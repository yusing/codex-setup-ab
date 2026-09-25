import { join } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { exec } from "./process";
import { sha256 } from "./state";
import type { ArmName, RunState } from "./types";

const FLAGS = new Set(["mode", "main-mentor-handoff", "mentor-handoff", "post-compact-recovery", "explore-filter", "timeout", "stream-idle-timeout", "debug", "grok"]);

/** Keep private --debug artifacts in the disposable container; export only capturer-owned metrics. */
export const MEKUGI_METRICS_WRAPPER = 'temp_dir=$(mktemp -d "${MEKUGI_DEBUG_TMPDIR:-/tmp}/codex-ab-mekugi.XXXXXX") || exit; '
  + 'exec 3<&0; TMPDIR="$temp_dir" "$@" <&3 3<&- & child=$!; exec 3<&-; '
  + 'trap \'kill -TERM "$child" 2>/dev/null || :\' TERM INT; '
  + 'while :; do wait "$child"; status=$?; kill -0 "$child" 2>/dev/null || break; done; '
  + 'for metrics in "$temp_dir"/mekugi-debug-*/metrics.json; do '
  + 'if [ -f "$metrics" ]; then cp "$metrics" /mekugi-exports/metrics.json || exit 1; exit "$status"; fi; '
  + 'done; if [ "$status" -eq 0 ]; then echo "Mekugi did not write metrics" >&2; exit 1; fi; exit "$status"';

export function validateMekugiFlags(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(flag => typeof flag !== "string")) throw new Error("Mekugi flags must be a string array");
  const seen = new Set<string>();
  for (const flag of value) {
    const match = /^--([a-z-]+)(?:=([^\0\n]*))?$/.exec(flag);
    if (!match || !FLAGS.has(match[1]!) || seen.has(match[1]!) || (match[2] === undefined && match[1] !== "debug" && match[1] !== "grok")) throw new Error(`unsupported or repeated Mekugi flag: ${flag}`);
    if (match[1] === "mode" && !["mekugi", "passthrough"].includes(match[2]!)) throw new Error("invalid Mekugi mode");
    if (["main-mentor-handoff", "mentor-handoff", "post-compact-recovery", "explore-filter"].includes(match[1]!) && !["true", "false"].includes(match[2]!)) throw new Error(`invalid Mekugi boolean flag: ${flag}`);
    if (match[1] === "debug" && match[2] !== undefined && match[2] !== "true") throw new Error(`invalid Mekugi debug flag: ${flag}`);
    seen.add(match[1]!);
  }
  return value;
}

export function mekugiIdentity(flags: string[]): { mode: string } {
  return {
    mode: flags.find(flag => flag.startsWith("--mode="))?.slice("--mode=".length) ?? "mekugi",
  };
}

/** Validate Mekugi exports with the runner-bundled analyzer snapshotted for this run. */
export async function validateMekugiExports(runDir: string, state: RunState, arm?: ArmName): Promise<{
  status: "valid" | "unavailable"; reason?: string; metrics?: unknown; model_schedule?: { root: string[]; child: string[] };
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
  const modelSchedule = state.mentor && arm ? await validateMentorSchedule(runDir, state, arm, metrics) : undefined;
  return { status: "valid", metrics, model_schedule: modelSchedule };
  } catch (error) {
    return { status: "unavailable", reason: `Mekugi diagnostics unavailable: ${String(error)}` };
  }
}

function objects(text: string): Record<string, unknown>[] {
  return text.split("\n").filter(Boolean).map((line, index) => {
    const item: unknown = JSON.parse(line);
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`invalid event at line ${index + 1}`);
    return item as Record<string, unknown>;
  });
}

function record(item: unknown): Record<string, unknown> {
  return item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
}

async function sessionFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sessionFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
  }
  return files;
}

async function validateMentorSchedule(runDir: string, state: RunState, arm: ArmName, metrics: unknown): Promise<{ root: string[]; child: string[] }> {
  const result = state.results?.[arm];
  if (!result) throw new Error("mentor arm has no recorded result");
  const events = objects(await readFile(join(runDir, result.stdout_path), "utf8"));
  const roots = events.filter(item => item.type === "thread.started" && typeof item.thread_id === "string").map(item => item.thread_id as string);
  if (roots.length !== 1) throw new Error("mentor root thread identity is missing or duplicated");
  const childIds = events.flatMap(item => {
    const call = record(item.item);
    return item.type === "item.completed" && call.type === "collab_tool_call" && call.tool === "spawn_agent"
      && call.status === "completed" && Array.isArray(call.receiver_thread_ids)
      ? call.receiver_thread_ids.filter((id): id is string => typeof id === "string") : [];
  });
  if (childIds.length !== 1) throw new Error("mentor run did not prove exactly one spawned child");
  const sessions = await sessionFiles(join(runDir, "arms", arm, "home/ubuntu/.codex/sessions"));
  const childMatches: Record<string, unknown>[] = [];
  let childRecords: Record<string, unknown>[] | undefined;
  for (const path of sessions) {
    const records = objects(await readFile(path, "utf8"));
    const metadata = records.find(item => item.type === "session_meta");
    const value = record(metadata?.payload);
    if (value.id === childIds[0]) { childMatches.push(value); childRecords = records; }
  }
  if (childMatches.length !== 1 || childMatches[0]!.parent_thread_id !== roots[0]
    || childMatches[0]!.agent_role !== "benchmark_worker" || childMatches[0]!.subagent_history_start_ordinal != null) {
    throw new Error("mentor child rollout lineage is unproved");
  }
  const configuredModels = new Set(childRecords!.filter(item => item.type === "turn_context").map(item => record(item.payload).model));
  const configuredEfforts = new Set(childRecords!.filter(item => item.type === "turn_context").map(item => record(item.payload).effort));
  if (configuredModels.size !== 1 || !configuredModels.has(state.mentor!.child_model)
    || configuredEfforts.size !== 1 || !configuredEfforts.has(state.mentor!.child_effort)) {
    throw new Error("mentor child rollout model or effort differs from fixed role");
  }
  const exchanges = record(metrics).exchanges;
  if (!Array.isArray(exchanges) || exchanges.length === 0) throw new Error("mentor capture has no provider exchanges");
  const models = { root: new Set<string>(), child: new Set<string>() };
  let childPhase: "fresh" | "sol" | "luna" = "fresh";
  let childTurnSeen = false;
  for (const exchange of [...exchanges].sort((a, b) => Number(record(a).sequence) - Number(record(b).sequence))) {
    const entry = record(exchange);
    const destination = entry.thread_id === roots[0] ? models.root : entry.thread_id === childIds[0] ? models.child : undefined;
    if (!destination) throw new Error("mentor capture contains an unproved thread");
    if (!Array.isArray(entry.provider_attempts)) throw new Error("mentor capture is missing provider attempts");
    for (const attempt of entry.provider_attempts) {
      const model = record(attempt).model;
      if (typeof model !== "string") throw new Error("mentor provider model is missing");
      destination.add(model);
      if (destination === models.child && arm === "current" && (entry.request_kind === "turn" || entry.request_kind == null)) {
        childTurnSeen = true;
        if ((childPhase === "fresh" && model !== "gpt-6-sol") || (childPhase === "luna" && model === "gpt-6-sol")) {
          throw new Error("mentor child provider schedule did not start with Sol or returned to Sol without compaction");
        }
        childPhase = model === "gpt-6-sol" ? "sol" : "luna";
      }
    }
    if (destination === models.child && entry.request_kind === "compaction" && entry.status === "completed") childPhase = "fresh";
  }
  if (models.root.size !== 1 || !models.root.has(state.execution.model)) throw new Error("mentor root model differs from the configured model");
  if (arm === "stock" && (models.child.size !== 1 || !models.child.has(state.mentor!.child_model))) throw new Error("non-mentor child was routed to another model");
  if (arm === "current" && (!models.child.has("gpt-6-sol") || [...models.child].some(model => model !== "gpt-6-sol" && model !== state.mentor!.child_model))) {
    throw new Error("mentor child did not use the expected bounded model schedule");
  }
  if (arm === "current" && !childTurnSeen) throw new Error("mentor child has no provider turn");
  return { root: [...models.root].sort(), child: [...models.child].sort() };
}
