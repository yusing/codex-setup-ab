/** Scored-attempt metrics are separate from joint-success efficiency comparisons. */
export type AttemptExecution = "completed" | "model_failure" | "budget_timeout" | "infrastructure_failure"
  | "administrative_cancellation" | "not_started" | "unknown";
export type AttemptOutcome = "pass" | "task_failure" | "model_failure" | "budget_timeout"
  | "infrastructure_failure" | "evaluator_failure" | "unassessed" | "administrative_cancellation" | "not_started";
export interface ReliabilityAttempt {
  attempt_id: string;
  task_id: string;
  arm: string;
  source: "fresh" | "historical";
  schedule: string;
  execution: AttemptExecution;
  behavior: "pass" | "fail" | "unassessed";
  evaluation_validity: "valid" | "invalid" | "unassessed";
  candidate_cost_usd: number | null;
  /** Requires verified request coverage and comparable pricing, not just a numeric estimate. */
  cost_eligible: boolean;
  evidence: "verified" | "legacy_unverified" | "unavailable";
}
export const RELIABILITY_POLICY = {
  schema: "codex-ab.reliability-policy.v1",
  scored: ["pass", "task_failure", "model_failure", "budget_timeout"],
  excluded: ["infrastructure_failure", "evaluator_failure", "unassessed", "administrative_cancellation", "not_started"],
  cost_basis: "candidate execution only; all scored attempts including failures; complete comparable cost coverage required",
  zero_successes: "undefined; never zero",
} as const;

export function classifyAttempt(attempt: ReliabilityAttempt): AttemptOutcome {
  switch (attempt.execution) {
    case "infrastructure_failure": case "administrative_cancellation": case "not_started":
    case "budget_timeout": case "model_failure": return attempt.execution;
  }
  if (attempt.evaluation_validity === "invalid") return "evaluator_failure";
  if (attempt.evaluation_validity !== "valid" || attempt.execution !== "completed" || attempt.evidence !== "verified") return "unassessed";
  return attempt.behavior === "pass" ? "pass" : attempt.behavior === "fail" ? "task_failure" : "unassessed";
}

export function attemptIsScored(attempt: ReliabilityAttempt): boolean {
  return (RELIABILITY_POLICY.scored as readonly string[]).includes(classifyAttempt(attempt));
}

function validate(attempts: ReliabilityAttempt[]): void {
  const identities = new Set<string>();
  for (const attempt of attempts) {
    if (!attempt.attempt_id || !attempt.task_id || !attempt.arm || !attempt.schedule
      || !["fresh", "historical"].includes(attempt.source)
      || !["completed", "model_failure", "budget_timeout", "infrastructure_failure", "administrative_cancellation", "not_started", "unknown"].includes(attempt.execution)
      || !["pass", "fail", "unassessed"].includes(attempt.behavior)
      || !["valid", "invalid", "unassessed"].includes(attempt.evaluation_validity)
      || !["verified", "legacy_unverified", "unavailable"].includes(attempt.evidence)
      || typeof attempt.cost_eligible !== "boolean"
      || attempt.candidate_cost_usd !== null && (typeof attempt.candidate_cost_usd !== "number"
        || !Number.isFinite(attempt.candidate_cost_usd) || attempt.candidate_cost_usd < 0)
      || attempt.cost_eligible && attempt.candidate_cost_usd === null) throw new Error("invalid reliability attempt");
    const identity = JSON.stringify([attempt.arm, attempt.task_id, attempt.attempt_id, attempt.source, attempt.schedule]);
    if (identities.has(identity)) throw new Error("duplicate reliability attempt");
    identities.add(identity);
  }
}
const total = (values: number[]): number | null => {
  if (!values.length) return null;
  const sum = values.reduce((a, b) => a + b, 0);
  return Number.isFinite(sum) ? sum : null;
};
const rate = (numerator: number, denominator: number): number | null => denominator ? numerator / denominator : null;

export function summarizeReliability(attempts: ReliabilityAttempt[]) {
  validate(attempts);
  const kinds = [...RELIABILITY_POLICY.scored, ...RELIABILITY_POLICY.excluded];
  const outcomes = Object.fromEntries(kinds.map(kind => [kind, attempts.filter(item => classifyAttempt(item) === kind).length])) as Record<AttemptOutcome, number>;
  const attempted = attempts.filter(item => item.execution !== "not_started");
  const scored = attempts.filter(attemptIsScored);
  const covered = scored.filter(item => item.cost_eligible);
  const observedScored = scored.flatMap(item => item.candidate_cost_usd === null ? [] : [item.candidate_cost_usd]);
  const scoredCost = covered.length === scored.length ? total(covered.map(item => item.candidate_cost_usd!)) : null;
  const costStatus = !scored.length ? "no_scored_attempts" : !outcomes.pass ? "no_successes"
    : scoredCost === null ? "incomplete_cost" : "available";
  return {
    policy: RELIABILITY_POLICY,
    planned: attempts.length, attempted: attempted.length, scored: scored.length, passing: outcomes.pass,
    excluded: attempted.length - scored.length, not_started: outcomes.not_started,
    distinct_tasks: new Set(attempted.map(item => item.task_id)).size,
    scored_tasks: new Set(scored.map(item => item.task_id)).size,
    outcomes,
    pass_rate: rate(outcomes.pass, scored.length), timeout_rate: rate(outcomes.budget_timeout, scored.length),
    infrastructure_failure_rate: rate(outcomes.infrastructure_failure, attempted.length),
    evaluation_valid: attempted.filter(item => item.evaluation_validity === "valid").length,
    evaluation_coverage: rate(attempted.filter(item => item.evaluation_validity === "valid").length, attempted.length),
    cost_covered: covered.length, cost_coverage: rate(covered.length, scored.length),
    cost_unknown: scored.filter(item => item.candidate_cost_usd === null).length,
    cost_ineligible: scored.filter(item => item.candidate_cost_usd !== null && !item.cost_eligible).length,
    scored_candidate_cost_usd: scoredCost,
    observed_scored_candidate_cost_usd: total(observedScored),
    observed_attempted_candidate_cost_usd: total(attempted.flatMap(item => item.candidate_cost_usd === null ? [] : [item.candidate_cost_usd])),
    attempted_cost_observed: attempted.filter(item => item.candidate_cost_usd !== null).length,
    cost_per_verified_success_usd: costStatus === "available" ? scoredCost! / outcomes.pass : null,
    cost_per_verified_success_status: costStatus,
    sources: [...new Set(attempts.map(item => item.source))].sort(),
    schedules: [...new Set(attempts.map(item => item.schedule))].sort(),
  };
}

export function reliabilityReport(attempts: ReliabilityAttempt[]) {
  validate(attempts);
  return {
    schema: "codex-ab.reliability.v1" as const,
    attempts,
    arms: Object.fromEntries([...new Set(attempts.map(item => item.arm))].map(arm => [arm,
      summarizeReliability(attempts.filter(item => item.arm === arm))])),
    /** These cohorts prevent historical controls or differing schedules being silently pooled. */
    cohorts: [...new Set(attempts.map(item => JSON.stringify([item.arm, item.source, item.schedule])))].map(key => {
      const [arm, source, schedule] = JSON.parse(key) as [string, ReliabilityAttempt["source"], string];
      return { arm, source, schedule, summary: summarizeReliability(attempts.filter(item => item.arm === arm && item.source === source && item.schedule === schedule)) };
    }),
  };
}

/** Old reports have no trusted attempt classification. Keep their coverage explicitly unknown. */
export function unavailableAttempt(input: Pick<ReliabilityAttempt, "attempt_id" | "task_id" | "arm" | "schedule"> & {
  source?: ReliabilityAttempt["source"]; not_started?: boolean; legacy?: boolean;
}): ReliabilityAttempt {
  return { attempt_id: input.attempt_id, task_id: input.task_id, arm: input.arm, schedule: input.schedule,
    source: input.source ?? "fresh", execution: input.not_started ? "not_started" : "unknown",
    behavior: "unassessed", evaluation_validity: "unassessed", candidate_cost_usd: null, cost_eligible: false,
    evidence: input.legacy ? "legacy_unverified" : "unavailable" };
}

export function reliabilityMarkdown(report: ReturnType<typeof reliabilityReport>, labels: Record<string, string> = {}): string {
  const pct = (value: number | null): string => value === null ? "unavailable" : `${(value * 100).toFixed(1)}%`;
  return `## Scored-attempt reliability\n\nPass and timeout rates use scored attempts. Model/task failures and candidate budget timeouts are scored; infrastructure failures, invalid evaluations, unassessed results, and administrative cancellations are excluded and counted separately. Unstarted slots are planned but not attempted. Candidate costs include scored failures; evaluator spend remains separate.\n\n| Arm | Source / schedule | Attempted | Scored | Passed | Excluded | Cost covered | Pass rate | Timeout rate | Candidate USD / verified success |\n| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n${report.cohorts.map(({ arm, source, schedule, summary: s }) => `| ${labels[arm] ?? arm} | ${source} / ${schedule} | ${s.attempted} | ${s.scored} | ${s.passing} | ${s.excluded} | ${s.cost_covered}/${s.scored} | ${pct(s.pass_rate)} | ${pct(s.timeout_rate)} | ${s.cost_per_verified_success_usd === null ? s.cost_per_verified_success_status.replaceAll("_", " ") : s.cost_per_verified_success_usd.toFixed(6)} |`).join("\n")}\n\n| Arm | Source / schedule | Infrastructure failures | Evaluator failures | Unassessed | Administrative cancellations | Not started | Valid evaluation coverage |\n| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |\n${report.cohorts.map(({ arm, source, schedule, summary: s }) => `| ${labels[arm] ?? arm} | ${source} / ${schedule} | ${s.outcomes.infrastructure_failure} | ${s.outcomes.evaluator_failure} | ${s.outcomes.unassessed} | ${s.outcomes.administrative_cancellation} | ${s.not_started} | ${pct(s.evaluation_coverage)} |`).join("\n")}\n\nA missing or noncomparable cost cannot support a cost ranking. No verified successes makes cost per success undefined. Legacy records without trusted outcome dimensions remain unassessed here.\n`;
}
