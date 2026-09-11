import { copyFile, cp, mkdir, mkdtemp } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { gradeArm } from "./runner";
import { readState, sha256, withRunLock, writeState } from "./state";
import { buildReportUnlocked } from "./report";
import { collectBundle, finalizeBundle } from "./bundle";
import type { ArmName } from "./types";

export async function regradeRun(runDirectory: string, reason: string, docker = process.env.CODEX_AB_DOCKER_BIN ?? "docker"): Promise<void> {
  if (!reason.trim()) throw new Error("regrade requires a concrete infrastructure correction reason");
  const runDir = resolve(runDirectory);
  return withRunLock(runDir, async () => {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.on("SIGINT", cancel);
    process.on("SIGTERM", cancel);
    try {
      const state = await readState(runDir);
      const arms = state.selected_arms ?? [];
      if (state.status !== "complete" || !state.acceptance || !state.image_id || !arms.length ||
          arms.some(arm => !state.results?.[arm]?.grade || state.results[arm]!.collection_error || state.results[arm]!.lifecycle_error)) {
        throw new Error("regrade requires completed execution and captured candidates with grading evidence");
      }
      if (state.invalidity_reasons?.length) throw new Error("regrade cannot clear run-wide isolation or input invalidity");
      for (const control of [state.task, state.acceptance, { path: state.runtime_tools.bun, sha256: state.runtime_tools.bun_sha256 }]) {
        if (await sha256(join(runDir, control.path)) !== control.sha256) throw new Error(`regrade input changed: ${control.path}`);
      }
      const hashes: Partial<Record<ArmName, string>> = {};
      for (const arm of arms) {
        const hash = await sha256(join(runDir, state.results![arm]!.patch_path));
        if (hash !== await sha256(join(runDir, "reports/bundle", `${arm}-changes.patch`))) throw new Error(`${arm} patch differs from the captured report bundle`);
        hashes[arm] = hash;
      }
      const archive = await mkdtemp(join(runDir, "reports/regrade-"));
      await cp(join(runDir, "reports/bundle"), join(archive, "bundle"), { recursive: true, force: false, errorOnExist: true });
      await copyFile(join(runDir, "run.json"), join(archive, "run.json"));
      const evaluatorRoot = join(archive, "evaluator");
      await mkdir(evaluatorRoot);
      controller.signal.throwIfAborted();
      state.regrade = {
        status: "running", reason, started_at: new Date().toISOString(),
        archive_path: relative(runDir, archive), evaluator_root: relative(runDir, evaluatorRoot),
        patch_sha256: hashes, judge_stale: Boolean(state.judge),
      };
      state.status = "partial";
      delete state.error;
      for (const arm of arms) delete state.results![arm]!.grade;
      await writeState(runDir, state);
      let failure: unknown;
      try {
        process.stderr.write("[regrade] archived previous evaluation; grading unchanged candidates with no model inference\n");
        const outcomes = await Promise.allSettled(arms.map(async arm => {
          const result = state.results![arm]!;
          result.grade = await gradeArm(docker, runDir, state, arm, join(runDir, result.patch_path), controller.signal, join(evaluatorRoot, arm));
          if (result.grade?.evaluator_error) throw new Error(result.grade.evaluator_error);
          if (result.grade?.supplemental_infrastructure_error) throw new Error(result.grade.supplemental_infrastructure_error);
          if (await sha256(join(runDir, result.patch_path)) !== hashes[arm]) throw new Error(`${arm} captured patch changed during regrading`);
          process.stderr.write(`[regrade] ${arm}: required gates ${result.grade?.passed ? "passed" : "failed"}\n`);
        }));
        const rejected = outcomes.find(outcome => outcome.status === "rejected");
        if (rejected?.status === "rejected") throw rejected.reason;
        if (controller.signal.aborted) throw new Error("regrading canceled");
        state.status = "complete";
        state.regrade.status = "complete";
      } catch (error) {
        failure = error;
        state.regrade.status = "failed";
        state.regrade.error = String(error);
        state.error = String(error);
      } finally {
        try {
          state.regrade.finished_at = new Date().toISOString();
          await writeState(runDir, state);
          await buildReportUnlocked(runDir);
          await collectBundle(runDir);
          await finalizeBundle(runDir);
          if (controller.signal.aborted && !failure) throw new Error("regrading canceled during reporting");
        } catch (error) {
          failure ??= error;
          const latest = await readState(runDir);
          latest.status = "partial";
          latest.error = String(failure);
          if (latest.regrade) {
            latest.regrade.status = "failed";
            latest.regrade.error = String(failure);
          }
          await writeState(runDir, latest);
          try {
            await buildReportUnlocked(runDir);
            await collectBundle(runDir);
            await finalizeBundle(runDir);
          } catch (reportError) {
            process.stderr.write(`[regrade] could not finalize failure report: ${String(reportError)}\n`);
          }
        }
      }
      if (failure) throw failure;
    } finally {
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    }
  });
}
