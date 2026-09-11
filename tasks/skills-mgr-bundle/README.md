# Portable skill bundle benchmark

A new task in skills-mgr, replacing the rejected info-command task. It requires reproducible archive creation, strict untrusted-input verification, atomic no-clobber extraction, executable-mode preservation, and bounded resource use.

- Source: `/home/ubuntu/projects/skills-mgr`.
- Base: `f16d629d7acafaa57ddc94a9a295f5040eb2c8df`.
- No existing solution commit: the forbidden identity is the all-zero SHA sentinel, which must remain absent.
- [Task](task.md) specifies the complete public CLI and v1 format.
- [Evaluator](acceptance_test.go) uses the existing command dispatcher and independently constructed archives.
- Package: root `.`. No submodules or generated Mekugi plugin assets.

## V3 run

Use current home plus the original v3 overlay and the current installed matching Mekugi/shell pair. Active home guidance and source repositories remain unchanged.

```sh
./dist/codex-ab prepare \
  --profile skills-mgr-bundle \
  --source /home/ubuntu/projects/skills-mgr \
  --base f16d629d7acafaa57ddc94a9a295f5040eb2c8df \
  --forbidden 0000000000000000000000000000000000000000 \
  --task tasks/skills-mgr-bundle/task.md \
  --acceptance tasks/skills-mgr-bundle/acceptance_test.go \
  --current-home /home/ubuntu \
  --review-treatment treatments/continuous-review-v3 \
  --current-launcher mekugi \
  --mekugi-bin /home/ubuntu/go/bin/mekugi \
  --mekugi-shell-bin /home/ubuntu/go/bin/shell \
  --snapshot-base /tmp/codex-ab-jGXnG1 \
  --reasoning-effort medium \
  --image codex-ab:0.154.0
```

Use the returned directory for `preflight`, then `run --arm current --confirm-paid-inference`. This is v3 only, not a stock comparison. The finishing bundle records checks, usage, timing, list-price cost estimates, patches, identities, and reviewer/interaction audits. Prior v3 measurements remain descriptive only because the task and launcher differ.

Required checks run `go test -json . -run '^TestABAcceptance' -count=1` and `go test -json . -count=1` with evaluator-private offline caches. A supplemental check repeats the suite twice with a 180-second timeout. Acceptance source stays hidden from the benchmark agent. Because the task is invented, there is no oracle solution against which to validate positive behavior before inference.

