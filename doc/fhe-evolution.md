# Evidence reliability and FHE-style evaluation

This guide identifies the evidence required for trustworthy comparisons. It is
not a claim of an official FHE score. Prepare fresh runs for current guarantees:
unsupported provenance cannot establish a verified winner, complete cost
comparison, or successful import. Import verification never rewrites source runs.

## Evidence requirements

| Evidence | Requirement and owner |
| --- | --- |
| Candidate capture | `codex-ab.candidate-manifest.v1`: filesystem, mode, tree, changed-path, and patch agreement. [Capture contract](contract.md#run-and-grade-both-arms). |
| Published rollouts | `codex-ab.rollouts.v2`: active/archive namespaces and source-price reconciliation before repricing. [Import contract](contract.md#run-and-grade-both-arms). |
| Usage | `codex-ab.usage.v2`: distinct observation validity, request coverage, and pricing precision. [Reporting](contract.md#report). |
| Behavioral evidence | `codex-ab.criterion-evidence.v2`, with independent `codex-ab.verification.v1` observations and trusted completion/failure provenance. [Verification](verification.md). |
| Qualification | Frozen `codex-ab.evaluator-controls.v1` controls and identity-bound `codex-ab.evaluator-qualification.v1` results. [Controls](verification.md#frozen-controls-and-a-complete-example). |
| Reports | Versioned v2 pair/trial/suite reports, with explicit eligibility, selection policy, reliability, and uncertainty. [Reporting](contract.md#report). |
| Fixed verification | `codex-ab.fixed-verifier.v1` inputs and `codex-ab.fixed-result.v1` rewards, separate from adaptive checks. [Fixed verifier](fixed-verifier.md). |
| Networks | `codex-ab.network-policy.v1`: separate arm networks, online-unrestricted candidates, offline verifiers. [Isolation](contract.md#prepare-an-isolated-pair). |

## Interpretation

- Supervisor completion, frozen-control qualification, and source assessment are
  separate evidence. Exit zero or printed success is not behavioral proof.
- Repairs preserve decided checks and case obligations. Same-model reversed
  presentation orders check bias, not independent ground truth.
- Scored-attempt reliability includes defined model/task failures and candidate
  budget timeouts; infrastructure and evaluator faults remain separate. Unknown
  costs cannot support cost-per-success or rankings. Direct-Codex request coverage
  is currently unverified even when token estimates are available.
- Paired uncertainty resamples task means, not repeats as independent tasks.
  One repeated task cannot establish cross-task uncertainty.
- The [four-cell experiment](guidance-launcher.md) separates guidance, launcher,
  and interaction contrasts. Preparation authorizes no inference.
- Fixed verification preserves the upstream reward writer's trust model. Matching
  its commands alone does not match official tasks, providers, budgets, schedules,
  or networks. Results record `methodology_comparable: false`; local tree hashes
  are not official archive hashes. See [provenance limits](fixed-verifier.md#fhe-provenance-and-comparison-limits).

## Validation

Run `bun run check` and `bun run build` for local regression checks and the CLI.
Ordinary tests use frozen prices and a loopback-only HTTP guard. They do not verify
Docker boundaries. The [CI workflow](../.github/workflows/check.yml) runs a separate
credential-free Docker gate for capture, supervisor permissions, source-reader
capabilities, network separation, fixed mounts, and cleanup.

The [verification guide](verification.md#model-free-verification) owns live commands,
fixture requirements, bundled task readiness, and source-judge limitations.
The [fixed-verifier guide](fixed-verifier.md#validation) owns its live checks.
Skipped integrations are not passed checks, and no model-free check authorizes
candidate or judge inference.
