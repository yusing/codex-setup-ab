# Evidence reliability and FHE-style evaluation

This change implements the evidence-first proposal against
`1c2ee9f907f85d1b2d5c4593d382d40d6d539278`. The proposal audited
`4d05e5a93db51337836c3ec88ae83858d7033d03`; the intervening commit had already
retained decided checks during repair and narrowed some exception handling.
Those improvements are preserved and extended. Existing runs are not evidence
that any particular failure described here occurred in practice.

Compatibility with older evidence formats is not a release goal. Prepare fresh
runs for the new guarantees. Unsupported or incomplete provenance cannot produce
a verified winner, a complete cost comparison, or a successful historical import.
Original source artifacts are never rewritten by import verification.

## Findings and changes

| Area | Finding at the starting HEAD | Change |
| --- | --- | --- |
| Candidate capture | The actual collector still honored candidate Git behavior; the reproduction substitutes a valid patch and writes another retained file. | Read-only source and seed, fresh output-only mount, sanitized Git metadata, raw filesystem capture, independent manifest and reconstruction checks. |
| Archived usage | Session discovery and import could omit archived rollouts while retaining plausible totals. | One canonical active/archive discovery path, namespace-preserving v2 manifest, source-price reconciliation before repricing, original measurements retained. |
| Verifier completion | Exit zero and output summaries did not prove that assertions completed. | A separate supervisor owns expectations and the nonempty case set; candidate code cannot write the completion record. Early exit, missing records, empty/legacy suites, and forged output cannot pass. |
| Failure ownership | Candidate-controlled text could affect evaluator-error classification. | Structured supervisor provenance for setup, wiring, candidate error, assertions, timeout, cancellation, and incompleteness. |
| Repair | Starting HEAD already preserved decided checks, but wiring repairs lacked enforceable semantic obligations. | Frozen check decisions, unchanged case inputs and expectations, explicit defect and retained obligations, qualification after repair. |
| Accounting | Valid-looking counters did not establish request coverage or precise per-request prices. | Safe integer and subset validation, separate observation/coverage/precision dimensions, no unsupported cumulative/delegate addition, strict cost eligibility. |
| Evaluator validity | Reversed-order source judging was not an independent oracle. | Frozen reference, baseline, targeted negative, and valid alternative controls; identity-bound qualification and explicit limitations. |
| Selection | Fresh holistic preference and historical weighted selection intentionally differed. | Explicit behavioral eligibility, score leaders, holistic preference, policy, availability, and disagreement; incomplete evidence cannot become a verified winner. |
| Judge/network boundaries | The source judge could execute code with credentials; candidate networking did not establish closed-book behavior. | Restricted source-reader broker and pinned capability qualification; separate arm networks; explicit online-unrestricted policy. |
| CI | Normal checks skipped real container boundaries. | A regular credential-free Docker job exercises collection, supervisor, reader, network separation, fixed mounts, import, and cleanup. |

## New evaluation and analysis paths

Scored-attempt reliability supplements the existing paired efficiency view on
joint successes. It records attempted, scored, passed, excluded, and cost-covered
counts. Model/task failures and candidate budget timeouts are scored;
infrastructure faults, invalid evaluation, administrative cancellation, and
unassessed outcomes are separate. A generic nonzero candidate exit remains unknown
unless trusted provenance identifies its cause; it is not guessed to be a scored
model failure. Cost per verified success includes eligible
candidate spend on scored failures, remains unavailable when costs are incomplete,
and is explicitly undefined when no attempt succeeds. Judge spend is separate.

Paired uncertainty groups repeats within tasks and bootstraps equal-weight task
means. Fresh/historical sources and execution schedules remain identifiable.
One repeated task cannot produce a cross-task interval; very small task sets
remain explicitly unstable.

The [four-cell helper](guidance-launcher.md) prepares minimal/current guidance
crossed with direct Codex/Mekugi, pins shared controls, and records fresh repeats
and schedule. Reports keep B−A, C−A, D−C, and the interaction separate. Preparation
does not authorize a paid run or assume an experimental result.

The [fixed-verifier path](fixed-verifier.md) is a distinct evaluator mode with
immutable task/verifier tree identities, runtime image and resource limits,
exact prompt binding, original commands, retained logs/reward, and verified
cleanup. Supplemental verification preserves adaptive results separately.
An exit-zero command without a valid reward is not a pass. Ordinary nonzero
exit with a valid reward follows the upstream adapter's documented semantics;
timeout, cancellation, and infrastructure failures remain invalid evaluation.

## Schemas and upgrade requirements

| Evidence | Current schema / requirement |
| --- | --- |
| Candidate capture | `codex-ab.candidate-manifest.v1`; file, mode, tree, changed-path, and patch agreement |
| Published rollout inventory | `codex-ab.rollouts.v2`; active and archived namespaces |
| Usage | `codex-ab.usage.v2`; observation validity, request coverage, pricing precision, and coverage basis |
| Behavioral evidence | `codex-ab.criterion-evidence.v2` and `codex-ab.verification.v1` supervisor records |
| Evaluator qualification | `codex-ab.evaluator-controls.v1` and `codex-ab.evaluator-qualification.v1` |
| Pair / trial / suite reports | Versioned v2 report schemas; reliability, uncertainty, and evidence dimensions |
| Fixed verifier | `codex-ab.fixed-verifier.v1` and `codex-ab.fixed-result.v1` |
| Network policy | `codex-ab.network-policy.v1`; explicit online policy and separate arm networks |

Task packs need meaningful `existing_test_verification` observations and frozen
`evaluator_controls` before adaptive results can be verified. Multi-arm adaptive
runs reject known-missing controls before candidate inference; direct judging
also verifies retained capture before authentication or model requests. An arbitrary
shared-process pytest, Go, or Jest exit status does not satisfy that requirement.
The [verification guide](verification.md) defines supported command and Python
observations, control requirements, and preserved repair obligations. Merely
adding a trivial success case does not qualify a task's behavioral requirements.

Direct-Codex rollouts currently do not carry a qualified request-completion and
delegated-ownership protocol. Their observed token and cost estimates remain
visible, but request coverage stays unverified and cannot support a cost ranking.
Validated provider captures must meet the explicit coverage contract.

## Real-task qualification

The existing [Flask IPv6 pack](../tasks/flask-ipv6-server-name/README.md) now has
frozen controls on its actual pinned Flask source, with exact source patch
identities. Its reference and independent bracket-parser alternative pass both
criteria; the unchanged baseline fails IPv6 while preserving existing address
selection; the targeted incorrect implementation fails both. Thirteen retained
behavior observations and seven IPv6 observations exercise real `Flask.run`.
The original pytest command remains a separate non-gating diagnostic.

Host Python observation checks matched all four expected outcome pairs. The
original pytest diagnostics reported 10 passing tests on the reference, 9 on the
baseline, 2 failures and 8 passes on the negative, and 9 passes on the alternative.
The live CI test uses the actual offline semantic and qualification path. Host
observations alone do not verify its Docker permissions. Other existing task
packs still need task-specific controls before adaptive execution is allowed.

## Validation

The regression suite includes the complete old collector from the starting HEAD
as a pinned fixture, with only its mount paths relocated. It demonstrates the
old corruption and then runs the new collector against the same candidate.
This local process reproduction is distinct from real Docker mount verification.
Other fixtures exercise archived-only and mixed-session imports through the
supported entry points, invalid counters, early verifier exit, result spoofing,
repair preservation, qualification, denominator edge cases, and grouped uncertainty.

Validation on the completed local implementation (Bun 1.4.4):

| Command / scope | Outcome |
| --- | --- |
| `bun run check` | Documentation paths and production typechecking passed; **579 tests passed, 28 skipped, 0 failed**, 4,011 assertions across 55 files. |
| `bun run build` | Passed; standalone CLI compiled. |
| `git diff --check` | Passed. |
| Real Flask source observations | All four expected control outcome pairs matched; original pytest diagnostics are listed above. |
| Model-free Docker CI gate | Runs in GitHub Actions; [PR #1 checks](https://github.com/yusing/codex-setup-ab/pull/1/checks) record the results. Docker is unavailable in the implementation workspace. |
| GitHub publication | Write access restored; published as [draft PR #1](https://github.com/yusing/codex-setup-ab/pull/1). The initial published tree exactly matches the locally tested implementation. |

The 28 local skips explicitly include Docker, live Mekugi, original-task/cache
fixtures, and the host-specific Code Mode companion. They are not successful
boundary verification. The Code Mode smoke test now requires an explicit
`CODEX_AB_LIVE_TOOLHOST=1` opt-in and its real installed companion, rather than
assuming a developer-specific home path exists in ordinary CI.

Ordinary Bun tests preload a loopback-only HTTP guard and use frozen pricing
fixtures. The initially attempted unguarded suite reached a public pricing
endpoint and was stopped by automatic approval review; the guarded path removes
that external dependency without changing production pricing behavior.

The configured Docker gate is:

```sh
docker build -f Dockerfile.model-free \
  --build-arg FIXTURE_UID="$(id -u)" --build-arg FIXTURE_GID="$(id -g)" \
  -t codex-ab:model-free .
CODEX_AB_LIVE_DOCKER=1 CODEX_AB_LIVE_IMAGE=codex-ab:model-free \
  CODEX_AB_VERIFIER_IMAGE=codex-ab:model-free \
  CODEX_AB_FLASK_SOURCE=/absolute/pinned-flask-checkout \
  bun test --timeout 60000 candidate.live.test.ts semantic.live.test.ts \
  judge-boundary.live.test.ts network.live.test.ts container.live.test.ts \
  fixed-verifier.live.test.ts flask-qualification.live.test.ts
bun test control.test.ts bundle.test.ts
```

The workflow supplies the exact Flask checkout automatically. This gate must
pass before claiming verified container boundaries or treating this change as
fully accepted. No paid candidate or judge run was performed.

## Limits and further validation

- The source-reader capability boundary is qualified for **Codex CLI 0.154.0**.
  Another CLI version fails closed before source-judge inference until its tool
  registration semantics and runtime behavior are qualified. The native patch tool
  remains registered but its writes are denied by read-only/never policy; it is
  not a general process-execution capability. Broker path restrictions do not
  claim to remove the patch tool's limited path/context-match observations.
- Ordinary candidate execution is **online unrestricted**. Separate Docker
  networks isolate peer arms; there is no provider-only egress allowlist and no
  closed-book claim.
- The independent observation protocol supports command output and JSON Python
  calls. Stateful APIs, arbitrary in-process test runners, non-JSON results, and
  other language bindings need dedicated adapters. It does not attest a native
  function return against an implementation that forges the same observable RPC.
- Frozen controls constrain an evaluator but do not prove universal correctness.
  Source-quality assessment remains model-dependent. Both presentation orders
  use the same model and are a bias check.
- The original-verifier adapter preserves the upstream verifier's trust model;
  it does not automatically protect an upstream in-process reward writer from
  candidate behavior. It records this separately from supervisor-verified checks.
- The official FHE site describes **1.1.0**. Its older public evaluation repository
  still describes **v1, 30 tasks** and cannot be relabeled 1.1. The 1.1 task archive
  and exact published hash manifest were not available for a complete local
  qualification during implementation. Local tree identities are not claimed
  to be official archive hashes.
- Fixed results set `methodology_comparable: false`. Matching original verifiers
  alone does not match provider/model, resources, budgets, network policy,
  schedules, or the full official task set. No official score or leaderboard
  equivalence is claimed.
- Model-free preparation and tests do not authorize candidate or judge inference.
  Fresh model-dependent evaluator qualification, task runs, and the four-cell
  experiment still require the existing explicit paid-inference consent.

## Primary references

- [FHE scoring and methodology](https://frontierharness.org/about/)
- [FHE efficiency definitions](https://frontierharness.org/efficiency/)
- [FHE dataset listing](https://hub.harborframework.com/datasets/frontier-harness-eval/frontier-harness-eval)
- [Public v1 evaluation harness](https://github.com/frontier-harness-eval/eval)
- [Harbor verifier reward handling](https://github.com/harbor-framework/harbor/blob/main/src/harbor/verifier/verifier.py)
- [Codex 0.154.0 tool registration](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/core/src/tools/spec_plan.rs)
