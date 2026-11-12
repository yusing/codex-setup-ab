import { afterEach, expect, spyOn, test } from "bun:test";
import { copyFile, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as containers from "./container";
import { configureFixedVerifierRun, runFixedVerifiersUnlocked, verifyFixedArm, verifyFixedInputs } from "./fixed-workflow";
import { fixedTreeIdentity } from "./fixed-verifier";
import { readState, sha256, writeState } from "./state";
import type { ArmResult, RunState } from "./types";
import { createFixedFixture } from "./test-support/fixed-verifier";
import { prepareReevaluation } from "./reevaluate";
import { historicalEvaluation } from "./evaluation";
import { collectBundle } from "./bundle";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function preparedFixture() {
  const fixture = await createFixedFixture(); roots.push(fixture.root);
  const runDir = join(fixture.root, "run"), configPath = join(fixture.root, "original-config.json");
  await mkdir(join(runDir, "control"), { recursive: true });
  await copyFile(join(fixture.taskDirectory, "instruction.md"), join(runDir, "control/task.md"));
  await writeFile(configPath, JSON.stringify(fixture.config, null, 2));
  const manifest = JSON.parse(await readFile(fixture.candidateManifestPath, "utf8"));
  const state = { schema_version: 1, id: "fixed-workflow-fixture", created_at: new Date().toISOString(), status: "prepared",
    task: { path: "control/task.md", sha256: await sha256(join(runDir, "control/task.md")) },
    source: { base_commit: manifest.base_commit, base_tree: manifest.base_tree, path: "unused", source_timestamp: 1, forbidden_commit: "f".repeat(40) },
    image: fixture.config.image, timeout_seconds: 20, resource_limits: fixture.config.resources,
    execution: { model: "gpt-6-astra", reasoning_effort: "medium", service_tier: "default" },
    arms: { stock: { repository: "arms/stock/repo", home_template: "unused" } },
  } as RunState;
  await writeState(runDir, state);
  return { ...fixture, runDir, state, configPath, taskDir: fixture.taskDirectory };
}

async function retainedCandidate(fixture: Awaited<ReturnType<typeof preparedFixture>>) {
  const { runDir } = fixture;
  const state = await readState(runDir);
  await mkdir(join(runDir, "evaluator"), { recursive: true });
  await cp(fixture.candidate, join(runDir, "evaluator/stock"), { recursive: true, verbatimSymlinks: true });
  await mkdir(join(runDir, "artifacts/stock"), { recursive: true });
  await copyFile(fixture.candidateManifestPath, join(runDir, "artifacts/stock/candidate-manifest.json"));
  await copyFile(fixture.patchPath, join(runDir, "artifacts/stock/changes.patch"));
  const manifest = JSON.parse(await readFile(fixture.candidateManifestPath, "utf8"));
  const result: ArmResult = { arm: "stock", anonymous_id: "candidate-1", container: "fixture", started_at: state.created_at,
    finished_at: state.created_at, agent_elapsed_ms: 1, exit_code: 0, timed_out: false, canceled: false,
    patch_path: "artifacts/stock/changes.patch", stdout_path: "artifacts/stock/stdout", stderr_path: "artifacts/stock/stderr",
    changed_files: ["result.txt"], head_after_agent: manifest.base_commit,
    capture_identity: { status: "verified", manifest_path: "artifacts/stock/candidate-manifest.json", tree: manifest.captured_tree, patch_sha256: manifest.patch_sha256 } };
  state.results = { stock: result }; state.selected_arms = ["stock"]; state.status = "complete";
  await writeState(runDir, state);
  return state;
}

function verifier(reward: string | null, timedOut = false) {
  return spyOn(containers, "runOwnedContainer").mockImplementation(async options => {
    expect(options.createArgs.slice(0, 2)).toEqual(["--network", "none"]);
    const output = options.createArgs.find(argument => argument.endsWith("dst=/logs/verifier"))!.split(",src=")[1]!.split(",dst=")[0]!;
    if (reward !== null) await writeFile(join(output, "reward.txt"), reward);
    return { exitCode: 0, timedOut, canceled: false, elapsedMs: 2, stdout: "", stderr: "", cleanupVerified: true };
  });
}

async function publicationInputs(runDir: string) {
  const state = await readState(runDir);
  state.snapshot_manifest = "snapshot-manifest.json";
  for (const path of [state.snapshot_manifest, "setup-files.json", "reports/report.json", "reports/report.md"]) {
    await mkdir(join(runDir, path, ".."), { recursive: true });
    await writeFile(join(runDir, path), "{}");
  }
  state.current_snapshot = { captured_at: state.created_at, manifest_sha256: await sha256(join(runDir, state.snapshot_manifest)) };
  state.runtime_tools = { current_setup_files: "setup-files.json", current_setup_files_sha256: await sha256(join(runDir, "setup-files.json")) } as RunState["runtime_tools"];
  await writeState(runDir, state);
}

test("configure-fixed freezes exact original prompt, config and task outside candidate inputs", async () => {
  const f = await preparedFixture();
  const mock = verifier("1");
  try {
    const frozen = await configureFixedVerifierRun(f);
    expect(mock).not.toHaveBeenCalled();
    expect(frozen).toMatchObject({ mode: "fixed-verifier", config_path: "evaluator/fixed-inputs/config.json",
      task_directory: "evaluator/fixed-inputs/task", prompt_path: "instruction.md" });
    expect(await readFile(join(f.runDir, frozen.config_path), "utf8")).toBe(await readFile(f.configPath, "utf8"));
    expect(await fixedTreeIdentity(join(f.runDir, frozen.task_directory))).toEqual(await fixedTreeIdentity(f.taskDir));
    const original = await readFile(join(f.runDir, frozen.config_path), "utf8");
    await expect(configureFixedVerifierRun(f)).rejects.toThrow("already configured");
    expect(await readFile(join(f.runDir, frozen.config_path), "utf8")).toBe(original);
    await rm(f.taskDir, { recursive: true }); await rm(f.configPath);
    expect((await verifyFixedInputs(f.runDir, await readState(f.runDir))).config).toEqual(f.config);
  } finally { mock.mockRestore(); }
});

test("fixed source cannot silently become an adaptive reevaluation or reused grade", async () => {
  const f = await preparedFixture(); await configureFixedVerifierRun(f); const source = await retainedCandidate(f);
  const before = await readdir(f.root);
  await expect(prepareReevaluation(f.runDir, f.root)).rejects.toThrow("fixed-verifier source reevaluation is not yet supported");
  expect(() => historicalEvaluation(source, "stock")).toThrow("fixed-verifier evaluation reuse is not yet supported");
  expect(await readdir(f.root)).toEqual(before);
});

test("configure-fixed rejects mismatched prompt and unpinned or historical controls before execution", async () => {
  for (const fault of ["prompt", "pin", "reuse", "import", "started"] as const) {
    const f = await preparedFixture();
    if (fault === "prompt") {
      await writeFile(join(f.taskDir, "instruction.md"), "different task\n");
      f.config.task.tree_sha256 = (await fixedTreeIdentity(f.taskDir)).sha256;
      await writeFile(f.configPath, JSON.stringify(f.config));
    } else if (fault === "pin") await writeFile(join(f.taskDir, "tests/test.sh"), "changed verifier\n");
    else if (fault === "reuse") f.state.evaluation = { mode: "reuse" };
    else if (fault === "import") f.state.planned_imports = [{ target_arm: "stock", run_dir: "/historical", arm: "stock" }];
    else f.state.status = "running";
    await writeState(f.runDir, f.state);
    const mock = verifier("1");
    try {
      await expect(configureFixedVerifierRun(f)).rejects.toThrow(fault === "prompt" ? "prompt" : fault === "pin" ? "pinned" : fault === "started" ? "prepared" : "historical");
      expect(mock).not.toHaveBeenCalled();
      expect((await readState(f.runDir)).fixed_verifier).toBeUndefined();
    } finally { mock.mockRestore(); }
  }
});

test("configured fixed input tampering is rejected before candidate/verifier launch", async () => {
  for (const target of ["config", "task", "prompt"] as const) {
    const f = await preparedFixture(); const pinned = await configureFixedVerifierRun(f);
    const path = target === "config" ? pinned.config_path : target === "task" ? join(pinned.task_directory, "tests/test.sh") : "control/task.md";
    await writeFile(join(f.runDir, path), "changed\n");
    await expect(verifyFixedInputs(f.runDir, await readState(f.runDir))).rejects.toThrow(target === "config" ? "identity changed" : target === "task" ? "pinned" : "prompt");
  }
});

test("fixed bundle retains matching original trees and refuses to publish changed pins", async () => {
  const f = await preparedFixture(); const pinned = await configureFixedVerifierRun(f);
  await publicationInputs(f.runDir);
  const bundle = await collectBundle(f.runDir);
  expect((await fixedTreeIdentity(join(bundle, "fixed-task"))).sha256).toBe(f.config.task.tree_sha256);
  expect(await sha256(join(bundle, "fixed-verifier-config.json"))).toBe(pinned.config_sha256);
  const published = await readFile(join(bundle, "fixed-task/tests/test.sh"), "utf8");
  await writeFile(join(f.runDir, pinned.task_directory, "tests/test.sh"), "changed after evaluation\n");
  await expect(collectBundle(f.runDir)).rejects.toThrow("pinned configuration");
  expect(await readFile(join(bundle, "fixed-task/tests/test.sh"), "utf8")).toBe(published);
});

test.each(["contents", "capture-reference"])("fixed workflow rejects changed candidate %s before execution", async fault => {
  const f = await preparedFixture(); await configureFixedVerifierRun(f);
  const retained = await retainedCandidate(f);
  if (fault === "contents") await writeFile(join(f.runDir, "evaluator/stock/result.txt"), "changed after capture\n");
  else {
    retained.results!.stock!.capture_identity!.tree = "0".repeat(40);
    await writeState(f.runDir, retained);
  }
  const mock = verifier("1");
  try {
    await expect(runFixedVerifiersUnlocked(f.runDir, "docker")).rejects.toThrow(fault === "contents" ? "reconstructed candidate contents" : "retained run capture");
    expect(mock).not.toHaveBeenCalled();
    expect((await readState(f.runDir)).fixed_verifiers).toBeUndefined();
  } finally { mock.mockRestore(); }
});

test.each(["1", "0"])("configured fixed workflow grades original reward %s and retains every attempt", async reward => {
  const f = await preparedFixture(); await configureFixedVerifierRun(f); await retainedCandidate(f);
  const mock = verifier(reward);
  try {
    await runFixedVerifiersUnlocked(f.runDir, "docker");
    const first = await readState(f.runDir);
    expect(first.judge).toBeUndefined();
    expect(first.results?.stock?.grade).toMatchObject({ passed: reward === "1",
      preparation: { exit_code: 0 }, router_suite: { exit_code: reward === "1" ? 0 : 1 },
      fixed: { behavioral_result: reward === "1" ? "pass" : "fail", mode: "fixed-verifier" } });
    const oldPath = first.fixed_verifiers!.stock![0]!.result_path;
    const oldBytes = await readFile(join(f.runDir, oldPath), "utf8");
    await runFixedVerifiersUnlocked(f.runDir, "docker");
    const second = await readState(f.runDir);
    expect(second.fixed_verifiers?.stock).toHaveLength(2);
    expect(second.fixed_verifiers!.stock![1]!.result_path).not.toBe(oldPath);
    expect(await readFile(join(f.runDir, oldPath), "utf8")).toBe(oldBytes);
    expect(mock).toHaveBeenCalledTimes(2);
  } finally { mock.mockRestore(); }
});

test.each([false, true])("fixed workflow retains unusable evidence and prevents behavioral success (timeout: %s)", async timeout => {
  const f = await preparedFixture(); await configureFixedVerifierRun(f); await retainedCandidate(f);
  const mock = verifier(timeout ? "1" : null, timeout);
  try {
    await expect(runFixedVerifiersUnlocked(f.runDir, "docker")).rejects.toThrow("fixed verification unavailable");
    const state = await readState(f.runDir);
    expect(state.results?.stock?.grade).toMatchObject({ passed: false, router_suite: { exit_code: -1 }, fixed: { behavioral_result: "unassessed" } });
    expect(state.fixed_verifiers?.stock).toHaveLength(1);
    expect(await Bun.file(join(f.runDir, state.fixed_verifiers!.stock![0]!.result_path)).exists()).toBe(true);
  } finally { mock.mockRestore(); }
});

test("supplemental fixed verification preserves adaptive grades and retains standalone original inputs", async () => {
  const f = await preparedFixture(); const state = await retainedCandidate(f);
  const command = { command: "adaptive fixture", started_at: state.created_at, elapsed_ms: 1, exit_code: 0, stdout: "", stderr: "" };
  state.results!.stock!.grade = { preparation: command, router_suite: command, passed: true, elapsed_ms: 1 };
  await writeState(f.runDir, state);
  const mock = verifier("0");
  try {
    const result = await verifyFixedArm({ ...f, arm: "stock" });
    expect(result.behavioral_result).toBe("fail");
    const retained = await readState(f.runDir);
    expect(retained.results?.stock?.grade).toEqual(state.results!.stock!.grade);
    expect(retained.fixed_verifier).toBeUndefined();
    const output = join(f.runDir, retained.fixed_verifiers!.stock![0]!.result_path, "..");
    await publicationInputs(f.runDir);
    const bundle = await collectBundle(f.runDir);
    expect((await fixedTreeIdentity(join(bundle, "fixed-verifiers/stock/1/inputs/task"))).sha256).toBe(f.config.task.tree_sha256);
    await rm(f.taskDir, { recursive: true }); await rm(f.configPath);
    expect(await fixedTreeIdentity(join(output, "inputs/task"))).toMatchObject({ sha256: f.config.task.tree_sha256 });
    expect(JSON.parse(await readFile(join(output, "inputs/config.json"), "utf8"))).toEqual(f.config);
    await writeFile(join(output, "inputs/task/tests/test.sh"), "changed after assessment\n");
    await expect(collectBundle(f.runDir)).rejects.toThrow("supplemental fixed verifier task differs");
  } finally { mock.mockRestore(); }
});
