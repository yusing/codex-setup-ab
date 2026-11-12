import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { controlIdentity, importArms, importControl } from "./control";
import { collectBundle, writeBundleManifest } from "./bundle";
import { runPair } from "./runner";
import type { CriteriaContract } from "./semantic";
import { meterRollouts, type PricingSnapshot } from "./usage";
import type { ArmResult, RunState } from "./types";
import { sha256, writeState } from "./state";
import { dependencyKey } from "./dependencies";
import { ROLLOUT_SCHEMA, rolloutIdentity } from "./rollout-evidence";
import { createFixedFixture } from "./test-support/fixed-verifier";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

const pricing: PricingSnapshot = {
  fetched_at: "2026-01-01T00:00:00.000Z",
  source: "fallback",
  catalog_url: "fixture",
  assumptions: [],
  warnings: [],
  models: {
    "gpt-6-astra": {
      model_id: "gpt-6-astra", source: "fixture", prompt: 0, completion: 0,
      input_cache_read: 0, input_cache_write: 0, overrides: [],
    },
  },
};

const rollout = [
  { type: "session_meta", payload: { id: "control-thread" } },
  { type: "turn_context", payload: { model: "gpt-6-astra" } },
  { type: "token_usage_record", payload: { response_id: "response-1", usage: {
    input_tokens: 10, cached_input_tokens: 2, cache_write_input_tokens: 1,
    output_tokens: 3, reasoning_output_tokens: 1, total_tokens: 13,
  } } },
].map(event => JSON.stringify(event)).join("\n") + "\n";

function state(id: string): RunState {
  const command = {
    command: "true", started_at: "2026-01-01T00:00:00.000Z", elapsed_ms: 1,
    exit_code: 0, stdout: "", stderr: "",
  };
  const stock: ArmResult = {
    arm: "stock", anonymous_id: "candidate-1", container: `codex-ab-${id}-stock`,
    started_at: "2026-01-01T00:00:00.000Z", finished_at: "2026-01-01T00:00:01.000Z",
    agent_elapsed_ms: 1, exit_code: 0, timed_out: false, canceled: false,
    patch_path: "artifacts/stock/changes.patch", stdout_path: "artifacts/stock/codex.jsonl",
    stderr_path: "artifacts/stock/codex.stderr", changed_files: [], head_after_agent: "base-commit",
    grade: { preparation: command, router_suite: command, elapsed_ms: 1, passed: true },
  };
  return {
    schema_version: 1,
    id,
    created_at: "2026-01-01T00:00:00.000Z",
    status: "complete",
    source: { path: "source", base_commit: "base-commit", base_tree: "base-tree", source_timestamp: 1, forbidden_commit: "future-commit" },
    task: { path: "control/task.md", sha256: "a".repeat(64) },
    image: "fixture-image",
    image_id: `sha256:${"b".repeat(64)}`,
    dependency_image: { key: "fixture", base_image: "fixture-image", image_id: `sha256:${"c".repeat(64)}` },
    comparison: "stock-current",
    execution: { model: "gpt-6-astra", reasoning_effort: "high", service_tier: "default" },
    resource_limits: { cpus: "2", memory: "4g" },
    timeout_seconds: 90,
    snapshot_manifest: "snapshot-manifest.json",
    current_snapshot: { captured_at: "2026-01-01T00:00:00.000Z", manifest_sha256: "d".repeat(64) },
    runtime_tools: {
      bun: "bun 1.4.2", bun_sha256: "e".repeat(64), codex_source: "codex", codex_version: "codex-cli fixture",
      codex_sha256: "f".repeat(64), codex_code_mode_host_source: "host", codex_code_mode_host_sha256: "1".repeat(64),
      codex_code_mode_host_size: 1, current_setup_installs: "snapshots/current/installs",
      current_setup_files: "runtime/mise-files.json", current_setup_files_sha256: "2".repeat(64),
    },
    operator: { uid: 1000, gid: 1000 },
    selected_arms: ["stock"],
    arms: {
      stock: { repository: "arms/stock/repo", home_template: "snapshots/stock/home/ubuntu" },
      current: { repository: "arms/current/repo", home_template: "snapshots/current/home/ubuntu" },
    },
    pricing,
    results: { stock },
    arm_attempts: { stock: {
      codex_home: "arms/stock/home/ubuntu/.codex", container: stock.container,
      started_at: stock.started_at, finished_at: stock.finished_at, status: "stopped",
    } },
    finishing: { status: "complete", started_at: "2026-01-01T00:00:01.000Z", bundle_path: "reports/bundle" },
  };
}

async function publishedControl(paired = false) {
  const directory = await mkdtemp(join(tmpdir(), "codex-ab-control-test-"));
  directories.push(directory);
  const sourceRun = join(directory, "source-run");
  const targetRun = join(directory, "target-run");
  const bundle = join(sourceRun, "reports/bundle");
  const source = state("published-control");
  const captured = await createFixedFixture(); directories.push(captured.root);
  const candidateManifest = JSON.parse(await readFile(captured.candidateManifestPath, "utf8"));
  const capturedPatch = await readFile(captured.patchPath, "utf8");
  source.source.base_commit = candidateManifest.base_commit; source.source.base_tree = candidateManifest.base_tree;
  source.results!.stock!.head_after_agent = candidateManifest.base_commit;
  source.results!.stock!.capture_identity = { status: "verified", manifest_path: "artifacts/stock/candidate-manifest.json",
    tree: candidateManifest.captured_tree, patch_sha256: candidateManifest.patch_sha256 };
  if (paired) {
    source.arms.stock.repository = "sessions/source/repo";
    source.arm_attempts!.stock!.codex_home = "sessions/source/home/ubuntu/.codex";
  }
  const sessions = join(sourceRun, source.arm_attempts!.stock!.codex_home, "sessions");
  await mkdir(bundle, { recursive: true });
  await mkdir(sessions, { recursive: true });
  await mkdir(join(sourceRun, "artifacts/stock"), { recursive: true });
  await mkdir(targetRun, { recursive: true });

  if (paired) {
    source.selected_arms = ["stock", "current"];
    source.results!.current = { ...source.results!.stock!, arm: "current", anonymous_id: "candidate-2" };
  }
  const rolloutPath = join(sessions, "rollout.jsonl");
  await writeFile(rolloutPath, rollout);
  await writeFile(join(sourceRun, source.results!.stock!.patch_path), capturedPatch);
  await writeFile(join(sourceRun, source.results!.stock!.capture_identity!.manifest_path), JSON.stringify(candidateManifest));
  await writeFile(join(sourceRun, source.results!.stock!.stdout_path), "captured stdout\n");
  await writeFile(join(sourceRun, source.results!.stock!.stderr_path), "captured stderr\n");
  await writeState(sourceRun, source);
  await writeFile(join(bundle, "run.json"), await readFile(join(sourceRun, "run.json")));
  await writeFile(join(bundle, "stock-changes.patch"), capturedPatch);
  await writeFile(join(bundle, "stock-candidate-manifest.json"), JSON.stringify(candidateManifest));
  await writeFile(join(bundle, "rollout-files.json"), JSON.stringify({ schema: ROLLOUT_SCHEMA,
    arms: { stock: await rolloutIdentity(join(sourceRun, source.arm_attempts!.stock!.codex_home)) } }));
  const measured = await meterRollouts(join(sourceRun, source.arm_attempts!.stock!.codex_home), pricing);
  await writeFile(join(bundle, "report.json"), JSON.stringify({
    validity: "valid", arms: { stock: { usage: measured } },
  }));
  await writeBundleManifest(bundle);
  const bundleSha256 = await sha256(join(bundle, "MANIFEST.sha256"));
  const treatment = state("treatment-run");
  treatment.source = structuredClone(source.source);
  treatment.arms.stock.repository = "sessions/destination/repo";
  return { directory, sourceRun, targetRun, bundle, bundleSha256, rolloutPath, source, treatment, measured, capturedPatch };
}

async function publishFixture(runDir: string, source: RunState, usages: Record<string, unknown>) {
  for (const [path, value] of [[source.snapshot_manifest, "{}"], [source.runtime_tools.current_setup_files, "{}"],
    [source.task.path, "task"], ["reports/report.md", "original report retained unchanged"],
    ["reports/report.json", JSON.stringify({ validity: "valid", arms: Object.fromEntries(Object.entries(usages).map(([arm, usage]) => [arm, { usage }])) })]]) {
    await mkdir(dirname(join(runDir, path!)), { recursive: true });
    await writeFile(join(runDir, path!), value!);
  }
  source.current_snapshot.manifest_sha256 = await sha256(join(runDir, source.snapshot_manifest));
  source.runtime_tools.current_setup_files_sha256 = await sha256(join(runDir, source.runtime_tools.current_setup_files));
  source.task.sha256 = await sha256(join(runDir, source.task.path));
  await writeState(runDir, source);
  const bundle = await collectBundle(runDir);
  await writeBundleManifest(bundle);
  return bundle;
}

async function archivedControl(archivedOnly = false) {
  const f = await publishedControl();
  const home = join(f.sourceRun, f.source.arm_attempts!.stock!.codex_home);
  const events = (id: string, input: number) => [
    { type: "session_meta", payload: { id } },
    { type: "turn_context", payload: { model: "gpt-6-astra" } },
    { type: "token_usage_record", payload: { response_id: id, usage: { input_tokens: input, cached_input_tokens: 0,
      cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: input } } },
  ].map(event => JSON.stringify(event)).join("\n") + "\n";
  if (archivedOnly) await rm(join(home, "sessions"), { recursive: true });
  else await writeFile(f.rolloutPath, events("active", 100));
  await mkdir(join(home, "archived_sessions"));
  await writeFile(join(home, "archived_sessions/archived.jsonl"), events("archive", 200));
  f.source.pricing = structuredClone(pricing);
  (f.source.pricing as PricingSnapshot).models["gpt-6-astra"]!.prompt = 0.001;
  f.treatment.pricing = structuredClone(f.source.pricing);
  const measured = await meterRollouts(home, f.source.pricing as PricingSnapshot);
  await publishFixture(f.sourceRun, f.source, { stock: measured });
  f.treatment.task.sha256 = f.source.task.sha256;
  return { ...f, home, measured };
}

test("control identity includes task, execution, tool, setup, and resource controls", () => {
  const original = state("identity");
  expect(controlIdentity(original)).toEqual(controlIdentity({ ...original }));

  for (const changed of [
    { ...original, task: { ...original.task, sha256: "9".repeat(64) } },
    { ...original, execution: { ...original.execution, model: "gpt-6.1-sol" as const } },
    { ...original, runtime_tools: { ...original.runtime_tools, codex_sha256: "8".repeat(64) } },
    { ...original, resource_limits: { ...original.resource_limits, memory: "8g" } },
    { ...original, arms: { ...original.arms, stock: { ...original.arms.stock, home_template: "snapshots/other/home" } } },
  ]) {
    expect(controlIdentity(changed)).not.toEqual(controlIdentity(original));
  }
});

test("runner accepts either single-arm selection and honors cancellation before Docker preflight", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-ab-stock-run-test-"));
  directories.push(directory);
  const runDir = join(directory, "prepared-run");
  await mkdir(runDir, { recursive: true });
  const prepared = state("stock-only-run");
  prepared.status = "prepared";
  delete prepared.finishing;
  delete prepared.results;
  delete prepared.arm_attempts;
  delete prepared.selected_arms;
  prepared.criteria = {
    path: "evaluator/criteria.json",
    sha256: "7".repeat(64),
    contract: {
      schema: "codex-ab.criteria.v1", task_sha256: prepared.task.sha256,
      criteria: [{ id: "fixture", description: "Make the fixture better." }],
      preparation: "true", existing_tests: "true", qualification: "not-run",
    } satisfies CriteriaContract,
  };
  await writeState(runDir, prepared);

  const options = { runDir, authFile: "/unused-auth", dockerBin: "/must-not-launch", signal: AbortSignal.abort() };
  await expect(runPair({ ...options, arm: "stock" })).rejects.toThrow("preflight canceled; no model was launched");
  await expect(runPair({ ...options, arm: "current" })).rejects.toThrow("preflight canceled; no model was launched");
});

test.each([false, true])("importControl carries a verified stock result into a matching treatment (paired source: %s)", async paired => {
  const fixture = await publishedControl(paired);
  const path = "recovery-timing.json";
  await writeFile(join(fixture.bundle, path), JSON.stringify({ ExitCode: 0 }));
  fixture.source.results!.stock!.recovery = { source_run_id: "canceled-controller", source_arm: "stock", collected_at: "2026-10-30T08:00:00.000Z",
    container_id: "completed-container", timing_source: "docker-inspect", controller_elapsed_available: false,
    caveats: ["The original controller was canceled by the user."], files: [{ path, sha256: await sha256(join(fixture.bundle, path)) }] };
  await writeState(fixture.sourceRun, fixture.source);
  await writeFile(join(fixture.bundle, "run.json"), await readFile(join(fixture.sourceRun, "run.json")));
  await writeBundleManifest(fixture.bundle);
  fixture.bundleSha256 = await sha256(join(fixture.bundle, "MANIFEST.sha256"));
  expect(controlIdentity(fixture.source)).toEqual(controlIdentity(fixture.treatment));

  const imported = await importControl(fixture.targetRun, fixture.treatment, fixture.sourceRun, fixture.bundleSha256);

  expect(imported.grade).toBeUndefined();
  expect(imported.recovery).toMatchObject({ source_run_id: "canceled-controller", controller_elapsed_available: false,
    files: [{ path: `evaluator/imported-control/${path}`, sha256: fixture.source.results!.stock!.recovery.files[0]!.sha256 }] });
  expect(await sha256(join(fixture.targetRun, imported.recovery!.files[0]!.path))).toBe(imported.recovery!.files[0]!.sha256);
  expect(imported.patch_path).toBe("artifacts/stock/changes.patch");
  expect(fixture.treatment.imported_control).toMatchObject({
    source_run_id: fixture.source.id, bundle_sha256: fixture.bundleSha256,
    stdout_sha256: await sha256(join(fixture.targetRun, "artifacts/stock/codex.jsonl")),
    stderr_sha256: await sha256(join(fixture.targetRun, "artifacts/stock/codex.stderr")),
  });
  expect(await readFile(join(fixture.targetRun, "artifacts/stock/changes.patch"), "utf8"))
    .toBe(fixture.capturedPatch);
  expect(await readFile(join(fixture.targetRun, dirname(fixture.treatment.arms.stock.repository), "home/ubuntu/.codex/sessions/rollout.jsonl"), "utf8"))
    .toBe(rollout);
});

test("importControl rejects changed bundle evidence, mismatched identity, and changed rollout bytes", async () => {
  const missingStock = await publishedControl();
  missingStock.source.selected_arms = ["current"];
  await writeState(missingStock.sourceRun, missingStock.source);
  await writeFile(join(missingStock.bundle, "run.json"), await readFile(join(missingStock.sourceRun, "run.json")));
  await writeBundleManifest(missingStock.bundle);
  await expect(importControl(missingStock.targetRun, missingStock.treatment, missingStock.sourceRun, await sha256(join(missingStock.bundle, "MANIFEST.sha256"))))
    .rejects.toThrow("complete, valid original stock attempt");

  const changedBundle = await publishedControl();
  await writeFile(join(changedBundle.bundle, "stock-changes.patch"), "tampered patch\n");
  await expect(importControl(changedBundle.targetRun, changedBundle.treatment, changedBundle.sourceRun, changedBundle.bundleSha256))
    .rejects.toThrow("retained bundle evidence changed");

  const mismatched = await publishedControl();
  mismatched.treatment.task.sha256 = "9".repeat(64);
  await expect(importControl(mismatched.targetRun, mismatched.treatment, mismatched.sourceRun, mismatched.bundleSha256))
    .rejects.toThrow("published control does not match task, setup, model, tool, or resource controls");

  const changedRollout = await publishedControl();
  await writeFile(changedRollout.rolloutPath, rollout.replace("control-thread", "changed-thread"));
  await expect(importControl(changedRollout.targetRun, changedRollout.treatment, changedRollout.sourceRun, changedRollout.bundleSha256))
    .rejects.toThrow("control rollout bytes differ from the published bundle");
});

for (const comparisonName of ["journal-compaction", "duplicate-output"] as const) {
  test(`${comparisonName} rejects imported direct-Codex controls`, async () => {
    const comparison = state("journal-control");
    comparison.comparison = comparisonName;
    await expect(importControl("/unused-target", comparison, "/unused-source", "a".repeat(64)))
      .rejects.toThrow("direct-Codex stock controls only");
  });
}

test("general arm import rejects mismatched, invalid, missing, or altered published evidence before mutation", async () => {
  for (const fault of ["task", "model", "invalid", "missing-arm", "bundle", "rollout", "evaluation"] as const) {
    const f = await publishedControl();
    if (fault === "task") f.treatment.task.sha256 = "9".repeat(64);
    if (fault === "model") f.treatment.execution.model = "gpt-6.1-sol";
    if (fault === "evaluation") f.treatment.evaluation = { mode: "reuse", baselines: { current: "stock" } };
    if (fault === "invalid") {
      f.source.invalidity_reasons = ["Withdrawn"];
      await writeState(f.sourceRun, f.source);
      await writeFile(join(f.bundle, "run.json"), await readFile(join(f.sourceRun, "run.json")));
      await writeBundleManifest(f.bundle);
    }
    if (fault === "bundle") await writeFile(join(f.bundle, "stock-changes.patch"), "altered");
    if (fault === "rollout") await writeFile(f.rolloutPath, "altered");
    const before = structuredClone(f.treatment);
    await expect(importArms(f.targetRun, f.treatment, [{ target_arm: "current", run_dir: f.sourceRun,
      arm: fault === "missing-arm" ? "arm-3" : "stock" }])).rejects.toThrow();
    expect(f.treatment).toEqual(before);
    expect(await Bun.file(join(f.targetRun, "artifacts/current/changes.patch")).exists()).toBe(false);
  }
});

test.each(["fresh", "reuse"] as const)("generic %s imports reject fixed-mode source publications before copying", async mode => {
  const f = await publishedControl();
  f.source.fixed_verifier = { mode: "fixed-verifier", config_path: "evaluator/fixed-inputs/config.json",
    config_sha256: "f".repeat(64), task_directory: "evaluator/fixed-inputs/task", prompt_path: "instruction.md" };
  await writeState(f.sourceRun, f.source);
  await writeFile(join(f.bundle, "run.json"), await readFile(join(f.sourceRun, "run.json")));
  await writeBundleManifest(f.bundle);
  f.treatment.evaluation = { mode };
  const before = structuredClone(f.treatment);
  await expect(importArms(f.targetRun, f.treatment, [{ target_arm: "current", run_dir: f.sourceRun, arm: "stock" }]))
    .rejects.toThrow("fixed-verifier imports and evaluation reuse are not yet supported");
  await expect(importControl(f.targetRun, f.treatment, f.sourceRun, await sha256(join(f.bundle, "MANIFEST.sha256"))))
    .rejects.toThrow("fixed-verifier imports and evaluation reuse are not yet supported");
  expect(f.treatment).toEqual(before);
  expect(await Bun.file(join(f.targetRun, "artifacts/current/changes.patch")).exists()).toBe(false);
  expect(await Bun.file(join(f.targetRun, "artifacts/stock/changes.patch")).exists()).toBe(false);
});

test("general arm import can select a retained imported arm without its original source directory", async () => {
  const f = await publishedControl();
  const imported = await importArms(f.targetRun, f.treatment, [{ target_arm: "current", run_dir: f.sourceRun, arm: "stock" }]);
  f.treatment.results = imported;
  f.treatment.selected_arms = ["current"];
  await publishFixture(f.targetRun, f.treatment, { current: f.measured });
  await rm(f.sourceRun, { recursive: true });
  const target = join(f.directory, "second-target");
  const state2 = state("second-target");
  state2.source = structuredClone(f.treatment.source); state2.task.sha256 = f.treatment.task.sha256;
  const again = await importArms(target, state2, [{ target_arm: "stock", run_dir: f.targetRun, arm: "current" }]);
  expect(again.stock?.grade).toBeUndefined();
  expect(await readFile(join(target, state2.arm_attempts!.stock!.codex_home, "sessions/rollout.jsonl"), "utf8")).toBe(rollout);
});

test("an active-only legacy manifest cannot silently discard archived usage", async () => {
  const f = await publishedControl();
  const home = join(f.sourceRun, f.source.arm_attempts!.stock!.codex_home);
  await mkdir(join(home, "archived_sessions"));
  await writeFile(join(home, "archived_sessions/archived.jsonl"), rollout.replaceAll("control-thread", "archived-thread").replaceAll("response-1", "response-2"));
  const measured = await meterRollouts(home, pricing);
  await writeFile(join(f.bundle, "rollout-files.json"), JSON.stringify({ stock: [{ path: "rollout.jsonl", sha256: await sha256(f.rolloutPath) }] }));
  await writeFile(join(f.bundle, "report.json"), JSON.stringify({ validity: "valid", arms: { stock: { usage: measured } } }));
  await writeBundleManifest(f.bundle);
  await expect(importArms(f.targetRun, f.treatment, [{ target_arm: "current", run_dir: f.sourceRun, arm: "stock" }]))
    .rejects.toThrow("archived");
});

test.each([false, true])("v2 publication and import preserve active and archived totals (archived only: %s)", async archivedOnly => {
  const f = await archivedControl(archivedOnly);
  const manifest = JSON.parse(await readFile(join(f.bundle, "rollout-files.json"), "utf8"));
  expect(manifest).toEqual({ schema: ROLLOUT_SCHEMA, arms: { stock: await rolloutIdentity(f.home) } });
  f.treatment.evaluation = { mode: "fresh" };
  // Changed current pricing is distinct from verification under the source snapshot.
  (f.treatment.pricing as PricingSnapshot).models["gpt-6-astra"]!.prompt = 0.002;
  const imported = await importArms(f.targetRun, f.treatment, [{ target_arm: "current", run_dir: f.sourceRun, arm: "stock" }]);
  const copiedHome = join(f.targetRun, f.treatment.arm_attempts!.current!.codex_home);
  const originalPrices = await meterRollouts(copiedHome, f.source.pricing as PricingSnapshot);
  expect(originalPrices.totals.input_tokens).toBe(archivedOnly ? 200 : 300);
  expect(originalPrices.totals.estimated_api_usd).toBeCloseTo(archivedOnly ? 0.2 : 0.3);
  const provenance = JSON.parse(await readFile(join(f.targetRun, f.treatment.imported_arms!.current!.directory, "accounting-verification.json"), "utf8"));
  expect(provenance).toMatchObject({ status: "verified", repriced: true,
    source_usage: { totals: originalPrices.totals }, remetered_original: { totals: originalPrices.totals } });
  expect(provenance.source_usage.request_coverage).toBe("unverified");
  expect(await readFile(join(f.bundle, "report.md"), "utf8")).toBe("original report retained unchanged");
  expect(imported.current?.grade).toBeUndefined();
});

test.each(["missing", "changed", "measurement"])("v2 import rejects %s archive evidence or published totals", async fault => {
  const f = await archivedControl();
  if (fault === "missing") await rm(join(f.home, "archived_sessions/archived.jsonl"));
  if (fault === "changed") await writeFile(join(f.home, "archived_sessions/archived.jsonl"), "{}\n");
  if (fault === "measurement") {
    const report = JSON.parse(await readFile(join(f.bundle, "report.json"), "utf8"));
    report.arms.stock.usage.totals.input_tokens = 100;
    await writeFile(join(f.bundle, "report.json"), JSON.stringify(report));
    await writeBundleManifest(f.bundle);
  }
  await expect(importArms(f.targetRun, f.treatment, [{ target_arm: "current", run_dir: f.sourceRun, arm: "stock" }]))
    .rejects.toThrow(fault === "measurement" ? "published measurement" : "rollout");
  expect(f.treatment.imported_arms).toBeUndefined();
});

test("v2 nested imports retain both session namespaces without the original source", async () => {
  const f = await archivedControl();
  f.treatment.results = await importArms(f.targetRun, f.treatment, [{ target_arm: "current", run_dir: f.sourceRun, arm: "stock" }]);
  f.treatment.selected_arms = ["current"];
  await publishFixture(f.targetRun, f.treatment, { current: f.measured });
  await rm(f.sourceRun, { recursive: true });
  const target = join(f.directory, "next-import");
  const next = state("next-import");
  next.source = structuredClone(f.treatment.source);
  next.task.sha256 = f.treatment.task.sha256;
  next.pricing = f.treatment.pricing;
  await importArms(target, next, [{ target_arm: "stock", run_dir: f.targetRun, arm: "current" }]);
  const again = await meterRollouts(join(target, next.arm_attempts!.stock!.codex_home), next.pricing as PricingSnapshot);
  expect(again.totals).toEqual(f.measured.totals);
  expect((await rolloutIdentity(join(target, next.arm_attempts!.stock!.codex_home))).map(file => file.path))
    .toEqual(["archived_sessions/archived.jsonl", "sessions/rollout.jsonl"]);
});

test("historical evaluation reuse preserves archived accounting and frozen grades", async () => {
  const f = await archivedControl();
  const contract: CriteriaContract = { schema: "codex-ab.criteria.v1", task_sha256: f.source.task.sha256,
    criteria: [{ id: "fixture", description: "Required fixture behavior." }], preparation: "true", existing_tests: "true", qualification: "not-run" };
  const criteriaPath = "evaluator/criteria.json";
  await mkdir(join(f.sourceRun, "evaluator"), { recursive: true });
  await writeFile(join(f.sourceRun, criteriaPath), JSON.stringify(contract));
  f.source.criteria = { path: criteriaPath, sha256: await sha256(join(f.sourceRun, criteriaPath)), contract };
  f.treatment.criteria = structuredClone(f.source.criteria);
  const evidence = { criterion: "fixture", status: "fail" as const, basis: "executed" as const, reasoning: "Retained behavioral failure." };
  f.source.results!.stock!.grade!.semantic = { "pass-1-existing": [{ ...evidence, criterion: "existing-tests", status: "pass" }],
    "pass-2-existing": [{ ...evidence, criterion: "existing-tests", status: "pass" }] };
  f.source.results!.stock!.grade!.passed = false;
  f.source.judge = { status: "complete", started_at: f.source.created_at, model: "gpt-6.1-sol", reasoning_effort: "high",
    winner: "none", usage_homes: [], passes: [1, 2].map(pass => ({ pass: pass as 1 | 2, presentation: ["stock"],
      scores: { "candidate-1": { correctness: 1, completeness: 1, maintainability: 1, test_quality: 1, weighted_total: 1 } },
      criteria: { "candidate-1": [evidence] }, issues: [], evidence: [], rationale: "Retained fixture assessment.", winner: "none" })) };
  await publishFixture(f.sourceRun, f.source, { stock: f.measured });
  f.treatment.evaluation = { mode: "reuse", baselines: { stock: "current" } };
  const result = await importArms(f.targetRun, f.treatment, [{ target_arm: "current", run_dir: f.sourceRun, arm: "stock" }]);
  expect(result.current?.grade).toEqual(f.source.results!.stock!.grade);
  const measured = await meterRollouts(join(f.targetRun, f.treatment.arm_attempts!.current!.codex_home), f.source.pricing as PricingSnapshot);
  expect(measured.totals).toEqual(f.measured.totals);
});

test("results reevaluation imports every arm with archived accounting before new grading", async () => {
  const f = await archivedControl();
  f.source.results!.current = { ...f.source.results!.stock!, arm: "current", anonymous_id: "candidate-2" };
  f.source.arm_attempts!.current = { ...f.source.arm_attempts!.stock! };
  f.source.selected_arms = ["stock", "current"];
  await publishFixture(f.sourceRun, f.source, { stock: f.measured, current: f.measured });
  f.treatment.evaluation = { mode: "fresh" };
  const result = await importArms(f.targetRun, f.treatment, ["stock", "current"].map(arm => ({
    target_arm: arm, run_dir: f.sourceRun, arm,
  })), "reevaluation");
  for (const arm of ["stock", "current"]) {
    expect(result[arm]?.grade).toBeUndefined();
    const measured = await meterRollouts(join(f.targetRun, f.treatment.arm_attempts![arm]!.codex_home), f.source.pricing as PricingSnapshot);
    expect(measured.totals).toEqual(f.measured.totals);
  }
});

test.each(["measurement", "capture"])("imports reject missing current %s provenance", async missing => {
  const f = await publishedControl();
  if (missing === "measurement") await writeFile(join(f.bundle, "report.json"), JSON.stringify({ validity: "valid",
    arms: { stock: { usage: { complete: true, totals: f.measured.totals } } } }));
  else {
    delete f.source.results!.stock!.capture_identity;
    await writeState(f.sourceRun, f.source);
    await writeFile(join(f.bundle, "run.json"), await readFile(join(f.sourceRun, "run.json")));
  }
  await writeBundleManifest(f.bundle);
  await expect(importArms(f.targetRun, f.treatment, [{ target_arm: "current", run_dir: f.sourceRun, arm: "stock" }]))
    .rejects.toThrow(missing === "measurement" ? "accounting provenance" : "capture provenance");
  await expect(importControl(f.targetRun, f.treatment, f.sourceRun, await sha256(join(f.bundle, "MANIFEST.sha256"))))
    .rejects.toThrow(missing === "measurement" ? "accounting provenance" : "capture provenance");
  expect(f.treatment.imported_arms).toBeUndefined();
  expect(await Bun.file(join(f.targetRun, "artifacts/stock/changes.patch")).exists()).toBe(false);
});

test("control entry point preserves v2 active and archived evidence", async () => {
  const f = await archivedControl();
  await importControl(f.targetRun, f.treatment, f.sourceRun, await sha256(join(f.bundle, "MANIFEST.sha256")));
  const copiedHome = join(f.targetRun, dirname(f.treatment.arms.stock.repository), "home/ubuntu/.codex");
  expect((await meterRollouts(copiedHome, f.source.pricing as PricingSnapshot)).totals).toEqual(f.measured.totals);
  expect((await rolloutIdentity(copiedHome)).map(file => file.path)).toEqual(["archived_sessions/archived.jsonl", "sessions/rollout.jsonl"]);
});

test("bundle and repeated arm import retain sanitized runtime families without adjacent private files", async () => {
  const f = await publishedControl();
  const exports = { capture: "arms/stock/exports/capture.jsonl", metrics: "arms/stock/exports/metrics.json",
    validator: { path: "runtime/analyze_capture.py", sha256: "" }, reader: { path: "runtime/benchmark_jsonl.py", sha256: "" } };
  f.source.mekugi_exports_by_arm = { stock: exports };
  const child = `${exports.capture}.runtimes/child/capture.jsonl`;
  const family = JSON.stringify({ schema: "mekugi.capture.family.v1", runtimes: [
    { capture: "capture.jsonl", metrics: { exchanges: [{ sequence: 1 }] } },
    { capture: "capture.jsonl.runtimes/child/capture.jsonl", metrics: { exchanges: [{ sequence: 1 }] } },
  ] });
  for (const [path, value] of [
    [f.source.snapshot_manifest, "{}"], [f.source.runtime_tools.current_setup_files, "{}"], [f.source.task.path, "task"],
    ["reports/report.md", "report"], ["reports/report.json", JSON.stringify({ validity: "valid", arms: { stock: { usage: f.measured } } })],
    [exports.capture, "sanitized root\n"], [child, "sanitized child\n"],
    [exports.metrics, family], [exports.validator.path, "# validator"], [exports.reader.path, "# reader"],
    ["arms/stock/exports/capture.jsonl.runtimes/child/reads.jsonl", "private AX evidence"],
  ]) {
    await mkdir(dirname(join(f.sourceRun, path!)), { recursive: true });
    await writeFile(join(f.sourceRun, path!), value!);
  }
  f.source.current_snapshot.manifest_sha256 = await sha256(join(f.sourceRun, f.source.snapshot_manifest));
  f.source.runtime_tools.current_setup_files_sha256 = await sha256(join(f.sourceRun, f.source.runtime_tools.current_setup_files));
  f.source.task.sha256 = await sha256(join(f.sourceRun, f.source.task.path));
  f.treatment.task.sha256 = f.source.task.sha256;
  exports.validator.sha256 = await sha256(join(f.sourceRun, exports.validator.path));
  exports.reader.sha256 = await sha256(join(f.sourceRun, exports.reader.path));
  await writeState(f.sourceRun, f.source);
  await collectBundle(f.sourceRun);
  await writeBundleManifest(f.bundle);
  expect(await readFile(join(f.bundle, "stock-mekugi-capture.jsonl.runtimes/child/capture.jsonl"), "utf8")).toBe("sanitized child\n");
  expect(await Bun.file(join(f.bundle, "stock-mekugi-capture.jsonl.runtimes/child/reads.jsonl")).exists()).toBe(false);
  await writeFile(join(f.sourceRun, child), "modified after publication");
  await writeFile(join(f.sourceRun, exports.metrics), "modified after publication");
  const imported = await importArms(f.targetRun, f.treatment, [{ target_arm: "current", run_dir: f.sourceRun, arm: "stock" }]);
  const retained = f.treatment.imported_arms!.current!;
  expect(await readFile(join(f.targetRun, retained.directory, child), "utf8")).toBe("sanitized child\n");
  expect(retained.files.map(file => file.path).filter(path => path.endsWith("reads.jsonl"))).toEqual([]);
  f.treatment.results = imported;
  f.treatment.selected_arms = ["current"];
  // Publish the imported evidence using the ordinary bundle collector.
  for (const path of [f.treatment.snapshot_manifest, f.treatment.runtime_tools.current_setup_files, f.treatment.task.path]) {
    await mkdir(dirname(join(f.targetRun, path)), { recursive: true });
    await writeFile(join(f.targetRun, path), await readFile(join(f.sourceRun, path)));
  }
  f.treatment.current_snapshot.manifest_sha256 = f.source.current_snapshot.manifest_sha256;
  f.treatment.runtime_tools.current_setup_files_sha256 = f.source.runtime_tools.current_setup_files_sha256;
  await mkdir(join(f.targetRun, "reports"), { recursive: true });
  await writeFile(join(f.targetRun, "reports/report.json"), JSON.stringify({ validity: "valid", arms: { current: { usage: f.measured } } }));
  await writeFile(join(f.targetRun, "reports/report.md"), "report");
  await writeState(f.targetRun, f.treatment);
  const targetBundle = await collectBundle(f.targetRun);
  await writeBundleManifest(targetBundle);
  expect(await readFile(join(targetBundle, retained.directory, child), "utf8")).toBe("sanitized child\n");
  await rm(f.sourceRun, { recursive: true });
  const next = state("family-reimport");
  next.source = structuredClone(f.treatment.source);
  next.task.sha256 = f.treatment.task.sha256;
  const nextRoot = join(f.directory, "reimport");
  await importArms(nextRoot, next, [{ target_arm: "stock", run_dir: f.targetRun, arm: "current" }]);
  expect(await readFile(join(nextRoot, next.imported_arms!.stock!.directory, child), "utf8")).toBe("sanitized child\n");
  expect(await readFile(join(nextRoot, next.imported_arms!.stock!.directory, exports.metrics), "utf8")).toBe(family);
});

test("imports allow launcher-only image rebuilds and reject changed dependency controls", async () => {
  for (const fault of ["none", "same-key", "operator", "recipe", "model", "arm-model", "arm-matches"] as const) {
    const f = await publishedControl();
    for (const [i, state] of [f.source, f.treatment].entries()) {
      state.runtime_tools.mekugi_in_image = true;
      state.runtime_tools.mekugi_sha256 = String(i + 1).repeat(64);
      state.runtime_tools.mekugi_exec_sha256 = String(i + 3).repeat(64);
      if (i === 1 && fault === "same-key") state.runtime_tools = { ...f.source.runtime_tools };
      if (i === 1 && fault === "operator") state.operator.uid++;
      if (i === 1 && fault === "model") state.execution.model = "gpt-6.1-sol";
      if (fault === "arm-matches" || i === 1 && fault === "arm-model") state.arm_settings = { [i ? "current" : "stock"]: { model: "gpt-6.1-terra" } };
      state.dependency_image = { base_image: state.image_id!, key: dependencyKey(state, state.image_id!), image_id: `sha256:${String(i + 5).repeat(64)}` };
    }
    if (fault === "recipe") f.treatment.dependency_image!.key = "unknown-recipe";
    await writeState(f.sourceRun, f.source);
    await writeFile(join(f.bundle, "run.json"), await readFile(join(f.sourceRun, "run.json")));
    await writeBundleManifest(f.bundle);
    const operation = importArms(f.targetRun, f.treatment, [{ target_arm: "current", run_dir: f.sourceRun, arm: "stock" }]);
    if (fault === "none" || fault === "arm-matches") expect((await operation).current?.exit_code).toBe(0);
    else {
      await expect(operation).rejects.toThrow(["model", "arm-model"].includes(fault) ? "controls: model" : "controls: dependency image");
      expect(await Bun.file(join(f.targetRun, "artifacts/current/changes.patch")).exists()).toBe(false);
    }
  }
});
