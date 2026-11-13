# Fixed verifier adapter

[README](../README.md) · [Contract](contract.md) · [CLI guide](cli.md)

The fixed-verifier mode executes a supplied, pinned original task verifier. Its
result is separate from adaptive behavioral checks and source-quality scores.
It does not generate checks, modify the verifier, run an implementation agent,
or make model requests. A successful process exit alone never establishes a pass.

## Prepare the original inputs

Obtain the original task directory, including its instruction, environment
definition, and complete verifier directory. Keep this directory outside every
candidate workspace. Pin the dataset's immutable revision and record its version;
a branch name or a mutable image tag is rejected. Preserve the original task and
verifier files, executable bits, and any internal symlinks.

The adapter hashes every regular file and symlink, ignoring Git metadata. Its
`codex-ab.fixed-tree.v1` identity is the SHA-256 of the canonical JSON array of
sorted file entries returned by `candidateFiles()`: relative path, Git-style
file mode, SHA-256 of bytes or literal symlink target, and byte count. This
identity is local to this adapter. It does not claim to equal an upstream
archive digest. External or dangling verifier/task symlinks are rejected because
their contents are not fully pinned.

For example, obtain the two local tree identities with:

```sh
bun -e 'import {fixedTreeIdentity} from "./fixed-verifier.ts"; for (const p of process.argv.slice(1)) console.log(p, (await fixedTreeIdentity(p)).sha256)' \
  /absolute/original-task /absolute/original-task/tests
```

Build the original task environment separately using its documented recipe, then
record the immutable image digest. All dependencies needed by the verifier must
already be present: the adapter runs with Docker networking disabled. If that
changes the benchmark's original network policy or dependency setup, retain the
difference in the experiment record.

## Configuration

Use an external JSON configuration with the following shape. Values in angle
brackets are placeholders to replace with observed identities; this example is
not an executable FHE task or an assertion that a particular corpus is available.

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

The command is an argument array and must explicitly name an entrypoint inside
`/tests`. Set it to the original command, including the original interpreter and
arguments. The image is either `sha256:…` or an image reference ending in
`@sha256:…`. User, working directory, resource limits, timeout, and selected reward
key are explicit controls. Unknown configuration fields are rejected.

The candidate mount is read-only, as is `/tests`. The verifier may write its
container's private layer and the fresh `/logs/verifier` mount. Only that new
reward/log directory is writable on the host; the adapter's earlier reports,
stdout/stderr, invocation, and manifests are outside its writable mounts. No
authentication file, Docker socket, user home, or other arm is mounted.

Tasks whose unchanged verifier needs to rewrite candidate source, fetch network
dependencies, or use a platform other than this Linux container contract are
unsupported by this first adapter. Do not silently rewrite their verifier or
claim that the restricted execution reproduces original benchmark conditions.

## Execute and inspect

For an original-verifier comparison, first prepare the run using the original
task prompt, then freeze its verifier before any candidate execution:

```sh
codex-ab configure-fixed --run-dir /absolute/prepared-run \
  --config /absolute/fixed-verifier.json --task-dir /absolute/original-task
```

Configuration verifies that the original `instruction.md` bytes have the exact
SHA-256 of the prepared task. Use `--prompt-path relative/file.md` when the
original prompt has another relative path. It copies the full pinned task into
`evaluator/fixed-inputs/task`, records the exact configuration bytes, and verifies
the copied identities. The original inputs can subsequently be moved or removed.
The task's verifier remains in evaluator-only inputs. Reconfiguration after any
candidate/judge attempt, historical imports, and historical evaluation reuse are
unsupported in this first configured mode. Prepare a fresh comparison instead of
mixing those evaluation contracts. Generic import and `reevaluate` also reject
fixed-mode source runs, so they cannot silently become adaptive evaluations.

Normal run finishing dispatches the configured original verifier instead of
adaptive judging. Fixed grades use the original reward gate and preserve the
execution/validity distinction. The model-free verifier stage can also be invoked
explicitly on retained candidates:

```sh
codex-ab verify-fixed --run-dir /absolute/configured-run
```

To add a separate fixed-verifier assessment to a completed adaptive run:

```sh
codex-ab verify-fixed --run-dir /absolute/run --arm stock \
  --config /absolute/fixed-verifier.json --task-dir /absolute/original-task
```

Supplemental verification preserves the adaptive grade. Each result has its own
immutable task/configuration snapshot and is reported separately. Every invocation
uses a fresh `evaluator/fixed/<arm>/attempt-*` directory; the state retains all
attempt references. An explicit new configured-verifier invocation updates its
current fixed grade while preserving all earlier result files. Repeated verifier
invocations on one implementation are not fresh implementation attempts and must
not be added to a scored-attempt denominator.

[`executeFixedVerifier()`](../fixed-verifier.ts) verifies the reconstructed tree,
trusted manifest, patch, bytes, modes, symlinks, index tree, and change list before
Docker starts. Legacy candidates without trusted capture are rejected.

Outputs are never reused. Evidence retains configuration, task/verifier/candidate
manifests, stdout/stderr, reward files, and `codex-ab.fixed-result.v1`. The owned
container lifecycle verifies cleanup.

## Score and validity contract

`reward.json` takes precedence over `reward.txt`, matching Harbor. A present but
empty, malformed, nonnumeric, or nonfinite JSON file cannot fall back to a text
reward. JSON rewards retain their complete numeric map; `reward_key` selects the
explicit outcome. Text rewards contain one decimal number under `reward`. The
selected score must be finite and in `[0, 1]`; a score of `1` passes, and a lower
score fails the binary completion gate while retaining the original numeric
score. Missing, oversized, nonregular, or symlink reward files are invalid.

Harbor consumes a recorded reward after ordinary verifier termination and does
not use the test exit code as the score. This adapter therefore retains a valid
reward alongside a nonzero exit, while keeping `execution_status` separate from
`behavioral_result` and `evaluation_validity`. Exit zero without a reward is
invalid and unassessed. Timeout, cancellation, and infrastructure or cleanup
failure leave behavioral results unassessed even if a reward file was created.

The result declares `trust_boundary: "upstream-fixed-verifier"`. The original
verifier owns its assertion and reward-writing semantics. This adapter does not
independently qualify its negative controls or guarantee that hostile candidate
code running within the upstream verifier cannot spoof its reward. These results
must not be presented as independently supervised adaptive-check evidence.

## FHE provenance and comparison limits

Every adapter result currently records `methodology_comparable: false`. Local
pins prove which supplied bytes ran; they do not prove that those bytes are an
official FHE 1.1 task, that all official tasks and attempts were run, or that the
model/provider, harness, budget, and network controls match a published result.

At implementation time, the official site and Hub described FHE 1.1 with 62 tasks,
while the publicly inspected reproduction repository still exposed a 30-task
v1 configuration. No v1 task is relabeled as v1.1, and the local test fixtures are
explicitly marked `local-fixture`. An FHE-comparable claim requires the actual
official 1.1 task/verifier manifest, verified original bytes, matched controls
or declared differences with a matched control, and the specified denominator.

Primary references:

- [Harbor verifier implementation](https://github.com/harbor-framework/harbor/blob/main/src/harbor/verifier/verifier.py)
- [Harbor task format](https://docs.harborframework.com/tasks/overview)
- [FrontierHarness methodology](https://frontierharness.org/about/)
- [FrontierHarness dataset](https://hub.harborframework.com/datasets/frontier-harness-eval/frontier-harness-eval)

## Validation

```sh
bun test fixed-verifier.test.ts
bun test fixed-workflow.test.ts
CODEX_AB_LIVE_DOCKER=1 CODEX_AB_LIVE_IMAGE=codex-ab:delivery \
  bun test fixed-verifier.live.test.ts
```

Ordinary tests cover pins, immutable inputs, command/mount wiring, reward parsing,
process outcomes, and cleanup errors. The live gate checks actual offline/read-only
Docker boundaries, prior-evidence preservation, and correct/wrong/early-exit
fixtures. Neither invokes models; skips establish no boundary coverage.