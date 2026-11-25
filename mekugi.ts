import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { exec } from "./process";
import { sha256 } from "./state";
import { MEKUGI_EXPORT_FAMILY, MEKUGI_EXPORT_SCRIPTS } from "./support/mekugi";
import type { ArmName, RunState } from "./types";

const FLAGS = new Set([
  "shell-guard", "child-reply-summary", "deduplicate-output", "timeout",
  "stream-idle-timeout", "debug",
]);

const RETIRED_ANSI_FAINT = /^--ansi-faint=(?:auto|on|off)$/;

export function activeMekugiFlags(flags: readonly string[]): string[] {
  return flags.filter(flag => !RETIRED_ANSI_FAINT.test(flag));
}

/**
 * Export sanitized metrics for this capture, leaving private debug bundles at their owner.
 * Older binaries write bundles and an optional native usage report under TMPDIR.
 */
export const MEKUGI_METRICS_WRAPPER = 'temp_dir=$(mktemp -d "${MEKUGI_DEBUG_TMPDIR:-/tmp}/task-runtime.XXXXXX") || exit; '
  + 'exec 3<&0; TMPDIR="$temp_dir" "$@" <&3 3<&- & child=$!; exec 3<&-; '
  + 'trap \'kill -TERM "$child" 2>/dev/null || :\' TERM INT; '
  + 'while :; do wait "$child"; status=$?; kill -0 "$child" 2>/dev/null || break; done; '
  + 'set -- "$temp_dir"/mekugi-token-metrics-*.md; '
  + 'if [ "$#" -eq 1 ] && [ -f "$1" ]; then cp "$1" /mekugi-exports/token-metrics.md || exit 1; fi; '
  + `python3 -c 'exec(${JSON.stringify(MEKUGI_EXPORT_FAMILY).replaceAll("'", "'\\''")})' "$temp_dir" "\${XDG_STATE_HOME:-$HOME/.local/state}" /mekugi-exports/capture.jsonl; `
  + 'export_status=$?; if [ "$status" -eq 0 ] && [ "$export_status" -ne 0 ]; then exit "$export_status"; fi; exit "$status"';

/** Enumerate only sanitized child captures, never the adjacent private AX/debug files. */
export async function mekugiRuntimeCaptures(runDir: string, capture: string): Promise<string[]> {
  const directory = `${capture}.runtimes`;
  let entries;
  try {
    if (!(await lstat(join(runDir, directory))).isDirectory()) throw new Error("Mekugi runtime captures must be a directory");
    entries = await readdir(join(runDir, directory), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const paths: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) throw new Error("Mekugi runtime capture entry must be a directory");
    const path = join(directory, entry.name, "capture.jsonl");
    try {
      if (!(await lstat(join(runDir, path))).isFile()) throw new Error("Mekugi runtime capture must be a regular file");
      paths.push(path);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return paths.sort();
}

export function validateMekugiFlags(
  value: unknown, origin?: "retained",
): string[] {
  if (!Array.isArray(value) || value.some(flag => typeof flag !== "string")) throw new Error("Mekugi flags must be a string array");
  const seen = new Set<string>();
  for (const flag of value) {
    if (/[\0\r\n]/.test(flag)) throw new Error(`unsupported Mekugi flag: ${flag}`);
    const [, name, argument] = /^--([a-z-]+)(?:=([^\0\n]*))?$/.exec(flag) ?? [];
    const supported = name && (FLAGS.has(name) ||
      (origin === "retained" && RETIRED_ANSI_FAINT.test(flag)));
    const isToggle = name === "shell-guard" || name === "child-reply-summary"
      || name === "deduplicate-output";
    if (!name || !supported || seen.has(name)
      || (argument === undefined && !isToggle && name !== "debug")) {
      throw new Error(`unsupported or repeated Mekugi flag: ${flag}`);
    }
    if (isToggle && argument !== undefined && !["true", "false"].includes(argument)) {
      throw new Error(`invalid Mekugi boolean flag: ${flag}`);
    }
    if (name === "debug" && argument !== undefined && argument !== "true") {
      throw new Error(`invalid Mekugi debug flag: ${flag}`);
    }
    seen.add(name);
  }
  return value;
}

export function isPairedMekugiComparison(comparison: RunState["comparison"]): boolean {
  return comparison === "journal-compaction" || comparison === "duplicate-output";
}

export function usesMekugi(state: Pick<RunState, "comparison" | "execution"> & Partial<Pick<RunState, "arms">>, arm: ArmName): boolean {
  if (state.comparison === "custom") return state.arms?.[arm]?.launcher === "mekugi";
  if (isPairedMekugiComparison(state.comparison)) return true;
  if (state.comparison === "codex-mekugi-grok") return arm === "stock";
  return (arm === "current" || state.comparison === "setup-commits") && state.execution.current_launcher === "mekugi";
}

export function mekugiArmFlags(state: Pick<RunState, "comparison" | "mekugi_flags" | "arm_settings">, arm: ArmName): string[] {
  const treatment = state.comparison === "duplicate-output" ? [`--deduplicate-output=${arm === "current"}`] : [];
  const flags = state.arm_settings?.[arm]?.mekugi_flags ?? state.mekugi_flags ?? [];
  return [...activeMekugiFlags(flags), ...treatment];
}

function mekugiIdentity(flags: string[]): { mode: string } {
  return {
    mode: flags.find(flag => flag.startsWith("--mode="))?.slice("--mode=".length) ?? "mekugi",
  };
}

/** Validate Mekugi exports with the runner-bundled analyzer snapshotted for this run. */
export async function validateMekugiExports(runDir: string, state: RunState, arm?: ArmName): Promise<{
  status: "valid" | "unavailable"; reason?: string; metrics?: unknown; nativeResponses?: unknown[][];
}> {
  const paths = arm ? state.mekugi_exports_by_arm?.[arm] ?? state.mekugi_exports : state.mekugi_exports;
  if (!paths) return { status: "unavailable", reason: "This arm did not request exports." };
  try {
  if (await sha256(join(runDir, paths.validator.path)) !== paths.validator.sha256 ||
      await sha256(join(runDir, paths.reader.path)) !== paths.reader.sha256) {
    return { status: "unavailable", reason: "Mekugi validator identity changed." };
  }
  const identity = mekugiIdentity(state.mekugi_flags ?? []);
  const program = [
    "import json, runpy, sys",
    "from pathlib import Path",
    "sys.path.insert(0, str(Path(sys.argv[1]).parent))",
    "owner = runpy.run_path(sys.argv[1])",
    "metrics = owner['load_json'](Path(sys.argv[2]))",
    "identity = json.loads(sys.argv[4])",
    "arm = 'control' if identity['mode'] == 'passthrough' else 'mekugi'",
    "config = {'benchmark_mode': 'paired'}",
    // Historical runs retain their original validator and reader. Use the current
    // analyzer for the new native format and for legacy family inventory policy.
    "analyzer = {'__name__': 'capture_inventory'}",
    `exec(${JSON.stringify(MEKUGI_EXPORT_SCRIPTS["analyze_capture.py"])}, analyzer)`,
    "capture = Path(sys.argv[3])",
    "native_responses = analyzer['native_response_family'](metrics, capture)",
    "if native_responses is not None:",
    "    if arm == 'control': raise ValueError('native responses do not establish passthrough mode')",
    "elif 'validate_family' in owner:",
    "    owner['validate_family'](metrics, Path(sys.argv[3]), arm, config)",
    "else:",
    "    owner['validate_snapshot'](metrics, arm, config)",
    "    owner['validate_raw_capture'](Path(sys.argv[3]), metrics)",
    "print(json.dumps(dict(metrics=metrics, nativeResponses=native_responses)))",
  ].join("\n");
  const checked = await exec(["python3", "-B", "-c", program, join(runDir, paths.validator.path),
    join(runDir, paths.metrics), join(runDir, paths.capture), JSON.stringify(identity)]);
  if (checked.exitCode !== 0) return { status: "unavailable", reason: checked.stderr.trim() || "Mekugi export validation failed." };
  const { metrics, nativeResponses } = JSON.parse(checked.stdout) as { metrics: unknown; nativeResponses: unknown[][] | null };
  return { status: "valid", metrics, ...(nativeResponses === null ? {} : { nativeResponses }) };
  } catch (error) {
    return { status: "unavailable", reason: `Mekugi diagnostics unavailable: ${String(error)}` };
  }
}
