# Skills manager remote uninstall

Reproduce one actual skills-mgr change: a non-interactive `uninstall` command for
remote skills that also serves as the recovery path for broken installations.
The [prompt](task.md) fixes the command name and leaves output wording and design
open. The [manifest](manifest.json) binds the outcomes to behavioral criteria.

## Baseline and reference

Repository: [yusing/skills-mgr](https://github.com/yusing/skills-mgr).

- Baseline: [`3d3d1f5`](https://github.com/yusing/skills-mgr/commit/3d3d1f565a19e181f22c90e5899729de0e928eda), November 11, 2026.
- Excluded solution and reference endpoint: [`d129bb0`](https://github.com/yusing/skills-mgr/commit/d129bb05c4b2e6b1a3c004f2ab1898deadec0b60), November 11, 2026.
- Both are later than the April 30, 2026 cutoffs verified for `gpt-6-astra` and
  `gpt-6.1-sol` (see [commit-backed task provenance](../../doc/cli.md#commit-backed-task-provenance)).

| Criterion | Reference evidence |
| --- | --- |
| `uninstall-removal` | `TestAgentUninstall` enabled/global cases; the install/uninstall round trip in `repository_cli_test.go` |
| `recovery-states` | `TestAgentUninstall` disabled, condition, missing, override, and override-directory cases |
| `ownership-rejections` | `TestAgentUninstall` shadowed and canceled cases, `TestAgentNativeOnlyCannotBeManaged`, `TestAgentCommandRejectsInvalidArguments` |
| `scope-and-guidance` | `TestAgentUninstall` global, home, global-rejected, and other-project assertions; the changed refusal messages |
| `consumers-tests-docs` | `TestHelpCommand`, `TestFishCompletions`, README command table and uninstall paragraph |

The reference adapts the existing interactive removal transaction instead of adding
a second one, and resolves remote metadata without reading content overrides so that
broken installations stay removable. Judges treat a duplicated removal path as a
simplicity and approach concern, not as a criterion failure by itself. Retaining or
deleting the fetched content generation is not a criterion.

## What it exercises

The change is small but touches every consumer of a command: dispatch, scope
selection, help, shell completion, documentation, and the shared removal
transaction. It checks that a recovery path tolerates broken state, that ownership
failures are rejections rather than deletions, and that unchanged commands keep
their behavior. See the [regression coverage map](../../doc/regression-coverage.md).

The unchanged baseline test suite passes against the reference, so the manifest
declares [retained baseline tests](../../doc/contract.md#task-derived-semantic-grading).

## Launch

Select **Skills manager remote uninstall** (task ID `skills-mgr-remote-uninstall`).
The source defaults to `$HOME/projects/skills-mgr`, or set
`CODEX_AB_SKILLS_MGR_SOURCE`. The checkout must contain the reference commit.
