import { expect, test } from "bun:test";
import { checkOutcome, validateCriteria, validateSemanticChecks } from "./semantic";
import { criterionAssessmentSchema, semanticHarnessSchema, semanticPromptEvidence, validateCriterionAssessments } from "./semantic-assessment";
import type { CommandEvidence } from "./types";

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
});
test("semantic prompts bound duplicated command output while retaining explicit evidence references", () => {
  const execution: CommandEvidence = {
    command: "test", started_at: "", elapsed_ms: 1, exit_code: 0,
    stdout: "x".repeat(600_000), stderr: "y".repeat(600_000),
  };
  const item = { criterion: "sum", status: "pass", basis: "executed", reasoning: "executed", execution } as const;
  const evidence = {
    candidates: { "candidate-1": [item], "candidate-2": [item] },
    history: { "candidate-1": [item], "candidate-2": [item] },
    existing_tests: { "candidate-1": item, "candidate-2": item },
  };
  const summary = semanticPromptEvidence(evidence);
  expect(JSON.stringify(summary).length).toBeLessThan(100_000);
  expect(summary.existing_tests["candidate-1"].execution?.stdout).toContain("complete output retained under /evidence");
  expect(execution.stdout).toHaveLength(600_000);
});

test("judge harness compilation problems remain unassessed, not candidate failures", () => {
  const check = { criterion: "sum", files: [], command: ["go", "test"], rationale: "Sum matches." };
  const execution: CommandEvidence = { command: "go test", started_at: "", elapsed_ms: 1, exit_code: 1, stdout: "", stderr: "undefined: AssumedImplementationName" };
  expect(checkOutcome(check, execution).status).toBe("unassessed");
  expect(checkOutcome(check, { ...execution, stderr: "assertion failed: expected 5, received 4" }).status).toBe("fail");
  for (const stderr of ["TypeError: math.add is not a function", "x.Foo undefined (type Item has no field or method Foo)"]) {
    expect(checkOutcome(check, { ...execution, stderr }).status).toBe("unassessed");
  }
  expect(checkOutcome(check, { ...execution, exit_code: 0, stderr: "caught expected Error: no such file or directory" }).status).toBe("pass");
  expect(checkOutcome(check, { ...execution, exit_code: 0, stderr: "" }).status).toBe("pass");
  expect(checkOutcome(check, { ...execution, exit_code: -1, stderr: "" }).status).toBe("unassessed");
  expect(checkOutcome(check, { ...execution, exit_code: 125, stderr: "HARNESS_ERROR: wrong interpreter" }).status).toBe("unassessed");
  expect(checkOutcome(check, { ...execution, stderr: "candidate initialization regression" }).status).toBe("fail");
});

test("a missing explicit public interface is a source-only defect, not a failed invented harness", () => {
  const evidence = {
    candidates: Object.fromEntries(["candidate-1", "candidate-2"].map(id => [id, [{ criterion: "sum", status: "unassessed", basis: "executed", reasoning: "undefined name" }]])),
    existing_tests: {}, history: {},
  } as Parameters<typeof validateCriterionAssessments>[2];
  const assessments = Object.fromEntries(["candidate-1", "candidate-2"].map(id => [id, [
    { criterion: "sum", status: "fail", basis: "source-only", reasoning: "The required exported add interface is absent from math.cjs." },
  ]]));
  expect(() => validateCriterionAssessments(assessments, contract, evidence)).toThrow("explicitly required");
  const explicit = { ...contract, criteria: [{ ...contract.criteria[0]!, required_interface: "export add(a, b)" }] };
  expect(validateCriterionAssessments(assessments, explicit, evidence)["candidate-1"][0]!.status).toBe("fail");
  assessments["candidate-1"]![0]!.status = "pass";
  expect(() => validateCriterionAssessments(assessments, explicit, evidence)).toThrow("cannot establish a pass");
});
