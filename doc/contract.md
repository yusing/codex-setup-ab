# Contract

[README](../README.md) · [Specification](spec.md) · [Contract](contract.md) · [CLI guide](cli.md)

This document defines preparation, isolation, evaluation, reporting, and lifecycle
guarantees. Examples run from the repository root. Comparison treatments are
described in the [specification](spec.md); build and multi-run workflows are in the
[CLI guide](cli.md).

## Arm identities

Reports and progress use launcher/setup labels, including treatment off/on labels.
Machine keys remain `stock`, `current`, then `arm-3`, etc.; JSON exposes `arm_labels`.
Judge inputs use anonymous `candidate-N` IDs. Operator progress reveals each pass's
mapping, not to the judge. Regenerate an existing report to apply display labels.

## Prepare an isolated pair

```sh
run_dir="$(./dist/codex-ab prepare \
  --source /home/ubuntu/projects/mekugi \
  --task-pack ./tasks/session-retention/manifest.json)"
```

Preparation creates a private mode-0700 directory outside the repository and
independent base-only clones without remotes, alternates, linked worktrees, or
hardlinks. It verifies tree identity and absence of the excluded solution commit.
A pack's `source.reference_commit` pins evaluator-only ordered patches and the
combined diff, with IDs and hashes. Its ancestry must descend from the baseline
and include the excluded commit. References survive trials/bundles but never enter
implementation mounts; older runs without references keep their original inputs.

The current setup is an independent shallow clone of `--current-home` (default
`/home/ubuntu`), without its remote. It includes all tracked configuration plus
tracked edits, staged additions, and deletions, without modifying the source or
index. Add untracked guidance to Git before preparation to include it.

For `setup-commits`, supply `--setup-a-commit REF` and `--setup-b-commit REF`
against the configuration repository at `--current-home`. Both references resolve to
commits before preparation. Each arm receives an independent, shallow snapshot of
its revision, with no tracked working-tree overlay. Recorded commit/tree identities,
per-arm manifests, reports, and trial controls identify both setups. Both arms use
the service tier from revision B, the selected launcher (direct Codex by default,
or Mekugi), task, and pinned runtime binaries/tool store. Model and reasoning
controls are defaults that explicit per-arm settings can override. Reviewer overlays and
asymmetric protected runtime are incompatible with this comparison. Candidate launch
uses the pinned image launchers even when a revision contains an older executable.
Codex configuration symlinks into the setup repository are read from the snapshot
and materialized before adaptation; targets outside the repository are rejected.

For `custom`, supply `--arms` as an ordered JSON array, for example
`[{"launcher":"codex","setup_commit":"stock"},{"launcher":"mekugi","setup_commit":"commit1"},{"launcher":"mekugi","setup_commit":"HEAD"}]`.
`launcher` selects `codex` or `mekugi` (the legacy launcher alias `stock` means `codex`).
`setup_commit` independently selects `stock` for minimal guidance, `worktree` for
the tracked working tree at `--current-home`, or a Git revision.
Stock setups retain configured mise tool access but omit custom instructions, skills, hooks, and Mekugi configuration.
Each revision arm receives the chosen setup revision;
HEAD means the committed revision, without working-tree edits. A worktree arm overlays
tracked edits, staged additions, and deletions on its HEAD, and its manifest records
the changed paths and captured files. At least two arms are
required. Model, reasoning and resource controls supply defaults. Optional `--arm-settings`
JSON maps arm keys to independent `model`, `reasoning_effort`, `cpus`, `memory`,
`timeout_seconds`, `auto_compact_limit`, `parallel_work`, `mekugi_flags`, and
`skills` selections. The same per-arm settings are available for other comparisons.
Task, service tier (from the second setup, default for Stock), and pinned runtime
binaries remain shared. Skills map names in the selected setup registry to booleans;
unchanged selections retain their setup defaults and conditions. Overrides change
only the disposable runtime home, leaving the host and frozen setup intact.
These are setup-level skills-mgr selections; repository-local selections retain
the manager's normal precedence. Per-arm parallel work appends the existing
delegation request to that candidate's prompt, retained with its artifacts. Reviewer overlays and protected runtime
are unavailable for this composition. The first two retained keys are `stock` and
`current`; subsequent keys are `arm-3`, `arm-4`, and so on. Each arm has an independent
workspace, home, setup manifest, and launcher identity. Two blind assessment passes
present all candidates in opposite orders. Reports retain every arm and show resource
differences against the first arm; missing evidence never becomes zero usage.

`--runtime-home` optionally selects a separate home for installed tools, hook binaries,
plugins, remote-skill caches, and tool-store sidecars; it defaults to `--current-home`.
This allows a configuration worktree to use an existing installation without copying
the installation into that worktree. Those files remain
runtime supplements, not historical builds. Revision-owned files are preserved,
except that Mekugi-launched setup-commit snapshots omit the obsolete
`orchestration.reviewers` table from `.config/mekugi/config.toml` for compatibility
with the shared runtime. Other settings remain intact; each affected manifest
records the omission, and the selected configuration commit retains the original.
Missing runtime dependencies fail before inference. A revision does not establish
historical provenance for those installed binaries or fetched skill contents. The
snapshot manifests retain the actual supplied bytes. The source checkout and its
index remain unchanged. Legacy `--control-run` reuse is unavailable for setup
revisions; use `--import-arms` for historical comparisons, or repeat the frozen
comparison through the existing trial workflow.

`--review-treatment DIR` overlays `parent-agents.md`, `review-correctness.toml`,
`review-simplify.toml`, and `web-reviewer.toml` only in the isolated setup, recording
before/after hashes. Omit it to preserve the selected setup. `--current-launcher
codex` selects bare Codex.

Runtime supplements include installed hooks, materialized skills, available bundled
plugins, referenced remote-skill generations, Modern Go Guidelines, mise migration
records, and referenced pipx lock sidecars. Untracked authentication, sessions, and
Mekugi state are excluded. Tracked setup files must contain no credentials or task
solutions.

Installed tools are not copied or hardlinked. Tool-enabled containers mount the
host mise store read-only at its recorded absolute path. Preparation records
device, inode, size, mode, and nanosecond mtime/ctime without hashing payloads;
preflight and launch reject drift, including same-size rewrites. Matching content
in a replacement installation is not sufficient. Keep host stores unchanged while
runs/trials use them. Read-only container mounts do not prevent host updates.
`--snapshot-base` is removed; task caches belong in shared dependency images.

Mise and Grok executables are hash-pinned read-only host mounts where needed.
The selected host Bun is verified as provenance, but containers resolve Bun from
the pinned image's PATH. Selected Mekugi and adjacent `mekugi-exec` are copied into
the snapshot, hashed, and embedded in the dependency image; later host changes do
not affect them. Older runs retain their original executable mounts. The default
`--mekugi-bin` is `~/go/bin/mekugi`; selecting it does not copy Mekugi state.

Containers preserve `/home/ubuntu` paths. `snapshot-manifest.json` binds the setup
commit/tree, tracked overlays, regular-file hashes, literal symlink targets, and
portability adaptations, excluding Git metadata. Compressed installed-tool
metadata and runtime hashes are verified before launch; older uncompressed and
copied-binary snapshots remain readable.

Preflight checks immutable inputs, runtime identities, offline configured tools,
readable configuration, writable homes, Git identity, task interpreters/dependencies,
and provider reachability. It does not load skills, run guidance hooks, require
optional guidance tools, or execute task evaluation tests. Dependency preparation
may compile during image construction; preflight does not repeat it as baseline
qualification. Mekugi checks use its pinned pair and `mekugi codex --version`, or
`mekugi --version` for Grok routing. Missing requirements fail before inference.

When mise's Rust installation links to the source home's `.cargo/bin`, preparation
also records metadata for those binaries and the `.rustup` runtime without reading
their contents. Containers mount both read-only, expose Cargo binaries in the
isolated home, and select the captured Rustup runtime. Cargo caches stay private
to each arm. Keep these host runtime paths unchanged too. Mise automatic installs
are disabled against the read-only stores; missing tools must be resolved before
preparing a new run.

Arms have independent writable workspaces, homes, and caches. Implementation
contexts use neutral prompts, paths, environment names, and Git branches; random
session paths and their operator-only mapping are recorded in `run.json`.
Dependency environments use `/opt/task-deps`; older inputs need fresh preparation
for neutral paths. Judges retain comparison context.

The host tool store reaches current only in `stock-current`, both arms in
`setup-commits`, `stock-mekugi`, `same-setup`, historical `journal-compaction`, and
`duplicate-output`, and neither in `codex-mekugi-grok`. Logs and patches stay outside
candidate-writable mounts. Criteria are fixed before execution; adaptive checks
are authored after candidates stop and run in separate evaluator workspaces.

Fresh unprotected Codex implementation and judge homes use private Docker copy-on-write
layers from immutable setup images. Model-free plugin reconciliation prefetches shared
account-visible runtime inputs; normal launcher refresh behavior remains enabled.
Original setup snapshots, live logs, sessions, authentication, and SQLite state
remain ordinary private host files. Other home changes are retained in immutable
Docker images recorded in `run.json`, including after failure or cancellation.
Keep those images available alongside the dependency images. To inspect a saved
home, create a stopped container from its recorded image ID and use `docker cp`
to copy `/home/ubuntu` into a separate private inspection directory. Authentication
and live-state bind mounts are excluded from image snapshots. If image capture
fails, the stopped owned container is retained and the failure identifies it;
its writable layer is not discarded. Grok, protected runtime, and older prepared runs
retain their host-mounted homes.

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
network used for inference. Each candidate arm has a separate run-owned Docker network;
each judge attempt also has its own network. These networks are removed after their
containers stop. Offline preparation and evaluation use `--network none`.
The candidate policy is explicitly `online-unrestricted`, with `closed_book: false`:
there is no runner-enforced provider destination allowlist. Removing reference commits
from the initial checkout does not establish that solutions are unavailable online.
Reports record this policy and the separate-arm connectivity boundary. This supports
IPv6-only provider endpoints without using host networking.

Preflight has its own persisted phase status and diagnostics. A failed check leaves
candidate execution and source assessment unstarted. Launch still retains an available
failure report and evidence bundle, then exits nonzero. Report finishing records whether
assessment and artifact finalization succeeded independently of an earlier execution or
preflight failure.

## Run and grade both arms

After reviewing `run.json`, start the model runs explicitly:

```sh
./dist/codex-ab run \
  --run-dir "$run_dir" \
  --auth-file /home/ubuntu/.codex/auth.json \
  --confirm-paid-inference
```

Before inference, preflight checks the recorded Codex version and companion hashes,
absence of image-bundled Mekugi, a real model-free Code Mode execution, setup
integrity, and configured tools. It resolves the image tag once; subsequent
containers use the immutable ID.

The shared `codex-ab-deps:<key>` image binds the base image, source commit/tree,
submodules, preparation command, selected Mekugi hashes, and operator identity.
It contains dependency caches and frozen Mekugi binaries, not source, homes,
credentials, or evaluator controls. The first build may download dependencies;
matching runs reuse it. Build diagnostics are retained under
`artifacts/dependencies.stdout` and `.stderr`; keep recorded images for later
checks/trials. Shared Docker storage does not impose a 1 GB corpus/log limit.

Arms materialize generated assets offline, using private writable layers over
that image. Preparation must not alter immutable baselines. Declared regenerable
`node_modules` directories are excluded from capture unless they contain tracked
source; exclusion does not delete candidate files. Protected execution uses
temporary build output. Grading uses read-only inputs and private layers over
immutable dependency/cache seeds, never another arm's changes.

Both preparations must pass before candidates launch, concurrently by default.
Defaults are Astra, medium reasoning, two CPUs, 4 GiB, and 30 minutes, subject to
preset and explicit per-arm settings. Service tier comes from the selected setup
and is recorded. Final launch rechecks controls, setup templates, mounted tools,
Bun provenance, and baseline identity.

Mekugi arms use `mekugi codex headless --yolo` (without `codex` for third-party
routing), admitting Main and its children through Mekugi's server-owned runtime.
Stock arms retain `codex exec --json`. Both receive the task on stdin and run in
the isolated workspace with their selected model, reasoning and resource controls
and the shared service tier. Both explicitly bypass hook trust for the captured setup; Mekugi carries
that override through admitted thread startup, independently of `--yolo`.
Mekugi stdout retains host JSONL and its final logical-completion event;
intermediate host turns for coordination do not finish the arm. Select a build
with admitted headless support; older retained measurements keep their original
execution path and are historical evidence, not reruns of this path.

Milestones go to stderr. Timeout or cancellation stops session-created containers and preserves available patches and results. A nonzero agent exit, timeout, cancellation, lifecycle failure, or collection failure leaves execution partial and skips grading and judge inference. The run command exits nonzero after metering and retaining its report bundle. Direct judging and finishing also require successful agent execution, including for older runs marked complete. Runs never restart or resume: prepare a new directory for another attempt. Completed historical reports remain readable.

Semantic assessment requires every configured arm. Historical singleton reports remain descriptive records, not paired comparisons.

`reevaluate --run-dir SOURCE` creates a new comparison containing every arm of a
completed, infrastructure-valid published source. It verifies the source bundle,
preserves the original evidence, imports the captured implementations and their
measurements, and uses the pinned preparation inputs and images for fresh evaluator
checks and both blind judging passes. It performs no implementation-agent calls.
Any source isolation preflight evidence remains historical; reevaluation does not
repeat implementation preflight.
New judging has its own usage and costs, and may change functional assessments as
well as scores. `--output-parent` selects the parent of the new evidence directory (default `/var/tmp`);
`--confirm-paid-inference` is required. Incomplete or invalid sources are rejected
before paid inference. This is a new evaluation, not a restart of the source run.

`launch` and `run` accept `--import-arms`, a JSON array of mappings with
`target_arm`, `run_dir`, and `arm`. Each mapping fills an existing comparison slot
from a completed, infrastructure-valid published adaptive run. An optional `bundle_sha256`
pins its bundle manifest; otherwise the harness captures the current manifest hash.
Targets must be distinct and leave at least one fresh arm. Imported results retain
their source setup labels, execution times, logs, rollouts, and available provider
accounting. Task, baseline, criteria, model, reasoning, service tier, base images, Codex
binaries, resource limits, and timeout must match; setup and launcher treatments
may differ. Evidence is verified and copied before candidate inference. Evaluation
mode `reuse` preserves imported grades and per-pass scores and assessments;
`fresh` grades and blindly assesses all patches together. Active and archived session
rollouts retain their namespaces and checksums. Before any repricing, import remeters
the retained evidence against the source pricing and checks the original reported
totals and coverage. Original measurements and verification results remain in
`accounting-verification.json`; repricing uses the new snapshot separately. When
the target has no pricing snapshot yet, its pricing hash and repricing comparison
are recorded as `null`; source accounting is still verified. Old
rollout or accounting schemas and missing trusted capture provenance are rejected.
Unknown current-format usage remains unknown and cannot establish complete accounting.
Sources remain unchanged and the new run
retains provenance and measurement evidence independently of their directories.
Imports cannot be combined with `--arm`, legacy `--control-run`, or repeated-trial
launches. Use one comparison per launch for historical imports.

`--evaluation-mode reuse|fresh` selects evaluation behavior. Imports default to
`reuse`; runs without imports use `fresh`. `--evaluation-baselines` is a JSON object
mapping each fresh arm key to an imported target slot. Omitted mappings default to
the last imported slot. Reuse requires completed two-pass historical assessments
and retained per-criterion and existing-test evidence, verified before inference.
Historical evaluation inputs are copied into the new bundle and remain usable
after source directories move.

For each fresh arm and pass, the judge starts from its baseline's final tests and
assessment. It may change interface calls, fixtures, and implementation-specific
wiring while retaining the same behavioral requirements, assertions, and failure
conditions. Adaptation rationales, original checks, adapted checks, and execution
evidence are retained. No imported candidate is regraded or rescored. The new
assessment checks coverage against the historical intent; broken harnesses remain
unassessed. Historical scores do not establish outcomes for a fresh candidate.
Reuse rankings compare eligible frozen and new weighted scores within each pass
only when every candidate uses the same rubric and each eligible candidate has a
complete numeric total;
an overall winner requires agreement across passes. Mixed rubrics or incomplete
scores retain the individual results without a quality ranking. These are historical score
rankings, not fresh joint blind judgments; prior comparative verdicts remain in
their source evidence rather than being transferred to the enlarged comparison.

The results-only `reevaluate` command is the exception to imports requiring a fresh
implementation: it imports exactly all configured arms and always uses fresh
evaluation. Ordinary launch/run imports retain their fresh-arm requirement.

New source assessments score correctness, simplicity, completeness, implementation
performance, maintainability, approach, and test quality. Their weights are defined
under [Blind judge](#blind-judge). Simplicity, performance, and approach also record
`satisfactory`, `concern`, or `unassessed`, an evidence
basis (`source`, `executed`, or `none`), and a concise explanation with concrete
evidence or the missing coverage. A substantive conclusion needs source or
executed evidence; absent evidence remains unassessed. An unassessed aspect has a
null numeric score and leaves the weighted total unavailable. Missing evidence is
neither zero nor a reason to redistribute its weight. Functional criteria remain
separate from these scoring dimensions.

Simplicity considers necessary scope, abstraction and state cost, duplication,
and disproportionate implementation or test weight without treating line count
as a verdict. Performance considers work, allocation, I/O, and scaling on the
changed paths; source-based risks are distinct from measured behavior and from
the agent's benchmark command time. Approach considers the established cause,
consumer and ownership fit, supported mechanisms, and material tradeoffs against
simpler viable alternatives. These checks assess the requested outcome without
adding unrelated features or requiring speculative optimizations.

Reuse preserves any recorded aspect assessments along with historical scores.
Historical candidates without them are explicitly unassessed for these aspects;
their original four-component scores and totals retain the original rubric.
Neither fresh findings nor missing historical evidence become historical passes.
Only fresh candidates receive new scores and aspect assessments in reuse mode.
Reports identify each candidate's rubric alongside its scores and evidence,
separately from functional acceptance.

Runtime dependency images embed Mekugi binaries. Their IDs may differ when both
recorded build keys match the current recipe and differ only in launcher-binary
inputs; base image, task dependency preparation, source, submodules, and execution
user must still match. This verifies shared preparation inputs, not byte-identical
dependency outputs across rebuilds. An image change under an unchanged build key
is rejected. Import errors name the mismatched controls.

The workbench's **Compare against HEAD** action creates an editable draft with
all completed source arms plus one fresh configuration-repository HEAD arm.
It copies task and execution controls, uses the last source arm's Codex or Mekugi
launcher for the fresh arm, and resets inference consent. Catalog task packs must
match the retained snapshot; changed packs, modified pack prompts, and shared
compaction limits require manual configuration. Draft creation performs no inference
and leaves source evidence unchanged. Full import verification still runs before execution.

After all agents stop, the runner captures the actual filesystem as a binary patch
relative to the immutable base. The offline collector receives a read-only candidate
mount and trusted seed; only a fresh, dedicated capture destination is writable.
Candidate Git configuration, filters, hooks, external diffs, and replace refs cannot
choose the captured bytes. Capture includes ignored new source files and preserves
binary contents, executable modes, and raw symlink targets. Only declared regenerable
preparation directories are excluded, and tracked source within them is retained.
Pinned submodule identities and contents remain immutable.

`codex-ab.candidate-manifest.v1` records file identities, modes, sizes, the resulting
Git tree, exclusions, changed paths, and patch hash. The runner independently checks
that manifest and the fresh evaluator reconstruction against the retained patch and
immutable base before grading. Imports require the current trusted capture manifest
and v2 rollout/accounting schemas; missing or old provenance is rejected. Git inspection
and patch capture run in offline containers. Agent and grader times remain separate.

For Mekugi's original router task, use the `mekugi` profile and explicitly select `--current-launcher mekugi` with `--mekugi-bin`. Historical result bundles retain their recorded image names and identities. Historical source snapshots may still use the `hpatch:core/v1` plugin ABI; preparation supports it without rewriting benchmark source.

## Protected Mekugi runtime

Add `--protect-mekugi` to preparation with `--mekugi-source` or `--mekugi-build`, and use an image
rebuilt from the current Dockerfile. Preflight uses the runner-bundled isolation scripts snapshotted into the run:
a real router starts, its executor can reach only assigned family listeners, capture/runtime mounts are
read-only, and private Code Mode execution must work without inference.
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
  "retained_tests": {"patterns": ["*_test.go"], "command": "optional baseline test command"},
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

A judge may repair an explicitly broken harness or missing coverage once per pass.
Repairs are limited to each candidate's unassessed criteria; resubmitted passing or
failing behavioral checks are ignored and their evidence stands. If there are no
unassessed criteria, no repair-model request is made. A final source assessment can
identify a wrongly wired ordinary failure as unassessed, but cannot replace its
assertions with a passing check in that run.
Harnesses must match the inspected interface's runtime. The
[verification protocol](verification.md#independent-observations-and-assertions)
owns trusted completion, failure provenance, dependency declarations, and output
bounds; [repair invariants](verification.md#repair-invariants) freeze case obligations.

Assumed names, runtimes, or entry points causing setup failure remain unassessed.
A missing explicitly required interface can be a source-only defect; unsupported
source-only failures become unassessed. An executed failure needs a failed check
for that criterion, not another criterion's result. Passing requires completed
supervisor assertions, qualified frozen controls, and the judge's assessment of
coverage. Raw probes remain visible when qualification fails. Both passes,
disagreements, source, commands, output, and repairs are retained; reversed orders
check presentation bias, not independent ground truth. Candidate-file mutations
report before/after hashes or modes for up to 100 paths, plus the total count.

`retained_tests` is optional. Each pass then also runs its command in a scratch copy of every
candidate in which files matching the patterns (shell-style, where `*` also matches `/`, never
inside `.git`) are replaced by the baseline commit's matching files; the candidate's own matching
files are removed first. Declare it only when the baseline files pass unchanged against the
reference endpoint. A failure is evidence that retained behavior regressed or that the candidate
edited expectations the task did not require changing. A nonzero retained-test command is recorded without classifying its cause from compiler
wording; source assessment must distinguish regression from incompatible test wiring. The result is shown to the
judge, recorded as `pass-N-retained`, and reported, but it is not a criterion and does not change
the existing-test gate, eligibility, or a decided grade.

Adaptive semantic grading uses behavioral criteria and frozen evaluator controls.
The separate [fixed-verifier mode](fixed-verifier.md) executes a pinned original
benchmark verifier and reports its reward independently of adaptive source quality.
Generic imports and evaluation reuse do not yet support configured fixed-verifier
runs. Semantic assessment requires every configured arm and cannot restart a started
assessment. See [verifier completion and qualification](verification.md) for the
supported observation protocol, control schema, repair invariants, and migration
requirements for existing task packs.

Harness authoring, an optional repair, and final assessment each have their own recorded model
attempts, with the existing capacity-only retry policy. Model usage and timing remain separate
from offline check time. No semantic model request occurs during `prepare` or `preflight`;
`run`, `judge`, `finish`, and `reevaluate` require `--confirm-paid-inference`.

## Blind judge

The `run` command performs blind semantic assessment automatically after all candidates are captured. For a complete pair with criteria and no judge attempt:

```sh
./dist/codex-ab judge --run-dir "$run_dir" --confirm-paid-inference
```

The judge uses gpt-6.1-sol, high reasoning, and default service tier. It receives
the task, anonymous patches/change lists, bounded summaries, and full read-only
`/evidence` and candidate trees. Pinned references appear under `/reference`.
It sees no arm labels, costs, agent logs, or candidate-writable filesystem.
Reference behavior defines task scope, not commit correspondence; equivalent
designs and safe improvements are allowed, but source comparison cannot replace
executed evidence.

Two independent restricted homes judge opposite orders. Each pass has authoring,
one optional repair, then assessment, with at most three capacity launches per
stage. Validated scores range 0–5; weights are correctness 25%, simplicity 25%,
completeness 20%, implementation performance 12%, maintainability 10%, approach 4%,
and test quality 4%, producing a complete total of 0–100. Historical four-axis
rubrics retain 50/20/20/10 and are not ranked against the expanded rubric. Critical
findings override totals; failed required gates prevent winning. Disagreements
remain visible. Oversized patches/summary packs fail explicitly; large logs stay
inspectable without prompt duplication. Historical judge metadata is unchanged.
If saved prices lack the new judge model, its fallback rate is recorded separately
without changing original pricing or trial controls.

The source-reading judge has no model-accessible shell, unified execution,
delegation, plugin/app, hook, image-viewer, or web-search capability. A fixed MCP broker
exposes bounded reads of candidate, reference, and evidence files and can write only
the attempt's check-plan JSON. It rejects symlink traversal, special files, and paths
outside those roots. Candidate execution remains in the credential-free offline
executor. Before source-judge inference, the selected runtime must report the
required execution features disabled; this check does not impose a CLI version allowlist.
Read-only sandbox configuration also prevents direct patch writes by the model.
Models that require Code Mode use its isolated JavaScript host to call the same
restricted tools. The host does not expose Node, filesystem, or network APIs;
enabling this tool transport does not enable candidate process execution.
Only the broker's three allowlisted tools are preapproved; native process tools
remain disabled and native filesystem writes remain denied.

Judging verifies retained inputs and uses the pinned images. It does not require
unused host tool installations to remain unchanged after candidate execution.
Candidate preflight and launch retain their full live-runtime checks.

Harness authors write their complete check plan to a retained, attempt-specific
artifact and return its reference. Repairs and assessments inspect full check
source through retained evidence instead of receiving duplicated source bodies.
Recovery continues both presentation orders concurrently and replays completed
stages, including historical inline plans, without another model request.
New judge requests, including recovered stages, use the default service tier;
each new attempt records its tier. Historical attempts retain their metadata.
Judge cost estimates use recorded model list rates; historical service-tier
surcharges are not included.
Offline checks share a baseline Go/Bun cache seed in an immutable image keyed by
dependency image, baseline, operator, and warming timeout. Warming compiles without
running baseline tests, records inputs/diagnostics, and is bounded to two minutes
or the shorter run timeout. Partial cache entries after timeout remain reusable;
cancellation stops warming. Keep recorded images for later checks.

Each check gets a private writable layer, not a copied compiler cache. Go seed
payloads stay read-only to avoid access-time copy-up; native action indexes and new
entries stay writable. Candidate/harness mounts are read-only. Unprivileged,
capability-free, offline candidate processes cannot alter other checks or images.
The supervisor has only workspace/privilege-drop capabilities. Temporary source,
outputs, and cache writes stay outside report bundles and credential-bearing homes.

After an implementation or judge container is confirmed stopped and removed,
the runner discards its downloaded remote plugin catalog if that path was absent
from the selected setup. Executable plugin contents, sessions, databases, logs,
auth, and check artifacts remain retained. Redirected cache paths are left alone.

Capacity errors retry automatically within the active judge command, with at most three launches per stage and 5-second and 15-second delays. Each launch gets a fresh isolated home and distinct logs; the state and report retain every attempt and its usage. A completed stage is never repeated.
Cancellation interrupts the delay and prevents another launch. Other failures, timeouts, invalid
verdicts, and exhausted retries stop with the available evidence preserved. There is no automatic
model substitution or conversational-agent fallback. Once the command exits, it cannot restart a
judge attempt; historical failed attempts remain unchanged. The exception is an explicit `finish --recover-judge` for a judge that timed out, or failed on a validation rule the current runner handles without failing: an unsupported source-only or executed failure, or a harness repair that resubmitted a successful check. Recovery also supports a missing harness plan when the retained judge configuration disabled the Code Mode host and the CLI recorded that exact tool-host failure. It retains prior attempts and existing-test observations, then retries plan authoring with the tool host available. Recovery also supports setup-commit judges that exited before producing output because their inherited setup configuration referenced an unavailable model-instructions file. The retained configuration and startup diagnostic must establish that specific failure; fresh judge homes use independent minimal configuration. Recovery requires completed existing tests in both passes, no recorded pass, no running attempt, and no partially executed evidence round. It archives the failed bundle, reuses completed existing-test evidence and evidence rounds, replays every completed judge stage's recorded response under current validation, and launches fresh attempts only for stages that never completed. Prior attempts and their usage remain recorded. Recovery does not resume an interrupted model conversation, change the timeout, or restart either A/B agent; another failure remains a failed finishing attempt.

## Report

New pair, trial, and suite reports use versioned v2 schemas. They expose execution
status, capture identity, behavioral result, evaluation validity, usage observation
validity, request coverage, and pricing precision as separate dimensions.
Published `MANIFEST.sha256` files use `codex-ab.bundle-manifest.v2`: a version
header followed by JSON file-identity rows. Each row binds the literal path,
file kind/executable mode, size, and content hash; symlinks hash their literal
targets without following them. Git metadata is excluded. Nested manifests are
included, and only the current manifest excludes itself. Verification rejects
older byte-only manifests, link-target changes, and executable-mode changes.
`codex-ab.usage.v2` does not infer complete request coverage from plausible token
counters or a well-formed session file. Counters must be finite, nonnegative safe
integers; cached-input and reasoning-output relationships must also be valid.
Cumulative snapshots are not summed with delegated or per-request usage without
an explicit reconciliation basis. Aggregate or approximate estimates remain visible
but cannot support an eligible cost ranking. The current direct-Codex session format
does not establish complete request coverage; that limit is reported explicitly.

Quality selection records behavioral eligibility, each pass's weighted-score leader,
the holistic judge preference, the selection policy, and any comparable disagreement.
Fresh source judging retains its holistic policy; historical evaluation reuse retains
its compatible weighted-score policy. Missing required evidence, incompatible rubrics,
missing score dimensions, or critical findings cannot produce a verified quality
selection. Agent command time is not a measurement of implementation performance.

The existing paired efficiency view on joint successes remains available. A separate
scored-attempt view includes verified passes, defined task/model failures, and candidate
budget timeouts. Infrastructure failures, evaluator failures, administrative cancellations,
unassessed outcomes, and unstarted slots have separate counts. Cost per verified success
uses eligible candidate spend across all scored attempts; unknown costs leave it
unavailable, and zero successes never produce a zero cost. Judge spend is separate.

Paired uncertainty averages repeats within each task and resamples matched task means
with equal task weights. Fresh and historical sources and execution schedules remain
separate cohorts. Fewer than two matched tasks has no cross-task interval; very small
task sets carry an instability warning. Repeats on one task do not increase task coverage.
The [experiment guide](guidance-launcher.md) documents denominators and the four-cell
guidance/launcher contrasts. Fixed-verifier rewards are labeled separately from adaptive
quality and do not establish an official FHE result or methodology equivalence.

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

Recovered execution evidence carries its source run and arm, collection time,
container identity, timing source, caveats, and hashes of explicitly listed
sanitized evidence. Imports and bundles preserve this provenance. Reports label
Docker container duration separately when native controller elapsed time is
unavailable. Mixed timing sources suppress elapsed-time percentages and faster-arm
rankings; trial controller-time statistics exclude recovered durations. Recovery
does not repair missing accounting or establish measurement completeness. Raw
sessions and full container inspection records remain private.

To leave a historical run and its original reports unchanged, export elsewhere using its recorded pricing:

```sh
./dist/codex-ab report --run-dir "$run_dir" --output-dir ./results/refreshed-result
```

If supplemental source assessments were already recorded separately, add
`--source-assessments FILE` to include them in the same Markdown. The JSON input contains
`passes`, an array of two objects with `presentation` (the arm keys in candidate-1, candidate-2,
... order, listing every arm with results exactly once, such as `["stock", "current"]`; the second
pass uses the reverse order) and `response` (the original judge-schema
JSON with scores, evidence, issues, winner, and rationale). The report validates both responses,
recalculates weighted scores, records the input hash, and shows agreement or disagreement inline.
Imported assessments do not restart inference, replace the official judge, supply missing usage,
or change overall winner eligibility. They are supplied evidence, not an operational fallback.

Execution automatically retains `reports/report.md`, `reports/report.json`, and a
checksummed `reports/bundle/`, including partial runs. Bundles contain setup/task
identities, evaluator controls, patches, interaction/role audits, assessments,
checks, and integrity evidence. Standalone reporting refreshes an existing
finishing bundle without inference. Rejected judge responses remain unvalidated,
never winner evidence.

Reports include root/child token categories, list-price estimates, command/agent/
grader times, gates, percentage differences, both passes, and separate judge cost.
Pricing is snapshotted once with source, time, assumptions, and warnings. Incomplete
usage or required checks prevent an overall winner. A qualified failure can settle
a failed outcome despite other unassessed criteria; verified success requires
complete checks in both passes. Historical grades gain no new guarantees. If both
fail, neither wins, though speed/cost differences remain visible. Encrypted
interaction content stays unknown; command waits and reviewer polling are separate.

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
classification requires exactly one recognized test command, and it must be the last command
of a simple list joined only by newlines, `;`, or `&&`. A non-zero status after `&&` is not
attributed to the test, because an earlier command may have stopped the list. A test in a
multi-command list carries no overall duration, because the record's time also covers the other
commands; copied-workspace test overhead uses single-command test records only. Pipes, `||`,
background jobs, redirections, grouping, expansion, control flow, `exit`/`exec`/`return`, quoted
examples, and other shell syntax are not treated as proof of individual operations or successful
reads. An exact Mekugi shell-instrumentation envelope is removed before classification, and `mrun`
output options and `rtk`, `rtk proxy`, `rtk bypass`, and `rtk test` prefixes are treated as
launchers of the command they wrap; an inexact envelope leaves the command unclassified.
Encrypted messages are not decoded or labeled as known
readiness signals: their ordering can support a qualified handoff inference, not a claim about
their contents. Unrecognized workflows and cache-miss causes remain explicitly unknown. Rules do
not call a model, assume every extra action is waste, or estimate counterfactual savings.

The programmatic performance section separates root and child usage, model-request counts,
mean and peak input context, uncached/cached/output cost components, and matched outer-tool
blocking spans. JSON includes these diagnostics and each additional arm's role/cost differences
against stock (`baseline_differences`, with `current_minus_stock` retained for the second arm).
Root request-accounting findings likewise compare every additional arm with stock.
Independent Mekugi runtimes retain host metadata without logical role ancestry.
When that lineage is unavailable, family totals remain measured and role-specific
comparisons remain unknown rather than charging every runtime to Main.
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
