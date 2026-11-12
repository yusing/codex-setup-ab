# Regression coverage map

This map shows which recurring agent failure classes the commit-backed task packs
and evaluation checks can detect, and which they cannot. It lets readers choose
tasks for an instruction or launcher comparison and judge what a result does and
does not establish. The classes summarize recurring failures that instruction
changes have tried to prevent; they are not a claim that every past session was
inspected.

A task detects a class only through observable output: the delivered patch, its
executed checks, the judge's seven-axis assessment, and recorded telemetry. A
benchmark run cannot show that an agent avoided a failure the task never offered.

## Covered classes

| Failure class | Where it is observable | Evidence |
| --- | --- | --- |
| Expected test values edited to accept a regression; tautological tests | [Remote uninstall](../tasks/skills-mgr-remote-uninstall/README.md), [fast acquisition](../tasks/skills-mgr-get-short-circuit/README.md) | Retained baseline tests fail when unchanged baseline files no longer pass; fast acquisition's `tests` criterion requires discriminating regressions; test-quality axis |
| A parallel mechanism added instead of adapting the existing owner | Remote uninstall, [repository-to-agent workflow](../tasks/skills-mgr-agent-cli/README.md) | Simplicity and approach axes, grounded in reference designs that reuse the existing transaction |
| Speculative safeguards, caches, or durable state | Fast acquisition | `no-persistent-cache` criterion; simplicity axis |
| Caller-specific behavior lost when an implementation is shared or optimized | Fast acquisition, remote uninstall | `expression-semantics`, `shared-consumers`, `scope-and-guidance` criteria; retained baseline tests |
| Class-wide requirement covered for only some members | Remote uninstall, repository-to-agent workflow | `recovery-states` and `consumers-tests-docs`; alias and invocation-policy cases in `content-checks` and `content-resources` |
| Ownership or trust failure treated as absence, or owned content deleted | Remote uninstall, repository-to-agent workflow | `ownership-rejections`; `remote-edit-rejection` with preserved state |
| Agent interpretation substituted for an explicit acceptance distinction | Repository-to-agent workflow | Separate `remote-edit-rejection` and `remote-edit-success` criteria and explicit evaluator guidance |
| Documentation or usage left stale | All three skills-mgr packs | Documentation and usage clauses in each pack's final criterion |
| Unaffected behavior regressed by a wider-than-requested change | Remote uninstall, fast acquisition | Retained baseline tests; existing-test gate; simplicity axis |
| Source inspection presented as behavioral proof | All packs | A criterion passes only with an executed check the judge accepts as covering it |
| Requirements lost across a long session | Repository-to-agent workflow | Eleven connected criteria over a multi-commit change; compactions are recorded, not forced |
| Repeated reads, duplicate suites, noisy output, and excess delegation | All packs | Agent elapsed time, root and child tokens, and command seconds per arm |

## Not covered

These classes need interaction, multiple sessions, or artifacts that a
single-prompt repository task does not produce:

- Misreading a mid-task correction or question, and asking or omitting a
  clarifying question. Runs receive one prompt and no follow-up turns.
- Handoff quality across separate sessions, and how a resumed agent consumes it.
- Skill selection and delivery. Comparisons that disable every skill cannot
  observe it.
- Version-control hygiene such as commit scope, worktree placement, and checking
  for upstream patches before removal. Candidates are graded on their working tree.
- Tone, punctuation, and responsiveness of the final reply, which the judge does
  not receive.
- Web UI design guidance.
- Review independence and delegation structure, except through their token and
  time cost.

Treat results on the covered classes as evidence for those classes only. A better
score on these tasks does not establish improvement on the classes above.
