import { expect, test } from "bun:test";
import { buildGuidanceLauncherPlan, guidanceLauncherEffects, recordGuidanceLauncherExperiment, verifyGuidanceLauncherExperiment, type FactorialObservation } from "./factorial";
import { prepareGuidanceLauncher } from "./scripts/prepare-guidance-launcher";
import type { RunState } from "./types";

function plan() {
  return buildGuidanceLauncherPlan({ setup_commit: "a".repeat(40), repetitions: 4, schedule: "alternating",
    shared_settings: { model: "gpt-6-astra", reasoning_effort: "medium", cpus: "2", memory: "4g", timeout_seconds: 900, auto_compact_limit: 200000 } });
}
function prepared(): RunState {
  const p = plan();
  return { status: "prepared", comparison: "custom", arm_configurations: p.arms, arm_settings: p.arm_settings,
    arms: Object.fromEntries(Object.values(p.cells).map(cell => [cell.arm, { repository: `/workspace/${cell.arm}`, home_template: `/home/${cell.arm}`, launcher: cell.launcher }])),
    source: { base_commit: "b".repeat(40) }, task: { sha256: "c".repeat(64) }, task_pack: { id: "task", sha256: "d".repeat(64) },
    image_id: `sha256:${"1".repeat(64)}`,
    execution: { model: "gpt-6-astra", reasoning_effort: "medium", service_tier: "default" },
    resource_limits: { cpus: "2", memory: "4g" }, timeout_seconds: 900,
    runtime_tools: { codex_sha256: "e".repeat(64), codex_code_mode_host_sha256: "f".repeat(64), mekugi_sha256: "0".repeat(64),
      mekugi_exec_sha256: "1".repeat(64), current_setup_files_sha256: "2".repeat(64) },
  } as RunState;
}

test("four-cell plan pins two guidance levels and shares model, reasoning, resources and budgets", () => {
  const p = plan();
  expect(p.arms).toEqual([{ launcher: "codex", setup_commit: "stock" }, { launcher: "mekugi", setup_commit: "stock" },
    { launcher: "codex", setup_commit: "a".repeat(40) }, { launcher: "mekugi", setup_commit: "a".repeat(40) }]);
  expect(p.arm_settings.current).toEqual(p.arm_settings["arm-4"]);
  expect(p.arm_settings.stock).toEqual(p.arm_settings["arm-3"]);
  p.arm_settings.stock.cpus = "7";
  expect(p.arm_settings["arm-3"].cpus).toBe("2");
});

test("recorded experiment includes task/runtime identities and rejects historical or unequal controls", () => {
  expect(recordGuidanceLauncherExperiment(prepared(), plan())).toMatchObject({ schema: "codex-ab.guidance-launcher-experiment.v1",
    task: { id: "task", base_commit: "b".repeat(40) }, controls: { timeout_seconds: 900, model: "gpt-6-astra" } });
  const changed = prepared();
  changed.arm_settings!["arm-4"].timeout_seconds = 901;
  expect(() => recordGuidanceLauncherExperiment(changed, plan())).toThrow("identities or controls changed");
  const imported = prepared(); imported.imported_arms = {};
  expect(() => recordGuidanceLauncherExperiment(imported, plan())).toThrow("fresh prepared run");
  const unpinned = prepared(); unpinned.runtime_tools.mekugi_sha256 = undefined;
  expect(() => recordGuidanceLauncherExperiment(unpinned, plan())).toThrow("identities must be pinned");
  const retained = prepared(); retained.experiment = recordGuidanceLauncherExperiment(retained, plan());
  retained.status = "complete";
  expect(() => verifyGuidanceLauncherExperiment(retained)).not.toThrow();
  retained.task.sha256 = "9".repeat(64);
  expect(() => verifyGuidanceLauncherExperiment(retained)).toThrow("identity changed");
});

test("four-cell preparation validates plan before filesystem, Docker or inference work", async () => {
  const input = { setup_commit: "HEAD", repetitions: 4, shared_settings: plan().arm_settings.stock, common: {} as never };
  await expect(prepareGuidanceLauncher(input)).rejects.toThrow("pinned full setup commit");
  expect(() => buildGuidanceLauncherPlan({ ...input, setup_commit: "a".repeat(40), repetitions: 1 })).toThrow("fresh repeated runs");
  expect(() => buildGuidanceLauncherPlan({ ...input, setup_commit: "a".repeat(40), shared_settings: { ...input.shared_settings, skills: { custom: false } } })).toThrow("guidance skills remain");
});

test("launcher contrasts and interaction use matched repeats within equal-weight tasks", () => {
  const values: FactorialObservation[] = [
    { task_id: "one", attempt_id: "1", source: "fresh", schedule: "alternating", cells: { A: 10, B: 12, C: 20, D: 25 } },
    { task_id: "two", attempt_id: "1", source: "fresh", schedule: "alternating", cells: { A: 20, B: 21, C: 10, D: 16 } },
    { task_id: "two", attempt_id: "2", source: "fresh", schedule: "alternating", cells: { A: 20, B: 21, C: 10, D: 16 } },
  ];
  const effects = guidanceLauncherEffects(values);
  expect(effects.launcher_under_minimal_B_minus_A[0].mean_difference).toBe(1.5);
  expect(effects.guidance_under_direct_C_minus_A[0].mean_difference).toBe(0);
  expect(effects.launcher_under_current_D_minus_C[0].mean_difference).toBe(5.5);
  expect(effects.interaction_D_minus_C_minus_B_minus_A[0]).toMatchObject({ mean_difference: 4, matched_tasks: 2, matched_pairs: 3 });
  const partial = guidanceLauncherEffects([{ ...values[0], cells: { ...values[0].cells, D: null } }]);
  expect(partial.launcher_under_minimal_B_minus_A[0].matched_pairs).toBe(1);
  expect(partial.interaction_D_minus_C_minus_B_minus_A[0].matched_pairs).toBe(0);
  expect(partial.interaction_D_minus_C_minus_B_minus_A[0].mean_difference).toBeNull();
});
