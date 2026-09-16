import { mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fetchPricing, meterGrokHome, meterRollouts, USAGE_KEYS, type MeteredRollouts, type PricingSnapshot } from "./usage";
import { validateMekugiExports } from "./mekugi";
import { performanceComparison, performanceMarkdown } from "./diagnostics";
import { explainMechanisms, mechanismsMarkdown, reviewPolicy } from "./mechanisms";
import { readJudgeResponse, summarizeCheck, validateJudgePass } from "./judge";
import { collectBundle, finalizeBundle } from "./bundle";
import { readState, writeState, withRunLock } from "./state";
import type { ArmName, ArmResult, JudgePass, RunState } from "./types";

const ARMS = ["stock", "current"] as const;

export interface ReportOptions {
  outputDirectory?: string;
  sourceAssessmentsFile?: string;
}

async function exportDirectory(runDir: string, requested: string): Promise<string> {
  const source = await realpath(runDir);
  let ancestor = resolve(requested);
  const missing: string[] = [];
  let canonical: string;
  for (;;) {
    try { canonical = await realpath(ancestor); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(ancestor) === ancestor) throw error;
      missing.unshift(basename(ancestor));
      ancestor = dirname(ancestor);
    }
  }
  const destination = join(canonical, ...missing);
  if (destination === source || destination.startsWith(`${source}${sep}`)) {
    throw new Error("--output-dir must be outside the source run; omit it to refresh the run in place");
  }
  return destination;
}

/** Replace the report entry, not an existing symlink/hardlink's target. */
async function writeReport(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(contents);
    await file.close();
    await rename(temporary, path);
  } finally {
    await file.close();
    await rm(temporary, { force: true });
  }
}

interface SuppliedAssessments {
  source_sha256: string;
  passes: JudgePass[];
  agreement: boolean;
}

async function suppliedAssessments(path: string, results: Partial<Record<ArmName, ArmResult>>): Promise<SuppliedAssessments> {
  const text = await readFile(path, "utf8");
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || !("passes" in value) || !Array.isArray(value.passes) || value.passes.length !== 2) {
    throw new Error("source assessments must contain two passes with presentation and response");
  }
  const passes = value.passes.map((item: unknown, index) => {
    if (!item || typeof item !== "object" || !("presentation" in item) || !Array.isArray(item.presentation) || !("response" in item)
      || item.presentation.length !== 2 || !item.presentation.includes("stock") || !item.presentation.includes("current")) {
      throw new Error("each supplied assessment must map candidate-1 and candidate-2 to stock/current");
    }
    const order = item.presentation as [ArmName, ArmName];
    return validateJudgePass(item.response, (index + 1) as 1 | 2, order, {
      "candidate-1": results[order[0]]?.grade?.passed === true, "candidate-2": results[order[1]]?.grade?.passed === true,
    });
  });
  if (passes[0]!.presentation[0] === passes[1]!.presentation[0]) throw new Error("supplied source assessments must reverse presentation order");
  const winner = (pass: JudgePass): string => pass.winner.startsWith("candidate-") ? pass.presentation[pass.winner === "candidate-1" ? 0 : 1] : pass.winner;
  return { source_sha256: new Bun.CryptoHasher("sha256").update(text).digest("hex"), passes, agreement: winner(passes[0]!) === winner(passes[1]!) };
}

function sumMeters(meters: Array<{ home: string; usage: MeteredRollouts }>): MeteredRollouts {
  const totals: MeteredRollouts["totals"] = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0, estimated_api_usd: 0, command_seconds: 0 };
  for (const meter of meters) {
    for (const key of USAGE_KEYS) totals[key] += meter.usage.totals[key];
    totals.command_seconds += meter.usage.totals.command_seconds;
    if (totals.estimated_api_usd !== null) totals.estimated_api_usd = meter.usage.totals.estimated_api_usd === null ? null : totals.estimated_api_usd + meter.usage.totals.estimated_api_usd;
  }
  return {
    sessions: meters.flatMap(meter => meter.usage.sessions),
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

function resultHasAllChecks(result: ArmResult | undefined, criteria?: RunState["criteria"]): boolean {
  if (!criteria || !result?.grade || result.grade.evaluator_error) return false;
  if (![1, 2].every(pass => {
    const semantic = result.grade!.semantic;
    const assessed = semantic?.[`pass-${pass}`];
    const existing = semantic?.[`pass-${pass}-existing`];
    return assessed !== undefined && existing !== undefined &&
      assessed.length === criteria.contract.criteria.length &&
      existing.length === 1 && assessed.every(item => item.status !== "unassessed" && (item.basis === "executed" || item.status === "fail")) &&
      existing.every(item => item.status !== "unassessed" && item.basis === "executed");
  })) return false;
  return [result.grade.preparation, result.grade.router_suite]
    .every(check => check.command !== "not run" && check.exit_code !== -1);
}

function number(value: number | null | undefined, digits = 0): string {
  return value === null || value === undefined ? "unknown" : value.toFixed(digits);
}

function gradeLabel(result: ArmResult | undefined): string {
  if (result?.grade?.evaluator_error) return "unassessed";
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

export async function buildReportUnlocked(runDirectory: string, options: ReportOptions = {}): Promise<{ jsonPath: string; markdownPath: string }> {
  const { outputDirectory } = options;
  const runDir = resolve(runDirectory);
  const reports = outputDirectory ? await exportDirectory(runDir, outputDirectory) : join(runDir, "reports");
  const state = await readState(runDir);
  if (outputDirectory && !state.pricing) throw new Error("export requires recorded pricing; the source run will not be modified");
  const pricing = (state.pricing ?? await fetchPricing()) as PricingSnapshot;
  if (!state.pricing) { state.pricing = pricing; await writeState(runDir, state); }

  const usage: Partial<Record<ArmName, MeteredRollouts>> = {};
  for (const arm of ARMS) {
    const grokHome = state.arm_attempts?.[arm]?.grok_home;
    const codexHome = state.arm_attempts?.[arm]?.codex_home ?? (state.results?.[arm] ? `arms/${arm}/home/ubuntu/.codex` : undefined);
    if (state.comparison === "codex-mekugi-grok" && arm === "current" && grokHome) usage[arm] = await meterGrokHome(resolve(runDir, grokHome), pricing);
    else if (codexHome) usage[arm] = await meterRollouts(resolve(runDir, codexHome), pricing);
  }
  const judgeAttempts = state.judge ? await Promise.all(state.judge.usage_homes.map(async home => ({ home, usage: await meterRollouts(join(runDir, home), pricing) }))) : [];
  const judgeUsage = state.judge ? sumMeters(judgeAttempts) : undefined;

  const selectedArms = state.selected_arms ?? ARMS;
  const mechanismArms = await Promise.all(selectedArms.flatMap(arm => usage[arm] ? [arm] : []).map(async arm => {
    const source = join(runDir, state.arms[arm].home_template, ".codex/AGENTS.md");
    const text = await readFile(source, "utf8").catch(() => "");
    return { arm, usage: usage[arm]!, policy: text ? reviewPolicy(text, source) : undefined };
  }));
  const mechanisms = explainMechanisms(mechanismArms);
  const taskText = await readFile(join(runDir, state.task.path), "utf8").catch(() => "Task text unavailable; see the recorded task identity below.");
  const supplied = options.sourceAssessmentsFile ? await suppliedAssessments(resolve(options.sourceAssessmentsFile), state.results ?? {}) : null;
  const invalidityReasons = state.invalidity_reasons ?? [];
  const valid = invalidityReasons.length === 0;
  const checksExecuted = state.status === "complete" && selectedArms.every(arm => resultHasAllChecks(state.results?.[arm], state.criteria));
  const gatesComplete = valid && checksExecuted;
  const armUsageComplete = selectedArms.every(arm => usage[arm]?.complete === true);
  const judgeComplete = state.judge?.status === "complete"
    && typeof state.judge.finished_at === "string"
    && state.judge.passes.length === 2
    && state.judge.passes.every((pass, index) => pass.pass === index + 1)
    && state.judge.usage_homes.length === (state.judge.attempts?.length ?? 2)
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
  const semanticRows = ARMS.flatMap(arm => Object.entries(state.results?.[arm]?.grade?.semantic ?? {}).flatMap(([pass, criteria]) =>
    criteria.map(item => `| ${arm} | ${pass} | ${item.criterion} | ${item.status} | ${item.basis} | ${item.reasoning.replaceAll("|", "\\|").replaceAll("\n", " ")} |`)));
  const semanticMarkdown = state.criteria ? `## Behavioral acceptance criteria\n\nContract SHA-256: ${state.criteria.sha256}. Oracle qualification: ${state.criteria.contract.qualification}. The contract was fixed before model execution. Executed harness source, argv, outputs and each repair are retained in the machine bundle. Source-only reasoning is labeled separately.\n\n| Arm | Pass | Criterion | Result | Evidence | Reasoning |\n| --- | --- | --- | --- | --- | --- |\n${semanticRows.join("\n") || "| Both | None | All | unassessed | none | Semantic assessment has not completed. |"}\n\n` : "";
  const mekugiDiagnostics = state.mekugi_exports ? await validateMekugiExports(runDir, state) : null;
  const report = {
    generated_at: new Date().toISOString(),
    run_id: state.id,
    design: selectedArms.length === 1 ? "single-arm descriptive run; no paired winner" : "single paired descriptive pilot; do not generalize causally from one pair",
    selected_arms: selectedArms,
    profile: state.profile ?? "hpatch",
    source: state.source,
    setup: { ...state.execution, comparison: state.comparison ?? "stock-current", mekugi_flags: state.mekugi_flags ?? [], arm_order: state.arm_order ?? "concurrent", trial: state.trial ?? null, resource_limits: state.resource_limits, snapshot_manifest: state.snapshot_manifest },
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
    performance_breakdown: performanceComparison(selectedArms.flatMap(arm => usage[arm] ? [{ arm, usage: usage[arm]! }] : [])),
    criteria: state.criteria ?? null,
    mekugi_diagnostics: mekugiDiagnostics,
    workflow_mechanisms: mechanisms,
    supplied_source_assessments: supplied,
    current_minus_stock_percent: delta,
    rejected_source_assessment: rejectedSourceAssessment,
    judge: state.judge ? { result: state.judge, attempts: judgeAttempts, usage: judgeUsage } : null,
    pricing,
  };

  await mkdir(reports, { recursive: true });
  const jsonPath = join(reports, "report.json");
  const markdownPath = join(reports, "report.md");
  await writeReport(jsonPath, `${JSON.stringify(report, null, 2)}\n`);

  const armRows = selectedArms.map(arm => {
    const result = state.results?.[arm];
    const totals = usage[arm]?.totals;
    return `| ${arm} | ${gradeLabel(result)} | ${number(result ? result.agent_elapsed_ms / 1000 : null, 3)} | ${number(graderSeconds(result), 3)} | ${number(totals?.input_tokens)} | ${number(totals?.cached_input_tokens)} | ${number(totals?.cache_write_input_tokens)} | ${number(totals?.output_tokens)} | ${number(totals?.reasoning_output_tokens)} | ${number(totals?.total_tokens)} | ${number(totals?.command_seconds, 3)} | ${number(totals?.estimated_api_usd, 6)} |`;
  });
  const checkDetails = selectedArms.flatMap(arm => {
    const grade = state.results?.[arm]?.grade;
    if (!grade) return [`- ${arm}: no grading evidence.`];
    return (["preparation", "router_suite", "supplemental_repeat"] as const).map(name => {
      const check = grade[name];
      if (!check) return `- ${arm} ${name}: not run.`;
      const summary = summarizeCheck(check);
      return `- ${arm} ${name}: exit ${check.exit_code}${check.validation_error ? `; ${check.validation_error}` : ""}; failed tests: ${JSON.stringify(summary.failed_tests)}; ${number(check.elapsed_ms / 1000, 3)} seconds.`;
    });
  });
  const judgeRows = judgeAttempts.map((attempt, index) => {
    const totals = attempt.usage.totals;
    const identity = state.judge?.attempts?.[index];
    return `| ${identity ? `${identity.pass}.${identity.attempt}` : index + 1} | ${attempt.usage.complete ? "complete" : "incomplete"} | ${totals.input_tokens} | ${totals.cached_input_tokens} | ${totals.cache_write_input_tokens} | ${totals.output_tokens} | ${totals.reasoning_output_tokens} | ${totals.total_tokens} | ${totals.command_seconds.toFixed(3)} | ${number(totals.estimated_api_usd, 6)} |`;
  });
  const warnings = [
    ...(!state.criteria ? ["No task-derived criteria were recorded. Historical measurements are descriptive only; grading completion and winner eligibility are unavailable."] : []),
    ...(state.finishing?.status === "failed" ? [`finishing: ${state.finishing.error ?? "failed"}`] : []),
    ...pricing.warnings.map(warning => `pricing: ${warning}`),
    ...selectedArms.flatMap(arm => (usage[arm]?.warnings ?? [state.results?.[arm] ? "usage was not measured" : "result and usage are missing"]).map(warning => `${arm}: ${warning}`)),
    ...(state.judge ? (judgeUsage?.warnings ?? ["judge usage was not measured"]).map(warning => `judge: ${warning}`) : ["judge: not run"]),
  ];
  const judgeSummary = state.judge
    ? `Status: **${state.judge.status}**. ${state.judge.passes.length} of 2 passes produced valid results.${state.judge.error ? ` Error: ${state.judge.error}` : ""}\n\n${state.judge.status === "complete" ? `Two independent reversed-order passes ${state.judge.agreement ? "agreed" : "disagreed"}. Judge winner: **${state.judge.winner}**.${state.judge.disagreement ? ` ${state.judge.disagreement}` : ""}` : "No judge winner is eligible from an incomplete attempt."}\n\n${state.judge.passes.map(passMarkdown).join("\n\n")}\n\n### Judge usage by attempted pass\n\n| Pass | usage status | input | cached input | cache write input | output | reasoning output | total | command seconds | estimated list-price API USD |\n| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n${judgeRows.join("\n") || "| - | missing | - | - | - | - | - | - | - | unknown |"}\n\nJudge aggregate estimated list-price API cost: ${number(judgeUsage?.totals.estimated_api_usd, 6)} USD; ${number(judgeUsage?.totals.total_tokens)} total tokens.`
    : "Not run.";
  const invalidityNotice = valid ? "" : `> **Infrastructure validity: INVALID**\n>\n${invalidityReasons.map(reason => `> - ${reason}`).join("\n")}\n>\n> Measurements are retained, but gates, completion, and winner are suppressed.\n\n`;
  const suppliedMarkdown = supplied ? `## Supplied supplemental source assessments\n\nThese previously recorded assessments were imported, schema-checked, and rescored programmatically. No inference was started. They ${supplied.agreement ? "agree on the mapped result" : "disagree on the mapped result; no consistent source-quality winner is established"}. They do not replace the official judge, establish unknown assessment costs, or change overall winner eligibility. Provenance beyond the supplied candidate mapping is not independently established. Input SHA-256: ${supplied.source_sha256}.\n\n${supplied.passes.map(passMarkdown).join("\n\n")}\n\n` : "";
  const md = `# Codex A/B report\n\n${invalidityNotice}> This is a descriptive benchmark. A singleton run has no paired winner; this does not establish a causal or generalizable difference.\n\n- Run: \`${state.id}\`\n- Base: \`${state.source.base_commit}\` (tree \`${state.source.base_tree}\`, source timestamp ${state.source.source_timestamp})\n- Model: ${state.execution.model}, ${state.execution.reasoning_effort} reasoning, ${state.execution.service_tier} service tier\n- Infrastructure validity: **${valid ? "valid" : "invalid"}**\n- Required checks executed: **${checksExecuted ? "yes" : "no"}**\n- Gate result eligible: **${gatesComplete ? "yes" : "no"}**\n- Arm usage complete: **${armUsageComplete ? "yes" : "no"}**\n- Judge result and usage complete: **${judgeComplete && judgeUsageComplete ? "yes" : "no"}**\n- Overall winner: **${effectiveWinner}**\n\nA failed grade does not make measurement incomplete. It only makes that candidate ineligible to win. Missing checks, usage, or infrastructure validity make the overall result incomplete and suppress the winner.\n\n${mechanismsMarkdown(mechanisms)}\n\n## Task and setup\n\n${taskText.trim().split("\n").map(line => `> ${line}`).join("\n")}\n\n- Comparison: ${state.comparison ?? "stock-current"}.\n- A / stock: ${state.comparison === "codex-mekugi-grok" ? "minimal generated Codex configuration plus Mekugi on grok:grok-4.6" : state.comparison === "same-setup" ? "captured current-home configuration; direct Codex" : "minimal generated Codex configuration; direct Codex"}.\n- B / current: ${state.comparison === "codex-mekugi-grok" ? "minimal generated Grok configuration; grok CLI on grok-4.6" : state.comparison === "stock-mekugi" ? "minimal generated Codex configuration plus Mekugi" : "captured current-home configuration"}; launcher ${state.execution.current_launcher ?? "codex"}.\n- Mekugi flags: ${JSON.stringify(state.mekugi_flags ?? [])}.\n- Codex: ${state.runtime_tools.codex_version}; executable SHA-256 ${state.runtime_tools.codex_sha256}.\n- Grok: ${state.runtime_tools.grok_version ?? "not used"}; executable SHA-256 ${state.runtime_tools.grok_sha256 ?? "n/a"}.\n- Image: ${state.image_id ?? state.image}.\n- Resources per arm: ${state.resource_limits.cpus} CPUs, ${state.resource_limits.memory} memory.\n- Arm execution order: ${state.arm_order ?? "concurrent"}.\n- Trial set: ${state.trial ? `${state.trial.set_id}, pair ${state.trial.index}, controls SHA-256 ${state.trial.controls_sha256}` : "standalone pair"}.\n- Setup manifest SHA-256: ${state.current_snapshot?.manifest_sha256 ?? "unknown"}.\n- Task SHA-256: ${state.task.sha256}.\n- Runtime boundary: ${state.protected_runtime ? "A: direct Codex with ordinary provider egress. B: Mekugi-owned private namespaces, capability-free executor, router-only egress and read-only capture/runtime mounts. This boundary differs between arms." : "ordinary container boundary; Mekugi exports are executor-writable"}.\n- Mekugi build provenance: ${state.mekugi_build ? `source SHA-256 ${state.mekugi_build.identity.source_archive_sha256}; builder ${state.mekugi_build.identity.image_id}` : "not supplied; executable hashes alone do not establish source provenance"}.\n- Task pack: ${state.task_pack ? `${state.task_pack.id}; snapshot SHA-256 ${state.task_pack.sha256}` : "standalone controls"}.\n\n## Arms\n\n| Arm | preparation, semantic criteria, and scoped package checks | agent seconds | grader seconds | input | cached input | cache write input | output | reasoning output | total | command seconds | API-equivalent USD |\n| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n${armRows.join("\n")}\n\n## Mekugi within-arm diagnostics\n\n${mekugiDiagnostics ? `Validation: ${mekugiDiagnostics.status}. ${mekugiDiagnostics.reason ?? "Capturer-owned schema and raw evidence reconcile."}\n\nThese exports are within-arm diagnostics, not measured savings against direct Codex. ${state.comparison === "codex-mekugi-grok" ? "Codex JSONL and Grok usage.json remain the paired accounting sources." : "Codex JSONL and rollout usage remain the paired accounting source."} ${state.protected_runtime ? "Capture/runtime mounts are read-only in the executor namespace; the trusted router retains write access. Preflight checks this boundary without inference." : "Export files are writable within the agent container, so consistency validation is not tamper-proof provenance."}\n\n\`\`\`json\n${JSON.stringify(mekugiDiagnostics.metrics && typeof mekugiDiagnostics.metrics === "object" ? Object.fromEntries(Object.entries(mekugiDiagnostics.metrics).filter(([key]) => ["schema", "mode", "model_protocol", "requests", "usage", "capture", "mekugi"].includes(key))) : null, null, 2)}\n\`\`\`` : "Not requested or unavailable in this historical run."}\n\n${semanticMarkdown}## Check details\n\n${checkDetails.join("\n")}\n\n## Current minus stock\n\n${Object.entries(delta).map(([key, value]) => `- ${key}: ${value === null ? "not available" : `${value}%`}`).join("\n") || "No paired usage is available."}\n\n${performanceMarkdown(selectedArms.flatMap(arm => usage[arm] ? [{ arm, usage: usage[arm]! }] : []))}\n\n## Judge\n\n${judgeSummary}\n\n${suppliedMarkdown}## Pricing provenance\n\n${state.comparison === "codex-mekugi-grok" ? "Codex USD applies public list-price API rates; Grok CLI USD uses complete provider-recorded session cost when available and otherwise a captured list-price estimate." : "Estimated USD values apply public list-price API rates to recorded tokens."} They are not a subscription charge or invoice, and any premium for the selected service tier is not modeled.\n\n- Source: ${pricing.source}\n- Fetched at: ${pricing.fetched_at}\n- Catalog: ${pricing.catalog_url}\n${pricing.assumptions.map(assumption => `- Assumption: ${assumption}`).join("\n") || "- No pricing assumptions recorded."}\n\n## Warnings\n\n${warnings.map(warning => `- ${warning}`).join("\n") || "- None."}\n\nThis is the complete human-readable result: task/setup, behavioral explanation, measurements, checks, and source judgments are inline. The accompanying JSON is machine-readable evidence, not another required report.\n`;
  await writeReport(markdownPath, md);
  return { jsonPath, markdownPath };
}

export async function buildReport(runDirectory: string, options: ReportOptions = {}): Promise<{ jsonPath: string; markdownPath: string }> {
  const { outputDirectory } = options;
  return withRunLock(resolve(runDirectory), async () => {
    const paths = await buildReportUnlocked(runDirectory, options);
    if (outputDirectory) return paths;
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
        await buildReportUnlocked(runDirectory, options);
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
