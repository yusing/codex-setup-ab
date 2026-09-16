import { join } from "node:path";
import { exec } from "./process";
import { sha256 } from "./state";
import type { RunState } from "./types";

const FLAGS = new Set(["mode", "model-protocol", "main-mentor-handoff", "mentor-handoff", "timeout", "stream-idle-timeout", "debug", "grok"]);

export function validateMekugiFlags(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(flag => typeof flag !== "string")) throw new Error("Mekugi flags must be a string array");
  const seen = new Set<string>();
  for (const flag of value) {
    const match = /^--([a-z-]+)(?:=([^\0\n]*))?$/.exec(flag);
    if (!match || !FLAGS.has(match[1]!) || seen.has(match[1]!) || (match[2] === undefined && match[1] !== "debug" && match[1] !== "grok")) throw new Error(`unsupported or repeated Mekugi flag: ${flag}`);
    if (match[1] === "mode" && !["mekugi", "passthrough"].includes(match[2]!)) throw new Error("invalid Mekugi mode");
    if (match[1] === "model-protocol" && !["native", "ctp2"].includes(match[2]!)) throw new Error("invalid Mekugi protocol");
    seen.add(match[1]!);
  }
  return value;
}

export function mekugiIdentity(flags: string[]): { mode: string; model_protocol: string } {
  return {
    mode: flags.find(flag => flag.startsWith("--mode="))?.slice("--mode=".length) ?? "mekugi",
    model_protocol: flags.find(flag => flag.startsWith("--model-protocol="))?.slice("--model-protocol=".length) ?? "native",
  };
}

/** Validation and metric definitions remain in the snapshotted Mekugi analyzer. */
export async function validateMekugiExports(runDir: string, state: RunState): Promise<{
  status: "valid" | "unavailable"; reason?: string; metrics?: unknown;
}> {
  if (!state.mekugi_exports) return { status: "unavailable", reason: "This run did not request exports." };
  try {
  const paths = state.mekugi_exports;
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
    "config = {'benchmark_mode': 'paired', 'treatment_model_protocol': identity['model_protocol']}",
    "owner['validate_snapshot'](metrics, arm, config)",
    "owner['validate_raw_capture'](Path(sys.argv[3]), metrics)",
    "print(json.dumps(metrics))",
  ].join("\n");
  const checked = await exec(["python3", "-c", program, join(runDir, paths.validator.path),
    join(runDir, paths.metrics), join(runDir, paths.capture), JSON.stringify(identity)]);
  if (checked.exitCode !== 0) return { status: "unavailable", reason: checked.stderr.trim() || "Mekugi export validation failed." };
  return { status: "valid", metrics: JSON.parse(checked.stdout) };
  } catch (error) {
    return { status: "unavailable", reason: `Mekugi diagnostics unavailable: ${String(error)}` };
  }
}
