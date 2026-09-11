import { expect, test } from "bun:test";
import { auditSession } from "./bundle";

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

