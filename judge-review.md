# Judge/report independent review brief

## Outcome and source contract

Inspect `judge.ts`, `report.ts`, the `JudgePass`/`JudgeReport` declarations in `types.ts`, and `judge-report.test.ts` against these contracts:

- `judgeRun(runDir, authFile, dockerBin?)` and `buildReport(runDir)` remain the CLI-facing interfaces.
- New judge attempts use gpt-5.6-sol with high reasoning and `service_tier=fast`, which Codex normalizes to the effective priority tier persisted in `JudgeReport.service_tier`. The type continues to accept old medium reports and an absent tier field.
- Each paid judge pass uses a fresh stock-template home. The container receives only that home and the strict output schema; host-captured stdout/stderr and the first verdict are not mounted into the second pass.
- The judge prompt contains only the task, anonymous candidate patches and file lists, sanitized evaluator evidence, and the fixed rubric. Evidence content is explicitly untrusted and cannot give instructions.
- Pass order is exactly stock/current, then current/stock, while the model sees only candidate-1/candidate-2.
- The Codex `--output-schema` file is mounted read-only. The consumer independently validates every required field, nested key, candidate identifier, score range, evidence string, issue field, winner, rationale, and winner eligibility without coercion.
- Before each model launch, `run.json` records an incomplete judge, the attempted pass home, and any prior valid pass. Completed passes are persisted immediately. Failure, timeout, and cancellation are terminal, preserve attempted usage locations, and make every later judge call refuse resume/retry.
- Judge containers use the shared cancellation-aware create/start/cleanup lifecycle. Cancellation is checked during setup, after the immutable pre-launch state write, and immediately before `docker start`; every created container is force-removed and verified absent on terminal paths.
- Reports meter every attempted judge home, including failed/incomplete passes, separately from arm usage.
- `gates_complete` means all evaluator checks actually executed, not merely that placeholder evidence objects exist and not that every grade passed. A `command: not run`/exit -1 placeholder is unexecuted; an executed failing command is measured. A fully measured failed candidate is ineligible, but the other passing candidate can still win. Missing checks, incomplete arm usage, incomplete judge usage/result, disagreement, or an ineligible judged winner suppresses the overall winner.
- Reports use persisted `arm_attempts[*].codex_home` as the arm usage source, so paid inference remains metered when result or patch collection fails. A collected-result fallback remains for runs created before launch evidence was introduced.
- JSON retains per-agent usage, all judge attempts/passes, warnings, and pricing provenance. Markdown exposes each raw token category, command and wall time, estimated list-price API cost, current-minus-stock deltas, separate judge cost, warnings/provenance, and the single-pair descriptive limitation. It explicitly says the estimate is not a subscription charge or invoice and does not model any service-tier premium.
- Reported arm execution settings come from `state.execution`; judge and runner use `state.image_id ?? state.image`.
- `RunState.invalidity_reasons?: string[]` is absent/empty for a valid run. A nonempty value preserves all evidence and metrics while making report validity explicit, suppressing gates/completion/winner, and making `judgeRun` refuse the run. `invalidateRun(runDir, reasons)` records this metadata only on terminal complete/partial runs.

## Validation completed

- `bunx tsc --noEmit`: passed.
- `bun test ./judge-report.test.ts`: 11 passed. Covers pass isolation, read-only schema mount, reversed mapping, pass-one and pass-two failure persistence/cost/rerun refusal, cancellation cleanup, no paid start at the create/start cancellation boundary, strict malformed-output rejection, failed-candidate eligibility, production-shaped skipped-check suppression, metering an attempted arm without a collected result, disagreement retention, infrastructure invalidation with evidence preservation and judge refusal, and Markdown metrics/tier rendering.
- Full `bun test`: 32 passed, 5 live-Docker tests skipped by their environment gate, 0 failed.
- `git diff --check -- judge.ts report.ts types.ts judge-report.test.ts judge-review.md`: passed.

## Runtime-review dispositions

- **A, fixed:** `resultHasAllChecks` now rejects the grader's exact skipped sentinel (`command: not run`, `exit_code: -1`) instead of treating placeholder objects as executed checks. The production-shaped preparation-failure fixture proves no measurement or winner, while the earlier fail/pass fixture proves executed failures remain measurable.
- **B, fixed:** arm metering is keyed by persisted `arm_attempts[*].codex_home`, independent of result collection. The fixture deletes one collected result while retaining its stopped paid attempt and proves its full usage remains in JSON.
- **C, fixed:** judge uses the shared `runOwnedContainer` lifecycle and one `AbortController`. Local guards stop setup/persist continuation; the shared helper owns the final create/start cancellation boundary, force-removes only its labeled container, and verifies absence. Fixtures cover cancellation during an attached start and during create immediately before the paid start; the latter proves no `docker start` call.

## Residual risk for source inspection

The fixture Docker executable proves arguments, state transitions, usage metering, and host-visible isolation, but does not prove that the pinned Codex 0.153.4 binary accepts this exact strict JSON Schema through `codex exec --output-schema` and emits the structured final object in the observed JSONL event shape. If that contract differs, a paid pass will be terminally recorded as failed rather than silently retried, but the run will not receive a judge verdict. Inspect the pinned CLI implementation/contract for the flag, supported schema keywords, and final `agent_message.text` representation. Root-owned rebuilt-image preflight should also exercise schema acceptance without paid inference if the CLI offers such a validation path.

Live Docker cancellation after the image UID/GID correction remains an integration check owned by root. The fixture establishes cancellation-aware create/start ordering plus exact force-remove and absence verification calls; it cannot establish daemon/container timing behavior.
