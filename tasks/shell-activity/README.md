# Shell activity display benchmark

A new task from session `01a08c0f-f3b2-7dd0-8d82-d1a3ea91bbe5`, distinct from the earlier grouped-activity and GoDoxy icons tasks.

- Source repository: `/home/ubuntu/projects/mekugi` (formerly Hpatch).
- Base: `ca04a2792ac9693a924bc6f00ff80dc4cf3159e3`.
- Excluded final solution: `1cc73440e265aeffa0dd2f11fa30e0266a53c45f`.
- Earlier solution-chain commit, also excluded by shallow base-only cloning: `35f4ee1b3d09858ee918fbf5d5074cdec189d7d6`.
- Task: [task.md](task.md).
- Behavioral contract: [criteria.json](criteria.json), evaluated through adaptive semantic checks.

The user asked for “Still Running” and “Running stored script” with a short excerpt of the actual command. The task makes the associated correlation, missing-source, Unicode, and transport-preservation contracts explicit. The evaluator uses pre-existing request/response interfaces rather than implementation-specific new helpers.

Both arms start from the same historical source, whose package and protocol names still say Hpatch. Do not rebrand that immutable source or expose later solution commits. The stock arm uses the minimal setup; the current arm uses the current-home snapshot, launched through bare Codex. The runner automatically runs semantic checks, judges source quality, audits interactions, and produces a checksummed report bundle.


## Evaluation

The task-derived criteria cover command correlation, retained source lookup, missing-source behavior, Unicode excerpt bounds, input handling, and transport preservation. Existing router tests and candidate-specific checks provide executed evidence. No prewritten hidden tests are injected.

## Run

Follow the [build guide](../../doc/cli.md#prerequisites-and-build), then prepare with the explicit task and source identities above. Replace the example source and home paths with your local checkouts. Historical continuous-review overlays are no longer bundled.

```sh
./dist/codex-ab prepare \
  --profile mekugi \
  --source /home/ubuntu/projects/mekugi \
  --base ca04a2792ac9693a924bc6f00ff80dc4cf3159e3 \
  --forbidden 1cc73440e265aeffa0dd2f11fa30e0266a53c45f \
  --task tasks/shell-activity/task.md \
  --criteria tasks/shell-activity/criteria.json \
  --current-home /home/ubuntu \
  --comparison stock-current \
  --current-launcher codex \
  --reasoning-effort medium \
  --image codex-ab:0.1.1
```

The command prints a new run directory. Pass it to `preflight`, then `run --confirm-paid-inference`. Both arms launch concurrently only after their non-inference preparation passes. `run` includes source assessment and the finishing bundle; do not launch a separate judge afterward.
