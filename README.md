# codex-ab

`codex-ab` runs controlled, descriptive comparisons of the same Codex model on the same repository task. The **stock** arm receives only a minimal model, service-tier, permission, and workspace-trust configuration. The **current** arm receives an audited snapshot of the user's instructions, skills, hooks, roles, and supporting tools. Codex runs directly by default; the current arm can explicitly use a snapshotted Mekugi launcher.

This is designed for a careful pilot, not a claim that one setup causes better results. A single pair does not support causal or general conclusions.

## Prerequisites and build

You need Bun 1.4 or later, Git, Python 3 for Mekugi export validation, Docker with BuildKit named-context support, access to the source commit, a standalone Codex binary and its matching `codex-code-mode-host` companion, and a mode-0600 Codex `auth.json`. The pinned Ubuntu 24.04 image copies only Go and Node from `hpatch-bench:run-D9ZuS3`; it does not inherit that image's Mekugi runtime, wrappers, source, home, or credentials. It copies the chosen standalone Codex pair directly. Preparation records the CLI version plus both files' SHA-256 identities; preflight requires both container copies to match.

```sh
bun install
bun run build
codex_bin="$(readlink -f /home/ubuntu/.local/bin/codex)"
codex_dir="$(dirname "$codex_bin")"
codex_sha="$(sha256sum "$codex_bin" | cut -d' ' -f1)"
codex_host="$codex_dir/codex-code-mode-host"
codex_host_sha="$(sha256sum "$codex_host" | cut -d' ' -f1)"
docker build \
  --build-context "codex_binary=$codex_dir" \
  --build-arg "CODEX_SHA256=$codex_sha" \
  --build-arg "CODEX_CODE_MODE_HOST_SHA256=$codex_host_sha" \
  --build-arg "BENCH_UID=$(id -u)" \
  --build-arg "BENCH_GID=$(id -g)" \
  -t codex-ab:0.1.0 .
./dist/codex-ab --version
```

No model request occurs during the build or `prepare`. The `run` command includes two independent source-assessment passes after a completed pair. Each pass has two stages when the first harness succeeds, or three when one repair stage is needed; every stage allows at most three Sol launches on capacity errors. `judge` is available for older, not-yet-judged pairs. Both commands make model requests using your Codex authentication and quota, and require `--confirm-paid-inference` to start. Reported API costs are list-price estimates, not subscription charges or invoices.

## Prepare an isolated pair

```sh
run_dir="$(./dist/codex-ab prepare \
  --source /home/ubuntu/projects/mekugi \
  --base bb9e740362fd86c9214f5c893c65ae6c46587a60 \
  --forbidden d50b9e6d7a2b01fc033a8aab523791876e4441b5 \
  --task ./task.md \
  --criteria ./criteria.json)"
```

Preparation creates a new mode-0700 `mktemp` directory outside the repository. It shallow-fetches exactly the base commit into a bare seed, makes two `--no-local --no-hardlinks` clones, removes their remotes, and verifies tree identity, the lack of object alternates and linked worktrees, and absence of the future solution commit. The solution itself is never copied.

For early familiarization followed by passive milestone retention and final-only inspection, use the [v3 treatment](treatments/continuous-review-v3/TREATMENT.md). Active home guidance is not changed.

The current setup starts with a shallow, independent clone of the configuration repository rooted at `--current-home` (default `/home/ubuntu`), with its remote removed. All tracked configuration is included automatically, so adding or removing a guidance file does not require a runner change. Current tracked edits, staged additions, and deletions are overlaid without changing the source checkout. New untracked instruction files must be added to Git before preparation to be included.

To apply a benchmark-only reviewer overlay, add `--review-treatment DIR` with `parent-agents.md`, `review-correctness.toml`, `review-simplify.toml`, and `web-reviewer.toml`. Preparation applies them to the isolated current snapshot after copying the live home, records before/after hashes in the manifest, and leaves active guidance untouched. Omit this option to benchmark the current home without a treatment. Use `--current-launcher codex` to run bare Codex without Mekugi.

Runtime supplements are copied separately: installed hooks, materialized skills and bundled plugins, the referenced remote-skill cache generations, and the existing Modern Go Guidelines provider. Preparation also snapshots the complete installed mise tool store and its migration completion records, and records a content manifest. To save disk space and preparation time, pass `--snapshot-base /tmp/codex-ab-PREVIOUS` for a completed run. When that run has identity metadata and a live file's change time proves that it has not changed since the base capture, preparation reuses the base's recorded SHA-256 instead of reading the file again. Older manifests are verified by content before reuse. Files with matching contents and modes are hard-linked from that isolated snapshot; changed files are copied, and live-home files are never hard-linked. Each new snapshot retains its own paths and survives deletion of the old run. Keep snapshot tool stores immutable; they are mounted read-only during execution. Preparation reports reused and copied bytes and records them in `snapshots/current/incremental.json`. The new manifest records each snapshot file's device, inode, size, mode, and nanosecond change times. Preflight uses those identities to detect changes without rereading the complete tool store, falling back to its recorded digest after a normal hard-link lifecycle change. A matching completed run also seeds the non-inference Go and Bun compile caches; the compiler still checks the exact base and dependencies. Preflight rejects mise migration failures before agent execution; the tool store stays read-only. The current arm starts Codex through that setup, so every tool declared by the active user configuration is available without network access. `--current-launcher mekugi` additionally copies the executable selected by `--mekugi-bin` (default `~/go/bin/mekugi`) and its matching `shell` helper into the audited snapshot, without copying Mekugi state. The helper defaults to `shell` beside the resolved Mekugi executable; use `--mekugi-shell-bin` when storing the pair separately. Install or build both from the same Mekugi revision. Their paths and hashes are recorded and checked before launch. Other untracked home files, including authentication and session history, are not copied. The source repository is expected to contain only configuration suitable for the benchmark, not tracked credentials or task solutions.

The clone preserves absolute `/home/ubuntu` paths inside its container. `snapshot-manifest.json` records the configuration commit and tree, overlaid tracked paths, a SHA-256 for every regular setup file (excluding Git metadata), literal symlink targets, and portability adaptations. The installed-tool content manifest and copied setup manager are also verified before launch. Preflight requires every configured tool to be present, then runs a referenced remote skill and the registered Go-guidelines hook with networking disabled. For Mekugi, it also resolves `shell` on the executor's PATH and executes its missing-thread diagnostic, catching absent or non-runnable helpers before inference. This checks helper startup, not a complete model-to-tool request. An incomplete setup fails before inference instead of being silently bypassed.

Each arm sees only its own clone, caches, and private home; the current arm also receives its read-only installed-tool snapshot. Agent logs and captured patches stay outside its writable mounts. Behavioral criteria are fixed before execution; adaptive checks are authored after both candidates stop and run in separate evaluator workspaces.

Validate the image and snapshotted dependencies without making a model request:

```sh
./dist/codex-ab preflight --run-dir "$run_dir"
```

## Run and grade both arms

After reviewing `run.json`, start the model runs explicitly:

```sh
./dist/codex-ab run \
  --run-dir "$run_dir" \
  --auth-file /home/ubuntu/.codex/auth.json \
  --confirm-paid-inference
```

The command first checks that the image exposes the exact Codex version recorded during preparation, its hash-matched code-mode host, and no image-bundled `mekugi`; exercises a real local code-mode execution without model access; and checks the complete current setup offline. For each arm, agent setup installs locked plugin dependencies when required, builds the ignored JavaScript embed missing from a clean checkout, and prewarms writable agent caches without evaluator source. It then copies those caches into evaluator-only storage for offline semantic assessment. Grading mounts those completed evaluator caches read-only and offline, without exposing them to the agent or consuming agent-modified entries after inference. It rejects any preparation that changes either immutable baseline. Only after both preparations pass does it start both gpt-6-astra arms at the selected reasoning effort (default medium) concurrently with identical two-CPU and 4 GiB limits. Preflight and the final launch check verify copied controls, both setup templates, the installed-tool file manifest, the Bun snapshot, and immutable baseline identity. The image tag is resolved before checking it, and all subsequent containers use that image ID. The default agent timeout is 30 minutes. Both arms use the service tier read from the snapshotted current configuration, and the report records it.

Milestones go to stderr. Timeout or cancellation stops session-created containers and preserves available patches and results. Runs never restart or resume: prepare a new directory for another attempt. Mekugi snapshots prepared without the separate `shell` helper must be replaced with a fresh preparation; completed historical reports remain readable.

Semantic assessment requires both arms. Historical singleton reports remain descriptive records, not paired comparisons.

After both agents stop, the runner captures tracked, committed, staged, and untracked changes as a binary patch relative to the recorded immutable base. Only then does it create separate evaluator workspaces. Independent semantic passes run the predetermined existing tests and author checks against each candidate's actual interfaces. Git inspection and patch capture run in separate offline containers, never on the host. Agent and grader times remain separate.

For Mekugi's original router task, use the `mekugi` profile and explicitly select `--current-launcher mekugi`, with `--mekugi-bin` and `--mekugi-shell-bin`. Historical result bundles and the pinned toolchain image retain their original names and identities. Historical source snapshots may still use the `hpatch:core/v1` plugin ABI; preparation supports it without rewriting benchmark source.

## Repeat a pinned comparison

Start from an unused prepared pair. `prepare-trials` runs model-free preflight, pins the immutable
image, input identities and pricing snapshot, then copies fresh source/setup trees for every pair.
The prototype is not executed. Each pair has independent writable homes and caches; copying large
tool snapshots requires enough disk space for all pairs.

```sh
trial_set="$(./dist/codex-ab prepare-trials --run-dir "$run_dir" --count 4)"
```

Pairs run one after another, with **both arms concurrent by default**. To alternate sequential
arm order, prepare with `--order alternating`: A then B for odd-numbered pairs, B then A for even
pairs. This changes resource contention relative to concurrent arms and is recorded in every
report. Do not pool the two schedules as equivalent experiments.

Execution includes both arms and their independent judges for every pair, so it consumes model
quota repeatedly. Start it only when intended:

```sh
./dist/codex-ab run-trials --trial-set "$trial_set" --confirm-paid-inference
```

For `codex-mekugi-grok` trial sets, also pass `--grok-auth-file /path/to/.grok/auth.json` to `run-trials`.

Failed pairs retain their evidence and do not discard later planned trials. Cancellation stops
the active pair and leaves remaining pairs unstarted. Started sets never resume or restart;
prepare a new set for another attempt. Each finished pair's existing evidence bundle is copied
into trial-set-owned storage before moving on, so later standalone reporting cannot
silently replace the trial observation.

The command prints one aggregate `report.md` path. It contains setup identities, paired means,
medians, sample standard deviations, winner counts, separate judge costs, and the full per-pair
reports inline. Adjacent JSON, checksums and per-pair machine bundles retain the evidence without
copying private authentication homes. Every planned pair appears, including failed or incomplete
ones. Only complete valid paired measurements enter aggregates; missing metrics remain unknown,
and percentage differences omit zero A baselines. Negative differences are retained. Repeats
are descriptive evidence, not a significance test or a causal conclusion.

To generate another self-contained report from retained evidence without inference or rerunning
judges, use `report-trials --trial-set "$trial_set"`. Each report gets a new output directory;
previous reports remain unchanged.

## Stock Codex versus stock plus Mekugi

For the pinned medium NVM task, the convenience runner builds the CLI and a missing local image,
prepares the selected comparison, runs model-free preflight, and then starts the paid pair:

```sh
scripts/run.sh --preset stock-mekugi
```

Other presets are `stock-current`, `current-vs-current-mekugi`, and `codex-mekugi-grok`. Run
`scripts/run.sh --help` for path and image overrides.

Use `--comparison stock-mekugi --mekugi-source /path/to/matching/mekugi` to isolate the launcher treatment. A receives the minimal generated stock configuration and launches Codex directly. B receives the same generated configuration plus only the selected Mekugi executable and its matching `shell` helper, then launches `mekugi codex`. Neither arm receives current-home instructions, skills, hooks, roles, tool installations, or a reviewer overlay. Both use the default service tier.

Select the executable pair with `--mekugi-bin` and `--mekugi-shell-bin`, and optionally add `--mekugi-flags` as for the current-setup launcher comparison. Mekugi capture and metrics exports are retained and validated against `--mekugi-source`. The current-home Git snapshot is retained for configuration provenance, while selected executables and analyzer sources are captured separately; unused current-home executables, runtime supplements, and the mise tool store are omitted and are not mounted into or used by either agent. Protected Mekugi runtime is not supported for this comparison because that runtime currently depends on the current-home setup.


## Stock Codex plus Mekugi versus Grok CLI

Use `--comparison codex-mekugi-grok` to compare stock Codex launched through Mekugi on `grok:grok-4.6` against the Grok CLI on `grok-4.6`. A receives the generated stock Codex configuration plus Mekugi/`shell` and launches `mekugi --grok codex`. B receives a generated Grok configuration plus the selected Grok executable and launches `grok` headlessly. Neither arm receives current-home instructions, skills, hooks, roles, tool installations, or a reviewer overlay. Both use the default service tier and the selected reasoning effort.

```sh
run_dir="$(./dist/codex-ab prepare \
  --task-pack ./tasks/nvm-download-no-eval/manifest.json \
  --source /tmp/codex-ab-nvm-source \
  --comparison codex-mekugi-grok \
  --mekugi-source /home/ubuntu/projects/mekugi \
  --mekugi-bin /home/ubuntu/go/bin/mekugi \
  --mekugi-shell-bin /home/ubuntu/go/bin/shell \
  --mekugi-flags '["--mode=mekugi","--model-protocol=native","--grok"]' \
  --grok-bin /home/ubuntu/.grok/bin/grok \
  --image codex-ab:0.154.0)"
./dist/codex-ab preflight --run-dir "$run_dir"
./dist/codex-ab run --run-dir "$run_dir" \
  --auth-file /home/ubuntu/.codex/auth.json \
  --grok-auth-file /home/ubuntu/.grok/auth.json \
  --confirm-paid-inference
```

`--grok-auth-file` is copied privately into both isolated homes. Grok usage is metered from each B session `usage.json`, using complete provider-recorded cost when available and otherwise a captured list-price estimate that remains unknown when request-level tiering cannot be reconstructed. Codex JSONL remains the A accounting source. Isolated launcher snapshots omit the unused current-home mise tool store. This is not a current-home direct Codex versus Mekugi comparison.

## Current setup: direct Codex versus Mekugi

Add `--comparison same-setup --mekugi-source /path/to/matching/mekugi` to `prepare`. A (stored as `stock` for compatibility)
and B (`current`) receive separate writable copies of the **same immutable current-home
snapshot**, the same read-only installed tools, prompt, source, model, reasoning, service tier,
and resource limits. A launches direct Codex through mise; B launches Mekugi through mise.
A reviewer overlay, if selected, therefore applies to both arms. There is no treatment-only
general workflow guidance. The default `stock-current` comparison is unchanged.

Select the matching executable pair with `--mekugi-bin` and `--mekugi-shell-bin`.
Use `--mekugi-flags '["--mode=mekugi","--model-protocol=native"]'` for explicit Mekugi options placed before its `codex`
subcommand. Export destinations and runtime configuration are benchmark-owned and cannot be
overridden through this option. The selected arguments and comparison identity appear in the
machine state and consolidated report. Preparation and preflight make no model requests.

Supply `--mekugi-source DIR` from the matching Mekugi checkout (required for `same-setup`) to enable its `--capture-output`
and `--metrics-output` exports and snapshot its analyzer. The report validates the capturer's
schema, treatment identity and raw-record consistency with that analyzer, retaining missing or
invalid telemetry explicitly. Capture calculations remain owned by Mekugi. The exports are
within-arm diagnostics, not measured savings against A. Consistency checks alone do not protect
exports from executor writes; the optional protected runtime below supplies that boundary.

## Protected Mekugi runtime

Add `--protect-mekugi` to preparation with `--mekugi-source` or `--mekugi-build`, and use an image
rebuilt from the current Dockerfile. Preflight reuses Mekugi's snapshotted isolation scripts:
a real router starts, its executor can reach only that listener, capture/runtime mounts are
read-only, and private Go compilation and Code Mode execution must work without inference.
The check copies the captured B home and workspace, mounts its exact mise tool store, and uses
the same `mise exec -- mekugi` launch path. The wrapper's underlying Codex executable must also
hash-match direct A. The recorded preflight result is retained in the bundle.

The trusted launcher needs Docker `NET_ADMIN`, `SYS_ADMIN`, and private mount/PID namespaces.
The executor keeps UID 0 for compatibility with Mekugi-owned state, but has no capabilities,
no supplementary groups, no privilege elevation, and an immutable non-root network GID.
Only run-owned writable trees are temporarily assigned to that executor; ownership is restored
after termination. An interrupted ownership restore is a lifecycle error, not a successful run.

**Arm A remains true direct Codex**, with its ordinary non-root container and provider egress.
Protected arm B has a different process/network boundary, recorded explicitly in state and
the report. This is not passthrough-versus-Mekugi and should not be described as identical
sandbox behavior. Existing unprotected runs remain readable and retain their diagnostic caveat.

## Retain exact Mekugi build provenance

To bind the selected executable pair to dirty source and compiled guidance, build from a captured
context rather than supplying a nearby checkout:

```sh
build_dir="$(./dist/codex-ab build-mekugi \
  --source /home/ubuntu/projects/mekugi --image codex-ab:0.1.0)"
```

This model-free command uses Mekugi's own `benchmarks/build_inputs.py` exclusion rules. It
retains a source archive, the archiver, build command/logs, immutable builder-image identity,
and both executable hashes in a private temporary directory. Compilation consumes the archive
inside a container without host credentials. Dependency downloads are allowed during this build;
no model request is made. Failed builds retain their available evidence.

Use `prepare --mekugi-build "$build_dir"` instead of `--mekugi-bin`, `--mekugi-shell-bin` and
`--mekugi-source`. Preparation takes its analyzer/runtime sources from the retained archive,
checks the binaries, and copies provenance into the existing result bundle. No live source
checkout or original build directory is needed after preparation. The run image is still
selected independently and verified normally. This is locally recorded build provenance,
not a signed third-party attestation. Supplying binaries without a build bundle remains
supported and explicitly reports missing source provenance.

## Portable task packs

The portable [nvm download](tasks/nvm-download-no-eval/manifest.json) and
[Gin context copy](tasks/gin-context-copy/manifest.json) packs reuse Mekugi's task prompts and
behavioral criteria. Each pins its upstream base and excluded solution commit, dependency
preparation, behavioral criteria and task-required single-file boundary. They use the generic
`task` profile, not a repository-specific runner branch.

Obtain the source repository locally, then prepare from its manifest:

```sh
git clone https://github.com/nvm-sh/nvm.git /tmp/codex-ab-nvm-source
run_dir="$(./dist/codex-ab prepare \
  --task-pack ./tasks/nvm-download-no-eval/manifest.json \
  --source /tmp/codex-ab-nvm-source \
  --comparison same-setup \
  --mekugi-source /home/ubuntu/projects/mekugi \
  --image codex-ab:0.1.0)"
./dist/codex-ab preflight --run-dir "$run_dir"
```

For Gin, clone `https://github.com/gin-gonic/gin.git` and select
`tasks/gin-context-copy/manifest.json`. `--task-pack` requires `--source` and rejects overrides
of its profile, base, forbidden commit, prompt or grading inputs. Only the pinned base reaches
the arms, even if the source checkout contains later commits.

Preparation fingerprints the manifest and prompt and freezes them, along with
the expanded criterion contract, under evaluator-only storage. The bundle retains their
contents and hashes. No original pack directory is needed after preparation. A fingerprint
identifies the supplied content; it is not a signature of upstream authenticity.

Nvm needs no downloaded dependencies. Its pinned installer requires Bash to be sourced, so its existing checks run with Bash; the changed function must remain POSIX-compatible. Gin prepares pinned Go modules before inference and reuses separate evaluator caches offline. Nvm's existing tests exercise installer source selection, not network-dependent downloads. Adaptive semantic checks cover the task's remaining outcomes. Pack contracts record `qualification: "not-run"`; preparing a pack does not authorize inference or claim oracle qualification.

## Skills manager bundle profile

The [skills-mgr bundle task](tasks/skills-mgr-bundle/README.md) is a multi-part task outside Mekugi and GoDoxy. Use `--profile skills-mgr-bundle` with explicit source, base, forbidden commit, task, and `--criteria` inputs. It prepares the root Go package without Mekugi plugin assets. Candidate-specific checks are authored during semantic assessment, rather than supplied as hidden test files.

## GoDoxy icons profile

Use `prepare --profile godoxy-icons --reasoning-effort medium` (or `xhigh`) with explicit `--source`, `--base`, `--forbidden`, `--task`, and `--criteria` inputs. Prepare a fresh pair for each effort, launcher, or repeat. Add `--current-launcher mekugi` to launch the current arm as `mekugi codex`; otherwise it launches bare Codex. Supply the matching `shell` helper as described above. The profile accepts only the pinned synthetic base `c335ef2d83d9fb8a774cb70b9b628ade54c654a2`, its recorded tree, excluded solution, and three exact submodule commits.

The source must contain local repositories at `goutils`, `internal/go-oidc`, and `internal/gopsutil` with the base commit's gitlink objects. Preparation shallow-fetches those exact commits into independent submodule clones, removes their remotes, and records their paths, source provenance, and SHAs in `run.json`. It rejects root remotes and initialized or populated `webui` throughout setup, patch collection, and grading. It does not initialize `webui`. The current arm uses the same audited current-home snapshot rules as the default profile.

Preflight retains the bare-image and local Code Mode checks. Go's module-selected toolchain must be at least 1.27. Candidate edits inside the pinned submodules are rejected during patch collection. The supplied criteria choose dependency preparation and existing tests; use the icons package with `-ldflags=-checklinkname=0` where needed. Both independent semantic passes evaluate the task against the captured candidates.


The workflow is hybrid: grading, usage accounting, token/time/cost breakdowns, report generation,
and retry decisions are deterministic code. Only candidate implementation, semantic harness authoring and qualitative source
assessment use models. No conversational subagents are needed to grade, judge, or explain the
recorded performance measurements.

## Task-derived semantic grading

Use `prepare --criteria FILE` to supply the required task-derived evaluation contract. The JSON contract has this form:

```json
{
  "schema": "codex-ab.criteria.v1",
  "task_sha256": "SHA256_OF_THE_EXACT_TASK_FILE",
  "criteria": [
    {"id": "behavior", "description": "Observable outcome required by the task"}
  ],
  "preparation": "command that prepares the pinned baseline dependencies",
  "existing_tests": "command that runs the relevant existing tests",
  "qualification": "not-run"
}
```

Write and review the criteria from the task **before** running either candidate. Only add
`required_interface` to a criterion when the task explicitly fixes that public interface.
Preparation records and verifies the contract hash and task binding. An optional `allowed_paths` array enforces exact file boundaries only when the task requires them. The `task` profile uses
these commands rather than repository-specific Go targets. Commands run inside containers,
not on the host. Prepare dependencies without introducing evaluator-only checks into agent
workspaces; evaluator build storage stays separate.

After both agents stop and their patches are captured, two blind passes inspect candidates in
opposite orders. Each pass runs the predetermined existing tests and asks Sol for additional
checks adapted to the actual candidate interfaces. The runner executes those checks offline,
without credentials or a Docker socket, against private copies of read-only candidate source.
It rejects harness files that overwrite candidate files and detects changes to original files.

A judge may repair a broken harness once per pass, including a failed check whose wiring was wrong. Earlier evidence remains available to the final assessment; real behavior failures must not be weakened into passes. Different names and test wiring are
allowed; different required outcomes are not. Compilation failures caused by assumed names
remain **unassessed**, not automatic candidate failures. A missing explicitly required public
interface can be a source-only defect. Passing requires executed evidence plus the judge's
assessment that the check actually covers the criterion. Both passes, disagreements, source,
commands, outputs and repair attempts are retained.

Prewritten hidden tests are no longer supported. Supply behavioral criteria, not evaluator source. Semantic assessment requires both arms and cannot restart a started assessment.

Harness authoring, an optional repair, and final assessment each have their own recorded model
attempts, with the existing capacity-only retry policy. Model usage and timing remain separate
from offline check time. No semantic model request occurs during `prepare` or `preflight`;
`run`, `judge` and `finish` still require `--confirm-paid-inference`.

## Blind judge

The `run` command performs blind semantic assessment automatically after both candidates are captured. For a complete pair with criteria and no judge attempt:

```sh
./dist/codex-ab judge --run-dir "$run_dir" --confirm-paid-inference
```

The gpt-5.6-sol judge uses high reasoning and the fast service tier (normalized by Codex to the priority request tier). It receives the task, anonymous patches, changed-file lists, bounded output summaries, and complete read-only evaluator evidence under `/evidence`, plus anonymous evaluator source directories for inspecting affected contracts and callers. It does not receive arm labels, costs, the original solution, agent logs, or either agent's writable filesystem. Two independent stock-config homes judge opposite presentation orders. Each pass uses two stages when its first harness succeeds or three when one repair stage is needed, with up to three capacity attempts per stage. Each assessment returns validated JSON scores for correctness (50%), completeness (20%), maintainability (20%), and test quality (10%), plus evidence, issues, and a winner. Critical findings override totals; a candidate that failed any required gate cannot win. Disagreement is reported rather than forced into consensus. Large logs stay retained and inspectable without being duplicated into the prompt. Oversized patches or summary packs still fail explicitly. Reports created before this setting change retain their recorded medium/default judge metadata.

Capacity errors retry automatically within the active judge command, with at most three launches per stage and 5-second and 15-second delays. Each launch gets a fresh isolated home and distinct logs; the state and report retain every attempt and its usage. A completed stage is never repeated.
Cancellation interrupts the delay and prevents another launch. Other failures, timeouts, invalid
verdicts, and exhausted retries stop with the available evidence preserved. There is no automatic
model substitution or conversational-agent fallback. Once the command exits, it cannot restart a
judge attempt; historical failed attempts remain unchanged.

## Report

```sh
./dist/codex-ab report --run-dir "$run_dir"
```

The command prints one result path: `reports/report.md`. This self-contained Markdown includes
the task and setup, behavioral explanation with inline event evidence, measurements, checks,
source judgments, and limitations. JSON files and the checksummed bundle retain machine-readable
evidence; no second explanation or source-review Markdown is needed. Refreshing a finishing bundle
removes the former generated `SOURCE-REVIEW.md` and `COMPARISON.md` duplicates.

To leave a historical run and its original reports unchanged, export elsewhere using its recorded pricing:

```sh
./dist/codex-ab report --run-dir "$run_dir" --output-dir ./results/refreshed-result
```

If supplemental source assessments were already recorded separately, add
`--source-assessments FILE` to include them in the same Markdown. The JSON input contains
`passes`, an array of two objects with `presentation` (candidate-1/candidate-2 arm labels,
`["stock", "current"]` then the reverse, or vice versa) and `response` (the original judge-schema
JSON with scores, evidence, issues, winner, and rationale). The report validates both responses,
recalculates weighted scores, records the input hash, and shows agreement or disagreement inline.
Imported assessments do not restart inference, replace the official judge, supply missing usage,
or change overall winner eligibility. They are supplied evidence, not an operational fallback.

The runner automatically writes `reports/report.md`, `reports/report.json`, and a checksummed `reports/bundle/` after execution, including partial runs. The bundle contains setup identities, task and evaluator controls, captured patches, interaction and role audits, source assessment, paired comparison, semantic check results, and integrity checks. Encrypted interaction content remains unknown; command waits are counted separately from reviewer-status polling. The standalone `report` command refreshes the standard report and an existing finishing bundle without starting inference. Readable rejected judge responses are retained separately as unvalidated evidence, never as an eligible winner. It includes raw, cached, cache-write, output, reasoning-output, and total tokens for root and child agents; estimated public-list API cost; command time; agent and grader wall time; gate status; B-minus-A percentages; both raw judge passes; and a separate judge cost. Pricing is fetched and snapshotted once per run, with source, timestamp, assumptions, and warnings. If usage or required checks are incomplete, the report shows no overall winner.

The behavioral explanation matches captured review instructions against visible execution events.
It recognizes isolated reviewer preparation, review gated until after validation,
finding/edit/test/re-review cycles, and copied-workspace test overhead. Every supported mechanism
includes its event locations and limits. Edits require completed file-change records. Test
classification requires a single recognized command; compound scripts, quoted examples, and
unsupported shell syntax are not treated as proof of individual operations or successful reads.
Encrypted messages are not decoded or labeled as known
readiness signals: their ordering can support a qualified handoff inference, not a claim about
their contents. Unrecognized workflows and cache-miss causes remain explicitly unknown. Rules do
not call a model, assume every extra action is waste, or estimate counterfactual savings.

The programmatic performance section separates root and child usage, model-request counts,
mean and peak input context, uncached/cached/output cost components, and matched outer-tool
blocking spans. JSON includes these diagnostics and current-minus-stock role/cost differences.
Request IDs are deduplicated before accounting; cumulative-only usage leaves request counts
unknown. Tool intervals end at the first matched output and are unioned within each session,
not added across overlapping agents. Additional or unmatched outputs mark timing partial.
A report refresh requires no model calls. The numbers locate observed overhead, but do not infer
causal blame for a specific instruction or launcher, decode encrypted messages, or replace
source-quality inspection. Missing judge-attempt usage remains unknown even if a later attempt
succeeds; the report never fabricates a complete cost or overall winner.

If execution completed but finishing failed before a judge request, fix the reported issue and use `finish --run-dir DIR --confirm-paid-inference`. It archives the failed bundle, preserves the same candidates and grades, runs only a not-yet-started judge, and regenerates the report bundle. It never restarts either A/B agent or a started judge attempt. A completed judge can be reused when only artifact generation failed.

For post-hoc troubleshooting deductions, use `remeter --run-dir DIR --exclusions FILE`. The JSON file contains `arm` (`stock` or `current`), `rationale`, and `responses` and `commands` arrays of `{ "id": "...", "reason": "..." }`. IDs must match recorded response and command IDs. The command writes a separate `reports/remeter-*/` accounting report using the recorded pricing, retaining the original run and reports. It does not rerun agents, rewrite later context usage, or claim an adjusted wall time.

If an evaluator infrastructure fault prevents assessment, retain the failed evidence, fix the fault, and prepare a fresh pair. Candidate-interface wiring failures remain **unassessed**, not product failures. The legacy `regrade` command and hidden-test inputs are no longer supported.

## Failure and automation behavior

- Exit 0 means the requested command, including automatic finishing for `run`, completed, not that an arm passed its evaluation. Finishing failures exit nonzero and preserve available evidence; they never restart inference.
- Invalid isolation, missing setup dependencies, non-private auth, malformed judge output, and repeated run/judge attempts exit nonzero.
- If an infrastructure fault is discovered after an attempt, record it without discarding evidence: `./dist/codex-ab invalidate --run-dir "$run_dir" --reason "concrete reason"`. Invalidated attempts retain metrics but cannot be judged or produce a winner.
- Commands reject unknown, inapplicable, and repeated options rather than silently changing the requested scope.
- Operations on one run are mutually exclusive, including report generation and invalidation, so concurrent commands cannot overwrite lifecycle state or start duplicate inference. A second command fails while the first owns the run. Normal exit releases the lock. A hard-killed process leaves `.operation-lock`; verify that its process and containers are stopped before manually removing that empty directory to inspect retained evidence. Never use lock removal to resume or restart inference.
- `run.json` is written atomically and is the machine-readable lifecycle record.
- Logs and manifests never contain auth contents. Treat the whole mode-0700 run directory as private because it contains temporary Codex homes and agent patches.

Use `./dist/codex-ab --help` for all flags. For development, run `bun test` and `bun run build`.
