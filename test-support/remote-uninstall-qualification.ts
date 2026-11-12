import type { CriteriaContract, SemanticCheck } from "../semantic";

/** CLI observations, with asserted values retained outside the candidate process. */
export function remoteUninstallQualificationChecks(contract: CriteriaContract): SemanticCheck[] {
  const observer = contract.existing_test_verification!.cases[0]!;
  if (observer.kind !== "command") throw new Error("remote-uninstall requires its frozen CLI observer");
  const removed = (mode: string) => ({ mode, exit: 0, confirmation: true, record: false, override: false, patch: false,
    selected: false, placeholders: [false, false], other_unchanged: true, unchanged: false, local: null,
    condition_ran: false, served_exit: 1, global_guidance: false });
  const rejected = (mode: string) => ({ mode, exit: 1, confirmation: false, record: true, override: false, patch: false,
    selected: true, placeholders: [true, true], other_unchanged: true, unchanged: true,
    local: mode.includes("shadowed") ? "---\nname: alpha\ndescription: Local.\n---\nLocal body.\n" : null,
    condition_ran: false, served_exit: 0, global_guidance: mode === "global-rejected" });
  const groups = [
    { criterion: "uninstall-removal", modes: ["enabled"], expected: [removed("enabled")] },
    { criterion: "recovery-states", modes: ["disabled", "condition", "missing", "override", "override-directory"],
      expected: ["disabled", "condition", "missing", "override", "override-directory"].map(removed) },
    { criterion: "ownership-rejections", modes: ["shadowed", "missing-shadowed", "unknown", "invalid", "extra", "no-argument"],
      expected: ["shadowed", "missing-shadowed", "unknown", "invalid", "extra", "no-argument"].map(rejected) },
    { criterion: "scope-and-guidance", modes: ["global", "home", "global-rejected"],
      expected: [removed("global"), removed("home"), rejected("global-rejected")] },
    { criterion: "consumers-tests-docs", modes: [], consumers: true, expected: [{ mode: "consumers", help_exit: 0,
      help_uninstall: true, fish_exit: 0, fish_uninstall: true, fish_global: true, readme_uninstall: true, readme_global: true }] },
  ];
  return groups.map(group => ({ criterion: group.criterion, files: [], command: observer.command,
    rationale: "Observe real command outputs and filesystem effects. Composite test/document/native/cancellation obligations need additional assessment.",
    verification: { schema: "codex-ab.verification.v1", cases: [{ ...observer, id: group.criterion,
      stdin: JSON.stringify({ modes: group.modes, consumers: group.consumers ?? false }), expected: JSON.stringify(group.expected) }] } }));
}
