import { copyFile, cp, lstat, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { verifyBundleManifest } from "./bundle";
import { armExecutionSucceeded, readState, sha256 } from "./state";
import { meterRollouts, type PricingSnapshot, USAGE_KEYS } from "./usage";
import { armNames, type ArmImport, type ArmResult, type RunState } from "./types";
import { isPairedMekugiComparison } from "./mekugi";
import { armLabels } from "./arm-labels";
import { dependencyKey } from "./dependencies";
import { historicalEvaluation } from "./evaluation";

function digest(value: unknown): string { return new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex"); }

export function parseArmImports(value: unknown): ArmImport[] {
  if (!Array.isArray(value) || !value.length) throw new Error("--import-arms requires a nonempty JSON array");
  const targets = new Set<string>();
  return value.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)
      || Object.keys(item).some(key => !["target_arm", "run_dir", "arm", "bundle_sha256"].includes(key))
      || ["target_arm", "run_dir", "arm"].some(key => typeof item[key] !== "string" || !item[key].trim())
      || item.bundle_sha256 !== undefined && !/^[a-f0-9]{64}$/.test(item.bundle_sha256)) {
      throw new Error("Each import requires target_arm, run_dir, arm, and an optional bundle_sha256");
    }
    const target = item.target_arm.trim();
    if (targets.has(target)) throw new Error(`Duplicate import target: ${target}`);
    targets.add(target);
    return { target_arm: target, run_dir: resolve(item.run_dir.trim()), arm: item.arm.trim(), bundle_sha256: item.bundle_sha256 };
  });
}

/** Shared experiment controls, excluding the independently selected setup/launcher. */
function comparisonIdentity(state: RunState) {
  return { profile: state.profile, base: state.source.base_commit, tree: state.source.base_tree,
    forbidden: state.source.forbidden_commit, task: state.task.sha256, criteria: state.criteria?.sha256,
    model: state.execution.model, effort: state.execution.reasoning_effort, tier: state.execution.service_tier,
    image: state.image_id,
    codex: state.runtime_tools.codex_sha256, host: state.runtime_tools.codex_code_mode_host_sha256,
    resources: state.resource_limits, timeout: state.timeout_seconds, compact: state.auto_compact_limit };
}

function compatibleDependencyImages(source: RunState, target: RunState): boolean {
  const a = source.dependency_image, b = target.dependency_image;
  if (a?.image_id === b?.image_id) return true;
  if (!a || !b || a.key === b.key || a.base_image !== b.base_image) return false;
  // The runtime image embeds launcher binaries. Permit a different image only
  // when both recorded recipes are known and their only changed inputs are those binaries.
  if (a.key !== dependencyKey(source, a.base_image) || b.key !== dependencyKey(target, b.base_image)) return false;
  const taskKey = (state: RunState, base: string) => dependencyKey({ ...state,
    runtime_tools: { ...state.runtime_tools, mekugi_in_image: false } }, base);
  return taskKey(source, a.base_image) === taskKey(target, b.base_image);
}

function artifactPath(root: string, path: string): string {
  if (!path || path.startsWith("/") || path.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Imported artifact path must be run-relative");
  return join(root, path);
}

/** Validate every selection before copying evidence or launching any new candidate. */
export async function importArms(runDir: string, state: RunState, selections: ArmImport[]): Promise<Partial<Record<string, ArmResult>>> {
  const imports = parseArmImports(selections);
  const keys = armNames(state);
  if (imports.some(item => !keys.includes(item.target_arm))) throw new Error("Unknown import target arm");
  if (imports.length >= keys.length) throw new Error("Imports must leave at least one fresh arm");
  const plans = [];
  const publications = new Map<string, { bundle: string; hash: string; source: RunState;
    published: { validity?: string }; rollouts: Record<string, RolloutFile[]> }>();
  for (const item of imports) {
    const sourceRun = resolve(item.run_dir);
    if (sourceRun === resolve(runDir)) throw new Error("Import source and target run must differ");
    let publication = publications.get(sourceRun);
    if (!publication) {
      const bundle = join(sourceRun, "reports/bundle");
      const hash = item.bundle_sha256 ?? await sha256(join(bundle, "MANIFEST.sha256"));
      await verifyBundleManifest(bundle, hash);
      if (await sha256(join(sourceRun, "run.json")) !== await sha256(join(bundle, "run.json"))) throw new Error("Import source state differs from its published bundle");
      const source = await readState(sourceRun);
      const published = JSON.parse(await readFile(join(bundle, "report.json"), "utf8")) as { validity?: string };
      const rollouts = JSON.parse(await readFile(join(bundle, "rollout-files.json"), "utf8")) as Record<string, RolloutFile[]>;
      publication = { bundle, hash, source, published, rollouts };
      publications.set(sourceRun, publication);
    }
    const { bundle, hash, source, published, rollouts } = publication;
    if (item.bundle_sha256 && item.bundle_sha256 !== hash) throw new Error("Conflicting source bundle SHA-256");
    const result = source.results?.[item.arm];
    if (source.status !== "complete" || source.finishing?.status !== "complete" || source.invalidity_reasons?.length
      || !source.selected_arms?.includes(item.arm) || !armExecutionSucceeded(result) || published.validity !== "valid") {
      throw new Error("Import requires a completed, infrastructure-valid published arm");
    }
    const expectedControls = comparisonIdentity(source), actual = comparisonIdentity(state);
    const differences = (Object.keys(expectedControls) as Array<keyof typeof expectedControls>).filter(key => JSON.stringify(expectedControls[key]) !== JSON.stringify(actual[key]));
    const mismatches: string[] = differences;
    if (!compatibleDependencyImages(source, state)) mismatches.push("dependency image");
    if (mismatches.length) throw new Error(`Imported arm does not match controls: ${mismatches.join(", ")}`);
    if (state.evaluation?.mode === "reuse") historicalEvaluation(source, item.arm);
    // Flatten an already-imported arm to its retained original measurement evidence.
    const prior = source.imported_arms?.[item.arm];
    const evidenceRoot = prior ? artifactPath(sourceRun, prior.directory) : sourceRun;
    const evidenceState = prior ? await readState(evidenceRoot) : source;
    const evidenceArm = prior?.evidence_arm ?? item.arm;
    const original = evidenceState.results![evidenceArm]!;
    const home = evidenceState.arm_attempts?.[evidenceArm]?.codex_home ?? join(dirname(evidenceState.arms[evidenceArm].repository), "home/ubuntu/.codex");
    const expected = rollouts[item.arm] ?? [];
    // Missing usage stays unknown; available rollout bytes must still match publication.
    if (expected.length) await verifyRollouts(artifactPath(evidenceRoot, join(home, "sessions")), expected);
    plans.push({ item, sourceRun, source, bundle, hash, result: result!, evidenceRoot, evidenceState, evidenceArm, original, home, expected });
  }
  const results: Partial<Record<string, ArmResult>> = {};
  for (const plan of plans) {
    const { item, sourceRun, source, bundle, hash, evidenceRoot, evidenceState, evidenceArm, original, home, expected } = plan;
    const directory = `evaluator/imported-arms/${item.target_arm}`;
    const root = join(runDir, directory);
    const captured: Array<{ path: string; sha256: string }> = [];
    const copy = async (from: string, path: string) => {
      if (!(await lstat(from)).isFile()) throw new Error("Imported artifact must be a regular file");
      const to = artifactPath(root, path);
      await mkdir(dirname(to), { recursive: true, mode: 0o700 });
      await copyFile(from, to);
      captured.push({ path: join(directory, path), sha256: await sha256(to) });
    };
    await copy(join(bundle, "MANIFEST.sha256"), "MANIFEST.sha256");
    await copy(join(bundle, "report.json"), "report.json");
    await copy(join(sourceRun, "run.json"), "source-run.json");
    await copy(join(evidenceRoot, "run.json"), "run.json");
    await copy(artifactPath(evidenceRoot, original.stdout_path), original.stdout_path);
    await copy(artifactPath(evidenceRoot, original.stderr_path), original.stderr_path);
    const paths = new Set<string>();
    const exports = evidenceState.mekugi_exports_by_arm?.[evidenceArm] ?? evidenceState.mekugi_exports;
    if (exports) for (const path of [exports.capture, exports.metrics, exports.validator.path, exports.reader.path]) paths.add(path);
    const setup = evidenceState.setup_revisions?.[evidenceArm]?.manifest ?? evidenceState.snapshot_manifest;
    paths.add(setup);
    paths.add(join(evidenceState.arms[evidenceArm].home_template, ".codex/AGENTS.md"));
    paths.add(join(evidenceState.arms[evidenceArm].home_template, ".codex/config.toml"));
    if (exports) paths.add(join(dirname(exports.metrics), "token-metrics.md"));
    for (const path of paths) {
      try { await copy(artifactPath(evidenceRoot, path), path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    for (const file of expected) await copy(artifactPath(evidenceRoot, join(home, "sessions", file.path)), join(home, "sessions", file.path));
    const grokHome = evidenceState.arm_attempts?.[evidenceArm]?.grok_home;
    if (grokHome) {
      // Grok accounting reads its session store, never the authentication file.
      const sessions = artifactPath(evidenceRoot, join(grokHome, "sessions"));
      for (const file of await files(sessions)) await copy(file, join(grokHome, "sessions", relative(sessions, file)));
    }
    const patchPath = `artifacts/${item.target_arm}/changes.patch`;
    await mkdir(dirname(join(runDir, patchPath)), { recursive: true });
    await copyFile(join(bundle, `${item.arm}-changes.patch`), join(runDir, patchPath));
    captured.push({ path: patchPath, sha256: await sha256(join(runDir, patchPath)) });
    state.imported_arms ??= {};
    state.imported_arms[item.target_arm] = { source_run_id: source.id, source_arm: item.arm, bundle_sha256: hash,
      label: armLabels(source)[item.arm], directory, evidence_arm: evidenceArm, files: captured };
    const result: ArmResult = { ...plan.result, arm: item.target_arm, anonymous_id: `candidate-${armNames(state).indexOf(item.target_arm) + 1}`,
      grade: state.evaluation?.mode === "reuse" ? structuredClone(plan.result!.grade) : undefined,
      patch_path: patchPath, stdout_path: join(directory, original.stdout_path), stderr_path: join(directory, original.stderr_path) };
    results[item.target_arm] = result;
    state.arm_attempts ??= {};
    state.arm_attempts[item.target_arm] = { codex_home: join(directory, home), grok_home: grokHome ? join(directory, grokHome) : undefined,
      container: result.container, started_at: result.started_at, finished_at: result.finished_at, status: "stopped" };
    process.stderr.write(`[run] imported ${armLabels(source)[item.arm]} from ${source.id} into ${item.target_arm}; candidate execution skipped\n`);
  }
  return results;
}

/** Inputs that must match before a published stock result can be reused. */
export function controlIdentity(state: RunState): unknown {
  return {
    profile: state.profile, source: { base_commit: state.source.base_commit, base_tree: state.source.base_tree,
      forbidden_commit: state.source.forbidden_commit },
    task_sha256: state.task.sha256, task_pack_sha256: state.task_pack?.sha256 ?? null,
    upstream_reference: state.upstream_reference,
    criteria_sha256: state.criteria?.sha256 ?? null, comparison: state.comparison ?? "stock-current",
    execution: state.execution, image_id: state.image_id, dependency_image_id: state.dependency_image?.image_id ?? null,
    codex_sha256: state.runtime_tools.codex_sha256,
    codex_code_mode_host_sha256: state.runtime_tools.codex_code_mode_host_sha256,
    resource_limits: state.resource_limits, timeout_seconds: state.timeout_seconds,
    stock_home_template: state.arms.stock.home_template,
    stock_setup_sha256: state.arms.stock.home_template === "snapshots/current/home/ubuntu"
      ? state.current_snapshot.manifest_sha256 : null,
    mekugi_flags: state.mekugi_flags ?? [], protected_runtime: state.protected_runtime ?? null,
  };
}

interface RolloutFile { path: string; sha256: string }
async function files(directory: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await files(path));
    else if (entry.isFile()) output.push(path);
    else throw new Error("control rollout contains a non-regular file");
  }
  return output.sort();
}
async function verifyRollouts(directory: string, expected: RolloutFile[]): Promise<void> {
  if (!Array.isArray(expected) || expected.length === 0) throw new Error("control bundle has no rollout identity");
  const actual = await files(directory);
  if (actual.length !== expected.length) throw new Error("control rollout file list changed");
  for (const [index, file] of expected.entries()) {
    if (typeof file.path !== "string" || !file.path || file.path.startsWith("/") || file.path.split("/").some(part => !part || part === "." || part === "..")
      || relative(directory, actual[index]!) !== file.path || await sha256(actual[index]!) !== file.sha256) {
      throw new Error("control rollout bytes differ from the published bundle");
    }
  }
}

export async function importControl(runDir: string, state: RunState, sourceDirectory: string, expectedBundleSha256: string): Promise<ArmResult> {
  if (state.comparison === "custom" || state.comparison === "setup-commits" || isPairedMekugiComparison(state.comparison) || state.comparison === "codex-mekugi-grok") {
    throw new Error("control reuse currently supports direct-Codex stock controls only");
  }
  if (!/^[0-9a-f]{64}$/.test(expectedBundleSha256)) throw new Error("control bundle SHA-256 must be 64 lowercase hex characters");
  const sourceRun = resolve(sourceDirectory);
  if (sourceRun === resolve(runDir)) throw new Error("control source and treatment run must differ");
  const bundle = join(sourceRun, "reports/bundle");
  await verifyBundleManifest(bundle, expectedBundleSha256);
  if (await sha256(join(sourceRun, "run.json")) !== await sha256(join(bundle, "run.json"))) throw new Error("control state differs from the published bundle");
  const source = await readState(sourceRun);
  if (source.status !== "complete" || source.finishing?.status !== "complete" || source.invalidity_reasons?.length
    || !source.selected_arms?.includes("stock") || source.imported_control
    || !source.results?.stock || source.results.stock.exit_code !== 0 || source.results.stock.collection_error
    || source.results.stock.lifecycle_error || source.results.stock.grade?.preparation.exit_code !== 0) {
    throw new Error("published control is not a complete, valid original stock attempt");
  }
  if (digest(controlIdentity(source)) !== digest(controlIdentity(state))) throw new Error("published control does not match task, setup, model, tool, or resource controls");
  const provenance = join(runDir, "evaluator/imported-control");
  await mkdir(provenance, { recursive: true, mode: 0o700 });
  await copyFile(join(bundle, "MANIFEST.sha256"), join(provenance, "MANIFEST.sha256"));
  await copyFile(join(bundle, "report.json"), join(provenance, "report.json"));
  const published = JSON.parse(await readFile(join(bundle, "report.json"), "utf8")) as { validity?: string; arms?: { stock?: { usage?: { complete?: boolean; totals?: Record<string, number> } } } };
  if (published.validity !== "valid" || published.arms?.stock?.usage?.complete !== true) throw new Error("published control has incomplete usage or invalid infrastructure");
  const rolloutManifest = JSON.parse(await readFile(join(bundle, "rollout-files.json"), "utf8")) as { stock?: RolloutFile[] };
  const originalSessions = join(sourceRun, source.arm_attempts?.stock?.codex_home ?? join(dirname(source.arms.stock.repository), "home/ubuntu/.codex"), "sessions");
  await verifyRollouts(originalSessions, rolloutManifest.stock ?? []);
  const output = join(runDir, "artifacts/stock");
  await mkdir(output, { recursive: true, mode: 0o700 });
  const patch = join(output, "changes.patch");
  await copyFile(join(bundle, "stock-changes.patch"), patch);
  const stdout = join(output, "codex.jsonl");
  const stderr = join(output, "codex.stderr");
  if (source.results.stock.stdout_path !== "artifacts/stock/codex.jsonl" || source.results.stock.stderr_path !== "artifacts/stock/codex.stderr"
    || source.results.stock.patch_path !== "artifacts/stock/changes.patch") throw new Error("control artifact paths changed");
  await copyFile(join(sourceRun, source.results.stock.stdout_path), stdout);
  await copyFile(join(sourceRun, source.results.stock.stderr_path), stderr);
  const home = join(runDir, dirname(state.arms.stock.repository), "home/ubuntu/.codex");
  await mkdir(home, { recursive: true, mode: 0o700 });
  const sessions = join(home, "sessions");
  await cp(originalSessions, sessions, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
  await verifyRollouts(sessions, rolloutManifest.stock ?? []);
  const metered = await meterRollouts(home, source.pricing as PricingSnapshot);
  if (!metered.complete || USAGE_KEYS.some(key => metered.totals[key] !== published.arms?.stock?.usage?.totals?.[key])) {
    throw new Error("copied control usage differs from its published measurement");
  }
  state.pricing = source.pricing;
  state.imported_control = { source_run_id: source.id, bundle_sha256: expectedBundleSha256,
    controls_sha256: digest(controlIdentity(source)), stdout_sha256: await sha256(stdout), stderr_sha256: await sha256(stderr) };
  const original = source.results.stock;
  return { ...original, grade: undefined, patch_path: "artifacts/stock/changes.patch",
    stdout_path: "artifacts/stock/codex.jsonl", stderr_path: "artifacts/stock/codex.stderr" };
}
