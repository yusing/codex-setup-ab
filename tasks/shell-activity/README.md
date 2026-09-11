# Shell activity display benchmark

A new task from session `01a08c0f-f3b2-7dd0-8d82-d1a3ea91bbe5`, distinct from the earlier grouped-activity and GoDoxy icons tasks.

- Source repository: `/home/ubuntu/projects/mekugi` (formerly Hpatch).
- Base: `ca04a2792ac9693a924bc6f00ff80dc4cf3159e3`.
- Excluded final solution: `1cc73440e265aeffa0dd2f11fa30e0266a53c45f`.
- Earlier solution-chain commit, also excluded by shallow base-only cloning: `35f4ee1b3d09858ee918fbf5d5074cdec189d7d6`.
- Task: [task.md](task.md).
- Evaluator: [acceptance_test.go](acceptance_test.go), injected into `internal/router/ab_acceptance_test.go`.

The user asked for “Still Running” and “Running stored script” with a short excerpt of the actual command. The task makes the associated correlation, missing-source, Unicode, and transport-preservation contracts explicit. The evaluator uses pre-existing request/response interfaces rather than implementation-specific new helpers.

Both arms start from the same historical source, whose package and protocol names still say Hpatch. Do not rebrand that immutable source or expose later solution commits. A is the minimal setup; B is the current-home snapshot with the continuous-review v2 overlay, launched through bare Codex. The runner automatically grades, repeats the package checks, judges source quality, audits interactions, and produces a checksummed report bundle.


## Evaluator validation

All four acceptance tests executed against independent temporary copies: all four fail on the base and pass on the excluded solution. The evaluator calls only APIs available at the base. This validates the hidden test's ability to distinguish the requested behavior; it is not an A/B result.

The validated task SHA-256 is `be9a9e8d7ad5e111d6e5b53e6bde7b8beb4e3d1be1eb969a936c208cd11bb3ef`; evaluator SHA-256 is `ab7da100e4eb76223c4016ea29424a9a051fd48c94c161cbf9545b3d9d06f7fb`.

## Run

Build the bare image using the root README, then prepare with the explicit task and source identities above:

```sh
./dist/codex-ab prepare \
  --profile mekugi \
  --source /home/ubuntu/projects/mekugi \
  --base ca04a2792ac9693a924bc6f00ff80dc4cf3159e3 \
  --forbidden 1cc73440e265aeffa0dd2f11fa30e0266a53c45f \
  --task tasks/shell-activity/task.md \
  --acceptance tasks/shell-activity/acceptance_test.go \
  --current-home /home/ubuntu \
  --review-treatment treatments/continuous-review-v2-current-home \
  --current-launcher codex \
  --reasoning-effort medium \
  --image codex-ab:0.1.1
```

The command prints a new run directory. Pass it to `preflight`, then `run --confirm-paid-inference`. Both arms launch concurrently only after their non-inference preparation passes. `run` includes source assessment and the finishing bundle; do not launch a separate judge afterward.
