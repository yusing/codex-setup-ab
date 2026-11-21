# Verifier completion and evaluator qualification

[README](../README.md) · [Contract](contract.md) · [CLI guide](cli.md)

New semantic evidence uses `codex-ab.criterion-evidence.v2`. An exit code, printed test
count, success marker, or `HARNESS_ERROR:` line is candidate-controlled data; none
establishes that a verifier completed or that a failure belongs to the evaluator.
Historical reports and evidence remain unchanged.

## Independent observations and assertions

The offline executor runs a Python supervisor as container root with only the
capabilities needed to create a private workspace, drop child privileges, and stop a
timed-out child (`CAP_KILL`). Candidate commands run as UID/GID `65534` with zero
effective/permitted/ambient capabilities, no supplementary groups, no credentials, and
`--network none`. The supervisor owns expectations, compares observations outside the
candidate process, and writes a private result mount that candidate processes cannot
write or signal. Completed records bind the exact check hash and ordered, nonempty case
set.

Total command budget leaves 2 seconds inside the outer container deadline for cleanup
and result writing (100 ms minimum for short deadlines; 120-second per-command cap).
Timed-out command output is retained. Stdout and stderr are each capped independently at
4 MiB (build artifacts and child files are uncapped); an extra byte stops the process
group and marks the observation unassessed (including during preparation). A truncated
prefix can never establish a pass.

`verification.schema` is `codex-ab.verification.v1`. Supported case kinds:

- **`command`**: runs `command` + `args` with optional text `stdin`, asserting both exit
  code and exact stdout. `format: "text"` checks exact text (including newlines);
  `format: "json"` compares parsed JSON structurally (equivalent numeric spellings such
  as `1`, `1.0`, and `1e0` match; booleans are not numbers). Put interpreter/entrypoint
  wiring in `command` and behavioral arguments (including option-style inputs) in `args`.
- **`python-call`**: imports a documented module and invokes its callable in an
  unprivileged Python child. `input` is JSON text (`args` and `kwargs`); `expected` is
  JSON text compared by the parent. Exiting zero without producing a value fails.

Each case runs in a separate process. Stateful library APIs, shared-process
pytest/Go/Jest suites, non-JSON results, streaming protocols, and arbitrary
language-specific calls require dedicated adapters. This protocol measures declared
external observations constrained by frozen qualification controls; it does not claim an
attested native return against a reflective implementation forging the same RPC output.

### Failure classification and preflight gates

- **Legacy `command` checks**: still execute and retain output, but exit zero without
  supervisor assertions is **unassessed** even if a test runner prints a passing summary.
  Nonzero child status is retained as candidate/test-command failure; printed text never
  reclassifies it (nor does candidate exit code 125). Retained baseline test failures are
  not reclassified by output text.
- **Unassessed vs. behavioral failures**: Supervisor setup errors, missing configured
  executables, invalid evaluator Python syntax, timeouts, cancellations, and missing
  result records are distinct unassessed outcomes. Candidate syntax, import, or runtime
  errors reached through the declared interface remain behavioral failures.
- **`evaluator_dependencies`**: optional list of top-level Python modules used only by
  the evaluator, checked in a clean interpreter outside the candidate import path. A
  missing declared evaluator dependency is a wiring failure; an undeclared missing import
  in candidate code remains a candidate error. Declaring a candidate-owned dependency as
  evaluator-only is invalid wiring.
- **Qualification gate**: Raw independent results are stored as `probe_status`. An
  adaptive criterion becomes an authoritative pass or failure only after frozen controls
  qualify the check; missing or broken controls leave it unassessed.
- **Pre-spend enforcement**: Both multi-arm adaptive benchmark execution and the adaptive
  judge refuse tasks missing `existing_test_verification` or any required frozen control
  role before reading credentials, fetching pricing, warming caches, or calling a model,
  and verify every candidate's trusted capture manifest and patch. Deliberate singleton
  execution is exempt. `prepare` and `configure-fixed` remain available for fixed-verifier
  tasks without adaptive controls, and configured fixed mode cannot invoke the adaptive
  judge. Historical records do not gain qualification from earlier pass labels.

## Frozen controls and a complete example

`evaluator_controls` is frozen in the task criteria before implementation begins and
stays in evaluator-only inputs. Every required criterion needs four roles:

1. **Reference control** (expected to pass)
2. **Unchanged baseline** (with its declared expected result; a baseline may legitimately
   pass an unaffected requirement)
3. **Targeted incorrect implementation** (expected to fail)
4. **Valid alternative** (expected to pass)

Role labels alone do not establish a valid oracle: task authors must map each expectation
to pinned task/reference behavior.

Controls start from `baseline` or pinned upstream `reference` (requiring
`source.reference_commit` and the frozen combined reference patch). `files` apply
explicit regular-file replacements (`source: null` deletes a file; path escapes are
rejected), and `python_target` adapts only the callable interface while keeping all
case inputs and expected outputs fixed. For small edits to large existing files,
`patches` accepts frozen objects (`path`, `before_sha256`, `after_sha256`, unified
`diff`) that must modify exactly one existing regular file and pass preimage/postimage
hash checks (symlinks, path escapes, creates/deletes, mode changes, multi-file diffs,
and overlapping replacements are rejected).

For a complete real criteria contract, see the
[Flask manifest](../tasks/flask-ipv6-server-name/manifest.json) and its
[control provenance](../tasks/flask-ipv6-server-name/README.md). Do not copy trivial
fixture controls into a real task.

A fictional `math_impl.add(a, b)` check illustrates the observation shape:

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

`command` is the retained legacy argv field; when independent verification cases are
present, those cases are the executed assertions (never treating `true` as coverage).

Each candidate-specific check (including repairs) runs against every applicable control
in the offline executor, recording evaluator/model version, task hash, reference commit,
check hash, control identity, per-control results, and scope in
`qualification/qualification.json`. A no-op passing both correct and incorrect controls
fails qualification, and missing roles or unassessed controls never qualify. Same-model
reversed orders check presentation bias, not independent ground truth.

The existing-test gate requires `existing_test_verification` with meaningful independent
observations for retained behavior. The runner also executes the original
`existing_tests` command once per candidate and pass in a separate offline workspace,
storing its output and timing under `existing-command/__existing_test_command` and
`pass-N-existing-command` as non-gating diagnostics (reused on recovery). These command
diagnostics cannot substitute for independent observations or settle eligibility.

## Repair invariants

Passed and failed behavioral checks are frozen; only unassessed execution is eligible
for wiring repair. A replacement must include `repair.defect` and nonempty
`retained_inputs`, `retained_assertions`, `retained_edge_cases`, and
`retained_failure_conditions` lists. The runner independently verifies that ordered case
IDs, case kinds, inputs, and expected values are unchanged:

- Command cases with an explicit `args` array may adapt `command` wiring while keeping
  `args`, stdin, output, exit status, and format fixed (new plans always declare `args`,
  even when empty).
- Cases originally missing `args` freeze their entire command; repairs cannot add `args`
  to unlock them.
- Qualification repeats on the replacement, and a previous behavioral failure can never
  be cleared by a later passing assessment (including via altered imported history).

## Model-free verification

```sh
bun test semantic.test.ts semantic-protocol.test.ts semantic-preflight.test.ts judge-boundary.test.ts
CODEX_AB_LIVE_DOCKER=1 bun test semantic.live.test.ts
CODEX_AB_LIVE_DOCKER=1 CODEX_AB_LIVE_IMAGE=codex-ab:model-free bun test judge-boundary.live.test.ts
```

`semantic.live.test.ts` uses `CODEX_AB_VERIFIER_IMAGE` or `python:3.13-slim` (pull it
first) and exercises correct/wrong/early-exit libraries, candidate syntax/import errors,
evaluator syntax errors, zero tests, fake success markers, CLI observations, private
result permissions, supervisor signal permissions, and offline networking. Cache tests
additionally require `CODEX_AB_LIVE_REFERENCE_RUN`. Skipped live tests do not verify
container boundaries, and no test in this workflow authorizes paid inference.

The [Flask IPv6 task](../tasks/flask-ipv6-server-name/README.md) exercises real
`Flask.run` (replacing only the server launcher) with 7 IPv6 and 13 retained
observations across all four controls; original pytest output is diagnostic only:

```sh
CODEX_AB_LIVE_DOCKER=1 CODEX_AB_VERIFIER_IMAGE=codex-ab:model-free \
  CODEX_AB_FLASK_SOURCE=/path/to/pinned/flask \
  bun test flask-qualification.live.test.ts
```

### Bundled task readiness

Every bundled task manifest and the standalone skill-bundle criteria freeze
existing-behavior observations and all four evaluator-control roles. Verify contract
readiness (acceptance plus rejection when observations or a role are removed) with:

```sh
bun test task-pack.test.ts semantic-preflight.test.ts
```

Contract readiness does not prove runtime execution; task-specific model-free tests
exercise real source observations and controls offline once pinned dependencies are
prepared. Commands, source pins, observation scope, and limits live in each task README:

- [NVM download arguments](../tasks/nvm-download-no-eval/README.md)
- [Gin context copying](../tasks/gin-context-copy/README.md)
- [Express transfer encoding](../tasks/express-transfer-encoding/README.md)
- [Flask address selection](../tasks/flask-ipv6-server-name/README.md)
- [Skills manager agent commands](../tasks/skills-mgr-agent-cli/README.md)
- [Skills manager remote uninstall](../tasks/skills-mgr-remote-uninstall/README.md)
- [Skills manager conditional acquisition](../tasks/skills-mgr-get-short-circuit/README.md)
- [Portable skill bundles](../tasks/skills-mgr-bundle/README.md)
- [Mekugi coordination checkpoints](../tasks/session-retention/README.md)
- [sqlite-utils upgrade](../tasks/sqlite-utils-history/README.md)

The standalone bundle task has no upstream solution commit (its reference and
alternative controls are authored fixtures, and different archive formats/equivalent
interfaces remain allowed). Controls qualify only the behaviors exercised by each
authored check; composite test/doc criteria and opt-in native-provider integration need
their own assessment. Updating a bundled task does not migrate prepared runs in place—
prepare a fresh run and keep older runs as historical evidence.

### Source-judge boundary verification

`judge-boundary.live.test.ts` runs the selected image's Codex CLI against a local
Responses mock with networking disabled to inspect advertised tools without credentials
or inference. Its allowlist covers the broker reader and native utility tools; generic
process execution, delegation, plugins, apps, hooks, and image tools are disabled.
Native `apply_patch` remains registered: read-only/never policy denies writes before
diff emission or patch execution, though verification reads can still expose a
path-existence or guessed-context oracle beyond the broker's roots (this is not a claim
that all native reads are confined to the broker). Code Mode's isolated JavaScript host
remains available for models that need it to call the restricted broker tools; the live
mock rejects process tools and host I/O globals on that surface.

Shell execution is disabled via `shell_tool=false`. In Codex CLI 0.154.0,
`unified_exec` selects the execution variant rather than acting as a denial gate; the
pinned [tool registration](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/core/src/tools/spec_plan.rs)
returns before registering either shell variant when `shell_tool` is false.
Qualification requires `shell_tool=false`, and the live provider mock rejects any
advertised process-execution tools.
