# Skills manager fast conditional acquisition

Reproduce one actual skills-mgr performance fix: `get` and `run` stop walking the
whole project when a skill's selection is a single known language or tooling query,
while every other selection expression keeps its exact behavior. The
[prompt](task.md) states the measured problem and constraints; the
[manifest](manifest.json) binds the outcomes to behavioral criteria.

## Baseline and reference

Repository: [yusing/skills-mgr](https://github.com/yusing/skills-mgr).

- Baseline: [`3412ced`](https://github.com/yusing/skills-mgr/commit/3412cedfbfc15973b76803dd8754b71bba345391), November 5, 2026.
- Excluded solution and reference endpoint: [`3d3d1f5`](https://github.com/yusing/skills-mgr/commit/3d3d1f565a19e181f22c90e5899729de0e928eda), November 11, 2026.
- Both are later than the April 30, 2026 cutoffs verified for `gpt-6-astra` and
  `gpt-6.1-sol` (see [commit-backed task provenance](../../doc/cli.md#commit-backed-task-provenance)).

| Criterion | Reference evidence |
| --- | --- |
| `single-query-fast-path` | `TestAcquisitionShortCircuitsSingleEvidenceQuery`; the upstream measurement fell from 7.27-8.29 to 0.38-0.44 seconds for nine reads with identical output |
| `expression-semantics` | `TestAcquisitionKeepsCompleteEvidenceForOtherExpressions`, including glob-like arguments that undergo pathname expansion |
| `shared-consumers` | `TestAcquisitionSingleEvidenceQuerySeesNestedEvidenceAndEdits`, the cancellation case, and unchanged `list` evaluation |
| `no-persistent-cache` | The commit's stated constraint and its in-memory, per-acquisition design |
| `tests` | The added regression file distinguishes the fast path from expressions that must still scan completely |

## What it exercises

The fix is a behavior-preserving optimization at a shared evaluator. It checks
that an optimization keeps caller-specific semantics (single acquisitions versus
shared list evaluation, literal versus expandable words), avoids speculative
durable state, and is backed by discriminating tests. See the
[regression coverage map](../../doc/regression-coverage.md).

The unchanged baseline test suite passes against the reference, so the manifest
declares [retained baseline tests](../../doc/contract.md#task-derived-semantic-grading).

## Frozen observations and model-free checks

The existing-behavior gate independently compares real `get`, script execution,
line-range reading, missing/nested evidence, and `list` observations. The original
Go suite remains a separate diagnostic, not proof that this observation gate
completed or that the whole suite was independently verified.

Evaluator-only controls start from the pinned reference or baseline. Targeted
source mutations restore a full acquisition walk, incorrectly optimize a wildcard,
drop cancellation, or write a durable evidence file; a separate control removes
the reference regression tests. A valid alternative bounds traversal workers at
eight instead of thirty-two without changing the requested behavior. Precise
patches bind both their preimage and postimage hashes.

The model-free regression runs all five criterion checks through the ordinary
offline supervisor and qualification path:

```sh
CODEX_AB_LIVE_DOCKER=1 CODEX_AB_SKILLS_MGR_SOURCE=/path/to/skills-mgr \
  CODEX_AB_SKILLS_VERIFIER_IMAGE=codex-ab:skills-mgr-migration-offline \
  bun test skills-other-qualification.live.test.ts
```

Prepare the dependency image with the pinned Go modules available offline.
The checks exercise four root-evidence queries, eight other expressions,
nested/ignored evidence and edits, cancellation, shared list evaluation, and
task-local file snapshots. The tests criterion additionally requires named Go
test failures against full-walk and wildcard mutations. These observations do
not establish absence of every possible filesystem write or comprehensive test
quality; adaptive checks must still assess the complete requested scope.

## Launch

Select **Skills manager fast conditional acquisition** (task ID
`skills-mgr-get-short-circuit`). The source defaults to `$HOME/projects/skills-mgr`,
or set `CODEX_AB_SKILLS_MGR_SOURCE`. The checkout must contain the reference commit.
