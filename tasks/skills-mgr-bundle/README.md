# Portable skill bundle benchmark

A new task in skills-mgr, replacing the rejected info-command task. The user-approved prompt asks for reproducible archive creation, verification and extraction, executable preservation, rejection of corrupt/unsafe archives, and no overwrites. It deliberately leaves the archive schema and implementation choices open.

- Source: `/home/ubuntu/projects/skills-mgr`.
- Base: `f16d629d7acafaa57ddc94a9a295f5040eb2c8df`.
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

Existing root-package tests and adaptive semantic checks cover reproducibility, executable preservation, corrupt and unsafe archives, and no-overwrite behavior. The task leaves CLI and archive formats open; harness wiring problems are assessment gaps rather than product failures. No prewritten hidden tests are supplied.
