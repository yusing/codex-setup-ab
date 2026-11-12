import { expect, test } from "bun:test";
import { classifyAttempt, reliabilityReport, summarizeReliability, unavailableAttempt, type ReliabilityAttempt } from "./reliability";

const attempt = (id: string, fields: Partial<ReliabilityAttempt> = {}): ReliabilityAttempt => ({
  attempt_id: id, task_id: "task@sha", arm: "stock", source: "fresh", schedule: "concurrent",
  execution: "completed", behavior: "pass", evaluation_validity: "valid", candidate_cost_usd: 1,
  cost_eligible: true, evidence: "verified", ...fields,
});

test("scored denominator includes model failures and budget timeouts, not infrastructure, evaluation, cancellation or unknown outcomes", () => {
  const inputs = [attempt("pass"), attempt("task", { behavior: "fail" }),
    attempt("model", { execution: "model_failure", evaluation_validity: "unassessed", behavior: "unassessed" }),
    attempt("timeout", { execution: "budget_timeout", evaluation_validity: "unassessed", behavior: "unassessed" }),
    attempt("infra", { execution: "infrastructure_failure" }), attempt("evaluation", { evaluation_validity: "invalid" }),
    attempt("unknown", { behavior: "unassessed", evaluation_validity: "unassessed" }),
    attempt("canceled", { execution: "administrative_cancellation" }),
    unavailableAttempt({ attempt_id: "unstarted", task_id: "task@sha", arm: "stock", schedule: "concurrent", not_started: true })];
  const summary = summarizeReliability(inputs);
  expect(summary).toMatchObject({ planned: 9, attempted: 8, scored: 4, passing: 1, excluded: 4, not_started: 1,
    pass_rate: 0.25, timeout_rate: 0.25, cost_covered: 4, scored_candidate_cost_usd: 4,
    cost_per_verified_success_usd: 4, observed_attempted_candidate_cost_usd: 8 });
  expect(summary.outcomes).toEqual({ pass: 1, task_failure: 1, model_failure: 1, budget_timeout: 1,
    infrastructure_failure: 1, evaluator_failure: 1, unassessed: 1, administrative_cancellation: 1, not_started: 1 });
  expect(classifyAttempt(attempt("unproven", { execution: "unknown" }))).toBe("unassessed");
});

test("missing and approximate costs remain visible but cannot yield complete cost per success", () => {
  const missing = summarizeReliability([attempt("pass"), attempt("fail", { behavior: "fail", candidate_cost_usd: null, cost_eligible: false })]);
  expect(missing).toMatchObject({ scored: 2, passing: 1, pass_rate: 0.5, cost_covered: 1, cost_unknown: 1,
    scored_candidate_cost_usd: null, observed_scored_candidate_cost_usd: 1,
    cost_per_verified_success_usd: null, cost_per_verified_success_status: "incomplete_cost" });
  const approximate = summarizeReliability([attempt("pass", { candidate_cost_usd: 0.5, cost_eligible: false })]);
  expect(approximate).toMatchObject({ observed_scored_candidate_cost_usd: 0.5, cost_ineligible: 1, cost_covered: 0,
    cost_per_verified_success_usd: null });
  expect(summarizeReliability([attempt("free", { candidate_cost_usd: 0 })]).cost_per_verified_success_usd).toBe(0);
  expect(summarizeReliability([attempt("fail", { behavior: "fail", candidate_cost_usd: 0 })]))
    .toMatchObject({ cost_per_verified_success_usd: null, cost_per_verified_success_status: "no_successes" });
  expect(summarizeReliability([])).toMatchObject({ pass_rate: null, cost_coverage: null, cost_per_verified_success_status: "no_scored_attempts" });
});

test("reliability and joint-success efficiency can legitimately favor different setups", () => {
  const cheapOnSuccess = summarizeReliability([attempt("one", { candidate_cost_usd: 1 }),
    attempt("two", { behavior: "fail", candidate_cost_usd: 20 })]);
  const reliable = summarizeReliability([attempt("one", { candidate_cost_usd: 2 }), attempt("two", { candidate_cost_usd: 2 })]);
  expect(cheapOnSuccess.pass_rate).toBe(0.5);
  expect(cheapOnSuccess.cost_per_verified_success_usd).toBe(21);
  expect(reliable.pass_rate).toBe(1);
  expect(reliable.cost_per_verified_success_usd).toBe(2);
});

test("legacy outcomes cannot become verified successes; historical and schedule cohorts stay explicit", () => {
  const legacy = unavailableAttempt({ attempt_id: "old", task_id: "task", arm: "stock", schedule: "concurrent", legacy: true });
  expect(summarizeReliability([legacy])).toMatchObject({ attempted: 1, scored: 0, passing: 0, excluded: 1 });
  expect(classifyAttempt(attempt("stored-pass", { evidence: "legacy_unverified" }))).toBe("unassessed");
  expect(classifyAttempt(attempt("stored-fail", { evidence: "unavailable", behavior: "fail" }))).toBe("unassessed");
  const report = reliabilityReport([attempt("fresh"), attempt("old", { source: "historical" }), attempt("alternate", { schedule: "alternating" })]);
  expect(report.cohorts).toHaveLength(3);
  expect(report.arms.stock.sources).toEqual(["fresh", "historical"]);
});

test("invalid cost and duplicate attempt identities are rejected", () => {
  for (const value of [-1, Infinity, NaN]) expect(() => summarizeReliability([attempt("bad", { candidate_cost_usd: value })])).toThrow("invalid reliability");
  expect(() => summarizeReliability([attempt("bad", { candidate_cost_usd: null })])).toThrow("invalid reliability");
  expect(() => summarizeReliability([attempt("same"), attempt("same")])).toThrow("duplicate reliability");
});
