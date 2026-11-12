# Guidance and launcher experiment

The model-free preparation helper creates four cells using the existing custom
composition path. Each cell gets the same task, Codex binary, tool store, model,
reasoning, CPU, memory, and candidate budget. The current guidance is pinned to a
full setup commit. Minimal guidance uses the existing `stock` setup, which omits
custom instructions, skills, and hooks while retaining shared tool access.

| Cell | Retained arm | Guidance | Launcher |
| --- | --- | --- | --- |
| A | stock | Minimal | Direct Codex |
| B | current | Minimal | Codex through Mekugi |
| C | arm-3 | Pinned current setup | Direct Codex |
| D | arm-4 | Pinned current setup | Codex through Mekugi |

## Prepare without inference

Write an operator-owned JSON configuration. Replace all example paths and SHAs
with real task and setup identities. `common` uses the same camelCase fields as
`PrepareOptions` in [prepare.ts](../prepare.ts); it cannot override the experiment's
composition or introduce an asymmetric treatment.

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
    "codexBinary": "/absolute/codex",
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

The command prints the prototype directory and a fresh repeated trial set.
Preparation builds/checks the existing runtime as needed and makes no model
requests. It records the design, intended differences, pinned task, and observed
runtime identities in `run.json.experiment`. Trial controls hash this metadata
alongside the existing setup and runtime snapshots. No historical imports are
allowed in this fresh experiment.

The alternating schedule executes A, B, C, D sequentially on odd repetitions and
D, C, B, A on even repetitions. Concurrent scheduling remains available. Preserve
the schedule in interpretation: alternating order does not remove all time or
resource effects and is not a randomization claim. The design still depends on
the repository's declared candidate network boundaries; preparing four cells does
not establish closed-book execution or benchmark comparability.

Execution remains a separate `run-trials` operation through the existing explicit
paid-inference consent gate. Preparation never grants that consent.

## Interpretation

The report retains these contrasts and their matched task/attempt counts:

- B − A: launcher difference under minimal guidance.
- C − A: guidance difference under direct Codex.
- D − C: launcher difference under current guidance.
- (D − C) − (B − A): interaction between launcher and guidance.

Positive differences mean larger values of the reported metric. For pass rate,
that means a higher pass fraction; for time and cost, it means greater expenditure.
The interaction requires all four cells for the same task and repeat. Each simple
contrast uses its own matched cells and discloses its coverage. Automated time/cost
interaction reporting uses four-way joint successes, and cost estimates additionally
require comparable accounting. The scored-attempt pass-rate view separately includes
task/model failures and candidate budget timeouts.

Repeats are averaged within each task. A deterministic percentile bootstrap
resamples task means with equal task weights; its default is 5,000 samples with
seed 1101. Fewer than two distinct matched tasks has no cross-task interval. Two to
four matched tasks has an explicitly unstable interval. The five-task display
threshold is a caution, not a guarantee of coverage or generalization. One repeated
task can estimate run-to-run variation but cannot establish broad task-level gains.

The standalone `guidanceLauncherEffects` API in [factorial.ts](../factorial.ts)
accepts task/attempt keyed observations across multiple tasks and keeps fresh,
historical, and schedule cohorts separate. It performs no evaluation or inference.
Machine reports retain the original joint-success and all-valid paired summaries
alongside the new reliability and uncertainty sections; their populations differ.

## Scored-attempt metrics and compatibility

[reliability.ts](../reliability.ts) versions its denominator policy. It separates
execution, behavioral result, evaluator validity, observed candidate costs, and
whether those costs are eligible for comparisons. Pass rate uses scored attempts;
infrastructure failures, invalid evaluations, unassessed outcomes, and administrative
cancellations are separately counted. Unstarted slots do not count as attempts.

Cost per verified success includes eligible candidate costs from all scored
attempts, including failures. Unknown or approximate cost prevents a complete cost
per success. Observed partial spend stays visible. Zero successes gives an undefined
value rather than zero. Evaluator spend remains separate. Historical records without
trusted outcome dimensions remain explicitly unassessed in the new metrics; old
reports and evidence are not rewritten. New trial and suite report schemas are v2.

These capabilities support the proposed FHE-style analysis. They do not themselves
establish an official FHE score or equivalence to its task verifiers and runtime.
