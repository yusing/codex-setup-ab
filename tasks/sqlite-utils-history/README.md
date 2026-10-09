# sqlite-utils row history benchmark

This task compares stock Codex with minimally configured Codex through Mekugi,
with journal context reset enabled, on a long brownfield change. Candidates add
opt-in, trigger-based row history to [sqlite-utils](https://github.com/simonw/sqlite-utils)
at upstream commit `85b1be10c81d9dd3567e36faf8dd411e4a8789bd`. The
[candidate prompt](task.md) fixes the API and CLI names, the history model, and
project rules; the [task pack](manifest.json) binds its exact bytes to the
criteria. The implementation design remains open.

## Why this task

Two pilot pairs of an earlier greenfield Booking Ledger task finished in 13 to 17
minutes with 11 to 14 model requests and context peaking between 50,000 and
73,000 tokens. The agents wrote whole applications in a few large patches and
observed little, so a larger greenfield specification only added output.

This task makes observation necessary. History must survive `transform()`,
`extract()`, `add_column()`, `rename_table()`, `drop()`, and `duplicate()`, and
coexist with cached counts and full-text search triggers. These live in
`sqlite_utils/db.py` (about 5,500 lines) and `sqlite_utils/cli.py` (about 3,800
lines). Documentation changes land in the large `docs/python-api.rst` and
`docs/cli.rst`, with cog-generated CLI reference content. The project rules
(compatibility, quality gates, documentation, changelog, identifier quoting,
atomicity, CLI conventions, and tests) apply to every part, including parts
usually done last. That makes requirement drift after a context reset visible.
Its context growth has not been measured.

## Launch in the Web UI

Open the workbench described in the main [README](../../README.md#launch-and-watch-in-the-web-ui)
and select **sqlite-utils row history**. The default source checkout is
`codex-ab-sqlite-utils-source` in the system temporary directory, or
`CODEX_AB_SQLITE_UTILS_SOURCE` when set. A missing checkout is cloned from the
upstream repository when preparation starts; an existing checkout must contain
the base commit. Preparation checks that the arm clones lack the following
upstream commit, which serves as the excluded-history sentinel. **Check inputs**
does not clone or start inference.

The task selects minimal Codex versus minimal Mekugi with auto journal compaction.
Its defaults are xhigh reasoning, a 3300-second limit for each agent, and a shared
200,000-token auto-compact limit for both agents. Comparison and runtime overrides
remain available. Choose preparation only, or give fresh paid-inference consent.

Dependency preparation installs pinned runtime and development packages,
including pytest, hypothesis, cog, black, flake8, and mypy, into
`/opt/codex-ab-deps/python`. Agents have no package network access and use that
environment, as the prompt states.

## Agent-directed launch

```sh
./dist/codex-ab launch --task sqlite-utils-history --prepare-only
./dist/codex-ab launch --task sqlite-utils-history --confirm-paid-inference
```

The first command clones the source if needed and prepares a pair without
inference. The second starts paid inference for both agents and the two blind
semantic assessments. Each agent has a **55-minute maximum**, strictly below
60 minutes. Preparation, preflight, and judges have separate budgets. Keep model,
effort, launcher identity, reset mode, and schedule fixed within a comparison, and
use the existing [trial workflow](../../doc/cli.md#repeat-a-pinned-comparison) for
repetitions.

Keep the Mekugi executable recorded at preparation unchanged until the run
finishes. Finishing re-verifies it before judging, and a rebuilt executable stops
the judges.

## Assess the outcome

The predetermined existing-test gate runs every test file present at the base
commit; it shows compatibility, not that the feature works. The judges run the
candidate's tests, the quality gates, and adaptive API and CLI checks against the
fixed criteria. Inspect each pass's per-criterion decisions, executed evidence,
and disagreements before using an aggregate winner. Record:

- **Quality:** coherent use of existing helpers, readable trigger generation,
  docstrings and type hints, and tests that can detect product failures.
- **Correctness:** recorded ops and versions, no-op and rowid-changing updates,
  replace behavior, BLOB encoding, reconcile, restore, prune, schema-change
  integration, odd identifiers, and atomic failures.
- **Completeness:** every API member, CLI command and option, documentation
  section, changelog entry, regenerated cog output, and test file.
- **Drift:** a project rule or history requirement contradicted or omitted in
  code, CLI behavior, tests, or documentation. Tie each finding to that
  requirement; distinguish a missing part from an incorrect one.

## Qualify journal reset evidence

`auto` resets the journal when Codex requests compaction. The shared
200,000-token limit makes both agents compact at the same context size: stock
Codex uses provider compaction and Mekugi uses journal reset. A session that stays
below the limit produces no reset, and the limit does not guarantee slice
continuation. Retain validated Mekugi capture, journal and compaction evidence,
and the request timeline. To call a result a **post-journal-reset** observation,
establish a successful root reset from journal evidence followed by continued root
work on this change. A flag, journal write, child reset, provider-authored
compaction, or counter alone does not prove that sequence. Use the timeline to
locate later edits and check them against the project rules.

Report no observed reset and unavailable reset evidence separately. Keep these
runs in the general stock-versus-Mekugi comparison, but do not treat them as
post-reset evidence. Do not discard timed-out or incomplete candidates; retain
their partial work and distinguish product gaps from infrastructure failures.
This comparison changes the whole launcher and tool treatment, so it cannot
isolate the causal effect of journal reset.

Qualification remains `not-run`: structural checks do not establish live reset
behavior, completion time, judge quality, or a treatment advantage.
