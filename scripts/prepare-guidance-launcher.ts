#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildGuidanceLauncherPlan, recordGuidanceLauncherExperiment } from "../factorial";
import { prepare, type PrepareOptions } from "../prepare";
import { preflightRun } from "../runner";
import { readState, withRunLock, writeState } from "../state";
import { prepareTrials } from "../trials";
import type { ArmSettings } from "../types";

/** A model-free preparation entry point; execution still uses run-trials' consent gate. */
export async function prepareGuidanceLauncher(input: {
  setup_commit: string; shared_settings: ArmSettings; repetitions: number;
  schedule?: "concurrent" | "alternating"; mekugi_flags?: string[]; docker_bin?: string;
  common: Omit<PrepareOptions, "comparison" | "arms" | "armSettings" | "setupACommit" | "setupBCommit" | "reviewTreatment" | "protectMekugi">;
}): Promise<{ prototype: string; trial_set: string }> {
  const plan = buildGuidanceLauncherPlan(input);
  if (!input.common || ["comparison", "arms", "armSettings", "setupACommit", "setupBCommit", "reviewTreatment", "protectMekugi"].some(key => key in input.common))
    throw new Error("four-cell helper owns comparison composition and forbids asymmetric treatments");
  const shared = plan.arm_settings.stock!;
  const prototype = await prepare({ ...input.common, comparison: "custom", arms: plan.arms, armSettings: plan.arm_settings,
    model: shared.model, reasoningEffort: shared.reasoning_effort, cpus: shared.cpus!, memory: shared.memory!,
    timeoutSeconds: shared.timeout_seconds!, autoCompactLimit: shared.auto_compact_limit,
    // Per-arm settings add the shared delegation instruction once, after the task is frozen.
    parallelWork: false });
  // Pin the actual built image and task dependencies before recording the design.
  await preflightRun(prototype, input.docker_bin);
  await withRunLock(prototype, async () => {
    const state = await readState(prototype);
    state.experiment = recordGuidanceLauncherExperiment(state, plan);
    await writeState(prototype, state);
  });
  const trial_set = await prepareTrials({ runDir: prototype, count: plan.repetitions, schedule: plan.schedule,
    outputParent: input.common.outputParent, dockerBin: input.docker_bin });
  return { prototype, trial_set };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] === "--help") {
    process.stdout.write("Usage: bun scripts/prepare-guidance-launcher.ts CONFIG.json\nPrepares four matched cells and fresh repeats without inference. See doc/guidance-launcher.md.\n");
    if (args[0] !== "--help") process.exitCode = 2;
  } else {
    try { process.stdout.write(`${JSON.stringify(await prepareGuidanceLauncher(JSON.parse(await readFile(resolve(args[0]!), "utf8"))), null, 2)}\n`); }
    catch (error) { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; }
  }
}
