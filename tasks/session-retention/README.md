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

The focused gate covers Thread Control, coordination presentation, Session
Control, and launch tests matching `Wait|Compaction`. Run fixtures with isolated
`XDG_STATE_HOME`, `XDG_RUNTIME_DIR`, and `MEKUGI_RUNTIME_DIR`. Native-provider
acceptance tests are opt-in and must be reported separately from offline fixtures.

On October 29, 2026, both snapshots passed the focused gate with Go 1.27.3 and
Bun 1.4.4, including an offline rerun. The baseline had 176 passing test/subtest
outcomes; the reference had 234 and one native-Claude acceptance skip. Compile-only
preparation preserved tracked source and checksum files on both snapshots with
warm caches. Cold-cache and Docker preparation remain unverified.

The manifest retains `qualification: "not-run"`. No Docker or paid-inference run
has qualified this replacement task. Candidate duration, adaptive-judge quality,
and observed compaction remain unmeasured.
