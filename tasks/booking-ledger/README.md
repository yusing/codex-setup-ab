# Booking Ledger new-project benchmark

This task compares stock Codex with minimally configured Codex through Mekugi,
with journal context reset enabled. Candidates build a new Python/SQLite CLI
from a seed containing only a placeholder README. The [candidate prompt](task.md)
fixes the product requirements; [criteria](criteria.json) bind their exact bytes.
The application design and command names remain open.

The overlapping intervals, atomic reschedule/import, dry run, and clipped reports
make correctness checkable across multiple features. Shared rules for UTC,
half-open intervals, cancelled bookings, IDs, validation, and persistent state
also expose requirement drift between code, tests, CLI behavior, and documentation.

## Launch in the Web UI

Open the workbench described in the main [README](../../README.md#launch-and-watch-in-the-web-ui)
and select **Booking Ledger new project**. Leave **Source checkout** blank to create
a private seed when preparation starts, or enter a seed previously created by the
helper below. **Check inputs** does not create a seed or start inference.

The task selects minimal Codex versus minimal Mekugi with auto journal compaction.
Its task defaults are xhigh reasoning and a 3300-second limit for each agent.
Comparison and runtime overrides remain available. Choose preparation only, or
give fresh paid-inference consent. Watch the operation and inspect its results
in the workbench.

## Agent-directed preparation without inference

Build the benchmark CLI and container image as described in the
[CLI build guide](../../doc/cli.md#prerequisites-and-build). From the benchmark root:

Use `./dist/codex-ab launch --task booking-ledger --prepare-only` for the same seed
creation and task defaults as the Web UI. The existing launch flags can override
the comparison and runtime settings. For explicit low-level preparation:

```sh
source_dir="$(bash tasks/booking-ledger/seed.sh)"
base="$(git -C "$source_dir" rev-parse benchmark-base)"
excluded="$(git -C "$source_dir" rev-parse benchmark-excluded)"
run_dir="$(./dist/codex-ab prepare \
  --profile task \
  --source "$source_dir" --base "$base" --forbidden "$excluded" \
  --task ./tasks/booking-ledger/task.md \
  --criteria ./tasks/booking-ledger/criteria.json \
  --comparison stock-mekugi \
  --mekugi-source /path/to/matching/mekugi \
  --mekugi-bin /path/to/mekugi \
  --mekugi-flags '["--mode=mekugi","--journal-compaction=auto"]' \
  --reasoning-effort xhigh --timeout 3300 \
  --image codex-ab:0.1.0)"
./dist/codex-ab preflight --run-dir "$run_dir"
```

The seed helper creates a private temporary Git repository outside this checkout.
It writes two deterministic commits and local tags there, with no application,
tests, solution, or candidate-facing evaluation material. The second, empty
commit is an exclusion sentinel, not a historical solution. The harness supplies
only the first commit to candidates and checks that the sentinel is absent.
The helper prints the source path and retains it; it does not modify this
checkout's Git state or start inference. Keep that directory for preparation and
trial preparation. This synthetic task uses standalone criteria rather than the
historical HTTPS task-pack schema.

Both agents have the same prompt, base, model, reasoning effort, minimal setup,
and installed-tool access. The Mekugi arm additionally uses the selected launcher
and its journal tools. Neither receives current-home instructions or skills.
Default model selection follows the harness; pin `--model` when repeating runs.

## Agent-directed execution

```sh
./dist/codex-ab run --run-dir "$run_dir" \
  --auth-file /path/to/.codex/auth.json --confirm-paid-inference
```

This starts paid inference for both agents and the two blind semantic assessments.
Each agent has a **55-minute maximum**, strictly below 60 minutes. Preparation,
preflight, and judges have separate budgets; total experiment time can exceed an
hour. The task is intended for sustained project work, but its actual duration
has not been measured and candidates can finish early. For repetitions, use
the existing [trial workflow](../../doc/cli.md#repeat-a-pinned-comparison) with a
fresh unused prepared pair. Keep model, effort, launcher identity, reset mode,
and concurrent/sequential schedule fixed within a comparison.

## Assess the outcome

Use the fixed criteria before either run. The existing judge weights are
correctness 50%, completeness 20%, maintainability 20%, and test quality 10%.
Requirement drift is an explicit criterion and evidence category, not an added
numeric score or a changed judge schema. Inspect each pass's per-criterion
decisions, executed evidence, source findings, and disagreements before using
an aggregate winner. Record:

- **Quality:** coherent design, useful errors/help, readable implementation,
  tests that can detect product failures, and usable README examples.
- **Correctness:** interval capacity, endpoint ties, cancellation, reschedule
  rollback, concurrent writes, import atomicity, dry-run equivalence, and clipped reports.
- **Completeness:** every required operation, output mode, validation rule,
  persistence behavior, documentation example, and test entry point.
- **Drift:** a specific prompt requirement contradicted or omitted in code,
  public behavior, tests, or README. Tie each finding to that requirement and
  evidence; distinguish a missing feature from an incorrect implementation.

Derive checks against the candidate's documented command names and JSON layout.
Use temporary databases and local files; run the required test command and CLI
journeys. The predetermined existing-test gate only checks the seed's Python
and SQLite environment, since there is no baseline application test suite.
It is not evidence that the candidate's product works. Evaluator wiring faults
remain unassessed. No prewritten hidden tests or excluded solution are supplied.

## Qualify journal reset evidence

`auto` enables journal resets, but this launcher/task does not force a reset or
guarantee slice continuation. Retain validated Mekugi capture, journal/compaction
evidence, and the request timeline. To call a result a **post-journal-reset**
observation, establish a successful root reset from journal evidence followed
by continued root work on this project. A flag, journal write, child reset,
provider-authored compaction, or counter alone does not prove that sequence.
Use the timeline to locate later edits and checks against the original prompt.

Report no observed reset and unavailable reset evidence separately. Keep these
runs in the general stock-versus-Mekugi comparison, but do not treat them as
post-reset evidence. Do not discard timed-out or incomplete candidates; retain
their partial work and distinguish product gaps from infrastructure failures.
This comparison changes the whole launcher/tool treatment, so it cannot isolate
the causal effect of journal reset. The existing journal-compaction comparison
answers a different question with Mekugi in both arms.

Qualification remains `not-run`: structural checks do not establish live reset
behavior, project completion time, judge quality, or a treatment advantage.
