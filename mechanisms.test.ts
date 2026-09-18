import { expect, test } from "bun:test";
import { sessionDiagnostics } from "./diagnostics";
import { explainMechanisms, mechanismsMarkdown, reviewPolicy, workflowTrace } from "./mechanisms";
import type { MeteredRollouts } from "./usage";

const policy = reviewPolicy(`Milestones are not requests for action. The reviewer retains them
without acknowledgments, further
inspection, or interim findings.
Send "main done" only after implementation, documentation, and all required validation
are finished.`, "captured/AGENTS.md");
const timestamp = (seconds: number): string => new Date(seconds * 1000).toISOString();
function call(time: number, name: string, args: object) {
  return { timestamp: timestamp(time), type: "response_item", payload: { type: "function_call", name, arguments: JSON.stringify(args) } };
}
function command(time: number, text: string, output = "", duration = 0.1) {
  return { timestamp: timestamp(time), type: "event_msg", payload: { type: "item_completed", item: {
    type: "CommandExecution", status: "completed", id: `cmd-${time}`, command: ["/bin/bash", "-c", text], aggregated_output: output, exit_code: 0, duration: { secs: duration, nanos: 0 },
  } } };
}
function assessment(time: number, author: string, verdict: "COMMENT" | "APPROVE") {
  return { timestamp: timestamp(time), type: "response_item", payload: {
    type: "agent_message", author, content: [{ type: "input_text", text: `## Recommendation: ${verdict}\n\n**MEDIUM, high confidence, correctness: Writer accepts records that reader rejects.**` }],
  } };
}
function rootEvents() {
  return [
    { type: "session_meta", payload: { id: "root" } },
    call(0, "spawn_agent", { task_name: "review", fork_turns: "none", message: 'Send "main done" later; this is not readiness.' }),
    command(1, "cat parser.ts"), command(3, "bun test"),
    call(4, "send_message", { target: "review", message: "opaque ciphertext" }),
    assessment(5, "/root/review", "COMMENT"),
    { timestamp: timestamp(6), type: "event_msg", payload: { type: "item_completed", item: { type: "FileChange", status: "completed", changes: { "parser.ts": { type: "update", unified_diff: "private patch" } } } } },
    command(7, "rtk shadowtree test", "shadowtree: overlayfs unavailable; falling back to copied workspace\nok example/pkg 0.2s\n", 4),
    call(8, "send_message", { target: "review", message: "opaque again" }),
    assessment(9, "/root/review", "APPROVE"),
  ];
}
function meter(events = rootEvents()): MeteredRollouts {
  return {
    complete: true, warnings: [], agents: [], totals: { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0, estimated_api_usd: 0, command_seconds: 0 },
    sessions: [sessionDiagnostics("root", events, "root.jsonl"), sessionDiagnostics("review", [
      { type: "session_meta", payload: { id: "review", parent_thread_id: "root", agent_path: "/root/review", agent_role: "review-correctness" } },
      command(2, "cat parser.ts"), call(2.5, "wait_agent", {}),
    ], "review.jsonl")],
  };
}

test("general workflow rules explain gated review, separate preparation, rework and wrapper overhead", () => {
  const result = explainMechanisms([{ arm: "current", usage: meter(), policy }]);
  expect(result.findings).toHaveLength(4);
  const md = mechanismsMarkdown(result);
  expect(md).toContain("prohibit the reviewer from inspecting milestones");
  expect(md).toContain("Writer accepts records that reader rejects");
  expect(md).toContain("4.000s overall versus 0.200s");
  expect(md).toContain("No explicit readiness signal was recognized");
  expect(md).not.toContain("private patch");
  expect(md).not.toContain("opaque ciphertext");
  expect(md).not.toContain("Before review readiness");
  expect(md).not.toContain("parent’s handoff to review");
  expect(md).toContain("root.jsonl:8");
});

test("no rework claim without matching reviewer approval and ordered edit/test evidence", () => {
  for (const events of [rootEvents().filter(event => event.timestamp !== timestamp(6)), rootEvents().filter(event => event.timestamp !== timestamp(7)), rootEvents().filter(event => event.timestamp !== timestamp(9)), [...rootEvents().slice(0, -1), assessment(9, "/root/unrelated", "APPROVE")]]) {
    expect(explainMechanisms([{ arm: "current", usage: meter(events), policy }]).findings.some(item => item.mechanism.includes("second validation"))).toBe(false);
  }
});

test("failed patches and patch-looking programs do not establish completed changes", () => {
  const events = rootEvents().filter(event => event.timestamp !== timestamp(6));
  for (const event of [
    { timestamp: timestamp(6), type: "event_msg", payload: { type: "item_completed", item: { type: "FileChange", status: "failed", changes: { "parser.ts": {} } } } },
    { timestamp: timestamp(6), type: "response_item", payload: { type: "custom_tool_call", name: "exec", input: 'if(false){await tools.apply_patch("private patch")}' } },
  ]) {
    const result = explainMechanisms([{ arm: "current", usage: meter([...events, event]), policy }]);
    expect(result.findings.some(item => item.mechanism.includes("second validation"))).toBe(false);
  }
});

test("absent policy never gets inferred from behavior; missing events stay unknown", () => {
  const usage = meter();
  const result = explainMechanisms([{ arm: "current", usage }]);
  expect(result.findings.some(item => item.mechanism.includes("early reviewer"))).toBe(false);
  expect(reviewPolicy("Review completed work promptly.", "policy").gated_review).toBe(false);
  usage.sessions = [];
  const missing = explainMechanisms([{ arm: "current", usage }]);
  expect(missing.findings).toEqual([]);
  expect(mechanismsMarkdown(missing)).toContain("Accounting alone is not a causal explanation");
});

test("quoted instructions, encrypted messages, continuation chunks and duplicate commands do not fabricate events", () => {
  const execution = command(4, "rtk shadowtree test", "ok example/pkg 0.1s", 2);
  const trace = workflowTrace([
    call(0, "spawn_agent", { message: "main done: please run bun test" }),
    command(1, 'echo "go test and shadowtree test"'),
    { timestamp: timestamp(2), type: "response_item", payload: { type: "agent_message", content: [{ type: "encrypted_content", encrypted_content: "private" }] } },
    { timestamp: timestamp(3), type: "response_item", payload: { type: "custom_tool_call_output", output: [{ type: "text", text: '{"wall_time_seconds":1,"output":"ok example/pkg 4s"}' }] } },
    execution, execution,
  ], "source.jsonl", [3, 5, 7, 9, 11, 13]);
  expect(trace.events.filter(event => event.kind === "test")).toEqual([expect.objectContaining({ kind: "test", seconds: 2, package_seconds: 0.1, line: 11, wrapper: "shadowtree" })]);
  expect(trace.encrypted_messages).toBe(1);
  expect(JSON.stringify(trace)).not.toContain("private");
});

test("compound exit codes do not certify individual tests", () => {
  const trace = workflowTrace([
    command(1, "cat source.ts; touch unrelated.ts"),
    command(2, "bun test; true", "FAIL"),
  ], "source");
  expect(trace.events.some(event => event.kind === "test" && event.exit_code === 0)).toBe(false);
});

test("literal helper scripts expose single tests without evaluating logged shell", () => {
  const trace = workflowTrace([
    command(1, "shell bash $'cat go.mod\\nhcat parser.ts\\ngit status --short\\n'"),
    command(2, "shell bash $'rtk shadowtree test ./... -run=TestParser -count=1'", "ok example/pkg 0.1s", 2),
    command(3, "shell bash $'cat \\x70arser.ts'"),
  ], "source");
  expect(trace.events.filter(event => event.kind === "test")).toEqual([expect.objectContaining({ kind: "test", wrapper: "shadowtree", seconds: 2, package_seconds: 0.1 })]);
});

test("quoted commands, heredocs and conditional code are not execution evidence", () => {
  for (const text of [
    "printf '%s' 'example;cat parser.ts'",
    'printf "%s" "instructions\nbun test\ncat parser.ts"',
    "cat <<'EOF'\ncat parser.ts\nbun test\nEOF",
    "if false; then\ncat parser.ts\nbun test\nfi",
    "# example;cat parser.ts\n# bun test",
    "exit 0; cat parser.ts; bun test",
    "cat missing.ts; true",
  ]) {
    const trace = workflowTrace([command(1, text)], "source");
    expect(trace.events.filter(event => event.kind !== "command")).toEqual([]);
  }
});

test("request accounting explains token and cost deltas without claiming causality", () => {
  const stock = meter([]);
  const current = meter([]);
  stock.agents = [{
    model: "gpt-6-astra", thread_id: "root", method: "token_usage_record",
    usage: { input_tokens: 12_014_814, cached_input_tokens: 11_797_632, cache_write_input_tokens: 0,
      output_tokens: 80_754, reasoning_output_tokens: 37_750, total_tokens: 12_095_568 },
    estimated_api_usd: 18.007152, request_count: 81, mean_input_tokens: 148_331.037, max_input_tokens: 222_598,
    cost_components: { uncached_input_usd: 2.171820, cached_input_usd: 11.797632, cache_write_input_usd: 0, output_usd: 4.037700 },
  }];
  current.agents = [{
    model: "gpt-6-astra", thread_id: "root", method: "token_usage_record",
    usage: { input_tokens: 15_880_034, cached_input_tokens: 15_542_784, cache_write_input_tokens: 0,
      output_tokens: 75_737, reasoning_output_tokens: 36_828, total_tokens: 15_955_771 },
    estimated_api_usd: 22.702134, request_count: 100, mean_input_tokens: 158_800.34, max_input_tokens: 237_947,
    cost_components: { uncached_input_usd: 3.372500, cached_input_usd: 15.542784, cache_write_input_usd: 0, output_usd: 3.786850 },
  }];
  const finding = explainMechanisms([{ arm: "stock", usage: stock }, { arm: "current", usage: current }]).findings
    .find(item => item.mechanism === "Extra workflow turns repeatedly process accumulated context");
  expect(finding?.explanation).toContain("a difference of 3,865,220");
  expect(finding?.explanation).toContain("75.5%");
  expect(finding?.explanation).toContain("+$3.745152 cached input");
  expect(finding?.explanation).toContain("-$0.250850 output");
  expect(finding?.limitation).toContain("not a causal counterfactual");

  stock.agents[0]!.usage.input_tokens = 100;
  stock.agents[0]!.request_count = 1;
  current.agents[0]!.usage.input_tokens = 100;
  current.agents[0]!.request_count = 2;
  current.agents[0]!.cost_components.cache_write_input_usd = 5;
  const equalInput = explainMechanisms([{ arm: "stock", usage: stock }, { arm: "current", usage: current }]).findings.at(-1)!;
  expect(equalInput.explanation).toContain("components cancel");
  expect(equalInput.explanation).not.toContain("Infinity");
  expect(equalInput.explanation).toContain("+$5.000000 cache writes");

  current.agents[0]!.usage.input_tokens = 150;
  const lowerMean = explainMechanisms([{ arm: "stock", usage: stock }, { arm: "current", usage: current }]).findings.at(-1)!;
  expect(lowerMean.explanation).toContain("approximately 87.5 tokens");
  expect(lowerMean.explanation).toContain("-37.5 tokens");
  expect(lowerMean.explanation).not.toContain("higher mean");
});
