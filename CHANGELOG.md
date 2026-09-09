# Changelog

## 0.1.1 - 2026-09-09

- Clone the configuration repository instead of requiring a hardcoded instruction-file list; preserve tracked working changes and record commit/tree provenance.
- Keep untracked runtime supplements separate and retain the compatible 0.1.0 container image default.

## 0.1.0 - 2026-09-09

- Add isolated preparation for two independent base-only repository clones.
- Add parallel stock and current-setup Codex execution with equal resource limits.
- Add evaluator-only grading, two-pass blind judging, rollout usage metering, and reports.
- Verify the standalone Codex CLI and matching code-mode host by hash and an offline execution smoke before model launch.
- Add explicit infrastructure invalidation that preserves attempted-run evidence while suppressing judging and winners.
