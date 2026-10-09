# sqlite-utils multi-commit upgrade benchmark

This task compares minimal Codex with minimal Codex through Mekugi on a real
brownfield upgrade. Candidates reproduce the user-visible outcomes of **19
upstream commits**, spanning schema parsing, introspection, transform fidelity,
strict-table types, input handling, CLI fixes, tests, and documentation.
The [prompt](task.md) states outcomes without prescribing the reference
implementation. Equivalent designs and safe improvements are welcome;
reference limitations are permitted, not mandatory. The
[task pack](manifest.json) binds these outcomes to evaluation criteria.

## Baseline and reference provenance

Repository: [simonw/sqlite-utils](https://github.com/simonw/sqlite-utils).

- Baseline: [`6a456830ca33eb5edaa634a9b0febe5d71bea2be`](https://github.com/simonw/sqlite-utils/commit/6a456830ca33eb5edaa634a9b0febe5d71bea2be), July 25, 2026.
- Reference endpoint: [`e4935e064407bc995f77795c025c33cef52d742e`](https://github.com/simonw/sqlite-utils/commit/e4935e064407bc995f77795c025c33cef52d742e), August 13, 2026.
- First excluded solution commit: `f726ea4a65c3ce9eaff67057908ee8f2fe7f81e0`.
  Candidate clones contain only the baseline history, not these later commits.
- Model cutoffs checked October 9, 2026: [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra)
  and [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol)
  both disclose April 30, 2026. The baseline is later than both cutoffs.
  Check the cutoff again when selecting another model or a changed model snapshot.

The selected ancestry range contains these actual commits. The behavior column
maps them to the fixed criteria; test refactors and release-note aggregation do
not require an identical patch.

| Step | Commit | Upstream change | Criterion |
| --- | --- | --- | --- |
| 01 | `f726ea4` | Transform tables referenced by views | `views-and-transactions` |
| 02 | `3db0c57` | CHECK introspection and SQL parsing | `checks-and-parser` |
| 03 | `2303b80` | Preserve CHECK constraints through transforms | `check-transforms` |
| 04 | `b432e68` | Use sqlite_master for older SQLite compatibility | `checks-and-parser` |
| 05 | `b37b8cf` | Preserve column comments through transforms | `comments-and-indexes` |
| 06 | `2d3c6b9` | Quote FTS tokenizer arguments | `input-query-identifiers` |
| 07 | `43d5d33` | Offset without limit | `input-query-identifiers` |
| 08 | `38fe466` | Use explicit table/view access in tests | `tests-types-docs` |
| 09 | `ebb04a9` | Type-checking fixes | `tests-types-docs` |
| 10 | `25c632f` | Empty input handling | `input-query-identifiers` |
| 11 | `c5063f6` | Quote convert --dry-run identifiers | `input-query-identifiers` |
| 12 | `e6be626` | Quote indexes/xindexes identifiers | `input-query-identifiers` |
| 13 | `88b48fa` | Decode TRUE/FALSE/NULL defaults | `input-query-identifiers` |
| 14 | `e4784ec` | Changelog updates | `tests-types-docs` |
| 15 | `57192ef` | Preserve indexes on renamed columns | `comments-and-indexes` |
| 16 | `fcfccea` | ANY columns across API, CLI, transform and extract | `any-types-and-cli` |
| 17 | `2b52b5e` | Preserve AUTOINCREMENT and sequence state | `autoincrement-and-unique` |
| 18 | `75ba588` | Preserve composite UNIQUE constraints | `autoincrement-and-unique` |
| 19 | `e4935e0` | Empty TEXT becomes NULL on numeric transforms | `numeric-transforms` |

Candidates make one commit per numbered prompt outcome, in this order, with
subjects beginning `upgrade-01:` through `upgrade-19:`. The step column maps
each candidate commit to its reference commit for comparison. Tests and
documentation belong with the relevant change; the changelog step records
changes completed at that point. Candidate Git history remains in the retained
arm repositories. The generic judge evaluates the final tree, not individual
commits or commit correspondence.

Expected outcomes come from these commits' implementation, regression tests,
and documentation, not additional synthetic restrictions. There is no blanket
ban on new SQL or metadata reads. Existing tests may change when the upstream
behavior changes, while unaffected coverage must remain meaningful.

## Why this is a long-session task

The reference range adds an approximately 900-line schema parser and changes
the large database and CLI modules. Its net diff covers 58 files, with 4,195
added and 1,383 removed lines, including extensive parser, transform, API and
CLI tests and reader documentation. Implementing the interacting behaviors
requires sustained source inspection, integration, and validation rather than
one isolated feature.

This workload is intended to give journal reset an opportunity to occur. Size
does not guarantee a reset, and no new candidate run has yet measured its
duration, context growth, or reset frequency.

## Launch and environment

Open the workbench from the main [README](../../README.md#launch-and-watch-in-the-web-ui)
and select **sqlite-utils multi-commit upgrade**. The retained task identifier
is `sqlite-utils-history`; this preserves CLI and historical evidence references,
but new preparations use this upstream upgrade instead of the former synthetic
row-history prompt. Existing run snapshots remain unchanged and are not
comparable as repetitions of the new task.

The default source checkout is `codex-ab-sqlite-utils-source` in the system
temporary directory, or `CODEX_AB_SQLITE_UTILS_SOURCE` when set. Preparation
clones a missing checkout and verifies the baseline and excluded solution
commit. **Check inputs** does not clone or start inference.

```sh
./dist/codex-ab launch --task sqlite-utils-history --prepare-only
./dist/codex-ab launch --task sqlite-utils-history --confirm-paid-inference
```

Defaults remain minimal Codex versus minimal Mekugi, auto journal compaction,
xhigh reasoning, a shared 200,000-token auto-compact limit, and a 55-minute
maximum per candidate. Preparation and judges have separate budgets. Optional
model, reasoning, timeout, and compaction overrides remain available. Keep the
recorded Mekugi executable unchanged while a run uses it.

Pinned Python runtime and development dependencies are installed into
`/opt/codex-ab-deps/python`. Candidate and offline evaluator work has no package
network access. The judges adapt checks to each candidate without access to
the reference implementation; the provenance range supports task authoring
and reference validation, not a candidate shortcut.

## Validation and interpretation

Run the full candidate suite and the repository's quality and cog checks, then
inspect both blind passes' criterion evidence and disagreements. A successful
baseline suite establishes the starting environment. A successful reference
suite establishes attainable upstream behavior under that environment; it
does not prove judge quality or a treatment advantage.

On October 9, 2026, both the baseline and reference full suites passed offline
using the pinned Python dependency environment from the earlier run. The
reference had **1,488 passed and 16 skipped** tests and passed black, flake8,
mypy, and cog checks. Sources were mounted read-only, Docker networking was
disabled, and validation made no model requests. The skipped tests required
optional environment capabilities. The manifest's `qualification: not-run`
describes the adaptive-judge contract's lack of a prequalified hidden oracle;
these upstream reference checks do not change that claim.

For a **post-journal-reset** claim, establish a successful root reset in the
retained Mekugi exports followed by continued root work. Flags, journal
writes, child resets, or task size do not establish that sequence. Report zero
observed resets and unavailable telemetry separately. Keep such runs in the
general setup comparison, without describing them as post-reset evidence.
This whole-launcher comparison does not isolate journal reset's causal effect.
