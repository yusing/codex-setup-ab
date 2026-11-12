import { createHash } from "node:crypto";
import { semanticCheckHash } from "../semantic-protocol";
import supervisorSource from "../semantic-supervisor.txt" with { type: "text" };
import type { CriterionEvidence, SemanticCheck } from "../semantic";
import type { RunState } from "../types";

/** Structured evidence fixture only: this does not assert that a container was run. */
export function verifiedBehaviorFixture(state: RunState, passed = true): Record<string, CriterionEvidence[]> {
  const contract = state.criteria!.contract;
  contract.existing_test_verification = { schema: "codex-ab.verification.v1", cases: [
    { id: "existing", kind: "command", command: ["fixture-existing-test"], expected_exit: 0, format: "text", expected: "ok\n" },
  ] };
  contract.evaluator_controls = { schema: "codex-ab.evaluator-controls.v1", cases:
    (["reference", "baseline", "negative", "alternative"] as const).map(role => ({
      id: role, role, base: "baseline" as const, files: [],
      expected: Object.fromEntries(contract.criteria.map(item => [item.id, role === "baseline" || role === "negative" ? "fail" as const : "pass" as const])),
    })) };
  const probe = (check: SemanticCheck, success: boolean): CriterionEvidence => ({
    schema: "codex-ab.criterion-evidence.v2", criterion: check.criterion, status: success ? "pass" : "fail", basis: "executed", reasoning: "Fixture supervisor evidence.",
    check, execution: { command: JSON.stringify(check.command), started_at: "2026-10-01T00:00:00Z", elapsed_ms: 1,
      exit_code: success ? 0 : 1, stdout: "", stderr: "", verifier: {
        schema: "codex-ab.verifier-result.v1", check_sha256: semanticCheckHash(check), status: success ? "passed" : "assertion_failure",
        completed: check.verification!.cases.length, expected: check.verification!.cases.length, detail: "Fixture supervisor completion.",
        cases: check.verification!.cases.map(item => ({ id: item.id, status: success ? "pass" : "fail", exit_code: 0, stdout: success ? "ok\n" : "wrong\n", stderr: "" })),
      } },
  });
  const assessed = contract.criteria.map(item => {
    const check: SemanticCheck = { criterion: item.id, command: ["fixture-behavior"], rationale: "Fixture behavioral assertion.", files: [],
      verification: { schema: "codex-ab.verification.v1", cases: [{ id: "behavior", kind: "command", command: ["fixture-probe"], expected_exit: 0, format: "text", expected: "ok\n" }] } };
    const row = probe(check, passed);
    row.probe_status = row.status;
    row.qualification = {
      schema: "codex-ab.evaluator-qualification.v1", status: "qualified", scope: [item.id], check_sha256: semanticCheckHash(check),
      controls_sha256: createHash("sha256").update(JSON.stringify({ controls: contract.evaluator_controls, baseline: state.source.base_commit, reference: state.upstream_reference })).digest("hex"),
      task_sha256: state.task.sha256, evaluator_version: "supervisor-v1", evaluator_model: "fixture-evaluator",
      runtime_image: state.evaluator_cache_image?.image_id ?? state.dependency_image?.image_id ?? state.image_id ?? state.image,
      supervisor_sha256: createHash("sha256").update(supervisorSource).digest("hex"), reference_commit: state.upstream_reference?.end_commit,
      results: contract.evaluator_controls!.cases.map(control => ({ control: control.id, role: control.role,
        expected: control.expected[item.id]!, matched: true, evidence: probe(check, control.expected[item.id] === "pass") })), limitations: ["Synthetic test fixture."],
    };
    return row;
  });
  const existing = probe({ criterion: "__existing_tests", command: ["sh", "-lc", contract.existing_tests], files: [],
    rationale: "Frozen existing-test assertion.", verification: contract.existing_test_verification }, true);
  return { "pass-1": structuredClone(assessed), "pass-2": structuredClone(assessed),
    "pass-1-existing": [structuredClone(existing)], "pass-2-existing": [structuredClone(existing)] };
}
