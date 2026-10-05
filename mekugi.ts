import { join } from "node:path";
import { exec } from "./process";
import { sha256 } from "./state";
import type { ArmName, RunState } from "./types";

const FLAGS = new Set(["mode", "ansi-faint", "post-compact-recovery", "journal-compaction", "timeout", "stream-idle-timeout", "debug", "grok"]);

/**
 * Export sanitized metrics for this capture, leaving private debug bundles at their owner.
 * Older binaries write bundles and an optional native usage report under TMPDIR.
 */
export const MEKUGI_METRICS_WRAPPER = 'temp_dir=$(mktemp -d "${MEKUGI_DEBUG_TMPDIR:-/tmp}/codex-ab-mekugi.XXXXXX") || exit; '
  + 'exec 3<&0; TMPDIR="$temp_dir" "$@" <&3 3<&- & child=$!; exec 3<&-; '
  + 'trap \'kill -TERM "$child" 2>/dev/null || :\' TERM INT; '
  + 'while :; do wait "$child"; status=$?; kill -0 "$child" 2>/dev/null || break; done; '
  + 'set -- "$temp_dir"/mekugi-token-metrics-*.md; '
  + 'if [ "$#" -eq 1 ] && [ -f "$1" ]; then cp "$1" /mekugi-exports/token-metrics.md || exit 1; fi; '
  + 'selected=; for metrics in "$temp_dir"/mekugi-debug-*/metrics.json "${XDG_STATE_HOME:-$HOME/.local/state}"/mekugi/debug/mekugi-debug-*/metrics.json; do '
  + '[ -f "$metrics" ] || continue; '
  + 'case "$metrics" in "$temp_dir"/*) ;; *) [ "$(readlink -f "${metrics%/metrics.json}/capture.jsonl")" = /mekugi-exports/capture.jsonl ] || continue ;; esac; '
  + '[ -z "$selected" ] || { echo "Mekugi wrote ambiguous metrics" >&2; exit 1; }; selected=$metrics; '
  + 'done; if [ -n "$selected" ]; then cp "$selected" /mekugi-exports/metrics.json || exit 1; '
  + 'elif [ "$status" -eq 0 ]; then echo "Mekugi did not write metrics" >&2; exit 1; fi; exit "$status"';

export function validateMekugiFlags(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(flag => typeof flag !== "string")) throw new Error("Mekugi flags must be a string array");
  const seen = new Set<string>();
  for (const flag of value) {
    if (/[\0\r\n]/.test(flag)) throw new Error(`unsupported Mekugi flag: ${flag}`);
    const match = /^--([a-z-]+)(?:=([^\0\n]*))?$/.exec(flag);
    if (!match || !FLAGS.has(match[1]!) || seen.has(match[1]!) || (match[2] === undefined && match[1] !== "debug" && match[1] !== "grok")) throw new Error(`unsupported or repeated Mekugi flag: ${flag}`);
    if (match[1] === "mode" && !["mekugi", "passthrough"].includes(match[2]!)) throw new Error("invalid Mekugi mode");
    if (match[1] === "ansi-faint" && !["auto", "on", "off"].includes(match[2]!)) throw new Error("invalid ansi-faint mode");
    if (match[1] === "journal-compaction" && !["auto", "slice", "off"].includes(match[2]!)) throw new Error("invalid journal-compaction mode");
    if (["post-compact-recovery", "grok"].includes(match[1]!) && match[2] !== undefined && !["true", "false"].includes(match[2]!)) throw new Error(`invalid Mekugi boolean flag: ${flag}`);
    if (match[1] === "debug" && match[2] !== undefined && match[2] !== "true") throw new Error(`invalid Mekugi debug flag: ${flag}`);
    seen.add(match[1]!);
  }
  // Passthrough never answers compaction, so the flag would label an arm it cannot change.
  if (seen.has("journal-compaction") && value.includes("--mode=passthrough")) throw new Error("journal-compaction requires Mekugi mode");
  return value;
}

export function mekugiIdentity(flags: string[]): { mode: string } {
  return {
    mode: flags.find(flag => flag.startsWith("--mode="))?.slice("--mode=".length) ?? "mekugi",
  };
}

/** Validate Mekugi exports with the runner-bundled analyzer snapshotted for this run. */
export async function validateMekugiExports(runDir: string, state: RunState, arm?: ArmName): Promise<{
  status: "valid" | "unavailable"; reason?: string; metrics?: unknown;
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
    "owner['validate_snapshot'](metrics, arm, config)",
    "owner['validate_raw_capture'](Path(sys.argv[3]), metrics)",
    "print(json.dumps(metrics))",
  ].join("\n");
  const checked = await exec(["python3", "-c", program, join(runDir, paths.validator.path),
    join(runDir, paths.metrics), join(runDir, paths.capture), JSON.stringify(identity)]);
  if (checked.exitCode !== 0) return { status: "unavailable", reason: checked.stderr.trim() || "Mekugi export validation failed." };
  const metrics = JSON.parse(checked.stdout);
  return { status: "valid", metrics };
  } catch (error) {
    return { status: "unavailable", reason: `Mekugi diagnostics unavailable: ${String(error)}` };
  }
}
