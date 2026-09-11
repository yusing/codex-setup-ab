# Portable skill bundle benchmark

A new task in skills-mgr, replacing the rejected info-command task. The user-approved prompt asks for reproducible archive creation, verification and extraction, executable preservation, rejection of corrupt/unsafe archives, and no overwrites. It deliberately leaves the archive schema and implementation choices open.

- Source: `/home/ubuntu/projects/skills-mgr`.
- Base: `f16d629d7acafaa57ddc94a9a295f5040eb2c8df`.
- No existing solution commit: the forbidden identity is the all-zero SHA sentinel, which must remain absent.
- [Task](task.md) is the complete short user-approved prompt. No additional specification is supplied to the agent.
- [Evaluator](acceptance_test.go) checks observable behavior using candidate-created archives, without requiring the discarded private v1 schema. Unsupported CLI/archive shapes must be reported as evaluator coverage gaps rather than product failures.
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

Use the returned directory for `preflight`, then `run --confirm-paid-inference`. A uses stock Codex; B uses current home plus v3 through `mekugi codex`. Both receive the same short task and start concurrently after non-inference checks pass. The finishing bundle records checks, usage, timing, list-price cost estimates, patches, identities, and reviewer/interaction audits. Prior v3 measurements remain descriptive only because the task and launcher differ.

Required checks run `go test -json . -run '^TestABAcceptance' -count=1` and `go test -json . -count=1` with evaluator-private offline caches. A supplemental check repeats the suite twice with a 180-second timeout. Acceptance source stays hidden from the benchmark agent. Because the task is invented, there is no oracle solution against which to validate positive behavior before inference.

The evaluator accepts source-first, archive-first, and `--output` CLI forms, and either direct payloads or a preserved named skill root. Archive-structure probes support ZIP and tar.gz; an unsupported form is a coverage gap to investigate, not evidence that the feature is wrong. Corruption checks do not impose a private manifest schema, exact resource limits, or exact permission normalization. Concurrent-process checks verify usable publication; source assessment must still inspect no-clobber race handling.

The initial evaluator could not recognize A's archive-first, multi-skill ZIP interface. Its correction adds interface/root-layout recognition and keeps the fixture's logical skill name constant across reproducibility checks. Functional checks and the user prompt are unchanged; original controls and grades are retained in the regrade archive.
