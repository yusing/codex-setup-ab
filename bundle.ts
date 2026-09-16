import { cp, copyFile, lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { readState, sha256, writeState } from "./state";
import type { ArmName } from "./types";

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

interface AuditCall {
  timestamp: string | null;
  name: string;
  nested_tools: string[];
  parameters: RecordValue;
  payload_visible: boolean;
}
interface SessionAudit {
  thread_id: unknown;
  parent_thread_id: unknown;
  agent_path: unknown;
  agent_role: unknown;
  model: unknown;
  calls: AuditCall[];
  received_messages: Array<{ timestamp: string | null; encrypted: boolean }>;
  completions: Array<string | null>;
  malformed_lines: number;
}

export function auditSession(jsonl: string): SessionAudit {
  const result: SessionAudit = { thread_id: null, parent_thread_id: null, agent_path: null, agent_role: null, model: null, calls: [], received_messages: [], completions: [], malformed_lines: 0 };
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let event: RecordValue;
    try { event = record(JSON.parse(line)); } catch { result.malformed_lines++; continue; }
    const payload = record(event.payload);
    const timestamp = typeof event.timestamp === "string" ? event.timestamp : null;
    if (event.type === "session_meta") {
      result.thread_id = payload.id ?? payload.session_id ?? null;
      result.parent_thread_id = payload.parent_thread_id ?? null;
      result.agent_path = payload.agent_path ?? null;
      result.agent_role = payload.agent_role ?? null;
    }
    if (event.type === "turn_context") result.model = payload.model ?? null;
    if (event.type === "event_msg" && payload.type === "task_complete") result.completions.push(timestamp);
    if (event.type !== "response_item") continue;
    if (payload.type === "agent_message") {
      const content = Array.isArray(payload.content) ? payload.content : [];
      result.received_messages.push({ timestamp, encrypted: content.some(block => record(block).type === "encrypted_content") });
    }
    if (payload.type !== "function_call" && payload.type !== "custom_tool_call") continue;
    const name = typeof payload.name === "string" ? payload.name : "unknown";
    const raw = payload.arguments ?? payload.input;
    const text = typeof raw === "string" ? raw : "";
    let args: RecordValue = {};
    try { args = record(JSON.parse(text)); } catch { /* Custom tool programs are not JSON. */ }
    const parameters: RecordValue = {};
    for (const key of ["task_name", "target", "agent_type", "fork_turns", "timeout_ms", "yield_time_ms"]) {
      if (typeof args[key] === "string" || typeof args[key] === "number") parameters[key] = args[key];
    }
    result.calls.push({
      timestamp, name, parameters,
      nested_tools: [...text.matchAll(/\btools\.([A-Za-z_0-9]+)/g)].map(match => match[1]!),
      payload_visible: Boolean(text) && !text.includes("encrypted_content"),
    });
  }
  return result;
}

async function regularFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await regularFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

function within(root: string, path: string): string {
  const full = resolve(root, path);
  if (!full.startsWith(`${resolve(root)}${sep}`)) throw new Error(`artifact outside run: ${path}`);
  return full;
}

/** Copies only benchmark-owned evidence, never private homes, auth, or raw prompts. */
export async function collectBundle(runDirectory: string): Promise<string> {
  const runDir = resolve(runDirectory);
  const state = await readState(runDir);
  const destination = join(runDir, "reports/bundle");
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const write = async (name: string, value: unknown) =>
    writeFile(join(destination, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  const copy = async (source: string, target: string) => {
    const path = within(runDir, source);
    if (!(await lstat(path)).isFile()) throw new Error(`artifact is not a regular file: ${source}`);
    await copyFile(path, join(destination, target));
  };
  await copy("run.json", "run.json");
  await copy("reports/report.json", "report.json");
  await copy("reports/report.md", "report.md");
  await copy(state.snapshot_manifest, "snapshot-manifest.json");
  await copy(state.runtime_tools.current_setup_files, "mise-files.json");
  await copy(state.task.path, "task.md");
  if (state.mekugi_exports) {
    for (const [source, target] of [[state.mekugi_exports.capture, "mekugi-capture.jsonl"],
      [state.mekugi_exports.metrics, "mekugi-metrics.json"],
      [state.mekugi_exports.validator.path, "analyze_capture.py"],
      [state.mekugi_exports.reader.path, "benchmark_jsonl.py"]]) {
      try { await copy(source!, target!); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await rm(join(destination, target!), { force: true });
      }
    }
  }
  if (state.protected_runtime) {
    await mkdir(join(destination, "isolation"), { recursive: true });
    for (const file of state.protected_runtime.scripts) await copy(file.path, `isolation/${file.path.split("/").at(-1)}`);
    await copy("artifacts/preflight-isolation.json", "isolation/preflight.json");
  }
  if (state.mekugi_build) await mkdir(join(destination, "mekugi-build"), { recursive: true });
  for (const file of state.mekugi_build?.files ?? []) await copy(file.path, `mekugi-build/${file.path.split("/").at(-1)}`);
  if (state.task_pack) await copy(state.task_pack.path, "task-pack.json");
  if (state.criteria) {
    await copy(state.criteria.path, "criteria.json");
    const semanticRoot = join(runDir, "evaluator/semantic");
    try { await cp(semanticRoot, join(destination, "semantic"), { recursive: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await rm(join(destination, "semantic"), { recursive: true, force: true });
    }
    for (const [index, attempt] of (state.judge?.attempts ?? []).entries()) {
      if (!attempt.stage) continue;
      for (const [source, suffix] of [[attempt.stdout_path, "jsonl"], [attempt.stderr_path, "stderr"]]) {
        try { await copy(source!, `semantic-judge-${index + 1}.${suffix}`); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    }
  }
  const sessions: Partial<Record<ArmName, SessionAudit[]>> = {};
  const integrity: Array<{ path: string; sha256: string; expected_sha256: string; matches: boolean }> = [];
  for (const [path, expected] of [
    [state.snapshot_manifest, state.current_snapshot.manifest_sha256],
    [state.task.path, state.task.sha256],
    ...(state.protected_runtime?.scripts.map(file => [file.path, file.sha256]) ?? []),
    ...(state.mekugi_build?.files.map(file => [file.path, file.sha256]) ?? []),
    ...(state.task_pack ? [[state.task_pack.path, state.task_pack.sha256]] : []),
    ...(state.criteria ? [[state.criteria.path, state.criteria.sha256]] : []),
    [state.runtime_tools.current_setup_files, state.runtime_tools.current_setup_files_sha256],
  ] as Array<[string, string]>) {
    const actual = await sha256(within(runDir, path));
    integrity.push({ path, sha256: actual, expected_sha256: expected, matches: actual === expected });
  }
  await write("final-integrity.json", { checks: integrity, passed: integrity.every(item => item.matches) });
  if (integrity.some(item => !item.matches)) {
    state.invalidity_reasons = [...new Set([...(state.invalidity_reasons ?? []), "finishing control integrity check failed"])];
    await writeState(runDir, state);
    throw new Error("finishing integrity checks failed; evidence preserved");
  }
  for (const arm of state.selected_arms ?? []) {
    const result = state.results?.[arm];
    if (result && !result.collection_error) await copy(result.patch_path, `${arm}-changes.patch`);
    const home = state.arm_attempts?.[arm]?.codex_home;
    const directory = home ? join(within(runDir, home), "sessions") : undefined;
    sessions[arm] = [];
    if (!directory) continue;
    let files: string[];
    try { files = await regularFiles(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      continue;
    }
    for (const file of files.filter(path => path.endsWith(".jsonl"))) {
      sessions[arm]!.push(auditSession(await readFile(file, "utf8")));
    }
  }
  const audit = Object.fromEntries(Object.entries(sessions).map(([arm, entries]) => [arm, entries.map(session => {
    const names = session.calls.flatMap(call => [call.name.split(".").at(-1)!, ...call.nested_tools]);
    return {
      thread_id: session.thread_id, agent_path: session.agent_path,
      reviewer_status_polls: names.filter(name => /(?:^|__)list_agents$/.test(name)).length,
      completion_waits: names.filter(name => /(?:^|__)wait_agent$/.test(name)).length,
      running_command_waits: names.filter(name => /(?:^|__)(write_stdin|wait)$/.test(name)).length,
      launches: session.calls.filter(call => /spawn_agent$/.test(call.name) || call.nested_tools.some(name => /spawn_agent$/.test(name))),
      updates: session.calls.filter(call => /(send_message|followup_task)$/.test(call.name) || call.nested_tools.some(name => /(send_message|followup_task)$/.test(name))),
      completions: session.completions,
      encrypted_received_messages: session.received_messages.filter(message => message.encrypted).length,
      malformed_lines: session.malformed_lines,
    };
  })]));
  await write("review-workflow.json", { sessions, scope: "Tool names, selected non-message parameters, timestamps and encryption markers. No raw arguments, prompts or message bodies. Timing does not prove message content or validation readiness." });
  await write("interaction-audit.json", { arms: audit, limitations: "Missing or encrypted events are unknown, not evidence of no interaction. Source edits performed inside shell commands are not inferred. Command waits are separate from reviewer-status polling." });
  await write("role-metadata.json", Object.fromEntries(Object.entries(sessions).map(([arm, entries]) => [arm, entries.map(({ calls, received_messages, completions, malformed_lines, ...metadata }) => metadata)])));
  await write("supplemental-repeat.json", {
    required_benchmark_gate_replaced: false,
    arms: Object.fromEntries((state.selected_arms ?? []).map(arm => [arm, state.results?.[arm]?.grade?.supplemental_repeat ?? null])),
    scope: "Offline scoped-package repeat check on read-only evaluator source. Task-derived criteria are assessed separately with retained executable semantic checks.",
  });
  const report = record(JSON.parse(await readFile(join(runDir, "reports/report.json"), "utf8")));
  if (report.rejected_source_assessment) await write("rejected-source-assessment.json", {
    status: "rejected; not an eligible winner or completed independent comparison",
    ...record(report.rejected_source_assessment),
  });
  const manifest = record(JSON.parse(await readFile(join(destination, "snapshot-manifest.json"), "utf8")));
  const treatment = record(manifest.review_treatment);
  if (Array.isArray(treatment.files)) {
    await mkdir(join(destination, "treatment"), { recursive: true });
    for (const value of treatment.files) {
      const item = record(value);
      const name = item.source;
      const target = item.destination;
      if (typeof name !== "string" || !["parent-agents.md", "review-correctness.toml", "review-simplify.toml", "web-reviewer.toml"].includes(name) ||
          typeof target !== "string" || ![".codex/AGENTS.md", ".codex/agents/review-correctness.toml", ".codex/agents/review-simplify.toml", ".codex/agents/web-reviewer.toml"].includes(target)) {
        throw new Error("invalid treatment manifest entry");
      }
      await copy(join(state.arms.current.home_template, target), `treatment/${name}`);
      if (await sha256(join(destination, "treatment", name)) !== item.after_sha256) throw new Error("applied treatment differs from manifest");
    }
  }
  const setupDescriptions = state.comparison === "codex-mekugi-grok"
    ? {
      stock: "Minimal generated Codex configuration plus the Mekugi launcher and shell helper on grok:grok-4.6; no current-home guidance overlay.",
      current: "Minimal generated Grok configuration plus the Grok CLI on grok-4.6; no current-home guidance overlay.",
    }
    : state.comparison === "stock-mekugi"
      ? {
        stock: "Minimal generated Codex configuration; no current-home guidance overlay.",
        current: "Minimal generated Codex configuration plus the Mekugi launcher and shell helper; no current-home guidance overlay.",
      }
      : state.comparison === "same-setup"
        ? {
          stock: "Same audited current-home snapshot as B, launched through direct Codex.",
          current: "Audited current-home snapshot, including recorded tracked worktree changes, launched through Mekugi.",
        }
        : {
          stock: "Minimal generated Codex configuration; no current-home guidance overlay.",
          current: "Audited current-home snapshot, including recorded tracked worktree changes.",
        };
  await write("setup-comparison.json", {
    source: state.source, task: state.task, task_pack: state.task_pack, criteria: state.criteria, submodules: state.submodules ?? [],
    comparison: state.comparison ?? "stock-current", mekugi_flags: state.mekugi_flags ?? [], arm_order: state.arm_order ?? "concurrent", trial: state.trial ?? null,
    execution: state.execution, image_id: state.image_id, runtime_tools: state.runtime_tools,
    resource_limits: state.resource_limits, current_configuration: manifest.configuration_repository,
    review_treatment: treatment,
    stock: setupDescriptions.stock,
    current: setupDescriptions.current,
  });
  await write("comparison.json", {
    design: report.design, arms: report.arms, current_minus_stock_percent: report.current_minus_stock_percent,
    source_quality: state.judge ?? null, validity: report.validity,
    limitations: "Single paired descriptive comparison. Different tasks and historical source snapshots are not equivalent baselines.",
  });
  return destination;
}

/** Refresh outcome-bearing artifacts last, including after partial collection failures. */
export async function finalizeBundle(runDirectory: string): Promise<void> {
  const destination = join(resolve(runDirectory), "reports/bundle");
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const [source, target] of [["run.json", "run.json"], ["reports/report.json", "report.json"], ["reports/report.md", "report.md"]]) {
    await copyFile(join(runDirectory, source!), join(destination, target!));
  }
  // These former generated result documents are superseded by the complete report.md.
  for (const name of ["SOURCE-REVIEW.md", "COMPARISON.md"]) await rm(join(destination, name), { force: true });
  await writeBundleManifest(destination);
}

async function bundleManifestContents(destination: string): Promise<string> {
  const checksums = await Promise.all((await regularFiles(destination)).filter(path => path !== join(destination, "MANIFEST.sha256")).map(async path =>
    `${await sha256(path)}  ${relative(destination, path)}`));
  return `${checksums.join("\n")}\n`;
}

export async function writeBundleManifest(destination: string): Promise<void> {
  await writeFile(join(destination, "MANIFEST.sha256"), await bundleManifestContents(destination));
}

export async function verifyBundleManifest(destination: string, expectedSha256: string): Promise<void> {
  const manifest = join(destination, "MANIFEST.sha256");
  if (await sha256(manifest) !== expectedSha256 || await readFile(manifest, "utf8") !== await bundleManifestContents(destination)) {
    throw new Error("retained bundle evidence changed");
  }
}
