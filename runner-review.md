# Runner isolation and lifecycle review brief

## Outcome and source boundary

Inspect `Dockerfile`, `prepare.ts`, `runner.ts`, `process.ts`, `container.ts`, `toolhost.ts`, `state.ts`, the runner-owned fields in `types.ts`, `cli.ts`, and the runner/container/tool-host tests. The benchmark must compare bare Codex with stock configuration against the exact same bare Codex with the snapshotted current setup. Hpatch is absent from both arms. An initial model attempt exposed an incomplete runtime image and generated-file prewarm; that attempt is retained as infrastructure-invalid, and this source is the corrected fresh-attempt implementation.

## Snapshot boundaries and adaptations

- `prepare` creates a new mode-0700 system temporary directory, shallow-fetches only recorded base `bb9e740362fd86c9214f5c893c65ae6c46587a60`, records its tree and source timestamp, and treats solution SHA `d50b9e6d7a2b01fc033a8aab523791876e4441b5` only as a forbidden object check.
- Each arm is a standalone `--no-local --no-hardlinks` clone. Preparation removes remotes and rejects alternates, linked worktrees, seed hardlinks, identity differences, and presence of the future commit.
- The current setup copies the allowlisted Codex configuration, overridden instructions, task guidance, roles, hooks and compiled hook binaries, local skills, all configured remote-skill entries and only their currently referenced content, the existing Go-guidelines provider, skills-mgr, rtk, and Bun. The manifest hashes each copied regular file and records adaptations.
- Project trust entries are replaced with only `/workspace`; absolute `/home/ubuntu` setup paths otherwise remain stable inside the current container.
- Auth, sessions, history, memories, shell snapshots, logs, state databases, OAuth state, unrelated caches/repositories, stale remote-skill generations, Git stores, and Hpatch configuration/runtime are excluded.
- The selected standalone Codex reports `codex-cli 0.153.4`; prepare records CLI SHA-256 `4d76e542c222ea8c75861d8c4ade60a1a332a63255ce1c60bdaebf7c2a2869e6` and its matching 63,381,656-byte `codex-code-mode-host` SHA-256 `d677dedf8179ca28ceb869a2e0b60d3ffad3d26f6e7738f7617d34500128a369`. Docker copies and verifies both from one named build context. Operator UID/GID are explicit image build args and recorded in the run.

## Mount and privacy invariants

- An arm receives only its own repository at `/workspace`, its dedicated `/home/ubuntu` including private mode-0600 auth, its own output directory and Go build cache, plus the audited Bun executable. There is no sibling arm, live host home/repository, evaluator directory, solution, Docker socket, or session-history mount.
- The evaluator acceptance test remains under the private run's `evaluator/` tree and is injected into separate evaluator workspaces only after both agents stop and submitted patches are captured.
- Preflight checks image UID/GID rather than widening private file modes. It proves mode-0600 config readability and private home writability as the intended container operator.

## Lifecycle, concurrency and capture

- A run transitions once from `prepared` to `running`, then `complete` or `partial`. Dependency/prewarm failures and cancellations persist a terminal partial state and error. Any repeat requires a new prepared run.
- `run --arm current` intentionally selects only the current arm for a non-paired repeat. The state records that selection; stock is not set up, prewarmed, launched, captured, or graded. The absent stock result keeps paired measurement and winner gates false, and the blind judge refuses the incomplete pair.
- Preflight itself is non-paid and leaves status `prepared`; it records the immutable Docker image ID. `run` repeats the checks and then uses the ID rather than a mutable tag.
- Both arms install the same locked plugin dependencies, build only the Git-ignored `dist/tools.js` embed, verify the tracked shared WASM hash is unchanged, and compile into separate Go caches. They never run the full generator, and Git cleanliness is checked after prewarm and again immediately before persisted launch intent. Only after both pass do agent containers start concurrently with identical CPU/memory/model/reasoning/service-tier settings.
- One shared container owner creates every deterministic container with a unique ownership label, starts it only after a final abort check, removes it by returned container ID, and verifies authoritative absence. It refuses preexisting names, daemon inspection errors, and cleanup failures. Cancellation independently removes the daemon container while bounded TERM/SIGKILL handles the attached client. Cancellation during preparation prevents agent launch; cancellation during inference skips grading; cancellation during grading cannot launch the next suite stage.
- Both inference promises settle before either evaluator starts, preventing grader contention with a still-running peer. Agent-stop timestamps exclude evaluator time.
- Changed-file discovery and binary patch capture compare the final working tree, index and any agent commits against the immutable recorded base, not mutable `HEAD`. Untracked files are intent-added only for patch serialization. Evaluators apply this preserved patch before hidden-test injection.

## Non-paid preflight contract

Preflight verifies direct `/usr/local/bin/codex`, exact version, both CLI and code-mode-host hashes, absence of `hpatch`, exact operator identity, and an immutable image ID. It runs a framed protocol handshake, session open, and real CodeMode VM `text(...)` execution against the companion with networking disabled and without model/API access. In a separate offline container it copies the snapshot into an ephemeral home, reads the complete `use-modern-go` body (larger than its 224-byte placeholder), and sends the exact successful PostToolUse payload to the registered `go_guidelines` hook, requiring the `Modern Go Guidelines v0.1.1: /workspace/go.mod ... END_GO_GUIDELINES sha256=` response. A separate ephemeral exact-base clone installs locked plugin dependencies, builds only the ignored JavaScript embed, proves the tracked shared WASM did not change, and compile-tests `internal/router`.

## Judge and report interfaces

- Runner state exposes authoritative `execution`, `image_id`, `runtime_tools`, per-arm agent results, `head_after_agent`, and preparation/acceptance/router grading evidence and elapsed time.
- `judge.ts` owns anonymous reversed-order passes and terminal attempted-judge state. `report.ts` owns eligibility, usage completeness and cost reporting. Their separate review brief is `judge-review.md`.
- Missing checks or incomplete accounting suppress an overall winner. A completed failed candidate is ineligible without suppressing an otherwise eligible passing candidate.

## Validation

- Corrected compatible Ubuntu 24.04 image build with UID/GID 1001:1001 passed as image ID `sha256:6b32c80ae856b602899faa1cbcc9594db7fd57fb5bda53187f8db190f02d7bcf`; build verifies Go 1.26.8, Node 24.20.0, glibc 2.39, both direct Codex runtime files, and absent Hpatch command.
- Fresh current-only preparation passed at `/tmp/codex-ab-jDIoUm`. Its two clones have exact base/tree identity, no remotes/alternates/future commit, and clean baselines. The current snapshot was captured at `2026-09-09T14:21:05.126Z`; its aggregate manifest SHA-256 is `c0b757066a385a866374c865acf2110c403ecc2e0a34c4bc662c50f2ebe53f13`. The runtime manifest records both standalone files and the snapshot remains secret/history/Hpatch-free. The optional `SMALL-TASK.md` is accurately absent from this current setup while active configuration, hooks, roles, and dependencies remain required.
- Root's corrected full preflight established companion VM execution, operator/private-file access, offline full remote-skill and substantive hook output, ignored-JavaScript-only generation with unchanged tracked WASM, and Go compilation before the current-only launch.
- `bun test`: 39 passed, 5 opt-in live-Docker cases skipped, 0 failed across usage, runner, tool-host, shared-container, and judge/report fixtures. This includes real local companion protocol execution without model access, missing-companion prepare/preflight failures, optional current snapshot input, corrected acceptance prefix selection, and current-only no-stock/no-winner behavior. The focused shared-container suite passed 8/8, including captured abort-cleanup rejection.
- `bunx tsc --noEmit`: passed.
- `bun run build` and compiled `--version`/`--help`: passed after the shared lifecycle and capture changes.

## Residual checks

- Independently inspect that every Docker mount and transition enforces the contracts above, especially live cancellation during warm/grade stages and immutable-base patch capture after agent commits.
- Root's opt-in live Docker lifecycle suite passed 5/5 (10 assertions), establishing create/start/attach semantics, nonzero exit propagation, TERM-ignoring cancellation, timeout cleanup, pre-aborted no-create, and confirmed daemon absence.
- No fresh inference should start unless the corrected preflight passes. The invalid prior attempt must remain separately recorded with its metrics and invalidity reasons; it is never resumed.
