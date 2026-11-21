# Fixed verifier adapter

[README](../README.md) · [Contract](contract.md) · [CLI guide](cli.md)

The fixed-verifier mode executes a supplied, pinned original task verifier. Its result
is separate from adaptive behavioral checks and source-quality scores. It does not
generate checks, modify the verifier, run an implementation agent, or make model
requests. A zero exit code alone never establishes a pass.

## Prepare the original inputs

Obtain the original task directory (instruction, environment definition, and complete
verifier directory) and keep it outside every candidate workspace. Pin the dataset's
immutable revision and record its version; branch names and mutable image tags are
rejected. Preserve original files, executable bits, and internal symlinks.

The adapter hashes every regular file and symlink (ignoring Git metadata). Its
`codex-ab.fixed-tree.v1` identity is the SHA-256 of the canonical JSON array of sorted
file entries from `candidateFiles()`: relative path, Git-style file mode, SHA-256 of
bytes or literal symlink target, and byte count. This identity is local to this adapter
and does not claim to equal an upstream archive digest. External or dangling symlinks
are rejected.

Compute the two local tree identities with:

```sh
bun -e 'import {fixedTreeIdentity} from "./fixed-verifier.ts"; for (const p of process.argv.slice(1)) console.log(p, (await fixedTreeIdentity(p)).sha256)' \
  /absolute/original-task /absolute/original-task/tests
```

Build the original task environment separately from its documented recipe and record
the immutable image digest. All verifier dependencies must be preinstalled because the
adapter runs with Docker networking disabled (`--network none`); if that differs from
the benchmark's original policy, record the difference in the experiment record.

## Configuration

Supply an external JSON configuration with the following schema (replace angle-bracket
placeholders with observed identities; this example is not an executable FHE task or an
assertion that a particular corpus is available):

```json
{
  "schema": "codex-ab.fixed-verifier.v1",
  "dataset": {
    "name": "frontier-harness-eval",
    "version": "1.1.0",
    "revision": "<40-character immutable commit or sha256:64-character digest>"
  },
  "task": {
    "id": "<original task identifier>",
    "tree_sha256": "<64-character local task tree identity>"
  },
  "verifier": {
    "path": "tests",
    "tree_sha256": "<64-character local verifier tree identity>",
    "command": ["/bin/bash", "/tests/test.sh"]
  },
  "image": "sha256:<64-character image ID>",
  "candidate_mount": "/app",
  "workdir": "/app",
  "user": "0:0",
  "timeout_seconds": 300,
  "resources": { "cpus": "2", "memory": "4g", "pids_limit": 256 },
  "network": "none",
  "reward_key": "reward"
}
```

- `verifier.command` is an argument array explicitly naming an entrypoint under `/tests`.
- `image` must be `sha256:…` or a reference ending in `@sha256:…`.
- User, working directory, resource limits, timeout, and `reward_key` are explicit;
  unknown configuration fields are rejected.
- Both `candidate_mount` and `/tests` are mounted read-only. Only the container's
  private layer and a fresh `/logs/verifier` mount are writable; earlier reports,
  stdout/stderr, invocations, manifests, auth files, Docker sockets, user homes, and
  other arms are never mounted.

Tasks whose unchanged verifier must rewrite candidate source, fetch network
dependencies, or run outside this Linux container contract are unsupported by this
adapter. Do not silently rewrite their verifier or claim equivalence to original
benchmark conditions.

## Execute and inspect

Prepare the run with the original task prompt, then freeze its verifier before any
candidate execution:

```sh
./dist/codex-ab configure-fixed --run-dir /absolute/prepared-run \
  --config /absolute/fixed-verifier.json --task-dir /absolute/original-task
```

`configure-fixed` verifies that `instruction.md` (override via
`--prompt-path relative/file.md`) matches the prepared task's exact SHA-256, copies the
pinned task into `evaluator/fixed-inputs/task`, records the exact config bytes, and
verifies copied identities so the original inputs can later move. Reconfiguration after
any candidate/judge attempt, historical imports, and evaluation reuse are unsupported in
configured fixed mode; generic imports and `reevaluate` also reject fixed-mode runs so
they cannot silently become adaptive evaluations.

Normal run finishing dispatches the configured verifier instead of adaptive judging.
You can also invoke the model-free verifier stage explicitly on retained candidates:

```sh
./dist/codex-ab verify-fixed --run-dir /absolute/configured-run
```

To add a separate fixed-verifier assessment to a completed adaptive run without altering
its adaptive grade:

```sh
./dist/codex-ab verify-fixed --run-dir /absolute/run --arm stock \
  --config /absolute/fixed-verifier.json --task-dir /absolute/original-task
```

Each invocation writes to a fresh `evaluator/fixed/<arm>/attempt-*` directory with its
own immutable task/config snapshot, retaining all prior attempts in state. Re-verifying
one implementation updates its current fixed grade without adding a fresh implementation
attempt to a scored-attempt denominator.

[`executeFixedVerifier()`](../fixed-verifier.ts) verifies the reconstructed tree,
trusted manifest, patch, bytes, modes, symlinks, index tree, and change list before
Docker starts; legacy candidates without trusted capture are rejected. Outputs are never
reused; evidence retains config, manifests, stdout/stderr, reward files, and
`codex-ab.fixed-result.v1`, and owned-container cleanup is verified.

## Score and validity contract

- **Reward precedence**: `reward.json` takes precedence over `reward.txt`, matching
  Harbor. A present but empty, malformed, nonnumeric, or nonfinite JSON file never falls
  back to `reward.txt`. JSON rewards retain their complete numeric map (`reward_key`
  selects the outcome); text rewards contain one decimal number under `reward`.
- **Gate and validity**: The selected score must be finite and in `[0, 1]` (`1` passes;
  lower scores fail the binary gate while keeping the numeric score). Missing,
  oversized, nonregular, or symlink reward files are invalid.
- **Process exit vs. reward**: Matching Harbor, a valid reward is retained alongside a
  nonzero verifier exit while keeping `execution_status`, `behavioral_result`, and
  `evaluation_validity` separate. Exit zero without a reward is invalid and unassessed.
  Timeout, cancellation, and infrastructure or cleanup failures leave behavioral results
  unassessed even if a reward file exists.
- **Trust boundary**: Results record `trust_boundary: "upstream-fixed-verifier"`. The
  original verifier owns its assertions and reward writer; this adapter does not qualify
  negative controls or prevent hostile candidate code running inside the verifier from
  spoofing its reward. Do not present fixed results as independently supervised adaptive
  evidence.

## FHE provenance and comparison limits

Every adapter result records `methodology_comparable: false`. Local pins prove which
supplied bytes ran, not that they match an official FHE 1.1 task, full task/attempt
denominator, or published model, provider, harness, budget, and network controls.

At implementation time, the official site and Hub described FHE 1.1 with 62 tasks, while
the inspected reproduction repository exposed a 30-task v1 configuration. No v1 task is
relabeled as v1.1, and local test fixtures are marked `local-fixture`. An FHE-comparable
claim requires the official 1.1 manifest, verified original bytes, matched controls (or
declared differences with a matched control), and the specified denominator.

Primary references:

- [Harbor verifier implementation](https://github.com/harbor-framework/harbor/blob/main/src/harbor/verifier/verifier.py)
- [Harbor task format](https://docs.harborframework.com/tasks/overview)
- [FrontierHarness methodology](https://frontierharness.org/about/)
- [FrontierHarness dataset](https://hub.harborframework.com/datasets/frontier-harness-eval/frontier-harness-eval)

## Validation

```sh
bun test fixed-verifier.test.ts fixed-workflow.test.ts
CODEX_AB_LIVE_DOCKER=1 CODEX_AB_LIVE_IMAGE=codex-ab:model-free \
  bun test fixed-verifier.live.test.ts
```

(`fixed-verifier.live.test.ts` defaults to `codex-ab:delivery` when
`CODEX_AB_LIVE_IMAGE` is unset; CI builds and uses `codex-ab:model-free`.)

Ordinary tests cover pins, immutable inputs, command/mount wiring, reward parsing,
process outcomes, and cleanup errors. The live gate checks real offline/read-only
Docker boundaries, prior-evidence preservation, and correct/wrong/early-exit fixtures.
Neither invokes models, and skipped tests establish no boundary coverage.
