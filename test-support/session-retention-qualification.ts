import type { CriteriaContract, SemanticCheck } from "../semantic";

export const sessionRetentionObservations: Record<string, object> = {
  "aggregate-waits": { supported: true, initial: "waiting", early: false, pending_delivery: false,
    state: "completed", events: [{ source: "a", status: "failed" }, { source: "b", status: "interrupted" }] },
  "messages-and-deadlines": { supported: true, initial: "waiting", early: false, deadline_state: "timeout" },
  "checkpoint-admission": { supported: true, initial: "scheduled", yielded_stop: false,
    before_host_stop: false, continuation: true, duplicate: false },
  "native-settlement": { supported: true, initial: "scheduled", yielded_stop: false,
    before_host_stop: false, continuation: true, duplicate: false },
  "continuation-barrier": { supported: true, message_before: false, wake_before: false, message_after: true },
  "failure-and-supersession": { supported: true, retry: false, wake: false, status: "uncertain" },
  "integration-and-contracts": { foreign_rejected: true, initial: "waiting", message_kind: "message",
    message_source: "a", message_text: "progress", after_consumption: "waiting",
    restored_root: "paused", restored_child: "paused", generation: 1, aggregate_supported: true,
    aggregate_state: "completed", aggregate_events: [{ source: "a", status: "failed" }, { source: "b", status: "interrupted" }],
    restored_aggregate_events: [{ source: "a", status: "failed" }, { source: "b", status: "interrupted" }], restored_wait_mode: "all" },
};

/** Exact observed service state, not a suite exit code or number of passing tests. */
export function sessionRetentionQualificationChecks(contract: CriteriaContract): SemanticCheck[] {
  const preserved = contract.existing_test_verification?.cases[0];
  if (!preserved || preserved.kind !== "command") throw new Error("Session pack has no frozen command observer");
  return contract.criteria.map(criterion => ({
    criterion: criterion.id, files: [], command: preserved.command,
    rationale: "Observe actual Thread Control service state for " + criterion.id + ". This scoped fixture does not certify contract prose, provider execution, or all branches of a composite criterion.",
    verification: { schema: "codex-ab.verification.v1", cases: [{ ...preserved,
      id: "observed-" + criterion.id, args: [criterion.id], expected: JSON.stringify(sessionRetentionObservations[criterion.id]) }] },
  }));
}
