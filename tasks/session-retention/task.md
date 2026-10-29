# Aggregate delegate waits and safe compaction checkpoints

Extend Thread Control so coordinators can wait for every selected descendant and
compact safely without losing unfinished work. Preserve unaffected behavior.

## Aggregate waits

Add `wait_mode: "all"` alongside the existing default `"any"` mode. Resolve the
selected descendants once. Aggregate mode returns every selected outcome only
after all selected agents settle and their result delivery finishes; failures and
interruptions count as settled. Addressed messages still wake either mode
immediately, without consuming queued completion notifications. Preserve deadline
behavior, selected identities, delivery order, retained claims, and restart recovery.

## Compaction checkpoints

Add an authenticated, self-directed `compact` operation and optional `compact:
true` on `wait_agent`. Register checkpoint and compound-wait intent atomically,
including when an outcome is already ready. Dispatch native compaction only after
the requesting execution and its host turn stop successfully. Yielded execution
stays pending; failed execution retires the checkpoint without claiming events.

Compaction is auxiliary work. Standalone success continues unfinished work once.
Compound success releases only the original wait: deliver an eligible outcome
once, or remain waiting without inference. Retain messages and results behind the
compaction barrier. Deadlines start when the wait is registered and may expire
during compaction.

On compound compaction failure, preserve the wait and events, report the failure
immediately, and include it in eventual wait delivery without starting inference
solely because compaction failed. Human input or interruption supersedes
undispatched continuation. Uncertain dispatch pauses for reconciliation and is
never retried blindly.

Support existing Codex root/delegate and Claude delegate paths through their
authoritative native settlement interfaces. Preserve authentication, logical work
generations, coordination attribution, and existing activity presentation.

## Delivery

Update the owning Thread Control, Session Control, and Claude backend contracts.
Add focused tests for aggregate outcomes, messages, deadlines, admission,
settlement, compaction failure, supersession, and restart recovery. Preserve
meaningful existing coverage and use local fixtures with isolated runtime state.
Use the workspace's `make test` runner for the affected packages. Go and pinned
Claude worker dependencies are prepared before execution; live model tests are
not required. Implementation design is yours.

Keep automatic compaction thresholds, SDK upgrades, same-cell wait continuation,
and unrelated features outside this change.
