# Mekugi coordination checkpoints benchmark

Implement aggregate delegate waits and safe agent compaction checkpoints on
Mekugi's modular Go workspace. These connected features come from two real
October 28–29 commits: coordinators wait for all selected descendants, then
compact without losing queued messages, outcomes, or unfinished work.

The [prompt](task.md) states the observable outcomes and leaves implementation
design open. The [manifest](manifest.json) pins the source, tests, criteria, and
evaluator-only reference evidence.

## Baseline and reference

Repository: [yusing/mekugi](https://github.com/yusing/mekugi).

- Baseline: [`0368c3b3abf4da904caec63948646b2a579c0695`](https://github.com/yusing/mekugi/commit/0368c3b3abf4da904caec63948646b2a579c0695), October 28, 2026.
- First excluded solution: [`495540d62e2e442f00455dc2c054de2d1f809505`](https://github.com/yusing/mekugi/commit/495540d62e2e442f00455dc2c054de2d1f809505), October 28, 2026, aggregate waits.
- Reference endpoint: [`97ea72b7ea54c4d70a78554908f911061df16bc1`](https://github.com/yusing/mekugi/commit/97ea72b7ea54c4d70a78554908f911061df16bc1), October 29, 2026, compaction checkpoints.

The baseline already contains server-owned agents, Thread Control, Session
Control, and the Claude delegate backend. It has no WASM/plugin runtime and
requires no architecture migration. Its date is later than the documented
cutoffs for `gpt-6-astra` and `gpt-6.1-sol`; see
[cutoff sources](../../doc/cli.md#commit-backed-task-provenance).

Candidates receive only the baseline history. Judges inspect nine frozen
ancestry patches and the combined diff under `/reference`. Only `495540d` and
`97ea72b` define new requirements. The other seven commits concern capture,
browser previews, parent-input/reply presentation, inspection events, environment
facts, and contributor guidance. They provide context, not additional features.
Equivalent designs and safe improvements are acceptable.

| Criterion | Reference | Upstream evidence |
| --- | --- | --- |
| `aggregate-waits` | `495540d` | Thread Control waits/bindings, launch delivery, coordination presentation; TestWaitAllSettlesSelectedOutcomesTogether and TestWaitAllMessageTimeoutAndStoppedTargets |
| `messages-and-deadlines` | Both | Logical-wait contracts and wait/control tests for messages, deadlines, retained claims, and recovery |
| `checkpoint-admission` | `97ea72b` | Thread Control actions/lifecycle; TestCompactionCheckpointAdmission |
| `native-settlement` | `97ea72b` | Session Control and Claude hooks; TestAgentCompactionUsesSoleLedgerAndBothGates and TestClaudeCompactionRequiresNativeSuccessBoundaryAndTerminal |
| `continuation-barrier` | `97ea72b` | TestCompoundCompactionRetainsWaitAndEvents and TestClaudeCompoundCompactionKeepsWaitBehindNativeSettlement |
| `failure-and-supersession` | `97ea72b` | TestCompactionSupersessionAndUncertainty and TestAgentCompactionCancellationPreservesLogicalSupersession |
| `integration-and-contracts` | Both | Thread Control, Session Control, and Claude backend specifications; wait/compaction tests and TestUISnapshotLogicalWaitAllOutcome |

Use these sources at the pinned endpoint, not the current working checkout.
The interaction between durable waits, execution settlement, compaction,
continuation, and two backend paths makes this a cross-cutting task. Workload size
does not establish candidate duration or observed compaction frequency.

## Prepare and run

In the workbench select **Mekugi coordination checkpoints**. The CLI identifier
remains `session-retention` to preserve existing selectors; new preparations use
this task instead of the former replay-storage retention prompt. Earlier runs
retain their original controls and form a different task.

Use `stock-current` for minimal versus current-home guidance, or `setup-commits`
for two committed setups. Use bare Codex for implementing Mekugi changes;
launcher-comparison presets reject this task. Select a
[separate-project task](../../doc/spec.md#stock-codex-versus-stock-plus-mekugi)
when comparing launchers.

After following the [build guide](../../doc/cli.md#prerequisites-and-build):

```sh
./dist/codex-ab launch --task session-retention \
  --source /path/to/mekugi --preset stock-current --prepare-only
```

Replace `--prepare-only` with `--confirm-paid-inference` to authorize candidate
and judge inference. Defaults remain a one-hour candidate limit and xhigh
reasoning. Alternatively, use `prepare --task-pack` with the manifest and source,
then preflight; see [portable task packs](../../doc/cli.md#portable-task-packs).

## Environment and qualification

Use Go 1.27 or newer and the workspace's `make test` runner. Preparation builds
the pinned Claude worker dependencies; the Agent SDK version is 0.3.312. It then
compiles the affected test packages with no matching tests and readonly module
resolution. Bulk `go mod download` adds incidental workspace checksums on these
snapshots, so preparation acquires only the selected test dependency graph.
Browser asset builds and general generation are unnecessary for this task.
The reference's environment-facts regression also needs Git supporting
[`--no-lazy-fetch`](https://github.com/git/git/blob/v2.46.0/Documentation/git.txt),
available in Git 2.46 and newer. Git 2.43 rejects that option and makes
`TestEnvironmentFactsCompactionProviderInput` fail despite correct context
refresh. The standard image supplies supported Git, and normal launch readiness
rebuilds stale standard images lacking the required capability. Retained
immutable image IDs stay unchanged. Do not skip the test or change the pinned
upstream source to accommodate an older image.

The focused gate covers Thread Control, coordination presentation, Session
Control, and launch tests matching `Wait|Compaction`. Run fixtures with isolated
`XDG_STATE_HOME`, `XDG_RUNTIME_DIR`, and `MEKUGI_RUNTIME_DIR`. Native-provider
acceptance tests are opt-in and must be reported separately from offline fixtures.

The frozen `existing_test_verification` observes actual Thread Control service
state: foreign-session rejection, default-any addressed-message identity and
payload, consumed-message non-replay, and paused root/child recovery with the
same work generation. A private Go overlay supplies the observer without editing
candidate source. The supervisor compares the complete JSON observation. This
is a scoped retained-behavior gate, not certification of every test matched by
`Wait|Compaction`; the original command remains a separate diagnostic.

Each criterion has pinned reference and unchanged-baseline controls, a precise
hash-bound production-source negative, and a valid alternative replacing the
descendant membership check with equivalent index lookup. The alternative
preserves the pinned implementation's other behavior, rather than claiming an
independently authored compaction design.

| Criterion | Model-free service observation | Targeted incorrect control |
| --- | --- | --- |
| `aggregate-waits` | Failed and interrupted outcomes remain pending until both results are delivered, then retain selected order | Never select aggregate outcomes |
| `messages-and-deadlines` | An incomplete aggregate wait expires from its registered deadline | Discard the registered deadline |
| `checkpoint-admission` | Standalone registration reports scheduled and creates exactly one continuation | Omit the standalone compact intent |
| `native-settlement` | Yielded execution cannot stop; compact dispatch waits for host settlement | Treat yielded execution as successful settlement |
| `continuation-barrier` | Messages and wakes remain blocked until compaction acknowledgment | Mark native compaction completed at dispatch |
| `failure-and-supersession` | Uncertain compaction pauses without retry or wake | Allow uncertain compact dispatch to be claimed again |
| `integration-and-contracts` | Combine preserved authenticated message handling with new aggregate results and retained ordered outcomes/mode after restart | Accept a foreign caller session |

The unchanged baseline passes the separate retained-behavior gate and fails all
seven criterion observations, including the new aggregate recovery workflow.
These checks deliberately qualify only the
listed service observations. They do not establish every branch of a criterion,
contract-document updates, native-provider execution, or all Session Control and
Claude launch integration. The pinned upstream tests and specifications remain
the evidence for that wider scope.

Run the source-backed checks without model inference from this repository:

```sh
CODEX_AB_SESSION_SOURCE=/path/to/mekugi \
  bun test session-retention-qualification.test.ts
```

The command archives both exact pins into temporary directories and applies
controls only there. Add `CODEX_AB_LIVE_DOCKER=1` and set
`CODEX_AB_SESSION_IMAGE` to a dependency-prepared image to exercise the ordinary
offline supervisor and qualification path as well. Source-only checks do not
establish the container boundary. Neither mode runs live native providers.

On October 29, 2026, both snapshots passed the focused gate with Go 1.27.3 and
Bun 1.4.4, including an offline rerun. The baseline had 176 passing test/subtest
outcomes; the reference had 234 and one native-Claude acceptance skip. Compile-only
preparation preserved tracked source and checksum files on both snapshots with
warm caches.

Model-free migration checks additionally passed the original focused gate on both
snapshots in an offline dependency-prepared container with Go 1.27.1, Bun 1.4.2,
and Git 2.56.1. The scoped frozen observations and all 28 control expectations
also passed through the ordinary offline supervisor and qualification executor
at two CPUs and 4 GiB per container. The complete supervisor matrix can take
tens of minutes because each control repeats preparation. Cold-cache launcher
preparation remains unverified.

The manifest retains `qualification: "not-run"`: qualification is recorded per
authored check and its frozen controls, not asserted by a pack-wide label.
Candidate duration, adaptive-judge quality, native-provider execution, and
observed compaction remain unmeasured. Prepare a fresh run to use the migrated
contract; retained runs keep their originally frozen inputs.
