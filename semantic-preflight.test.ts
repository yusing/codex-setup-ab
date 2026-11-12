import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { verifyAdaptiveContract, verifyAdaptiveJudgeInputs } from "./semantic-preflight";
import { runSemanticJudge } from "./semantic-judge";
import { judgeRunUnlocked } from "./judge";
import { runBenchmark } from "./workflow";
import type { RunState } from "./types";

const hash = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
const stateFixture = (): RunState => ({
  schema_version: 1, id: "preflight", status: "complete", source: { base_commit: "a".repeat(40), base_tree: "b".repeat(40) },
  task: { path: "task.md", sha256: hash("task") }, arms: { stock: {} },
  criteria: { contract: { schema: "codex-ab.criteria.v1", task_sha256: hash("task"),
    criteria: [{ id: "behavior", description: "Frozen fixture behavior" }], qualification: "not-run", preparation: "true", existing_tests: "true",
    existing_test_verification: { schema: "codex-ab.verification.v1", cases: [{ id: "observed", kind: "command", command: ["printf", "yes"], expected_exit: 0, format: "text", expected: "yes" }] },
    evaluator_controls: { schema: "codex-ab.evaluator-controls.v1", cases: ["reference", "baseline", "negative", "alternative"].map(role => ({
      id: role, role, base: "baseline", files: [], expected: { behavior: role === "negative" ? "fail" : "pass" },
    })) },
  } },
  results: { stock: { execution_status: "succeeded", exit_code: 0, canceled: false, timed_out: false,
    patch_path: "artifacts/stock/changes.patch", capture_identity: { status: "verified", manifest_path: "artifacts/stock/candidate-manifest.json", tree: "c".repeat(40), patch_sha256: hash("") } } },
} as unknown as RunState);

test("adaptive preflight requires all frozen control roles and independent existing observations", async () => {
  const fixed = stateFixture();
  fixed.fixed_verifier = { mode: "fixed-verifier" } as RunState["fixed_verifier"];
  await expect(verifyAdaptiveJudgeInputs("/unused", fixed)).rejects.toThrow("fixed-verifier mode");
  const state = stateFixture();
  delete state.criteria!.contract.existing_test_verification;
  await expect(verifyAdaptiveJudgeInputs("/unused", state)).rejects.toThrow("existing_test_verification");
  for (const role of ["reference", "baseline", "negative", "alternative"]) {
    const incomplete = stateFixture();
    incomplete.criteria!.contract.evaluator_controls!.cases = incomplete.criteria!.contract.evaluator_controls!.cases.filter(item => item.role !== role);
    await expect(verifyAdaptiveJudgeInputs("/unused", incomplete)).rejects.toThrow(`missing ${role}`);
  }
  const invalidNegative = stateFixture();
  invalidNegative.criteria!.contract.evaluator_controls!.cases.find(item => item.role === "negative")!.expected.behavior = "pass";
  await expect(verifyAdaptiveJudgeInputs("/unused", invalidNegative)).rejects.toThrow("missing negative");
  const missingCapture = stateFixture();
  delete missingCapture.results!.stock!.capture_identity;
  await expect(verifyAdaptiveJudgeInputs("/unused", missingCapture)).rejects.toThrow("trusted candidate capture provenance for stock");
});

test("adaptive preflight verifies capture bytes and source identity before accepting readiness", async () => {
  const root = await mkdtemp(join(tmpdir(), "semantic-preflight-"));
  try {
    const state = stateFixture(), artifact = join(root, "artifacts/stock");
    await mkdir(artifact, { recursive: true });
    await writeFile(join(artifact, "changes.patch"), "");
    await writeFile(join(artifact, "candidate-manifest.json"), JSON.stringify({ schema: "codex-ab.candidate-manifest.v1",
      base_commit: state.source.base_commit, base_tree: state.source.base_tree, captured_tree: state.results!.stock!.capture_identity!.tree,
      excluded_directories: [], files: [], changed_files: [], patch_sha256: hash("") }));
    await verifyAdaptiveJudgeInputs(root, state);
    state.results!.stock!.capture_identity!.tree = "d".repeat(40);
    await expect(verifyAdaptiveJudgeInputs(root, state)).rejects.toThrow("identity differs");
    state.results!.stock!.capture_identity!.tree = "c".repeat(40);
    await writeFile(join(artifact, "changes.patch"), "changed");
    await expect(verifyAdaptiveJudgeInputs(root, state)).rejects.toThrow("invalid or changed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unmigrated adaptive tasks fail before reading auth or launching any model runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "semantic-no-inference-"));
  try {
    const state = stateFixture();
    delete state.criteria!.contract.evaluator_controls;
    await writeFile(join(root, "run.json"), JSON.stringify(state));
    const missingAuth = join(root, "auth-must-not-be-read.json"), missingDocker = join(root, "docker-must-not-launch");
    await expect(judgeRunUnlocked(root, missingAuth, missingDocker)).rejects.toThrow("complete frozen evaluator controls");
    await expect(runSemanticJudge(root, state, missingAuth, missingDocker)).rejects.toThrow("complete frozen evaluator controls");
    expect(state.judge).toBeUndefined();
    expect(await Bun.file(join(root, "evaluator/judge")).exists()).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("multi-arm adaptive benchmarks reject unmigrated tasks before candidate setup or inference", async () => {
  const root = await mkdtemp(join(tmpdir(), "adaptive-contract-before-candidates-"));
  try {
    const state = stateFixture();
    state.status = "prepared";
    state.arms.current = { ...state.arms.stock! };
    delete state.results;
    // Task readiness is independent of captured candidates and filesystem state.
    expect(() => verifyAdaptiveContract(state)).not.toThrow();
    delete state.criteria!.contract.evaluator_controls;
    const original = JSON.stringify(state);
    await writeFile(join(root, "run.json"), original);
    await expect(runBenchmark({ runDir: root, authFile: join(root, "auth-must-not-be-read.json"),
      dockerBin: join(root, "docker-must-not-launch") })).rejects.toThrow("complete frozen evaluator controls");
    expect(await Bun.file(join(root, "run.json")).text()).toBe(original);
    expect(await Bun.file(join(root, "artifacts")).exists()).toBe(false);
    expect(await Bun.file(join(root, "reports")).exists()).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
