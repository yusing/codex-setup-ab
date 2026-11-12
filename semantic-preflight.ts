import { join } from "node:path";
import { readCandidateManifest } from "./candidate-evidence";
import { validateCriteria } from "./semantic";
import { armNames, type RunState } from "./types";

function inputPath(value: string): string {
  if (!value || value.startsWith("/") || value.includes("\\") || /[\0\r\n]/.test(value)
      || value.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error("adaptive judging requires safe run-relative capture paths");
  }
  return value;
}

/** Pure task readiness check: safe before candidate capture or runtime setup. */
export function verifyAdaptiveContract(state: RunState): void {
  if (state.fixed_verifier) throw new Error("configured fixed-verifier mode does not use adaptive source judging");
  if (!state.criteria) throw new Error("adaptive judging requires a frozen task-derived criteria contract");
  const contract = validateCriteria(state.criteria.contract, state.task.sha256);
  if (!contract.existing_test_verification) {
    throw new Error("adaptive judging requires frozen supervisor observations in existing_test_verification; migrate the task contract before judging");
  }
  const controls = contract.evaluator_controls;
  for (const criterion of contract.criteria) {
    const applicable = controls?.cases.filter(control => control.expected[criterion.id]) ?? [];
    const missing = (["reference", "baseline", "negative", "alternative"] as const).filter(role =>
      !applicable.some(control => control.role === role && (role === "baseline"
        || control.expected[criterion.id] === (role === "negative" ? "fail" : "pass"))));
    if (missing.length) {
      throw new Error(`adaptive judging requires complete frozen evaluator controls for ${criterion.id}: missing ${missing.join(", ")}; migrate the task contract before judging`);
    }
  }
  if (controls!.cases.some(control => control.base === "reference") && !state.upstream_reference) {
    throw new Error("adaptive judging requires the pinned upstream reference used by evaluator controls");
  }
}

/** Refuse unqualified task inputs and unverifiable captures before judge inference. */
export async function verifyAdaptiveJudgeInputs(runDir: string, state: RunState): Promise<void> {
  verifyAdaptiveContract(state);
  for (const arm of armNames(state)) {
    const result = state.results?.[arm];
    const captured = result?.capture_identity;
    if (!result || captured?.status !== "verified") {
      throw new Error(`adaptive judging requires trusted candidate capture provenance for ${arm}; recapture with the current collector`);
    }
    const manifest = await readCandidateManifest(join(runDir, inputPath(captured.manifest_path)), join(runDir, inputPath(result.patch_path)));
    if (manifest.base_commit !== state.source.base_commit || manifest.base_tree !== state.source.base_tree
        || manifest.captured_tree !== captured.tree || manifest.patch_sha256 !== captured.patch_sha256) {
      throw new Error(`adaptive judging candidate identity differs from the retained capture for ${arm}`);
    }
  }
}
