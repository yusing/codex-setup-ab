import { copyFile, cp, mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { verifyBundleManifest, writeBundleManifest } from "./bundle";
import { preflightRunUnlocked } from "./runner";
import { verifyPreparedInputs } from "./prepare";
import { runBenchmarkUnlocked } from "./workflow";
import { fetchPricing, type MeteredRollouts } from "./usage";
import { readState, sha256, withRunLock, writeState } from "./state";
import type { ArmName, ArmOrder, ArmResult, RunState } from "./types";

type Schedule = "concurrent" | "alternating";
interface Trial {
  index: number;
  run_dir: string;
  run_id: string;
  order: ArmOrder;
  status: "prepared" | "running" | "complete" | "failed";
  error?: string;
  bundle_sha256?: string;
  report_sha256?: string;
  markdown_sha256?: string;
}
export interface TrialSet {
  schema: "codex-ab.trials.v1";
  id: string;
  created_at: string;
  status: "preparing" | "prepared" | "running" | "complete" | "partial";
  schedule: Schedule;
  controls: ReturnType<typeof trialControls>;
  controls_sha256: string;
  plan_sha256: string;
  trials: Trial[];
  error?: string;
}
interface PairReport {
  run_id: string;
  measurement_complete: boolean;
  winner: string;
  setup: { arm_order: ArmOrder; trial: RunState["trial"] };
  arms: Record<ArmName, { result: ArmResult | null; usage: MeteredRollouts | null }>;
  judge?: { usage?: MeteredRollouts } | null;
}

/** Pin experimental inputs, not run-local paths, timestamps, attempts or results. */
export function trialControls(state: RunState) {
  return {
    profile: state.profile, source: state.source, submodules: state.submodules,
    task: state.task, task_pack: state.task_pack, criteria: state.criteria,
    comparison: state.comparison ?? "stock-current", execution: state.execution,
    image_id: state.image_id, resource_limits: state.resource_limits, timeout_seconds: state.timeout_seconds,
    current_snapshot: state.current_snapshot, snapshot_manifest: state.snapshot_manifest,
    runtime_tools: state.runtime_tools, operator: state.operator, arms: state.arms,
    protected_runtime: state.protected_runtime, mekugi_flags: state.mekugi_flags,
    mekugi_build: state.mekugi_build, mekugi_exports: state.mekugi_exports, pricing: state.pricing,
  };
}
function digest(value: unknown): string { return new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex"); }
function armOrder(schedule: Schedule, index: number): ArmOrder {
  return schedule === "concurrent" ? "concurrent" : index % 2 === 1 ? "stock-first" : "current-first";
}
async function writeSet(directory: string, set: TrialSet): Promise<void> {
  const temporary = join(directory, ".trials.tmp");
  await writeFile(temporary, `${JSON.stringify(set, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, join(directory, "trials.json"));
}
export async function readTrialSet(directory: string): Promise<TrialSet> {
  const set = JSON.parse(await readFile(join(directory, "trials.json"), "utf8")) as TrialSet;
  if (set.schema !== "codex-ab.trials.v1" || !/^codex-ab-trials-[A-Za-z0-9]+$/.test(set.id)
    || !["concurrent", "alternating"].includes(set.schedule) || !Array.isArray(set.trials) || set.trials.length < 2
    || digest(set.controls) !== set.controls_sha256
    || digest({ controls: set.controls_sha256, count: set.trials.length, schedule: set.schedule }) !== set.plan_sha256 || !/^sha256:[0-9a-f]{64}$/.test(set.controls.image_id ?? "")) {
    throw new Error("invalid trial-set identity or controls");
  }
  for (const [offset, trial] of set.trials.entries()) {
    const index = offset + 1;
    if (trial.index !== index || trial.run_dir !== `runs/${index}` || trial.run_id !== `${set.id}-${index}`
      || trial.order !== armOrder(set.schedule, index)) throw new Error("trial-set plan changed");
  }
  return set;
}
function assertMembership(set: TrialSet, trial: Trial, state: RunState): void {
  if (state.id !== trial.run_id || digest(trialControls(state)) !== set.controls_sha256
    || state.arm_order !== trial.order || state.trial?.set_id !== set.id || state.trial.index !== trial.index
    || state.trial.controls_sha256 !== set.controls_sha256 || state.trial.plan_sha256 !== set.plan_sha256) throw new Error("trial controls or membership changed");
}
function assertFresh(state: RunState): void {
  if (state.status !== "prepared" || state.results || state.arm_attempts || state.finishing || state.judge) {
    throw new Error("trial preparation/execution requires a fresh prepared pair");
  }
}

export async function prepareTrials(options: {
  runDir: string; count: number; schedule?: Schedule; outputParent?: string; dockerBin?: string;
}): Promise<string> {
  if (!Number.isSafeInteger(options.count) || options.count < 2) throw new Error("--count must be an integer of at least 2");
  const schedule = options.schedule ?? "concurrent";
  if (!["concurrent", "alternating"].includes(schedule)) throw new Error("--order must be concurrent or alternating");
  const prototype = resolve(options.runDir);
  return withRunLock(prototype, async () => {
    const initial = await readState(prototype);
    assertFresh(initial);
    if (initial.trial) throw new Error("use a standalone prepared pair as the trial prototype");
    await preflightRunUnlocked(prototype, options.dockerBin);
    const state = await readState(prototype);
    state.pricing ??= await fetchPricing();
    const controls = trialControls(state);
    const controlsSha256 = digest(controls);
    const directory = await mkdtemp(join(options.outputParent ?? tmpdir(), "codex-ab-trials-"));
    const set: TrialSet = {
      schema: "codex-ab.trials.v1", id: basename(directory), created_at: new Date().toISOString(),
      status: "preparing", schedule, controls, controls_sha256: controlsSha256,
      plan_sha256: digest({ controls: controlsSha256, count: options.count, schedule }),
      trials: Array.from({ length: options.count }, (_, offset) => {
        const index = offset + 1;
        return { index, run_dir: `runs/${index}`, run_id: `${basename(directory)}-${index}`,
          order: armOrder(schedule, index), status: "prepared" };
      }),
    };
    await writeSet(directory, set);
    process.stderr.write(`[trials] preparing ${set.trials.length} fresh pairs in ${directory}\n`);
    try {
      for (const trial of set.trials) {
        const target = join(directory, trial.run_dir);
        await mkdir(target, { recursive: true, mode: 0o700 });
        // Never copy executed arm homes, auth, reports, probe state or operation locks.
        const paths = ["seed.git", "control", "evaluator", "snapshots", "arms/stock/repo", "arms/current/repo",
          ...(state.mekugi_build?.files.map(file => file.path) ?? []),
          ...(state.runtime_tools.preflight_cache ? ["artifacts/preflight-cache"] : [])];
        for (const path of paths) {
          const destination = join(target, path);
          await mkdir(dirname(destination), { recursive: true });
          await cp(join(prototype, path), destination, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
        }
        await mkdir(join(target, "artifacts"), { recursive: true });
        const fresh: RunState = { ...state, id: trial.run_id, created_at: new Date().toISOString(),
          arm_order: trial.order, trial: { set_id: set.id, index: trial.index, controls_sha256: set.controls_sha256, plan_sha256: set.plan_sha256 } };
        await writeState(target, fresh);
        await verifyPreparedInputs(target, fresh);
        process.stderr.write(`[trials] prepared pair ${trial.index}/${set.trials.length} (${trial.order})\n`);
      }
      set.status = "prepared";
    } catch (error) {
      set.status = "partial";
      set.error = String(error);
      await writeSet(directory, set);
      throw new Error(`trial preparation failed; retained ${directory}: ${String(error)}`);
    }
    await writeSet(directory, set);
    return directory;
  });
}

export async function runTrials(options: { directory: string; authFile: string; grokAuthFile?: string; dockerBin?: string; signal?: AbortSignal }): Promise<string> {
  const directory = resolve(options.directory);
  return withRunLock(directory, async () => {
    const set = await readTrialSet(directory);
    if (set.status !== "prepared" || set.trials.some(trial => trial.status !== "prepared")) throw new Error("trial sets never resume or restart; prepare a new set");
    for (const trial of set.trials) {
      const state = await readState(join(directory, trial.run_dir));
      assertMembership(set, trial, state);
      assertFresh(state);
    }
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    options.signal?.addEventListener("abort", cancel, { once: true });
    process.on("SIGINT", cancel);
    process.on("SIGTERM", cancel);
    set.status = "running";
    await writeSet(directory, set);
    try {
      for (const trial of set.trials) {
        if (controller.signal.aborted) break;
        trial.status = "running";
        await writeSet(directory, set);
        process.stderr.write(`[trials] executing pair ${trial.index}/${set.trials.length} (${trial.order})\n`);
        const runDir = join(directory, trial.run_dir);
        try {
          await withRunLock(runDir, async () => {
            try {
              assertMembership(set, trial, await readState(runDir));
              await runBenchmarkUnlocked({ runDir, authFile: options.authFile, grokAuthFile: options.grokAuthFile, dockerBin: options.dockerBin, signal: controller.signal });
              trial.status = "complete";
            } catch (error) {
              trial.status = "failed";
              trial.error = String(error);
              process.stderr.write(`[trials] pair ${trial.index} failed; available evidence retained\n`);
            }
            const evidence = join(directory, "evidence", String(trial.index));
            await mkdir(evidence, { recursive: true, mode: 0o700 });
            try {
              await cp(join(runDir, "reports/bundle"), evidence, { recursive: true, verbatimSymlinks: true });
              await copyFile(join(runDir, "run.json"), join(evidence, "run.json"));
              trial.report_sha256 = await sha256(join(evidence, "report.json"));
              trial.markdown_sha256 = await sha256(join(evidence, "report.md"));
              await writeBundleManifest(evidence);
              trial.bundle_sha256 = await sha256(join(evidence, "MANIFEST.sha256"));
            } catch (error) {
              trial.error = `${trial.error ?? ""} Evidence freeze incomplete: ${String(error)}`.trim();
              trial.status = "failed";
            }
          });
        } catch (error) {
          trial.status = "failed";
          trial.error = String(error);
        }
        await writeSet(directory, set);
      }
      set.status = !controller.signal.aborted && set.trials.every(trial => trial.status === "complete") ? "complete" : "partial";
      if (controller.signal.aborted) set.error = "canceled; unstarted pairs retained without execution";
      await writeSet(directory, set);
      const report = await reportTrialsUnlocked(directory, set);
      if (set.status === "partial") throw new Error(`trial set incomplete; retained aggregate: ${report}`);
      return report;
    } finally {
      options.signal?.removeEventListener("abort", cancel);
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    }
  });
}

export function summarize(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (!n) return { n, mean: null, median: null, sample_sd: null, min: null, max: null };
  const mean = sorted.reduce((sum, value) => sum + value, 0) / n;
  return { n, mean, median: n % 2 ? sorted[Math.floor(n / 2)]! : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2,
    sample_sd: n > 1 ? Math.sqrt(sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1)) : null,
    min: sorted[0]!, max: sorted[n - 1]! };
}
const metrics = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens",
  "total_tokens", "estimated_api_usd", "command_seconds", "agent_seconds", "grader_seconds"] as const;
type Metric = typeof metrics[number];
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function measurement(report: PairReport, arm: ArmName, metric: Metric): number | null {
  const item = report.arms[arm];
  if (metric === "agent_seconds") return item.result ? item.result.agent_elapsed_ms / 1000 : null;
  if (metric === "grader_seconds") return item.result?.grade ? item.result.grade.elapsed_ms / 1000 : null;
  return item.usage?.totals[metric] ?? null;
}
export function aggregatePairs(reports: PairReport[]) {
  return Object.fromEntries(metrics.map(metric => {
    const pairs = reports.map(report => [measurement(report, "stock", metric), measurement(report, "current", metric)])
      .filter((pair): pair is [number, number] => pair.every(finite));
    return [metric, { stock: summarize(pairs.map(pair => pair[0])), current: summarize(pairs.map(pair => pair[1])),
      difference: summarize(pairs.map(([a, b]) => b - a)),
      percent: summarize(pairs.filter(([a]) => a !== 0).map(([a, b]) => (b - a) / a * 100)) }];
  }));
}

async function reportTrialsUnlocked(directory: string, set: TrialSet): Promise<string> {
  await mkdir(join(directory, "reports"), { recursive: true });
  const destination = await mkdtemp(join(directory, "reports/aggregate-"));
  const rows: Array<{ trial: Trial; eligible: boolean; reason: string | null; report: PairReport | null }> = [];
  const sections: string[] = [];
  for (const trial of set.trials) {
    const frozen = join(directory, "evidence", String(trial.index));
    const evidence = join(destination, "trials", String(trial.index));
    await mkdir(evidence, { recursive: true });
    let report: PairReport | null = null;
    let reason: string | null = null;
    let markdown = "No completed pair report is available.";
    try {
      if (trial.status === "prepared") {
        await copyFile(join(directory, trial.run_dir, "run.json"), join(evidence, "run.json"));
        throw new Error("pair was not started");
      }
      await cp(frozen, evidence, { recursive: true, verbatimSymlinks: true });
      const state = await readState(evidence);
      assertMembership(set, trial, state);
      if (!trial.report_sha256 || !trial.markdown_sha256) throw new Error("pair report was not finalized by this trial set");
      if (!trial.bundle_sha256) throw new Error("pair evidence freeze was incomplete");
      await verifyBundleManifest(evidence, trial.bundle_sha256);
      if (await sha256(join(evidence, "report.json")) !== trial.report_sha256
        || await sha256(join(evidence, "report.md")) !== trial.markdown_sha256) throw new Error("retained pair report changed");
      report = JSON.parse(await readFile(join(evidence, "report.json"), "utf8")) as PairReport;
      markdown = await readFile(join(evidence, "report.md"), "utf8");
      if (report.run_id !== state.id || report.setup.arm_order !== trial.order
        || JSON.stringify(report.setup.trial) !== JSON.stringify(state.trial)) throw new Error("pair report identity mismatch");
      if (trial.status !== "complete" || state.status !== "complete" || state.finishing?.status !== "complete"
        || state.invalidity_reasons?.length || report.measurement_complete !== true) reason = "incomplete or invalid paired measurement";
    } catch (error) { reason = String(error); report = null; markdown = "No verified pair report is available; retained evidence is under trials/."; }
    rows.push({ trial, eligible: reason === null, reason, report });
    sections.push(`## Pair ${trial.index}: ${trial.order}\n\n${reason ? `Excluded from paired aggregates: ${reason}\n\n` : ""}${markdown}`);
  }
  const eligible = rows.filter(row => row.eligible).map(row => row.report!);
  const paired = aggregatePairs(eligible);
  const judgeValues = rows.flatMap(row => {
    const usage = row.report?.judge?.usage;
    return usage?.complete && finite(usage.totals.estimated_api_usd) ? [usage.totals.estimated_api_usd] : [];
  });
  const winners = Object.fromEntries(["stock", "current", "tie", "none"].map(winner => [winner, eligible.filter(report => report.winner === winner).length]));
  const result = { schema: "codex-ab.trial-report.v1", generated_at: new Date().toISOString(), trial_set: set,
    planned_pairs: set.trials.length, eligible_pairs: eligible.length, winners, current_minus_stock: paired,
    judge_estimated_api_usd: { ...summarize(judgeValues), total: judgeValues.length ? judgeValues.reduce((a, b) => a + b, 0) : null },
    pairs: rows };
  const display = (value: number | null): string => value === null ? "unavailable" : String(Number(value.toFixed(6)));
  const markdown = `# Repeated Codex A/B report

- Trial set: ${set.id}; status: ${set.status}.
- Controls SHA-256: ${set.controls_sha256}; plan SHA-256: ${set.plan_sha256}.
- Schedule: ${set.schedule}. Pairs run one after another; concurrent arms remain the default.
- Eligible pairs: ${eligible.length}/${set.trials.length}.
- Boundary: ${set.controls.protected_runtime ? "A is direct Codex with provider egress; B uses the protected router-only executor. These boundaries differ." : "ordinary container boundaries"}.

These are descriptive paired observations, not a causal claim or statistical significance test.
Alternating order changes within-pair resource contention; do not pool it with concurrent trials.
All planned pairs are listed, including failed and unstarted pairs. Only complete, valid paired
measurements enter the table. A failed behavioral grade can still be a complete measurement.
Missing values are never zero-filled. Each metric uses only pairs with both finite values;
percent differences additionally omit zero A baselines. Differences are B minus A.
Judge costs below are separate from arm costs. Pair checks, usage, timing, pricing and source
judgments are included inline after the summary; machine evidence is retained under trials/.

| Metric | paired n | mean A | mean B | mean B-A | median B-A | sample SD B-A | percent n | mean % B-A |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${Object.entries(paired).map(([key, value]) => `| ${key} | ${value.difference.n} | ${display(value.stock.mean)} | ${display(value.current.mean)} | ${display(value.difference.mean)} | ${display(value.difference.median)} | ${display(value.difference.sample_sd)} | ${value.percent.n} | ${display(value.percent.mean)} |`).join("\n")}

Eligible-pair winners: A ${winners.stock}, B ${winners.current}, tie ${winners.tie}, no eligible winner ${winners.none}. This count is descriptive, not an aggregate winner claim.

Judge estimated API USD: ${display(result.judge_estimated_api_usd.total)} across ${judgeValues.length}/${set.trials.length} pairs with complete judge accounting. Missing judge costs are unknown.

| Pair | Order | Execution | Paired measurement |
| --- | --- | --- | --- |
${rows.map(row => `| ${row.trial.index} | ${row.trial.order} | ${row.trial.status} | ${row.reason?.replaceAll("|", "\\|").replaceAll("\n", " ") ?? "included"} |`).join("\n")}

${sections.join("\n\n")}
`;
  await writeFile(join(destination, "trials.json"), `${JSON.stringify(set, null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(destination, "report.json"), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(destination, "report.md"), markdown, { mode: 0o600 });
  await writeBundleManifest(destination);
  return join(destination, "report.md");
}

export function reportTrials(directory: string): Promise<string> {
  const root = resolve(directory);
  return withRunLock(root, async () => reportTrialsUnlocked(root, await readTrialSet(root)));
}
