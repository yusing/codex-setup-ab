import { createHash } from "node:crypto";
import { semanticCheckHash, validateVerification, validateVerifierRecord } from "./semantic-protocol";
import supervisorSource from "./semantic-supervisor.txt" with { type: "text" };
import type { CriterionEvidence, SemanticCheck } from "./semantic";
import type { ArmResult, RunState } from "./types";

export interface VerifiedCriterionEvidence {
  behavior: "pass" | "fail" | "unassessed";
  evaluation_validity: "valid" | "invalid" | "unassessed";
  reason: string;
}

const undecided = (reason: string, invalid = false): VerifiedCriterionEvidence => ({
  behavior: "unassessed", evaluation_validity: invalid ? "invalid" : "unassessed", reason,
});
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Validate a retained probe, not a claimed status or a marker in command output. */
function probe(row: CriterionEvidence): VerifiedCriterionEvidence {
  if (row.schema !== "codex-ab.criterion-evidence.v2" || row.basis !== "executed" || !row.check || !row.execution)
    return undecided("No current supervisor evidence was retained.");
  if (row.check.criterion !== row.criterion || row.execution.validation_error)
    return undecided("The criterion identity or execution validation is invalid.", true);
  try { if (row.check.verification) validateVerification(row.check.verification); }
  catch { return undecided("The declared supervisor assertions are malformed.", true); }
  const record = validateVerifierRecord(row.execution.verifier, row.check, row.check.verification?.cases.length ?? 0);
  if (!record) return undecided("The supervisor record is missing, incomplete, or bound to another check.");
  if (record.status === "evaluator_wiring" || record.status === "executor_setup")
    return undecided("The supervisor recorded an evaluator or executor defect.", true);
  const behavior = record.status === "passed" ? "pass"
    : record.status === "assertion_failure" || record.status === "candidate_error" ? "fail" : "unassessed";
  if (behavior === "unassessed") return undecided(`The supervisor recorded ${record.status}.`);
  if (behavior === "pass" && row.execution.exit_code !== 0)
    return undecided("A successful supervisor record conflicts with command failure.", true);
  if (row.status !== behavior || row.probe_status !== undefined && row.probe_status !== behavior)
    return undecided("The retained assessment does not agree with its supervisor result.");
  return { behavior, evaluation_validity: "valid", reason: "Supervisor evidence attests the declared outcome." };
}

/** Revalidate saved evidence before it can enter behavioral gates or scored attempts. */
function verifyCriterion(row: CriterionEvidence, state: RunState, existing: boolean): VerifiedCriterionEvidence {
  const raw = probe(row);
  if (raw.behavior === "unassessed") return raw;
  const contract = state.criteria?.contract;
  if (!contract || contract.task_sha256 !== state.task.sha256) return undecided("No matching frozen task contract is available.", true);
  const check = row.check!;
  if (existing) {
    if (row.criterion !== "__existing_tests" || check.files.length !== 0
      || JSON.stringify(check.command) !== JSON.stringify(["sh", "-lc", contract.existing_tests])
      || JSON.stringify(check.verification) !== JSON.stringify(contract.existing_test_verification))
      return undecided("The existing-test gate differs from the frozen contract.", true);
    return raw;
  }
  if (!contract.criteria.some(item => item.id === row.criterion)) return undecided("The criterion is not in the frozen task contract.", true);
  const qualification = row.qualification;
  if (!qualification || qualification.status === "not-run" || qualification.status === "incomplete")
    return undecided("Adaptive evaluator qualification is missing or incomplete.");
  if (qualification.status !== "qualified") return undecided("Adaptive evaluator controls failed.", true);
  const controls = contract.evaluator_controls;
  const expectedRuntime = state.evaluator_cache_image?.image_id ?? state.dependency_image?.image_id ?? state.image_id ?? state.image;
  if (qualification.schema !== "codex-ab.evaluator-qualification.v1" || !controls
    || qualification.check_sha256 !== semanticCheckHash(check) || qualification.task_sha256 !== state.task.sha256
    || JSON.stringify(qualification.scope) !== JSON.stringify([row.criterion])
    || qualification.controls_sha256 !== digest({ controls, baseline: state.source.base_commit, reference: state.upstream_reference })
    || qualification.reference_commit !== state.upstream_reference?.end_commit
    || qualification.evaluator_version !== "supervisor-v1" || !qualification.evaluator_model
    || qualification.runtime_image !== expectedRuntime
    || qualification.supervisor_sha256 !== createHash("sha256").update(supervisorSource).digest("hex"))
    return undecided("Evaluator qualification is not bound to these task, check, controls, and runtime identities.", true);
  const expected = controls.cases.filter(control => control.expected[row.criterion]);
  if (!Array.isArray(qualification.results) || expected.length !== qualification.results.length
    || new Set(qualification.results.map(item => item.control)).size !== expected.length)
    return undecided("Evaluator qualification has missing or repeated control results.", true);
  for (const control of expected) {
    const retained = qualification.results.find(item => item.control === control.id);
    const adapted: SemanticCheck = structuredClone(check);
    if (control.python_target && adapted.verification) adapted.verification.cases = adapted.verification.cases.map(item =>
      item.kind === "python-call" ? { ...item, ...control.python_target } : item);
    if (!retained || retained.role !== control.role || retained.expected !== control.expected[row.criterion]
      || retained.matched !== true || !retained.evidence?.check
      || semanticCheckHash(retained.evidence.check) !== semanticCheckHash(adapted)
      || probe(retained.evidence).behavior !== retained.expected)
      return undecided("A frozen evaluator control lacks matching supervisor evidence.", true);
  }
  if (!["reference", "baseline", "negative", "alternative"].every(role => expected.some(control => control.role === role))
    || !expected.some(control => control.role === "reference" && control.expected[row.criterion] === "pass")
    || !expected.some(control => control.role === "alternative" && control.expected[row.criterion] === "pass")
    || !expected.some(control => control.role === "negative" && control.expected[row.criterion] === "fail"))
    return undecided("Qualification does not cover reference, baseline, negative, and alternative implementations.", true);
  return raw;
}

export function verifiedCriterionEvidence(row: CriterionEvidence, state: RunState, existing = row.criterion === "__existing_tests"): VerifiedCriterionEvidence {
  try { return verifyCriterion(row, state, existing); }
  catch { return undecided("Retained evaluator evidence is malformed.", true); }
}

/** A pass requires every declared gate; one independently valid necessary-condition failure settles a fail. */
export function adaptiveBehaviorEvidence(result: ArmResult | undefined, state: RunState) {
  const required = 2 * ((state.criteria?.contract.criteria.length ?? 0) + 1);
  const coverage = { required, verified_pass: 0, verified_fail: 0, unassessed: required, complete: false };
  const issues: string[] = [];
  const evidence = !result ? "unavailable" as const
    : result.capture_identity?.status === "verified" && Object.values(result.grade?.semantic ?? {}).flat().some(row => row.schema === "codex-ab.criterion-evidence.v2")
      ? "verified" as const : "legacy_unverified" as const;
  const finish = (behavior: VerifiedCriterionEvidence["behavior"], evaluation_validity: VerifiedCriterionEvidence["evaluation_validity"]) =>
    ({ behavior, evaluation_validity, evidence, coverage, issues });
  if (!result?.grade || !state.criteria || result.capture_identity?.status !== "verified") {
    issues.push("Trusted candidate capture and a frozen behavioral contract are required.");
    return finish("unassessed", "unassessed");
  }
  if (result.grade.evaluator_error) { issues.push(result.grade.evaluator_error); return finish("unassessed", "invalid"); }
  const ids = state.criteria.contract.criteria.map(item => item.id);
  if (!ids.length || new Set(ids).size !== ids.length) { issues.push("The criterion set is empty or repeated."); return finish("unassessed", "invalid"); }
  let invalid = false;
  let exactCoverage = true;
  for (const pass of [1, 2]) {
    for (const [group, expected] of [[`pass-${pass}`, ids], [`pass-${pass}-existing`, ["__existing_tests"]]] as const) {
      const rows = result.grade.semantic?.[group] ?? [];
      if (rows.length !== expected.length || new Set(rows.map(row => row.criterion)).size !== rows.length
        || rows.some(row => !(expected as readonly string[]).includes(row.criterion))) {
        exactCoverage = false;
        issues.push(`${group}: missing, repeated, or unexpected criterion identities.`);
      }
      for (const id of expected) {
        const matches = rows.filter(row => row.criterion === id);
        if (matches.length !== 1) continue;
        const verified = verifiedCriterionEvidence(matches[0]!, state, id === "__existing_tests");
        if (verified.behavior === "pass") coverage.verified_pass++;
        else if (verified.behavior === "fail") coverage.verified_fail++;
        else issues.push(`${group}/${id}: ${verified.reason}`);
        invalid ||= verified.evaluation_validity === "invalid";
      }
    }
  }
  coverage.unassessed = required - coverage.verified_pass - coverage.verified_fail;
  coverage.complete = exactCoverage && coverage.unassessed === 0;
  if (coverage.verified_fail) return finish("fail", "valid");
  if (coverage.complete && result.grade.passed && result.grade.preparation.exit_code === 0
    && result.grade.preparation.command !== "not run") return finish("pass", "valid");
  if (coverage.complete) issues.push("The retained grade or preparation conflicts with the completed passing gates.");
  return finish("unassessed", invalid || coverage.complete ? "invalid" : "unassessed");
}
