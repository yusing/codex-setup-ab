import { expect, test } from "bun:test";
import { checkOutcome, validateCriteria, validateSemanticChecks } from "./semantic";
import { validateCriterionAssessments } from "./semantic-assessment";
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
  const check = { criterion: "sum", files: [{ path: "additional.test.js", source: "" }], command: ["node", "--test"], rationale: "Sum is the required behavior." };
  expect(validateSemanticChecks([check], contract)).toHaveLength(1);
  expect(() => validateSemanticChecks([{ ...check, criterion: "weaker-outcome" }], contract)).toThrow();
  for (const path of ["../candidate.js", "/candidate.js", "nested/../../candidate.js", ".git/config", "nested/./test.js"]) {
    expect(() => validateSemanticChecks([{ ...check, files: [{ path, source: "" }] }], contract)).toThrow();
  }
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
});

test("a missing explicit public interface is a source-only defect, not a failed invented harness", () => {
  const evidence = {
    candidates: Object.fromEntries(["candidate-1", "candidate-2"].map(id => [id, [{ criterion: "sum", status: "unassessed", basis: "executed", reasoning: "undefined name" }]])),
    existing_tests: {}, fixed_tests: {}, history: {},
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
