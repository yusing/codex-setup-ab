# Portable skill bundle benchmark

A new task in skills-mgr, replacing the rejected info-command task. The user-approved prompt asks for reproducible archive creation, verification and extraction, executable preservation, rejection of corrupt/unsafe archives, and no overwrites. It deliberately leaves the archive schema and implementation choices open.

- Source: `/home/ubuntu/projects/skills-mgr`.
- Base: `f16d629d7acafaa57ddc94a9a295f5040eb2c8df`, September 11, 2026. This is later than the April 30, 2026 cutoffs documented for `gpt-6-astra` and `gpt-6.1-sol` in [task provenance](../../doc/cli.md#commit-backed-task-provenance).
- No existing solution commit: the forbidden identity is the all-zero SHA sentinel, which must remain absent.
- [Task](task.md) is the complete short user-approved prompt. No additional specification is supplied to the agent.
- [Criteria](criteria.json) describe required behavior without fixing an archive schema. Adaptive checks use each candidate's actual CLI and archives.
- Package: root `.`. No submodules or generated Mekugi plugin assets.

## Minimal Codex versus current-home Mekugi

Follow the [build guide](../../doc/cli.md#prerequisites-and-build), then use your current home and installed Mekugi executable. Replace the example source, home, and executable paths with your local paths. Active home guidance and source repositories remain unchanged. Historical v3 overlays are no longer bundled; this recipe measures the current setup rather than recreating that treatment.

```sh
./dist/codex-ab prepare \
  --profile skills-mgr-bundle \
  --source /home/ubuntu/projects/skills-mgr \
  --base f16d629d7acafaa57ddc94a9a295f5040eb2c8df \
  --forbidden 0000000000000000000000000000000000000000 \
  --task tasks/skills-mgr-bundle/task.md \
  --criteria tasks/skills-mgr-bundle/criteria.json \
  --current-home /home/ubuntu \
  --comparison stock-current \
  --current-launcher mekugi \
  --mekugi-bin /home/ubuntu/go/bin/mekugi \
  --reasoning-effort medium \
  --image codex-ab:0.1.0
```

Use the returned directory for `preflight`, then `run --confirm-paid-inference`. The stock arm uses minimal Codex; the current arm uses your current home through `mekugi codex`. Both receive the same short task and start concurrently after non-inference checks pass. The finishing bundle records checks, usage, timing, list-price cost estimates, patches, identities, and reviewer/interaction audits. Prior v3 measurements describe their historical setup and must not be pooled with this comparison.

## Frozen observations and model-free checks

The existing-behavior gate compares actual skill reading, script execution,
line-range reading, missing/nested language evidence, and listing. The original
root Go suite runs separately as a diagnostic. Neither its exit status nor this
focused observation gate independently certifies the entire suite.

There is no upstream bundle solution commit. The evaluator controls therefore
contain an explicitly **authored local reference** and an **authored compressed
alternative**, both added to the unchanged pinned baseline. They implement local
ZIP bundles with different compression and deterministic member ordering. They
are qualification fixtures, not upstream provenance or a required candidate
archive schema, CLI spelling, or implementation. The all-zero forbidden sentinel
and baseline remain unchanged.

Targeted incorrect controls change round-trip contents, make archives depend on
their output path, lose executable permission, accept unsafe archives, truncate
an existing archive, or omit bundle regression tests. The unchanged baseline is
expected to fail the new bundle criteria, while preserving the existing gate.

```sh
CODEX_AB_LIVE_DOCKER=1 CODEX_AB_SKILLS_MGR_SOURCE=/path/to/skills-mgr \
  CODEX_AB_SKILLS_VERIFIER_IMAGE=codex-ab:skills-mgr-migration-offline \
  bun test skills-other-qualification.live.test.ts
```

Use an offline dependency image containing the pinned Go modules. This model-free
check exercises actual create/verify/extract operations, byte-for-byte portable
contents, reproducibility across changed paths/mtimes/creation order, executing an
extracted script, corrupt/traversal/link rejection, and collision sentinel
preservation. Test sensitivity is checked using named failures for corrupted
round-trip contents and unsafe acceptance. It does not claim comprehensive test
quality or freeze candidate interfaces; adaptive checks still use the candidate's
actual commands and format. Harness wiring failures remain assessment gaps.
