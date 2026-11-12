import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkOutcome, retainedOutcome, validateCriteria, validateSemanticChecks } from "./semantic";
import { readFile } from "node:fs/promises";
import { checked } from "./process";
import { criterionAssessmentSchema, prepareSemanticAssessment, semanticHarnessSchema, semanticPromptEvidence, validateCriterionAssessments } from "./semantic-assessment";
import type { CommandEvidence, RunState } from "./types";
import * as containers from "./container";

const contract = validateCriteria({
  schema: "codex-ab.criteria.v1", task_sha256: "task",
  criteria: [{ id: "sum", description: "Return the sum of two inputs" }],
  preparation: "true", existing_tests: "node --test", qualification: "not-run",
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

test("failure provenance is explicit rather than inferred from exception vocabulary", () => {
  const check = { criterion: "sum", files: [], command: ["go", "test"], rationale: "Sum matches." };
  const execution: CommandEvidence = { command: "go test", started_at: "", elapsed_ms: 1, exit_code: 1, stdout: "", stderr: "undefined: AssumedImplementationName" };
  expect(checkOutcome(check, execution).status).toBe("fail");
  expect(checkOutcome(check, { ...execution, stderr: "assertion failed: expected 5, received 4" }).status).toBe("fail");
  for (const stderr of ["TypeError: math.add is not a function", "x.Foo undefined (type Item has no field or method Foo)",
    "ImportError: candidate dependency", "no such file or directory: candidate-owned-config"]) {
    expect(checkOutcome(check, { ...execution, stderr }).status).toBe("fail");
  }
  expect(checkOutcome(check, { ...execution, exit_code: 0, stderr: "caught expected Error: no such file or directory" }).status).toBe("pass");
  expect(checkOutcome(check, { ...execution, exit_code: 0, stderr: "" }).status).toBe("pass");
  expect(checkOutcome(check, { ...execution, exit_code: -1, stderr: "" }).status).toBe("unassessed");
  expect(checkOutcome(check, { ...execution, exit_code: 125, stderr: "HARNESS_ERROR: wrong interpreter" }).status).toBe("unassessed");
  expect(checkOutcome(check, { ...execution, exit_code: 0, stderr: "HARNESS_ERROR: failure swallowed by shell" }).status).toBe("unassessed");
  expect(checkOutcome(check, { ...execution, stderr: "candidate initialization regression" }).status).toBe("fail");
});

test("empty selected test suites cannot establish a pass, but mixed Go suites retain real coverage", () => {
  const check = { criterion: "sum", files: [], command: ["test"], rationale: "Sum behavior." };
  const execution = { command: "test", started_at: "", elapsed_ms: 1, exit_code: 0, stdout: "", stderr: "" };
  for (const stdout of ["ok example 0.1s [no tests to run]", "? example [no test files]", "Ran 0 tests in 0.01s",
    "collected 0 items", "# tests 0", " 0 pass\n 0 fail\nRan 0 tests across 0 files.", "No tests found!"]) {
    expect(checkOutcome(check, { ...execution, stdout }).status).toBe("unassessed");
  }
  expect(checkOutcome(check, { ...execution, stdout: "? empty [no test files]\nok tested 0.2s\n" }).status).toBe("pass");
  for (const stdout of ["Ran 0 tests in 0.01s\nRan 2 tests in 0.02s", "# tests 0\n# tests 2",
    "collected 0 items\ncollected 3 items", "No tests found!\n 2 pass\nRan 2 tests across 1 file."]) {
    expect(checkOutcome(check, { ...execution, stdout }).status).toBe("pass");
  }
  for (const stdout of [" 0 pass\n 1 fail\nRan 1 test across 1 file.",
    "? empty [no test files]\nassertion failed\nFAIL tested 0.2s\nFAIL", "Ran 0 tests\nsetup failed"]) {
    expect(checkOutcome(check, { ...execution, exit_code: 1, stdout }).status).toBe("fail");
  }
});

test("retained baseline tests declare relative patterns and leave internal build breaks unassessed", () => {
  const retained = { patterns: ["*_test.go"], command: "go test ." };
  expect(validateCriteria({ ...contract, retained_tests: retained }, "task").retained_tests).toEqual(retained);
  for (const value of [{ ...retained, patterns: [] }, { ...retained, command: "" }, { ...retained, patterns: ["../x_test.go"] },
    { ...retained, patterns: ["/abs_test.go"] }, { ...retained, patterns: [".git/*"] }, "go test ."]) {
    expect(() => validateCriteria({ ...contract, retained_tests: value }, "task")).toThrow("retained_tests");
  }
  const check = { criterion: "__retained_tests", files: [], command: ["go", "test"], rationale: "Baseline tests pass." };
  const execution: CommandEvidence = { command: "go test", started_at: "", elapsed_ms: 1, exit_code: 1, stdout: "", stderr: "" };
  const built = (stdout: string) => retainedOutcome(checkOutcome(check, { ...execution, stdout }));
  expect(built("# example\n./a_test.go:3:2: undefined: helper\nFAIL\texample [build failed]\nFAIL").status).toBe("unassessed");
  expect(built("--- FAIL: TestHelp (0.00s)\n    help_test.go:9: missing usage\nFAIL\nFAIL\texample\t0.1s\nFAIL").status).toBe("fail");
  expect(retainedOutcome(checkOutcome(check, { ...execution, exit_code: 0, stdout: "ok\texample\t0.1s" })).status).toBe("pass");
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
  const state = { id: "fixture-run", image: "fixture", source: { base_commit: base }, execution: { current_launcher: "codex" }, timeout_seconds: 1,
    resource_limits: { cpus: "1", memory: "1g" }, results: { stock: { grade: { elapsed_ms: 0 } } } } as unknown as RunState;
  const fixed = validateCriteria({ ...contract, retained_tests: { patterns: ["*_test.go"], command: "go test ." } }, "task");
  const mounts: string[][] = [];
  const run = spyOn(containers, "runOwnedContainer").mockImplementation(async options => {
    mounts.push(options.createArgs.filter(arg => arg.endsWith(":/baseline:ro")));
    const retained = options.name.includes("-retained-");
    return { exitCode: retained ? 1 : 0, stdout: retained ? "--- FAIL: TestHelp\nFAIL\texample\t0.1s" : "ok\texample\t0.1s", stderr: "", elapsedMs: 1, timedOut: false, canceled: false };
  });
  let prompt = "";
  try {
    const evidence = await prepareSemanticAssessment({ runDir: root, state, contract: fixed, pass: 1, order: ["stock"], docker: "unused", persistState: async () => {},
      ask: async (_stage, text) => { prompt = text; return { "candidate-1": [{ criterion: "sum", files: [], command: ["test"], rationale: "Sum behavior" }] }; } });
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
  } finally { run.mockRestore(); await rm(root, { recursive: true, force: true }); }
});

test("repair preserves behavioral failures and only replaces unassessed checks", async () => {
  const root = await mkdtemp(join(tmpdir(), "semantic-repair-"));
  const state = { id: "repair", image: "fixture", execution: { current_launcher: "codex" }, timeout_seconds: 1, resource_limits: { cpus: "1", memory: "1g" },
    results: { stock: { grade: { elapsed_ms: 0 } }, current: { grade: { elapsed_ms: 0 } } } } as unknown as RunState;
  const fixed = { ...contract, criteria: [...contract.criteria, { id: "broken", description: "Exercise its real entry point" }] };
  const executed: string[] = [];
  const run = spyOn(containers, "runOwnedContainer").mockImplementation(async options => {
    executed.push(options.name);
    const broken = options.name.includes("round-1") && options.name.endsWith("-broken");
    const failed = options.name.endsWith("-sum");
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
          criterion: item.id, command: ["test"], files: [], rationale: "Check required behavior",
        }))]));
      } });
    expect(stages).toEqual(["harness-1", "harness-2"]);
    expect(executed.filter(name => name.includes("round-2") && name.endsWith("-sum"))).toHaveLength(0);
    expect(evidence.candidates["candidate-1"].map(item => item.status)).toEqual(["fail", "pass"]);
    expect(evidence.history["candidate-1"].filter(item => item.criterion === "sum")).toHaveLength(1);
  } finally { run.mockRestore(); await rm(root, { recursive: true, force: true }); }
});

test("a purely behavioral failure does not buy another harness-authoring round", async () => {
  const root = await mkdtemp(join(tmpdir(), "semantic-no-repair-"));
  const state = { id: "failed", image: "fixture", execution: { current_launcher: "codex" }, timeout_seconds: 1, resource_limits: { cpus: "1", memory: "1g" },
    results: { stock: { grade: { elapsed_ms: 0 } } } } as unknown as RunState;
  const run = spyOn(containers, "runOwnedContainer").mockResolvedValue({ exitCode: 1, stdout: "", stderr: "assertion failed", elapsedMs: 1, timedOut: false, canceled: false });
  const stages: string[] = [];
  try {
    await prepareSemanticAssessment({ runDir: root, state, contract, pass: 1, order: ["stock"], docker: "unused", persistState: async () => {},
      ask: async stage => { stages.push(stage); return { "candidate-1": [{ criterion: "sum", files: [], command: ["test"], rationale: "Sum behavior" }] }; } });
    expect(stages).toEqual(["harness-1"]);
  } finally { run.mockRestore(); await rm(root, { recursive: true, force: true }); }
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
