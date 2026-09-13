import { cp, mkdtemp } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { runPairUnlocked, type RunOptions } from "./runner";
import { judgeRunUnlocked } from "./judge";
import { buildReportUnlocked } from "./report";
import { collectBundle, finalizeBundle } from "./bundle";
import { readState, withRunLock, writeState } from "./state";

/** The lock covers execution and finishing, including paid source assessment. */
async function executeBenchmarkUnlocked(options: RunOptions, mode: "run" | "finish"): Promise<void> {
  const runDir = resolve(options.runDir);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener("abort", cancel, { once: true });
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    const initial = await readState(runDir);
    if (mode === "run" && (initial.status !== "prepared" || initial.finishing)) throw new Error("prepare a new run instead of resuming or restarting it");
    if (mode === "finish") {
      if (initial.status !== "complete" || initial.finishing?.status !== "failed") throw new Error("finish requires complete execution with failed finishing");
      if (initial.judge && initial.judge.status !== "complete") throw new Error("a started judge attempt cannot be resumed or retried");
      const archive = join(await mkdtemp(join(runDir, "reports/finishing-attempt-")), "bundle");
      await cp(join(runDir, "reports/bundle"), archive, { recursive: true, force: false, errorOnExist: true });
      initial.finishing_history ??= [];
      initial.finishing_history.push({ ...initial.finishing, bundle_path: relative(runDir, archive) });
      await writeState(runDir, initial);
    }

    let failure: unknown;
    try {
      if (mode === "run") await runPairUnlocked({ ...options, signal: controller.signal });
    } catch (error) {
      failure = error;
    }
    const state = await readState(runDir);
    if (state.status !== "complete") failure ??= new Error(state.error ?? "benchmark execution incomplete");
    state.finishing = { status: "running", started_at: new Date().toISOString(), bundle_path: "reports/bundle" };
    await writeState(runDir, state);
    try {
      if (!failure && !controller.signal.aborted && state.status === "complete" && state.selected_arms?.length === 2 && !state.judge) {
        process.stderr.write("[finish] starting independent reversed-order source assessment\n");
        await judgeRunUnlocked(runDir, options.authFile, options.dockerBin, controller.signal);
      }
    } catch (error) {
      failure ??= error;
    }
    try {
      process.stderr.write("[finish] metering root and child usage; generating report and interaction audit\n");
      await buildReportUnlocked(runDir);
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
      await buildReportUnlocked(runDir);
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
        await buildReportUnlocked(runDir);
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

export function finishBenchmark(options: RunOptions): Promise<void> {
  return withRunLock(resolve(options.runDir), () => executeBenchmarkUnlocked(options, "finish"));
}
