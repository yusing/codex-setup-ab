# Skills manager agent CLI task

This task asks candidates to make skills-mgr usable by coding agents without its
interactive UI. Agents need to discover available and active skills, diagnose problems,
and safely change selection and content while retaining existing behavior. The
[prompt](task.md) sets these outcomes without prescribing command names, interface
details, or implementation design.

## Historical source

The [task manifest](manifest.json) pins `https://github.com/yusing/skills-mgr.git` at
base commit `9ee73a175a6c86b749984cf1904433b3037e530f` and excludes later solution commit
`3d287a151622bca1ac764ffa1ce50e5b5472fd25`. Preparation isolates the historical base;
the excluded solution is not supplied to either candidate or evaluator.

Dependency preparation uses `go mod download`; the existing-test gate is
`go test . -count=1`. That gate passed on the pinned baseline. Semantic assessment
derives additional checks from the prompt and each candidate's actual interface.

## Run a comparison

Build the CLI using the [build guide](../../doc/cli.md#prerequisites-and-build).
Supply a local skills-mgr checkout containing the pinned base, then run from the
benchmark repository:

```sh
CODEX_AB_SKILLS_MGR_SOURCE=/path/to/skills-mgr \
CODEX_AB_MEKUGI_SOURCE=/path/to/mekugi ./dist/codex-ab launch \
  --preset stock-mekugi --task skills-mgr-agent-cli --confirm-paid-inference
```

This command can build the benchmark image, prepares the pair, performs preflight,
and starts paid inference, including semantic assessment. The task source defaults
to `$HOME/projects/skills-mgr`; the independent Mekugi runtime source defaults to
`$HOME/projects/mekugi`. Other presets are `stock-current`,
`current-vs-current-mekugi`, and `codex-mekugi-grok`.

The preset runner gives this task a 7200-second agent timeout and defaults to
`xhigh` reasoning, except that the Grok preset defaults to `high`. An explicit
`--reasoning-effort` overrides the effort. Mekugi presets accept
`--journal-compaction auto|slice|off`; omission preserves Mekugi's default.

For model-free preparation, use the manifest directly with `prepare --task-pack`
and `--source`, then run `preflight`. See the
[portable task pack guide](../../doc/cli.md#portable-task-packs) for the workflow
and [comparison options](../../doc/spec.md#stock-codex-versus-stock-plus-mekugi).

## Qualification limits

The baseline test pass establishes a usable existing-test gate. No Docker or paid
inference run has qualified this task. The contract remains `qualification: "not-run"`.
It is a long-horizon candidate, but runtime and compaction frequency have not been
measured. The two-hour limit does not guarantee a long run or a compaction event.
