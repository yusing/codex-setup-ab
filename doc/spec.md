# Specification

[README](../README.md) · [Specification](spec.md) · [Contract](contract.md) · [CLI guide](cli.md)

## Purpose and scope

`codex-ab` runs controlled, descriptive comparisons of the same Codex model on the same repository task. In the default `stock-current` comparison, the **stock** arm receives only a minimal model, service-tier, permission, and workspace-trust configuration. The **current** arm receives an audited snapshot of the user's instructions, skills, hooks, roles, and supporting tools. Codex runs directly by default; the current arm can explicitly use a snapshotted Mekugi launcher. The `stock-mekugi` comparison instead gives both arms minimal guidance and identical configured tool access, comparing direct Codex with Mekugi without current-home agent guidance.

This is designed for a careful pilot. A single pair does not support causal or general conclusions.
Comparisons hold the task and declared controls fixed; launcher, guidance, and projection treatments
are selected explicitly. Repeated pairs and diverse suites provide descriptive evidence, not
randomized causal estimates. See the [CLI guide](cli.md) for repeated runs and task packs, and the
[contract](contract.md) for isolation, evaluation, and evidence guarantees.

## Comparisons

| Selector | Comparison |
| --- | --- |
| `stock-current` | Minimal Codex versus an audited current-home setup, optionally launched through Mekugi. |
| `stock-mekugi` | Minimal direct Codex versus minimal Codex through Mekugi, with identical configured tools. |
| `codex-mekugi-grok` | Stock Codex through Mekugi on Grok versus the Grok CLI. |
| `same-setup` | Direct Codex versus Mekugi with the same current-home guidance and tools. |
| `journal-compaction` | Model-written versus router compaction with the same Mekugi setup. |
| `duplicate-output` | Mekugi duplicate-output projection off versus on. |

The Web UI names each compared setup by its launcher, guidance, or treatment.
Previews, measurements, execution status, output, and source assessments use these
names instead of positional letters or numbered candidate aliases. Names are
available in partial results before a report is generated. Source assessments
resolve identities through each pass's recorded presentation order. Missing
identity mappings are shown as unavailable. Stored reports and evidence keep
their original identifiers.

The dark-mode workbench uses readable sans-serif typography, paired setup previews,
and grouped run settings. Navigation, forms, and results adapt to narrow screens
with visible keyboard focus. Fonts are served locally, including from the
standalone executable; the browser does not contact an external font service.

Pair results show the outcome, key measurements and percentage differences,
source-assessment reasoning and issues, and criterion decisions directly.
Readers do not need to expand sections to understand the result. Token breakdowns,
execution evidence, pricing provenance, and diagnostics remain in one optional
technical report and the retained evidence downloads.

Setup output renders Codex and Mekugi agent messages as Markdown, including lists,
links, tables, and code blocks. Tool activity uses short status messages rather than raw event
JSON or command transport payloads. Incomplete log records wait for a complete
event; raw evidence remains available for download. Embedded HTML is displayed
as text, unsafe links are inactive, and images do not trigger network requests.
Build output stays plain text. Live updates retain open panels and follow-scroll
behavior.

## Stock Codex versus stock plus Mekugi

In the Web UI, select **Minimal Codex versus minimal Mekugi** and a task. Preparation
checks the local image against the selected Codex pair and rebuilds a missing or stale
image. The run performs model-free preflight before inference. The agent equivalent is:

```sh
./dist/codex-ab launch --preset stock-mekugi --task skills-mgr-agent-cli --confirm-paid-inference
```

Available tasks are `nvm-download-no-eval`, `session-retention`, and
[skills-mgr-agent-cli](../tasks/skills-mgr-agent-cli/README.md); omitting `--task` keeps the NVM
default. The skills manager task asks for agent-friendly, non-interactive skill management,
leaving the interface and implementation design open. It uses a two-hour agent timeout;
long-horizon runtime and compaction frequency have not been measured, and compaction is not guaranteed.
`session-retention` is available only with `stock-current`. All Mekugi presets reject that
Mekugi development task before external effects, so the launcher is compared on a separate project.
Other presets are `stock-current`, `current-vs-current-mekugi`, and `codex-mekugi-grok`.
Use `CODEX_AB_SKILLS_MGR_SOURCE` to select the skills manager task checkout
(default `$HOME/projects/skills-mgr`). `CODEX_AB_MEKUGI_SOURCE` independently selects the
Mekugi runtime checkout (default `$HOME/projects/mekugi`) and the source for `session-retention`;
set the source, executable, image, and credential paths in the Web UI's settings.

To select Mekugi's compaction mode explicitly:

```sh
CODEX_AB_SKILLS_MGR_SOURCE=/path/to/skills-mgr \
CODEX_AB_MEKUGI_SOURCE=/path/to/mekugi ./dist/codex-ab launch \
  --preset stock-mekugi --task skills-mgr-agent-cli --journal-compaction auto --confirm-paid-inference
```

This command starts paid inference. `--journal-compaction auto|slice|off` accepts spaced or
equals forms with `stock-mekugi`, `current-vs-current-mekugi`, and `codex-mekugi-grok`.
It also works with `stock-current --current-launcher mekugi`. Omitting it preserves
Mekugi's default; direct-Codex comparisons reject it. The dedicated
[journal compaction comparison](spec.md#journal-compaction-comparison) is available in the
Web UI and through agent-directed `launch --preset journal-compaction` with
`--auto-compact-limit N`; that comparison owns both arms' compaction modes.

Use `--comparison stock-mekugi --mekugi-source /path/to/matching/mekugi` to isolate the launcher treatment. Both arms receive the same minimal generated Codex configuration and the existing mise runtime and configuration, including referenced lock sidecars and migration completion records. Both access the same read-only host installation store at its original absolute path. A launches direct Codex through mise; B additionally receives the selected Mekugi executable and launches `mekugi codex` through mise. Neither arm receives current-home agent instructions, skills, hooks, roles, or a reviewer overlay. Both use the default service tier.

Preparation does not install tools or copy their store, and no Dockerfile tool provisioning is needed. Preflight requires the configured tools to be available offline. Keep the host installation store available and unchanged while prepared runs or trial sets are in use; its read-only container mount does not prevent host-side updates. This tool access applies to `stock-mekugi`; the Grok comparison still omits the store, while `same-setup` retains the full current-home guidance in both arms.

Use the Web UI model and reasoning controls, or agent-directed `launch --preset stock-mekugi --model gpt-6.1-sol --reasoning-effort high --confirm-paid-inference`, to run a Sol/high pair. Mekugi runs the selected models without mentor handoff; the former mentor options and comparisons are no longer supported. Saved mentor runs cannot be processed by the current harness; retain their existing reports for historical results. The default model remains Astra. Reasoning defaults to medium for NVM and xhigh for the skills manager and session-retention tasks; the Grok preset defaults to high regardless of task. An explicit `--reasoning-effort` overrides these defaults. The selected image must contain the matching host Codex and code-mode-host binaries; the runner checks their versions and hashes before inference. Build the selected Mekugi executable before rerunning.

Select the executable with `--mekugi-bin`, and optionally add `--mekugi-flags` as for the current-setup launcher comparison. Mekugi capture and metrics exports are retained and validated with the runner-bundled analyzer; `--mekugi-source` remains the required export-validation selector, not proof that the binary came from that checkout. The current-home Git snapshot is retained for configuration provenance, while the selected executable and runner-owned analyzer sources are captured separately. Only the configured mise tool setup reaches both minimal agent homes; other current-home runtime supplements and unused launcher executables are omitted. Protected Mekugi runtime is not supported for this comparison because that runtime currently depends on the current-home setup.

## Stock Codex plus Mekugi versus Grok CLI

Use `--comparison codex-mekugi-grok` to compare stock Codex launched through Mekugi on `grok:grok-4.7` against the Grok CLI on `grok-4.7`. A receives the generated stock Codex configuration plus Mekugi and launches `mekugi --grok codex`. B receives a generated Grok configuration plus the selected Grok executable and launches `grok` headlessly. Neither arm receives current-home instructions, skills, hooks, roles, tool installations, or a reviewer overlay. Both use the default service tier and high reasoning unless `--reasoning-effort` selects another effort.

```sh
run_dir="$(./dist/codex-ab prepare \
  --task-pack ./tasks/nvm-download-no-eval/manifest.json \
  --source /tmp/codex-ab-nvm-source \
  --comparison codex-mekugi-grok \
  --mekugi-source /home/ubuntu/projects/mekugi \
  --mekugi-bin /home/ubuntu/go/bin/mekugi \
  --mekugi-flags '["--mode=mekugi","--grok"]' \
  --grok-bin /home/ubuntu/.grok/bin/grok \
  --image codex-ab:0.1.0)"
./dist/codex-ab preflight --run-dir "$run_dir"
./dist/codex-ab run --run-dir "$run_dir" \
  --auth-file /home/ubuntu/.codex/auth.json \
  --grok-auth-file /home/ubuntu/.grok/auth.json \
  --confirm-paid-inference
```

`--grok-auth-file` is copied privately into both isolated homes. Grok usage is metered from each B session `usage.json`, using captured list prices for comparison. Session-only Grok estimates use base rates and explicitly exclude unknown request-level long-context premiums; provider-recorded totals are retained separately. Command durations and tool blocking come from matched events in `events.jsonl`. Codex JSONL remains the A accounting source. Isolated launcher snapshots omit the unused current-home mise tool store. This is not a current-home direct Codex versus Mekugi comparison.

## Journal compaction comparison

Use `prepare --comparison journal-compaction --auto-compact-limit N` with the
usual predetermined task/criteria and Mekugi source/binary options to compare
model-written compaction (A, off) with router compaction (B, auto). Both arms use
the same current-home snapshot, Mekugi binary and recorded positive token limit.
This comparison owns the compaction flag and requires ordinary container
boundaries in both arms. Imported controls are not supported. Preparation and preflight do not run inference; execution
still requires `--confirm-paid-inference`. Pairs with no compaction in either arm
are marked `no compaction observed` and excluded from paired aggregates, never
counted as ties. Missing compaction evidence is separately reported as unavailable.
Use `prepare-trials --count 4` on the prepared run for repeated pairs; schedules
remain separate. This opt-in comparison does not enable auto as Mekugi's default.

## Duplicate-output comparison

Use `prepare --comparison duplicate-output` with the usual predetermined
task/criteria and `--mekugi-source`/`--mekugi-bin` options to compare Mekugi's
duplicate-output projection off (A, `--duplicate-output=false`) with on
(B, `--duplicate-output=true`). Both arms launch the same Mekugi binary through
mise with separate writable copies of the same immutable current-home snapshot,
the same task, model, reasoning, service tier, tools, and ordinary container
boundary. A reviewer overlay, if selected, applies to both arms. This isolates
the output projection rather than comparing direct Codex with Mekugi.

Select supported model controls explicitly, for example
`--model gpt-6.1-sol --reasoning-effort high`. This comparison accepts a current-home configuration
that already uses those values; it does not require Astra/medium in that configuration.
Both arms retain identical current-home setup. Absolute paths under the original
home (for example, `/home/yusing`) resolve to each arm's own isolated home through
an alias alongside `/home/ubuntu`. The active host home is not mounted. Preflight
uses a read-only snapshot alias; installed tools retain their existing read-only
host-store mount, including when nested under that alias. Other comparisons keep
their existing model guards and home-path behavior.

The comparison owns `--duplicate-output`; supplying it through `--mekugi-flags`
is rejected, as are passthrough, Grok routing, and `--protect-mekugi`.
Imported direct-Codex controls are unsupported. Model-free preflight checks both
flag values and their export paths before inference. Each arm retains separate
capture and metrics exports and provider-usage accounting; missing or invalid
exports prevent a complete paired measurement. Preparation and preflight do not
run inference; execution requires `--confirm-paid-inference`. Use
`prepare-trials --count 4` on a prepared run for fresh repeated pairs.

Duplicate-output projection is enabled by default in Mekugi mode. Outside this
comparison, use `--mekugi-flags '["--duplicate-output=false"]'` to disable it.
Passthrough is unaffected, and full host results, retained evidence, and the UI
remain intact. See Mekugi's
[projection contract](https://github.com/yusing/mekugi/blob/main/doc/spec/execution.md#duplicate-output-projection).

## Current setup: direct Codex versus Mekugi

Add `--comparison same-setup --mekugi-source /path/to/matching/mekugi` to `prepare`. A (stored as `stock` for compatibility)
and B (`current`) receive separate writable copies of the **same immutable current-home
snapshot**, the same read-only installed tools, prompt, source, model, reasoning, service tier,
and resource limits. A launches direct Codex through mise; B launches Mekugi through mise.
A reviewer overlay, if selected, therefore applies to both arms. There is no treatment-only
general workflow guidance. The default `stock-current` comparison is unchanged.

Select the Mekugi executable with `--mekugi-bin`.
Use `--mekugi-flags '["--mode=mekugi"]'` for explicit Mekugi options placed before its `codex`
subcommand. Supported flags include `--ansi-faint=auto|on|off`, `--post-compact-recovery=true|false`,
`--journal-compaction=auto|slice|off`, `--duplicate-output=true|false`, timeouts,
`--mode`, `--grok`, and `--debug`.
The removed `--explore-filter` option is rejected. Export destinations, credential paths, and runtime configuration are benchmark-owned and cannot be
overridden through this option. The selected arguments and comparison identity appear in the
machine state and consolidated report. Preparation and preflight make no model requests.

Supply `--mekugi-source DIR` (required for `same-setup`) to enable sanitized `--capture-output`
and capturer-owned metrics exports. Mekugi now writes the metrics snapshot through `--debug`; the runner keeps its other, potentially private debug files inside the disposable agent container and copies only `metrics.json` and the root session's native usage report, `token-metrics.md`, into the run artifacts. The checkout is not read for validation scripts or binary provenance; use `--mekugi-build` for recorded source-to-binary provenance. Preparation snapshots the runner-bundled analyzer and its hash.
The report validates the capturer's schema, treatment identity and raw-record consistency with that analyzer, retaining missing or
invalid telemetry explicitly. Capture calculations remain owned by Mekugi. When validation
succeeds, a Mekugi arm's tokens and requests come from its provider attempts, excluding prewarm,
because router-local tool re-sends and retries never reach the Codex rollout while Mekugi's native
cost includes them. Direct Codex rollouts omit prewarm too. Without a valid capture, the report
falls back to the Codex rollout and says so in its warnings. The exports are otherwise
within-arm diagnostics, not measured savings against A. Consistency checks alone do not protect
exports from executor writes; the optional [protected runtime](contract.md#protected-mekugi-runtime) supplies that boundary.

## New-project quality and requirement-retention task

The [Booking Ledger benchmark](../tasks/booking-ledger/README.md) asks candidates to
build a complete Python/SQLite CLI from a clean synthetic seed. It focuses on
quality, correctness, completeness, and requirement drift across persistent state,
interval capacity, atomic changes, imports, and reports. Its model-free preparation
recipe compares stock Codex with Mekugi journal context reset enabled and caps each
agent at 55 minutes. Reset occurrence and project duration remain unmeasured;
post-reset claims require observed root reset and continued work. Evaluation time
is separate. This task uses standalone criteria and the generic task profile.
