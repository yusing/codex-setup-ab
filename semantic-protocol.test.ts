import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checked } from "./process";
import { executeSemanticCheck, type SemanticCheck } from "./semantic";
import { semanticCheckHash, validateVerification, validateVerifierRecord, type VerifierRecord } from "./semantic-protocol";
import { qualifySemanticCheck, validateEvaluatorControls, type EvaluatorControls } from "./semantic-qualification";
import { prepareSemanticAssessment, validateCriterionAssessments } from "./semantic-assessment";
import type { RunState } from "./types";
import * as containers from "./container";
import * as semantic from "./semantic";

const check: SemanticCheck = { criterion: "sum", command: ["true"], files: [], rationale: "Sum includes both inputs.",
  verification: { schema: "codex-ab.verification.v1", cases: [{ id: "positive", kind: "python-call", module: "math_impl", callable: "add",
    input: '{"args":[2,3],"kwargs":{}}', expected: "5" }] } };

test("verification schema rejects zero cases, unsafe fields and invalid observations", () => {
  expect(validateVerification(check.verification)).toEqual(check.verification!);
  for (const verification of [null, {}, { schema: "codex-ab.verification.v1", cases: [] },
    { ...check.verification, cases: [{ ...check.verification!.cases[0], input: '{"args":[],"kwargs":{},"code":"x"}' }] },
    { ...check.verification, cases: [{ ...check.verification!.cases[0], expected: "NaN" }] },
    { ...check.verification, cases: [{ ...check.verification!.cases[0], expected: "1e400" }] },
    { ...check.verification, cases: [{ ...check.verification!.cases[0], module: "../../module" }] },
    { ...check.verification, cases: [{ id: "command", kind: "command", command: ["true"], expected_exit: -1, format: "text", expected: "" }] },
    { ...check.verification, cases: [{ id: "command", kind: "command", command: ["true"], args: [3], expected_exit: 0, format: "text", expected: "" }] },
    { ...check.verification, cases: [check.verification!.cases[0], check.verification!.cases[0]] }]) {
    expect(() => validateVerification(verification)).toThrow();
  }
});

test("completed records must bind the exact check and nonempty finished case set", () => {
  const record: VerifierRecord = { schema: "codex-ab.verifier-result.v1", check_sha256: semanticCheckHash(check), status: "passed",
    completed: 1, expected: 1, detail: "Supervisor compared an observed result.", cases: [{ id: "positive", status: "pass", exit_code: 0, stdout: "5", stderr: "" }] };
  expect(validateVerifierRecord(record, check, 1)).toEqual(record);
  for (const bad of [{ ...record, completed: 0 }, { ...record, expected: 2 }, { ...record, check_sha256: "old-check" },
    { ...record, completed: 1.5 }, { ...record, cases: [] }, { ...record, cases: [{ ...record.cases[0], status: "fail" }] }]) {
    expect(validateVerifierRecord(bad, check, 1)).toBeUndefined();
  }
});

test("the real executor rejects a missing record and never reuses stale completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "semantic-record-"));
  const output = join(root, "out");
  await mkdir(join(output, "supervisor"), { recursive: true });
  await writeFile(join(output, "supervisor/result.json"), JSON.stringify({ schema: "codex-ab.verifier-result.v1", check_sha256: semanticCheckHash(check),
    status: "passed", completed: 1, expected: 1, detail: "Stale pass", cases: [{ id: "positive", status: "pass", exit_code: 0, stdout: "5", stderr: "" }] }));
  const state = { id: "record", image: "fixture", timeout_seconds: 1, resource_limits: { cpus: "1", memory: "1g" } } as RunState;
  const run = spyOn(containers, "runOwnedContainer").mockResolvedValue({ exitCode: 0, stdout: "ASSERTION_REACHED_AND_PASSED", stderr: "", elapsedMs: 1,
    timedOut: false, canceled: false, cleanupVerified: true });
  try {
    const result = await executeSemanticCheck({ runDir: root, state, candidate: root, output, name: "missing-record", check, docker: "unused" });
    expect(result.status).toBe("unassessed");
    expect(result.execution?.verifier).toBeUndefined();
    expect(run.mock.calls[0]![0].createArgs).toContain("SETUID");
    expect(JSON.parse(await readFile(join(output, "harness.json"), "utf8")).candidate_uid).toBe(65534);
  } finally { run.mockRestore(); await rm(root, { recursive: true, force: true }); }
});

test.each([[1, 0.1], [3, 1], [300, 120]])("supervisor reserves cleanup time within an outer %is budget", async (seconds, caseSeconds) => {
  const root = await mkdtemp(join(tmpdir(), "semantic-time-budget-"));
  const run = spyOn(containers, "runOwnedContainer").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "", elapsedMs: 1,
    timedOut: false, canceled: false, cleanupVerified: true });
  try {
    const state = { id: "budget", image: "fixture", timeout_seconds: seconds, resource_limits: { cpus: "1", memory: "1g" } } as RunState;
    await executeSemanticCheck({ runDir: root, state, candidate: root, output: join(root, "out"), name: "budget", check, docker: "unused" });
    const harness = await Bun.file(join(root, "out/harness.json")).json();
    expect(harness.case_timeout_seconds).toBe(caseSeconds);
    expect(harness.execution_timeout_seconds).toBe(Math.max(0.1, seconds! - 2));
    expect(run.mock.calls[0]![0].timeoutMs).toBe(seconds! * 1000);
    expect(run.mock.calls[0]![0].createArgs).toContain("KILL");
  } finally { run.mockRestore(); await rm(root, { recursive: true, force: true }); }
});

test("a later no-op pass cannot erase a prior genuine behavioral failure at final grading", () => {
  const failed = { criterion: "sum", status: "fail" as const, basis: "executed" as const, reasoning: "wrong sum", check };
  const passed = { ...failed, status: "pass" as const };
  expect(() => validateCriterionAssessments({ "candidate-1": [{ criterion: "sum", status: "pass", basis: "executed", reasoning: "later success" }] }, {
    schema: "codex-ab.criteria.v1", task_sha256: "task", criteria: [{ id: "sum", description: "Add values" }], preparation: "true", existing_tests: "true", qualification: "not-run",
  }, { candidates: { "candidate-1": [passed] }, history: { "candidate-1": [failed, passed] }, existing_tests: { "candidate-1": passed } })).toThrow("remains unresolved");
});

test("a successful probe without frozen qualification remains unassessed at the real final-grade path", async () => {
  const root = await mkdtemp(join(tmpdir(), "semantic-unqualified-"));
  const contract = { schema: "codex-ab.criteria.v1" as const, task_sha256: "task", criteria: [{ id: "sum", description: "Add values" }],
    preparation: "true", existing_tests: "true", qualification: "not-run" as const };
  const state = { id: "unqualified", task: { sha256: "task" }, image: "fixture", execution: { current_launcher: "codex" }, results: { stock: { grade: { elapsed_ms: 0 } } } } as unknown as RunState;
  const run = spyOn(semantic, "executeSemanticCheck").mockImplementation(async options => ({
    schema: "codex-ab.criterion-evidence.v2", criterion: options.check.criterion, check: options.check,
    status: "pass", basis: "executed", reasoning: "An independent probe passed.",
  }));
  const rounds: string[] = [];
  try {
    const evidence = await prepareSemanticAssessment({ runDir: root, state, contract, pass: 1, order: ["stock"], docker: "unused", persistState: async () => {},
      ask: async stage => { rounds.push(stage); return { "candidate-1": [check] }; } });
    expect(evidence.candidates["candidate-1"][0]).toMatchObject({ status: "unassessed", probe_status: "pass", qualification: { status: "not-run" } });
    expect(rounds).toEqual(["harness-1"]);
    const judged = validateCriterionAssessments({ "candidate-1": [{ criterion: "sum", status: "pass", basis: "executed", reasoning: "Ignore qualification" }] }, contract, evidence);
    expect(judged["candidate-1"][0]!.status).toBe("unassessed");
  } finally { run.mockRestore(); await rm(root, { recursive: true, force: true }); }
});

test("qualification exercises frozen controls and rejects an always-passing check", async () => {
  const root = await mkdtemp(join(tmpdir(), "semantic-qualification-"));
  const source = join(root, "source");
  await mkdir(source);
  await checked(["git", "init", "-q", source]);
  await writeFile(join(source, "math_impl.py"), "def add(a, b): return 0\n");
  await checked(["git", "-C", source, "add", "."]);
  await checked(["git", "-C", source, "-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "baseline"]);
  const base = (await checked(["git", "-C", source, "rev-parse", "HEAD"])).stdout.trim();
  await checked(["git", "clone", "-q", "--bare", source, join(root, "seed.git")]);
  const controls: EvaluatorControls = { schema: "codex-ab.evaluator-controls.v1", cases: [
    { id: "correct", role: "reference", base: "baseline", files: [{ path: "math_impl.py", source: "def add(a,b): return a+b\n" }], expected: { sum: "pass" } },
    { id: "baseline", role: "baseline", base: "baseline", files: [], expected: { sum: "fail" } },
    { id: "subtraction", role: "negative", base: "baseline", files: [{ path: "math_impl.py", source: "def add(a,b): return a-b\n" }], expected: { sum: "fail" } },
    { id: "alternative", role: "alternative", base: "baseline", files: [{ path: "math_impl.py", source: "def combine(a,b): return sum([a,b])\n" }],
      python_target: { module: "math_impl", callable: "combine" }, expected: { sum: "pass" } },
  ] };
  const contract = { schema: "codex-ab.criteria.v1" as const, task_sha256: "task", criteria: [{ id: "sum", description: "Sum" }], preparation: "true", existing_tests: "true", qualification: "not-run" as const };
  const state = { id: "qualification", task: { sha256: "task" }, source: { base_commit: base }, criteria: { contract } } as RunState;
  let alwaysPass = false;
  const run = spyOn(semantic, "executeSemanticCheck").mockImplementation(async options => {
    const control = options.candidate.split("/").at(-2)!;
    if (control === "alternative") expect(options.check.verification!.cases[0]).toMatchObject({ callable: "combine", input: '{"args":[2,3],"kwargs":{}}', expected: "5" });
    expect(await readFile(join(options.candidate, "math_impl.py"), "utf8")).toContain("def ");
    return { criterion: "sum", status: alwaysPass || ["correct", "alternative"].includes(control) ? "pass" : "fail", basis: "executed", reasoning: "Control fixture result" };
  });
  try {
    expect(validateEvaluatorControls(controls, ["sum"])).toEqual(controls);
    const result = await qualifySemanticCheck({ runDir: root, output: join(root, "qualified"), state, check, controls, docker: "unused", evaluatorModel: "fixture-model" });
    expect(result.status).toBe("qualified");
    expect(result.results).toHaveLength(4);
    expect(result.controls_sha256).toHaveLength(64);
    expect(result.evaluator_model).toBe("fixture-model");
    alwaysPass = true;
    const rejected = await qualifySemanticCheck({ runDir: root, output: join(root, "noop"), state, check, controls, docker: "unused", evaluatorModel: "fixture-model" });
    expect(rejected.status).toBe("failed");
    expect(rejected.results.filter(item => !item.matched).map(item => item.control)).toEqual(["baseline", "subtraction"]);
  } finally { run.mockRestore(); await rm(root, { recursive: true, force: true }); }
});
