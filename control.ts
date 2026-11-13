import { armRuntime } from "./arm-settings";
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { verifyBundleManifest } from "./bundle";
import { armExecutionSucceeded, readState, sha256 } from "./state";
import { applyMekugiProviderUsage, meterGrokHome, meterRollouts, type MeteredRollouts, type PricingSnapshot, USAGE_KEYS } from "./usage";
import { armNames, type ArmImport, type ArmResult, type RunState } from "./types";
import { isPairedMekugiComparison, mekugiRuntimeCaptures } from "./mekugi";
import { armLabels } from "./arm-labels";
import { dependencyKey } from "./dependencies";
import { historicalEvaluation } from "./evaluation";
import { readRolloutManifest, verifyRolloutIdentity } from "./rollout-evidence";
import { readCandidateManifest } from "./candidate-evidence";

interface PublishedReport { validity?: string; arms?: Record<string, { usage?: Partial<MeteredRollouts> }> }

function usageIdentity(usage: Partial<MeteredRollouts>) {
  return { measurement_schema: usage.measurement_schema ?? null, complete: usage.complete,
    observation_validity: usage.observation_validity ?? null, request_coverage: usage.request_coverage ?? null,
    pricing_precision: usage.pricing_precision ?? null, totals: usage.totals };
}

function assertPublishedMeasurement(metered: MeteredRollouts, published: Partial<MeteredRollouts>): void {
  if (published.measurement_schema !== "codex-ab.usage.v2") throw new Error("imports require published codex-ab.usage.v2 accounting provenance");
  if (!published.totals || USAGE_KEYS.some(key => published.totals![key] !== metered.totals[key])) {
    throw new Error("imported usage differs from its published measurement");
  }
  if (published.complete !== metered.complete) throw new Error("imported usage coverage differs from its published measurement");
  if (["observation_validity", "request_coverage", "pricing_precision"].some(
    key => published[key as keyof MeteredRollouts] !== metered[key as keyof MeteredRollouts])) {
    throw new Error("imported usage coverage or precision differs from its published measurement");
  }
  if (Object.hasOwn(published.totals, "estimated_api_usd") && published.totals.estimated_api_usd !== metered.totals.estimated_api_usd) {
    throw new Error("imported cost differs under the original published pricing snapshot");
  }
}

async function importMeasurement(root: string, state: RunState, arm: string, pricing: PricingSnapshot,
  published: Partial<MeteredRollouts> | undefined, metricsPath?: string): Promise<MeteredRollouts> {
  const grok = state.arm_attempts?.[arm]?.grok_home;
  if (state.comparison === "codex-mekugi-grok" && arm === "current" && grok) return meterGrokHome(artifactPath(root, grok), pricing);
  const home = state.arm_attempts?.[arm]?.codex_home ?? join(dirname(state.arms[arm].repository), "home/ubuntu/.codex");
  const metered = await meterRollouts(artifactPath(root, home), pricing);
  if (published?.agents?.some(agent => agent.method === "mekugi_capture.provider_attempts")) {
    if (!metricsPath) throw new Error("published provider usage is missing its retained metrics");
    // Preserve the source's sealed capture-validation status while reproducing
    // its numeric measurement; do not promote older, unqualified publications.
    const error = applyMekugiProviderUsage(metered, JSON.parse(await readFile(metricsPath, "utf8")), pricing, published.request_coverage === "verified");
    if (error) throw new Error(`imported provider usage is unavailable: ${error}`);
  }
  return metered;
}

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

function requireAdaptiveImport(state: RunState, label: string): void {
  if (state.fixed_verifier || Object.values(state.results ?? {}).some(result => result?.grade?.fixed)) {
    throw new Error(`${label} uses fixed-verifier mode; historical fixed-verifier imports and evaluation reuse are not yet supported`);
  }
}

/** Validate every selection before copying evidence or launching any new candidate. */
export async function importArms(runDir: string, state: RunState, selections: ArmImport[], purpose: "execution" | "reevaluation" = "execution"): Promise<Partial<Record<string, ArmResult>>> {
  requireAdaptiveImport(state, "Import target");
  const imports = parseArmImports(selections);
  const keys = armNames(state);
  if (imports.some(item => !keys.includes(item.target_arm))) throw new Error("Unknown import target arm");
  if (purpose === "reevaluation") {
    if (state.evaluation?.mode !== "fresh" || imports.length !== keys.length
      || new Set(imports.map(item => item.run_dir)).size !== 1
      || imports.some(item => item.arm !== item.target_arm)) throw new Error("Reevaluation requires fresh evaluation of exactly all source arms");
  } else if (imports.length >= keys.length) throw new Error("Imports must leave at least one fresh arm");
  const plans = [];
  const publications = new Map<string, { bundle: string; hash: string; source: RunState;
    published: PublishedReport; rollouts: ReturnType<typeof readRolloutManifest> }>();
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
      requireAdaptiveImport(source, "Import source");
      const published = JSON.parse(await readFile(join(bundle, "report.json"), "utf8")) as PublishedReport;
      const rollouts = readRolloutManifest(JSON.parse(await readFile(join(bundle, "rollout-files.json"), "utf8")));
      publication = { bundle, hash, source, published, rollouts };
      publications.set(sourceRun, publication);
    }
    const { bundle, hash, source, published, rollouts } = publication;
    if (purpose === "reevaluation" && JSON.stringify(armNames(source)) !== JSON.stringify(keys)) throw new Error("Reevaluation must retain every configured source arm");
    if (item.bundle_sha256 && item.bundle_sha256 !== hash) throw new Error("Conflicting source bundle SHA-256");
    const result = source.results?.[item.arm];
    if (source.status !== "complete" || source.finishing?.status !== "complete" || source.invalidity_reasons?.length
      || !source.selected_arms?.includes(item.arm) || !armExecutionSucceeded(result) || published.validity !== "valid") {
      throw new Error("Import requires a completed, infrastructure-valid published arm");
    }
    if (result?.capture_identity?.status !== "verified") throw new Error("imports require trusted candidate capture provenance");
    {
      const manifest = await readCandidateManifest(join(bundle, `${item.arm}-candidate-manifest.json`), join(bundle, `${item.arm}-changes.patch`));
      if (manifest.captured_tree !== result.capture_identity.tree || manifest.patch_sha256 !== result.capture_identity.patch_sha256
        || manifest.base_commit !== source.source.base_commit || manifest.base_tree !== source.source.base_tree) {
        throw new Error("imported trusted candidate identity differs from its source publication");
      }
    }
    const expectedControls = comparisonIdentity(armRuntime(source, item.arm)), actual = comparisonIdentity(armRuntime(state, item.target_arm));
    const differences = (Object.keys(expectedControls) as Array<keyof typeof expectedControls>).filter(key => JSON.stringify(expectedControls[key]) !== JSON.stringify(actual[key]));
    const mismatches: string[] = differences;
    if (!compatibleDependencyImages(source, state)) mismatches.push("dependency image");
    if (mismatches.length) throw new Error(`Imported arm does not match controls: ${mismatches.join(", ")}`);
    if (state.evaluation?.mode === "reuse") historicalEvaluation(source, item.arm);
    // Flatten an already-imported arm to its retained original measurement evidence.
    const prior = source.imported_arms?.[item.arm];
    const evidenceRoot = prior ? artifactPath(sourceRun, prior.directory) : sourceRun;
    const evidenceState = prior ? await readState(artifactPath(bundle, prior.directory)) : source;
    requireAdaptiveImport(evidenceState, "Retained import source");
    const evidenceArm = prior?.evidence_arm ?? item.arm;
    const original = evidenceState.results![evidenceArm]!;
    const recoveryCopies = await Promise.all((original.recovery?.files ?? []).map(async file => {
      const from = artifactPath(bundle, prior ? join(prior.directory, file.path) : file.path);
      if (!(await lstat(from)).isFile() || await sha256(from) !== file.sha256) throw new Error("Imported recovery evidence differs from its recorded hash");
      return { from, ...file };
    }));
    const home = evidenceState.arm_attempts?.[evidenceArm]?.codex_home ?? join(dirname(evidenceState.arms[evidenceArm].repository), "home/ubuntu/.codex");
    const expected = rollouts.arms[item.arm] ?? [];
    await verifyRolloutIdentity(artifactPath(evidenceRoot, home), expected);
    const exports = evidenceState.mekugi_exports_by_arm?.[evidenceArm] ?? evidenceState.mekugi_exports;
    const exportCopies: Array<{ from: string; path: string }> = [];
    if (exports) {
      const prefix = source.mekugi_exports_by_arm?.[item.arm] ? `${item.arm}-` : "";
      const published = (path: string, name: string) => prior ? join(prior.directory, path) : name;
      const capture = published(exports.capture, `${prefix}mekugi-capture.jsonl`);
      const retained = [
        [capture, exports.capture],
        [published(exports.metrics, `${prefix}mekugi-metrics.json`), exports.metrics],
        [published(exports.validator.path, "analyze_capture.py"), exports.validator.path],
        [published(exports.reader.path, "benchmark_jsonl.py"), exports.reader.path],
        [published(join(dirname(exports.metrics), "token-metrics.md"), `${prefix}mekugi-token-metrics.md`), join(dirname(exports.metrics), "token-metrics.md")],
        ...(await mekugiRuntimeCaptures(bundle, capture)).map(path => [path, exports.capture + path.slice(capture.length)]),
      ];
      for (const [retainedPath, path] of retained) {
        const from = artifactPath(bundle, retainedPath!);
        try {
          if (!(await lstat(from)).isFile()) throw new Error("Imported export must be a regular file");
          exportCopies.push({ from, path: path! });
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    }
    const originalUsage = published.arms?.[item.arm]?.usage;
    if (originalUsage?.measurement_schema !== "codex-ab.usage.v2") throw new Error("imports require published codex-ab.usage.v2 accounting provenance");
    const metered = await importMeasurement(evidenceRoot, evidenceState, evidenceArm, source.pricing as PricingSnapshot,
      originalUsage, exportCopies.find(file => file.path === exports?.metrics)?.from);
    assertPublishedMeasurement(metered, originalUsage);
    const accounting = { schema: "codex-ab.import-accounting.v1",
      status: "verified",
      reason: "Retained evidence reproduces the source measurement, including coverage and price precision.",
      source_run_id: source.id, source_arm: item.arm,
      source_usage: usageIdentity(originalUsage),
      remetered_original: usageIdentity(metered), original_pricing: source.pricing,
      original_pricing_sha256: digest(source.pricing), target_pricing_sha256: state.pricing ? digest(state.pricing) : null,
      repriced: state.pricing ? digest(source.pricing) !== digest(state.pricing) : null };
    plans.push({ item, sourceRun, source, bundle, hash, result: result!, evidenceRoot, evidenceState, evidenceArm, original, home, expected, exportCopies, recoveryCopies, accounting, originalUsage });
  }
  const results: Partial<Record<string, ArmResult>> = {};
  for (const plan of plans) {
    const { item, sourceRun, source, bundle, hash, evidenceRoot, evidenceState, evidenceArm, original, home, expected, exportCopies, recoveryCopies } = plan;
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
    const prior = source.imported_arms?.[item.arm];
    // Flatten execution bytes without flattening away the publications that
    // priced/interpreted them at each historical import.
    await copy(join(bundle, "report.json"), `source-publications/${hash}/report.json`);
    await copy(join(bundle, "run.json"), `source-publications/${hash}/run.json`);
    if (prior) {
      const priorPublications = artifactPath(bundle, join(prior.directory, "source-publications"));
      for (const file of await files(priorPublications)) await copy(file, join("source-publications", relative(priorPublications, file)));
    }
    await copy(join(prior ? artifactPath(bundle, prior.directory) : evidenceRoot, "run.json"), "run.json");
    if (purpose === "reevaluation" && state.protected_runtime && item.target_arm === keys[0]) {
      // Isolation was checked during original implementation execution. Retain
      // the sealed evidence once, with the existing imported-file provenance.
      const path = "artifacts/preflight-isolation.json";
      await mkdir(dirname(join(runDir, path)), { recursive: true });
      await copyFile(join(bundle, "isolation/preflight.json"), join(runDir, path));
      captured.push({ path, sha256: await sha256(join(runDir, path)) });
    }
    await copy(artifactPath(evidenceRoot, original.stdout_path), original.stdout_path);
    await copy(artifactPath(evidenceRoot, original.stderr_path), original.stderr_path);
    // Sanitized runtime evidence comes from the sealed publication, not mutable run exports.
    for (const file of exportCopies) await copy(file.from, file.path);
    for (const file of recoveryCopies) await copy(file.from, file.path);
    const paths = new Set<string>();
    const setup = evidenceState.setup_revisions?.[evidenceArm]?.manifest ?? evidenceState.snapshot_manifest;
    paths.add(setup);
    paths.add(join(evidenceState.arms[evidenceArm].home_template, ".codex/AGENTS.md"));
    paths.add(join(evidenceState.arms[evidenceArm].home_template, ".codex/config.toml"));
    for (const path of paths) {
      try { await copy(artifactPath(evidenceRoot, path), path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    for (const file of expected) await copy(artifactPath(evidenceRoot, join(home, file.path)), join(home, file.path));
    await verifyRolloutIdentity(join(root, home), expected);
    const grokHome = evidenceState.arm_attempts?.[evidenceArm]?.grok_home;
    if (grokHome) {
      // Grok accounting reads its session store, never the authentication file.
      const sessions = artifactPath(evidenceRoot, join(grokHome, "sessions"));
      for (const file of await files(sessions)) await copy(file, join(grokHome, "sessions", relative(sessions, file)));
    }
    const copiedUsage = await importMeasurement(root, evidenceState, evidenceArm, source.pricing as PricingSnapshot,
      plan.originalUsage, exportCopies.find(file => file.path === (evidenceState.mekugi_exports_by_arm?.[evidenceArm] ?? evidenceState.mekugi_exports)?.metrics)
        ? join(root, (evidenceState.mekugi_exports_by_arm?.[evidenceArm] ?? evidenceState.mekugi_exports)!.metrics) : undefined);
    assertPublishedMeasurement(copiedUsage, plan.originalUsage);
    const accountingPath = join(directory, "accounting-verification.json");
    await writeFile(join(runDir, accountingPath), `${JSON.stringify(plan.accounting, null, 2)}\n`, { mode: 0o600 });
    captured.push({ path: accountingPath, sha256: await sha256(join(runDir, accountingPath)) });
    const patchPath = `artifacts/${item.target_arm}/changes.patch`;
    await mkdir(dirname(join(runDir, patchPath)), { recursive: true });
    await copyFile(join(bundle, `${item.arm}-changes.patch`), join(runDir, patchPath));
    captured.push({ path: patchPath, sha256: await sha256(join(runDir, patchPath)) });
    const captureManifest = `artifacts/${item.target_arm}/candidate-manifest.json`;
    {
      await copyFile(join(bundle, `${item.arm}-candidate-manifest.json`), join(runDir, captureManifest));
      captured.push({ path: captureManifest, sha256: await sha256(join(runDir, captureManifest)) });
    }
    state.imported_arms ??= {};
    state.imported_arms[item.target_arm] = { source_run_id: source.id, source_arm: item.arm, bundle_sha256: hash,
      label: armLabels(source)[item.arm], directory, evidence_arm: evidenceArm, files: captured };
    const result: ArmResult = { ...plan.result, arm: item.target_arm, anonymous_id: `candidate-${armNames(state).indexOf(item.target_arm) + 1}`,
      capture_identity: { ...plan.result.capture_identity!, manifest_path: captureManifest },
      recovery: original.recovery ? { ...original.recovery, files: original.recovery.files.map(file => ({ ...file, path: join(directory, file.path) })) } : undefined,
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
    ...(state.arm_settings?.stock ? { stock_settings: state.arm_settings.stock } : {}),
    stock_home_template: state.arms.stock.home_template,
    stock_setup_sha256: state.arms.stock.home_template === "snapshots/current/home/ubuntu"
      ? state.current_snapshot.manifest_sha256 : null,
    mekugi_flags: state.mekugi_flags ?? [], protected_runtime: state.protected_runtime ?? null,
  };
}

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

export async function importControl(runDir: string, state: RunState, sourceDirectory: string, expectedBundleSha256: string): Promise<ArmResult> {
  requireAdaptiveImport(state, "Control import target");
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
  requireAdaptiveImport(source, "Control import source");
  if (source.status !== "complete" || source.finishing?.status !== "complete" || source.invalidity_reasons?.length
    || !source.selected_arms?.includes("stock") || source.imported_control
    || !source.results?.stock || source.results.stock.exit_code !== 0 || source.results.stock.collection_error
    || source.results.stock.lifecycle_error || source.results.stock.grade?.preparation.exit_code !== 0) {
    throw new Error("published control is not a complete, valid original stock attempt");
  }
  if (digest(controlIdentity(source)) !== digest(controlIdentity(state))) throw new Error("published control does not match task, setup, model, tool, or resource controls");
  if (source.results.stock.capture_identity?.status !== "verified") throw new Error("imports require trusted candidate capture provenance");
  {
    const manifest = await readCandidateManifest(join(bundle, "stock-candidate-manifest.json"), join(bundle, "stock-changes.patch"));
    if (manifest.captured_tree !== source.results.stock.capture_identity.tree || manifest.patch_sha256 !== source.results.stock.capture_identity.patch_sha256
      || manifest.base_commit !== source.source.base_commit || manifest.base_tree !== source.source.base_tree) {
      throw new Error("imported trusted candidate identity differs from its source publication");
    }
  }
  const recoveryFiles = await Promise.all((source.results.stock.recovery?.files ?? []).map(async file => {
    const from = artifactPath(bundle, file.path);
    if (!(await lstat(from)).isFile() || await sha256(from) !== file.sha256) throw new Error("Imported recovery evidence differs from its recorded hash");
    return { from, path: join("evaluator/imported-control", file.path), sha256: file.sha256 };
  }));
  const published = JSON.parse(await readFile(join(bundle, "report.json"), "utf8")) as PublishedReport;
  if (published.validity !== "valid" || published.arms?.stock?.usage?.complete !== true) throw new Error("published control has incomplete usage or invalid infrastructure");
  if (published.arms.stock.usage.measurement_schema !== "codex-ab.usage.v2") throw new Error("imports require published codex-ab.usage.v2 accounting provenance");
  const rolloutManifest = readRolloutManifest(JSON.parse(await readFile(join(bundle, "rollout-files.json"), "utf8")));
  const originalHome = join(sourceRun, source.arm_attempts?.stock?.codex_home ?? join(dirname(source.arms.stock.repository), "home/ubuntu/.codex"));
  await verifyRolloutIdentity(originalHome, rolloutManifest.arms.stock ?? []);
  assertPublishedMeasurement(await meterRollouts(originalHome, source.pricing as PricingSnapshot), published.arms.stock.usage);
  if (source.results.stock.stdout_path !== "artifacts/stock/codex.jsonl" || source.results.stock.stderr_path !== "artifacts/stock/codex.stderr"
    || source.results.stock.patch_path !== "artifacts/stock/changes.patch") throw new Error("control artifact paths changed");
  const provenance = join(runDir, "evaluator/imported-control");
  await mkdir(provenance, { recursive: true, mode: 0o700 });
  await copyFile(join(bundle, "MANIFEST.sha256"), join(provenance, "MANIFEST.sha256"));
  await copyFile(join(bundle, "report.json"), join(provenance, "report.json"));
  const output = join(runDir, "artifacts/stock");
  await mkdir(output, { recursive: true, mode: 0o700 });
  const patch = join(output, "changes.patch");
  await copyFile(join(bundle, "stock-changes.patch"), patch);
  await copyFile(join(bundle, "stock-candidate-manifest.json"), join(output, "candidate-manifest.json"));
  const stdout = join(output, "codex.jsonl");
  const stderr = join(output, "codex.stderr");
  await copyFile(join(sourceRun, source.results.stock.stdout_path), stdout);
  await copyFile(join(sourceRun, source.results.stock.stderr_path), stderr);
  const home = join(runDir, dirname(state.arms.stock.repository), "home/ubuntu/.codex");
  await mkdir(home, { recursive: true, mode: 0o700 });
  for (const file of rolloutManifest.arms.stock ?? []) {
    await mkdir(dirname(join(home, file.path)), { recursive: true, mode: 0o700 });
    await copyFile(join(originalHome, file.path), join(home, file.path));
  }
  await verifyRolloutIdentity(home, rolloutManifest.arms.stock ?? []);
  const metered = await meterRollouts(home, source.pricing as PricingSnapshot);
  assertPublishedMeasurement(metered, published.arms!.stock!.usage!);
  for (const file of recoveryFiles) {
    const to = artifactPath(runDir, file.path);
    await mkdir(dirname(to), { recursive: true, mode: 0o700 });
    await copyFile(file.from, to);
  }
  state.pricing = source.pricing;
  state.imported_control = { source_run_id: source.id, bundle_sha256: expectedBundleSha256,
    controls_sha256: digest(controlIdentity(source)), stdout_sha256: await sha256(stdout), stderr_sha256: await sha256(stderr) };
  const original = source.results.stock;
  return { ...original, grade: undefined, patch_path: "artifacts/stock/changes.patch",
    capture_identity: { ...original.capture_identity!, manifest_path: "artifacts/stock/candidate-manifest.json" },
    recovery: original.recovery ? { ...original.recovery, files: recoveryFiles.map(({ path, sha256 }) => ({ path, sha256 })) } : undefined,
    stdout_path: "artifacts/stock/codex.jsonl", stderr_path: "artifacts/stock/codex.stderr" };
}
