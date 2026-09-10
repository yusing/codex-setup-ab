# codex-ab

`codex-ab` runs one controlled, descriptive comparison of the same Codex model on the same repository task. The **stock** arm receives only a minimal model, service-tier, permission, and workspace-trust configuration. The **current** arm receives an audited snapshot of the user's instructions, skills, hooks, roles, and supporting tools. Both arms use bare Codex directly; Hpatch is not part of either treatment.

This is designed for a careful pilot, not a claim that one setup causes better results. A single pair does not support causal or general conclusions.

## Prerequisites and build

You need Bun 1.4 or later, Git, Docker with BuildKit named-context support, access to the source commit, the standalone Codex 0.153.4 binary and its matching `codex-code-mode-host` companion, and a mode-0600 Codex `auth.json`. The pinned Ubuntu 24.04 image copies only Go and Node from `hpatch-bench:run-D9ZuS3`; it does not inherit that image's Hpatch runtime, wrappers, source, home, or credentials. It copies the chosen standalone Codex pair directly. Preparation records the CLI version plus both files' SHA-256 identities; preflight requires both container copies to match.

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

No model request occurs during the build or `prepare`. The `run` and `judge` commands make model requests using your Codex authentication and quota, and require `--confirm-paid-inference` to start. Reported API costs are list-price estimates, not subscription charges or invoices.

## Prepare an isolated pair

```sh
run_dir="$(./dist/codex-ab prepare \
  --source /home/ubuntu/projects/hpatch \
  --base bb9e740362fd86c9214f5c893c65ae6c46587a60 \
  --forbidden d50b9e6d7a2b01fc033a8aab523791876e4441b5 \
  --task ./task.md \
  --acceptance ./acceptance_test.go)"
```

Preparation creates a new mode-0700 `mktemp` directory outside the repository. It shallow-fetches exactly the base commit into a bare seed, makes two `--no-local --no-hardlinks` clones, removes their remotes, and verifies tree identity, the lack of object alternates and linked worktrees, and absence of the future solution commit. The solution itself is never copied.

The current setup starts with a shallow, independent clone of the configuration repository rooted at `--current-home` (default `/home/ubuntu`), with its remote removed. All tracked configuration is included automatically, so adding or removing a guidance file does not require a runner change. Current tracked edits, staged additions, and deletions are overlaid without changing the source checkout. New untracked instruction files must be added to Git before preparation to be included.

Runtime supplements are copied separately: installed hooks, materialized skills and bundled plugins, the referenced remote-skill cache generations, the existing Modern Go Guidelines provider, and supporting executables. Other untracked home files, including authentication, session history, and Hpatch state, are not copied. The source repository is expected to contain only configuration suitable for the benchmark, not tracked credentials or task solutions.

The clone preserves absolute `/home/ubuntu` paths inside its container. `snapshot-manifest.json` records the configuration commit and tree, overlaid tracked paths, a SHA-256 for every regular setup file (excluding Git metadata), literal symlink targets, and portability adaptations. Before inference, preflight runs a referenced remote skill and the registered Go-guidelines hook with networking disabled. An unsupported hook or missing tool fails instead of being silently disabled.

The evaluator test is copied under `evaluator/`, which is never mounted into an arm. Each arm sees only its own clone, Go cache, and private home. Agent logs and captured patches are kept outside its writable mounts. It cannot see the sibling, the host's live home or repositories, the Docker socket, the acceptance test, or evaluator artifacts.

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

The command first checks that the image exposes Codex 0.153.4, its hash-matched code-mode host, and no `hpatch`; exercises a real local code-mode execution without model access; and checks the current snapshot's required tools. For each arm it installs locked plugin dependencies, builds only the ignored JavaScript embed missing from a clean checkout, verifies that the tracked WASM is unchanged, and compile-prewarms a dedicated Go cache. It rejects any preparation that changes either immutable baseline. Only after both preparations pass does it start both gpt-6-astra arms at the selected reasoning effort (default medium) concurrently with identical two-CPU and 4 GiB limits. Preflight and the final launch check verify copied controls, both setup templates, the Bun snapshot, and immutable baseline identity. The image tag is resolved before checking it, and all subsequent containers use that image ID. The default agent timeout is 30 minutes. Both arms use the service tier read from the snapshotted current configuration, and the report records it.

Milestones go to stderr. Timeout or cancellation stops session-created containers and preserves available patches and results. Runs never restart or resume: prepare a new directory for another attempt.

For a non-comparative run, use `run --arm current` or `run --arm stock`. Only the selected arm is launched, captured, and graded. The report shows its executed checks and root-plus-child usage, but cannot claim paired measurement completeness or a winner; `judge` refuses singleton runs.

After both agents stop, the runner captures tracked, committed, staged, and untracked changes as a binary patch relative to the recorded immutable base. Only then does it create separate evaluator workspaces, install their locked dependencies without rewriting tracked generated assets, inject `acceptance_test.go`, run the focused `^TestABAcceptance` prefix gate, and run the full `internal/router` suite. Git inspection and patch capture of candidate repositories run in separate offline containers, never on the host. Acceptance injection also happens inside the evaluator container, so candidate symlinks cannot redirect writes into the host. Agent and grader times remain separate.

## GoDoxy icons profile

Use `prepare --profile godoxy-icons --reasoning-effort medium` (or `xhigh`) with explicit `--source`, `--base`, `--forbidden`, `--task`, and `--acceptance` inputs. This profile requires `run --arm stock`; prepare a fresh directory for each effort or repeat. The default profile remains Hpatch. The GoDoxy profile requires explicit task and acceptance options and accepts only the pinned synthetic base `c335ef2d83d9fb8a774cb70b9b628ade54c654a2`, its recorded tree, excluded solution, and three exact submodule commits; altered identities or copied controls fail preflight.

The source must contain local repositories at `goutils`, `internal/go-oidc`, and `internal/gopsutil` with the base commit's gitlink objects. Preparation shallow-fetches those exact commits into independent submodule clones, removes their remotes, and records their paths, source provenance, and SHAs in `run.json`. It rejects root remotes and initialized or populated `webui` throughout setup, patch collection, and grading. It does not initialize `webui`, capture current-home instructions or skills, or prepare Hpatch assets.

Preflight retains the bare-image and local Code Mode checks, then tests the icons package in an ephemeral copy. Go's module-selected toolchain must be at least 1.27; downloading it and dependencies may require network access. Prewarm uses the same package and rejects changes to tracked root files or initialized submodules. Candidate edits inside those submodules are rejected during patch collection.

The evaluator runs in a fresh clone with the same submodule commits. It receives the supplied test at `internal/homepage/icons/fetch/ab_acceptance_test.go` and runs:

```sh
go test -json -count=1 -ldflags=-checklinkname=0 -run '^TestABAcceptance' ./internal/homepage/icons/fetch
go test -json -count=1 -ldflags=-checklinkname=0 ./internal/homepage/icons/fetch
```

For both profiles, grading requires each declared `TestABAcceptance` test to emit run and pass events in both commands. A zero exit without executed tests, or skipped acceptance tests, does not pass. These checks never inject the evaluator into the agent's baseline. CPU, memory, authentication, no-resume rules, and usage metering are unchanged. The stock profile uses the default service tier and persists the selected reasoning effort in both state and its minimal config.

## Blind judge

After both grading gates complete:

```sh
./dist/codex-ab judge --run-dir "$run_dir" --confirm-paid-inference
```

The gpt-5.6-sol judge uses high reasoning and the fast service tier (normalized by Codex to the priority request tier). It receives only the task, anonymous patches, changed-file lists, and test evidence. It does not receive arm labels, costs, the original solution, agent logs, or either arm filesystem. Two independent stock-config homes judge opposite presentation orders. Each returns validated JSON scores for correctness (50%), completeness (20%), maintainability (20%), and test quality (10%), plus evidence, issues, and a winner. Critical findings override totals; a failed acceptance candidate cannot win. Disagreement is reported rather than forced into consensus. Oversized evidence fails explicitly instead of being truncated. Reports created before this setting change retain their recorded medium/default judge metadata.

## Report

```sh
./dist/codex-ab report --run-dir "$run_dir"
```

The report writes `reports/report.md` and `reports/report.json`. It includes raw, cached, cache-write, output, reasoning-output, and total tokens for root and child agents; estimated public-list API cost; command time; agent and grader wall time; gate status; B-minus-A percentages; both raw judge passes; and a separate judge cost. Pricing is fetched and snapshotted once per run, with source, timestamp, assumptions, and warnings. If usage or required checks are incomplete, the report shows no overall winner.

## Failure and automation behavior

- Exit 0 means the requested command completed, not that an arm passed its evaluation.
- Invalid isolation, missing setup dependencies, non-private auth, malformed judge output, and repeated run/judge attempts exit nonzero.
- If an infrastructure fault is discovered after an attempt, record it without discarding evidence: `./dist/codex-ab invalidate --run-dir "$run_dir" --reason "concrete reason"`. Invalidated attempts retain metrics but cannot be judged or produce a winner.
- Commands reject unknown, inapplicable, and repeated options rather than silently changing the requested scope.
- Operations on one run are mutually exclusive, including report generation and invalidation, so concurrent commands cannot overwrite lifecycle state or start duplicate inference. A second command fails while the first owns the run. Normal exit releases the lock. A hard-killed process leaves `.operation-lock`; verify that its process and containers are stopped before manually removing that empty directory to inspect retained evidence. Never use lock removal to resume or restart inference.
- `run.json` is written atomically and is the machine-readable lifecycle record.
- Logs and manifests never contain auth contents. Treat the whole mode-0700 run directory as private because it contains temporary Codex homes and agent patches.

Use `./dist/codex-ab --help` for all flags. For development, run `bun test` and `bun run build`.
