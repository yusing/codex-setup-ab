import { expect, test } from "bun:test";
import { adaptiveBehaviorEvidence, verifiedCriterionEvidence } from "./behavioral-evidence";
import { verifiedBehaviorFixture } from "./test-support/behavioral-evidence";
import type { ArmResult, RunState } from "./types";

function fixture(passed = true) {
  const state = { task: { sha256: "task-sha" }, source: { base_commit: "base-commit" }, image: "sha256:runtime",
    criteria: { contract: { schema: "codex-ab.criteria.v1", task_sha256: "task-sha", criteria: [
      { id: "first", description: "First behavior" }, { id: "second", description: "Second behavior" },
    ], preparation: "true", existing_tests: "fixture-tests", qualification: "not-run" } } } as RunState;
  const result = { capture_identity: { status: "verified" }, grade: { passed,
    preparation: { command: "prepare", exit_code: 0 }, semantic: verifiedBehaviorFixture(state, passed) } } as ArmResult;
  return { state, result, row: result.grade!.semantic!["pass-1"]![0]! };
}

test("verified behavioral pass requires both exact criterion sets and existing-test gates", () => {
  const { state, result } = fixture();
  expect(adaptiveBehaviorEvidence(result, state)).toMatchObject({ behavior: "pass", evaluation_validity: "valid", evidence: "verified",
    coverage: { required: 6, verified_pass: 6, verified_fail: 0, unassessed: 0, complete: true } });
  delete result.grade!.semantic!["pass-2-existing"];
  expect(adaptiveBehaviorEvidence(result, state)).toMatchObject({ behavior: "unassessed", evaluation_validity: "unassessed",
    coverage: { verified_pass: 5, unassessed: 1, complete: false } });
});

test("one new row cannot promote legacy, source-only, duplicated, or missing coverage", () => {
  for (const damage of ["legacy", "source-only", "duplicate", "missing"] as const) {
    const { state, result } = fixture();
    const rows = result.grade!.semantic!["pass-2"]!;
    if (damage === "legacy") delete rows[0]!.schema;
    if (damage === "source-only") rows[0]!.basis = "source-only";
    if (damage === "duplicate") rows[1] = structuredClone(rows[0]!);
    if (damage === "missing") rows.pop();
    expect(adaptiveBehaviorEvidence(result, state).behavior).toBe("unassessed");
  }
});

test("a qualified necessary-condition failure settles a fail without inventing full coverage", () => {
  const { state, result, row } = fixture(false);
  result.grade!.semantic = { "pass-1": [row] };
  expect(adaptiveBehaviorEvidence(result, state)).toMatchObject({ behavior: "fail", evaluation_validity: "valid",
    coverage: { verified_fail: 1, verified_pass: 0, unassessed: 5, complete: false } });
  result.grade!.semantic = { "pass-1-retained": [row] };
  expect(adaptiveBehaviorEvidence(result, state).behavior).toBe("unassessed");
});

test("failed evaluator controls cannot score a candidate failure", () => {
  const { state, result, row } = fixture(false);
  row.qualification!.status = "failed";
  result.grade!.semantic = { "pass-1": [row] };
  expect(adaptiveBehaviorEvidence(result, state)).toMatchObject({ behavior: "unassessed", evaluation_validity: "invalid" });
});

test("retained qualification must match task, check, runtime, controls, and independent control results", () => {
  for (const damage of ["task", "check", "runtime", "controls", "reference", "missing", "duplicate", "forged-status"] as const) {
    const { state, row } = fixture();
    const q = row.qualification!;
    if (damage === "task") q.task_sha256 = "another-task";
    if (damage === "check") q.check_sha256 = "another-check";
    if (damage === "runtime") q.runtime_image = "another-image";
    if (damage === "controls") q.controls_sha256 = "another-set";
    if (damage === "reference") q.results[0]!.evidence.execution!.verifier!.status = "assertion_failure";
    if (damage === "missing") q.results.pop();
    if (damage === "duplicate") q.results[3] = structuredClone(q.results[0]!);
    if (damage === "forged-status") q.results[2]!.evidence.execution!.verifier!.cases[0]!.status = "pass";
    expect(verifiedCriterionEvidence(row, state)).toMatchObject({ behavior: "unassessed", evaluation_validity: "invalid" });
  }
});

test("candidate capture, protocol completion and frozen existing-test binding remain independent gates", () => {
  const { state, result, row } = fixture();
  delete result.capture_identity;
  expect(adaptiveBehaviorEvidence(result, state)).toMatchObject({ behavior: "unassessed", evidence: "legacy_unverified" });
  row.execution!.verifier!.completed = 0;
  expect(verifiedCriterionEvidence(row, state).behavior).toBe("unassessed");
  const existing = result.grade!.semantic!["pass-1-existing"]![0]!;
  state.criteria!.contract.existing_test_verification!.cases[0]!.expected = "changed expectation";
  expect(verifiedCriterionEvidence(existing, state)).toMatchObject({ behavior: "unassessed", evaluation_validity: "invalid" });
});

test("old pass flags, source-only failures, and malformed retained objects cannot manufacture verified outcomes", () => {
  const { state, result } = fixture();
  for (const rows of Object.values(result.grade!.semantic!)) for (const row of rows) delete row.schema;
  expect(adaptiveBehaviorEvidence(result, state)).toMatchObject({ behavior: "unassessed", evidence: "legacy_unverified" });
  const row = result.grade!.semantic!["pass-1"]![0]!;
  row.schema = "codex-ab.criterion-evidence.v2"; row.status = "fail"; row.basis = "source-only";
  expect(verifiedCriterionEvidence(row, state).behavior).toBe("unassessed");
  row.basis = "executed"; row.check = null as never;
  expect(verifiedCriterionEvidence(row, state).behavior).toBe("unassessed");
});
