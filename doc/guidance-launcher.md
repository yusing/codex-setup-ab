# Guidance and launcher experiment

[README](../README.md) · [Contract](contract.md) · [CLI guide](cli.md)

The model-free preparation helper creates four matched cells using the `custom`
composition path. Every cell shares the same task, image-bundled Codex binary, tool
store, model, reasoning effort, CPU/memory limits, and candidate budget. Current
guidance is pinned to a full 40-character setup commit; minimal guidance uses the
`stock` setup (no custom instructions, skills, or hooks, while retaining shared tool
access).

| Cell | Retained arm | Guidance | Launcher |
| --- | --- | --- | --- |
| A | `stock` | Minimal | Direct Codex |
| B | `current` | Minimal | Codex through Mekugi |
| C | `arm-3` | Pinned current setup | Direct Codex |
| D | `arm-4` | Pinned current setup | Codex through Mekugi |

## Prepare without inference

Write an operator-owned JSON configuration, replacing all example paths and SHAs with
real task and setup identities. `common` accepts the camelCase `PrepareOptions` fields
from [prepare.ts](../prepare.ts) (standalone Codex comes from the shared `image`;
`common` cannot override the experiment's composition or introduce asymmetric treatments):

```json
{
  "setup_commit": "FULL_40_CHARACTER_SETUP_COMMIT_SHA",
  "repetitions": 4,
  "schedule": "alternating",
  "shared_settings": {
    "model": "gpt-6-astra",
    "reasoning_effort": "medium",
    "cpus": "2",
    "memory": "4g",
    "timeout_seconds": 1800,
    "auto_compact_limit": 200000,
    "parallel_work": false
  },
  "mekugi_flags": [],
  "common": {
    "profile": "task",
    "source": "/absolute/task-source",
    "baseCommit": "FULL_40_CHARACTER_BASE_COMMIT_SHA",
    "forbiddenCommit": "FULL_40_CHARACTER_REFERENCE_COMMIT_SHA",
    "taskPath": "/absolute/task-pack/task.md",
    "taskPackPath": "/absolute/task-pack/manifest.json",
    "currentHome": "/absolute/setup-checkout",
    "runtimeHome": "/absolute/runtime-home",
    "mekugiSource": "/absolute/mekugi-source",
    "mekugiBinary": "/absolute/mekugi",
    "image": "codex-ab:0.1.0",
    "cpus": "2",
    "memory": "4g",
    "timeoutSeconds": 1800,
    "outputParent": "/absolute/benchmark-runs"
  }
}
```

```sh
bun scripts/prepare-guidance-launcher.ts experiment-config.json
```

The script prints the prototype directory and a fresh repeated trial set. Preparation
checks or builds the runtime as needed, makes no model requests, and records the design,
intended differences, pinned task, and observed runtime identities in
`run.json.experiment`. Trial controls hash this metadata alongside setup and runtime
snapshots. Historical imports are disallowed in this experiment.

The `alternating` schedule runs A, B, C, D sequentially on odd repetitions and D, C, B, A
on even repetitions; `concurrent` scheduling is also supported. Preserve the schedule in
interpretation: alternating order does not remove all time or resource effects and is not
a randomization claim. The design still uses the repository's declared candidate network
boundaries and does not establish closed-book execution or benchmark comparability.

Execution remains a separate `run-trials` command behind the explicit
`--confirm-paid-inference` gate; preparation never grants inference consent.

## Interpretation

Reports retain four contrasts with their matched task and attempt counts:

- **B − A**: launcher difference under minimal guidance.
- **C − A**: guidance difference under direct Codex.
- **D − C**: launcher difference under current guidance.
- **(D − C) − (B − A)**: interaction between launcher and guidance.

Positive values mean a larger reported metric (higher pass rate, longer time, or higher
cost). The interaction requires all four cells for the same task and repeat; each simple
contrast uses its own matched cells and discloses coverage. Automated time/cost
interaction reporting uses four-way joint successes, and cost estimates additionally
require comparable accounting. The scored-attempt pass-rate view separately includes
task/model failures and candidate budget timeouts.

Repeats are averaged within each task. A deterministic percentile bootstrap resamples
task means with equal task weights (default: 5,000 samples, seed `1101`). Fewer than two
matched tasks produces no cross-task interval; two to four matched tasks carries an
explicit instability warning. The five-task display threshold is a caution, not a
guarantee of coverage or generalization. Repeating one task estimates run-to-run
variation, not broad task-level gains.

The standalone `guidanceLauncherEffects` API in [factorial.ts](../factorial.ts) accepts
task/attempt-keyed observations across multiple tasks and keeps fresh, historical, and
schedule cohorts separate without performing evaluation or inference. Machine reports
retain the original joint-success and all-valid paired summaries alongside reliability
and uncertainty sections because their populations differ.

## Scored-attempt metrics and compatibility

The [report contract](contract.md#report) defines scored-attempt denominators, cost
eligibility, missing evidence, and v2 report compatibility. Candidate costs include
scored failures; evaluator spend is separate. Historical records without trusted outcome
dimensions remain unassessed and are never rewritten.

These capabilities support FHE-style analysis without establishing an official FHE score
or equivalence to upstream task verifiers and runtimes.
