import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { prepare, type PrepareOptions } from "./prepare";
import { loadTaskPack } from "./task-pack";
import { prepareTrials, readTrialSet, reportTrials, runTrials, summarize } from "./trials";
import { sha256, withRunLock } from "./state";
import type { ArmName } from "./types";

type SuiteComparison = "stock-current" | "mentor-matrix";
type Schedule = "concurrent" | "alternating";
interface SuiteTask { id: string; pack: string }
interface SuiteManifest { schema: "codex-ab.suite.v1"; tasks: SuiteTask[] }
interface SuiteSet { task: string; setup: "standard" | ArmName; trial_set: string; status: "prepared" | "running" | "complete" | "failed"; error?: string }
interface SuiteState {
  schema: "codex-ab.suite-run.v1"; id: string; created_at: string;
  status: "preparing" | "prepared" | "running" | "complete" | "partial";
  comparison: SuiteComparison; schedule: Schedule; count: number;
  manifest_sha256: string; sources_sha256: string; sets: SuiteSet[]; error?: string;
}
interface PairReport {
  measurement_complete: boolean;
  arms: Record<ArmName, { result?: { agent_elapsed_ms: number; grade?: { passed: boolean } } | null;
    usage?: { complete: boolean; totals: { estimated_api_usd: number | null } } | null }>;
}
interface TrialReport { trial_set: { controls: { task_pack?: { id?: string }; mentor?: { setup?: ArmName } } };
  pairs: Array<{ eligible: boolean; report: PairReport | null }> }

const cleanName = (value: string): boolean => /^[a-z0-9][a-z0-9-]*$/.test(value);
function localAsset(directory: string, path: string): string {
  if (!path || isAbsolute(path) || path.split(/[\\/]/).some(part => !part || part === "." || part === "..")) throw new Error("unsafe suite pack path");
  return join(directory, path);
}
async function writeSuite(directory: string, state: SuiteState): Promise<void> {
  const temporary = join(directory, ".suite.tmp");
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, join(directory, "suite.json"));
}
async function readSuite(directory: string): Promise<SuiteState> {
  const state = JSON.parse(await readFile(join(directory, "suite.json"), "utf8")) as SuiteState;
  if (state.schema !== "codex-ab.suite-run.v1" || state.id !== basename(directory) || !Array.isArray(state.sets)
    || !["stock-current", "mentor-matrix"].includes(state.comparison) || !["concurrent", "alternating"].includes(state.schedule)
    || !Number.isSafeInteger(state.count) || state.count < 2 || !/^[0-9a-f]{64}$/.test(state.manifest_sha256)
    || !/^[0-9a-f]{64}$/.test(state.sources_sha256)) throw new Error("invalid suite identity");
  const keys = new Set<string>();
  for (const set of state.sets) {
    const key = `${set.task}/${set.setup}`;
    if (!cleanName(set.task) || keys.has(key) || !["standard", "stock", "current"].includes(set.setup)
      || !/^codex-ab-trials-[A-Za-z0-9]+$/.test(set.trial_set)) throw new Error("suite set plan changed");
    keys.add(key);
  }
  return state;
}

export async function prepareSuite(options: {
  manifestPath: string; sourcesPath: string; comparison: SuiteComparison; count: number; schedule: Schedule;
  outputParent?: string; dockerBin?: string;
  common: Omit<PrepareOptions, "source" | "baseCommit" | "forbiddenCommit" | "taskPath" | "taskPackPath" | "comparison" | "mentorSetup" | "profile">;
}): Promise<string> {
  if (!Number.isSafeInteger(options.count) || options.count < 2) throw new Error("suite count must be at least 2");
  if (!["stock-current", "mentor-matrix"].includes(options.comparison)) throw new Error("unsupported suite comparison");
  if (!["concurrent", "alternating"].includes(options.schedule)) throw new Error("unsupported suite schedule");
  const manifestPath = resolve(options.manifestPath);
  const sourcesPath = resolve(options.sourcesPath);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as SuiteManifest;
  const sources = JSON.parse(await readFile(sourcesPath, "utf8")) as Record<string, unknown>;
  if (manifest.schema !== "codex-ab.suite.v1" || !Array.isArray(manifest.tasks) || manifest.tasks.length < 2
    || !sources || typeof sources !== "object" || Array.isArray(sources)) throw new Error("invalid suite manifest or sources map");
  const tasks = await Promise.all(manifest.tasks.map(async item => {
    if (!cleanName(item.id) || typeof sources[item.id] !== "string") throw new Error(`missing source checkout for suite task ${item.id}`);
    const packPath = localAsset(dirname(manifestPath), item.pack);
    const pack = await loadTaskPack(packPath);
    if (pack.manifest.id !== item.id) throw new Error(`suite task identity mismatch: ${item.id}`);
    return { id: item.id, packPath, source: sources[item.id] as string, pack };
  }));
  if (new Set(tasks.map(task => task.id)).size !== tasks.length) throw new Error("duplicate suite task");
  const directory = await mkdtemp(join(options.outputParent ?? tmpdir(), "codex-ab-suite-"));
  const state: SuiteState = { schema: "codex-ab.suite-run.v1", id: basename(directory), created_at: new Date().toISOString(),
    status: "preparing", comparison: options.comparison, schedule: options.schedule, count: options.count,
    manifest_sha256: await sha256(manifestPath), sources_sha256: await sha256(sourcesPath), sets: [] };
  await writeSuite(directory, state);
  try {
    for (const task of tasks) {
      for (const setup of options.comparison === "mentor-matrix" ? ["stock", "current"] as const : ["standard"] as const) {
        process.stderr.write(`[suite] preparing ${task.id}, ${setup}\n`);
        const run = await prepare({ ...options.common, source: task.source,
          baseCommit: task.pack.manifest.source.base_commit, forbiddenCommit: task.pack.manifest.source.forbidden_commit,
          taskPath: task.pack.taskPath, taskPackPath: task.packPath, profile: "task",
          comparison: options.comparison === "mentor-matrix" ? "mentor-handoff" : "stock-current",
          mentorSetup: setup === "standard" ? undefined : setup,
          reasoningEffort: setup === "standard" ? options.common.reasoningEffort : "high",
          outputParent: directory });
        const trialSet = await prepareTrials({ runDir: run, count: options.count, schedule: options.schedule,
          outputParent: directory, dockerBin: options.dockerBin });
        state.sets.push({ task: task.id, setup, trial_set: basename(trialSet), status: "prepared" });
        await writeSuite(directory, state);
      }
    }
    state.status = "prepared";
  } catch (error) {
    state.status = "partial";
    state.error = String(error);
    await writeSuite(directory, state);
    throw new Error(`suite preparation failed; retained ${directory}: ${String(error)}`);
  }
  await writeSuite(directory, state);
  return directory;
}

function value(pair: PairReport, arm: ArmName, metric: "agent_seconds" | "estimated_api_usd"): number | null {
  const item = pair.arms[arm];
  if (!item) return null;
  return metric === "agent_seconds" ? item.result ? item.result.agent_elapsed_ms / 1000 : null
    : item.usage?.complete ? item.usage.totals.estimated_api_usd : null;
}
async function reportSuiteUnlocked(directory: string, state: SuiteState): Promise<string> {
  const rows: Array<{ task: string; setup: SuiteSet["setup"]; planned: number; measured: number; both_pass: number;
    values: Record<ArmName, Record<"agent_seconds" | "estimated_api_usd", number[]>>; report: string }> = [];
  for (const set of state.sets) {
    const trialDir = join(directory, set.trial_set);
    const trial = await readTrialSet(trialDir);
    const reportPath = await reportTrials(trialDir);
    const report = JSON.parse(await readFile(join(dirname(reportPath), "report.json"), "utf8")) as TrialReport;
    if (trial.controls.task_pack?.id !== set.task || report.trial_set.controls.task_pack?.id !== set.task
      || (state.comparison === "mentor-matrix" && trial.controls.mentor?.setup !== set.setup)) throw new Error("suite task or setup identity changed");
    const measured = report.pairs.filter(pair => pair.eligible && pair.report?.measurement_complete);
    const passing = measured.map(pair => pair.report!).filter(pair => pair.arms.stock.result?.grade?.passed && pair.arms.current.result?.grade?.passed);
    const values = { stock: { agent_seconds: [], estimated_api_usd: [] }, current: { agent_seconds: [], estimated_api_usd: [] } } as
      Record<ArmName, Record<"agent_seconds" | "estimated_api_usd", number[]>>;
    for (const pair of passing) for (const metric of ["agent_seconds", "estimated_api_usd"] as const) {
      const a = value(pair, "stock", metric), b = value(pair, "current", metric);
      if (a !== null && b !== null && Number.isFinite(a) && Number.isFinite(b)) { values.stock[metric].push(a); values.current[metric].push(b); }
    }
    rows.push({ task: set.task, setup: set.setup, planned: report.pairs.length, measured: measured.length,
      both_pass: passing.length, values, report: relative(directory, reportPath) });
  }
  const effects = rows.map(row => {
    const effect = (metric: "agent_seconds" | "estimated_api_usd") => {
      const a = row.values.stock[metric], b = row.values.current[metric];
      return a.length && a.length === b.length ? summarize(b.map((item, index) => item - a[index]!)).mean : null;
    };
    return { task: row.task, setup: row.setup, agent_seconds: effect("agent_seconds"), estimated_api_usd: effect("estimated_api_usd") };
  });
  const macro = Object.fromEntries(["agent_seconds", "estimated_api_usd"].map(metric => [metric,
    Object.fromEntries([...new Set(effects.map(item => item.setup))].map(setup => [setup,
      summarize(effects.flatMap(item => item.setup === setup && item[metric as "agent_seconds" | "estimated_api_usd"] !== null
        ? [item[metric as "agent_seconds" | "estimated_api_usd"]!] : []))]))]));
  const format = (item: number | null): string => item === null ? "unknown" : item.toFixed(4);
  const destination = await mkdtemp(join(directory, "report-"));
  const summary = { schema: "codex-ab.suite-report.v1", suite: state, rows, effects, macro, generated_at: new Date().toISOString() };
  const markdown = `# Cross-task benchmark suite\n\nComparison: ${state.comparison}. Schedule: ${state.schedule}. Status: ${state.status}. These are descriptive results, not a causal or significance claim. Every row reports one task and one setup; the stock/current arm names mean mentor off/on in mentor-matrix rows. Only complete valid pairs whose **both** candidates passed contribute to speed and cost effects. Missing or failed measurements are never zero-filled.\n\n| Task | Setup | Planned pairs | Measured pairs | Both passed | B-A agent seconds | B-A estimated USD |\n| --- | --- | ---: | ---: | ---: | ---: | ---: |\n${rows.map((row, index) => `| ${row.task} | ${row.setup} | ${row.planned} | ${row.measured} | ${row.both_pass} | ${format(effects[index]!.agent_seconds)} | ${format(effects[index]!.estimated_api_usd)} |`).join("\n")}\n\n## Equal-task macro effects\n\nEach eligible task has equal weight, regardless of repetitions.\n\n| Setup | Eligible tasks, time | Mean B-A seconds | Eligible tasks, cost | Mean B-A USD |\n| --- | ---: | ---: | ---: | ---: |\n${Object.entries(macro.agent_seconds).map(([setup, time]) => `| ${setup} | ${time.n} | ${format(time.mean)} | ${macro.estimated_api_usd[setup]?.n ?? 0} | ${format(macro.estimated_api_usd[setup]?.mean ?? null)} |`).join("\n")}\n\n## Per-task evidence\n\n${rows.map(row => `- ${row.task}, ${row.setup}: ${row.report}`).join("\n")}\n\nAll four mentor-matrix cells use Mekugi. A cross-setup difference is not a within-run randomized effect; compare stock and current setup rows cautiously. Estimates are public-list API equivalents, not invoices.\n`;
  await writeFile(join(destination, "report.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(destination, "report.md"), markdown, { mode: 0o600 });
  return join(destination, "report.md");
}

export function reportSuite(directory: string): Promise<string> {
  const root = resolve(directory);
  return withRunLock(root, async () => reportSuiteUnlocked(root, await readSuite(root)));
}

export function runSuite(options: { directory: string; authFile: string; dockerBin?: string; signal?: AbortSignal }): Promise<string> {
  const directory = resolve(options.directory);
  return withRunLock(directory, async () => {
    const state = await readSuite(directory);
    if (state.status !== "prepared" || state.sets.some(set => set.status !== "prepared")) throw new Error("suite execution cannot resume; prepare a fresh suite");
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (options.signal?.aborted) cancel();
    options.signal?.addEventListener("abort", cancel, { once: true });
    process.on("SIGINT", cancel); process.on("SIGTERM", cancel);
    state.status = "running";
    await writeSuite(directory, state);
    try {
      for (const [index, set] of state.sets.entries()) {
        if (controller.signal.aborted) break;
        set.status = "running"; await writeSuite(directory, state);
        process.stderr.write(`[suite] running ${index + 1}/${state.sets.length}: ${set.task}, ${set.setup}\n`);
        try { await runTrials({ directory: join(directory, set.trial_set), authFile: options.authFile,
          dockerBin: options.dockerBin, signal: controller.signal }); set.status = "complete"; }
        catch (error) { set.status = "failed"; set.error = String(error); }
        await writeSuite(directory, state);
      }
      state.status = !controller.signal.aborted && state.sets.every(set => set.status === "complete") ? "complete" : "partial";
      if (controller.signal.aborted) state.error = "canceled; unstarted trial sets remain unstarted";
      await writeSuite(directory, state);
      const report = await reportSuiteUnlocked(directory, state);
      if (state.status !== "complete") throw new Error(`suite incomplete; retained report: ${report}`);
      return report;
    } finally {
      options.signal?.removeEventListener("abort", cancel);
      process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
    }
  });
}
