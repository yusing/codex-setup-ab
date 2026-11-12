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
arm repositories. The judge evaluates the final tree using the frozen upstream
commit patches and combined diff, not individual candidate commits or commit
correspondence.

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

This workload is intended to exercise sustained context use and Codex-owned
compaction. Size does not guarantee compaction, and no new candidate run has
yet measured its duration, context growth, or compaction frequency.

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

Defaults remain minimal Codex versus minimal Mekugi,
xhigh reasoning, a shared 200,000-token auto-compact limit, and a 55-minute
maximum per candidate. Preparation and judges have separate budgets. Optional
model, reasoning, timeout, and compaction overrides remain available. Keep the
recorded Mekugi executable unchanged while a run uses it.

Pinned Python runtime and development dependencies are installed into
`/opt/task-deps/python`. Candidate and offline evaluator work has no package
network access. Preparation freezes all 19 upstream commit patches and the
combined diff in evaluator-only storage. Both judge stages inspect that
read-only reference to ground checks and final assessments in actual upstream
behavior. Equivalent implementations and safe improvements remain acceptable.
Implementation agents never receive the reference; no live upstream checkout
or network lookup is needed during judging.

## Validation and interpretation

Run the full candidate suite and the repository's quality and cog checks, then
inspect both blind passes' criterion evidence and disagreements. A successful
baseline suite establishes the starting environment. A successful reference
suite establishes attainable upstream behavior under that environment; it
does not prove judge quality or a treatment advantage.

The frozen existing-behavior gate observes actual API insert/update/read,
atomic rollback, a foreign-key-protected transform and restored foreign-key
setting, JSON/CSV/TSV input, and CLI row output. The supervisor compares the
returned row and setting values independently. This is a scoped retained-behavior
gate, not an assertion that the entire pytest suite passed. The original full
suite command remains a separate diagnostic.

Every criterion has the actual pinned upstream reference, the unchanged baseline,
a targeted incorrect source mutation, and a valid alternative source change.
All mutations are small frozen patches with checked preimage and postimage hashes.
The baseline is expected to fail each feature probe, while both baseline and
reference pass the retained-behavior gate. The alternative controls use equivalent
implementations, not a requirement to reproduce upstream syntax.

The model-free observations and their controls have this scope:

| Criterion | Observed behavior | Targeted negative | Valid alternative |
| --- | --- | --- | --- |
| `views-and-transactions` | Live view rows with and without backups; both initial legacy-alter settings restored | Disable legacy-alter mode during swap | Equivalent previous-setting predicate |
| `checks-and-parser` | Named, quoted and commented CHECK expressions, literal choices including empty choices, owning columns and source spans | Omit introspected checks | Independently construct grouped column checks |
| `check-transforms` | Enforce renamed checks; reject a dependent drop without changing schema/rows; remove an owned check on drop | Omit checks during recreation | Equivalent owned-column drop predicate |
| `comments-and-indexes` | Move comments on rename/reorder; retain unique, NOCASE, descending index behavior | Lose column comments | Equivalent renamed-comment lookup; double-quoted, bracketed, backtick and unquoted identifiers |
| `autoincrement-and-unique` | Deleted high-water ID is not reused; retain named composite UNIQUE, NOCASE, descending order and IGNORE conflict behavior; drop a constituent | Lose sequence high-water restoration | Equivalent SQL sequence maximum |
| `any-types-and-cli` | API create/add/introspect/transform/extract; STRICT numeric-looking text and ordinary affinity; CLI create/add/transform | Misclassify ANY affinity | Equivalent ANY type dispatch |
| `numeric-transforms` | API INTEGER/FLOAT/REAL and CLI INTEGER conversions; exact empty strings, whitespace, NULL and untouched text | Copy empty strings without NULL conversion | CASE expression instead of NULLIF |
| `input-query-identifiers` | Row/search/CLI offset, blank input, safe and valid tokenizer values, quoted index rename, boolean/NULL defaults and bracketed dry-run identifiers | Leave TRUE defaults as text | Independent boolean default dispatch |
| `tests-types-docs` | API/CLI topic smoke checks, a readable nonempty changelog artifact, automatic reference directives, exported ANY and Table runtime interfaces | Remove the required changelog artifact | Equivalent API wording; generic marker wording that still describes ANY behavior |
| `integrated-upgrade` | STRICT ANY with CHECK/UNIQUE, numeric conversion, deleted high-water ID, a live view and backup, then extraction | Lose UNIQUE during recreation | Equivalent CASE-based numeric copying |

These expectations derive from the numbered prompt outcomes and corresponding
pinned commits in the provenance table. In particular, the tests/types/docs probe
does **not** certify complete documentation, changelog topic completeness, type checking, meaningful test
coverage, or all configured checks. Older SQLite compatibility, additional parser
syntax and unsupported-transform protections also require adaptive checks and
source review beyond these model-free examples. The full criteria remain binding.

To repeat the offline supervisor and qualification test, supply the pinned source
checkout and an image containing the manifest's pinned Python dependencies:

```sh
CODEX_AB_LIVE_DOCKER=1 CODEX_AB_SQLITE_UTILS_SOURCE=/path/to/sqlite-utils \
  CODEX_AB_VERIFIER_IMAGE=your-prepared-image \
  bun test sqlite-qualification.live.test.ts
```

The test makes no model requests. It executes ten feature probes against all four
control roles, including additional valid wording and identifier-quoting neighbors,
plus retained-behavior observations on baseline and reference,
through the normal offline supervisor and qualification executor. A skipped live
test does not establish runtime coverage. Fresh preparation freezes this contract;
older retained runs do not acquire these observations or controls retroactively.

On October 9, 2026, both the baseline and reference full suites passed offline
using the pinned Python dependency environment from the earlier run. The
reference had **1,488 passed and 16 skipped** tests and passed black, flake8,
mypy, and cog checks. Sources were mounted read-only, Docker networking was
disabled, and validation made no model requests. The skipped tests required
optional environment capabilities. The manifest's `qualification: not-run`
does not prequalify newly authored adaptive checks. Each such check must qualify
against the frozen controls; upstream suite results alone do not qualify it.

Historical post-journal-reset claims require retained evidence of a successful
root reset followed by continued root work. Task size and flags alone do not
establish that sequence. Current Mekugi runs have no journal-reset treatment;
this whole-launcher comparison does not isolate compaction's causal effect.
