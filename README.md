# codex-ab

`codex-ab` runs controlled, descriptive comparisons of the same Codex model on the same repository task. The **stock** arm receives only a minimal model, service-tier, permission, and workspace-trust configuration. The **current** arm receives an audited snapshot of the user's instructions, skills, hooks, roles, and supporting tools. Codex runs directly by default; the current arm can explicitly use a snapshotted Mekugi launcher.

This is designed for a careful pilot, not a claim that one setup causes better results. A single pair does not support causal or general conclusions.

## Prerequisites and build

You need Bun 1.4 or later, Git, Docker with BuildKit named-context support, access to the source commit, a standalone Codex binary and its matching `codex-code-mode-host` companion, and a mode-0600 Codex `auth.json`. The pinned Ubuntu 24.04 image copies only Go and Node from `hpatch-bench:run-D9ZuS3`; it does not inherit that image's Mekugi runtime, wrappers, source, home, or credentials. It copies the chosen standalone Codex pair directly. Preparation records the CLI version plus both files' SHA-256 identities; preflight requires both container copies to match.

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

No model request occurs during the build or `prepare`. The `run` command includes two independent source-assessment requests after a completed pair; `judge` is available for older, not-yet-judged pairs. Both commands make model requests using your Codex authentication and quota, and require `--confirm-paid-inference` to start. Reported API costs are list-price estimates, not subscription charges or invoices.

## Prepare an isolated pair

```sh
run_dir="$(./dist/codex-ab prepare \
  --source /home/ubuntu/projects/mekugi \
  --base bb9e740362fd86c9214f5c893c65ae6c46587a60 \
  --forbidden d50b9e6d7a2b01fc033a8aab523791876e4441b5 \
  --task ./task.md \
  --acceptance ./acceptance_test.go)"
```

Preparation creates a new mode-0700 `mktemp` directory outside the repository. It shallow-fetches exactly the base commit into a bare seed, makes two `--no-local --no-hardlinks` clones, removes their remotes, and verifies tree identity, the lack of object alternates and linked worktrees, and absence of the future solution commit. The solution itself is never copied.

For early familiarization followed by passive milestone retention and final-only inspection, use the [v3 treatment](treatments/continuous-review-v3/TREATMENT.md). Active home guidance is not changed.

The current setup starts with a shallow, independent clone of the configuration repository rooted at `--current-home` (default `/home/ubuntu`), with its remote removed. All tracked configuration is included automatically, so adding or removing a guidance file does not require a runner change. Current tracked edits, staged additions, and deletions are overlaid without changing the source checkout. New untracked instruction files must be added to Git before preparation to be included.

To apply a benchmark-only reviewer overlay, add `--review-treatment DIR` with `parent-agents.md`, `review-correctness.toml`, `review-simplify.toml`, and `web-reviewer.toml`. Preparation applies them to the isolated current snapshot after copying the live home, records before/after hashes in the manifest, and leaves active guidance untouched. Use [current-home v2](treatments/continuous-review-v2-current-home/TREATMENT.md) with `--current-launcher codex` for the non-Mekugi treatment.

Runtime supplements are copied separately: installed hooks, materialized skills and bundled plugins, the referenced remote-skill cache generations, and the existing Modern Go Guidelines provider. Preparation also snapshots the complete installed mise tool store and its migration completion records, and records a content manifest. To save disk space, pass `--snapshot-base /tmp/codex-ab-PREVIOUS` for a completed run. Files with matching contents and modes are hard-linked from that isolated snapshot; changed files are copied, and live-home files are never hard-linked. Each new snapshot retains its own paths and survives deletion of the old run. Keep snapshot tool stores immutable; they are mounted read-only during execution. Preparation reports reused and copied bytes and records them in `snapshots/current/incremental.json`. Preflight rejects mise migration failures before agent execution; the tool store stays read-only. The current arm starts Codex through that setup, so every tool declared by the active user configuration is available without network access. `--current-launcher mekugi` additionally copies the executable selected by `--mekugi-bin` (default `~/go/bin/mekugi`) and its matching `shell` helper into the audited snapshot, without copying Mekugi state. The helper defaults to `shell` beside the resolved Mekugi executable; use `--mekugi-shell-bin` when storing the pair separately. Install or build both from the same Mekugi revision. Their paths and hashes are recorded and checked before launch. Other untracked home files, including authentication and session history, are not copied. The source repository is expected to contain only configuration suitable for the benchmark, not tracked credentials or task solutions.

The clone preserves absolute `/home/ubuntu` paths inside its container. `snapshot-manifest.json` records the configuration commit and tree, overlaid tracked paths, a SHA-256 for every regular setup file (excluding Git metadata), literal symlink targets, and portability adaptations. The installed-tool content manifest and copied setup manager are also verified before launch. Preflight requires every configured tool to be present, then runs a referenced remote skill and the registered Go-guidelines hook with networking disabled. For Mekugi, it also resolves `shell` on the executor's PATH and executes its missing-thread diagnostic, catching absent or non-runnable helpers before inference. This checks helper startup, not a complete model-to-tool request. An incomplete setup fails before inference instead of being silently bypassed.

The evaluator test is copied under `evaluator/`, which is never mounted into an arm. Each arm sees only its own clone, Go caches, and private home; the current arm also receives its read-only installed-tool snapshot. Agent logs and captured patches are kept outside its writable mounts. It cannot see the sibling, the host's live home or repositories, the Docker socket, the acceptance test, or evaluator artifacts.

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

The command first checks that the image exposes the exact Codex version recorded during preparation, its hash-matched code-mode host, and no image-bundled `mekugi`; exercises a real local code-mode execution without model access; and checks the complete current setup offline. For each arm, agent setup installs locked plugin dependencies when required, builds the ignored JavaScript embed missing from a clean checkout, and prewarms writable agent caches without evaluator source. It then copies those caches into evaluator-only storage, injects the acceptance source into a separate ephemeral baseline, and compiles without running tests to complete the evaluator's exact dependency closure. Grading mounts those completed evaluator caches read-only and offline, without exposing them to the agent or consuming agent-modified entries after inference. It rejects any preparation that changes either immutable baseline. Only after both preparations pass does it start both gpt-6-astra arms at the selected reasoning effort (default medium) concurrently with identical two-CPU and 4 GiB limits. Preflight and the final launch check verify copied controls, both setup templates, the installed-tool file manifest, the Bun snapshot, and immutable baseline identity. The image tag is resolved before checking it, and all subsequent containers use that image ID. The default agent timeout is 30 minutes. Both arms use the service tier read from the snapshotted current configuration, and the report records it.

Milestones go to stderr. Timeout or cancellation stops session-created containers and preserves available patches and results. Runs never restart or resume: prepare a new directory for another attempt. Mekugi snapshots prepared without the separate `shell` helper must be replaced with a fresh preparation; completed historical reports remain readable.

For a non-comparative run, use `run --arm current` or `run --arm stock`. Only the selected arm is launched, captured, and graded. The report shows its executed checks and root-plus-child usage, but cannot claim paired measurement completeness or a winner; `judge` refuses singleton runs.

After both agents stop, the runner captures tracked, committed, staged, and untracked changes as a binary patch relative to the recorded immutable base. Only then does it create separate evaluator workspaces, inject `acceptance_test.go`, and run the focused `^TestABAcceptance` prefix gate plus the full package suite offline with evaluator-only module, build, and package caches frozen before inference. Git inspection and patch capture of candidate repositories run in separate offline containers, never on the host. Acceptance injection also happens inside the evaluator container, so candidate symlinks cannot redirect writes into the host. Agent and grader times remain separate.

New runs use the `mekugi` profile and `--current-launcher mekugi`, with `--mekugi-bin` and `--mekugi-shell-bin`. Historical result bundles and the pinned toolchain image retain their original names and identities. Historical source snapshots may still use the `hpatch:core/v1` plugin ABI; preparation supports it without rewriting benchmark source.

## Skills manager bundle profile

The [skills-mgr bundle task](tasks/skills-mgr-bundle/README.md) is a new, multi-part task outside Mekugi and GoDoxy. Use `--profile skills-mgr-bundle` with explicit source, base, forbidden commit, task, and evaluator inputs. This profile compiles and grades the root Go package without Mekugi plugin preparation. The hidden evaluator is injected at `ab_acceptance_test.go` only in evaluator workspaces; required acceptance, package-suite, and supplemental repeat checks retain the same isolation and usage accounting as the other profiles.

## GoDoxy icons profile

Use `prepare --profile godoxy-icons --reasoning-effort medium` (or `xhigh`) with explicit `--source`, `--base`, `--forbidden`, `--task`, and `--acceptance` inputs. Prepare a fresh directory for each effort, launcher, or repeat. Run `--arm stock` for the minimal setup or `--arm current` for the active snapshotted setup. Add `--current-launcher mekugi` to launch the current arm as `mekugi codex`; otherwise it launches bare `codex`. Supply the matching `shell` helper as described under preparation. The GoDoxy profile accepts only the pinned synthetic base `c335ef2d83d9fb8a774cb70b9b628ade54c654a2`, its recorded tree, excluded solution, and three exact submodule commits; altered identities or copied controls fail preflight.

The source must contain local repositories at `goutils`, `internal/go-oidc`, and `internal/gopsutil` with the base commit's gitlink objects. Preparation shallow-fetches those exact commits into independent submodule clones, removes their remotes, and records their paths, source provenance, and SHAs in `run.json`. It rejects root remotes and initialized or populated `webui` throughout setup, patch collection, and grading. It does not initialize `webui`. The current arm uses the same audited current-home snapshot rules as the default profile.

Preflight retains the bare-image and local Code Mode checks, then tests the icons package in an ephemeral copy. Go's module-selected toolchain must be at least 1.27. Before inference, evaluator prewarm injects the acceptance source into a separate ephemeral baseline copy and compiles it without running tests. It completes the evaluator's exact toolchain and dependency closure only in evaluator-private caches; generated test objects never enter the agent caches. Candidate edits inside those submodules are rejected during patch collection.

The evaluator runs in a fresh clone with the same submodule commits. It receives the supplied test at `internal/homepage/icons/fetch/ab_acceptance_test.go` and runs:

```sh
go test -json -count=1 -ldflags=-checklinkname=0 -run '^TestABAcceptance' ./internal/homepage/icons/fetch
go test -json -count=1 -ldflags=-checklinkname=0 ./internal/homepage/icons/fetch
```

For both profiles, grading requires each declared `TestABAcceptance` test to emit run and pass events in both commands. A zero exit without executed tests, or skipped acceptance tests, does not pass. These checks never inject the evaluator into the agent's baseline. CPU, memory, authentication, no-resume rules, and usage metering are unchanged. The stock profile uses the default service tier and persists the selected reasoning effort in both state and its minimal config.

The runner also repeats the scoped package tests twice in one process, offline, against read-only evaluator source. These supplemental checks have a 180-second test timeout and do not replace required gates. A test failure is advisory; an infrastructure or cleanup failure retains required-check evidence but prevents judging and successful workflow completion. Required grading time, supplemental time, and source-assessment usage remain separate. Task-specific extra contracts belong in the evaluator test selected before inference, not in manual post-run work.

## Blind judge

The `run` command performs this step automatically after both grading gates complete. For an older complete pair without a judge attempt:

```sh
./dist/codex-ab judge --run-dir "$run_dir" --confirm-paid-inference
```

The gpt-5.6-sol judge uses high reasoning and the fast service tier (normalized by Codex to the priority request tier). It receives the task, anonymous patches, changed-file lists, test evidence, and read-only anonymous evaluator source directories for inspecting affected contracts and callers. It does not receive arm labels, costs, the original solution, agent logs, or either agent's writable filesystem. Two independent stock-config homes judge opposite presentation orders. Each returns validated JSON scores for correctness (50%), completeness (20%), maintainability (20%), and test quality (10%), plus evidence, issues, and a winner. Critical findings override totals; a candidate that failed any required gate cannot win. Disagreement is reported rather than forced into consensus. Prompts include check summaries and references to complete, read-only sanitized logs. Large logs stay available without filling the prompt or being truncated. Oversized patches or summary packs still fail explicitly. Reports created before this setting change retain their recorded medium/default judge metadata.

## Report

```sh
./dist/codex-ab report --run-dir "$run_dir"
```

The runner automatically writes `reports/report.md`, `reports/report.json`, and a checksummed `reports/bundle/` after execution, including partial runs. The bundle contains setup identities, task and evaluator controls, captured patches, interaction and role audits, source assessment, paired comparison, supplemental repeat results, and integrity checks. Encrypted interaction content remains unknown; command waits are counted separately from reviewer-status polling. The standalone `report` command refreshes the standard report and an existing finishing bundle without starting inference. Readable rejected judge responses are retained separately as unvalidated evidence, never as an eligible winner. It includes raw, cached, cache-write, output, reasoning-output, and total tokens for root and child agents; estimated public-list API cost; command time; agent and grader wall time; gate status; B-minus-A percentages; both raw judge passes; and a separate judge cost. Pricing is fetched and snapshotted once per run, with source, timestamp, assumptions, and warnings. If usage or required checks are incomplete, the report shows no overall winner.

If execution completed but finishing failed before a judge request, fix the reported issue and use `finish --run-dir DIR --confirm-paid-inference`. It archives the failed bundle, preserves the same candidates and grades, runs only a not-yet-started judge, and regenerates the report bundle. It never restarts either A/B agent or a started judge attempt. A completed judge can be reused when only artifact generation failed.

For post-hoc troubleshooting deductions, use `remeter --run-dir DIR --exclusions FILE`. The JSON file contains `arm` (`stock` or `current`), `rationale`, and `responses` and `commands` arrays of `{ "id": "...", "reason": "..." }`. IDs must match recorded response and command IDs. The command writes a separate `reports/remeter-*/` accounting report using the recorded pricing, retaining the original run and reports. It does not rerun agents, rewrite later context usage, or claim an adjusted wall time.

For a confirmed evaluator infrastructure fault, fix the runner and use `regrade --run-dir DIR --reason "concrete correction"`. This archives the previous report bundle and grading state, verifies unchanged task/test/Bun inputs and captured patches, then grades fresh evaluator workspaces with the pinned image and evaluator-only caches. It refreshes the reports without rerunning agents or making model requests. Earlier judge results are marked stale because their test evidence has changed; their original output and cost remain preserved. This command cannot clear run-wide isolation or input invalidity.

## Failure and automation behavior

- Exit 0 means the requested command, including automatic finishing for `run`, completed, not that an arm passed its evaluation. Finishing failures exit nonzero and preserve available evidence; they never restart inference.
- Invalid isolation, missing setup dependencies, non-private auth, malformed judge output, and repeated run/judge attempts exit nonzero.
- If an infrastructure fault is discovered after an attempt, record it without discarding evidence: `./dist/codex-ab invalidate --run-dir "$run_dir" --reason "concrete reason"`. Invalidated attempts retain metrics but cannot be judged or produce a winner.
- Commands reject unknown, inapplicable, and repeated options rather than silently changing the requested scope.
- Operations on one run are mutually exclusive, including report generation and invalidation, so concurrent commands cannot overwrite lifecycle state or start duplicate inference. A second command fails while the first owns the run. Normal exit releases the lock. A hard-killed process leaves `.operation-lock`; verify that its process and containers are stopped before manually removing that empty directory to inspect retained evidence. Never use lock removal to resume or restart inference.
- `run.json` is written atomically and is the machine-readable lifecycle record.
- Logs and manifests never contain auth contents. Treat the whole mode-0700 run directory as private because it contains temporary Codex homes and agent patches.

Use `./dist/codex-ab --help` for all flags. For development, run `bun test` and `bun run build`.
