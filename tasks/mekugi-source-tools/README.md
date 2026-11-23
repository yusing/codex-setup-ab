# Mekugi native source tools benchmark

Harden `mcat` and `mfinspect` in Mekugi's Rust helper crate. The
[prompt](task.md) asks for faithful byte streams, resilient source outlines,
and observable command failures without changing ordinary reads.

## Baseline and reference

The [manifest](manifest.json) pins code from
[mekugi-harness/mekugi](https://github.com/mekugi-harness/mekugi). All three
commits are on the maintained monorepo's main history:

- Baseline: [`ff9e32e`](https://github.com/mekugi-harness/mekugi/commit/ff9e32e932575e7b56ccaca671f0c3e5efdebd74),
  November 22, 2026, with the native helper aliases already in place.
- First excluded solution: [`df345c3`](https://github.com/mekugi-harness/mekugi/commit/df345c33f13334488d6ac936f540f648d365435d),
  November 22, 2026, native helper review fixes.
- Reference endpoint: [`6699574`](https://github.com/mekugi-harness/mekugi/commit/66995741daf343b4c9f70f15f533b5c786a2751e),
  November 22, 2026, stdout and outline recovery follow-ups.

The baseline postdates the documented cutoffs for
[`gpt-6-astra`](https://developers.openai.com/api/docs/models/gpt-6-astra)
and [`gpt-6.1-sol`](https://developers.openai.com/api/docs/models/gpt-6.1-sol)
(April 30, 2026),
[`gpt-6.2-astra`](https://developers.openai.com/api/docs/models/gpt-6.2-astra)
(May 18, 2026),
[`gpt-6.2-sol`](https://developers.openai.com/api/docs/models/gpt-6.2-sol)
and [`gpt-6.1-terra`](https://developers.openai.com/api/docs/models/gpt-6.1-terra)
(June 1, 2026). Verify other models separately.

Candidates receive the shallow baseline. Evaluators receive the two reference
patches and combined diff. The patches also change other native tools and
terminal retention; those changes are not part of this task.

Criterion evidence in `codex-rs/mekugi-tools`:

- `mcat-read`: `df345c3` streams unadorned reads; `6699574` validates UTF-8 at
  output time. The range and generated-file tests cover retained selections.
- `outline-recovery`: Both commits fix flow frontmatter, surrogate-escaped
  names and pointers, and Go literal decoding. See the upstream test
  `preserves_lone_surrogates_flow_yaml_and_go_string_escapes`.
- `cli-errors`: Both commits update the process entry points in `src/lib.rs`:
  argument validation and failure propagation through stdout flush.

The task spans streaming and UTF-8 handling, multiple parsers, command
entry points, regression tests, and their existing contracts. Its scope
does not establish candidate duration or observed journal resets.

## Prepare and run

Use a local checkout of the maintained monorepo containing the three pins.
Select **Mekugi native source tools** in the workbench, or run:

```sh
./dist/codex-ab launch --task mekugi-source-tools --prepare-only
```

The default checkout is `$HOME/projects/mekugi`. Override it with `--source` or
`CODEX_AB_MEKUGI_SOURCE`. The preset uses bare Codex and a one-hour, xhigh
candidate budget. Use a separate project for launcher comparisons. Replace
`--prepare-only` with `--confirm-paid-inference` only to run candidates and
judges. See the [build guide](../../doc/cli.md#prerequisites-and-build).

The preset builds `codex-ab:rust` when needed. It uses Rust 1.99.1 and a C
compiler in the container, not the host's Cargo or LLVM. Workspace dependency
resolution uses the upstream lockfile; preparation compiles only the affected
helper crate. A cold cache still fetches workspace-wide Git dependencies.
For direct `prepare --task-pack`, build and select that image:

```sh
docker build --target rust -t codex-ab:rust .
```

## Model-free qualification

```sh
CODEX_AB_LIVE_DOCKER=1 CODEX_AB_MEKUGI_SOURCE="$HOME/projects/mekugi" \
  bun test mekugi-source-tools.live.test.ts
```

This prepares an ordinary pair without running models, builds the dependency
image, and drives the helper entry points through the offline supervisor.
The frozen retained check verifies an ordinary range, invalid UTF-8 file
contents, and a TypeScript outline. For each criterion the verifier is tested
against the pinned reference, unchanged baseline, a targeted fault, and a
passing source variant:

- Reads: mixed line endings, no EOF newline, UTF-8 across buffer boundaries,
  and generated-file advice only for a selected range. The negative strips
  carriage returns; the passing variant uses a smaller streaming buffer.
- Outlines: YAML keys after an apostrophe, escaped surrogates in names and
  pointers, decoded Go imports, and recovery of later declarations.
  The negative treats an embedded apostrophe as a quote; the passing variant
  uses equivalent quote logic.
- CLI errors: non-UTF-8 OS arguments and output failure on Linux's `/dev/full`.
  The negative drops the write-failure exit status; the variant collects valid
  arguments through an equivalent fallible iterator.

Qualification covers these observations, not every parser input or the
unrelated native runtime. The manifest's `qualification: "not-run"` reflects
that an adaptive check must qualify against the frozen controls on each run.
