import { expect, test } from "bun:test";
import { auditSession, finalizeBundle } from "./bundle";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("interaction audit separates command waits, collaboration and encrypted payloads without copying bodies", () => {
  const events = [
    { type: "session_meta", payload: { id: "child", parent_thread_id: "root", agent_path: "/root/review", agent_role: "review-correctness" } },
    { type: "turn_context", payload: { model: "gpt-6-astra" } },
    { timestamp: "1", type: "response_item", payload: { type: "function_call", name: "mekugi_collaboration.spawn_agent", arguments: JSON.stringify({ fork_turns: "none", message: "private prompt" }) } },
    { timestamp: "2", type: "response_item", payload: { type: "custom_tool_call", name: "exec", input: "await tools.write_stdin({session_id:1})" } },
    { timestamp: "3", type: "response_item", payload: { type: "agent_message", content: [{ type: "encrypted_content", data: "private ciphertext" }] } },
    { timestamp: "4", type: "event_msg", payload: { type: "task_complete", last_agent_message: "private final text" } },
  ];
  const audit = auditSession(events.map(event => JSON.stringify(event)).join("\n") + "\nmalformed\n");
  expect(audit.agent_path).toBe("/root/review");
  expect(audit.calls[0]?.parameters).toEqual({ fork_turns: "none" });
  expect(audit.calls[1]?.nested_tools).toEqual(["write_stdin"]);
  expect(audit.received_messages).toEqual([{ timestamp: "3", encrypted: true }]);
  expect(audit.completions).toEqual(["4"]);
  expect(audit.malformed_lines).toBe(1);
  expect(JSON.stringify(audit)).not.toContain("private");
});

test("finishing keeps one result Markdown and removes only superseded generated duplicates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "single-report-test-"));
  try {
    const bundle = join(directory, "reports/bundle");
    await mkdir(bundle, { recursive: true });
    await writeFile(join(directory, "run.json"), "{}");
    await writeFile(join(directory, "reports/report.json"), "{}");
    await writeFile(join(directory, "reports/report.md"), "complete result");
    for (const name of ["SOURCE-REVIEW.md", "COMPARISON.md", "task.md"]) await writeFile(join(bundle, name), name);
    await finalizeBundle(directory);
    expect((await readdir(bundle)).filter(name => name.endsWith(".md")).sort()).toEqual(["report.md", "task.md"]);
    expect(await readFile(join(bundle, "report.md"), "utf8")).toBe("complete result");
    expect(await readFile(join(bundle, "task.md"), "utf8")).toBe("task.md");
    expect(await readFile(join(bundle, "MANIFEST.sha256"), "utf8")).not.toContain("SOURCE-REVIEW");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
