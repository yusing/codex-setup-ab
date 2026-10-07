# Agent-directed CLI guide

[README](../README.md) · [Specification](spec.md) · [Contract](contract.md) · [CLI guide](cli.md)

Run commands from the repository root. Human-directed work uses the
[Web UI](../README.md#launch-and-watch-in-the-web-ui). For pair preparation, execution,
semantic grading, and report options, see the [contract](contract.md).
Use `./dist/codex-ab --help` for all flags.

## Prerequisites and build

You need Bun 1.4 or later, Git, Python 3 for Mekugi export validation, Docker with BuildKit named-context support, access to the source commit, a standalone Codex binary and its matching `codex-code-mode-host` companion, and a mode-0600 Codex `auth.json`. The pinned Ubuntu 24.04 image copies Go 1.27.1 and Node 24.21.0 from public, digest-pinned official images; it does not inherit another benchmark image's runtime, wrappers, source, home, or credentials. It copies the chosen standalone Codex pair directly. Preparation records the CLI version plus both files' SHA-256 identities; preflight requires both container copies to match.

For human-directed work, [start the Web UI](../README.md#launch-and-watch-in-the-web-ui). Pair
preparation checks and builds the selected image automatically. The following manual
build commands are for agent-directed setup.

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
  --build-arg "BENCH_UID=1000" \
  --build-arg "BENCH_GID=1000" \
  -t codex-ab:0.1.0 .
./dist/codex-ab --version
```

The harness follows the selected host Codex version, not a separately pinned CLI release. The container operator is always `1000:1000`. The preset runner checks an existing image before use and rebuilds it when its operator identity or the Codex/code-mode-host binary hashes differ from the selected host setup, so stale images are not reused after a Codex update. Existing prepared runs retain their recorded runtime identities; prepare a new run to use an updated host pair.

No model request occurs during the build or `prepare`. The `run` command includes two independent source-assessment passes after a completed pair. Each pass has two stages when the first harness succeeds, or three when one repair stage is needed; every stage allows at most three Sol launches on capacity errors. `judge` is available for older, not-yet-judged pairs. Both commands make model requests using your Codex authentication and quota, and require `--confirm-paid-inference` to start. Reported API costs are list-price estimates, not subscription charges or invoices.

## Repeat a pinned comparison

Start from an unused prepared pair. `prepare-trials` runs model-free preflight, pins the immutable
image, input identities and pricing snapshot, then copies fresh source/setup trees for every pair.
The prototype is not executed. Each pair has independent writable homes and container layers;
task dependencies share the pinned Docker image without per-pair cache copies. Configured tools
reuse the same read-only host installation store without per-pair copies; keep that store
available and unchanged while the trial set is in use.

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

## Retain exact Mekugi build provenance

To bind the selected executable pair to dirty source and compiled guidance, build from a captured
context rather than supplying a nearby checkout:

```sh
build_dir="$(./dist/codex-ab build-mekugi \
  --source /home/ubuntu/projects/mekugi --image codex-ab:0.1.0)"
```

This model-free command uses the comparison runner's bundled Mekugi source-exclusion rules. It
retains a source archive, the archiver, build command/logs, immutable builder-image identity,
and the executable hash in a private temporary directory. Compilation consumes the archive
inside a container without host credentials. Dependency downloads are allowed during this build;
no model request is made. Failed builds retain their available evidence.

Use `prepare --mekugi-build "$build_dir"` instead of `--mekugi-bin` and
`--mekugi-source`. Preparation snapshots the runner-bundled analyzer and isolation scripts,
checks the executable, and copies source provenance into the existing result bundle. No live source
checkout or original build directory is needed after preparation. The run image is still
selected independently and verified normally. This is locally recorded build provenance,
not a signed third-party attestation. Supplying binaries without a build bundle remains
supported and explicitly reports missing source provenance.

## Portable task packs

Portable packs include [nvm download](../tasks/nvm-download-no-eval/manifest.json),
[Gin context copy](../tasks/gin-context-copy/manifest.json), and
[skills manager agent CLI](../tasks/skills-mgr-agent-cli/README.md). Each pins its upstream base and
excluded solution commit, dependency preparation, and behavioral criteria. NVM and Gin also
enforce their task-required single-file boundaries; the skills manager task leaves file scope open.
They use the generic `task` profile, not a repository-specific runner branch.

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

## Diverse task suite

`tasks/diverse-suite.json` selects four pinned task packs: Gin, Flask, Express, and nvm. Supply a JSON object mapping each task ID to a local checkout of its source repository. The suite checks each checkout against its pack's base and forbidden commits, prepares at least two fresh pairs per task/setup, and runs model-free preflight before allowing inference. The new Flask and Express packs use adaptive grading, not prequalified hidden-test oracles. Their selected existing tests passed on the pinned baseline (Flask: 9; Express: 71).

```sh
cat > /tmp/codex-ab-sources.json <<'JSON'
{
  "gin-context-copy": "/path/to/gin",
  "flask-ipv6-server-name": "/path/to/flask",
  "express-transfer-encoding": "/path/to/express",
  "nvm-download-no-eval": "/path/to/nvm"
}
JSON
suite_run="$(./dist/codex-ab prepare-suite \
  --suite ./tasks/diverse-suite.json --sources-file /tmp/codex-ab-sources.json \
  --comparison stock-current --count 2 --order alternating \
  --image codex-ab:0.1.0)"
./dist/codex-ab run-suite --suite-run "$suite_run" --confirm-paid-inference
./dist/codex-ab report-suite --suite-run "$suite_run"
```

The suite report gives task-level counts and B-minus-A time and estimated cost effects only for complete pairs where **both** candidates pass. Its macro mean weights each eligible task once; unknown cost is not zero-filled. The suite executes trial sets sequentially, does not resume interrupted runs, and retains partial reports. It is descriptive rather than a randomized causal estimate.

## Reuse a completed stock control

For a direct-Codex comparison, reuse the original stock result from a completed stock-only or paired run. You can also create a control with `run --arm stock --confirm-paid-inference`. Its finished bundle must be complete and valid. Prepare a second run with matching task, model, Codex/image, dependency image, resources, and recorded setup controls, then run it with `--control-run` and the SHA-256 of the published control bundle's `MANIFEST.sha256` file:

```sh
control_sha="$(sha256sum "$control_run/reports/bundle/MANIFEST.sha256" | cut -d' ' -f1)"
./dist/codex-ab run --run-dir "$treatment_run" \
  --control-run "$control_run" --control-bundle-sha256 "$control_sha" \
  --confirm-paid-inference
```

Only the treatment arm starts a new agent. The control bundle, state, rollout bytes, and usage totals must match, and both captured patches are graded against the new run's evaluator. A mismatched or altered control fails before treatment inference. This historical comparison does not establish unchanged host tool-store contents or configuration across runs. This path does not support the Grok, journal-compaction, or duplicate-output comparisons, or reuse of an imported control.

For a standalone B run, use `run --arm current --confirm-paid-inference` without `--control-run`. It retains a single-arm report and bundle without a paired judge or winner.

## Skills manager bundle profile

The [skills-mgr bundle task](../tasks/skills-mgr-bundle/README.md) is a multi-part task outside Mekugi and GoDoxy. Use `--profile skills-mgr-bundle` with explicit source, base, forbidden commit, task, and `--criteria` inputs. It prepares the root Go package without Mekugi plugin assets. Candidate-specific checks are authored during semantic assessment, rather than supplied as hidden test files.

## GoDoxy icons profile

Use `prepare --profile godoxy-icons --reasoning-effort medium` (or `xhigh`) with explicit `--source`, `--base`, `--forbidden`, `--task`, and `--criteria` inputs. Prepare a fresh pair for each effort, launcher, or repeat. Add `--current-launcher mekugi` to launch the current arm as `mekugi codex`; otherwise it launches bare Codex. Select the Mekugi executable with `--mekugi-bin` if needed. The profile accepts only the pinned synthetic base `c335ef2d83d9fb8a774cb70b9b628ade54c654a2`, its recorded tree, excluded solution, and three exact submodule commits.

The source must contain local repositories at `goutils`, `internal/go-oidc`, and `internal/gopsutil` with the base commit's gitlink objects. Preparation shallow-fetches those exact commits into independent submodule clones, removes their remotes, and records their paths, source provenance, and SHAs in `run.json`. It rejects root remotes and initialized or populated `webui` throughout setup, patch collection, and grading. It does not initialize `webui`. The current arm uses the same audited current-home snapshot rules as the default profile.

Preflight retains the bare-image and local Code Mode checks. Go's module-selected toolchain must be at least 1.27. Candidate edits inside the pinned submodules are rejected during patch collection. The supplied criteria choose dependency preparation and existing tests; use the icons package with `-ldflags=-checklinkname=0` where needed. Both independent semantic passes evaluate the task against the captured candidates.


The workflow is hybrid: grading, usage accounting, token/time/cost breakdowns, report generation,
and retry decisions are deterministic code. Only candidate implementation, semantic harness authoring and qualitative source
assessment use models. No conversational subagents are needed to grade, judge, or explain the
recorded performance measurements.
