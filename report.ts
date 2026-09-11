import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fetchPricing, meterRollouts, USAGE_KEYS, type MeteredRollouts, type PricingSnapshot } from "./usage";
import { readJudgeResponse, summarizeCheck } from "./judge";
import { collectBundle, finalizeBundle } from "./bundle";
import { readState, writeState, withRunLock } from "./state";
import type { ArmName, ArmResult, JudgePass } from "./types";

const ARMS = ["stock", "current"] as const;

function sumMeters(meters: Array<{ home: string; usage: MeteredRollouts }>): MeteredRollouts {
  const totals: MeteredRollouts["totals"] = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0, estimated_api_usd: 0, command_seconds: 0 };
  for (const meter of meters) {
    for (const key of USAGE_KEYS) totals[key] += meter.usage.totals[key];
    totals.command_seconds += meter.usage.totals.command_seconds;
    if (totals.estimated_api_usd !== null) totals.estimated_api_usd = meter.usage.totals.estimated_api_usd === null ? null : totals.estimated_api_usd + meter.usage.totals.estimated_api_usd;
  }
  return {
    agents: meters.flatMap(meter => meter.usage.agents),
    totals,
    warnings: meters.flatMap(meter => meter.usage.warnings.map(warning => `${meter.home}: ${warning}`)),
    complete: meters.length > 0 && meters.every(meter => meter.usage.complete),
  };
}

function percent(a: number | null, b: number | null): number | null {
  if (a === null || b === null || a === 0) return null;
  return Number((((b - a) / a) * 100).toFixed(2));
}

function graderSeconds(result: ArmResult | undefined): number | null {
  if (!result?.grade) return null;
  return result.grade.elapsed_ms / 1000;
}

function resultHasAllChecks(result: ArmResult | undefined): boolean {
  if (!result?.grade) return false;
  return [result.grade.preparation, result.grade.acceptance, result.grade.router_suite]
    .every(check => check.command !== "not run" && check.exit_code !== -1);
}

function number(value: number | null | undefined, digits = 0): string {
  return value === null || value === undefined ? "unknown" : value.toFixed(digits);
}

function gradeLabel(result: ArmResult | undefined): string {
  return result?.grade?.passed === true ? "pass" : result?.grade ? "fail" : "missing";
}

function passMarkdown(pass: JudgePass): string {
  const scoreRows = (["candidate-1", "candidate-2"] as const).map(id => {
    const score = pass.scores[id];
    return `| ${id} | ${score.correctness} | ${score.completeness} | ${score.maintainability} | ${score.test_quality} | ${score.weighted_total.toFixed(2)} |`;
  });
  const evidence = pass.evidence.length > 0 ? pass.evidence.map(item => `- ${item}`).join("\n") : "- None reported.";
  const issues = pass.issues.length > 0 ? pass.issues.map(issue => `- ${issue.candidate} / ${issue.severity}: ${issue.detail}`).join("\n") : "- None reported.";
  return `### Pass ${pass.pass}\n\nPresentation: candidate-1 = ${pass.presentation[0]}, candidate-2 = ${pass.presentation[1]}. Raw winner: **${pass.winner}**.\n\n| Candidate | correctness | completeness | maintainability | test quality | weighted total |\n| --- | ---: | ---: | ---: | ---: | ---: |\n${scoreRows.join("\n")}\n\nRationale: ${pass.rationale}\n\nEvidence:\n\n${evidence}\n\nIssues:\n\n${issues}`;
}

async function invalidateRunUnlocked(runDirectory: string, reasons: string[]): Promise<void> {
  if (reasons.length === 0 || reasons.some(reason => typeof reason !== "string" || reason.trim().length === 0)) {
    throw new Error("invalidation requires at least one nonempty reason");
  }
  const runDir = resolve(runDirectory);
  const state = await readState(runDir);
  if (state.status !== "complete" && state.status !== "partial") throw new Error(`only a complete or partial run can be invalidated, got ${state.status}`);
  state.invalidity_reasons = [...reasons];
  await writeState(runDir, state);
}

export async function buildReportUnlocked(runDirectory: string): Promise<{ jsonPath: string; markdownPath: string }> {
  const runDir = resolve(runDirectory);
  const state = await readState(runDir);
  const pricing = (state.pricing ?? await fetchPricing()) as PricingSnapshot;
  if (!state.pricing) { state.pricing = pricing; await writeState(runDir, state); }

  const usage: Partial<Record<ArmName, MeteredRollouts>> = {};
  for (const arm of ARMS) {
    const codexHome = state.arm_attempts?.[arm]?.codex_home ?? (state.results?.[arm] ? `arms/${arm}/home/ubuntu/.codex` : undefined);
    if (codexHome) usage[arm] = await meterRollouts(resolve(runDir, codexHome), pricing);
  }
  const judgeAttempts = state.judge ? await Promise.all(state.judge.usage_homes.map(async home => ({ home, usage: await meterRollouts(join(runDir, home), pricing) }))) : [];
  const judgeUsage = state.judge ? sumMeters(judgeAttempts) : undefined;

  const selectedArms = state.selected_arms ?? ARMS;
  const invalidityReasons = state.invalidity_reasons ?? [];
  const valid = invalidityReasons.length === 0;
  const checksExecuted = state.status === "complete" && selectedArms.every(arm => resultHasAllChecks(state.results?.[arm]));
  const gatesComplete = valid && checksExecuted;
  const armUsageComplete = selectedArms.every(arm => usage[arm]?.complete === true);
  const judgeComplete = state.judge?.status === "complete"
    && typeof state.judge.finished_at === "string"
    && state.judge.passes.length === 2
    && state.judge.passes.every((pass, index) => pass.pass === index + 1)
    && state.judge.usage_homes.length === 2
    && typeof state.judge.agreement === "boolean";
  const judgeUsageComplete = judgeUsage?.complete === true;
  const measurementComplete = valid && state.finishing?.status !== "failed" && checksExecuted && armUsageComplete && judgeComplete && judgeUsageComplete;

  const delta: Record<string, number | null> = {};
  if (usage.stock && usage.current) {
    for (const key of USAGE_KEYS) delta[key] = percent(usage.stock.totals[key], usage.current.totals[key]);
    delta.estimated_api_usd = percent(usage.stock.totals.estimated_api_usd, usage.current.totals.estimated_api_usd);
    delta.agent_elapsed_ms = percent(state.results?.stock?.agent_elapsed_ms ?? null, state.results?.current?.agent_elapsed_ms ?? null);
    delta.grader_seconds = percent(graderSeconds(state.results?.stock), graderSeconds(state.results?.current));
    delta.command_seconds = percent(usage.stock.totals.command_seconds, usage.current.totals.command_seconds);
  }

  const judgedWinner = state.judge?.winner ?? "none";
  let effectiveWinner: ArmName | "tie" | "none" = "none";
  if (measurementComplete && state.judge?.agreement === true) {
    if ((judgedWinner === "stock" || judgedWinner === "current") && state.results?.[judgedWinner]?.grade?.passed === true) effectiveWinner = judgedWinner;
    if (judgedWinner === "tie" && ARMS.every(arm => state.results?.[arm]?.grade?.passed === true)) effectiveWinner = "tie";
  }

  let rejectedSourceAssessment: { pass: number; error: string | undefined; response: unknown } | null = null;
  if (state.judge?.status === "failed") {
    const pass = state.judge.passes.length + 1;
    try {
      rejectedSourceAssessment = { pass, error: state.judge.error, response: await readJudgeResponse(runDir, pass) };
    } catch { /* A failed process or malformed response may have no readable assessment. */ }
  }
  const report = {
    generated_at: new Date().toISOString(),
    run_id: state.id,
    design: selectedArms.length === 1 ? "single-arm descriptive run; no paired winner" : "single paired descriptive pilot; do not generalize causally from one pair",
    selected_arms: selectedArms,
    profile: state.profile ?? "hpatch",
    source: state.source,
    setup: { ...state.execution, resource_limits: state.resource_limits, snapshot_manifest: state.snapshot_manifest },
    finishing: state.finishing ?? null,
    status: state.status,
    validity: valid ? "valid" : "invalid",
    invalidity_reasons: invalidityReasons,
    checks_executed: checksExecuted,
    gates_complete: gatesComplete,
    arm_usage_complete: armUsageComplete,
    judge_complete: judgeComplete,
    judge_usage_complete: judgeUsageComplete,
    measurement_complete: measurementComplete,
    winner: effectiveWinner,
    arms: Object.fromEntries(ARMS.map(arm => [arm, { attempt: state.arm_attempts?.[arm] ?? null, result: state.results?.[arm] ?? null, usage: usage[arm] ?? null }])),
    current_minus_stock_percent: delta,
    rejected_source_assessment: rejectedSourceAssessment,
    judge: state.judge ? { result: state.judge, attempts: judgeAttempts, usage: judgeUsage } : null,
    pricing,
  };

  const reports = join(runDir, "reports");
  await mkdir(reports, { recursive: true });
  const jsonPath = join(reports, "report.json");
  const markdownPath = join(reports, "report.md");
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);

  const armRows = selectedArms.map(arm => {
    const result = state.results?.[arm];
    const totals = usage[arm]?.totals;
    return `| ${arm} | ${gradeLabel(result)} | ${number(result ? result.agent_elapsed_ms / 1000 : null, 3)} | ${number(graderSeconds(result), 3)} | ${number(totals?.input_tokens)} | ${number(totals?.cached_input_tokens)} | ${number(totals?.cache_write_input_tokens)} | ${number(totals?.output_tokens)} | ${number(totals?.reasoning_output_tokens)} | ${number(totals?.total_tokens)} | ${number(totals?.command_seconds, 3)} | ${number(totals?.estimated_api_usd, 6)} |`;
  });
  const checkDetails = selectedArms.flatMap(arm => {
    const grade = state.results?.[arm]?.grade;
    if (!grade) return [`- ${arm}: no grading evidence.`];
    return (["preparation", "acceptance", "router_suite", "supplemental_repeat"] as const).map(name => {
      const check = grade[name];
      if (!check) return `- ${arm} ${name}: not run.`;
      const summary = summarizeCheck(check);
      return `- ${arm} ${name}: exit ${check.exit_code}${check.validation_error ? `; ${check.validation_error}` : ""}; failed tests: ${JSON.stringify(summary.failed_tests)}; ${number(check.elapsed_ms / 1000, 3)} seconds.`;
    });
  });
  const judgeRows = judgeAttempts.map((attempt, index) => {
    const totals = attempt.usage.totals;
    return `| ${index + 1} | ${attempt.usage.complete ? "complete" : "incomplete"} | ${totals.input_tokens} | ${totals.cached_input_tokens} | ${totals.cache_write_input_tokens} | ${totals.output_tokens} | ${totals.reasoning_output_tokens} | ${totals.total_tokens} | ${totals.command_seconds.toFixed(3)} | ${number(totals.estimated_api_usd, 6)} |`;
  });
  const warnings = [
    ...(state.finishing?.status === "failed" ? [`finishing: ${state.finishing.error ?? "failed"}`] : []),
    ...pricing.warnings.map(warning => `pricing: ${warning}`),
    ...selectedArms.flatMap(arm => (usage[arm]?.warnings ?? [state.results?.[arm] ? "usage was not measured" : "result and usage are missing"]).map(warning => `${arm}: ${warning}`)),
    ...(state.judge ? (judgeUsage?.warnings ?? ["judge usage was not measured"]).map(warning => `judge: ${warning}`) : ["judge: not run"]),
  ];
  const judgeSummary = state.judge
    ? `Status: **${state.judge.status}**. ${state.judge.passes.length} of 2 passes produced valid results.${state.judge.error ? ` Error: ${state.judge.error}` : ""}\n\n${state.judge.status === "complete" ? `Two independent reversed-order passes ${state.judge.agreement ? "agreed" : "disagreed"}. Judge winner: **${state.judge.winner}**.${state.judge.disagreement ? ` ${state.judge.disagreement}` : ""}` : "No judge winner is eligible from an incomplete attempt."}\n\n${state.judge.passes.map(passMarkdown).join("\n\n")}\n\n### Judge usage by attempted pass\n\n| Pass | usage status | input | cached input | cache write input | output | reasoning output | total | command seconds | estimated list-price API USD |\n| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n${judgeRows.join("\n") || "| - | missing | - | - | - | - | - | - | - | unknown |"}\n\nJudge aggregate estimated list-price API cost: ${number(judgeUsage?.totals.estimated_api_usd, 6)} USD; ${number(judgeUsage?.totals.total_tokens)} total tokens.`
    : "Not run.";
  const invalidityNotice = valid ? "" : `> **Infrastructure validity: INVALID**\n>\n${invalidityReasons.map(reason => `> - ${reason}`).join("\n")}\n>\n> Measurements are retained, but gates, completion, and winner are suppressed.\n\n`;
  const md = `# Codex A/B report\n\n${invalidityNotice}> This is a descriptive benchmark. A singleton run has no paired winner; this does not establish a causal or generalizable difference.\n\n- Run: \`${state.id}\`\n- Base: \`${state.source.base_commit}\` (tree \`${state.source.base_tree}\`, source timestamp ${state.source.source_timestamp})\n- Model: ${state.execution.model}, ${state.execution.reasoning_effort} reasoning, ${state.execution.service_tier} service tier\n- Infrastructure validity: **${valid ? "valid" : "invalid"}**\n- Required checks executed: **${checksExecuted ? "yes" : "no"}**\n- Gate result eligible: **${gatesComplete ? "yes" : "no"}**\n- Arm usage complete: **${armUsageComplete ? "yes" : "no"}**\n- Judge result and usage complete: **${judgeComplete && judgeUsageComplete ? "yes" : "no"}**\n- Overall winner: **${effectiveWinner}**\n\nA failed grade does not make measurement incomplete. It only makes that candidate ineligible to win. Missing checks, usage, or infrastructure validity make the overall result incomplete and suppress the winner.\n\n## Arms\n\n| Arm | preparation, acceptance, and scoped package checks | agent seconds | grader seconds | input | cached input | cache write input | output | reasoning output | total | command seconds | estimated list-price API USD |\n| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n${armRows.join("\n")}\n\n## Check details\n\n${checkDetails.join("\n")}\n\n## Current minus stock\n\n${Object.entries(delta).map(([key, value]) => `- ${key}: ${value === null ? "not available" : `${value}%`}`).join("\n") || "No paired usage is available."}\n\n## Judge\n\n${judgeSummary}\n\n## Pricing provenance\n\nEstimated USD values apply public list-price API rates to recorded tokens. They are not a subscription charge or invoice, and any premium for the selected service tier is not modeled.\n\n- Source: ${pricing.source}\n- Fetched at: ${pricing.fetched_at}\n- Catalog: ${pricing.catalog_url}\n${pricing.assumptions.map(assumption => `- Assumption: ${assumption}`).join("\n") || "- No pricing assumptions recorded."}\n\n## Warnings\n\n${warnings.map(warning => `- ${warning}`).join("\n") || "- None."}\n\nSee \`report.json\` for per-agent usage records, complete grading evidence, all judge attempts and passes, and the pricing snapshot.\n`;
  await writeFile(markdownPath, md);
  return { jsonPath, markdownPath };
}

export async function buildReport(runDirectory: string): Promise<{ jsonPath: string; markdownPath: string }> {
  return withRunLock(resolve(runDirectory), async () => {
    const paths = await buildReportUnlocked(runDirectory);
    if ((await readState(resolve(runDirectory))).finishing) {
      try {
        await collectBundle(runDirectory);
      } catch (error) {
        const state = await readState(resolve(runDirectory));
        if (state.finishing) {
          state.finishing.status = "failed";
          state.finishing.error = String(error);
          await writeState(resolve(runDirectory), state);
        }
        await buildReportUnlocked(runDirectory);
        await finalizeBundle(runDirectory);
        throw error;
      }
      await finalizeBundle(runDirectory);

    }
    return paths;
  });

}

export async function invalidateRun(runDirectory: string, reasons: string[]): Promise<void> {
  return withRunLock(resolve(runDirectory), () => invalidateRunUnlocked(runDirectory, reasons));
}
