import observations from "./sqlite-observations.json";
import type { CriteriaContract, SemanticCheck } from "../semantic";

/** Authored model-free probes, not a substitute for adaptive checks of the complete prompt. */
export function sqliteQualificationChecks(contract: CriteriaContract): SemanticCheck[] {
  return contract.criteria.map(criterion => {
    const probe = observations[criterion.id as keyof typeof observations];
    if (!probe) throw new Error(`No sqlite-utils observation for ${criterion.id}`);
    return {
      criterion: criterion.id, files: [], command: probe.command,
      rationale: "Observe actual pinned sqlite-utils API/CLI or reader-document behavior. Scope is described in the task README; tests/types/docs observations do not certify all tests or documentation.",
      verification: { schema: "codex-ab.verification.v1", cases: [{ ...probe, kind: "command", format: "json" }] },
    };
  });
}
