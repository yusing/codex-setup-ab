# Specification

[README](../README.md) · [Contract](contract.md) · [CLI guide](cli.md)

## Purpose and scope

`codex-ab` compares coding-agent setups on the same pinned repository task. It
holds declared controls fixed, captures implementations independently, evaluates
observable task behavior, and reports quality, time, tokens, and estimated cost.
Results are descriptive: neither one pair nor repeated trials establish causality
or generalization. Unknown measurements stay unknown.

The [contract](contract.md) owns isolation, schemas, scoring, accounting, and
failure behavior. The [CLI guide](cli.md) owns operational recipes; task READMEs
own source provenance, criteria, and qualification limits.

## Comparisons

Presets initialize controls; explicit per-arm settings may vary model, reasoning,
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

Imported arms retain their original implementations, measurements, and setup
identities. By default, fresh candidates adapt a selected imported arm's tests
while retaining the tested outcomes; imported grades and assessments stay frozen.
Fresh evaluation instead regrades every patch. Mixed or incomplete scoring
rubrics remain visible without a combined ranking. Results-only reevaluation
creates new evidence for all captured arms without rerunning implementations or
rewriting the source run. See [imports](cli.md#import-previous-arms) and
[reevaluation](cli.md#reevaluate-retained-implementations).

### Workbench experience

The Web UI prepares, launches, watches, and inspects comparisons. Arm tabs own
candidate settings; task and host infrastructure are shared. **Compare against
HEAD** creates an editable draft containing the source arms and one fresh HEAD
arm, with inference consent reset. Suite preparation and build capture use the CLI.

Names describe launchers and setups rather than storage keys. Partial results use
the same names; source assessments resolve anonymous candidates through each
pass's presentation mapping. Missing mappings appear unavailable. Stored IDs stay
unchanged. Forms and results adapt to narrow screens with visible keyboard focus;
fonts are local, including in the standalone executable.

Results lead with the outcome, measurements, differences, criterion decisions,
and concise source-assessment explanations. Correctness and simplicity have equal
priority, then completeness, performance, maintainability, approach, and test
quality. Explanations connect implementation decisions to observed consequences;
agent command time is not implementation performance. Missing historical scoring
dimensions remain unassessed. Full judge evidence is expandable; token breakdowns,
pricing, execution evidence, and diagnostics belong in the optional technical
report and downloads. Pending or infrastructure-unassessed grades are not graded;
a failed grade requires an assessed failure.

Preparation shows progress without placeholder result columns. Failures retain
status and logs. Codex/Mekugi messages render safe Markdown; tool events show short
status text, not raw transport JSON. Incomplete records wait for completion.
Embedded HTML stays text, unsafe links are inactive, and images make no network
requests. Build output stays plain text. Updates preserve open panels and
follow-scroll; watcher allocation failures fall back to periodic refresh.

## Stock Codex versus stock plus Mekugi

Choose **Minimal Codex versus minimal Mekugi** in the UI, or:

```sh
codex-ab launch --preset stock-mekugi --task skills-mgr-agent-cli --confirm-paid-inference
```

Both arms use minimal generated guidance, the default service tier, and the same
read-only mise installation store and configuration. A launches Codex through
mise; B launches the pinned Mekugi pair through mise. Neither receives current-home
instructions, skills, hooks, roles, or reviewer overlays. Preparation neither
installs tools nor copies the tool store. Keep mounted host tools unchanged;
preflight requires offline availability. Protected runtime is unsupported here.

The [launch catalog](../launch.ts) owns task choices and defaults. Omitting `--task`
selects NVM. `custom` accepts a pack or explicit inputs. Catalog tasks include NVM,
Gin, Flask, Express, skills manager, sqlite-utils, and Mekugi coordination checkpoints.
The skills-manager workflow spans 12 commits and uses a two-hour agent timeout.
Mekugi coordination checkpoints retains ID `session-retention`, uses the modular
Go workspace, and covers aggregate waits and settled compaction checkpoints for
Codex/Claude delegates. Use bare Codex via `stock-current` or `setup-commits` for
that task; launcher-comparison presets reject it before external effects.

`CODEX_AB_SKILLS_MGR_SOURCE` selects the skills-manager checkout (default
`$HOME/projects/skills-mgr`); `CODEX_AB_MEKUGI_SOURCE` selects the Mekugi checkout
(default `$HOME/projects/mekugi`) for the runtime selector and coordination task.
Set runtime, image, and credential paths in host infrastructure.

Codex choices include `gpt-6-astra` (default), `gpt-6.1-sol`, and `gpt-6.1-terra`.
Reasoning defaults to medium for NVM and xhigh for skills-manager and coordination
tasks; the Grok preset defaults to high. `--reasoning-effort` overrides this.
Efforts are none, minimal, low, medium, high, xhigh, max, and ultra; provider/model
support determines usability. `stock-mekugi` accepts a shared
`--auto-compact-limit N`; other comparisons reject that shared option. Compaction
remains Codex-owned. Neither workload size nor compaction settings prove a reset.

**Parallel work**, unchecked by default, appends neutral delegation, coordination,
integration, and validation instructions to the candidate prompt. It changes
neither trial scheduling nor host guidance. Mentor options are unsupported; keep
existing reports for saved mentor runs, which the current harness cannot process.

## Stock Codex plus Mekugi versus Grok CLI

`codex-mekugi-grok` compares Mekugi routing to `grok:grok-4.7` with headless Grok CLI
on `grok-4.7`. Both use minimal generated configuration, default service tier, and
high reasoning unless overridden. Neither gets current-home guidance or tools.
Select `--grok-bin` and provide a private `--grok-auth-file` for both homes.

Grok's session `usage.json` supplies B accounting; Codex JSONL supplies A accounting.
Grok session estimates use base rates and exclude unknown request-level
long-context premiums, retaining provider totals separately. Matched events
supply command timing. This is not a current-home direct-Codex comparison.

## Historical journal compaction evidence

New journal comparisons and recovery flags are unsupported. Retained runs remain
reportable with their original controls, evidence, and exclusions. Prepare a fresh
supported comparison for the current Mekugi interface.

## Duplicate-output comparison

`duplicate-output` owns `--deduplicate-output=false` for A and `true` for B.
Both arms use the same pinned Mekugi binary, immutable current-home setup, task,
model, reasoning, service tier, tools, and ordinary container boundary. A selected
reviewer overlay applies to both. Candidate controls need not match setup defaults.

Absolute source-home paths resolve to each arm's isolated home, not the active
host home; tool-store mounts remain read-only. Preflight uses a disposable home
and checks both flag values and export paths. Supplying deduplication through
`--mekugi-flags`, protected runtime, or imported direct-Codex controls is rejected.
Missing/invalid exports prevent complete paired measurement. Outside this
comparison deduplication defaults on; disable it with
`--mekugi-flags '["--deduplicate-output=false"]'`. Host results, retained evidence,
and UI output remain intact.

## Current setup: direct Codex versus Mekugi

`same-setup` gives both arms separate writable copies of one immutable current-home
snapshot with identical tools and controls. A launches direct Codex; B uses
Mekugi's admitted headless adapter and server-owned Thread Control. Reviewer
overlays apply equally. The default `stock-current` treatment is unchanged.

`--mekugi-bin` selects an executable with adjacent `mekugi-exec`. Both are frozen,
hash-pinned into the image, and unaffected by subsequent host updates. Prepare
again to select new binaries. `--mekugi-source` selects export validation, not
source-to-binary provenance; use [build capture](cli.md#retain-exact-mekugi-build-provenance)
for that. The runner bundles and hashes the analyzer; the live checkout does not
supply validation scripts.

`--mekugi-flags` precede the `codex` subcommand. Supported controls include shell
guarding, deduplication, child-reply summaries, `--ansi-faint=auto|on|off`, timeouts,
and `--debug`. UI unchecked toggles explicitly disable the selected behavior.
Mode, journal, recovery, mentor, explore-filter, and `--grok` flags are rejected;
comparison selection owns routing. Export destinations, credentials, and runtime
configuration are benchmark-owned. Settings never rewrite the host.

Per-runtime sanitized captures and metrics form a retained family envelope; older
single-runtime and optional native reports remain readable. Each runtime is
validated before family accounting; local sequence numbers are not a global order.
Valid provider attempts supply Mekugi usage, including retries and tool re-sends,
excluding prewarm. Invalid capture falls back to Codex rollouts with warnings.
These are within-arm diagnostics, not measured savings. Validation alone does not
protect exports from executor writes; see [protected runtime](contract.md#protected-mekugi-runtime).

## Long-session quality and requirement-retention task

The [sqlite-utils upgrade](../tasks/sqlite-utils-history/README.md) spans 19 upstream
commits: schema introspection, transforms, strict types, input handling, CLI fixes,
tests, and docs. The post-cutoff baseline and reference behavior define the task,
not synthetic compatibility rules. It retains ID `sqlite-utils-history`; old
row-history runs are different tasks. Defaults compare minimal Codex/Mekugi with
a shared 200,000-token compaction limit and 55-minute agent limit, excluding
evaluation. Duration and actual compactions remain unmeasured.
