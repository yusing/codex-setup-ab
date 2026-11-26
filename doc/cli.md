# Agent-directed CLI guide

[README](../README.md) · [Specification](spec.md) · [Contract](contract.md)

Run commands from the repository root using `./dist/codex-ab` (or `bun cli.ts` without
building). Human-directed work belongs in the
[Web UI](../README.md#launch-and-watch-in-the-web-ui). Run `./dist/codex-ab --help` for
the full command and option list.

- **Related guides**: [evidence reliability](fhe-evolution.md),
  [verifier completion and qualification](verification.md),
  [fixed-verifier mode](fixed-verifier.md), and the
  [four-cell preparation helper](guidance-launcher.md).
- **Default output parent**: Retained run, trial, suite, reevaluation, and build outputs
  default to `/var/tmp`; override with `--output-parent`.
- **Hybrid execution**: Grading, usage accounting, token/time/cost breakdowns, report
  generation, and retry decisions are deterministic code. Only candidate implementation,
  semantic harness authoring, and qualitative source assessment use models.

## Prerequisites and build

You need Bun 1.4+, Git, Docker with BuildKit, access to the source commit, and Python 3
(for Mekugi export validation). Inference also requires a mode-0600 Codex `auth.json`
(and a Grok OAuth store for `codex-mekugi-grok`). You do not need Codex installed on the
host.

The Ubuntu 26.04 image installs standalone Codex and its matching Code Mode companion
using the [official installer](https://learn.chatgpt.com/docs/codex/cli#get-started-with-codex-cli)
at image build time. The base includes Node, Bun, Python, and Ubuntu Git (with
`--no-lazy-fetch`, local clones, and HTTPS). The full target adds Go, compilers,
and protected-runtime tools. The Rust target adds pinned Rust and a C compiler.
Images do not include a host setup or credentials.

Pair preparation checks and builds the selected image automatically. Manual build
commands for agent-directed setup:

```sh
bun run build
docker build -t codex-ab:0.1.0 .
./dist/codex-ab --version
```

`launch` reuses a capable image or builds one if missing or incomplete. Leave the
workbench image blank, or omit `--image`, to use the lean image for the built-in NVM,
Flask, sqlite-utils, and Express packs. The
[Mekugi native source tools](../tasks/mekugi-source-tools/README.md)
pack uses the Rust image. Go tasks, custom packs, and protected runtime use the
full image. Set `--image` or `CODEX_AB_IMAGE` to override this choice.
Direct `prepare` and `prepare-suite` expect a prebuilt image and default to the full
image. The container operator is `1000:1000`. To
refresh Codex deliberately, rebuild with `--no-cache` and prepare a new run (existing
runs stay pinned to their recorded image ID, Codex version, and executable hashes, which
`preflight` verifies).

Build, preparation, and preflight make no model requests. Candidate execution and
adaptive judging require `--confirm-paid-inference` and use your authentication and
quota. Reported costs are list-price estimates, not subscription charges or invoices.
See the [judge contract](contract.md#blind-judge) for stages, retries, and limits.

## Find and inspect retained evidence

Prefer the absolute directory from the Web UI's **Copy evidence reference** action.
Workbench entry IDs belong to the running server, not persisted benchmark identity. If
you have only an entry ID, query the running server's `/api/entries` endpoint instead of
scanning repositories, temporary homes, or provider captures:

```sh
curl -fsS http://localhost:4849/api/entries | python3 -c '
import json, sys
entry_id = sys.argv[1]
matches = [entry for entry in json.load(sys.stdin)["entries"] if entry["id"] == entry_id]
if not matches:
    sys.exit("Entry not found. Ask for the retained evidence directory; the server may have restarted.")
for entry in matches:
    print(json.dumps({key: entry.get(key) for key in ("id", "title", "kind", "directory")}, indent=2))
' 'ENTRY_ID'
```

Adjust host/port if needed. After a server restart, reattach the retained directory
directly—old entry IDs cannot recover paths. Run directories are private: share selected
measurements and artifact paths, not authentication homes or raw provider captures.

### Diff retained first requests

Compare a retained first turn against `stock` in the same run or against a previous
Mekugi run without changing evidence or calling a model:

```sh
./dist/codex-ab first-request-diff --run-dir "$run"
./dist/codex-ab first-request-diff --run-dir "$run" --against-run "$previous"
```

Use `--arm` and `--against-arm` for other arm names. The unified diff compares startup
messages and tool definitions before the first sampled item, plus the first turn's
Mekugi transport receipt when retained (`stock` has no Mekugi receipt; neither the
receipt nor the rollout records the full provider request). Inspect output before
sharing because it includes private prompt text.

### Read-only pair summary recipe

This read-only recipe emits selected measurements and a compact artifact index for a
pair, preserving missing evidence as `null` without inference, report regeneration, or
recursive scans:

```sh
python3 - '/absolute/path/to/run' <<'PY'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1]).resolve()
def load(relative):
    path = root / relative
    return json.loads(path.read_text()) if path.is_file() else {}
state = json.loads((root / "run.json").read_text())
report = load("reports/report.json")
def arm_summary(arm):
    recorded = (report.get("arms") or {}).get(arm) or {}
    result = (state.get("results") or {}).get(arm) or recorded.get("result") or {}
    usage = recorded.get("usage") or {}
    return {"exit_code": result.get("exit_code"),
            "agent_elapsed_ms": result.get("agent_elapsed_ms"),
            "checks_passed": (result.get("grade") or {}).get("passed"),
            "usage_complete": usage.get("complete"), "totals": usage.get("totals")}
artifacts = ["run.json", "reports/report.md", "reports/report.json"]
for arm in ("stock", "current"):
    artifacts += [f"artifacts/{arm}/codex.jsonl", f"artifacts/{arm}/codex.stderr",
                  f"artifacts/{arm}/changes.patch"]
print(json.dumps({"directory": str(root), "run_id": state.get("id"),
    "status": state.get("status"), "error": str(state["error"])[:300] if state.get("error") else None,
    "validity": report.get("validity"), "winner": report.get("winner"),
    "arms": {arm: arm_summary(arm) for arm in ("stock", "current")},
    "warnings": [str(warning)[:300] for warning in (report.get("warnings") or [])[:10]],
    "artifacts": [str(root / path) for path in artifacts if (root / path).is_file()]}, indent=2))
PY
```

Open only the specific report section or bounded log tail needed afterward. Trial and
suite directories contain `trials.json` or `suite.json` listing their child run
directories. See the [report contract](contract.md#report) for retained evidence and
measurement limits.

## Compare setup commits

Use the workbench's **Setup commit versus setup commit** comparison, or prepare a
model-free pair from the CLI:

```sh
./dist/codex-ab launch --preset setup-commits --task nvm-download-no-eval \
  --current-home /path/to/configuration-repository \
  --setup-a-commit BASE_REF --setup-b-commit TREATMENT_REF --prepare-only
```

Pass `--current-launcher mekugi` to run both arms on the same pinned Mekugi runtime
(default is direct Codex). Commit selectors apply to the setup repository, not the task
repository, and exclude dirty tracked edits. Repeat count/order controls repeat the
frozen snapshots; paid inference still requires `--confirm-paid-inference`.

Both `launch` and `prepare` accept per-arm overrides via `--arm-settings` keyed by
retained arm keys (`stock`, `current`, `arm-3`, …), for example:

```sh
--arm-settings '{"current":{"mekugi_flags":["--child-reply-summary=false"],
                           "skills":{"example":false}}}'
```

Omitted fields keep command defaults. Only pass `--shell-guard` with a pinned
Mekugi build that supports the switch. Skills are setup-level selections.
Repository-local selections keep `skills-mgr`'s normal precedence. See the
[preparation contract](contract.md#prepare-an-isolated-pair) for runtime supplements,
models, reasoning, and resource controls.

## Repeat a pinned comparison

Start from an unused prepared pair. `prepare-trials` runs model-free preflight, pins the
immutable image, input identities, and pricing snapshot, and copies fresh source/setup
trees for every pair without executing the prototype. Each pair gets independent
writable homes and container layers while sharing the pinned dependency image and
read-only host tool store (keep that store unchanged while the trial set is in use).

```sh
trial_set="$(./dist/codex-ab prepare-trials --run-dir "$run_dir" --count 4)"
./dist/codex-ab run-trials --trial-set "$trial_set" --confirm-paid-inference
```

- **Schedule**: Pairs run sequentially with **both arms concurrent by default**. Pass
  `--order alternating` to run A then B on odd pairs and B then A on even pairs; do not
  pool concurrent and alternating schedules as equivalent experiments.
- **Grok trials**: Pass `--grok-auth-file /path/to/.grok/auth.json` to `run-trials` for
  `codex-mekugi-grok` sets.
- **Failure and cancellation**: Failed pairs retain evidence without discarding later
  trials. Cancellation stops the active pair and leaves remaining pairs unstarted.
  Started sets never resume or restart; each finished pair's evidence bundle is copied
  into trial-set storage before continuing.
- **Reporting**: `run-trials` prints an aggregate `report.md` (with paired means,
  medians, sample standard deviations, winner counts, separate judge costs, and inline
  per-pair reports) alongside JSON, checksums, and per-pair bundles (excluding auth
  homes). Only complete valid paired measurements enter aggregates; missing metrics stay
  unknown, zero A baselines omit percentage deltas, and negative differences are kept.
  Regenerate a self-contained report without inference via
  `./dist/codex-ab report-trials --trial-set "$trial_set"`.

## Installed Mekugi runtime

Install from the [Mekugi monorepo](https://github.com/mekugi-harness/mekugi#release-binaries).
For its default release install location, pass `--mekugi-bin ~/.local/bin/mekugi`
or set `CODEX_AB_MEKUGI_BIN` for launch and the workbench. Preparation snapshots
the installed host Mekugi runtime without compiling Go or Rust.
Keep all six artifacts beside `--mekugi-bin`: `mekugi`, `mekugi-exec`,
`mekugi-app-server`, `codex-code-mode-host`, Linux `bwrap`, and `mekugi-models.json`.
All six are frozen, hashed, and kept separate from stock Codex's code-mode host; missing
artifacts fail preparation.
The dependency image installs the Linux runtime libraries for dynamically linked
Bubblewrap and app-server builds. If an older run failed preflight because
`libcap.so.2` was missing, start a fresh launch to build the fixed dependency
image. Retained runs still point to their original images.

Previously captured bundles remain readable through `--mekugi-build` without running a
build: their Go executable/source provenance is retained, while native artifacts are
frozen from the installed Mekugi beside `go/bin/mekugi` under Runtime home. A historical
Go build bundle does not establish native source provenance; installed binaries without
source provenance remain supported and are labeled accordingly in reports.

## Portable task packs

Portable packs pin their upstream base, excluded solution commit, evaluator reference
endpoint, dependency preparation, and behavioral criteria under the generic `task`
profile (permitting relevant regression tests and documentation without synthetic
single-file boundaries). See the [regression coverage map](regression-coverage.md) for
which failure classes they detect.

Clone the source repository locally, then prepare and preflight from its manifest:

```sh
git clone https://github.com/nvm-sh/nvm.git /var/tmp/codex-ab-nvm-source
run_dir="$(./dist/codex-ab prepare \
  --task-pack ./tasks/nvm-download-no-eval/manifest.json \
  --source /var/tmp/codex-ab-nvm-source \
  --comparison same-setup \
  --mekugi-source /home/ubuntu/projects/mekugi \
  --image codex-ab:0.1.0)"
./dist/codex-ab preflight --run-dir "$run_dir"
```

For Gin, clone `https://github.com/gin-gonic/gin.git` and pass
`tasks/gin-context-copy/manifest.json`. `--task-pack` requires `--source` and rejects
overrides of its profile, base, forbidden commit, prompt, or criteria. Only the pinned
base enters candidate workspaces.

Preparation fingerprints and freezes the manifest, prompt, expanded criteria, and (when
`source.reference_commit` is set) the ordered upstream reference patches and combined
diff under evaluator-only storage; no original pack directory is needed afterward. A
fingerprint identifies supplied content, not upstream authenticity. Pack contracts
record `qualification: "not-run"`; preparation never authorizes inference.

### Commit-backed task provenance

| Pack | Baseline and commit date | Reference endpoint | Criterion evidence |
| --- | --- | --- | --- |
| [Gin](../tasks/gin-context-copy/manifest.json) | `2e4d4f3`, June 22, 2026 | [`293ad7e`](https://github.com/gin-gonic/gin/commit/293ad7edebb3ae30369288bd6416ca0d78474727) | `copy-isolation`, `existing-copy-behavior`: `Context.Copy` and `TestContextCopy*` in `context_test.go`. |
| [Flask](../tasks/flask-ipv6-server-name/manifest.json) | `de8429f`, August 11, 2026 (authored July 14) | [`7203fea`](https://github.com/pallets/flask/commit/7203feabf723edae0286ae5dc64fec8ac4c91735) | `ipv6-server-name`, `existing-address-selection`: `Flask.run` host/port docs and run-config/port/default tests (URL-parser normalization allowed). |
| [Express](../tasks/express-transfer-encoding/manifest.json) | `59e205a`, June 15, 2026 | [`9a34acf`](https://github.com/expressjs/express/commit/9a34acf03cb818ff3f8bc40e44176e277a25cbb9) | `transfer-encoding-length` (`18e5985` four transfer-coding cases); `send-regressions` (ETag fix `9a34acf` and `test/res.send.js`). |
| [Nvm](../tasks/nvm-download-no-eval/manifest.json) | `52047ed`, July 15, 2026 | [`b17550a`](https://github.com/nvm-sh/nvm/commit/b17550a0b9ab691439815dfccc8b73e3a59fa103) | `literal-arguments`, `wget-translations`, `curl-posix`: `install.sh` (Bash-sourced), unchanged curl route, `nvm_download_no_eval_injection` (`sh -n` syntax check; option-like output operands out of scope). |

Verified knowledge cutoffs (checked October 29, 2026):
[`gpt-6-astra`](https://developers.openai.com/api/docs/models/gpt-6-astra) and
[`gpt-6.1-sol`](https://developers.openai.com/api/docs/models/gpt-6.1-sol) are April 30,
2026; [`gpt-6.2-astra`](https://developers.openai.com/api/docs/models/gpt-6.2-astra) is
May 18, 2026; [`gpt-6.2-sol`](https://developers.openai.com/api/docs/models/gpt-6.2-sol)
is June 1, 2026. Every baseline above postdates all four cutoffs; verify other models
(including Grok) separately. The
[skills manager](../tasks/skills-mgr-agent-cli/README.md),
[remote uninstall](../tasks/skills-mgr-remote-uninstall/README.md),
[fast conditional acquisition](../tasks/skills-mgr-get-short-circuit/README.md), and
[sqlite-utils](../tasks/sqlite-utils-history/README.md) packs record their own
provenance and cutoff evidence, as does
[Mekugi native source tools](../tasks/mekugi-source-tools/README.md).

Notes on reference scope:
- Gin, Flask, and Nvm each freeze one reference commit; Express freezes 18 ancestry
  commits to reach `9a34acf` (only the two named fixes define new requirements).
  Reference limitations are permitted, not mandatory rejection rules; safe
  improvements are acceptable.
- [Mekugi coordination checkpoints](../tasks/session-retention/README.md) is
  retired from the launch catalog. Retained runs and explicit portable-pack
  preparation remain available.
- Legacy `skills-mgr-bundle` and `godoxy-icons` profiles have no commit-backed
  post-cutoff qualification.

## Diverse task suite

`tasks/diverse-suite.json` selects Gin, Flask, Express, NVM, and sqlite-utils. Map each task ID to a
local checkout containing its baseline and reference ancestry:

```sh
cat > /tmp/codex-ab-sources.json <<'JSON'
{
  "gin-context-copy": "/path/to/gin",
  "flask-ipv6-server-name": "/path/to/flask",
  "express-transfer-encoding": "/path/to/express",
  "nvm-download-no-eval": "/path/to/nvm",
  "sqlite-utils-history": "/path/to/sqlite-utils"
}
JSON
suite_run="$(./dist/codex-ab prepare-suite \
  --suite ./tasks/diverse-suite.json --sources-file /tmp/codex-ab-sources.json \
  --comparison stock-current --count 2 --order alternating \
  --image codex-ab:0.1.0)"
./dist/codex-ab run-suite --suite-run "$suite_run" --confirm-paid-inference
./dist/codex-ab report-suite --suite-run "$suite_run"
```

Preparation creates at least two fresh pairs per task/setup and runs model-free
preflight. The suite executes trial sets sequentially, does not resume interrupted runs,
and retains partial reports. Its report shows task-level counts plus B-minus-A time and
estimated cost effects on complete joint-pass pairs (macro mean weights each eligible
task once; unknown costs are not zero-filled). Results are descriptive, not randomized
causal estimates.

## Import previous arms

In the workbench, use **Start from a completed run → Compare against HEAD** (or the same
action on an attached run's results page) to build an editable draft importing every
completed arm plus one fresh configuration-repo `HEAD` arm.

From the CLI, pass `--import-arms` to `launch` or `run` to fill existing slots from
completed, infrastructure-valid published runs while leaving at least one fresh slot:

```sh
./dist/codex-ab launch --preset stock-current --task nvm-download-no-eval \
  --import-arms '[{"target_arm":"stock","run_dir":"/path/to/previous-run","arm":"current"}]' \
  --confirm-paid-inference
```

Add `--prepare-only` to save selections without inference, or attach imports to a
prepared run with
`./dist/codex-ab run --run-dir "$run_dir" --import-arms 'JSON_ARRAY' --confirm-paid-inference`.
Custom compositions can import multiple arms across `stock`, `current`, `arm-3`, ….
To test tracked edits from a separate configuration worktree, pass `--current-home` (the
worktree root), `--runtime-home` (the home with installed tools), and
`"setup_commit":"worktree"` on the fresh custom arm (`HEAD` uses committed files only;
untracked instruction files are excluded).

Optional `bundle_sha256` pins a mapping; otherwise its current manifest is pinned.

| Evaluation choice | Effect |
| --- | --- |
| `--evaluation-mode reuse` (default) | Preserve imported grades/scores; adapt their checks only for fresh candidates. |
| `--evaluation-mode fresh` | Regrade and blindly reassess all patches (required if historical assessment evidence is missing). |
| `--evaluation-baselines '{"arm-4":"arm-3"}'` | Pick an imported baseline per fresh slot (omitted mappings use the last imported slot). |

Reuse rankings require the same complete rubric across candidates; mixed rubrics omit a
quality ranking. Original runs stay unchanged, missing metrics stay unknown, and imports
require repeat count 1 without `--arm` or `--control-run`. See the
[import contract](contract.md#run-and-grade-both-arms) for exact matching and accounting
rules.

## Reevaluate retained implementations

Re-run evaluator checks and both blind judge passes under the current rubric for every
arm in a completed, infrastructure-valid published run without rerunning implementation
agents:

```sh
./dist/codex-ab reevaluate --run-dir /path/to/completed-run \
  --output-parent ./results --confirm-paid-inference
```

The original run stays unchanged. The new evidence directory retains source provenance
and implementation measurements, records new evaluator/judge costs, and can be attached
in the workbench. Keep pinned images and immutable preparation inputs available; this
does not restart an incomplete implementation run.

## Reuse a completed stock control

For direct-Codex comparisons, reuse an original `stock` result from a completed paired
or stock-only run (`run --arm stock --confirm-paid-inference`). Prepare a matching
treatment run, then pass `--control-run` and the SHA-256 of the control bundle's
`MANIFEST.sha256`:

```sh
control_sha="$(sha256sum "$control_run/reports/bundle/MANIFEST.sha256" | cut -d' ' -f1)"
./dist/codex-ab run --run-dir "$treatment_run" \
  --control-run "$control_run" --control-bundle-sha256 "$control_sha" \
  --confirm-paid-inference
```

Only the treatment arm launches an agent; both captured patches are graded against the
new run's evaluator, and any mismatch fails before treatment inference. This legacy path
does not establish unchanged host tool-store contents across runs and does not support
`setup-commits`, `codex-mekugi-grok`, `duplicate-output`, or imported controls.

For a standalone B run, use `./dist/codex-ab run --arm current --confirm-paid-inference`
without `--control-run` (retains a single-arm report/bundle without a paired judge or
winner).

## Skills manager bundle profile

The [skills-mgr bundle task](../tasks/skills-mgr-bundle/README.md) uses
`--profile skills-mgr-bundle` with explicit `--source`, `--base`, `--forbidden`,
`--task`, and `--criteria`. It prepares the root Go package without Mekugi plugin
assets; candidate-specific checks are authored during semantic assessment.

## GoDoxy icons profile

Use `./dist/codex-ab prepare --profile godoxy-icons --reasoning-effort medium` (or
`xhigh`) with explicit `--source`, `--base`, `--forbidden`, `--task`, and `--criteria`
(add `--current-launcher mekugi` and optional `--mekugi-bin` to launch `current` through
Mekugi). The profile accepts only synthetic base
`c335ef2d83d9fb8a774cb70b9b628ade54c654a2`, its recorded tree, excluded solution, and
three exact submodule commits (`goutils`, `internal/go-oidc`, `internal/gopsutil`).

Preparation shallow-fetches those three local submodules into independent clones without
remotes, records their SHAs in `run.json`, and rejects root remotes, initialized
`webui`, and candidate edits inside pinned submodules. Go's module-selected toolchain
must be at least 1.27; supplied criteria own dependency prep (using
`-ldflags=-checklinkname=0` for the icons package where needed) and existing tests.
