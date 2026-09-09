#!/usr/bin/env bun
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { prepare } from "./prepare";
import { preflightRun, runPair } from "./runner";
import { judgeRun } from "./judge";
import { buildReport, invalidateRun } from "./report";

export const VERSION = "0.1.1";
const DEFAULT_BASE = "bb9e740362fd86c9214f5c893c65ae6c46587a60";
const DEFAULT_FORBIDDEN = "d50b9e6d7a2b01fc033a8aab523791876e4441b5";

const HELP = `codex-ab ${VERSION}

Prepare, run, grade, blindly judge, and report one isolated stock-versus-current Codex pair.

Usage:
  codex-ab prepare [options]
  codex-ab preflight --run-dir DIR [--docker-bin FILE]
  codex-ab run --run-dir DIR --confirm-paid-inference [options]
  codex-ab judge --run-dir DIR --confirm-paid-inference [options]
  codex-ab report --run-dir DIR
  codex-ab invalidate --run-dir DIR --reason TEXT

Prepare options:
  --source DIR          source Git repository (default /home/ubuntu/projects/hpatch)
  --base SHA            exact shallow base commit
  --forbidden SHA       future/oracle commit that arms must not contain
  --task FILE           task prompt (default ./task.md)
  --acceptance FILE     evaluator-only Go test (default ./acceptance_test.go)
  --output-parent DIR   parent for mktemp run directory (default system temp)
  --current-home DIR    configuration Git repository root (default current home)
  --codex-bin FILE      standalone Codex 0.153.4 used to build the image
  --image NAME          prebuilt bare-Codex image (default codex-ab:0.1.0)
  --timeout SECONDS     per agent and judge pass (default 1800)
  --cpus COUNT          identical per-container CPU limit (default 2)
  --memory LIMIT        identical per-container memory limit (default 4g)

Run/judge options:
  --auth-file FILE      auth copied privately into isolated homes
  --docker-bin FILE     Docker-compatible fixture or executable
  --arm current         run only the current-setup arm (run only; default is both)

Started or finished attempts are never resumed or restarted; prepare a new experiment to rerun. Run and judge require the explicit model-execution confirmation flag.
`;

function options(args: string[]): Record<string, string | boolean> {
  const parsed: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const item = args[i];
    if (!item.startsWith("--")) throw new Error(`unexpected argument: ${item}`);
    const key = item.slice(2);
    if (key === "confirm-paid-inference") { parsed[key] = true; continue; }
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`${item} requires a value`);
    parsed[key] = value;
  }
  return parsed;
}

function string(o: Record<string, string | boolean>, key: string, fallback?: string): string {
  const value = o[key] ?? fallback;
  if (typeof value !== "string") throw new Error(`--${key} is required`);
  return value;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") { process.stdout.write(HELP); return 0; }
  if (argv[0] === "--version" || argv[0] === "-V") { process.stdout.write(`${VERSION}\n`); return 0; }
  const command = argv[0];
  const o = options(argv.slice(1));
  if (command === "prepare") {
    const timeout = Number(string(o, "timeout", "1800"));
    if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new Error("--timeout must be a positive integer");
    const runDir = await prepare({
      source: string(o, "source", "/home/ubuntu/projects/hpatch"), baseCommit: string(o, "base", DEFAULT_BASE),
      forbiddenCommit: string(o, "forbidden", DEFAULT_FORBIDDEN), taskPath: string(o, "task", resolve("task.md")),
      acceptancePath: string(o, "acceptance", resolve("acceptance_test.go")), outputParent: o["output-parent"] as string | undefined,
      currentHome: string(o, "current-home", homedir()), image: string(o, "image", "codex-ab:0.1.0"),
      cpus: string(o, "cpus", "2"), memory: string(o, "memory", "4g"), timeoutSeconds: timeout,
      codexBinary: string(o, "codex-bin", join(homedir(), ".local/bin/codex")),
    });
    process.stdout.write(`${runDir}\n`);
    return 0;
  }
  if (command === "run" || command === "judge") {
    if (o["confirm-paid-inference"] !== true) throw new Error(`${command} launches model inference; pass --confirm-paid-inference to confirm intentional execution`);
    const runDir = string(o, "run-dir");
    const auth = string(o, "auth-file", join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json"));
    if (command === "run") {
      const arm = o.arm;
      if (arm !== undefined && arm !== "current") throw new Error("--arm currently supports only current");
      await runPair({ runDir, authFile: auth, dockerBin: o["docker-bin"] as string | undefined, arm });
    }
    else await judgeRun(runDir, auth, o["docker-bin"] as string | undefined);
    process.stdout.write(`${resolve(runDir)}\n`);
    return 0;
  }
  if (command === "preflight") {
    await preflightRun(string(o, "run-dir"), o["docker-bin"] as string | undefined);
    process.stdout.write(`${resolve(string(o, "run-dir"))}\n`);
    return 0;
  }
  if (command === "report") {
    const result = await buildReport(string(o, "run-dir"));
    process.stdout.write(`${result.markdownPath}\n${result.jsonPath}\n`);
    return 0;
  }
  if (command === "invalidate") {
    const runDir = string(o, "run-dir");
    await invalidateRun(runDir, [string(o, "reason")]);
    process.stdout.write(`${resolve(runDir)}\n`);
    return 0;
  }
  throw new Error(`unknown command: ${command}`);
}

if (import.meta.main) {
  main().then(code => process.exit(code)).catch(error => { process.stderr.write(`codex-ab: ${error instanceof Error ? error.message : String(error)}\n`); process.exit(1); });
}
