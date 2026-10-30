import { armNames, candidateIds, qualityAspectKeys } from "./types";
import { armLabels } from "./arm-labels";
import { mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve, sep } from "node:path";
import { applyMekugiProviderUsage, fetchPricing, meterGrokHome, meterRollouts, readMekugiNativeCost, USAGE_KEYS, type MeteredRollouts, type PricingSnapshot } from "./usage";
import { isPairedMekugiComparison, usesMekugi, validateMekugiExports } from "./mekugi";
import { performanceComparison, performanceMarkdown } from "./diagnostics";
import { explainResources, resourceExplanationMarkdown } from "./assessment-explanation";
import { explainMechanisms, mechanismsMarkdown, reviewPolicy } from "./mechanisms";
import { compactionComparisonExclusion, journalEvidence, journalEvidenceMarkdown } from "./journal";
import { readJudgeResponse, summarizeCheck, unassessedQualityAspects, validateJudgePass } from "./judge";
import { collectBundle, finalizeBundle } from "./bundle";
import { readState, writeState, withRunLock } from "./state";
import type { ArmName, ArmResult, JudgePass, RunState } from "./types";

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
      || item.presentation.length !== Object.keys(results).length || new Set(item.presentation).size !== item.presentation.length || Object.keys(results).some(arm => !(item.presentation as unknown[]).includes(arm))) {
      throw new Error("each supplied assessment must map candidate-1 and candidate-2 to stock/current");
    }
    const order = item.presentation as ArmName[];
    return reportedPass(validateJudgePass(item.response, (index + 1) as 1 | 2, order, Object.fromEntries(order.map((arm, index) => [`candidate-${index + 1}`, results[arm]?.grade?.passed === true]))));
  });
  if (JSON.stringify([...passes[0]!.presentation].reverse()) !== JSON.stringify(passes[1]!.presentation)) throw new Error("supplied source assessments must reverse presentation order");
  const winner = (pass: JudgePass): string => pass.winner.startsWith("candidate-") ? pass.presentation[Number(pass.winner.slice("candidate-".length)) - 1] : pass.winner;
  return { source_sha256: new Bun.CryptoHasher("sha256").update(text).digest("hex"), passes, agreement: winner(passes[0]!) === winner(passes[1]!) };
}

function sumMeters(meters: Array<{ home: string; usage: MeteredRollouts }>): MeteredRollouts {
  const totals: MeteredRollouts["totals"] = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0, estimated_api_usd: 0, command_seconds: 0 };
  for (const meter of meters) {
    for (const key of USAGE_KEYS) totals[key] += meter.usage.totals[key];
    totals.command_seconds = totals.command_seconds === null || meter.usage.totals.command_seconds === null
      ? null : totals.command_seconds + meter.usage.totals.command_seconds;
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

// An assessed failure settles a failed grade even when another pass left criteria unassessed.
function resultIsDecided(result: ArmResult | undefined, criteria?: RunState["criteria"]): boolean {
  if (resultHasAllChecks(result, criteria)) return true;
  if (!criteria || !result?.grade || result.grade.evaluator_error || result.grade.passed !== false) return false;
  return Object.values(result.grade.semantic ?? {}).some(items => items.some(item => item.status === "fail"));
}

function number(value: number | null | undefined, digits = 0): string {
  return value === null || value === undefined ? "unknown" : value.toFixed(digits);
}

function gradeLabel(result: ArmResult | undefined, criteria?: RunState["criteria"]): string {
  if (!result?.grade) return "missing";
  if (result.grade.evaluator_error || !resultIsDecided(result, criteria)) return "unassessed";
  return result.grade.passed === true ? "pass" : "fail";
}

function passMarkdown(pass: JudgePass, labels: Record<ArmName, string>): string {
  const scoreRows = candidateIds(pass.presentation.length).map(id => {
    const score = pass.scores[id];
    return `| ${id} | ${score.correctness} | ${score.completeness} | ${score.maintainability} | ${score.test_quality} | ${score.weighted_total.toFixed(2)} |`;
  });
  const evidence = pass.evidence.length > 0 ? pass.evidence.map(item => `- ${item}`).join("\n") : "- None reported.";
  const issues = pass.issues.length > 0 ? pass.issues.map(issue => `- ${issue.candidate} / ${issue.severity}: ${issue.detail}`).join("\n") : "- None reported.";
  const aspectRows = candidateIds(pass.presentation.length).flatMap(id => {
    const aspects = pass.quality_aspects?.[id] ?? unassessedQualityAspects();
    return qualityAspectKeys.map(key => {
      const aspect = aspects[key];
      return `| ${id} | ${key} | ${aspect.status} | ${aspect.basis} | ${aspect.reasoning.replaceAll("|", "\\|").replaceAll("\n", " ")} |`;
    });
  });
  return `### Pass ${pass.pass}\n\nPresentation: ${pass.presentation.map((arm, index) => `candidate-${index + 1} = ${labels[arm]}`).join(", ")}. Raw winner: **${pass.winner}**.\n\n| Candidate | correctness | completeness | maintainability | test quality | weighted total |\n| --- | ---: | ---: | ---: | ---: | ---: |\n${scoreRows.join("\n")}\n\nRationale: ${pass.rationale}\n\n#### Qualitative aspects\n\nThese evidence-based assessments carry no additional scoring weight or task gate.\n\n| Candidate | Aspect | Result | Evidence | Reasoning |\n| --- | --- | --- | --- | --- |\n${aspectRows.join("\n")}\n\nEvidence:\n\n${evidence}\n\nIssues:\n\n${issues}`;
}

function reportedPass(pass: JudgePass): JudgePass {
  if (pass.quality_aspects) return pass;
  return { ...pass, quality_aspects: Object.fromEntries(candidateIds(pass.presentation.length).map(id => [id, unassessedQualityAspects()])) };
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

/** Measure stopped execution once; retain this writer only within the owning locked operation. */
export async function prepareReportUnlocked(runDirectory: string, options: ReportOptions = {}): Promise<() => Promise<{ jsonPath: string; markdownPath: string }>> {
  const { outputDirectory } = options;
  const runDir = resolve(runDirectory);
  const reports = outputDirectory ? await exportDirectory(runDir, outputDirectory) : join(runDir, "reports");
  const state = await readState(runDir);
  const ARMS = armNames(state);
  const labels = armLabels(state);
  const winnerLabel = (winner: string) => labels[winner] ?? winner;
  if (outputDirectory && !state.pricing) throw new Error("export requires recorded pricing; the source run will not be modified");
  const recordedPricing = (state.pricing ?? await fetchPricing()) as PricingSnapshot;
  if (!state.pricing) { state.pricing = recordedPricing; await writeState(runDir, state); }
  const pricing: PricingSnapshot = state.judge_pricing ? {
    ...recordedPricing,
    models: { ...recordedPricing.models, [state.judge_pricing.rate.model_id]: state.judge_pricing.rate },
    assumptions: [...recordedPricing.assumptions,
      `Judge ${state.judge_pricing.rate.model_id} embedded list-price fallback captured on ${state.judge_pricing.captured_at}; original run pricing is unchanged.`],
  } : recordedPricing;

  const contexts = Object.fromEntries(await Promise.all(ARMS.map(async arm => {
    const imported = state.imported_arms?.[arm];
    return [arm, imported ? { root: join(runDir, imported.directory), state: await readState(join(runDir, imported.directory)), arm: imported.evidence_arm }
      : { root: runDir, state, arm }];
  })));
  const isMekugi = (arm: ArmName) => usesMekugi(contexts[arm].state, contexts[arm].arm);
  const usage: Partial<Record<ArmName, MeteredRollouts>> = {};
  for (const arm of ARMS) {
    const c = contexts[arm];
    const grokHome = c.state.arm_attempts?.[c.arm]?.grok_home;
    const codexHome = c.state.arm_attempts?.[c.arm]?.codex_home ?? (c.state.results?.[c.arm] ? join(dirname(c.state.arms[c.arm].repository), "home/ubuntu/.codex") : undefined);
    if (c.state.comparison === "codex-mekugi-grok" && c.arm === "current" && grokHome) usage[arm] = await meterGrokHome(resolve(c.root, grokHome), pricing);
    else if (codexHome) usage[arm] = await meterRollouts(resolve(c.root, codexHome), pricing, undefined, isMekugi(arm) ? "native" : "rollout");
  }
  const diagnosticsByArm = state.mekugi_exports_by_arm || state.imported_arms ? Object.fromEntries(await Promise.all(ARMS.filter(isMekugi).map(async arm => {
    const c = contexts[arm];
    return [arm, await validateMekugiExports(c.root, c.state, c.arm)] as const;
  }))) : null;
  const mekugiDiagnostics = state.mekugi_exports ? await validateMekugiExports(runDir, state) : null;
  for (const arm of ARMS) {
    if (!isMekugi(arm)) continue;
    const c = contexts[arm];
    let metered = usage[arm];
    if (!metered) continue;
    const exports = diagnosticsByArm?.[arm] ?? mekugiDiagnostics;
    const kept = exports?.status === "valid" ? applyMekugiProviderUsage(metered, exports.metrics, pricing) : exports?.reason ?? "exports were not requested";
    if (kept !== null) {
      const codexHome = c.state.arm_attempts?.[c.arm]?.codex_home ?? join(dirname(c.state.arms[c.arm].repository), "home/ubuntu/.codex");
      metered = usage[arm] = await meterRollouts(resolve(c.root, codexHome), pricing);
      // A validator traceback stays in mekugi_diagnostics.reason; the warning keeps its final error line.
      metered.warnings.push(`Mekugi provider-attempt accounting is unavailable (${kept.trim().split("\n").at(-1)}); tokens and requests use the Codex rollout, which omits router-side attempts`);
    }
    if (exports?.status === "valid") metered.journal = journalEvidence(exports.metrics) ?? undefined;
    const stdoutPath = c.state.results?.[c.arm]?.stdout_path;
    const metricsPath = (c.state.mekugi_exports_by_arm?.[c.arm] ?? c.state.mekugi_exports)?.metrics;
    const nativeCost = stdoutPath ? await readMekugiNativeCost(join(c.root, stdoutPath),
      metricsPath ? join(c.root, dirname(metricsPath), "token-metrics.md") : undefined) : null;
    metered.recorded_api_usd = nativeCost;
    if (nativeCost !== null) metered.warnings.push(`Mekugi native estimate USD ${nativeCost.toFixed(4)} is retained separately, not used for the list-price comparison`);
  }
  const judgeAttempts = state.judge ? await Promise.all(state.judge.usage_homes.map(async home => ({ home, usage: await meterRollouts(join(runDir, home), pricing) }))) : [];
  const judgeUsage = state.judge ? sumMeters(judgeAttempts) : undefined;

  const selectedArms = state.selected_arms ?? ARMS;
  const mechanismArms = await Promise.all(selectedArms.flatMap(arm => usage[arm] ? [arm] : []).map(async arm => {
    const c = contexts[arm];
    const source = join(c.root, c.state.arms[c.arm].home_template, ".codex/AGENTS.md");
    const text = await readFile(source, "utf8").catch(() => "");
    return { arm, usage: usage[arm]!, policy: text ? reviewPolicy(text, source) : undefined };
  }));
  const mechanisms = explainMechanisms(mechanismArms, labels);
  const taskText = await readFile(join(runDir, state.task.path), "utf8").catch(() => "Task text unavailable; see the recorded task identity below.");
  const supplied = options.sourceAssessmentsFile ? await suppliedAssessments(resolve(options.sourceAssessmentsFile), state.results ?? {}) : null;
  const performanceArms = selectedArms.flatMap(arm => usage[arm] ? [{ arm, usage: usage[arm]! }] : []);
  const performance = performanceComparison(performanceArms);
  const performanceText = performanceMarkdown(performanceArms, performance, labels);
  const resourceExplanation = explainResources(selectedArms.map(arm => ({ arm, label: labels[arm], usage: usage[arm] })));

  return async () => {
    // Collection can invalidate integrity, and finalization can fail after measurement.
    const state = await readState(runDir);
    const invalidityReasons = state.invalidity_reasons ?? [];
    const valid = invalidityReasons.length === 0;
    const checksExecuted = state.status === "complete" && selectedArms.every(arm => resultIsDecided(state.results?.[arm], state.criteria));
    const gatesComplete = valid && checksExecuted;
    const armUsageComplete = selectedArms.every(arm => usage[arm]?.complete === true);
    const judgeComplete = state.judge?.status === "complete"
      && typeof state.judge.finished_at === "string"
      && state.judge.passes.length === 2
      && state.judge.passes.every((pass, index) => pass.pass === index + 1)
      && state.judge.usage_homes.length === (state.judge.attempts?.length ?? 2)
      && typeof state.judge.agreement === "boolean";
    const judgeUsageComplete = judgeUsage?.complete === true;
    const diagnosticsComplete = !(isPairedMekugiComparison(state.comparison) || state.comparison === "custom" && ARMS.some(isMekugi)) || (diagnosticsByArm !== null && ARMS.filter(isMekugi).every(arm => diagnosticsByArm[arm]?.status === "valid"));
    const comparisonExclusion = state.comparison === "journal-compaction" ? compactionComparisonExclusion(ARMS.map(arm => usage[arm]?.journal)) : null;
    const measurementComplete = !comparisonExclusion && valid && state.finishing?.status !== "failed" && checksExecuted && armUsageComplete && judgeComplete && judgeUsageComplete && diagnosticsComplete;

    const judgedWinner = state.judge?.winner ?? "none";
    let effectiveWinner: ArmName | "tie" | "none" = "none";
    if (measurementComplete && state.judge?.agreement === true) {
      const eligible = (arm: ArmName) => state.results?.[arm]?.grade?.passed === true && resultHasAllChecks(state.results[arm], state.criteria);
      if (ARMS.includes(judgedWinner) && eligible(judgedWinner)) effectiveWinner = judgedWinner;
      if (judgedWinner === "tie" && ARMS.every(eligible)) effectiveWinner = "tie";
    }

    const winnerReason = selectedArms.length === 1 ? "Single-arm run: no paired winner."
      : comparisonExclusion ? `Comparison excluded: ${comparisonExclusion}.`
      : !valid ? "Infrastructure invalid: winner suppressed."
      : checksExecuted && selectedArms.every(arm => state.results?.[arm]?.grade?.passed === false) ? (ARMS.length === 2 ? "Neither candidate passed the required checks." : "No candidate passed the required checks.")
      : !measurementComplete ? "Required checks, usage, or judge evidence is incomplete."
      : !state.judge?.agreement ? "The judge passes disagree."
      : effectiveWinner === "none" ? "The judge selected neither eligible candidate."
      : effectiveWinner === "tie" ? "All eligible candidates tied." : state.evaluation?.mode === "reuse"
        ? "The eligible candidate led the historical weighted-score comparison in both passes."
        : "The eligible candidate won both judge passes.";
    const metricWinner = (values: Array<number | null | undefined>): ArmName | "tie" | "none" => {
      if (values.some(value => value == null)) return "none";
      const minimum = Math.min(...values as number[]);
      const winners = selectedArms.filter((_, index) => values[index] === minimum);
      return winners.length === 1 ? winners[0]! : "tie";
    };
    const efficiency = selectedArms.length >= 2 ? {
      faster: metricWinner(selectedArms.map(arm => state.results?.[arm]?.agent_elapsed_ms)),
      lower_estimated_cost: metricWinner(selectedArms.map(arm => usage[arm]?.complete ? usage[arm]!.totals.estimated_api_usd : null)),
    } : null;
    const baselineDifferences = Object.fromEntries(ARMS.slice(1).map(arm => {
      const baseline = ARMS[0]!;
      const changes: Record<string, number | null> = {};
      for (const key of [...USAGE_KEYS, "estimated_api_usd", "command_seconds"] as const) {
        changes[key] = percent(usage[baseline]?.complete ? usage[baseline]!.totals[key] : null, usage[arm]?.complete ? usage[arm]!.totals[key] : null);
      }
      changes.agent_elapsed_ms = percent(state.results?.[baseline]?.agent_elapsed_ms ?? null, state.results?.[arm]?.agent_elapsed_ms ?? null);
      changes.grader_seconds = percent(graderSeconds(state.results?.[baseline]), graderSeconds(state.results?.[arm]));
      return [arm, changes];
    }));

    let rejectedSourceAssessment: { pass: number; error: string | undefined; response: unknown } | null = null;
    if (state.judge?.status === "failed") {
      const pass = state.judge.failed_pass
        ?? ([1, 2] as const).find(candidate => !state.judge!.passes.some(completed => completed.pass === candidate))
        ?? state.judge.passes.length + 1;
      try {
        rejectedSourceAssessment = { pass, error: state.judge.error, response: await readJudgeResponse(runDir, pass) };
      } catch { /* A failed process or malformed response may have no readable assessment. */ }
    }
    const semanticPassOrder = ["pass-1-existing", "pass-1", "pass-2-existing", "pass-2"];
    const semanticRows = ARMS.flatMap(arm => Object.entries(state.results?.[arm]?.grade?.semantic ?? {})
      .sort(([left], [right]) => semanticPassOrder.indexOf(left) - semanticPassOrder.indexOf(right))
      .flatMap(([pass, criteria]) =>
        criteria.map(item => `| ${labels[arm as ArmName]} | ${pass} | ${item.criterion} | ${item.status} | ${item.basis} | ${item.reasoning.replaceAll("|", "\\|").replaceAll("\n", " ")} |`)));
    const semanticMarkdown = state.criteria ? `## Behavioral acceptance criteria\n\nContract SHA-256: ${state.criteria.sha256}. Oracle qualification: ${state.criteria.contract.qualification}. The contract was fixed before model execution. Executed harness source, argv, outputs and each repair are retained in the machine bundle. Source-only reasoning is labeled separately.\n\n| Arm | Pass | Criterion | Result | Evidence | Reasoning |\n| --- | --- | --- | --- | --- | --- |\n${semanticRows.join("\n") || "| Both | None | All | unassessed | none | Semantic assessment has not completed. |"}\n\n` : "";
    const report = {
      generated_at: new Date().toISOString(),
      run_id: state.id,
      design: state.imported_arms ? "historical arms versus fresh candidates; do not generalize causally" : state.imported_control ? "historical stock control versus fresh treatment; do not generalize causally"
        : selectedArms.length === 1 ? "single-arm descriptive run; no paired winner" : "single paired descriptive pilot; do not generalize causally from one pair",
      selected_arms: selectedArms,
      evaluation: state.evaluation ?? { mode: "fresh" },
      profile: state.profile ?? "hpatch",
      source: state.source,
      setup: { setup_revisions: state.setup_revisions, ...state.execution, auto_compact_limit: state.auto_compact_limit ?? null, dependency_image: state.dependency_image, comparison: state.comparison ?? "stock-current", mekugi_flags: state.mekugi_flags ?? [], imported_control: state.imported_control ?? null, imported_arms: state.imported_arms ?? null, arm_order: state.arm_order ?? "concurrent", trial: state.trial ?? null, resource_limits: state.resource_limits, snapshot_manifest: state.snapshot_manifest },
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
      comparison_exclusion: comparisonExclusion,
      winner: effectiveWinner,
      winner_reason: winnerReason,
      efficiency,
      arm_labels: labels,
      arms: Object.fromEntries(ARMS.map(arm => [arm, { attempt: state.arm_attempts?.[arm] ?? null, result: state.results?.[arm] ?? null, usage: usage[arm] ?? null }])),
      performance_breakdown: performance,
      criteria: state.criteria ?? null,
      mekugi_diagnostics: mekugiDiagnostics,
      mekugi_diagnostics_by_arm: diagnosticsByArm,
      workflow_mechanisms: mechanisms,
      resource_explanation: resourceExplanation,
      supplied_source_assessments: supplied,
      current_minus_stock_percent: usage.stock && usage.current ? baselineDifferences.current : {},
      baseline_arm: ARMS[0],
      baseline_differences_percent: baselineDifferences,
      rejected_source_assessment: rejectedSourceAssessment,
      judge: state.judge ? { result: { ...state.judge, passes: state.judge.passes.map(reportedPass) }, attempts: judgeAttempts, usage: judgeUsage } : null,
      pricing,
    };

    await mkdir(reports, { recursive: true });
    const jsonPath = join(reports, "report.json");
    const markdownPath = join(reports, "report.md");
    await writeReport(jsonPath, `${JSON.stringify(report, null, 2)}\n`);

    const armRows = selectedArms.map(arm => {
      const result = state.results?.[arm];
      const totals = usage[arm]?.complete ? usage[arm]!.totals : undefined;
      const uncached = totals ? totals.input_tokens - totals.cached_input_tokens : null;
      return `| ${labels[arm as ArmName]} | ${gradeLabel(result, state.criteria)} | ${number(result ? result.agent_elapsed_ms / 1000 : null, 3)} | ${number(graderSeconds(result), 3)} | ${number(totals?.input_tokens)} | ${number(uncached)} | ${number(totals?.cached_input_tokens)} | ${number(totals?.cache_write_input_tokens)} | ${number(totals?.output_tokens)} | ${number(totals?.reasoning_output_tokens)} | ${number(totals?.total_tokens)} | ${number(totals?.command_seconds, 3)} | ${number(totals?.estimated_api_usd, 6)} |`;
    });
    const costExplanation = usage.stock?.complete && usage.current?.complete
      ? `Total input alone does not determine cost. ${labels.current} minus ${labels.stock}: ${usage.current.totals.input_tokens - usage.stock.totals.input_tokens} total input tokens, but ${usage.current.totals.input_tokens - usage.current.totals.cached_input_tokens - usage.stock.totals.input_tokens + usage.stock.totals.cached_input_tokens} uncached input tokens. Uncached, cached, cache-write, and output tokens have separate prices; their dollar contributions appear below.`
      : "Uncached, cached, cache-write, and output tokens have separate prices; available dollar contributions appear below.";
    const recordedCostRows = selectedArms.map(arm => {
      const meter = usage[arm];
      const recorded = usesMekugi(state, arm) ? meter?.recorded_api_usd
        : meter?.agents.length && meter.agents.every(agent => agent.recorded_api_usd != null)
          ? meter.agents.reduce((sum, agent) => sum + agent.recorded_api_usd!, 0) : null;
      return `| ${labels[arm]} | ${number(recorded, 6)} | ${usesMekugi(state, arm) ? "Mekugi native session estimate" : state.comparison === "codex-mekugi-grok" ? "Grok provider-recorded session cost" : "Not recorded"} |`;
    });
    const checkDetails = selectedArms.flatMap(arm => {
      const grade = state.results?.[arm]?.grade;
      if (!grade) return [`- ${labels[arm as ArmName]}: no grading evidence.`];
      return (["preparation", "router_suite", "supplemental_repeat"] as const).map(name => {
        const check = grade[name];
        if (!check) return `- ${labels[arm as ArmName]} ${name}: not run.`;
        const summary = summarizeCheck(check);
        return `- ${labels[arm as ArmName]} ${name}: exit ${check.exit_code}${check.validation_error ? `; ${check.validation_error}` : ""}; failed tests: ${JSON.stringify(summary.failed_tests)}; ${number(check.elapsed_ms / 1000, 3)} seconds.`;
      });
    });
    const judgeRows = judgeAttempts.map((attempt, index) => {
      const totals = attempt.usage.totals;
      const identity = state.judge?.attempts?.[index];
      return `| ${identity ? `${identity.pass}.${identity.attempt}` : index + 1} | ${attempt.usage.complete ? "complete" : "incomplete"} | ${totals.input_tokens} | ${totals.cached_input_tokens} | ${totals.cache_write_input_tokens} | ${totals.output_tokens} | ${totals.reasoning_output_tokens} | ${totals.total_tokens} | ${number(totals.command_seconds, 3)} | ${number(totals.estimated_api_usd, 6)} |`;
    });
    const warnings = [
      ...(!state.criteria ? ["No task-derived criteria were recorded. Historical measurements are descriptive only; grading completion and winner eligibility are unavailable."] : []),
      ...(state.finishing?.status === "failed" ? [`finishing: ${state.finishing.error ?? "failed"}`] : []),
      ...pricing.warnings.map(warning => `pricing: ${warning}`),
      ...selectedArms.flatMap(arm => (usage[arm]?.warnings ?? [state.results?.[arm] ? "usage was not measured" : "result and usage are missing"]).map(warning => `${labels[arm as ArmName]}: ${warning}`)),
      ...(state.judge ? (judgeUsage?.warnings ?? ["judge usage was not measured"]).map(warning => `judge: ${warning}`) : ["judge: not run"]),
      ...Object.entries(diagnosticsByArm ?? {}).flatMap(([arm, item]) => item?.status === "valid" ? [] : [`${labels[arm as ArmName]}: ${item?.reason ?? "provider capture unavailable"}`]),
    ];
    const judgeSummary = state.judge
      ? `${valid
        ? `Status: **${state.judge.status}**. ${state.judge.passes.length} of 2 passes produced valid results.`
        : `Status: **invalidated**. ${state.judge.passes.length} recorded passes are retained for audit only; their scores, criterion verdicts, and winner are not valid.`}${state.judge.error ? ` Recorded error: ${state.judge.error}` : ""}\n\n${valid && state.judge.status === "complete"
        ? `Two independent reversed-order passes ${state.judge.agreement ? "agreed" : "disagreed"}. Judge winner: **${winnerLabel(state.judge.winner)}**.${state.judge.disagreement ? ` ${state.judge.disagreement}` : ""}`
        : "No judge winner is eligible from an incomplete or invalidated assessment."}\n\n${state.judge.passes.map(pass => passMarkdown(pass, labels)).join("\n\n")}\n\n### Judge usage by attempted pass\n\n| Pass | usage status | input | cached input | cache write input | output | reasoning output | total | command seconds | estimated list-price API USD |\n| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n${judgeRows.join("\n") || "| - | missing | - | - | - | - | - | - | - | unknown |"}\n\nJudge aggregate estimated list-price API cost: ${number(judgeUsage?.totals.estimated_api_usd, 6)} USD; ${number(judgeUsage?.totals.total_tokens)} total tokens.`
      : "Not run.";
    const invalidityNotice = valid ? "" : `> **Infrastructure validity: INVALID**\n>\n${invalidityReasons.map(reason => `> - ${reason}`).join("\n")}\n>\n> Measurements are retained, but gates, completion, and winner are suppressed.\n\n`;
    const suppliedMarkdown = supplied ? `## Supplied supplemental source assessments\n\nThese previously recorded assessments were imported, schema-checked, and rescored programmatically. No inference was started. They ${supplied.agreement ? "agree on the mapped result" : "disagree on the mapped result; no consistent source-quality winner is established"}. They do not replace the official judge, establish unknown assessment costs, or change overall winner eligibility. Provenance beyond the supplied candidate mapping is not independently established. Input SHA-256: ${supplied.source_sha256}.\n\n${supplied.passes.map(pass => passMarkdown(pass, labels)).join("\n\n")}\n\n` : "";
    const setupProvenance = state.setup_revisions
      ? ARMS.map(arm => {
        const c = contexts[arm];
        const revision = c.state.setup_revisions?.[c.arm];
        if (!revision) return `- ${labels[arm]}: setup manifest SHA-256 ${c.state.current_snapshot.manifest_sha256}.`;
        return `- ${labels[arm]}: commit ${revision.commit}; tree ${revision.tree}; manifest SHA-256 ${revision.manifest_sha256}.`;
      }).join("\n")
      : `- Setup manifest SHA-256: ${state.current_snapshot?.manifest_sha256 ?? "unknown"}.`;
    const mekugiDiagnosticsMarkdown = (diagnosticsByArm
      ? ARMS.map(arm => ({ label: labels[arm], diagnostics: diagnosticsByArm[arm] }))
      : [{ label: "", diagnostics: mekugiDiagnostics }])
      .map(({ label, diagnostics }) => (label ? `### ${label}\n\n` : "") + (diagnostics ? `Validation: ${diagnostics.status}. ${diagnostics.reason ?? "Capturer-owned schema and raw evidence reconcile."}\n\nThese exports are within-arm diagnostics, not measured savings against direct Codex. ${state.comparison === "codex-mekugi-grok" ? "Codex JSONL and Grok usage.json remain the paired accounting sources." : "Codex JSONL and rollout usage remain the paired accounting source."} ${state.protected_runtime ? "Capture/runtime mounts are read-only in the executor namespace; the trusted router retains write access. Preflight checks this boundary without inference." : "Export files are writable within the agent container, so consistency validation is not tamper-proof provenance."}\n\n\`\`\`json\n${JSON.stringify(diagnostics.metrics && typeof diagnostics.metrics === "object" ? Object.fromEntries(Object.entries(diagnostics.metrics).filter(([key]) => ["schema", "mode", "model_protocol", "requests", "usage", "capture", "mekugi"].includes(key))) : null, null, 2)}\n\`\`\`` : "Not requested or unavailable in this historical run.")).join("\n\n");
    const md = `# Codex A/B report\n\n${invalidityNotice}> This is a descriptive benchmark. ${state.imported_arms ? "This run compares historical arms with fresh candidates. Host tool-store contents and configuration may differ across runs." : state.imported_control ? "This fresh treatment uses a historical stock control, not a new simultaneous pair. Host tool-store contents and configuration may differ across runs." : selectedArms.length === 1 ? "This single-arm run has no paired winner." : "This single paired run does not establish a causal or generalizable difference."}\n\n- Run: \`${state.id}\`\n- Base: \`${state.source.base_commit}\` (tree \`${state.source.base_tree}\`, source timestamp ${state.source.source_timestamp})\n- Model: ${state.execution.model}, ${state.execution.reasoning_effort} reasoning, ${state.execution.service_tier} service tier\n- Infrastructure validity: **${valid ? "valid" : "invalid"}**\n- Required checks decided: **${checksExecuted ? "yes" : "no"}**\n- Gate result eligible: **${gatesComplete ? "yes" : "no"}**\n- Arm usage complete: **${armUsageComplete ? "yes" : "no"}**\n- Judge result and usage complete: **${valid && judgeComplete && judgeUsageComplete ? "yes" : "no"}**\n- Overall winner: **${winnerLabel(effectiveWinner)}**\n- Winner explanation: ${winnerReason}\n${efficiency ? `- Faster arm: **${winnerLabel(efficiency.faster)}**. Lower estimated list-price cost: **${winnerLabel(efficiency.lower_estimated_cost)}** (descriptive only, not a quality winner).\n` : ""}\nA failed grade does not make measurement incomplete. It only makes that candidate ineligible to win. An assessed failure settles a failed grade even when another pass left criteria unassessed; a winner still needs complete checks in both passes. Missing checks, usage, or infrastructure validity make the overall result incomplete and suppress the winner.\n\n${resourceExplanationMarkdown(resourceExplanation)}\n\n${mechanismsMarkdown(mechanisms)}\n\n${journalEvidenceMarkdown(selectedArms.map(arm => ({ label: labels[arm], evidence: usage[arm]?.journal })), state.comparison === "journal-compaction")}\n\n## Task and setup\n\n${taskText.trim().split("\n").map(line => `> ${line}`).join("\n")}\n\n- Comparison: ${state.comparison ?? "stock-current"}.\n${ARMS.map(arm => `- ${arm}: ${labels[arm]}.`).join("\n")}\n- Mekugi flags: ${JSON.stringify(state.mekugi_flags ?? [])}.\n- Codex: ${state.runtime_tools.codex_version}; executable SHA-256 ${state.runtime_tools.codex_sha256}.\n- Grok: ${state.runtime_tools.grok_version ?? "not used"}; executable SHA-256 ${state.runtime_tools.grok_sha256 ?? "n/a"}.\n- Image: ${state.image_id ?? state.image}.\n- Dependency image: ${state.dependency_image?.image_id ?? "legacy per-run caches"}.\n- Resources per arm: ${state.resource_limits.cpus} CPUs, ${state.resource_limits.memory} memory.\n- Arm execution order: ${state.arm_order ?? "concurrent"}.\n- Trial set: ${state.trial ? `${state.trial.set_id}, pair ${state.trial.index}, controls SHA-256 ${state.trial.controls_sha256}` : "standalone pair"}.\n${setupProvenance}\n- Task SHA-256: ${state.task.sha256}.\n- Runtime boundary: ${state.protected_runtime ? "A: direct Codex with ordinary provider egress. B: Mekugi-owned private namespaces, capability-free executor, router-only egress and read-only capture/runtime mounts. This boundary differs between arms." : "ordinary container boundary; Mekugi exports are executor-writable"}.\n- Mekugi build provenance: ${state.mekugi_build ? `source SHA-256 ${state.mekugi_build.identity.source_archive_sha256}; builder ${state.mekugi_build.identity.image_id}` : "not supplied; executable hashes alone do not establish source provenance"}.\n- Task pack: ${state.task_pack ? `${state.task_pack.id}; snapshot SHA-256 ${state.task_pack.sha256}` : "standalone controls"}.\n\n## Arms\n\n| Arm | preparation, semantic criteria, and scoped package checks | agent seconds | grader seconds | input | uncached input | cached input | cache write input | output | reasoning output | total | command seconds | API-equivalent USD |\n| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n${armRows.join("\n")}\n\n${costExplanation}\n\nAll arm cost comparisons use captured list prices, not mixed native/provider totals. Grok session-only estimates use base rates when request-level tiering is unavailable; see warnings. Mekugi arm tokens and requests come from validated provider attempts, excluding prewarm, so they include router-side re-sends and retries that the Codex rollout omits; without a validated capture they fall back to the Codex rollout, as the warnings state. Direct Codex rollouts omit prewarm too.\n\n### Native/provider costs (not the comparison basis)\n\n| Arm | recorded USD | source |\n| --- | ---: | --- |\n${recordedCostRows.join("\n")}\n\nThese figures may use different rates, service tiers, or accounting scopes. Fewer total tokens alone does not guarantee lower cost: uncached input and output have different prices.\n\n## Mekugi within-arm diagnostics\n\n${mekugiDiagnosticsMarkdown}\n\n${semanticMarkdown}## Check details\n\n${checkDetails.join("\n")}\n\n${Object.entries(baselineDifferences).map(([arm, differences]) => `## ${labels[arm]} minus ${labels[ARMS[0]!]}\n\n${Object.entries(differences).map(([key, value]) => `- ${key}: ${value === null ? "not available" : `${value}%`}`).join("\n")}`).join("\n\n")}\n\n${performanceText}\n\n## Judge\n\n${judgeSummary}\n\n${suppliedMarkdown}## Pricing provenance\n\nAll compared USD figures use the captured list-price snapshot. Grok aggregate estimates use base rates, with unknown request-level long-context premiums excluded and explicitly warned. Native/provider-reported totals are retained separately for reconciliation, not mixed into comparison costs. These estimates are not subscription charges or invoices; service-tier premiums are not modeled.\n\n- Source: ${pricing.source}\n- Fetched at: ${pricing.fetched_at}\n- Catalog: ${pricing.catalog_url}\n${pricing.assumptions.map(assumption => `- Assumption: ${assumption}`).join("\n") || "- No pricing assumptions recorded."}\n\n## Warnings\n\n${warnings.map(warning => `- ${warning}`).join("\n") || "- None."}\n\nThis is the complete human-readable result: task/setup, behavioral explanation, measurements, checks, and source judgments are inline. The accompanying JSON is machine-readable evidence, not another required report.\n`;
    let rendered = md;
    if (state.imported_arms) rendered = rendered.replace("## Arms\n\n", `## Imported arms\n\n${Object.entries(state.imported_arms).map(([arm, imported]) => `- ${labels[arm]}: run ${imported.source_run_id}, arm ${imported.source_arm}; published bundle SHA-256 ${imported.bundle_sha256}.`).join("\n")}\n\nImported candidates were not rerun. ${state.evaluation?.mode === "reuse" ? "Their grades, scores, and assessments were reused unchanged. Fresh candidates were evaluated with adapted historical tests preserving the same behavioral scope. Rankings combine historical and new scores, not a fresh joint blind verdict." : "Their patches receive fresh assessments."} Usage is recomputed from retained original evidence with this run's list prices. Source setup manifests and measurement evidence are retained in the bundle. Prepared setup slots for imported arms were not executed.\n\n${state.evaluation?.mode === "reuse" ? Object.entries(state.evaluation.baselines ?? {}).map(([arm, baseline]) => `- Evaluation baseline for ${labels[arm]}: ${labels[baseline]}.`).join("\n") + "\n\n" : ""}## Arms\n\n`);
    if (state.imported_control) rendered = rendered.replace("## Arms\n\n", `## Imported stock control\n\nRun ${state.imported_control.source_run_id}; published bundle SHA-256 ${state.imported_control.bundle_sha256}. Task, setup, model, Codex, image, resource, and rollout identities were checked before treatment inference. The source attempt was not rerun; its captured patch was independently graded against the new treatment. The target bundle retains its published report and manifest.\n\n## Arms\n\n`);
    await writeReport(markdownPath, rendered);
    return { jsonPath, markdownPath };
  };
}

export async function buildReportUnlocked(runDirectory: string, options: ReportOptions = {}): Promise<{ jsonPath: string; markdownPath: string }> {
  return (await prepareReportUnlocked(runDirectory, options))();
}

export async function buildReport(runDirectory: string, options: ReportOptions = {}): Promise<{ jsonPath: string; markdownPath: string }> {
  const { outputDirectory } = options;
  return withRunLock(resolve(runDirectory), async () => {
    const renderReport = await prepareReportUnlocked(runDirectory, options);
    const paths = await renderReport();
    if (outputDirectory) return paths;
    if ((await readState(resolve(runDirectory))).finishing) {
      try {
        await collectBundle(runDirectory);
        await finalizeBundle(runDirectory);
      } catch (error) {
        const state = await readState(resolve(runDirectory));
        if (state.finishing) {
          state.finishing.status = "failed";
          state.finishing.error = String(error);
          await writeState(resolve(runDirectory), state);
        }
        await renderReport();
        await finalizeBundle(runDirectory);
        throw error;
      }
    }
    return paths;
  });

}

export async function invalidateRun(runDirectory: string, reasons: string[]): Promise<void> {
  return withRunLock(resolve(runDirectory), () => invalidateRunUnlocked(runDirectory, reasons));
}
