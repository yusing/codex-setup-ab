import { armRuntime, parseArmSettings } from "./arm-settings";
import { validateMekugiFlags } from "./mekugi";
import { pairedUncertaintyByCohort, type BootstrapOptions, type PairedObservation } from "./uncertainty";
import type { ArmConfiguration, ArmSettings, RunState } from "./types";

export const GUIDANCE_LAUNCHER_CELLS = {
  A: { arm: "stock", guidance: "minimal", launcher: "codex" },
  B: { arm: "current", guidance: "minimal", launcher: "mekugi" },
  C: { arm: "arm-3", guidance: "current", launcher: "codex" },
  D: { arm: "arm-4", guidance: "current", launcher: "mekugi" },
} as const;
export type FactorialCell = keyof typeof GUIDANCE_LAUNCHER_CELLS;
export interface GuidanceLauncherPlan {
  schema: "codex-ab.guidance-launcher-plan.v1";
  setup_commit: string;
  repetitions: number;
  schedule: "concurrent" | "alternating";
  comparison: "custom";
  cells: typeof GUIDANCE_LAUNCHER_CELLS;
  arms: ArmConfiguration[];
  arm_settings: Record<string, ArmSettings>;
  intentional_differences: string[];
}
export interface GuidanceLauncherExperiment {
  schema: "codex-ab.guidance-launcher-experiment.v1";
  plan: GuidanceLauncherPlan;
  task: { id: string | null; task_sha256: string; base_commit: string; pack_sha256: string | null };
  runtime: { codex_sha256: string; codex_code_mode_host_sha256: string; mekugi_sha256: string; mekugi_exec_sha256: string; tool_store_manifest_sha256: string; image_id: string | null };
  controls: { model: string; reasoning_effort: string; service_tier: string; cpus: string; memory: string; timeout_seconds: number; auto_compact_limit: number | null; parallel_work: boolean };
  claim: "prepared design; no outcome or benchmark comparability established";
}

/** Both launchers get the same controls at each guidance level; no inference occurs. */
export function buildGuidanceLauncherPlan(input: {
  setup_commit: string;
  shared_settings: ArmSettings;
  repetitions: number;
  schedule?: "concurrent" | "alternating";
  mekugi_flags?: string[];
}): GuidanceLauncherPlan {
  if (!/^[0-9a-f]{40}$/.test(input.setup_commit)) throw new Error("four-cell preparation requires a pinned full setup commit SHA");
  if (!Number.isSafeInteger(input.repetitions) || input.repetitions < 2) throw new Error("four-cell experiment requires fresh repeated runs");
  const schedule = input.schedule ?? "alternating";
  if (!["concurrent", "alternating"].includes(schedule)) throw new Error("invalid four-cell schedule");
  const shared = input.shared_settings;
  if (!shared || ["model", "reasoning_effort", "cpus", "memory", "timeout_seconds"].some(key => shared[key as keyof ArmSettings] === undefined)
    || shared.skills !== undefined || shared.mekugi_flags !== undefined) throw new Error("supply explicit shared model, reasoning, resources and timeout; guidance skills remain the treatment");
  const flags = validateMekugiFlags(input.mekugi_flags ?? []);
  const arms = Object.values(GUIDANCE_LAUNCHER_CELLS).map(cell => ({ launcher: cell.launcher,
    setup_commit: cell.guidance === "minimal" ? "stock" : input.setup_commit }));
  const arm_settings = parseArmSettings(Object.fromEntries(Object.values(GUIDANCE_LAUNCHER_CELLS).map(cell => [cell.arm,
    { ...structuredClone(shared), parallel_work: shared.parallel_work ?? false, ...(cell.launcher === "mekugi" ? { mekugi_flags: [...flags] } : {}) }])),
  Object.values(GUIDANCE_LAUNCHER_CELLS).map(cell => cell.arm));
  return { schema: "codex-ab.guidance-launcher-plan.v1", setup_commit: input.setup_commit, repetitions: input.repetitions,
    schedule, comparison: "custom", cells: structuredClone(GUIDANCE_LAUNCHER_CELLS), arms, arm_settings,
    intentional_differences: ["minimal versus pinned current instructions, skills and hooks", "direct Codex versus Codex through the pinned Mekugi launcher"] };
}

export function recordGuidanceLauncherExperiment(state: RunState, plan: GuidanceLauncherPlan): GuidanceLauncherExperiment {
  if (state.status !== "prepared" || state.results || state.arm_attempts || state.imported_arms || state.imported_control || state.planned_imports?.length)
    throw new Error("four-cell design requires a fresh prepared run");
  return describeGuidanceLauncherExperiment(state, plan);
}

function describeGuidanceLauncherExperiment(state: RunState, plan: GuidanceLauncherPlan): GuidanceLauncherExperiment {
  const keys = Object.values(GUIDANCE_LAUNCHER_CELLS).map(cell => cell.arm);
  if (state.comparison !== "custom" || JSON.stringify(state.arm_configurations) !== JSON.stringify(plan.arms)
    || JSON.stringify(Object.keys(state.arms)) !== JSON.stringify(keys)
    || keys.some(key => JSON.stringify(state.arm_settings?.[key]) !== JSON.stringify(plan.arm_settings[key]))) throw new Error("four-cell arm identities or controls changed");
  const controls = keys.map(arm => {
    const runtime = armRuntime(state, arm);
    return { model: runtime.execution.model, reasoning_effort: runtime.execution.reasoning_effort, service_tier: runtime.execution.service_tier,
      cpus: runtime.resource_limits.cpus, memory: runtime.resource_limits.memory, timeout_seconds: runtime.timeout_seconds,
      auto_compact_limit: runtime.auto_compact_limit ?? null, parallel_work: state.arm_settings?.[arm]?.parallel_work ?? false };
  });
  if (controls.some(item => JSON.stringify(item) !== JSON.stringify(controls[0]))) throw new Error("four-cell model, reasoning, resource or budget controls differ");
  const tools = state.runtime_tools;
  if (![state.task.sha256, tools.codex_sha256, tools.codex_code_mode_host_sha256, tools.mekugi_sha256,
    tools.mekugi_exec_sha256, tools.current_setup_files_sha256].every(value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value))
    || !/^[0-9a-f]{40}$/.test(state.source.base_commit) || !/^sha256:[0-9a-f]{64}$/.test(state.image_id ?? "")) throw new Error("four-cell task and runtime identities must be pinned");
  return { schema: "codex-ab.guidance-launcher-experiment.v1", plan: structuredClone(plan),
    task: { id: state.task_pack?.id ?? null, task_sha256: state.task.sha256, base_commit: state.source.base_commit, pack_sha256: state.task_pack?.sha256 ?? null },
    runtime: { codex_sha256: tools.codex_sha256, codex_code_mode_host_sha256: tools.codex_code_mode_host_sha256,
      mekugi_sha256: tools.mekugi_sha256!, mekugi_exec_sha256: tools.mekugi_exec_sha256!,
      tool_store_manifest_sha256: tools.current_setup_files_sha256, image_id: state.image_id ?? null },
    controls: controls[0]!, claim: "prepared design; no outcome or benchmark comparability established" };
}

export function verifyGuidanceLauncherExperiment(state: RunState): void {
  if (state.experiment && JSON.stringify(describeGuidanceLauncherExperiment(state, state.experiment.plan)) !== JSON.stringify(state.experiment))
    throw new Error("retained four-cell experiment identity changed");
}

export interface FactorialObservation extends Omit<PairedObservation, "baseline" | "treatment"> {
  cells: Record<FactorialCell, number | null>;
}

export function guidanceLauncherEffects(observations: FactorialObservation[], options: BootstrapOptions = {}) {
  const difference = (left: number | null, right: number | null) => left !== null && right !== null ? left - right : null;
  const contrast = (baseline: FactorialCell, treatment: FactorialCell) => pairedUncertaintyByCohort(observations.map(item => ({
    task_id: item.task_id, attempt_id: item.attempt_id, source: item.source, schedule: item.schedule,
    baseline: item.cells[baseline], treatment: item.cells[treatment],
  })), options);
  return { schema: "codex-ab.guidance-launcher-effects.v1", cells: GUIDANCE_LAUNCHER_CELLS,
    launcher_under_minimal_B_minus_A: contrast("A", "B"),
    guidance_under_direct_C_minus_A: contrast("A", "C"),
    launcher_under_current_D_minus_C: contrast("C", "D"),
    interaction_D_minus_C_minus_B_minus_A: pairedUncertaintyByCohort(observations.map(item => ({
      task_id: item.task_id, attempt_id: item.attempt_id, source: item.source, schedule: item.schedule,
      baseline: difference(item.cells.B, item.cells.A), treatment: difference(item.cells.D, item.cells.C),
    })), options),
    caveat: "The interaction is (D-C)-(B-A), with equal task weighting and matched attempt coverage. Preparation and descriptive estimates establish no causal or leaderboard claim." };
}
