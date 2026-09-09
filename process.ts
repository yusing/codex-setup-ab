import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  stdoutFile?: string;
  stderrFile?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ExecResult { exitCode: number; stdout: string; stderr: string; timedOut: boolean; canceled: boolean; elapsedMs: number }

export async function exec(argv: string[], options: ExecOptions = {}): Promise<ExecResult> {
  const started = performance.now();
  if (options.stdoutFile) await mkdir(dirname(options.stdoutFile), { recursive: true });
  if (options.stderrFile) await mkdir(dirname(options.stderrFile), { recursive: true });
  // The final check belongs immediately beside process creation. In particular,
  // an abort during async output preparation must not launch a paid container.
  if (options.signal?.aborted) {
    return { exitCode: -1, stdout: "", stderr: "canceled before process spawn", timedOut: false, canceled: true, elapsedMs: Math.round(performance.now() - started) };
  }
  const out = options.stdoutFile ? Bun.file(options.stdoutFile) : undefined;
  const err = options.stderrFile ? Bun.file(options.stderrFile) : undefined;
  const child = Bun.spawn(argv, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
    stdout: out ?? "pipe",
    stderr: err ?? "pipe",
  });
  let timedOut = false;
  let canceled = options.signal?.aborted === true;
  let abortEscalation: ReturnType<typeof setTimeout> | undefined;
  const abort = () => {
    canceled = true;
    child.kill("SIGTERM");
    abortEscalation = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 1_000);
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (canceled) abort();
  const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 10_000);
  }, options.timeoutMs);
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    out ? Promise.resolve("") : new Response(child.stdout as ReadableStream<Uint8Array>).text(),
    err ? Promise.resolve("") : new Response(child.stderr as ReadableStream<Uint8Array>).text(),
  ]);
  if (timer) clearTimeout(timer);
  if (abortEscalation) clearTimeout(abortEscalation);
  options.signal?.removeEventListener("abort", abort);
  return { exitCode, stdout, stderr, timedOut, canceled, elapsedMs: Math.round(performance.now() - started) };
}

export async function checked(argv: string[], options: ExecOptions = {}): Promise<ExecResult> {
  const result = await exec(argv, options);
  if (result.exitCode !== 0) throw new Error(`${argv.join(" ")} failed (${result.exitCode}): ${result.stderr.trim()}`);
  return result;
}
