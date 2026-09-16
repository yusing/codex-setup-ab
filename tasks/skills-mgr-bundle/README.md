# Portable skill bundle benchmark

A new task in skills-mgr, replacing the rejected info-command task. The user-approved prompt asks for reproducible archive creation, verification and extraction, executable preservation, rejection of corrupt/unsafe archives, and no overwrites. It deliberately leaves the archive schema and implementation choices open.

- Source: `/home/ubuntu/projects/skills-mgr`.
- Base: `f16d629d7acafaa57ddc94a9a295f5040eb2c8df`.
- No existing solution commit: the forbidden identity is the all-zero SHA sentinel, which must remain absent.
- [Task](task.md) is the complete short user-approved prompt. No additional specification is supplied to the agent.
- [Criteria](criteria.json) describe required behavior without fixing an archive schema. Adaptive checks use each candidate's actual CLI and archives.
- Package: root `.`. No submodules or generated Mekugi plugin assets.

## Stock A versus v3 B

Use current home plus the original v3 overlay and the current installed matching Mekugi/shell pair. Active home guidance and source repositories remain unchanged.

```sh
./dist/codex-ab prepare \
  --profile skills-mgr-bundle \
  --source /home/ubuntu/projects/skills-mgr \
  --base f16d629d7acafaa57ddc94a9a295f5040eb2c8df \
  --forbidden 0000000000000000000000000000000000000000 \
  --task tasks/skills-mgr-bundle/task.md \
  --criteria tasks/skills-mgr-bundle/criteria.json \
  --current-home /home/ubuntu \
  --review-treatment treatments/continuous-review-v3 \
  --current-launcher mekugi \
  --mekugi-bin /home/ubuntu/go/bin/mekugi \
  --mekugi-shell-bin /home/ubuntu/go/bin/shell \
  --snapshot-base /tmp/codex-ab-jGXnG1 \
  --reasoning-effort medium \
  --image codex-ab:0.154.0
```

Use the returned directory for `preflight`, then `run --confirm-paid-inference`. A uses stock Codex; B uses current home plus v3 through `mekugi codex`. Both receive the same short task and start concurrently after non-inference checks pass. The finishing bundle records checks, usage, timing, list-price cost estimates, patches, identities, and reviewer/interaction audits. Prior v3 measurements remain descriptive only because the task and launcher differ.

Existing root-package tests and adaptive semantic checks cover reproducibility, executable preservation, corrupt and unsafe archives, and no-overwrite behavior. The task leaves CLI and archive formats open; harness wiring problems are assessment gaps rather than product failures. No prewritten hidden tests are supplied.
