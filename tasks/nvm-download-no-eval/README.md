# NVM literal download arguments

This pack retains the [task](task.md) and exact upstream endpoints in its
[manifest](manifest.json). It evaluates real `install.sh` functions without
network downloads. The [verification protocol](../../doc/verification.md) explains
the supervisor-owned assertions and frozen evaluator controls.

## Retained behavior and controls

The existing-behavior gate sources the actual installer with Bash and
`NVM_ENV=testing`, then independently compares 15 `nvm_source` observations:
default and Git endpoints, script/exec/completion URLs, repository and version
overrides, explicit `NVM_SOURCE` values, and invalid-method rejection. It records
exact stdout, exit status, and whether stderr was emitted. These observations
cover the retained source-selection behavior, not every installer test or a real
installation. The original `bash nvm_source` command also runs as a separate,
non-gating diagnostic.

All controls are evaluator-only. The reference is actual upstream
[b17550a0](https://github.com/nvm-sh/nvm/commit/b17550a0b9ab691439815dfccc8b73e3a59fa103),
not an authored replacement. Its
[regression test](https://github.com/nvm-sh/nvm/blob/b17550a0b9ab691439815dfccc8b73e3a59fa103/test/install_script/nvm_download_no_eval_injection)
and [installer](https://github.com/nvm-sh/nvm/blob/b17550a0b9ab691439815dfccc8b73e3a59fa103/install.sh)
establish the literal-argument behavior and unchanged curl branch. The pinned
[baseline](https://github.com/nvm-sh/nvm/blob/52047edfb15547042bef6fac7c83b17cb66cf02f/install.sh)
establishes preserved source-selection and curl behavior.

| Criterion | Reference | Baseline | Targeted incorrect control | Valid alternative |
| --- | --- | --- | --- | --- |
| Literal arguments | Pass | Fail: shell reparsing | Reintroduce `eval` before wget | Pass: quoted positional-argument loop |
| wget translations | Pass | Fail: numeric resume value is forwarded | Stop consuming the resume value | Pass: same required flag meanings, independent loop |
| Curl and shell contract | Pass | Pass | Remove curl's `--compressed` flag | Pass: unchanged curl branch and portable translation constructs |

Source controls use small unified patches with exact preimage and postimage
hashes. They do not replace the whole installer. The independently authored
alternative consumes original positional arguments with a `while` loop and
appends translated arguments, rather than copying the reference's `for` loop.
Output operands resembling options remain outside the task's required scope.

## Model-free runtime validation

The [qualification checks](../../test-support/nvm-qualification.ts) observe exact
argv from local fake wget/curl executables, literal substitution proof-file
absence, all required flag translations, repeated flags, resume-value
consumption, and curl exit-status propagation. They also run `sh -n`, verify the
Bash entry guard, and execute the sourced download function under `/bin/sh` for
a basic wget request. That last observation is not a claim that the entire
installer runs under POSIX sh or a proof covering every shell construct.

The [live regression](../../nvm-qualification.live.test.ts) exercises the ordinary
semantic assessment and frozen-control qualification path, compares every
successful observation against supervisor expectations, and checks the retained
source-selection gate on both the reference and baseline. No model endpoint,
credentials, or paid inference is used. The manifest stays `qualification:
"not-run"`: each newly authored adaptive evaluator must qualify its own checks.

With an existing local Git repository containing both pinned commits and a local
verifier image containing Python, Bash, sh, sed, and touch:

```sh
CODEX_AB_LIVE_DOCKER=1 CODEX_AB_VERIFIER_IMAGE=codex-ab:0.1.0 \
  CODEX_AB_NVM_SOURCE=/path/to/nvm \
  bun test nvm-qualification.live.test.ts
```

The fixture reads the source repository and creates its own temporary Git seed
and workspaces. It does not change that source checkout. Containers execute with
networking disabled. A skipped live test supplies no runtime or isolation
coverage. This test qualifies the declared observations and controls, not all
possible incorrect implementations or the installer's complete test suite.
