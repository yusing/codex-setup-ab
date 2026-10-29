# Skills manager repository-to-agent workflow

Reproduce the connected behavior of **12 actual skills-mgr commits**: install a
repository skill, recover missing cached content, inspect and validate what an
agent can use, and safely change selection and content without the interactive UI.
The [prompt](task.md) leaves command names, output formats, and implementation
design open. The [manifest](manifest.json) binds the outcomes to behavioral
criteria and evaluator-only upstream evidence.

## Baseline and reference

Repository: [yusing/skills-mgr](https://github.com/yusing/skills-mgr).

- Baseline: [`9ae7009faa837921ef6ed28e7b78f02a8e2f964e`](https://github.com/yusing/skills-mgr/commit/9ae7009faa837921ef6ed28e7b78f02a8e2f964e), October 2, 2026.
- First excluded solution: `49b3594ad30bcfc0a869758fe79ef0dfa9b92087`.
- Reference endpoint: [`4d73a988979b7b9c8f0135b5bc9b9c6976aab7c0`](https://github.com/yusing/skills-mgr/commit/4d73a988979b7b9c8f0135b5bc9b9c6976aab7c0), October 6, 2026.
- Cutoffs verified October 29, 2026: [`gpt-6-astra`](https://developers.openai.com/api/docs/models/gpt-6-astra)
  and [`gpt-6.1-sol`](https://developers.openai.com/api/docs/models/gpt-6.1-sol)
  both disclose April 30, 2026. This baseline is later than both cutoffs.
  Other models, including the Grok preset, need their own verified cutoff before
  describing their comparison as post-cutoff.

Preparation gives candidates only the baseline history. The reference commits,
ordered patches, and combined diff are frozen separately for judges under
`/reference`. They establish attainable behavior for the selected scope, not a
required architecture or exact patch. Equivalent designs and safe improvements
are acceptable.

| Commit | Upstream outcome | Criteria |
| --- | --- | --- |
| `49b3594` | Install root or nested repository skills and retain their source identity | `repository-install`, `remote-recovery` |
| `09c0929` | Recover missing remote content without losing identity or disrupting unrelated skills | `remote-recovery` |
| `469f294` | Explain installation, selection, serving, and storage | `compatibility-tests-docs` |
| `bec1d5c` | Accept repository-installed identities in the selection schema | `remote-recovery` |
| `c88ac60` | Explain what sync downloads | `compatibility-tests-docs` |
| `bc92a20` | Create manager state on the first global write | `layered-selection` |
| `3d70c7f` | Treat the user's home directory as the global layer | `layered-selection` |
| `8c4eedf` | Avoid immediately respawning failed background refreshes | `refresh-backoff` |
| `9ee73a1` | Support consistent serving and mutation transactions | `safe-edits`, `compatibility-tests-docs` |
| `3d287a1` | Add non-interactive inspection, checks, selection, and safe editing | `diagnostics`, `content-checks`, `layered-selection`, `safe-edits` |
| `5bc6b3d` | Document the agent-management workflow | `compatibility-tests-docs` |
| `4d73a98` | Distinguish resolved ownership from alternative candidates | `diagnostics` |

The reference's `repository_install_test.go`, `repository_cli_test.go`, and
`audit_remote_regression_test.go` establish installation, persistence, recovery,
and failure behavior. `agent_commands_test.go` covers management and rejected
mutations; `refresh_runner_test.go` covers retry behavior. Its README and
selection/remote-store specifications explain the intended reader contract.
Judges use these sources alongside the visible prompt, without adding unrelated
changes bundled into the commits as extra requirements.

## Workload and launch

The range spans 40 files with 3,726 additions and 625 deletions, including tests
and documentation. Installation, selection, cache recovery, serving, and editing
share state and ownership rules, requiring integration across existing modules.
This makes a stronger long-session candidate than an isolated command, but size
does not establish duration or compaction frequency.

In the workbench, select **Skills manager repository-to-agent workflow**. The
retained task ID is `skills-mgr-agent-cli`; new preparations use this expanded
task. Earlier runs retain their captured prompt and baseline and are a different
task, not repetitions of this one.

Build the CLI using the [build guide](../../doc/cli.md#prerequisites-and-build).
Supply a local skills-mgr checkout containing the baseline and reference history.
For model-free preparation:

```sh
CODEX_AB_SKILLS_MGR_SOURCE=/path/to/skills-mgr \
CODEX_AB_MEKUGI_SOURCE=/path/to/mekugi ./dist/codex-ab launch \
  --preset stock-mekugi --task skills-mgr-agent-cli --prepare-only
```

Replace `--prepare-only` with `--confirm-paid-inference` only to authorize a paid
candidate and judge run. The source defaults to `$HOME/projects/skills-mgr`; the
independent Mekugi runtime source defaults to `$HOME/projects/mekugi`. See
[comparison options](../../doc/spec.md#stock-codex-versus-stock-plus-mekugi) for
other presets and [portable task packs](../../doc/cli.md#portable-task-packs) for
direct manifest preparation.

Existing defaults remain a 7200-second candidate limit and `xhigh` reasoning
(`high` for the Grok preset). Explicit reasoning and timeout overrides remain
available. Compaction is Codex-owned; the time limit guarantees neither a long
run nor a compaction event. Record observed resets separately from workload intent.

## Validation and limits

Dependency preparation uses `go mod download`; the existing-test gate is
`go test . -count=1`. On October 29, 2026, both pinned snapshots passed that gate
using Go 1.27.3 on Linux; the module requires Go 1.26. Tests ran from archived
snapshots outside the source checkout. This establishes a usable baseline and
attainable reference behavior in that local environment.

No Docker or paid-inference run has qualified this replacement task. Adaptive
judge coverage, candidate duration, and compaction frequency remain unmeasured;
the manifest retains `qualification: "not-run"`. Upstream test passes do not
establish judge quality or a launcher advantage.
