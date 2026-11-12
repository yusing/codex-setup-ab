# Flask IPv6 evaluator qualification

This pack retains its original task and upstream scope. It pins Flask baseline
`de8429ffda8cfb54db175529e2bae72a24e1fa7e` and reference
`7203feabf723edae0286ae5dc64fec8ac4c91735`. The reference changes the development
server's `SERVER_NAME` parsing and adds an IPv6 case to `test_run_from_config`.
Candidate instructions receive the task only; control implementations and
reference evidence stay in evaluator inputs.

## Frozen source controls

| Control | Source | IPv6 criterion | Existing address selection |
| --- | --- | --- | --- |
| Upstream reference | Exact pinned reference patch over the baseline | Pass | Pass |
| Unchanged baseline | Exact pinned baseline | Fail | Pass |
| Targeted incorrect implementation | Reference with IPv6 host truncation and loss of configured port zero | Fail | Fail |
| Independent valid implementation | Baseline with explicit bracket parsing, preserving the original override path | Pass | Pass |

The incorrect and alternative implementations are precise patches to the real
`src/flask/app.py`, with SHA-256 hashes of both file versions. They do not replace
Flask with a toy class. The negative deliberately regresses two task obligations.
The alternative implements the fix without the reference's `urlsplit` design.
These controls establish only the declared cases and supported interfaces; they
are not proof that every possible evaluator is correct.

## Independent behavior observations

The frozen existing-behavior observer imports candidate Flask from `src` and
calls real `Flask.run`. It mocks only `werkzeug.serving.run_simple`, so it can
observe the chosen host and port without opening a network listener. It also
records debug and server options, whether the same application was passed, and
whether first-request state was reset after normal return and a server error.

Thirteen scenarios cover defaults, DNS, IPv4, host and port overrides, explicit
and configured port zero, debug overrides, explicit server options, and cleanup.
The model-free qualification test adds seven IPv6 scenarios covering short and
long IPv6 addresses, configured ports, zero, and host/port overrides. Each group
returns a complete JSON array. The protected supervisor compares that array
with expectations outside the candidate process. A zero exit without the full
observed value cannot satisfy these assertions.

The original scoped pytest command still runs as a separate non-gating
diagnostic. Its output and status do not establish supervisor completion or
certify tests that were not observed independently. Source-quality assessment
can still consider the candidate's regression tests.

The task permits URL-parser normalization and validation differences. These
observations do not add case-sensitive DNS or malformed-input requirements that
the pinned reference does not promise.

## Running the checks

The model-free container installs exact versions from `requirements.txt`.
The pack's preparation command pins the same versions when creating its Python
environment. Each execution records the actual immutable image identity.

```sh
CODEX_AB_LIVE_DOCKER=1 CODEX_AB_VERIFIER_IMAGE=codex-ab:model-free \
  CODEX_AB_FLASK_SOURCE=/path/to/flask-with-both-pinned-commits \
  bun test flask-qualification.live.test.ts
```

The test runs `prepareSemanticAssessment` and the real offline supervisor. Its
authored checks are supplied locally, without a model call or API credentials.
The CI fixture fetches the exact reference commit and includes both control
patches in the same retained qualification records as candidate checks.

The manifest keeps `qualification: "not-run"`: a task definition does not grant
an execution result in advance. A particular authored check becomes qualified
only after its recorded reference, baseline, negative, and alternative outcomes
match. A skipped Docker test is not verification of the container boundary.
