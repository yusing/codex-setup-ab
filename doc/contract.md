# Contract

[README](../README.md) · [Specification](spec.md) · [Contract](contract.md) · [CLI guide](cli.md)

This document defines preparation, isolation, evaluation, reporting, and lifecycle
guarantees. Examples run from the repository root. Comparison treatments are
described in the [specification](spec.md); build and multi-run workflows are in the
[CLI guide](cli.md).

## Arm identities

Reports and operator progress name arms by their actual launcher and setup (for example, `Codex (minimal setup)` versus `Codex + Mekugi (minimal setup)`). Duplicate-output comparisons and historical journal-compaction comparisons include off/on labels. Operator progress reveals the A/B mapping for each reversed-order judge pass; blinded judge/grader inputs still use `candidate-N`, and machine evidence retains those IDs. Legacy CLI selectors and storage paths retain `stock`/`current` keys; custom compositions append numbered arm keys; report JSON includes `arm_labels` for display. Regenerate a report to apply these names to an existing run.

## Prepare an isolated pair

```sh
run_dir="$(./dist/codex-ab prepare \
  --source /home/ubuntu/projects/mekugi \
  --base bb9e740362fd86c9214f5c893c65ae6c46587a60 \
  --forbidden d50b9e6d7a2b01fc033a8aab523791876e4441b5 \
  --task ./task.md \
  --criteria ./criteria.json)"
```

Preparation creates a new mode-0700 `mktemp` directory outside the repository. It shallow-fetches exactly the base commit into a bare seed, makes two `--no-local --no-hardlinks` clones, removes their remotes, and verifies tree identity, the lack of object alternates and linked worktrees, and absence of the future solution commit. Implementation workspaces never receive the solution. A task pack may pin a `source.reference_commit` endpoint for evaluator-only upstream evidence. Preparation freezes the actual ordered commit patches and the combined base-to-endpoint diff from the supplied source repository, with commit IDs and file hashes. The range must descend from the baseline and include the excluded solution commit. Judges can inspect this read-only reference when designing checks and assessing the final result; it does not enter implementation mounts. References are retained in trials and checksummed bundles. Older runs without a reference keep their original inputs.

The current setup starts with a shallow, independent clone of the configuration repository rooted at `--current-home` (default `/home/ubuntu`), with its remote removed. All tracked configuration is included automatically, so adding or removing a guidance file does not require a runner change. Current tracked edits, staged additions, and deletions are overlaid without changing the source checkout. New untracked instruction files must be added to Git before preparation to be included.

For `setup-commits`, supply `--setup-a-commit REF` and `--setup-b-commit REF`
against the configuration repository at `--current-home`. Both references resolve to
commits before preparation. Each arm receives an independent, shallow snapshot of
its revision, with no tracked working-tree overlay. Recorded commit/tree identities,
per-arm manifests, reports, and trial controls identify both setups. Both arms use
the service tier from revision B and the selected launcher (direct Codex by default, or Mekugi), model, reasoning effort,
service tier, task, and pinned runtime binaries/tool store. Reviewer overlays and
asymmetric protected runtime are incompatible with this comparison. Candidate launch
uses the pinned image launchers even when a revision contains an older executable.
Codex configuration symlinks into the setup repository are read from the snapshot
and materialized before adaptation; targets outside the repository are rejected.

For `custom`, supply `--arms` as an ordered JSON array, for example
`[{"launcher":"codex","setup_commit":"stock"},{"launcher":"mekugi","setup_commit":"commit1"},{"launcher":"mekugi","setup_commit":"HEAD"}]`.
`launcher` selects `codex` or `mekugi` (the legacy launcher alias `stock` means `codex`).
`setup_commit` independently selects `stock` for minimal guidance or a Git revision.
Stock setups retain configured mise tool access but omit custom instructions, skills, hooks, and Mekugi configuration.
Each revision arm receives the chosen setup revision;
HEAD means the committed revision, without working-tree edits. At least two arms are
required. Shared model, reasoning, service tier (from the second setup, default for Stock), runtime,
task, and resource controls apply to all arms. Reviewer overlays and protected runtime
are unavailable for this composition. The first two retained keys are `stock` and
`current`; subsequent keys are `arm-3`, `arm-4`, and so on. Each arm has an independent
workspace, home, setup manifest, and launcher identity. Two blind assessment passes
present all candidates in opposite orders. Reports retain every arm and show resource
differences against the first arm; missing evidence never becomes zero usage.

Installed hook binaries, plugins, remote-skill caches, and tool-store sidecars remain
runtime supplements, not historical builds. Revision-owned files are preserved,
except that Mekugi-launched setup-commit snapshots omit the obsolete
`orchestration.reviewers` table from `.config/mekugi/config.toml` for compatibility
with the shared runtime. Other settings remain intact; each affected manifest
records the omission, and the selected configuration commit retains the original.
Missing runtime dependencies fail before inference. A revision does not establish
historical provenance for those installed binaries or fetched skill contents. The
snapshot manifests retain the actual supplied bytes. The source checkout and its
index remain unchanged. Historical stock-control reuse is unavailable for this mode;
prepare a fresh pair or repeat the frozen pair through the existing trial workflow.

To apply a benchmark-only reviewer overlay, add `--review-treatment DIR` with `parent-agents.md`, `review-correctness.toml`, `review-simplify.toml`, and `web-reviewer.toml`. Preparation applies them to the isolated current snapshot after copying the live home, records before/after hashes in the manifest, and leaves active guidance untouched. Omit this option to benchmark the current home without a treatment. Use `--current-launcher codex` to run bare Codex without Mekugi.

Runtime supplements are copied separately: installed hooks, materialized skills, bundled plugins when their temporary cache exists, the referenced remote-skill cache generations, and the existing Modern Go Guidelines provider. Preparation copies mise's migration completion records and the pipx lock sidecars referenced by its lockfile, but does not copy or hard-link its installed tools. Containers use the shared base/dependency image plus a read-only bind mount of the existing host mise tool store. Preparation records its absolute path and file metadata (device, inode, size, mode, and nanosecond modification/change times), without reading or hashing installed-tool contents. Preflight and the final launch check reject changed metadata, including same-size rewrites. This checks that the same host installation is still in place, rather than accepting replacement files with matching contents. Keep that host path available and do not update or remove installed tools while a run or trial set is in use: a read-only container mount does not prevent host-side changes. Trial pairs reuse the same mount without duplicating the store. The obsolete `--snapshot-base` option has been removed. Task dependency caches remain in the shared Docker dependency image. Preflight rejects mise migration failures before agent execution; the tool store stays read-only. The current arm starts Codex through that setup, so every tool declared by the active user configuration is available without network access. Mise and Grok executables are retained at their existing host paths, with captured SHA-256 identities, and mounted read-only only into containers that need them. Keep those executable paths available and unchanged alongside the tool store. Container checks and task preparation resolve Bun through PATH from the pinned base image; the selected host Bun executable remains recorded and verified as preparation provenance, without a separate executable mount or image copy. Preparation copies the selected Mekugi executable pair into the run snapshot and pins both SHA-256 identities. Preflight copies both frozen executables into the shared dependency image at build time and checks their hashes. Host Mekugi updates or removal after preparation do not affect the benchmark. Older prepared runs retain their recorded executable mounts; prepare a new run to use image-pinned Mekugi. `--current-launcher mekugi` selects `--mekugi-bin` (default `~/go/bin/mekugi`) without copying Mekugi state. Other untracked home files, including authentication and session history, are not copied. The source repository is expected to contain only configuration suitable for the benchmark, not tracked credentials or task solutions.

The clone preserves absolute `/home/ubuntu` paths inside its container. `snapshot-manifest.json` records the configuration commit and tree, overlaid tracked paths, a SHA-256 for every regular setup file (excluding Git metadata), literal symlink targets, and portability adaptations. The complete installed-tool metadata manifest is stored as compressed JSON and verified before launch, along with the selected runtime executable hashes. Older uncompressed manifests and copied-binary snapshots remain readable. Preflight requires every configured tool to be present and checks the general setup tools with networking disabled. It additionally exercises the `use-modern-go` remote skill and registered Go-guidelines hook when the task workspace contains `go.mod`. For Mekugi, it checks the selected executable pair and launches `mekugi codex --version` offline, or standalone `mekugi --version` for Grok routing. This checks launcher startup, not a complete model-to-tool request. An incomplete setup fails before inference instead of being silently bypassed.

When mise's Rust installation links to the source home's `.cargo/bin`, preparation
also records metadata for those binaries and the `.rustup` runtime without reading
their contents. Containers mount both read-only, expose Cargo binaries in the
isolated home, and select the captured Rustup runtime. Cargo caches stay private
to each arm. Keep these host runtime paths unchanged too. Mise automatic installs
are disabled against the read-only stores; missing tools must be resolved before
preparing a new run.

Each arm sees only its own clone, caches, and private home. New implementation-agent contexts use neutral task instructions, paths, environment names, and Git branches rather than comparison identifiers. Judges retain their paired inputs. Fresh runs use random session directories for implementation workspaces, active homes, runtime state, and capture exports, including their host-side mount sources. Their mapping is recorded in `run.json`; operator-only logs retain setup labels. Historical records keep their original identities. The shared dependency environment uses `/opt/task-deps`; older prepared inputs require fresh preparation to use the neutral context. The host installed-tool store is mounted read-only into the current arm for `stock-current`, into both arms for `setup-commits`, `stock-mekugi`, `same-setup`, `journal-compaction`, and `duplicate-output`, and into neither arm for `codex-mekugi-grok`. Agent logs and captured patches stay outside its writable mounts. Behavioral criteria are fixed before execution; adaptive checks are authored after both candidates stop and run in separate evaluator workspaces.

Fresh preparation seeds the same repository-local Git author identity in both candidate
clones. The dependency image places the task Python
environment on PATH for direct commands and login shells. Captured Bash login
profiles restore task-Python precedence after user initialization, including
Linuxbrew initialization. Preflight checks both `python` and `python3` through
the copied candidate home and its mise setup offline before inference. Generated minimal Codex configuration omits the
unsupported top-level `network_access` setting; Docker owns network isolation.

When Linuxbrew is available on the preparation host, tool-enabled arms also mount
its installation prefix read-only at the original absolute path. Its file metadata
is recorded and checked alongside mise and Rust, and its bin directories are exposed
on PATH. Keep all mounted installations unchanged while prepared runs use them.
The existing comparison-specific tool access rules apply to Linuxbrew too. Fresh
preparation is required to adopt these environment changes; retained runs are unchanged.

Validate the image and snapshotted dependencies without making a model request:

```sh
./dist/codex-ab preflight --run-dir "$run_dir"
```

Preflight verifies provider reachability over the same kind of temporary, IPv6-capable Docker
network used for inference. Agent pairs and each judge attempt receive run-owned networks that
are removed after their containers stop; offline preparation and evaluation remain on
`--network none`. This supports IPv6-only provider endpoints without using host networking.

## Run and grade both arms

After reviewing `run.json`, start the model runs explicitly:

```sh
./dist/codex-ab run \
  --run-dir "$run_dir" \
  --auth-file /home/ubuntu/.codex/auth.json \
  --confirm-paid-inference
```

The command first checks that the base image exposes the exact Codex version recorded during preparation, its hash-matched code-mode host, and no image-bundled `mekugi`; exercises a real local code-mode execution without model access; and checks the complete current setup offline. Preflight builds or reuses a `codex-ab-deps:<key>` Docker image keyed by the base image ID, source commit/tree, submodules, preparation command, pinned Mekugi hash when selected, and operator identity. Dependency caches and the frozen Mekugi executable enter the final image, not source, homes, credentials, or evaluator controls. Mekugi startup checks and execution use that immutable image without a host Mekugi bind mount. Fresh containers share immutable image layers and get private copy-on-write storage; dependency changes made by an agent never reach another arm, another run, or grading. Each arm materializes its generated workspace assets offline using those cached dependencies. Grading uses the original dependency image offline with a read-only root and a shared immutable build-cache seed; cache writes and execution workspaces stay temporary. Evaluator cache reuse is described in the blind-judge section. Protected execution uses temporary Go build output because its root filesystem is read-only. Ignored `node_modules` directories created during preparation are removed after successful patch capture, unless an agent has tracked them or redirected their path; removed paths are recorded per arm. They can be regenerated from the shared image. The first image build may download dependencies; later matching runs reuse it. Build logs are saved under `artifacts/dependencies.stdout` and `artifacts/dependencies.stderr`, and the immutable dependency image ID is recorded in `run.json`. Keep that image available for later grading or trial runs. Docker images and build cache occupy shared disk space outside the corpus; this does not impose a 1 GB cap on source, tool snapshots, or captured logs. It rejects any preparation that changes either immutable baseline. Only after both preparations pass does it start both arms with the selected model and reasoning effort (defaults: gpt-6-astra and medium) concurrently with identical two-CPU and 4 GiB limits. Preflight and the final launch check verify copied controls, both setup templates, the host installed-tool file manifest, the selected Bun executable, and immutable baseline identity. The image tag is resolved before checking it, and all subsequent containers use that image ID. The default agent timeout is 30 minutes. Both arms use the service tier read from the snapshotted current configuration, and the report records it.

Milestones go to stderr. Timeout or cancellation stops session-created containers and preserves available patches and results. A nonzero agent exit, timeout, cancellation, lifecycle failure, or collection failure leaves execution partial and skips grading and judge inference. The run command exits nonzero after metering and retaining its report bundle. Direct judging and finishing also require successful agent execution, including for older runs marked complete. Runs never restart or resume: prepare a new directory for another attempt. Completed historical reports remain readable.

Semantic assessment requires every configured arm. Historical singleton reports remain descriptive records, not paired comparisons.

After all agents stop, the runner captures tracked, committed, staged, and untracked changes as a binary patch relative to the recorded immutable base. Only then does it create separate evaluator workspaces. Independent semantic passes run the predetermined existing tests and author checks against each candidate's actual interfaces. Git inspection and patch capture run in separate offline containers, never on the host. Agent and grader times remain separate.

For Mekugi's original router task, use the `mekugi` profile and explicitly select `--current-launcher mekugi` with `--mekugi-bin`. Historical result bundles retain their recorded image names and identities. Historical source snapshots may still use the `hpatch:core/v1` plugin ABI; preparation supports it without rewriting benchmark source.

## Protected Mekugi runtime

Add `--protect-mekugi` to preparation with `--mekugi-source` or `--mekugi-build`, and use an image
rebuilt from the current Dockerfile. Preflight uses the runner-bundled isolation scripts snapshotted into the run:
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
  "evaluator_guidance": "optional fixed runtime/setup guidance for adaptive harnesses",
  "qualification": "not-run"
}
```

Write and review the criteria from the task **before** running either candidate. Only add
`required_interface` to a criterion when the task explicitly fixes that public interface.
Preparation records and verifies the contract hash and task binding. An optional `allowed_paths` array enforces exact file boundaries only when the task requires them. The `task` profile uses
these commands rather than repository-specific Go targets. Commands run inside containers,
not on the host. Prepare dependencies without introducing evaluator-only checks into agent
workspaces; evaluator build storage stays separate.

After all agents stop and their patches are captured, two blind passes inspect candidates in
opposite orders and run concurrently. Each pass runs the predetermined existing tests, then asks
Sol to author additional checks adapted to the actual candidate interfaces. The runner executes
those checks offline, without credentials or a Docker socket, against private copies of read-only
candidate source. Sol then reviews the source together with the executed evidence and returns the
scores, per-criterion decisions, issues, and winner for that pass. The runner rejects harness files
that overwrite candidate files and detects changes to original files.

A judge may repair a broken harness once per pass, including a failed check whose wiring was wrong.
Repairs are limited to each candidate's failed or unassessed criteria; a resubmitted check for an
earlier pass is ignored, and the passing evidence stands.
Harnesses must use the runtime required by the inspected entry point. Evaluator-owned setup mistakes,
such as a wrong interpreter, invented entry point, or missing harness-only dependency, must be
reported as `HARNESS_ERROR`; candidate errors reached through documented supported setup remain
behavioral evidence. Ordinary assertion failures are reserved for checks that reached the target
behavior.
Earlier evidence remains available to the final assessment; real behavior failures must not be
weakened into passes. Different names and test wiring are allowed; different required outcomes are
not. Compilation or setup failures caused by assumed names, runtimes, or entry points remain
**unassessed**, not automatic candidate failures. A missing explicitly required public interface
can be a source-only defect. An unsupported source-only failure becomes unassessed instead of aborting judgment.
An executed failure must be supported by a failed check for that same criterion. If its check
passed or could not assess the behavior, the failure label becomes unassessed and retains the
judge's observation. Failures from other criteria remain separate evidence. Passing requires executed evidence plus the judge's assessment that the
check actually covers the criterion. Both passes, disagreements, source, commands, outputs and
repair attempts are retained.

Prewritten hidden tests are no longer supported. Supply behavioral criteria, not evaluator source. Semantic assessment requires every configured arm and cannot restart a started assessment.

Harness authoring, an optional repair, and final assessment each have their own recorded model
attempts, with the existing capacity-only retry policy. Model usage and timing remain separate
from offline check time. No semantic model request occurs during `prepare` or `preflight`;
`run`, `judge` and `finish` still require `--confirm-paid-inference`.

## Blind judge

The `run` command performs blind semantic assessment automatically after all candidates are captured. For a complete pair with criteria and no judge attempt:

```sh
./dist/codex-ab judge --run-dir "$run_dir" --confirm-paid-inference
```

The gpt-6.1-sol judge uses high reasoning and the fast service tier. It receives the task, anonymous patches, changed-file lists, bounded output summaries, and complete read-only evaluator evidence under `/evidence`, plus anonymous evaluator source directories for inspecting affected contracts and callers. It does not receive arm labels, costs, agent logs, or either agent's writable filesystem. Task packs with a pinned upstream reference also mount its frozen commit patches and combined diff read-only under `/reference`. Both stages use them to establish task-scoped behavior while accepting equivalent designs and safe improvements; source comparison does not replace executed criterion evidence. The judge assesses final candidate trees, not commit-by-commit correspondence. Two independent homes containing only the minimal Codex configuration judge opposite presentation orders; they do not copy the task agents' mise runtime. Each pass uses two stages when its first harness succeeds or three when one repair stage is needed, with up to three capacity attempts per stage. Each assessment returns validated JSON scores for correctness (50%), completeness (20%), maintainability (20%), and test quality (10%), plus evidence, issues, and a winner. Critical findings override totals; a candidate that failed any required gate cannot win. Disagreement is reported rather than forced into consensus. Large logs stay retained and inspectable without being duplicated into the prompt. Oversized patches or summary packs still fail explicitly. Historical reports retain their recorded judge metadata. When judging an older run whose saved prices lack gpt-6.1-sol, the judge records a separate fallback rate for its own usage without changing the run's original pricing snapshot or trial controls.

Judging verifies retained inputs and uses the pinned images. It does not require
unused host tool installations to remain unchanged after candidate execution.
Candidate preflight and launch retain their full live-runtime checks.

Harness authors write their complete check plan to a retained, attempt-specific
artifact and return its reference. Repairs and assessments inspect full check
source through retained evidence instead of receiving duplicated source bodies.
Recovery continues both presentation orders concurrently and replays completed
stages, including historical inline plans, without another model request.
New judge requests, including recovered stages, use the fast service tier;
each new attempt records its tier. Historical attempts retain their metadata.
Judge cost estimates use recorded model list rates; fast-tier surcharges are
not included.
Offline evaluator checks across both candidates and passes reuse the same
prewarmed Go build cache from the pinned baseline and the Bun dependency cache
seed in the pinned dependency image. Baseline cache warming runs once offline
before both passes, compiling without running baseline tests. Warming is optional
and bounded to two minutes or the shorter run timeout; partial cache entries
remain reusable after a timeout. Cancellation still stops the operation.
Each evaluator makes a private writable copy, using copy-on-write cloning where
available. Candidate code cannot change another check's cache. Cache writes stay
outside report bundles and credential-bearing judge containers. Candidate source
copies, outputs, and temporary execution workspaces remain separate.

Capacity errors retry automatically within the active judge command, with at most three launches per stage and 5-second and 15-second delays. Each launch gets a fresh isolated home and distinct logs; the state and report retain every attempt and its usage. A completed stage is never repeated.
Cancellation interrupts the delay and prevents another launch. Other failures, timeouts, invalid
verdicts, and exhausted retries stop with the available evidence preserved. There is no automatic
model substitution or conversational-agent fallback. Once the command exits, it cannot restart a
judge attempt; historical failed attempts remain unchanged. The exception is an explicit `finish --recover-judge` for a judge that timed out, or failed on a validation rule the current runner handles without failing: an unsupported source-only or executed failure, or a harness repair that resubmitted a successful check. Recovery also supports setup-commit judges that exited before producing output because their inherited setup configuration referenced an unavailable model-instructions file. The retained configuration and startup diagnostic must establish that specific failure; fresh judge homes use independent minimal configuration. Recovery requires completed existing tests in both passes, no recorded pass, no running attempt, and no partially executed evidence round. It archives the failed bundle, reuses completed existing-test evidence and evidence rounds, replays every completed judge stage's recorded response under current validation, and launches fresh attempts only for stages that never completed. Prior attempts and their usage remain recorded. Recovery does not resume an interrupted model conversation, change the timeout, or restart either A/B agent; another failure remains a failed finishing attempt.

## Report

```sh
./dist/codex-ab report --run-dir "$run_dir"
```

Source-assessment rationales explain the decisive implementation cause and its
observed effect in a short comparison. Detailed evidence, criterion decisions,
and issues remain retained. Quality judges stay blind to agent logs and costs.
Report generation explains token and request differences from existing usage
and visible workflow evidence without another model request. Unknown request
counts, opaque work, and unsupported causal explanations remain unknown.

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

The runner automatically writes `reports/report.md`, `reports/report.json`, and a checksummed `reports/bundle/` after execution, including partial runs. The bundle contains setup identities, task and evaluator controls, captured patches, interaction and role audits, source assessment, paired comparison, semantic check results, and integrity checks. Encrypted interaction content remains unknown; command waits are counted separately from reviewer-status polling. The standalone `report` command refreshes the standard report and an existing finishing bundle without starting inference. Readable rejected judge responses are retained separately as unvalidated evidence, never as an eligible winner. It includes raw, uncached, cached, cache-write, output, reasoning-output, and total tokens for root and child agents; estimated public-list API cost; command time; agent and grader wall time; gate status; B-minus-A percentages; both raw judge passes; and a separate judge cost. Pricing is fetched and snapshotted once per run, with source, timestamp, assumptions, and warnings. If usage or required checks are incomplete, the report shows no overall winner. An assessed criterion failure in either pass settles that arm's failed grade even when the other pass left criteria unassessed; a winner still needs complete checks in both passes. When both candidates fail, neither wins; the report explains why and separately identifies the faster and lower-estimated-cost arms without declaring a quality winner.

Validated Mekugi exports also report compaction answerer, provider cost and cost
from the first compaction onward, excluding prewarm. Older exports without
answerer evidence remain unknown, not provider-answered. Router answers with no
provider attempts show zero provider tokens, not a savings estimate. The JSON
usage evidence retains each thread's latest cumulative journal counters and its
tracking start; snapshots are not added together across requests. Missing counts
remain unknown. Journal counters and router compaction answerers describe historical
exports; new runs use Codex-owned compaction. Retired journal comparisons remain
reportable but cannot be launched, including from previously prepared inputs.
Removed Mekugi flags in prepared inputs require fresh preparation before execution.
Current byte-only v7 exports reconcile transport bytes and provider usage without
inventing semantic/token estimates or tool aggregates. Historical v6/v7 exports
retain their original calculation checks.
New preparations freeze both `mekugi` and its adjacent `mekugi-exec` companion,
verify their hashes, and include both identities in the dependency image key.

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
unknown. Cache diagnostics split the first metered request per thread from later requests,
including captured retries, and show their contributions to the uncached-input gap. Model
switches do not restart that split. Captured prewarm usage and cost appear separately from
paired task totals; direct Codex prewarm remains unknown, not zero. These are task-only costs,
not startup-inclusive session costs. Cache counts locate a difference but cannot prove its
cause or validate a transport fix without a fresh controlled run.
Tool intervals end at the first matched output and are unioned within each session,
not added across overlapping agents. Additional or unmatched outputs mark timing partial.
A report refresh requires no model calls. The numbers locate observed overhead, but do not infer
causal blame for a specific instruction or launcher, decode encrypted messages, or replace
source-quality inspection. Missing judge-attempt usage remains unknown even if a later attempt
succeeds; the report never fabricates a complete cost or overall winner.

If execution completed but finishing failed before a judge request, fix the reported issue and use `finish --run-dir DIR --confirm-paid-inference`. It archives the failed bundle, preserves the same candidates and grades, runs only a not-yet-started judge, and regenerates the report bundle. It never restarts either A/B agent. A completed judge can be reused when only artifact generation failed. For a judge timeout, the supported configuration-startup failure, or supported judge validation failures, add `--recover-judge` to continue the incomplete judge as described in the [judge contract](contract.md#blind-judge).

For post-hoc troubleshooting deductions, use `remeter --run-dir DIR --exclusions FILE`. The JSON file contains `arm` (a retained arm key, such as `stock`, `current`, or `arm-3`), `rationale`, and `responses` and `commands` arrays of `{ "id": "...", "reason": "..." }`. IDs must match recorded response and command IDs. The command writes a separate `reports/remeter-*/` accounting report using the recorded pricing, retaining the original run and reports. It does not rerun agents, rewrite later context usage, or claim an adjusted wall time.

If an evaluator infrastructure fault prevents assessment outside the supported recovery cases, retain the failed evidence, fix the fault, and prepare a fresh pair. Candidate-interface wiring failures remain **unassessed**, not product failures. The legacy `regrade` command and hidden-test inputs are no longer supported.

## Failure and automation behavior

- Exit 0 means the requested command, including automatic finishing for `run`, completed, not that an arm passed its evaluation. Finishing failures exit nonzero and preserve available evidence; they never restart inference.
- Invalid isolation, missing setup dependencies, non-private auth, malformed judge output, and repeated run/judge attempts exit nonzero.
- If an infrastructure fault is discovered after an attempt, record it without discarding evidence: `./dist/codex-ab invalidate --run-dir "$run_dir" --reason "concrete reason"`. Invalidated attempts retain metrics but cannot be judged or produce a winner.
- Commands reject unknown, inapplicable, and repeated options rather than silently changing the requested scope.
- Operations on one run are mutually exclusive, including report generation and invalidation, so concurrent commands cannot overwrite lifecycle state or start duplicate inference. A second command fails while the first owns the run. Normal exit releases the lock. A hard-killed process leaves `.operation-lock`; verify that its process and containers are stopped before manually removing that empty directory to inspect retained evidence. Never use lock removal to resume or restart inference.
- `run.json` is written atomically and is the machine-readable lifecycle record.
- Logs and manifests never contain auth contents. Treat the whole mode-0700 run directory as private because it contains temporary Codex homes and agent patches.

Use `./dist/codex-ab --help` for all flags.
