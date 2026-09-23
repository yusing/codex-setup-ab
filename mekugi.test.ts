import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateMekugiExports } from "./mekugi";
import { sha256 } from "./state";
import type { RunState } from "./types";

test("mentor provider schedule permits Sol after a successful child compaction only", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-ab-mentor-schedule-"));
  try {
    const validator = join(root, "analyze_capture.py");
    const reader = join(root, "benchmark_jsonl.py");
    const metricsPath = join(root, "metrics.json");
    const capture = join(root, "capture.jsonl");
    const stdout = join(root, "stdout.jsonl");
    const sessions = join(root, "arms/current/home/ubuntu/.codex/sessions");
    await mkdir(sessions, { recursive: true });
    await writeFile(validator, "import json\ndef load_json(path): return json.loads(path.read_text())\ndef validate_snapshot(*args): pass\ndef validate_raw_capture(*args): pass\n");
    await writeFile(reader, "");
    await writeFile(capture, "");
    await writeFile(stdout, [
      { type: "thread.started", thread_id: "parent" },
      { type: "item.completed", item: { type: "collab_tool_call", tool: "spawn_agent", status: "completed", receiver_thread_ids: ["child"] } },
    ].map(JSON.stringify).join("\n") + "\n");
    await writeFile(join(sessions, "child.jsonl"), [
      { type: "session_meta", payload: { id: "child", parent_thread_id: "parent", agent_role: "benchmark_worker" } },
      { type: "turn_context", payload: { model: "gpt-6-luna", effort: "medium" } },
    ].map(JSON.stringify).join("\n") + "\n");
    const exchanges = [
      { sequence: 1, thread_id: "parent", request_kind: "turn", status: "completed", provider_attempts: [{ model: "gpt-6-sol" }] },
      { sequence: 2, thread_id: "child", request_kind: "turn", status: "completed", provider_attempts: [{ model: "gpt-6-sol" }] },
      { sequence: 3, thread_id: "child", request_kind: "turn", status: "completed", provider_attempts: [{ model: "gpt-6-luna" }] },
      { sequence: 4, thread_id: "child", request_kind: "compaction", status: "completed", provider_attempts: [{ model: "gpt-6-luna" }] },
      { sequence: 5, thread_id: "child", request_kind: "turn", status: "completed", provider_attempts: [{ model: "gpt-6-sol" }] },
    ];
    await writeFile(metricsPath, JSON.stringify({ exchanges }));
    const state = {
      comparison: "mentor-handoff", mentor: { setup: "stock", child_model: "gpt-6-luna", child_effort: "medium" },
      execution: { model: "gpt-6-sol" }, mekugi_flags: [],
      results: { current: { stdout_path: "stdout.jsonl" } },
      mekugi_exports_by_arm: { current: {
        validator: { path: "analyze_capture.py", sha256: await sha256(validator) },
        reader: { path: "benchmark_jsonl.py", sha256: await sha256(reader) },
        metrics: "metrics.json", capture: "capture.jsonl",
      } },
    } as unknown as RunState;
    expect((await validateMekugiExports(root, state, "current")).status).toBe("valid");
    exchanges[3]!.status = "failed";
    await writeFile(metricsPath, JSON.stringify({ exchanges }));
    const invalid = await validateMekugiExports(root, state, "current");
    expect(invalid.status).toBe("unavailable");
    expect(invalid.reason).toContain("without compaction");
    expect(await readFile(capture, "utf8")).toBe("");
  } finally { await rm(root, { recursive: true, force: true }); }
});
