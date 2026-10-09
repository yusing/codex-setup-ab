# codex-ab

`codex-ab` runs isolated, descriptive comparisons of coding-agent setups on the same
pinned repository task. Compare minimal Codex with your current guidance, direct Codex
with Mekugi, or specific Mekugi treatments. A Grok CLI comparison is also available.

The Web UI prepares and launches runs, streams progress, and inspects retained results.
Reports combine behavioral grades, source assessments, time, tokens, and estimated API
costs. Unknown measurements stay unknown. A single pair does not support causal or
general conclusions.

## Prerequisites and build

- Bun 1.4 or later, Git, and Docker with BuildKit named-context support.
- Access to the task's source repository and pinned commit.
- A standalone Codex binary with its matching `codex-code-mode-host` companion.
- A mode-0600 Codex `auth.json` for inference.
- Python 3 and a Mekugi executable for comparisons using Mekugi export validation.

Pair preparation checks and builds the selected image automatically. For manual
build commands and runtime details, see the [CLI build guide](doc/cli.md#prerequisites-and-build).
Build, preparation, and preflight make no model requests. Running candidates and judges
uses your authentication and quota and requires explicit paid-inference consent.
Reported API costs are list-price estimates, not subscription charges or invoices.

## Launch and watch in the Web UI

Start the dark-mode workbench from this repository:

```sh
bun install
bun start
```

Open **http://localhost:4849**. `scripts/run.sh` also starts the Web UI and accepts only
server options such as `--host ADDRESS` and `--port 4850`. Human-directed
preparation, launch, watching, and result inspection belong in this workbench.
The server binds to `127.0.0.1` by default. To bind to your Tailscale address:

```sh
bun start --host "$(tailscale ip -4)"
```

Open `http://<your-tailscale-ip>:4849` from a device in your tailnet. You can also
use `--host 0.0.0.0` to listen on all IPv4 interfaces, or `--host ::` for IPv6.
The workbench has no login and can control local files and paid runs. Bind only
to trusted interfaces. Keep the server running while an operation is active.

Choose a pinned task and comparison, set the source checkout, model, reasoning effort,
and optional Mekugi settings, then **Check inputs**. The workbench explains incompatible
combinations and missing local inputs before starting work. Advanced settings expose
the existing preparation options, including custom task packs and task/criteria files.
Tasks with a pinned upstream repository, such as NVM and sqlite-utils row history,
clone a missing source checkout during preparation. The sqlite-utils task defaults to
minimal Codex versus minimal Mekugi, auto journal compaction, a shared 200,000-token
auto-compact limit, xhigh reasoning, and a 55-minute limit.
Preparation only is off by default; explicitly consent to paid inference before
starting a run, or select preparation only for a model-free check. Enter optional
Mekugi flags as space-separated text, for example `--mode=mekugi --duplicate-output=false`.
A repeat count of two or more prepares fresh trial pairs.
The suite workflow accepts a suite manifest and source-mapping file.

The run view shows phase messages, elapsed time, persisted run/arm/judge status,
candidate output tails, and partial results while work continues. Updates arrive
through server-sent events when operation or evidence files change. A dropped
connection reconnects automatically and loads the current view. You can stop an
active operation; cancellation retains available evidence and uses the runner's
container cleanup. Closing a browser tab leaves the server operation running.
Reload to reconnect, or attach an existing run, trial-set, or suite directory after
restarting the server. Started runs are never restarted; the existing audited
judge-recovery action remains available.

Results lead with the overall outcome and each setup's grade, per-pass criterion counts,
and judge scores, followed by time, token and estimated-cost comparisons, criterion
evidence, judge reasoning, warnings, trial/suite aggregates, and retained reports,
patches, and logs. Unknown metrics stay unknown. Each result is descriptive evidence,
not a causal conclusion. Report generation, source assessments, usage correction,
invalidation, preflight, and grading are available as existing-run actions in the UI.
Mekugi build capture is available as a separate model-free operation.
Explicit selection loads the selected run even when automatic watching is paused.
Pausing evidence updates keeps operation status and Stop feedback live.
Loaded or refreshed views use current invalidation reasons instead of winner claims
from an older report. Regenerate the report to update exported evidence. Failed builds expose their available compiler
logs and build outcome without requiring a successful provenance manifest.

The workbench runs one operation at a time. Its run list is kept in server memory;
benchmark evidence stays in the existing external run directories. Credential inputs
are local file paths, never pasted credential contents. The browser does not serve
private homes or authentication stores. Paid inference requires fresh consent for
each operation. Checks and report-only actions do not grant this consent.

Use **Copy evidence reference** in the run view when asking an agent to inspect results.
The reference includes the absolute evidence directory and the current workbench entry ID.
If the browser blocks clipboard access, the UI selects the reference for manual copying.
Entry IDs expire when the server restarts; the retained directory is the reusable reference.

For agent-directed preset launch, use `codex-ab launch --preset NAME` with
task/model/reasoning/compaction flags and explicit `--confirm-paid-inference`.
Use `--prepare-only` to stop before inference. Existing CLI commands and flags remain
available to agents. See the [CLI guide](doc/cli.md) and [contract](doc/contract.md) for these interfaces.

## Documentation

- [Specification](doc/spec.md): comparison scope, treatments, and benchmark intent.
- [Contract](doc/contract.md): isolation, criteria schema, judging, accounting, and failure behavior.
- [CLI guide](doc/cli.md): manual builds, repeated comparisons, task packs, suites, and control reuse.
- [sqlite-utils row history](tasks/sqlite-utils-history/README.md): a long-session brownfield quality and requirement-retention task.

Started runs and trial sets do not restart or resume. Cancellation preserves available
evidence; prepare a fresh pair for another attempt. Limited judge recovery is documented
in the [contract](doc/contract.md#blind-judge). Treat external run directories as private:
they contain temporary agent homes and patches. Keep the recorded Docker images available
and the host tool store unchanged while runs or trial sets use them.

## Development

```sh
bun run check
bun run build
```

`check` validates repository-relative documentation paths, typechecks production
TypeScript, and runs the existing tests. CI runs the same command and builds the CLI.
Live Docker and Mekugi tests remain opt-in; ordinary checks use no paid inference.

### Source ownership and focused checks

| Change | Start here | Focused tests |
| --- | --- | --- |
| UI rendering and evidence watching | [Browser app](web/app.js), [server](web-server.ts) | `bun test web-server.test.ts` |
| Task choices, presets, and launch defaults | [Launch catalog](launch.ts), [CLI options](cli-options.ts) | `bun test preset.test.ts task-pack.test.ts` |
| Execution, grading, and recovery | [Workflow](workflow.ts), [runner](runner.ts), [semantic judge](semantic-judge.ts) | `bun test runner.test.ts semantic.test.ts` |
| Setup snapshots and isolation | [Preparation](prepare.ts), [snapshot verification](snapshot.ts), [isolation](isolation.ts) | `bun test snapshot.test.ts container.test.ts toolhost.test.ts` |
| Usage, cost, and retained reports | [Usage](usage.ts), [diagnostics](diagnostics.ts), [report](report.ts) | `bun test usage.test.ts diagnostics.test.ts cache-diagnostics.test.ts` |
| Documentation navigation | [Path checker](scripts/check-docs.ts) | `bun test scripts/check-docs.test.ts` |

Start searches in the owning files and use symbol outlines before whole-file reads.
Retained benchmark directories contain large generated evidence, not harness source.
For result-ID lookup and bounded evidence inspection, see the
[inspection guide](doc/cli.md#find-and-inspect-retained-evidence).
