# Specification

[README](../README.md) · [Contract](contract.md) · [CLI guide](cli.md)

## Purpose and scope

`codex-ab` compares coding-agent setups on the same pinned repository task. It holds
declared controls fixed, captures implementations independently, evaluates observable
task behavior, and reports quality, time, tokens, and estimated cost. Results are
descriptive: neither one pair nor repeated trials establish causality or generalization.
Unknown measurements stay unknown.

The [contract](contract.md) owns isolation, schemas, scoring, accounting, and failure
behavior. The [CLI guide](cli.md) owns operational recipes; task READMEs own source
provenance, criteria, and qualification limits.

## Comparisons

Presets initialize controls; explicit per-arm settings may vary model, reasoning effort,
resources, Mekugi behavior, parallel-work instructions, and setup-skill selection.

| Selector | Guidance and launcher treatment |
| --- | --- |
| `stock-current` | Minimal direct Codex versus the audited tracked current-home setup, using Codex or Mekugi. |
| `stock-mekugi` | Minimal direct Codex versus minimal Codex through Mekugi, with identical configured tool access. |
| `same-setup` | Direct Codex versus Mekugi with the same immutable current-home guidance and tools. |
| `setup-commits` | Two committed setup revisions with shared pinned binaries and the same launcher. |
| `custom` | Two or more independently selected Codex/Mekugi arms with Stock, committed, or tracked-worktree guidance. |
| `duplicate-output` | The same Mekugi setup with duplicate-output projection off versus on. |
| `codex-mekugi-grok` | Minimal Codex through Mekugi on Grok versus the Grok CLI, without the current-home tool store. |

Imported arms retain their original implementations, measurements, and setup identities.
By default (`--evaluation-mode reuse`), fresh candidates adapt a selected imported arm's
tests while preserving imported grades and assessments; `fresh` regrades every patch.
Mixed or incomplete rubrics remain visible without a combined ranking. Results-only
reevaluation creates new evidence for all captured arms without rerunning
implementations or altering the source run. See [imports](cli.md#import-previous-arms)
and [reevaluation](cli.md#reevaluate-retained-implementations).

### Workbench experience

- **Layout and identity**: The Web UI prepares, launches, watches, and inspects
  comparisons. Arm tabs own candidate settings; task and host infrastructure are shared.
  **Compare against HEAD** builds an editable draft with all completed source arms plus
  one fresh `HEAD` arm (inference consent reset). Suite preparation uses the CLI.
- **Labels and accessibility**: Display names describe launchers and setups rather than
  storage keys; source assessments resolve anonymous candidates via each pass's
  presentation mapping (missing mappings appear unavailable). Stored IDs stay unchanged.
  Forms and results adapt to narrow screens with visible keyboard focus, and fonts are
  served locally (including in the compiled binary).
- **Results hierarchy**: Views lead with the outcome, measurements, differences,
  criterion decisions, and concise source-assessment explanations. Correctness and
  simplicity carry equal top priority, followed by completeness, implementation
  performance, maintainability, approach, and test quality. Agent command time is not
  implementation performance; missing historical dimensions remain unassessed. Full
  judge evidence is expandable, and token breakdowns, pricing, execution evidence, and
  diagnostics live in the optional technical report and downloads. Pending or
  infrastructure-unassessed grades are not graded; a failed grade requires an assessed
  failure.
- **Streaming safety**: Preparation shows progress without placeholder result columns,
  and failures retain status and logs. Codex/Mekugi messages render safe Markdown; tool
  events show short status text instead of raw transport JSON, and incomplete records
  wait for completion. Embedded HTML stays text, unsafe links are inactive, images make
  no network requests, and build output stays plain text. Live updates preserve open
  panels and follow-scroll, falling back to periodic refresh if file watchers cannot be
  allocated.

## Stock Codex versus stock plus Mekugi

Choose **Minimal Codex versus minimal Mekugi** in the UI, or run:

```sh
./dist/codex-ab launch --preset stock-mekugi --task skills-mgr-agent-cli --confirm-paid-inference
```

Both arms use minimal generated guidance, the default service tier, and the same
read-only mise installation store and configuration. Arm A launches Codex through mise;
Arm B launches the pinned Mekugi pair through mise. Neither receives current-home
instructions, skills, hooks, roles, or reviewer overlays. Preparation neither installs
tools nor copies the tool store; keep mounted host tools unchanged, as preflight
requires offline availability. Protected runtime is unsupported here.

### Task catalog, models, and defaults

The [launch catalog](../launch.ts) owns task choices and defaults:

- **Tasks**: Omitting `--task` selects NVM (`nvm-download-no-eval`). Built-in tasks
  include NVM, Gin, Flask, Express, three skills-manager packs (each using a 2-hour
  agent timeout), sqlite-utils, and
  [Mekugi native source tools](../tasks/mekugi-source-tools/README.md)
  (`mekugi-source-tools`, 1-hour timeout), plus `custom` for a custom pack or
  explicit inputs. Use bare Codex for the Mekugi task; launcher comparisons
  require a separate project.
- **Source environment overrides**:
  - `CODEX_AB_SOURCE_DIR`: NVM checkout (default `/var/tmp/codex-ab-nvm-source`)
  - `CODEX_AB_SKILLS_MGR_SOURCE`: skills-manager checkout (default `$HOME/projects/skills-mgr`)
  - `CODEX_AB_MEKUGI_SOURCE`: Mekugi monorepo checkout for the native tools task
    and launcher comparisons (default `$HOME/projects/mekugi`)
  - `CODEX_AB_SQLITE_UTILS_SOURCE`: sqlite-utils checkout (default `/var/tmp/codex-ab-sqlite-utils-source`)
- **Models**: `gpt-6-astra` (default), `gpt-6.1-sol`, `gpt-6.1-terra`, `gpt-6.2-astra`,
  and `gpt-6.2-sol`.
- **Reasoning effort**: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and
  `ultra` (usability depends on provider/model support). Defaults are `medium` for NVM,
  Gin, Flask, and Express; `xhigh` for skills-manager, sqlite-utils, and
  `mekugi-source-tools`; and `high` for `codex-mekugi-grok`. Override with
  `--reasoning-effort`.
- **Compaction and parallel work**: `stock-mekugi` accepts a shared
  `--auto-compact-limit N` (other comparisons reject the shared option); compaction
  remains Codex-owned, and neither workload size nor compaction settings prove a reset.
  **Parallel work** (`--parallel-work`, off by default) appends neutral delegation,
  coordination, integration, and validation instructions to the candidate prompt without
  altering trial scheduling or host guidance. Mentor options are unsupported; saved
  mentor runs remain readable only via their existing reports.

## Stock Codex plus Mekugi versus Grok CLI

`codex-mekugi-grok` compares Mekugi routing to `grok:grok-4.7` with headless Grok CLI
on `grok-4.7`. Both arms use minimal generated configuration, default service tier, and
`high` reasoning unless overridden, without current-home guidance or tools. Supply
`--grok-bin` and a private `--grok-auth-file` for both homes.
This comparison requires a Mekugi build with built-in Grok OAuth routing. Recent
Mekugi versions require a custom Responses profile for third-party providers;
that route is not equivalent to this comparison and preflight rejects it.

Grok's session `usage.json` supplies Arm B accounting; Codex JSONL supplies Arm A
accounting. Grok session estimates use base rates and exclude unknown request-level
long-context premiums, retaining provider totals separately. Matched events supply
command timing. This is not a current-home direct-Codex comparison.

## Historical journal compaction evidence

New journal comparisons and recovery flags are unsupported. Retained runs remain
reportable with their original controls, evidence, and exclusions. Prepare a fresh
supported comparison for the current Mekugi interface.

## Duplicate-output comparison

`duplicate-output` requires a Mekugi build with the deduplication switch. It sets
`--deduplicate-output=false` on Arm A and `true` on Arm B. Both arms share the same
pinned Mekugi binary, immutable current-home setup, task, model, reasoning, service
tier, tools, and ordinary container boundary (a reviewer overlay applies equally to
both).

Absolute source-home paths resolve to each arm's isolated home, not the host home, and
tool-store mounts stay read-only. Preflight checks both flag values and export paths in
a disposable home. Combining `duplicate-output` with deduplication in `--mekugi-flags`,
protected runtime, or imported direct-Codex controls is rejected. Missing or invalid
exports prevent complete paired measurement. Outside this comparison, builds with the
switch default to enabled and accept `--mekugi-flags '["--deduplicate-output=false"]'`
to disable it; standard Codex comparisons using the newer native Mekugi runtime can
leave deduplication enabled but cannot disable it.

## Current setup: direct Codex versus Mekugi

`same-setup` gives both arms separate writable copies of one immutable current-home
snapshot with identical tools and controls. Arm A launches direct Codex; Arm B uses
Mekugi's admitted headless adapter and server-owned Thread Control. Reviewer overlays
apply equally. The default `stock-current` treatment is unchanged.

`--mekugi-bin` selects a complete [installed host runtime](cli.md#installed-mekugi-runtime)
that is frozen and hash-pinned into the image without compiling Mekugi or Rust.
`--mekugi-source` selects export validation, not source-to-binary provenance; the runner
bundles and hashes the analyzer rather than reading validation scripts from the live
checkout.

- **Allowed `--mekugi-flags`**: child-reply summaries and `--debug`.
  Shell guarding, router response and stream idle timeouts, and
  deduplication overrides require a build offering the relevant switch.
  Unchecking a UI toggle requests an explicit opt-out, which preflight rejects
  if the pinned launcher cannot honor it.
- **Retained ANSI styling**: Older runs may record `--ansi-faint`. Headless
  launches ignore it, and new configurations do not accept it.
- **Rejected flags**: mode, journal, recovery, mentor, explore-filter, and `--grok`
  flags (comparison selection owns routing; export destinations, credentials, and
  runtime configuration are benchmark-owned). Settings never rewrite the host.
- **Captures and usage**: Per-runtime sanitized captures and metrics form a retained
  family envelope (older single-runtime and optional native reports remain readable).
  Each runtime is validated before family accounting; local sequence numbers are not a
  global order. Valid provider attempts supply Mekugi usage (including retries and tool
  re-sends, excluding prewarm); invalid capture falls back to Codex rollouts with
  warnings. Recent native captures record completed responses, not provider
  attempts; the raw export is retained and usage comes from Codex rollouts.
  These are within-arm diagnostics, not measured savings, and validation alone
  does not protect exports from executor writes (see
  [protected runtime](contract.md#protected-mekugi-runtime)).

## Long-session quality and requirement-retention task

The [sqlite-utils upgrade](../tasks/sqlite-utils-history/README.md) spans 19 upstream
commits covering schema introspection, transforms, strict types, input handling, CLI
fixes, tests, and docs. Its post-cutoff baseline and reference behavior define the task
without synthetic compatibility rules. It retains ID `sqlite-utils-history` (earlier
row-history runs are distinct tasks) and defaults to `stock-mekugi`, `xhigh` reasoning,
a shared 200,000-token auto-compact limit, and a 55-minute agent limit (excluding
evaluation). Duration and actual compactions remain unmeasured until run.
