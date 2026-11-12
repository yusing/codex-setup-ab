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
| `3d287a1` | Add non-interactive inspection, checks, selection, and safe editing | `diagnostics`, `content-checks`, `content-resources`, `layered-selection`, `safe-edits`, `remote-edit-rejection`, `remote-edit-success` |
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

## Acceptance boundaries

The visible task and criterion descriptions fix the same observable outcomes for
every evaluator. The new noninteractive remote replacement rejects identity and
invocation-policy edits before publication, including when a valid patch already
exists. Effective metadata normalization is not rejection. The separate existing
interactive editor retains its own contract. Valid served Markdown horizontal
rules and reference checks work through supported manifest aliases. GitHub refs
containing slashes use percent-encoded slashes; automatic resolution of unencoded
branch boundaries is not required. These distinctions come from the pinned
reference tests, not candidate-authored expectations.

Changed task/criteria hashes require fresh implementation trials. Older scores
remain evidence for their captured task and oracle, not repetitions under this
clarified contract.

## Validation and limits

Dependency preparation uses `go mod download`; the existing-test gate is
`go test . -count=1`. On October 29, 2026, both pinned snapshots passed that gate
using Go 1.27.3 on Linux; the module requires Go 1.26. Tests ran from archived
snapshots outside the source checkout. This establishes a usable baseline and
attainable reference behavior in that local environment.

The manifest freezes independent observations for retained local behavior before
implementation: `get` body/frontmatter stripping, a line range, reference reading,
XML listing metadata and references, disabled-selection rejection with empty
stdout, and checking that reads never execute the skill script. The supervisor
compares the actual JSON observation with its private expected value. This is a
scoped existing-behavior gate, not attestation of every test in the original
`go test . -count=1` suite. That command remains a separate diagnostic.

Every criterion has four frozen control roles: the pinned upstream reference,
the unchanged baseline with its declared outcome, a precise hashed source mutant,
and a valid equivalent source alternative. Remote protected-field rejection has
two independent mutants so accepting a name change and accepting an invocation
policy change cannot mask one another. The alternatives retain the pinned
reference behavior while using equivalent guards, value construction, rollback
error handling, or help wording. They are source variants, not independent full
solutions. Reference and baseline commits, the prompt, and criterion promises are
unchanged.

The model-free regression executes these controls through the normal offline
semantic supervisor. Its evaluator-only observers record actual command output,
served content, persisted state, and resource side effects, rather than treating
a test runner's exit code or printed count as proof. Failed background refresh
uses a package-local adapter to record the real failed refresh cycle and retry
eligibility; its expected values still live outside the Go child.

| Criterion | Executed observation and targeted regression |
| --- | --- |
| `repository-install` | Install an encoded slash-ref nested skill, read its resources/mode, reject invalid input without a selection change; drop the persisted explicit ref/path. |
| `remote-recovery` | Restore an evicted generation with its accepted patch and selection; preserve patch/selection on a later fetch failure; incorrectly treat an evicted generation as fresh. |
| `diagnostics` | Compare resolved and disabled owner reports with serving, selection layer, and body health; omit the resolved owner. |
| `content-checks` | Leading Markdown horizontal rule and empty bodies under both invocation policies through all four manifest aliases; incorrectly reparse served Markdown. |
| `content-resources` | Empty references, missing explicit targets, continued script-file reads without execution under both policies and all aliases; omit alias reference expansion. |
| `layered-selection` | Global/project selection, a condition, inheritance, and home-directory global routing; reject `inherit` rather than restoring the global selection. |
| `safe-edits` | Stale/empty rejection, deterministic publication obstruction with rollback, file replacement/rename, mode and placeholder retention; omit manifest rollback. |
| `remote-edit-rejection` | Separately reject protected name/policy edits, empty bodies, and stale guards after an accepted patch, retaining fetched bytes, patch, selection, and serving; independently allow each protected edit. |
| `remote-edit-success` | Serve an accepted local patch without changing fetched bytes and report its health/identity/policy; save original bytes instead of the replacement. |
| `refresh-backoff` | Observe failure logging, immediate retry suppression, and later retry eligibility; fail to persist cycle completion. |
| `compatibility-tests-docs` | Install, edit, check, disable/re-enable, sync, and serve the local patch, alongside retained serving/script execution and help advertising `run`/`sync`; remove the documented `run` entry. |

The unchanged baseline fails each criterion observation, including the connected
compatibility workflow and failed-refresh backoff. It passes the separate
retained-serving gate. These outcomes come from the pinned source behavior, not an assumption
that every baseline must fail.

Run the model-free regression with an offline image containing the task's pinned
Go modules and compiler cache, readable by the executor's unprivileged child:

```sh
CODEX_AB_QUALIFY_SKILLS_MGR_AGENT_CLI=1 \
CODEX_AB_SKILLS_MGR_SOURCE=/path/to/skills-mgr \
CODEX_AB_QUALIFICATION_IMAGE=sha256:IMAGE_ID \
bun test skills-mgr-agent-cli-qualification.live.test.ts
```

A successful run compares 49 supervisor records: retained observations on both
snapshots, 45 criterion/control observations, and two observer-isolation controls.
Evaluator-only Python observers use isolated interpreter mode so candidate-owned
standard-library shadows cannot forge their output. The isolation regression
reproduces the old import bypass with a forged JSON result and missing Go
entrypoint, then verifies that the corrected observer rejects it. No model credentials or inference
are used. The observers and source variants are evaluator-only and are not a
hidden candidate oracle. The encoded-ref fixture uses a temporary local Git
repository with URL rewriting, never the network during checks.

This establishes sensitivity only for the listed scenarios and source variants.
The full installation address matrix, native fallback alternatives, every trust
boundary, interactive-editor behavior, comprehensive documentation/test quality,
and adaptive judge quality are not certified by these observations. In particular,
the compatibility criterion retains its full requirement; its small executed
scenario does not certify the entire Go suite or reader documentation. Candidate
duration, compaction frequency, and launcher advantage remain unmeasured. The
manifest retains `qualification: "not-run"` because this regression does not
prequalify a future adaptive judge's candidate-specific checks.

Prepare fresh runs to capture the migrated contract. Older retained preparations
keep their original criteria and observations and cannot acquire the new controls
from an in-place manifest edit. Changed source pins require requalification.
