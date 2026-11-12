import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkOutcome, retainedOutcome, validateCriteria, validateSemanticChecks } from "./semantic";
import { readFile } from "node:fs/promises";
import { checked } from "./process";
import { criterionAssessmentSchema, prepareSemanticAssessment, semanticHarnessSchema, semanticPromptEvidence, validateCriterionAssessments } from "./semantic-assessment";
import type { CommandEvidence, RunState } from "./types";
import { semanticCheckHash, type VerifierRecord } from "./semantic-protocol";

const verification = { schema: "codex-ab.verification.v1" as const, cases: [
  { id: "sum", kind: "command" as const, command: ["printf", "5"], stdin: "", expected_exit: 0, format: "text" as const, expected: "5" },
] };
const repair = { defect: "incorrect fixture adapter", retained_inputs: ["2, 3"], retained_assertions: ["sum equals 5"], retained_edge_cases: ["original case set"], retained_failure_conditions: ["wrong sum"] };
async function supervisorFixture(options: containers.OwnedContainerOptions, status: VerifierRecord["status"]): Promise<void> {
  const source = options.createArgs.find(arg => arg.endsWith(":/harness.json:ro"))!.slice(0, -":/harness.json:ro".length);
  const output = options.createArgs.find(arg => arg.endsWith(":/verifier-results:rw"))!.slice(0, -":/verifier-results:rw".length);
  const harness = JSON.parse(await readFile(source, "utf8"));
  const cases = harness.verification?.cases ?? [];
  await writeFile(join(output, "result.json"), JSON.stringify({
    schema: "codex-ab.verifier-result.v1", check_sha256: harness.check_sha256,
    status: status === "passed" && !cases.length ? "incomplete" : status,
    expected: cases.length, completed: ["passed", "assertion_failure", "candidate_error"].includes(status) ? cases.length : 0,
    detail: "Fixture supervisor evidence", cases: ["passed", "assertion_failure", "candidate_error"].includes(status)
      ? cases.map((item: any) => ({ id: item.id, status: status === "passed" ? "pass" : "fail", exit_code: status === "passed" ? 0 : 1, stdout: "", stderr: "" })) : [],
  }));
}

import * as containers from "./container";
import * as qualification from "./semantic-qualification";
const qualificationFixture = () => spyOn(qualification, "qualifySemanticCheck").mockImplementation(async options => ({
  schema: "codex-ab.evaluator-qualification.v1", status: "qualified", scope: [options.check.criterion],
  check_sha256: semanticCheckHash(options.check), task_sha256: "task", evaluator_version: "supervisor-v1",
  evaluator_model: "fixture", results: [], limitations: ["Model-free orchestration fixture"],
}));

const contract = validateCriteria({
  schema: "codex-ab.criteria.v1", task_sha256: "task",
  criteria: [{ id: "sum", description: "Return the sum of two inputs" }],
  preparation: "true", existing_tests: "node --test", existing_test_verification: verification, qualification: "not-run",
}, "task");

test("criteria are pinned before candidate-specific interface adaptation", () => {
  expect(() => validateCriteria({ ...contract, task_sha256: "other" }, "task")).toThrow();
  expect(() => validateCriteria({ ...contract, criteria: [contract.criteria[0], contract.criteria[0]] }, "task")).toThrow();
  expect(() => validateCriteria({ ...contract, qualification: "base-and-solution" }, "task")).toThrow();
  expect(() => validateCriteria({ ...contract, black_box: [] }, "task")).toThrow("no longer supported");
  expect(() => validateCriteria({ ...contract, evaluator_guidance: "" }, "task")).toThrow("nonempty string");
  const check = { criterion: "sum", files: [{ path: "additional.test.js", source: "" }], command: ["node", "--test"], rationale: "Sum is the required behavior." };
  expect(validateSemanticChecks([check], contract)).toHaveLength(1);
  expect(() => validateSemanticChecks([{ ...check, criterion: "weaker-outcome" }], contract)).toThrow();
  for (const path of ["../candidate.js", "/candidate.js", "nested/../../candidate.js", ".git/config", "nested/./test.js"]) {
    expect(() => validateSemanticChecks([{ ...check, files: [{ path, source: "" }] }], contract)).toThrow();
  }
});


test("assessment schema requires exactly the fixed criteria and excludes invented IDs", () => {
  const schema = criterionAssessmentSchema(contract) as {
    properties: Record<string, { minItems: number; maxItems: number; items: { properties: { criterion: { enum: string[] } } } }>;
  };
  for (const candidate of ["candidate-1", "candidate-2"]) {
    expect(schema.properties[candidate]?.minItems).toBe(1);
    expect(schema.properties[candidate]?.maxItems).toBe(1);
    expect(schema.properties[candidate]?.items.properties.criterion.enum).toEqual(["sum"]);
  }
});
test("harness schema restricts checks to the fixed criterion IDs", () => {
  const schema = semanticHarnessSchema(contract) as {
    properties: Record<string, { maxItems: number; items: { properties: { criterion: { enum: string[] }; command: { minItems: number } } } }>;
  };
  for (const candidate of ["candidate-1", "candidate-2"]) {
    expect(schema.properties[candidate]?.maxItems).toBe(1);
    expect(schema.properties[candidate]?.items.properties.criterion.enum).toEqual(["sum"]);
    expect(schema.properties[candidate]?.items.properties.command.minItems).toBe(1);
  }
  const repair = semanticHarnessSchema(contract, { "candidate-1": [], "candidate-2": ["sum"] }) as typeof schema;
  expect(repair.properties["candidate-1"]?.maxItems).toBe(0);
  expect(repair.properties["candidate-2"]?.maxItems).toBe(1);
  expect(repair.properties["candidate-2"]?.items.properties.criterion.enum).toEqual(["sum"]);
});
test("semantic prompts bound duplicated command output while retaining explicit evidence references", () => {
  const execution: CommandEvidence = {
    command: "test", started_at: "", elapsed_ms: 1, exit_code: 0,
    stdout: "x".repeat(600_000), stderr: "y".repeat(600_000),
  };
  const item = { criterion: "sum", status: "pass" as const, basis: "executed" as const, reasoning: "executed", execution,
    check: { criterion: "sum", command: ["node", "check.js"], rationale: "Sum behavior", files: [{ path: "check.js", source: "z".repeat(600_000) }] } };
  const evidence = {
    candidates: { "candidate-1": [item], "candidate-2": [item] },
    history: { "candidate-1": [item], "candidate-2": [item] },
    existing_tests: { "candidate-1": item, "candidate-2": item },
  };
  const summary = semanticPromptEvidence(evidence);
  expect(JSON.stringify(summary).length).toBeLessThan(100_000);
  expect(summary.existing_tests["candidate-1"].execution?.stdout).toContain("complete output retained under /evidence");
  expect(execution.stdout).toHaveLength(600_000);
  expect(summary.candidates["candidate-1"][0]?.check?.files[0]?.source).toContain("/evidence/round-*/candidate-1/sum/harness.json");
  expect(item.check.files[0].source).toHaveLength(600_000);
});

test("candidate text and child-selected exit codes cannot impersonate supervisor provenance", () => {
  const check = { criterion: "sum", files: [], command: ["test"], rationale: "Sum matches.", verification };
  const base: CommandEvidence = { command: "test", started_at: "", elapsed_ms: 1, exit_code: 0, stdout: "", stderr: "" };
  const record = (status: VerifierRecord["status"]): VerifierRecord => ({
    schema: "codex-ab.verifier-result.v1", check_sha256: semanticCheckHash(check), status, expected: 1, completed: 1,
    detail: "Supervisor assertion", cases: [{ id: "sum", status: status === "passed" ? "pass" : "fail", exit_code: 1, stdout: "", stderr: "" }],
  });
  for (const output of ["", "HARNESS_ERROR: fake evaluator error", "SyntaxError: candidate source", "ImportError: candidate dependency", "Ran 0 tests", "Ran 9 tests", "ASSERTION_REACHED_AND_PASSED"]) {
    expect(checkOutcome(check, { ...base, stdout: output }).status).toBe("unassessed");
    expect(checkOutcome(check, { ...base, exit_code: 125, stdout: output, verifier: record("assertion_failure") }).status).toBe("fail");
    expect(checkOutcome(check, { ...base, stderr: output, verifier: record("passed") }).status).toBe("pass");
  }
  const broken = { ...record("evaluator_wiring"), completed: 0, cases: [] };
  expect(checkOutcome(check, { ...base, verifier: broken }).status).toBe("unassessed");
  expect(checkOutcome(check, { ...base, verifier: { ...record("passed"), check_sha256: "wrong" } }).status).toBe("unassessed");
  expect(checkOutcome(check, { ...base, verifier: { ...record("passed"), completed: 0, cases: [] } }).status).toBe("unassessed");
});

test("retained baseline tests keep candidate compile failures rather than relabeling output", () => {
  const retained = { patterns: ["*_test.go"], command: "go test ." };
  expect(validateCriteria({ ...contract, retained_tests: retained }, "task").retained_tests).toEqual(retained);
  for (const value of [{ ...retained, patterns: [] }, { ...retained, command: "" }, { ...retained, patterns: ["../x_test.go"] },
    { ...retained, patterns: ["/abs_test.go"] }, { ...retained, patterns: [".git/*"] }, "go test ."]) {
    expect(() => validateCriteria({ ...contract, retained_tests: value }, "task")).toThrow("retained_tests");
  }
  const evidence = { criterion: "__retained_tests", status: "fail" as const, basis: "executed" as const, reasoning: "Candidate failed",
    execution: { command: "go test", started_at: "", elapsed_ms: 1, exit_code: 1, stdout: "FAIL example [build failed]", stderr: "" } };
  expect(retainedOutcome(evidence).status).toBe("fail");
});

test("retained baseline tests run baseline files against each candidate as separate evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "semantic-retained-"));
  const source = join(root, "source");
  const git = (...args: string[]) => checked(["git", "-c", "init.defaultBranch=main", "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
  await git("init", "-q", source);
  await Bun.write(join(source, "a_test.go"), "package a\n");
  await git("-C", source, "add", ".");
  await git("-C", source, "commit", "-qm", "base");
  const base = (await checked(["git", "-C", source, "rev-parse", "HEAD"])).stdout.trim();
  await git("clone", "-q", "--bare", source, join(root, "seed.git"));
  const state = { id: "fixture-run", image: "fixture", task: { sha256: "task" }, source: { base_commit: base }, execution: { current_launcher: "codex" }, timeout_seconds: 1,
    resource_limits: { cpus: "1", memory: "1g" }, results: { stock: { grade: { elapsed_ms: 0 } } } } as unknown as RunState;
  const fixed = validateCriteria({ ...contract, retained_tests: { patterns: ["*_test.go"], command: "go test ." } }, "task");
  const mounts: string[][] = [];
  const qualified = qualificationFixture();
  const run = spyOn(containers, "runOwnedContainer").mockImplementation(async options => {
    mounts.push(options.createArgs.filter(arg => arg.endsWith(":/baseline:ro")));
    const retained = options.name.includes("-retained-");
    await supervisorFixture(options, retained ? "candidate_error" : "passed");
    return { exitCode: retained ? 1 : 0, stdout: retained ? "--- FAIL: TestHelp\nFAIL\texample\t0.1s" : "ok\texample\t0.1s", stderr: "", elapsedMs: 1, timedOut: false, canceled: false };
  });
  let prompt = "";
  try {
    const evidence = await prepareSemanticAssessment({ runDir: root, state, contract: fixed, pass: 1, order: ["stock"], docker: "unused", persistState: async () => {},
      ask: async (_stage, text) => { prompt = text; return { "candidate-1": [{ criterion: "sum", files: [], command: ["test"], rationale: "Sum behavior", verification, repair }] }; } });
    expect(evidence.existing_tests["candidate-1"].status).toBe("pass");
    expect(evidence.retained_tests?.["candidate-1"].status).toBe("fail");
    expect(evidence.candidates["candidate-1"].map(item => item.criterion)).toEqual(["sum"]);
    const baseline = join(root, "evaluator/semantic/pass-1/baseline");
    expect(await readFile(join(baseline, "a_test.go"), "utf8")).toBe("package a\n");
    expect(mounts.filter(items => items.length)).toEqual([[`${baseline}:/baseline:ro`]]);
    const harness = JSON.parse(await readFile(join(root, "evaluator/semantic/pass-1/retained/candidate-1/__retained_tests/harness.json"), "utf8"));
    expect(harness.retained).toEqual({ patterns: ["*_test.go"] });
    expect(prompt).toContain("Retained baseline tests ran the unchanged baseline test files");
    expect(semanticPromptEvidence(evidence).retained_tests?.["candidate-1"].status).toBe("fail");
  } finally { run.mockRestore(); qualified.mockRestore(); await rm(root, { recursive: true, force: true }); }
});

test("original existing command executes once and stays diagnostic beside independent observations", async () => {
  const root = await mkdtemp(join(tmpdir(), "semantic-existing-command-"));
  const state = { id: "existing-command", image: "fixture", task: { sha256: "task" }, execution: { current_launcher: "codex" },
    timeout_seconds: 1, resource_limits: { cpus: "1", memory: "1g" }, results: { stock: { grade: { elapsed_ms: 0 } } } } as unknown as RunState;
  const qualified = qualificationFixture();
  const diagnostics: string[][] = [];
  const run = spyOn(containers, "runOwnedContainer").mockImplementation(async options => {
    const original = options.name.endsWith("-__existing_test_command");
    const source = options.createArgs.find(arg => arg.endsWith(":/harness.json:ro"))!.slice(0, -":/harness.json:ro".length);
    if (original) diagnostics.push(JSON.parse(await readFile(source, "utf8")).command);
    await supervisorFixture(options, original ? "candidate_error" : "passed");
    return { exitCode: original ? 1 : 0, stdout: original ? "Original suite failed" : "observed", stderr: "", elapsedMs: 2,
      timedOut: false, canceled: false, cleanupVerified: true };
  });
  try {
    const evidence = await prepareSemanticAssessment({ runDir: root, state, contract, pass: 1, order: ["stock"], docker: "unused", persistState: async () => {},
      ask: async () => ({ "candidate-1": [{ criterion: "sum", files: [], command: ["true"], rationale: "Sum behavior", verification }] }) });
    expect(diagnostics).toEqual([["sh", "-lc", contract.existing_tests]]);
    expect(evidence.existing_tests["candidate-1"].status).toBe("pass");
    expect(evidence.existing_test_commands?.["candidate-1"]).toMatchObject({ status: "unassessed", execution: { exit_code: 1, stdout: "Original suite failed" } });
    expect(evidence.candidates["candidate-1"].map(item => item.status)).toEqual(["pass"]);
    const saved = await Bun.file(join(root, "evaluator/semantic/pass-1/existing-command/candidate-1/__existing_test_command/evidence.json")).json();
    expect(saved.status).toBe("unassessed");
    expect(saved.reasoning).toContain("non-gating diagnostic");
    expect(semanticPromptEvidence(evidence).existing_test_commands?.["candidate-1"].execution?.exit_code).toBe(1);
    const replay = await prepareSemanticAssessment({ runDir: root, state, contract, pass: 1, order: ["stock"], docker: "unused", persistState: async () => {},
      reuseSaved: true, ask: async () => { throw Error("completed rounds must replay"); } });
    expect(diagnostics).toHaveLength(1);
    expect(replay.existing_test_commands).toEqual(evidence.existing_test_commands);
  } finally { run.mockRestore(); qualified.mockRestore(); await rm(root, { recursive: true, force: true }); }
});

test("repair preserves behavioral failures and only replaces unassessed checks", async () => {
  const root = await mkdtemp(join(tmpdir(), "semantic-repair-"));
  const state = { id: "repair", image: "fixture", task: { sha256: "task" }, execution: { current_launcher: "codex" }, timeout_seconds: 1, resource_limits: { cpus: "1", memory: "1g" },
    results: { stock: { grade: { elapsed_ms: 0 } }, current: { grade: { elapsed_ms: 0 } } } } as unknown as RunState;
  const fixed = { ...contract, criteria: [...contract.criteria, { id: "broken", description: "Exercise its real entry point" }] };
  const executed: string[] = [];
  const qualified = qualificationFixture();
  const run = spyOn(containers, "runOwnedContainer").mockImplementation(async options => {
    executed.push(options.name);
    const broken = options.name.includes("round-1") && options.name.endsWith("-broken");
    const failed = options.name.endsWith("-sum");
    await supervisorFixture(options, broken ? "evaluator_wiring" : failed ? "assertion_failure" : "passed");
    return { exitCode: broken ? 125 : failed ? 1 : 0, stdout: "", stderr: broken ? "HARNESS_ERROR: incorrect adapter" : failed ? "assertion failed" : "",
      elapsedMs: 1, timedOut: false, canceled: false };
  });
  const stages: string[] = [];
  try {
    const evidence = await prepareSemanticAssessment({ runDir: root, state, contract: fixed, pass: 1,
      order: ["stock", "current"], docker: "unused", persistState: async () => {},
      ask: async stage => {
        stages.push(stage);
        // A malicious or mistaken repair also submits a passing replacement for
        // the real failure. The runner must not execute or accept it.
        return Object.fromEntries(["candidate-1", "candidate-2"].map(id => [id, fixed.criteria.map(item => ({
          criterion: item.id, command: ["test"], files: [], rationale: "Check required behavior", verification, repair,
        }))]));
      } });
    expect(stages).toEqual(["harness-1", "harness-2"]);
    expect(executed.filter(name => name.includes("round-2") && name.endsWith("-sum"))).toHaveLength(0);
    expect(evidence.candidates["candidate-1"].map(item => item.status)).toEqual(["fail", "pass"]);
    expect(evidence.history["candidate-1"].filter(item => item.criterion === "sum")).toHaveLength(1);
  } finally { run.mockRestore(); qualified.mockRestore(); await rm(root, { recursive: true, force: true }); }
});

test("a purely behavioral failure does not buy another harness-authoring round", async () => {
  const root = await mkdtemp(join(tmpdir(), "semantic-no-repair-"));
  const state = { id: "failed", image: "fixture", task: { sha256: "task" }, execution: { current_launcher: "codex" }, timeout_seconds: 1, resource_limits: { cpus: "1", memory: "1g" },
    results: { stock: { grade: { elapsed_ms: 0 } } } } as unknown as RunState;
  const qualified = qualificationFixture();
  const run = spyOn(containers, "runOwnedContainer").mockImplementation(async options => {
    await supervisorFixture(options, "assertion_failure");
    return { exitCode: 1, stdout: "", stderr: "assertion failed", elapsedMs: 1, timedOut: false, canceled: false, cleanupVerified: true };
  });
  const stages: string[] = [];
  try {
    await prepareSemanticAssessment({ runDir: root, state, contract, pass: 1, order: ["stock"], docker: "unused", persistState: async () => {},
      ask: async stage => { stages.push(stage); return { "candidate-1": [{ criterion: "sum", files: [], command: ["test"], rationale: "Sum behavior", verification, repair }] }; } });
    expect(stages).toEqual(["harness-1"]);
  } finally { run.mockRestore(); qualified.mockRestore(); await rm(root, { recursive: true, force: true }); }
});

test("a missing explicit public interface is a source-only defect, not a failed invented harness", () => {
  const evidence = {
    candidates: Object.fromEntries(["candidate-1", "candidate-2"].map(id => [id, [{ criterion: "sum", status: "unassessed", basis: "executed", reasoning: "undefined name" }]])),
    existing_tests: {}, history: {},
  } as Parameters<typeof validateCriterionAssessments>[2];
  const assessments = Object.fromEntries(["candidate-1", "candidate-2"].map(id => [id, [
    { criterion: "sum", status: "fail", basis: "source-only", reasoning: "The required exported add interface is absent from math.cjs." },
  ]]));
  const inconclusive = validateCriterionAssessments(assessments, contract, evidence)["candidate-1"][0]!;
  expect(inconclusive.status).toBe("unassessed");
  expect(inconclusive.reasoning).toContain("Judge observation:");
  const explicit = { ...contract, criteria: [{ ...contract.criteria[0]!, required_interface: "export add(a, b)" }] };
  expect(validateCriterionAssessments(assessments, explicit, evidence)["candidate-1"][0]!.status).toBe("fail");
  assessments["candidate-1"]![0]!.status = "pass";
  expect(() => validateCriterionAssessments(assessments, explicit, evidence)).toThrow("cannot establish a pass");
});

test("executed failure labels need failed evidence for the same criterion", () => {
  const fixed = { ...contract, criteria: [...contract.criteria, { id: "retention", description: "Retain all requirements" }] };
  const failed = { criterion: "sum", status: "fail", basis: "executed", reasoning: "Assertion failed" } as const;
  const passed = { criterion: "retention", status: "pass", basis: "executed", reasoning: "Lifecycle passed" } as const;
  const broken = { ...passed, status: "unassessed", reasoning: "HARNESS_ERROR: wrong interpreter" } as const;
  const evidence = {
    candidates: { "candidate-1": [failed, passed], "candidate-2": [failed, broken] },
    existing_tests: { "candidate-1": passed, "candidate-2": passed }, history: { "candidate-1": [], "candidate-2": [] },
  };
  const assessments = Object.fromEntries(["candidate-1", "candidate-2"].map(id => [id, [
    { criterion: "sum", status: "fail", basis: "executed", reasoning: "The sum check failed" },
    { criterion: "retention", status: "fail", basis: "executed", reasoning: "The sum failure contradicts retained requirements" },
  ]]));
  const result = validateCriterionAssessments(assessments, fixed, evidence);
  for (const id of ["candidate-1", "candidate-2"] as const) {
    expect(result[id][0]!.status).toBe("fail");
    expect(result[id][1]).toMatchObject({ status: "unassessed", basis: "executed" });
    expect(result[id][1]!.reasoning).toContain("Judge observation: The sum failure contradicts retained requirements");
  }
  expect(evidence.candidates["candidate-1"][1]).toEqual(passed);
  expect(evidence.candidates["candidate-2"][1]).toEqual(broken);
});
