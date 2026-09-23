import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { controlIdentity, importControl } from "./control";
import { writeBundleManifest } from "./bundle";
import { runPair } from "./runner";
import type { CriteriaContract } from "./semantic";
import { meterRollouts, type PricingSnapshot } from "./usage";
import type { ArmResult, RunState } from "./types";
import { sha256, writeState } from "./state";

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

async function publishedControl() {
  const directory = await mkdtemp(join(tmpdir(), "codex-ab-control-test-"));
  directories.push(directory);
  const sourceRun = join(directory, "source-run");
  const targetRun = join(directory, "target-run");
  const bundle = join(sourceRun, "reports/bundle");
  const sessions = join(sourceRun, "arms/stock/home/ubuntu/.codex/sessions");
  await mkdir(bundle, { recursive: true });
  await mkdir(sessions, { recursive: true });
  await mkdir(join(sourceRun, "artifacts/stock"), { recursive: true });
  await mkdir(targetRun, { recursive: true });

  const source = state("published-control");
  const rolloutPath = join(sessions, "rollout.jsonl");
  await writeFile(rolloutPath, rollout);
  await writeFile(join(sourceRun, source.results!.stock!.patch_path), "diff --git a/file b/file\n");
  await writeFile(join(sourceRun, source.results!.stock!.stdout_path), "captured stdout\n");
  await writeFile(join(sourceRun, source.results!.stock!.stderr_path), "captured stderr\n");
  await writeState(sourceRun, source);
  await writeFile(join(bundle, "run.json"), await readFile(join(sourceRun, "run.json")));
  await writeFile(join(bundle, "stock-changes.patch"), "diff --git a/file b/file\n");
  await writeFile(join(bundle, "rollout-files.json"), JSON.stringify({ stock: [{ path: "rollout.jsonl", sha256: await sha256(rolloutPath) }] }));
  const measured = await meterRollouts(join(sourceRun, "arms/stock/home/ubuntu/.codex"), pricing);
  await writeFile(join(bundle, "report.json"), JSON.stringify({
    validity: "valid", arms: { stock: { usage: { complete: measured.complete, totals: measured.totals } } },
  }));
  await writeBundleManifest(bundle);
  const bundleSha256 = await sha256(join(bundle, "MANIFEST.sha256"));
  const treatment = state("treatment-run");
  return { directory, sourceRun, targetRun, bundle, bundleSha256, rolloutPath, source, treatment };
}

test("control identity includes task, execution, tool, setup, and resource controls", () => {
  const original = state("identity");
  expect(controlIdentity(original)).toEqual(controlIdentity({ ...original }));

  for (const changed of [
    { ...original, task: { ...original.task, sha256: "9".repeat(64) } },
    { ...original, execution: { ...original.execution, model: "gpt-6-sol" as const } },
    { ...original, runtime_tools: { ...original.runtime_tools, codex_sha256: "8".repeat(64) } },
    { ...original, resource_limits: { ...original.resource_limits, memory: "8g" } },
    { ...original, arms: { ...original.arms, stock: { ...original.arms.stock, home_template: "snapshots/other/home" } } },
  ]) {
    expect(controlIdentity(changed)).not.toEqual(controlIdentity(original));
  }
});

test("runner accepts stock-only selection and rejects current-only before Docker preflight", async () => {
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
  await expect(runPair({ ...options, arm: "current" })).rejects.toThrow("single-arm runs support stock controls only");
});

test("importControl carries a verified stock result into a matching treatment", async () => {
  const fixture = await publishedControl();
  expect(controlIdentity(fixture.source)).toEqual(controlIdentity(fixture.treatment));

  const imported = await importControl(fixture.targetRun, fixture.treatment, fixture.sourceRun, fixture.bundleSha256);

  expect(imported.grade).toBeUndefined();
  expect(imported.patch_path).toBe("artifacts/stock/changes.patch");
  expect(fixture.treatment.imported_control).toMatchObject({
    source_run_id: fixture.source.id, bundle_sha256: fixture.bundleSha256,
    stdout_sha256: await sha256(join(fixture.targetRun, "artifacts/stock/codex.jsonl")),
    stderr_sha256: await sha256(join(fixture.targetRun, "artifacts/stock/codex.stderr")),
  });
  expect(await readFile(join(fixture.targetRun, "artifacts/stock/changes.patch"), "utf8"))
    .toBe("diff --git a/file b/file\n");
  expect(await readFile(join(fixture.targetRun, "arms/stock/home/ubuntu/.codex/sessions/rollout.jsonl"), "utf8"))
    .toBe(rollout);
});

test("importControl rejects changed bundle evidence, mismatched identity, and changed rollout bytes", async () => {
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
