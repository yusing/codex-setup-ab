# Verifier completion and evaluator qualification

[Contract](contract.md) · [CLI guide](cli.md)

New semantic evidence uses `codex-ab.criterion-evidence.v2`. An exit code, printed
test count, success marker, or `HARNESS_ERROR:` line is candidate-controlled data.
None establishes that a verifier completed or that a failure belongs to the
evaluator. Historical reports and evidence remain unchanged.

## Independent observations and assertions

The offline executor runs a Python supervisor as container root with only the
capabilities needed to create a private workspace and drop child privileges.
Candidate commands run as UID/GID 65534, without supplementary groups or model
credentials, on `--network none`. The supervisor owns the expectations and
compares observed results outside the candidate process. Candidate processes
cannot write the private result mount or signal the supervisor. A completed
record binds the exact check hash and the ordered, nonempty case set.
The supervisor retains `CAP_KILL` so it can stop a timed-out child after the UID
drop; the child must have zero effective, permitted, and ambient capabilities.
Its total command budget leaves two seconds inside the outer container deadline
for cleanup and the protected result, with a 100ms minimum for short deadlines
and a 120-second per-command cap. Timed-out command output is retained.

`verification.schema` is `codex-ab.verification.v1`. Supported observations are:

- `command`: run argv with optional text stdin; assert both the exit code and
  exact stdout. `format: "text"` compares exact text, including newlines.
  `format: "json"` compares parsed JSON structurally.
- `python-call`: import a documented module and invoke its callable in an
  unprivileged Python child. `input` is JSON text containing `args` and `kwargs`;
  `expected` is JSON text. The parent compares the observed JSON value. A library
  that exits zero before producing a value fails this protocol.

Each case is a separate process. Stateful library APIs, arbitrary shared-process
pytest/Go/Jest suites, non-JSON object results, streaming protocols, and arbitrary
language-specific function calls need dedicated adapters. This protocol does not
claim an attested native function return against a deliberately reflective
implementation that forges the same observable RPC value. It measures the
declared external observations, with sensitive/incorrect checks constrained by
frozen qualification controls.

Legacy `command` checks still execute and retain their output. A zero exit without
supervisor assertions is **unassessed**, even if a test runner prints a passing
summary. Nonzero child status is retained as candidate/test-command failure;
printed vocabulary cannot convert it to an evaluator error. Supervisor setup,
missing configured executables, invalid evaluator Python syntax, timeout,
cancellation, and missing result records are distinct unassessed outcomes.
Candidate syntax/import/runtime errors reached through the declared interface
remain behavioral failures. A candidate's chosen exit code 125 has no special
authority. Retained baseline test failures are not reclassified by output text.
Checks can declare `evaluator_dependencies`, an array of top-level Python module
names used only by the evaluator. The supervisor verifies these in a clean
isolated interpreter outside the candidate import path. An unavailable declared
evaluator dependency is a wiring failure; an undeclared missing import reached
inside candidate code remains a candidate error. Declaring a candidate-owned
dependency as evaluator-only is invalid wiring and must be rejected in review
and qualification.

The raw independent observation result is retained as `probe_status`. An adaptive
criterion can become an authoritative pass or failure only after its frozen
evaluator controls have qualified the check. Missing or broken controls leave
the raw result unassessed for quality eligibility and reliability scoring.
The adaptive judge refuses a task missing `existing_test_verification` or any
required frozen control role before reading credentials, fetching pricing,
warming caches, or making a model request. It also requires every candidate's
trusted capture manifest and patch to match the retained baseline and identity.
Multi-arm adaptive benchmark execution checks the same task contract before
candidate setup or inference, so missing controls cannot consume candidate spend
and fail only when judging begins. Deliberate singleton execution is exempt.
Prepare/configure-fixed remain available for original fixed-verifier tasks
without adaptive controls. Configured fixed mode cannot invoke the adaptive
judge. These are preparation requirements for new evaluation; older retained
records do not acquire qualification from their previous pass labels.

## Frozen controls and a complete example

`evaluator_controls` is stored in the task criteria before implementation begins.
Its files stay in evaluator-only inputs. Every required criterion needs a
reference control expected to pass, an unchanged baseline with its declared
expected result, a targeted incorrect implementation expected to fail, and a
valid alternative expected to pass. A baseline may legitimately pass an
unaffected requirement. Role labels alone do not establish a valid oracle:
task authors must map each expectation to the pinned task/reference behavior.

Controls start from `baseline` or the pinned upstream `reference`. The latter
requires `source.reference_commit` and the frozen combined reference patch.
`files` apply explicit regular-file replacements; `source: null` deletes a file.
Paths cannot escape the control tree. `python_target` adapts only the callable
interface while preserving every case input and expected output.

For a small change to a large existing source file, `patches` accepts frozen
objects with `path`, `before_sha256`, `after_sha256`, and a unified `diff`.
Each patch must modify exactly its named existing regular file. The executor
checks the preimage hash, applies the patch, and checks the postimage hash before
running a check. Symlinks, path escapes, file creation/deletion, mode changes,
multiple-file diffs, and overlapping file replacements are rejected. The full
patch remains part of the frozen control identity.

The following compact criteria example is for a fictional task that introduces
`math_impl.add(a, b)`. Replace the task hash with the actual prompt hash and use
real pinned task/reference behavior in production. The inline reference is a
fixture, not an official benchmark task.

```json
{
  "schema": "codex-ab.criteria.v1",
  "task_sha256": "REPLACE_WITH_THE_TASK_SHA256",
  "criteria": [
    {"id": "sum", "description": "Return the numeric sum of both inputs", "required_interface": "math_impl.add(a, b)"}
  ],
  "preparation": "true",
  "existing_tests": "python3 -m unittest discover",
  "existing_test_verification": {
    "schema": "codex-ab.verification.v1",
    "cases": [
      {"id": "preserved-zero", "kind": "python-call", "module": "math_impl", "callable": "add", "input": "{\"args\":[0,0],\"kwargs\":{}}", "expected": "0"}
    ]
  },
  "qualification": "not-run",
  "evaluator_controls": {
    "schema": "codex-ab.evaluator-controls.v1",
    "cases": [
      {"id": "reference", "role": "reference", "base": "baseline", "files": [{"path": "math_impl.py", "source": "def add(a, b): return a + b\n"}], "expected": {"sum": "pass"}},
      {"id": "unchanged", "role": "baseline", "base": "baseline", "files": [], "expected": {"sum": "fail"}},
      {"id": "subtraction", "role": "negative", "base": "baseline", "files": [{"path": "math_impl.py", "source": "def add(a, b): return a - b\n"}], "expected": {"sum": "fail"}},
      {"id": "alternative", "role": "alternative", "base": "baseline", "files": [{"path": "math_impl.py", "source": "def combine(a, b): return sum([a, b])\n"}], "python_target": {"module": "math_impl", "callable": "combine"}, "expected": {"sum": "pass"}}
    ]
  }
}
```

The corresponding authored check includes independent cases, for example:

```json
{
  "criterion": "sum",
  "files": [],
  "command": ["true"],
  "rationale": "Both inputs contribute, including negative and zero inputs.",
  "verification": {
    "schema": "codex-ab.verification.v1",
    "cases": [
      {"id": "positive", "kind": "python-call", "module": "math_impl", "callable": "add", "input": "{\"args\":[2,3],\"kwargs\":{}}", "expected": "5"},
      {"id": "negative", "kind": "python-call", "module": "math_impl", "callable": "add", "input": "{\"args\":[-2,3],\"kwargs\":{}}", "expected": "1"},
      {"id": "zero", "kind": "python-call", "module": "math_impl", "callable": "add", "input": "{\"args\":[0,0],\"kwargs\":{}}", "expected": "0"}
    ]
  }
}
```

`command` is the retained legacy argv field; when independent verification cases
are supplied, those cases are the executed assertions. The existence of this
field does not authorize treating `true` as behavioral coverage.

Each candidate-specific check runs against every applicable control using the
same offline executor. This also runs after a repair. Evidence records the
evaluator/model version, task hash, reference commit, exact check hash, control
identity, per-control result and qualification scope in
`qualification/qualification.json` beside the check evidence. A no-op that passes
both correct and incorrect controls fails qualification. Missing roles or an
unassessed control are not successful qualification. Same-model reversed orders
remain a presentation-bias check, not independent ground truth.

The existing-test gate needs `existing_test_verification` defining the supported
independent observations for retained behavior. Adding a single trivial case
does not certify an entire test suite. Declare the actual scope and meaningful
assertions. The runner also executes the original `existing_tests` command once
per candidate and judge pass in a separate offline workspace. Its stdout, stderr,
exit status and timing are retained under `existing-command/__existing_test_command`
and `pass-N-existing-command` as non-gating diagnostics. Recovery reuses that
record. These command diagnostics cannot substitute for independent observations
or settle a criterion or eligibility result.
This distinction prevents a missing completion record from being silently
treated as a complete successful test suite.

## Repair invariants

Passed and failed behavioral checks are frozen. Only unassessed execution can be
considered for wiring repair. The replacement must include `repair.defect` and
nonempty lists named `retained_inputs`, `retained_assertions`,
`retained_edge_cases`, and `retained_failure_conditions`. The runner independently
checks that ordered case IDs, inputs and expected values are unchanged. An
interface/command adaptation may reach a different implementation without
changing those obligations. Qualification repeats on the replacement. A previous
behavioral failure cannot be cleared by a later passing assessment, including
when importing a manually altered evidence history.

## Model-free verification

```sh
bun test semantic.test.ts semantic-protocol.test.ts semantic-preflight.test.ts judge-boundary.test.ts
CODEX_AB_LIVE_DOCKER=1 bun test semantic.live.test.ts
CODEX_AB_LIVE_DOCKER=1 CODEX_AB_LIVE_IMAGE=codex-ab:model-free bun test judge-boundary.live.test.ts
```

The live test uses `CODEX_AB_VERIFIER_IMAGE` or `python:3.13-slim`; pull the chosen
image before running the gate. It exercises correct/wrong/early-exit libraries,
candidate syntax/import failures, evaluator syntax failures, zero tests, fake
success markers, CLI observations, private result permissions, supervisor signal
permissions, and the offline network namespace. Cache tests additionally require
`CODEX_AB_LIVE_REFERENCE_RUN`. Skipped live tests do not verify the container
boundary. No test in this workflow authorizes paid inference.

The existing [Flask IPv6 task](../tasks/flask-ipv6-server-name/README.md) is a
complete migrated pack with real pinned upstream source controls. Its observer
calls actual `Flask.run`, replacing only `werkzeug.serving.run_simple` to record
host, port, options, application identity, and cleanup. The original scoped
pytest command remains a separate diagnostic. The model-free live test uses
seven IPv6 observations and thirteen retained-behavior observations, asserting
each complete JSON batch from the supervisor. It executes the ordinary semantic
assessment and qualification path against the reference, unchanged baseline,
targeted source mutant, and an independent valid parser. CI installs the pack's
pinned Python dependencies and fetches the exact upstream reference before this
offline test. Other task packs require their own mapped controls and observations;
this migration does not qualify them.

```sh
CODEX_AB_LIVE_DOCKER=1 CODEX_AB_VERIFIER_IMAGE=codex-ab:model-free \
  CODEX_AB_FLASK_SOURCE=/path/to/pinned/flask \
  bun test flask-qualification.live.test.ts
```

The source-judge live test uses the pinned Codex CLI and a local Responses mock
inside a container with networking disabled. It inspects the tools actually
advertised to the provider without supplying credentials or purchasing model
output. Its allowlist includes the reader and native utility tools. Native
`apply_patch` remains registered: read-only/never policy denies writes before
diff emission or patch execution, but verification reads can still expose a
path-existence or guessed-context oracle beyond the broker's roots. This is
not a claim that all native reads are confined to the broker. Generic process
execution, code mode, delegation, plugins, apps, hooks, and image tools are
disabled for the pinned source judge.
