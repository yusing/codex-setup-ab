import { CODEX_MODELS, REASONING_EFFORTS, type ArmSettings, type RunState } from "./types";
import { validateMekugiFlags, usesMekugi } from "./mekugi";

const fields = new Set(["model", "reasoning_effort", "cpus", "memory", "timeout_seconds", "auto_compact_limit", "parallel_work", "mekugi_flags", "skills"]);

export function parseArmSettings(value: unknown, keys: string[]): Record<string, ArmSettings> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Arm settings must be an object keyed by arm");
  return Object.fromEntries(Object.entries(value).map(([arm, settings]) => {
    if (!keys.includes(arm) || !settings || typeof settings !== "object" || Array.isArray(settings)
      || Object.keys(settings).some(key => !fields.has(key))) throw new Error(`Invalid settings for arm ${arm}`);
    const s = settings as Record<string, unknown>;
    if (s.model !== undefined && (typeof s.model !== "string" || ![...CODEX_MODELS.map(item => item.id), "grok:grok-4.7"].includes(s.model))) throw new Error(`Unsupported model for ${arm}`);
    if (s.reasoning_effort !== undefined && !REASONING_EFFORTS.some(value => value === s.reasoning_effort)) throw new Error(`Invalid reasoning effort for ${arm}`);
    if (s.cpus !== undefined && (typeof s.cpus !== "string" || !Number.isFinite(Number(s.cpus)) || Number(s.cpus) <= 0)) throw new Error(`Invalid CPU limit for ${arm}`);
    if (s.memory !== undefined && (typeof s.memory !== "string" || !/^[1-9]\d*(?:[bkmg])?$/i.test(s.memory))) throw new Error(`Invalid memory limit for ${arm}`);
    for (const key of ["timeout_seconds", "auto_compact_limit"]) if (s[key] !== undefined && (typeof s[key] !== "number" || !Number.isSafeInteger(s[key]) || Number(s[key]) < 1)) throw new Error(`Invalid ${key} for ${arm}`);
    if (s.parallel_work !== undefined && typeof s.parallel_work !== "boolean") throw new Error(`Invalid parallel work setting for ${arm}`);
    if (s.mekugi_flags !== undefined) validateMekugiFlags(s.mekugi_flags);
    if (s.skills !== undefined && (!s.skills || typeof s.skills !== "object" || Array.isArray(s.skills)
      || Object.entries(s.skills).some(([name, enabled]) => !name.trim() || typeof enabled !== "boolean"))) throw new Error(`Invalid skills for ${arm}`);
    return [arm, s as ArmSettings];
  }));
}

export function validateArmSettings(state: Pick<RunState, "arms" | "comparison" | "execution" | "arm_settings">): void {
  const settings = parseArmSettings(state.arm_settings ?? {}, Object.keys(state.arms));
  for (const [arm, value] of Object.entries(settings)) {
    if (value.mekugi_flags?.length && !usesMekugi(state, arm)) throw new Error(`Mekugi flags require the Mekugi launcher in ${arm}`);
    if (value.model && (state.comparison === "codex-mekugi-grok") !== (value.model === "grok:grok-4.7")) throw new Error(`Model does not match the launcher in ${arm}`);
    if (state.comparison === "duplicate-output" && value.mekugi_flags?.some(flag => /^--deduplicate-output(?:=|$)/.test(flag))) throw new Error("The duplicate-output comparison owns its treatment flag");
  }
}

/** Legacy controls are defaults; explicit arm settings belong only to that candidate. */
export function armRuntime(state: RunState, arm: string): RunState {
  const s = state.arm_settings?.[arm];
  if (!s) return state;
  return { ...state,
    execution: { ...state.execution, model: s.model ?? state.execution.model, reasoning_effort: s.reasoning_effort ?? state.execution.reasoning_effort },
    resource_limits: { cpus: s.cpus ?? state.resource_limits.cpus, memory: s.memory ?? state.resource_limits.memory },
    timeout_seconds: s.timeout_seconds ?? state.timeout_seconds,
    auto_compact_limit: s.auto_compact_limit ?? state.auto_compact_limit,
  };
}

export function parallelWorkTask(task: string): string {
  return task + "\n\n## Parallel work\n\nUse delegates for independent work in parallel. Keep coupled work together and avoid overlapping edits. Give delegates the relevant requirements and context; each owns implementation and focused validation. Coordinate dependencies, integrate results, and validate the complete result.\n";
}
