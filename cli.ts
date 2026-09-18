#!/usr/bin/env bun
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { validateMekugiFlags } from "./mekugi";
import { buildMekugi } from "./provenance";
import { prepareTrials, reportTrials, runTrials } from "./trials";
import { prepare } from "./prepare";
import { preflightRun } from "./runner";
import { remeterRun } from "./remeter";
import { finishBenchmark, runBenchmark } from "./workflow";
import { judgeRun } from "./judge";
import { buildReport, invalidateRun } from "./report";

export const VERSION = "0.1.1";
const DEFAULT_BASE = "bb9e740362fd86c9214f5c893c65ae6c46587a60";
const DEFAULT_FORBIDDEN = "d50b9e6d7a2b01fc033a8aab523791876e4441b5";

const HELP = `codex-ab ${VERSION}

Prepare, run, grade, blindly judge, and report isolated Codex pairs or a pinned trial set.

Usage:
  codex-ab build-mekugi --source DIR --image NAME [--output-parent DIR] [--docker-bin FILE]
  codex-ab prepare [options]
  codex-ab prepare-trials --run-dir DIR --count N [--order concurrent|alternating] [--output-parent DIR] [--docker-bin FILE]
  codex-ab run-trials --trial-set DIR --confirm-paid-inference [--auth-file FILE] [--docker-bin FILE]
  codex-ab report-trials --trial-set DIR
  codex-ab preflight --run-dir DIR [--docker-bin FILE]
  codex-ab run --run-dir DIR --confirm-paid-inference [options]
  codex-ab finish --run-dir DIR --confirm-paid-inference [options]
  codex-ab judge --run-dir DIR --confirm-paid-inference [options]
  codex-ab remeter --run-dir DIR --exclusions FILE
  codex-ab report --run-dir DIR [--output-dir DIR]
  codex-ab invalidate --run-dir DIR --reason TEXT

Prepare options:
  --profile NAME        mekugi (default), godoxy-icons, skills-mgr-bundle, or task
  --reasoning-effort N   medium (default) or xhigh
  --source DIR          source Git repository (default /home/ubuntu/projects/mekugi)
  --base SHA            exact shallow base commit
  --forbidden SHA       future/oracle commit that arms must not contain
  --task FILE           task prompt (default ./task.md)
  --task-pack FILE      portable pinned manifest; requires --source; owns task/base/criteria
  --criteria FILE       predetermined behavioral contract; defaults to task profile
  --output-parent DIR   parent for mktemp run directory (default system temp)
  --current-home DIR    configuration Git repository root (default current home)
  --review-treatment DIR  four-file reviewer overlay applied only to the current snapshot
  --comparison NAME    stock-current (default), same-setup, stock-mekugi, or codex-mekugi-grok
  --mekugi-flags JSON   explicit Mekugi --flag=value array, before codex
  --protect-mekugi      protect B's capture/runtime; A retains direct provider networking
  --mekugi-build DIR    captured build bundle; selects its matching binaries and source
  --mekugi-source DIR   matching Mekugi source for its capture validator
  --current-launcher N  codex (default; same-setup uses mekugi) or mekugi
  --mekugi-bin FILE     Mekugi executable used by --current-launcher mekugi
  --grok-bin FILE       Grok executable used by --comparison codex-mekugi-grok
  --mekugi-shell-bin FILE  matching shell helper (default shell beside Mekugi)
  --bun-bin FILE        Bun 1.4+ executable copied for isolated preparation
  --codex-bin FILE      standalone Codex executable used to build the image
  --image NAME          prebuilt bare-Codex image (default codex-ab:0.1.0)
  --timeout SECONDS     per agent and judge launch (default 1800)
  --cpus COUNT          identical per-container CPU limit (default 2)
  --memory LIMIT        identical per-container memory limit (default 4g)

Run/judge options (run includes automatic source assessment and reporting):
  --grok-auth-file FILE Grok OAuth store copied privately into isolated homes
  --auth-file FILE      auth copied privately into isolated homes
  --docker-bin FILE     Docker-compatible fixture or executable
  --arm NAME            run only stock or current (run only; default is both)

Report options:
  --output-dir DIR      export outside the source run without changing its reports or state
  --source-assessments FILE  include recorded supplemental assessments inline; never reruns judging

Started or finished commands are never resumed or restarted; prepare a new experiment to rerun.
Within an active judge command, Sol capacity errors retry twice (5s, 15s), preserving all attempts.
Test execution and accounting are programmatic; semantic harness authors and source judges use additional model calls.
Run and judge require the explicit model-execution confirmation flag.
`;

function options(command: string, args: string[]): Record<string, string | boolean> {
  const allowed: Record<string, string[]> = {
    "build-mekugi": ["source", "image", "output-parent", "docker-bin"],
    prepare: ["profile", "reasoning-effort", "source", "base", "forbidden", "task", "criteria", "task-pack", "output-parent", "current-home", "review-treatment", "comparison", "mekugi-flags", "mekugi-source", "mekugi-build", "protect-mekugi", "current-launcher", "mekugi-bin", "mekugi-shell-bin", "grok-bin", "codex-bin", "bun-bin", "image", "timeout", "cpus", "memory"],
    "prepare-trials": ["run-dir", "count", "order", "output-parent", "docker-bin"],
    "run-trials": ["trial-set", "auth-file", "grok-auth-file", "docker-bin", "confirm-paid-inference"],
    "report-trials": ["trial-set"],
    preflight: ["run-dir", "docker-bin"],
    run: ["run-dir", "auth-file", "grok-auth-file", "docker-bin", "arm", "confirm-paid-inference"],
    finish: ["run-dir", "auth-file", "docker-bin", "confirm-paid-inference"],
    judge: ["run-dir", "auth-file", "docker-bin", "confirm-paid-inference"],
    remeter: ["run-dir", "exclusions"],
    report: ["run-dir", "output-dir", "source-assessments"],
    invalidate: ["run-dir", "reason"],
  };
  if (!Object.hasOwn(allowed, command)) throw new Error(`unknown command: ${command}`);
  const parsed: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const item = args[i];
    if (!item.startsWith("--")) throw new Error(`unexpected argument: ${item}`);
    const key = item.slice(2);
    if (!allowed[command].includes(key)) throw new Error(`unknown option for ${command}: ${item}`);
    if (Object.hasOwn(parsed, key)) throw new Error(`duplicate option: ${item}`);
    if (key === "confirm-paid-inference" || key === "protect-mekugi") { parsed[key] = true; continue; }
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

export function parseMekugiFlags(value: string): string[] {
  return validateMekugiFlags(JSON.parse(value));
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") { process.stdout.write(HELP); return 0; }
  if (argv[0] === "--version" || argv[0] === "-V") { process.stdout.write(`${VERSION}\n`); return 0; }
  const command = argv[0];
  const o = options(command, argv.slice(1));
  if (command === "build-mekugi") {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
    try {
      process.stdout.write(`${await buildMekugi({ source: string(o, "source"), image: string(o, "image"),
        outputParent: o["output-parent"] as string | undefined, docker: o["docker-bin"] as string | undefined, signal: controller.signal })}\n`);
      return 0;
    } finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
  }
  if (command === "prepare") {
    if (o.profile === "skills-mgr-bundle" && ["source", "base", "forbidden", "task", "criteria"].some(key => typeof o[key] !== "string")) {
      throw new Error("skills-mgr-bundle requires explicit --source, --base, --forbidden, --task, and --criteria");
    }
    if (o["task-pack"] && (typeof o.source !== "string" ||
        ["base", "forbidden", "task", "criteria", "profile"].some(key => o[key] !== undefined))) {
      throw new Error("--task-pack requires --source and cannot override its base, forbidden, task, criteria, or profile");
    }
    if (o["mekugi-build"] && ["mekugi-bin", "mekugi-shell-bin", "mekugi-source"].some(key => o[key] !== undefined)) {
      throw new Error("--mekugi-build owns its binaries and source; do not override them");
    }
    const timeout = Number(string(o, "timeout", "1800"));
    if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new Error("--timeout must be a positive integer");
    const runDir = await prepare({
      profile: string(o, "profile", o.criteria ? "task" : "mekugi") as import("./types").BenchmarkProfile,
      reasoningEffort: string(o, "reasoning-effort", "medium") as import("./types").ReasoningEffort,
      source: string(o, "source", "/home/ubuntu/projects/mekugi"), baseCommit: string(o, "base", DEFAULT_BASE),
      forbiddenCommit: string(o, "forbidden", DEFAULT_FORBIDDEN), taskPath: string(o, "task", resolve("task.md")),
      taskPackPath: o["task-pack"] as string | undefined,
      criteriaPath: o.criteria as string | undefined,
      outputParent: o["output-parent"] as string | undefined,
      reviewTreatment: o["review-treatment"] as string | undefined,
      comparison: string(o, "comparison", "stock-current") as import("./types").Comparison,
      mekugiFlags: o["mekugi-flags"] ? parseMekugiFlags(string(o, "mekugi-flags")) : undefined,
      currentLauncher: o["current-launcher"] as import("./types").CodexLauncher | undefined,
      protectMekugi: o["protect-mekugi"] === true,
      mekugiBuild: o["mekugi-build"] as string | undefined,
      mekugiSource: o["mekugi-source"] as string | undefined,
      mekugiBinary: o["mekugi-bin"] as string | undefined,
      grokBinary: o["grok-bin"] as string | undefined,
      mekugiShellBinary: o["mekugi-shell-bin"] as string | undefined,
      currentHome: string(o, "current-home", homedir()), image: string(o, "image", "codex-ab:0.1.0"),
      cpus: string(o, "cpus", "2"), memory: string(o, "memory", "4g"), timeoutSeconds: timeout,
      codexBinary: string(o, "codex-bin", join(homedir(), ".local/bin/codex")),
      bunBinary: o["bun-bin"] as string | undefined,
    });
    process.stdout.write(`${runDir}\n`);
    return 0;
  }
  if (command === "prepare-trials") {
    const order = string(o, "order", "concurrent");
    if (order !== "concurrent" && order !== "alternating") throw new Error("--order must be concurrent or alternating");
    process.stdout.write(`${await prepareTrials({ runDir: string(o, "run-dir"), count: Number(string(o, "count")),
      schedule: order, outputParent: o["output-parent"] as string | undefined, dockerBin: o["docker-bin"] as string | undefined })}\n`);
    return 0;
  }
  if (command === "run-trials") {
    if (o["confirm-paid-inference"] !== true) throw new Error("run-trials launches model inference; pass --confirm-paid-inference to confirm intentional execution");
    process.stdout.write(`${await runTrials({ directory: string(o, "trial-set"),
      authFile: string(o, "auth-file", join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json")),
      grokAuthFile: o["grok-auth-file"] as string | undefined,
      dockerBin: o["docker-bin"] as string | undefined })}\n`);
    return 0;
  }
  if (command === "report-trials") {
    process.stdout.write(`${await reportTrials(string(o, "trial-set"))}\n`);
    return 0;
  }
  if (command === "run" || command === "judge" || command === "finish") {
    if (o["confirm-paid-inference"] !== true) throw new Error(`${command} launches model inference; pass --confirm-paid-inference to confirm intentional execution`);
    const runDir = string(o, "run-dir");
    const auth = string(o, "auth-file", join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json"));
    if (command === "run") {
      const arm = o.arm;
      if (arm !== undefined && arm !== "current" && arm !== "stock") throw new Error("--arm must be stock or current");
      await runBenchmark({ runDir, authFile: auth, grokAuthFile: o["grok-auth-file"] as string | undefined, dockerBin: o["docker-bin"] as string | undefined, arm });
    }
    else if (command === "finish") await finishBenchmark({ runDir, authFile: auth, dockerBin: o["docker-bin"] as string | undefined });
    else await judgeRun(runDir, auth, o["docker-bin"] as string | undefined);
    process.stdout.write(`${resolve(runDir)}\n`);
    return 0;
  }
  if (command === "preflight") {
    await preflightRun(string(o, "run-dir"), o["docker-bin"] as string | undefined);
    process.stdout.write(`${resolve(string(o, "run-dir"))}\n`);
    return 0;
  }
  if (command === "remeter") {
    process.stdout.write(`${await remeterRun(string(o, "run-dir"), string(o, "exclusions"))}\n`);
    return 0;
  }
  if (command === "report") {
    const result = await buildReport(string(o, "run-dir"), { outputDirectory: o["output-dir"] as string | undefined, sourceAssessmentsFile: o["source-assessments"] as string | undefined });
    process.stdout.write(`${result.markdownPath}\n`);
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
