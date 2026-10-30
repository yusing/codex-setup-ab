import { armNames } from "./types";
import { cp, mkdtemp } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { gradeArm, runPairUnlocked, type RunOptions } from "./runner";
import { importArms } from "./control";
import { prepareReevaluation } from "./reevaluate";
import { assertRecoverableJudge, judgeRunUnlocked } from "./judge";
import { prepareReportUnlocked } from "./report";
import { collectBundle, finalizeBundle } from "./bundle";
import { armExecutionSucceeded, readState, withRunLock, writeState } from "./state";

/** The lock covers execution and finishing, including paid source assessment. */
async function executeBenchmarkUnlocked(options: RunOptions & { recoverJudge?: boolean }, mode: "run" | "finish" | "reevaluate"): Promise<void> {
  const runDir = resolve(options.runDir);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener("abort", cancel, { once: true });
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    const initial = await readState(runDir);
    if (mode !== "finish" && (initial.status !== "prepared" || initial.finishing)) throw new Error("prepare a new run instead of resuming or restarting it");
    if (mode === "finish") {
      if (initial.status !== "complete" || initial.finishing?.status !== "failed"
        || !(initial.selected_arms ?? armNames(initial)).every(arm => armExecutionSucceeded(initial.results?.[arm]))) throw new Error("finish requires complete execution with failed finishing");
      if (options.recoverJudge && initial.judge?.status !== "failed") throw new Error("judge recovery requires a failed judge attempt");
      if (options.recoverJudge) await assertRecoverableJudge(runDir, initial);
      if (initial.judge && initial.judge.status !== "complete") {
        if ((initial.judge.attempts?.length ?? 0) > 0 && !options.recoverJudge) throw new Error("a started judge attempt cannot be resumed or retried without --recover-judge");
        if (!options.recoverJudge) delete initial.judge;
      }
      const archive = join(await mkdtemp(join(runDir, "reports/finishing-attempt-")), "bundle");
      await cp(join(runDir, "reports/bundle"), archive, { recursive: true, force: false, verbatimSymlinks: true });
      initial.finishing_history ??= [];
      initial.finishing_history.push({ ...initial.finishing, bundle_path: relative(runDir, archive) });
      await writeState(runDir, initial);
    }

    let failure: unknown;
    try {
      if (mode === "run") await runPairUnlocked({ ...options, signal: controller.signal });
      if (mode === "reevaluate") {
        try {
          initial.results = await importArms(runDir, initial, initial.planned_imports ?? [], "reevaluation");
          initial.selected_arms = armNames(initial);
          initial.status = "running";
          await writeState(runDir, initial);
          const docker = options.dockerBin ?? process.env.CODEX_AB_DOCKER_BIN ?? "docker";
          for (const arm of initial.selected_arms) {
            if (controller.signal.aborted) throw new Error("reevaluation canceled; available evidence preserved");
            const result = initial.results[arm]!;
            process.stderr.write(`[reevaluate] materializing retained candidate ${arm} for fresh evaluator tests and source assessment\n`);
            result.grade = await gradeArm(docker, runDir, initial, arm, join(runDir, result.patch_path), controller.signal);
            await writeState(runDir, initial);
          }
          initial.status = "complete";
          await writeState(runDir, initial);
        } catch (error) {
          initial.status = "partial";
          initial.error = String(error);
          await writeState(runDir, initial);
          throw error;
        }
      }
    } catch (error) {
      failure = error;
    }
    const state = await readState(runDir);
    if (state.status !== "complete" || !(state.selected_arms ?? armNames(state)).every(arm => armExecutionSucceeded(state.results?.[arm]))) {
      failure ??= new Error(state.error ?? "benchmark execution incomplete");
    }
    state.finishing = { status: "running", started_at: new Date().toISOString(), bundle_path: "reports/bundle" };
    await writeState(runDir, state);
    try {
      if (!failure && !controller.signal.aborted && state.status === "complete" && (state.selected_arms?.length ?? 0) >= 2 && (!state.judge || options.recoverJudge)) {
        process.stderr.write(options.recoverJudge
          ? "[finish] revalidating completed judge stages and continuing incomplete ones\n"
          : state.evaluation?.mode === "reuse" ? "[finish] retaining imported evaluations; adapting historical tests and assessing fresh candidates\n"
          : "[finish] starting independent reversed-order source assessment passes in parallel\n");
        await judgeRunUnlocked(runDir, options.authFile, options.dockerBin, controller.signal, options.recoverJudge);
      }
    } catch (error) {
      failure ??= error;
    }
    let renderReport: Awaited<ReturnType<typeof prepareReportUnlocked>> | undefined;
    const refreshReport = async () => {
      renderReport ??= await prepareReportUnlocked(runDir);
      await renderReport();
    };
    try {
      process.stderr.write("[finish] metering root and child usage; generating report and interaction audit\n");
      await refreshReport();
      await collectBundle(runDir);
    } catch (error) {
      failure ??= error;
    }
    if (controller.signal.aborted) failure ??= new Error("benchmark canceled; available evidence preserved");
    const current = await readState(runDir);
    current.finishing = {
      ...state.finishing, status: failure ? "failed" : "complete",
      finished_at: new Date().toISOString(), ...(failure ? { error: String(failure) } : {}),
    };
    await writeState(runDir, current);
    try {
      await refreshReport();
      await finalizeBundle(runDir);
      if (controller.signal.aborted && !failure) throw new Error("benchmark canceled during finalization");
    } catch (error) {
      failure ??= error;
      current.finishing.status = "failed";
      current.finishing.error = String(failure);
      await writeState(runDir, current);
      // A storage failure can make even the failure bundle unavailable.
      // Keep the authoritative state failed; never restart model execution.
      try {
        await refreshReport();
        await finalizeBundle(runDir);
      } catch (finalError) {
        process.stderr.write(`[finish] unable to finalize failure bundle: ${String(finalError)}\n`);
      }
    }
    if (failure) throw failure;
    process.stderr.write(`[finish] evidence bundle: ${runDir}/reports/bundle\n`);
  } finally {
    options.signal?.removeEventListener("abort", cancel);
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

export function runBenchmarkUnlocked(options: RunOptions): Promise<void> {
  return executeBenchmarkUnlocked(options, "run");
}

export function runBenchmark(options: RunOptions): Promise<void> {
  return withRunLock(resolve(options.runDir), () => runBenchmarkUnlocked(options));
}

export function finishBenchmark(options: RunOptions & { recoverJudge?: boolean }): Promise<void> {
  return withRunLock(resolve(options.runDir), () => executeBenchmarkUnlocked(options, "finish"));
}

export async function reevaluateBenchmark(options: { runDir: string; outputParent?: string; authFile: string; dockerBin?: string; signal?: AbortSignal }): Promise<string> {
  const directory = await prepareReevaluation(options.runDir, options.outputParent);
  process.stderr.write(`[reevaluate] independent comparison ${directory}; implementation execution skipped\n`);
  try {
    await withRunLock(directory, () => executeBenchmarkUnlocked({ ...options, runDir: directory }, "reevaluate"));
  } catch (error) {
    throw new Error(`reevaluation failed; retained ${directory}: ${String(error)}`);
  }
  return directory;
}
