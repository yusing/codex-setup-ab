import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { exec } from "./process";
import { evidenceLines, rolloutPaths } from "./rollout-evidence";
import { readState } from "./state";
import { usesMekugi } from "./mekugi";
import { isRecord, type JsonRecord as ObjectValue } from "./util";

const object = (value: unknown): ObjectValue | undefined => isRecord(value) ? value : undefined;
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

async function* rows(path: string) {
  let number = 0;
  for await (const line of evidenceLines(path)) {
    number++;
    if (!line.trim()) continue;
    try {
      const row = object(JSON.parse(line));
      if (row) { yield row; continue; }
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    throw new Error(`${path}:${number}: invalid JSONL object`);
  }
}

function artifact(root: string, path: string): string {
  const target = resolve(root, path);
  const fromRoot = relative(root, target);
  if (!fromRoot || isAbsolute(fromRoot) || fromRoot === ".." ||
      fromRoot.startsWith(`..${sep}`)) throw new Error("evidence is outside the run");
  return target;
}

async function rolloutPrefix(path: string) {
  let id: string | undefined;
  let base = "";
  let sawTask = false;
  const blocks: string[] = [];
  const texts: string[] = [];
  for await (const row of rows(path)) {
    const item = object(row.payload);
    if (!item) continue;
    if (row.type === "session_meta") {
      if (object(item.source)?.subagent || object(item.thread_source)?.subagent) {
        return undefined;
      }
      const thread = item.id ?? item.session_id;
      id = typeof thread === "string" ? thread : undefined;
      base = typeof item.base_instructions === "string" ? item.base_instructions : "";
    }
    if (row.type === "event_msg" && item.type === "task_started" && sawTask) break;
    if (row.type !== "response_item") continue;
    if (item.type === "message" && (item.role === "developer" || item.role === "user")) {
      for (const span of list(item.content)) {
        const part = object(span);
        if (part?.type !== "input_text" || typeof part.text !== "string") continue;
        const text = part.text;
        texts.push(text);
        blocks.push(`# ${item.role}\n${text.trimEnd()}`);
      }
      if (item.role === "user") sawTask = true;
    } else if (item.type === "additional_tools") {
      for (const tool of list(item.tools)) appendTool(blocks, tool);
    } else {
      // The first sampled item ends the retained input prefix.
      break;
    }
  }
  if (!id || !sawTask) return undefined;
  if (base.trim() && !texts.includes(base)) {
    blocks.unshift(`# base instructions (session metadata)\n${base.trimEnd()}`);
  }
  return { id, blocks };
}

function appendTool(blocks: string[], value: unknown, prefix = "") {
  const tool = object(value);
  if (!tool) return;
  const { description, tools, ...fields } = tool;
  const name = typeof tool.name === "string" ? tool.name : String(tool.type);
  blocks.push(`# tool ${prefix}${name}\n${JSON.stringify(fields, null, 2)}` +
    (typeof description === "string" ? `\n${description.trimEnd()}` : ""));
  for (const child of list(tools)) appendTool(blocks, child, `${prefix}${name}.`);
}

async function receipt(path: string, id: string): Promise<string | undefined> {
  for await (const row of rows(path)) {
    if (row.thread_id !== id || row.request_kind !== "turn" ||
        row.boundary !== "provider") continue;
    return JSON.stringify({
      model: row.request_model,
      sequence: row.request_sequence,
      request_bytes: object(row.request)?.bytes,
      input_tokens: object(row.usage)?.input_tokens,
      projected_fields: Object.keys(object(object(row.projected_fingerprint)?.fields)
        ?? {}).sort(),
      projected_input_items: object(row.projected_fingerprint)?.item_count,
    }, null, 2);
  }
}

async function firstRequest(run: string, arm: string): Promise<string> {
  const state = await readState(run);
  if (!Object.hasOwn(state.arms, arm)) throw new Error(`unknown arm: ${arm}`);
  const home = state.arm_attempts?.[arm]?.codex_home ??
    join(dirname(state.arms[arm]!.repository), "home/ubuntu/.codex");
  const roots = [];
  for (const path of await rolloutPaths(artifact(run, home))) {
    const prefix = await rolloutPrefix(path);
    if (prefix) roots.push(prefix);
  }
  if (roots.length !== 1) {
    throw new Error(`${arm}: expected one root Codex rollout, found ${roots.length}`);
  }
  const { blocks, id } = roots[0]!;
  const capture = state.mekugi_exports_by_arm?.[arm]?.capture ??
    (usesMekugi(state, arm) ? state.mekugi_exports?.capture : undefined);
  const facts = capture && await receipt(artifact(run, capture), id);
  return [`# Transport receipt (not the provider body)\n${facts || "Unavailable"}`,
    "# Retained startup items (not the provider body)", ...blocks]
    .join("\n\n").replaceAll(id, "<thread-id>") + "\n";
}

export async function firstRequestDiff(run: string, arm: string, against: string, base: string) {
  const [before, after] = await Promise.all([firstRequest(against, base), firstRequest(run, arm)]);
  const cwd = await mkdtemp(join(tmpdir(), "codex-ab-request-diff-"));
  try {
    await writeFile(join(cwd, "baseline"), before, { mode: 0o600 });
    await writeFile(join(cwd, "current"), after, { mode: 0o600 });
    const diff = await exec(["git", "diff", "--no-index", "--no-ext-diff",
      "--no-textconv", "--no-color", "--no-prefix", "--text", "--diff-algorithm=myers",
      "--", "baseline", "current"], { cwd });
    if (diff.exitCode !== 0 && diff.exitCode !== 1) {
      throw new Error(`cannot diff first requests: ${diff.stderr.trim()}`);
    }
    return diff.stdout;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
