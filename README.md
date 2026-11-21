# codex-ab

`codex-ab` runs isolated, descriptive comparisons of coding-agent setups on the same
pinned repository task. Compare minimal Codex with your current guidance, direct Codex
with Mekugi, two setup commits on shared pinned runtime binaries, specific Mekugi
treatments, or Mekugi against the Grok CLI.

The Web UI prepares and launches runs, streams progress, and inspects retained results.
Reports combine behavioral grades, source assessments, time, tokens, and estimated API
costs. Unknown measurements stay unknown, and a single pair does not support causal or
general conclusions.

Evidence separates trusted candidate capture, verifier completion, evaluator
qualification, usage coverage, and pricing precision. Reports pair joint-success
comparisons with scored-attempt reliability and cross-task uncertainty; original
benchmark verifiers run in a separate fixed-verifier mode. See the
[evidence reliability guide](doc/fhe-evolution.md).

## Prerequisites and build

- **Core tools**: Bun 1.4+, Git, Docker with BuildKit, and access to the task's source
  repository and pinned commit.
- **Codex runtime**: Standalone Codex and its Code Mode companion are installed inside
  the shared Docker image; the host does not need Codex.
- **Inference credentials**: A mode-0600 Codex `auth.json` (plus a Grok OAuth store for
  `codex-mekugi-grok`).
- **Mekugi comparisons**: Python 3 and a complete [installed Mekugi runtime](doc/cli.md#installed-mekugi-runtime)
  in one directory. Preparation snapshots these host artifacts without compiling Mekugi
  or Rust, separately from the stock Codex pair.

Pair preparation checks and builds the selected image automatically. For manual build
commands and container details, see the [CLI build guide](doc/cli.md#prerequisites-and-build).
Build, preparation, and preflight make no model requests. Running candidates and judges
uses your authentication and quota and requires explicit paid-inference consent.
Reported API costs are list-price estimates, not subscription charges or invoices.

## Launch and watch in the Web UI

### Starting the workbench

Start the dark-mode workbench from the repository root:

```sh
bun install
bun start
```

Open **http://localhost:4849**. `scripts/run.sh` also starts the Web UI and accepts
server options (`--host ADDRESS`, `--port PORT`). The server binds to `127.0.0.1` by
default; to expose it on your Tailscale interface:

```sh
bun start --host "$(tailscale ip -4)"
```

Then open `http://<your-tailscale-ip>:4849` from a device in your tailnet (`--host 0.0.0.0`
listens on all IPv4 interfaces; `--host ::` listens on IPv6). Because the workbench has
no login and can control local files and paid runs, bind only to trusted interfaces and
keep the server running while an operation is active.

### Configuring comparisons

- **Task and source**: Choose a pinned task and source checkout, then run **Check inputs**
  before starting. Tasks with a pinned upstream repository (such as NVM and
  [sqlite-utils](tasks/sqlite-utils-history/README.md)) clone a missing checkout during
  preparation. Custom task fields appear only for the custom task.
- **Arms and presets**: Configure per-arm model, reasoning effort, execution limits, and
  Mekugi behavior in the **Arms** tabs (Mekugi switches and response/idle timeouts appear
  only on Mekugi arms). **Custom composition** supports additional arms with independent
  launchers and setup commits.
- **Skills**: Toggle individual skills from each arm's setup registry (**Disable all**
  turns off every listed skill; **Use setup defaults** restores defaults). Overrides apply
  only to that arm's disposable runtime home; minimal guidance includes no setup skills.
- **Setup commits and worktrees**: For **Setup commit versus setup commit**, pick both
  revisions in their arm tabs (tracked local edits are excluded; see the
  [setup-commit guide](doc/cli.md#compare-setup-commits)). In custom compositions,
  **Current tracked setup** captures tracked edits from the setup repo; if it is a
  separate worktree, set **Runtime home** under **Host infrastructure** to the home
  containing installed tools and supplements. Untracked instruction files are not captured.
- **Repeats and imports**: Set a repeat count of 2+ to prepare fresh trial pairs. To
  compare against earlier runs, choose **Previous result** in an arm tab (or use
  **Compare against HEAD** on a completed run) with repeat count 1 and at least one fresh
  slot. **Reuse historical evaluation** (default) preserves imported grades and adapts
  historical tests to fresh candidates; **Fresh evaluation of all candidates** regrades
  every patch. See the [import guide](doc/cli.md#import-previous-arms).
- **Inference consent**: Preparation-only mode is off by default. Grant paid-inference
  consent before starting a run, or select preparation-only for a model-free check.

Suite preparation and agent-directed launches use the CLI:

```sh
./dist/codex-ab launch --preset NAME --prepare-only
```

Add `--confirm-paid-inference` (plus task, model, reasoning, or compaction flags) to
execute inference. See the [CLI guide](doc/cli.md) and [contract](doc/contract.md).

### Live progress and results

- **Streaming view**: Displays phase messages, elapsed time, persisted run/arm/judge
  status, candidate output tails, and partial results over server-sent events. Dropped
  connections reconnect automatically; closing a browser tab leaves the server operation
  running, and reloading after a server restart reattaches the selected evidence directory
  while preserving unsent form inputs.
- **Cancellation and attachment**: Stopping an active operation retains available evidence
  and cleans up owned containers. Other retained runs, trial sets, and suites can be
  attached by directory. Started runs never restart; audited judge recovery remains
  available.
- **Results and actions**: Results lead with the overall outcome, grades, per-pass
  criterion counts, and judge scores, followed by time, token, and cost comparisons,
  criterion evidence, judge reasoning, warnings, aggregates, and retained artifacts.
  Existing-run actions cover report generation, source assessments, usage correction,
  invalidation, preflight, and grading. Loaded views reflect current invalidation reasons
  over older winner claims, and failed builds surface available compiler logs without a
  provenance manifest.

### Storage, privacy, and agent handoff

- **Browser persistence**: Arm settings, preset, imported-result paths, and skill
  overrides are saved in `localStorage` (clear site data to reset). Request tokens,
  credentials, and paid-inference consent are never saved.
- **Isolation and privacy**: The workbench runs one operation at a time and keeps its run
  list in server memory; benchmark evidence stays in private external run directories.
  Credentials are local file paths, never pasted contents, and paid inference requires
  fresh consent for every operation.
- **Agent handoff**: Use **Copy evidence reference** in the run view to copy the absolute
  evidence directory and current workbench entry ID. Entry IDs expire on server restart;
  the retained directory is the durable reference.

## Documentation

- [Specification](doc/spec.md): comparison scope, treatments, and benchmark intent.
- [Contract](doc/contract.md): isolation, criteria schema, judging, accounting, and failure behavior.
- [CLI guide](doc/cli.md): manual builds, repeated comparisons, task packs, suites, and control reuse.
- [Verifier completion and qualification](doc/verification.md): independent assertions, frozen controls, and task-pack migration.
- [Fixed verifiers](doc/fixed-verifier.md): pinned original-verifier execution and its comparability limits.
- [Guidance and launcher experiment](doc/guidance-launcher.md): prepare four matched cells and fresh repeated trials without inference.
- [Evidence reliability](doc/fhe-evolution.md): required provenance, interpretation, and validation.
- [sqlite-utils multi-commit upgrade](tasks/sqlite-utils-history/README.md): post-cutoff, 19-commit brownfield task for quality and requirement retention.
- [Regression coverage map](doc/regression-coverage.md): agent failure classes that task packs and checks can and cannot detect.

Started runs and trial sets do not restart or resume. Cancellation preserves available
evidence; prepare a fresh pair for another attempt. Limited judge recovery is documented
in the [contract](doc/contract.md#blind-judge). Treat external run directories as private
(they contain temporary agent homes and patches), and keep recorded Docker images and
the host tool store unchanged while runs or trial sets use them.

## Development

```sh
bun run check
bun run build
```

`check` validates repository-relative documentation paths, typechecks production
TypeScript, and runs all tests across six isolated worker processes. Runner tests are
split by workflow with private fixtures per file; tests within each file stay serial to
protect spies and environment changes (for example, `bun test runner-setup.test.ts`).

CI runs `bun run check`, builds the CLI, and runs a separate model-free Docker job on
pushes, pull requests, and a weekly schedule covering capture, verifier supervision,
source-reader boundaries, arm network separation, fixed-verifier mounts, imports, and
container cleanup. Local live checks are opt-in and use no paid inference (skipped checks
do not verify a container boundary). To smoke-test the Code Mode companion offline:

```sh
CODEX_AB_LIVE_TOOLHOST=1 bun test toolhost.test.ts
```

Set `CODEX_AB_LIVE_IMAGE` to target a different built image.

### Source ownership and focused checks

| Change | Start here | Focused tests |
| --- | --- | --- |
| UI rendering and evidence watching | [Browser app](web/app.js), [server](web-server.ts) | `bun test web-server.test.ts` |
| Task choices, presets, and launch defaults | [Launch catalog](launch.ts), [CLI options](cli-options.ts) | `bun test preset.test.ts task-pack.test.ts` |
| Execution, grading, and recovery | [Workflow](workflow.ts), [runner](runner.ts), [semantic judge](semantic-judge.ts) | `bun test runner semantic.test.ts` |
| Trusted candidate capture | [Collector](candidate-script.txt), [manifest verification](candidate-evidence.ts) | `bun test candidate.test.ts`; Docker: `candidate.live.test.ts` |
| Verifier provenance and qualification | [Supervisor protocol](semantic-protocol.ts), [qualification](semantic-qualification.ts), [fixed adapter](fixed-verifier.ts) | `bun test semantic-protocol.test.ts fixed-verifier.test.ts fixed-workflow.test.ts` |
| Source judge permissions | [Capability boundary](judge-boundary.ts), [reader](judge-reader.mjs) | `bun test judge-boundary.test.ts`; Docker: `judge-boundary.live.test.ts` |
| Setup snapshots and isolation | [Preparation](prepare.ts), [snapshot verification](snapshot.ts), [isolation](isolation.ts) | `bun test snapshot.test.ts container.test.ts toolhost.test.ts` |
| Usage, cost, and retained reports | [Usage](usage.ts), [diagnostics](diagnostics.ts), [report](report.ts) | `bun test usage.test.ts diagnostics.test.ts cache-diagnostics.test.ts` |
| Reliability and repeated comparisons | [Reliability](reliability.ts), [uncertainty](uncertainty.ts), [factorial experiment](factorial.ts) | `bun test reliability.test.ts uncertainty.test.ts factorial.test.ts trials.test.ts suite.test.ts` |
| Documentation navigation | [Path checker](scripts/check-docs.ts) | `bun test scripts/check-docs.test.ts` |

Start searches in the owning files and use symbol outlines before whole-file reads.
Retained benchmark directories contain large generated evidence, not harness source.
For result-ID lookup and bounded evidence inspection, see the
[inspection guide](doc/cli.md#find-and-inspect-retained-evidence).
