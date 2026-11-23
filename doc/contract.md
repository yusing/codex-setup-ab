# Contract

[README](../README.md) · [Specification](spec.md) · [CLI guide](cli.md)

This document defines preparation, isolation, evaluation, reporting, and lifecycle
guarantees. Examples run from the repository root. Comparison treatments are described
in the [specification](spec.md); build and multi-run recipes are in the
[CLI guide](cli.md).

## Arm identities

Reports and progress use launcher/setup display labels (including treatment off/on
labels). Machine keys remain `stock`, `current`, `arm-3`, …; JSON exposes `arm_labels`.
Judge inputs use anonymous `candidate-N` IDs; operator progress reveals each pass's
mapping without exposing it to the judge. Regenerate an existing report to apply display
labels.

## Prepare an isolated pair

This example uses the [archived Mekugi checkout](../tasks/session-retention/README.md#prepare-and-run).

```sh
run_dir="$(./dist/codex-ab prepare \
  --source "$HOME/projects/mekugi-archive" \
  --task-pack ./tasks/session-retention/manifest.json)"
```

Preparation creates a private mode-0700 directory outside the repository with
independent base-only clones (no remotes, alternates, linked worktrees, or hardlinks),
verifying tree identity and absence of the excluded solution commit. When a pack sets
`source.reference_commit`, preparation verifies its ancestry from the baseline through
the excluded commit and freezes its ordered patches, combined diff, IDs, and hashes in
evaluator-only storage (surviving trials and bundles, never entering implementation
mounts).

The default `current` setup is an independent shallow clone of `--current-home` (default
`/home/ubuntu`, remote stripped) including tracked configuration plus tracked edits,
staged additions, and deletions without modifying the source checkout or index. Add
untracked guidance to Git before preparation to include it.

### Comparison modes and arm settings

- **`setup-commits`**: Pass `--setup-a-commit REF` and `--setup-b-commit REF` against
  `--current-home`. Both resolve to commits before preparation; each arm gets an
  independent shallow snapshot with no working-tree overlay. Both arms share revision
  B's service tier (default if omitted), the selected launcher (direct Codex by default,
  or Mekugi), task, and pinned runtime binaries/tool store. Codex config symlinks into
  the setup repo are materialized from the snapshot (targets outside the repo are
  rejected). Reviewer overlays and `--protect-mekugi` are incompatible. Legacy
  `--control-run` is unavailable; use `--import-arms` or `prepare-trials`.
- **`custom`**: Pass `--arms` as an ordered JSON array of two or more arms, e.g.
  `[{"launcher":"codex","setup_commit":"stock"},{"launcher":"mekugi","setup_commit":"commit1"},{"launcher":"mekugi","setup_commit":"HEAD"}]`.
  `launcher` is `codex` (legacy alias `stock`) or `mekugi`; `setup_commit` is `stock`
  (minimal guidance), `worktree` (tracked working tree at `--current-home`, recording
  changed paths and captured files), or a Git revision (`HEAD` means committed files
  only). Arm keys are `stock`, `current`, `arm-3`, `arm-4`, …. Both blind passes present
  all candidates in opposite orders, and reports show resource deltas against the first
  arm. Service tier comes from the second setup (default for `stock` or if omitted).
  Reviewer overlays and `--protect-mekugi` are unavailable.
- **Minimal (`stock`) arms**: Retain configured mise tool access where applicable but
  omit custom instructions, hooks, Mekugi configuration, bundled skills, skills catalog,
  and plugin loading (skipping plugin prefetch). Before inference, each minimal arm
  verifies an empty skill inventory in its prepared workspace; a nonempty inventory or
  discovery error stops the run.
- **Per-arm settings (`--arm-settings`)**: JSON mapping arm keys to independent `model`,
  `reasoning_effort`, `cpus`, `memory`, `timeout_seconds`, `auto_compact_limit`,
  `parallel_work`, `mekugi_flags`, and `skills` (booleans over the arm's setup registry;
  unchanged skills keep setup defaults/conditions, and repository-local `skills-mgr`
  selections keep normal precedence). Overrides affect only the disposable runtime home.
  Per-arm `parallel_work` appends the delegation instruction to that candidate's prompt.
- **Reviewer overlay (`--review-treatment DIR`)**: Overlays `parent-agents.md`,
  `review-correctness.toml`, `review-simplify.toml`, and `web-reviewer.toml` only in the
  isolated setup, recording before/after hashes.

### Runtime supplements and host tool mounts

- **`--runtime-home`**: Selects a separate home for installed tools, hook binaries,
  plugins, remote-skill caches, and tool-store sidecars (defaults to `--current-home`),
  letting a configuration worktree reuse an existing installation. Supplements are not
  historical builds, and revision snapshots do not establish historical provenance for
  installed binaries or fetched skills. Mekugi-launched `setup-commits` snapshots omit
  the obsolete `orchestration.reviewers` table from `.config/mekugi/config.toml` for
  runtime compatibility (recorded in the arm manifest; the source commit is untouched).
- **Supplements included**: Installed hooks, materialized skills, available bundled
  plugins, referenced remote-skill generations, Modern Go Guidelines, mise migration
  records, and referenced pipx lock sidecars. Untracked auth, sessions, and Mekugi state
  are excluded; tracked setup files must contain no credentials or task solutions.
- **Host tool stores (mise, Rust, Linuxbrew)**: Installed tools are mounted read-only at
  their recorded absolute paths rather than copied or hardlinked. Preparation records
  device, inode, size, mode, and nanosecond mtime/ctime without hashing payloads;
  preflight and launch reject any drift (including same-size rewrites). Mise automatic
  installs are disabled against read-only stores. When mise's Rust links to `.cargo/bin`,
  both `.cargo/bin` and `.rustup` are recorded and mounted read-only (Cargo caches stay
  private per arm). When Linuxbrew is present on the host, its prefix is likewise
  recorded, mounted read-only, and added to PATH. Keep all mounted host stores
  unchanged while runs/trials use them. (`--snapshot-base` is removed; task caches live
  in shared dependency images.)
- **Tool-store reachability**: `current` only in `stock-current`; both arms in
  `setup-commits`, `stock-mekugi`, `same-setup`, historical `journal-compaction`, and
  `duplicate-output`; neither arm in `codex-mekugi-grok`.
- **Executables and snapshots**: Mise and Grok binaries are hash-pinned read-only mounts
  where needed; host Bun is recorded as provenance while containers resolve Bun from the
  image's PATH. The six [installed Mekugi runtime](cli.md#installed-mekugi-runtime)
  artifacts beside `--mekugi-bin` (default `~/go/bin/mekugi`) are copied, individually
  hashed, and embedded in a private image directory separate from stock Codex's
  code-mode host, without compiling Mekugi or Rust. Containers preserve `/home/ubuntu`
  paths, and `snapshot-manifest.json` binds setup commit/tree, tracked overlays, file
  hashes, literal symlink targets, and portability adaptations (excluding Git metadata).

### Isolated homes, environment, and preflight

- **Workspace neutrality**: Arms have independent writable workspaces, homes, and
  caches. Implementation contexts use neutral prompts, paths, environment names, and Git
  branches (random session paths and operator-only mappings live in `run.json`).
  Dependency environments live under `/opt/task-deps`, and both candidate clones receive
  the same repository-local Git author identity. Task Python precedes user/Linuxbrew
  init on PATH for direct commands and login shells. Minimal Codex config omits the
  unsupported top-level `network_access` setting because Docker owns network isolation.
- **Copy-on-write homes**: Fresh unprotected Codex implementation and judge homes use
  private Docker copy-on-write layers from immutable setup images (with model-free
  plugin prefetch when plugins are enabled). Snapshots, live logs, sessions, auth, and
  SQLite state stay private host files; other home writes are saved in immutable Docker
  images recorded in `run.json` (excluding auth and live-state bind mounts). If image
  capture fails, the stopped container is retained for inspection. Grok, protected
  runtime, and older runs keep host-mounted homes.
- **Network policy (`codex-ab.network-policy.v1`)**: Each candidate arm and each judge
  attempt runs on its own temporary IPv6-capable Docker network (removed after container
  stop). Offline preparation and evaluation use `--network none`. Candidate policy is
  explicitly `online-unrestricted` with `closed_book: false` (no runner-enforced
  destination allowlist; removing reference commits does not prove solutions are
  unavailable online).
- **Preflight**: Run `./dist/codex-ab preflight --run-dir "$run_dir"` to validate
  immutable inputs, image ID and Codex/Code Mode hashes, absence of image-bundled
  Mekugi, real model-free Code Mode execution, offline configured tools (including
  `python`/`python3`), readable config, writable homes, Git identity, task
  interpreters/dependencies, Mekugi flags/hashes/probes, and provider reachability—all
  without making model requests. Preflight does not load skills, run guidance hooks, or
  run evaluation tests. Failed preflight leaves execution and assessment unstarted while
  retaining a failure report and bundle.

## Run and grade both arms

```sh
./dist/codex-ab run \
  --run-dir "$run_dir" \
  --auth-file /home/ubuntu/.codex/auth.json \
  --confirm-paid-inference
```

### Images, launchers, and execution lifecycle

- **Shared dependency image**: `codex-ab-deps:<key>` binds base image, source
  commit/tree, submodules, preparation command, selected Mekugi hashes, and operator
  identity. It holds dependency caches and frozen Mekugi binaries—never source, homes,
  credentials, or evaluator controls. Build diagnostics are stored in
  `artifacts/dependencies.stdout`/`.stderr`; keep recorded images for later checks and
  trials. Arms materialize generated assets offline on private writable layers; declared
  regenerable `node_modules` directories are excluded from capture unless they contain
  tracked source.
- **Defaults and launch**: Both preparations must pass before candidates start
  (concurrently by default). Defaults are `gpt-6-astra`, `medium` reasoning, 2 CPUs,
  4 GiB memory, and 30 minutes, subject to preset and per-arm settings. Final launch
  rechecks controls, setup templates, mounted tools, Bun provenance, and baseline
  identity.
- **Launcher invocations**: Mekugi arms run `mekugi codex headless --yolo` (without
  `codex` for third-party routing), admitting Main and children through Mekugi's
  server-owned runtime and retaining host JSONL plus its final logical-completion event.
  Stock arms run `codex exec --json`. Both receive the task on stdin and bypass hook
  trust for the captured setup (Mekugi carries this override through admitted thread
  startup independently of `--yolo`).
- **Failure and lifecycle**: Milestones go to stderr. Timeout or cancellation stops
  owned containers and preserves available patches/results. Nonzero agent exit, timeout,
  cancellation, lifecycle failure, or collection failure leaves execution partial, skips
  grading/judging, writes the report bundle, and exits nonzero. Direct judging and
  finishing require successful agent execution. Runs never restart or resume; semantic
  assessment requires every configured arm.
- **Legacy Mekugi router task**: Use `--profile mekugi --current-launcher mekugi` with
  `--mekugi-bin`. Historical source snapshots using the `hpatch:core/v1` plugin ABI
  remain supported without rewriting benchmark source.

### Historical imports and reevaluation

- **`reevaluate --run-dir SOURCE`**: Creates a new evidence directory (default parent
  `/var/tmp`) from every arm of a completed, infrastructure-valid published run,
  preserving the original run and implementation measurements while running fresh
  evaluator checks and both blind judge passes (no implementation-agent calls; source
  preflight stays historical). Rejects incomplete, invalid, or fixed-verifier runs.
- **`--import-arms` (`launch` or `run`)**: JSON array of
  `{"target_arm", "run_dir", "arm", "bundle_sha256"?}` mappings from completed,
  infrastructure-valid published adaptive runs. Targets must be distinct and leave at
  least one fresh arm (cannot combine with `--arm`, `--control-run`, or repeat count > 1).
  Task, baseline, criteria, model, reasoning, service tier, base images, Codex binaries,
  resource limits, and timeout must match; setup/launcher treatments may differ.
  Dependency image IDs may differ only when both build keys match the current recipe and
  differ solely in launcher-binary inputs.
- **Import provenance and accounting verification**: Requires
  `codex-ab.candidate-manifest.v1` and v2 rollout/accounting schemas; active/archived
  rollouts keep namespaces and checksums. Before repricing, import remeters retained
  evidence against source pricing and verifies original totals/coverage in
  `accounting-verification.json` (recording `null` target pricing hash/repricing when no
  target snapshot exists yet). Unknown usage stays unknown.
- **Evaluation modes (`--evaluation-mode reuse|fresh`, `--evaluation-baselines`)**:
  Imports default to `reuse`; non-import runs use `fresh`. `reuse` freezes imported
  grades, per-pass scores, and aspect assessments (requiring completed two-pass evidence
  and retained per-criterion/existing-test records, copied into the new bundle). For each
  fresh arm and pass, the judge adapts its baseline's final tests (defaulting to the
  last imported slot) to the new interface while preserving behavioral requirements,
  assertions, and failure conditions. Reuse rankings compare eligible scores within each
  pass only when every candidate shares one complete rubric (overall winner requires
  pass agreement); mixed rubrics or incomplete scores omit a combined ranking.
- **Workbench Compare against HEAD**: Builds an editable draft importing all completed
  arms plus one fresh `HEAD` arm (inheriting the last arm's Codex/Mekugi launcher,
  resetting inference consent). Catalog packs must match the retained snapshot; changed
  packs or shared compaction limits require manual configuration.

### Trusted candidate capture

After agents stop, an offline collector mounts candidate trees read-only with a trusted
seed and writes a binary patch relative to the immutable base into a fresh destination.
Candidate Git config, filters, hooks, external diffs, and replace refs cannot control
captured bytes. Capture includes ignored new source files and preserves binary bytes,
executable modes, and raw symlink targets; only declared regenerable preparation
directories are excluded (tracked source inside them is kept), and pinned submodules
stay immutable.

`codex-ab.candidate-manifest.v1` records file identities, modes, sizes, resulting Git
tree, exclusions, changed paths, and patch hash. The runner independently verifies that
manifest and evaluator reconstruction before grading; agent and grader times stay
separate.

## Protected Mekugi runtime

Pass `--protect-mekugi` with `--mekugi-source` or `--mekugi-build` using an image built
from the current `Dockerfile`. Preflight runs runner-bundled isolation scripts: a real
router starts, its executor can reach only assigned family listeners, capture/runtime
mounts are read-only, and private Code Mode execution succeeds without inference.
Preflight copies the captured B home and workspace, mounts its mise store, launches via
`mise exec -- mekugi`, and verifies the underlying Codex hash matches direct Arm A.

The trusted launcher uses Docker `NET_ADMIN`, `SYS_ADMIN`, and private mount/PID
namespaces. The executor retains UID 0 for Mekugi state compatibility with zero
capabilities, no supplementary groups, no privilege elevation, and an immutable non-root
network GID. Only run-owned writable trees are temporarily assigned to it, and failed
ownership restoration is a lifecycle error.

**Arm A remains true direct Codex** (ordinary non-root container and direct egress).
Protected Arm B has a different process/network boundary, recorded explicitly in state
and reports; do not describe this as identical sandbox behavior.

## Task-derived semantic grading

Supply the predetermined behavioral contract via `prepare --criteria FILE`:

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

Author and review criteria from the task **before** running candidates. Add
`required_interface` only when the task explicitly fixes a public interface, and
`allowed_paths` only when the task requires exact file boundaries. Commands run inside
containers without introducing evaluator-only checks into candidate workspaces.

After candidates stop, two concurrent blind passes inspect candidates in opposite
orders: each runs existing tests, asks Sol to author interface-adapted checks executed
offline against private read-only copies of candidate source, and then reviews source
plus executed evidence to return scores, criterion decisions, issues, and a pass winner.
Harnesses that overwrite candidate files are rejected, and candidate-file mutations
report before/after hashes/modes (up to 100 paths plus total count).

- **Single repair per pass**: Limited to unassessed criteria; resubmitted passing or
  failing checks are ignored, and no repair call runs if all criteria are assessed. A
  final assessment may mark a wrongly wired failure unassessed, but cannot turn it into
  a pass.
- **Evidence rules**: Assumed names/runtimes causing setup failure stay unassessed. A
  missing explicitly required interface can be a source-only defect; unsupported
  source-only failures become unassessed. An executed failure needs a failed check for
  that criterion. Passing requires completed supervisor assertions, qualified frozen
  controls, and judge coverage acceptance (raw probes stay visible on qualification
  failure). See [verification](verification.md#independent-observations-and-assertions)
  and [repair invariants](verification.md#repair-invariants).
- **Optional `retained_tests`**: Runs in a scratch copy where files matching `patterns`
  (shell-style, `*` matches `/`, never inside `.git`) are replaced by baseline files
  (candidate matches removed first). Declare only when baseline files pass unchanged
  against the reference endpoint. Results (`pass-N-retained`) are shown to the judge and
  reported without reclassifying compiler output or altering the existing-test gate,
  eligibility, or grade.
- **Fixed-verifier separation**: Adaptive grading is separate from
  [fixed-verifier mode](fixed-verifier.md); generic imports and reuse do not support
  configured fixed-verifier runs.

Harness authoring, optional repair, and final assessment record separate model attempts,
usage, and timing (separate from offline check time). `run`, `judge`, `finish`, and
`reevaluate` require `--confirm-paid-inference`.

## Blind judge

`run` performs blind semantic assessment automatically after candidate capture. For a
complete pair with criteria and no judge attempt:

```sh
./dist/codex-ab judge --run-dir "$run_dir" --confirm-paid-inference
```

New judge attempts use `gpt-6.2-sol`, high reasoning, and the default service
tier. Recovery continues with the recorded model. The judge receives
the task, anonymous patches/change lists, bounded summaries, and full read-only
`/evidence` and candidate trees. Pinned references appear under `/reference`.
It sees no arm labels, costs, agent logs, or candidate-writable filesystem.
Reference behavior defines task scope, not commit correspondence; equivalent
designs and safe improvements are allowed, but source comparison cannot replace
executed evidence.

### Scoring rubric and quality aspects

Validated axis scores range 0–5, producing a 0–100 weighted total:

| Axis | Current rubric (`expanded-seven-axis-v2`) | Legacy rubric (`legacy-four-axis-v1`) |
| --- | --- | --- |
| Correctness | 25% | 50% |
| Simplicity | 25% | — |
| Completeness | 20% | 20% |
| Implementation performance | 12% | — |
| Maintainability | 10% | 20% |
| Approach | 4% | — |
| Test quality | 4% | 10% |

- **Quality aspects**: Simplicity (necessary scope, abstraction/state cost, duplication,
  proportionate test weight—not raw line count), performance (work, allocation, I/O,
  scaling on changed paths—distinct from agent command time), and approach (established
  cause, consumer/ownership fit, supported mechanisms, material tradeoffs) also record
  `satisfactory` / `concern` / `unassessed`, evidence basis (`source` / `executed` /
  `none`), and a concise explanation.
- **Missing evidence and rubric boundaries**: An unassessed aspect gets a `null` score
  and leaves the weighted total unavailable (never zeroed or redistributed). Historical
  four-axis scores retain their rubric and are never ranked against seven-axis scores.
  Critical findings override totals, failed required gates prevent winning, and
  disagreements remain visible. Oversized patches or summary packs fail explicitly.
  Missing judge-model pricing falls back separately without mutating trial pricing
  controls, and judge estimates use list rates (no service-tier surcharges).

### Source-reader capability boundary

The source judge has no shell, unified execution, delegation, plugin/app, hook,
image-viewer, or web-search tools. A fixed MCP broker exposes bounded reads of
candidate, reference, and evidence trees and writes only the attempt's check-plan JSON
(rejecting symlinks, special files, and out-of-root paths). Before judge inference, the
runtime must report required execution features disabled; read-only sandbox policy also
blocks direct patch writes. Models requiring Code Mode use its isolated JavaScript host
(no Node, filesystem, or network APIs) with only the broker's three allowlisted tools
preapproved. Judging uses pinned images and does not require unused host tool
installations to remain unchanged after candidate execution.

### Caching, retries, and judge recovery

- **Artifact plans and cache warming**: Harness authors write their check plan to an
  attempt-specific artifact and return its reference so repairs and assessments read it
  from retained evidence. Offline checks share an immutable baseline Go/Bun cache seed
  image (warmed without running baseline tests, capped at 2 minutes or run timeout;
  partial caches remain reusable). Each check uses a private writable layer with
  read-only Go seed payloads and unprivileged, capability-free offline candidate
  processes. After a container is removed, downloaded remote plugin catalogs absent from
  the selected setup are discarded (executables, sessions, databases, logs, auth, and
  check artifacts stay retained).
- **Capacity retries**: Within an active judge command, capacity errors retry up to
  three launches per stage (5 s and 15 s delays), each in a fresh home with retained
  usage; completed stages never repeat, and cancellation interrupts retry delays. Other
  failures, timeouts, invalid verdicts, and exhausted retries stop with evidence intact
  (no model substitution or conversational fallback).
- **Audited recovery (`finish --recover-judge`)**: Permitted only when existing tests
  completed in both passes, no pass is recorded, no attempt is running, and no evidence
  round partially executed. Supported triggers:
  1. Judge timeout.
  2. Validation rules the current runner handles without failing (unsupported
     source-only/executed failure, or a repair resubmitting a passing check).
  3. Missing harness plan where retained judge config disabled the Code Mode host and
     the CLI logged that exact tool-host failure.
  4. Setup-commit judges that exited before output because inherited config referenced
     an unavailable model-instructions file (fresh judge homes use minimal config).

  Recovery archives the failed bundle, reuses completed existing-test and evidence
  rounds, replays completed stages under current validation, and launches fresh attempts
  only for incomplete stages (continuing both orders concurrently). It never resumes an
  interrupted model conversation, changes the timeout, or restarts candidate agents.

## Report

```sh
./dist/codex-ab report --run-dir "$run_dir"
```

### Schemas, manifests, and accounting

- **Versioned v2 reports**: Pair, trial, and suite reports separate execution status,
  capture identity, behavioral result, evaluation validity, usage observation validity,
  request coverage, and pricing precision.
- **Bundle manifests (`codex-ab.bundle-manifest.v2`)**: Published `MANIFEST.sha256`
  files pair a version header with JSON file-identity rows binding literal path,
  kind/executable mode, size, and content hash (symlinks hash literal targets; Git
  metadata excluded; nested manifests included; only the current manifest excludes
  itself). Verification rejects legacy byte-only manifests and mode/symlink changes.
- **Usage accounting (`codex-ab.usage.v2`)**: Counters must be finite nonnegative safe
  integers with valid cached-input and reasoning-output relationships. Cumulative
  snapshots are never summed with delegated/per-request usage without explicit
  reconciliation. Aggregate/approximate estimates stay visible but cannot support an
  eligible cost ranking. Direct-Codex sessions currently do not establish complete
  request coverage (reported explicitly). Pricing is snapshotted once with source, time,
  assumptions, and warnings; missing judge-attempt usage stays unknown and prevents a
  complete cost or winner.
- **Mekugi exports**: Validated exports report compaction answerer, provider cost, and
  post-compaction cost (excluding prewarm); byte-only v7 exports reconcile transport
  bytes and provider usage without fabricating token or tool estimates. Removed Mekugi
  flags normally require fresh preparation, except preflight can preserve an enabled
  deduplication request on bundled native Mekugi without passing the obsolete switch.
  Retired journal comparisons remain reportable but cannot launch.
- **Recovered execution evidence**: Preserves source run/arm, collection time, container
  ID, `docker-inspect` timing source, caveats, and sanitized-file hashes. Reports label
  container duration separately when controller elapsed time is unavailable; mixed
  timing sources suppress elapsed-time percentages and faster-arm rankings, and trial
  controller-time stats exclude recovered durations.

### Reliability, uncertainty, and behavioral explanations

- **Quality selection**: Records behavioral eligibility, per-pass weighted-score leader,
  holistic judge preference, selection policy (`holistic` for fresh judging, compatible
  weighted scores for reuse), and disagreements. Missing required evidence, mixed
  rubrics, missing score dimensions, or critical findings block a verified selection.
- **Reliability and cost-per-success**: Reports retain joint-success paired efficiency
  alongside a separate scored-attempt view (verified passes, task/model failures, and
  candidate budget timeouts; infrastructure/evaluator faults, cancellations, unassessed,
  and unstarted slots stay separate). Cost per verified success uses eligible candidate
  spend over all scored attempts (unknown costs make it unavailable; zero successes
  never produce zero cost; judge spend is separate).
- **Cross-task uncertainty**: Averages repeats within each task and bootstraps matched
  task means with equal task weights, keeping fresh/historical sources and schedules
  separate. Fewer than 2 matched tasks yields no interval; small task sets carry an
  instability warning. Fixed-verifier rewards are labeled separately and never imply FHE
  comparability. See the [experiment guide](guidance-launcher.md).
- **Behavioral explanation**: Deterministic rules match captured review instructions
  against visible events (isolated reviewer prep, validation-gated review,
  finding/edit/test/re-review cycles, copied-workspace test overhead) with event
  locations and limits. Edits require completed file-change records; test classification
  requires one recognized test command at the end of a simple newline/`;`/`&&` list
  (stripping exact Mekugi shell-instrumentation envelopes and `mrun`/`rtk` wrappers;
  nonzero status after `&&` is not attributed to the test, and multi-command lists carry
  no test duration). Complex shell syntax, encrypted messages, unrecognized workflows,
  and cache-miss causes stay explicitly unknown.
- **Programmatic diagnostics**: Separates root/child usage, deduplicated request counts
  (unknown for cumulative-only usage), mean/peak context, uncached/cached/output costs,
  first-request vs. later-request cache splits (including retries, unaffected by model
  switches), captured prewarm (separate from task totals; direct-Codex prewarm stays
  unknown), and unioned per-session tool-blocking spans. JSON exposes
  `baseline_differences` (`current_minus_stock` retained for the second arm). When
  Mekugi runtime lineage is unavailable, family totals stay measured and role splits
  stay unknown.

### Finishing, remetering, and supplemental assessments

- **Self-contained output**: `report` prints `reports/report.md` (alongside
  `reports/report.json` and checksummed `reports/bundle/`). Refreshing removes legacy
  `SOURCE-REVIEW.md` and `COMPARISON.md` duplicates. Use `--output-dir DIR` to export
  elsewhere without altering the source run.
- **Supplemental source assessments (`--source-assessments FILE`)**: Embeds recorded
  two-pass JSON (`passes` with `presentation` and judge-schema `response`) inline after
  validating schemas, recalculating weighted scores, and recording the input hash. Does
  not run inference, replace the official judge, fill missing usage, or change winner
  eligibility.
- **Finishing (`finish`)**: If execution completed but finishing failed before a judge
  request, fix the cause and run `finish --run-dir DIR --confirm-paid-inference`
  (archives failed bundle, preserves candidates/grades, runs unstarted judge, rebuilds
  bundle; add `--recover-judge` for supported recovery cases).
- **Post-hoc deductions (`remeter`)**: `remeter --run-dir DIR --exclusions FILE`
  (JSON with `arm`, `rationale`, and recorded `responses`/`commands` `{id, reason}`
  entries) writes a separate `reports/remeter-*/` report using recorded pricing without
  modifying the original run, rewriting later context, or claiming adjusted wall time.
- **Unsupported legacy paths**: Evaluator infrastructure faults outside supported
  recovery require fixing the fault and preparing a fresh pair. Legacy `regrade` and
  hidden-test inputs are removed.

## Failure and automation behavior

- Exit 0 means the requested command (including automatic finishing for `run`) completed,
  not that an arm passed evaluation. Finishing failures exit nonzero, preserve evidence,
  and never restart inference.
- Invalid isolation, missing setup dependencies, non-private auth, malformed judge
  output, and repeated run/judge attempts exit nonzero.
- Record post-hoc infrastructure faults without discarding evidence via
  `./dist/codex-ab invalidate --run-dir "$run_dir" --reason "concrete reason"`.
  Invalidated runs retain metrics but cannot be judged or produce a winner.
- Commands reject unknown, inapplicable, and repeated options rather than silently
  changing scope.
- Operations on one run are mutually exclusive via `.operation-lock` (including report
  generation and invalidation). Normal exit releases the lock; if a hard-killed process
  leaves `.operation-lock`, verify its process and containers have stopped before
  removing the empty directory for inspection—never to resume or restart inference.
- `run.json` is written atomically as the machine-readable lifecycle record.
- Logs and manifests never contain auth contents. Treat the entire mode-0700 run
  directory as private because it contains temporary homes and patches.

Use `./dist/codex-ab --help` for all flags.
