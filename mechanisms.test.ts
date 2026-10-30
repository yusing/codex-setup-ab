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
    .find(item => item.mechanism === "current: extra workflow turns repeatedly process accumulated context");
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
  expect(lowerMean.explanation).not.toContain("did not record");

  current.codex_visible_requests = { root: 1 };
  const hidden = explainMechanisms([{ arm: "stock", usage: stock }, { arm: "current", usage: current }]).findings.at(-1)!;
  expect(hidden.explanation).toContain("1 of the current parent's 2 requests were provider attempts that Codex did not record");
  expect(hidden.evidence[0]).toContain("Validated Mekugi provider attempts");
});

test("request accounting compares every additional arm with stock", () => {
  const agent = (input: number, requests: number) => ({
    model: "gpt-6-astra", thread_id: "root", method: "token_usage_record" as const,
    usage: { input_tokens: input, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: input },
    estimated_api_usd: 0, request_count: requests, mean_input_tokens: input / requests, max_input_tokens: input,
    cost_components: { uncached_input_usd: 0, cached_input_usd: 0, cache_write_input_usd: 0, output_usd: 0 },
  });
  const [stock, current, third] = [meter([]), meter([]), meter([])];
  stock.agents = [agent(100, 1)];
  current.agents = [agent(300, 2)];
  third.agents = [agent(600, 3)];
  const findings = explainMechanisms([{ arm: "stock", usage: stock }, { arm: "current", usage: current }, { arm: "arm-3", usage: third }],
    { stock: "Stock", current: "Current", "arm-3": "Third" }).findings;
  expect(findings.map(item => item.mechanism)).toEqual([
    "Current: extra workflow turns repeatedly process accumulated context",
    "Third: extra workflow turns repeatedly process accumulated context",
  ]);
  expect(findings[1]!.explanation).toContain("Third parent made 3 model requests versus 1 for Stock");
  expect(findings[1]!.explanation).toContain("a difference of 500");
});

const tracker = "/tmp/task-runtime.X/mekugi-tools-1/exec-track.sh";
const envelope = `:; __mekugi_b() { return $?; }; __mekugi_e() { return $?; }; [ ! -r '${tracker}' ] || . '${tracker}'; `;

test("Mekugi-instrumented scripts expose launcher-wrapped tests", () => {
  const segments = (scripts: string[]) => envelope + scripts.map((script, index) => `{ __mekugi_b ${index} && :; ${script}; __mekugi_e ${index} && :; }`).join("; ");
  const trace = workflowTrace([
    command(1, segments(["skills-mgr get golang-best-practices", "skills-mgr run use-modern-go/scripts/run-tool.sh list --go-version 1.26"])),
    command(2, envelope + "mrun --max-tokens 6000 go test . -count=1", "ok example/pkg 0.3s", 2),
    command(3, envelope + "mrun --max-tokens=5000 -- go test . -count=1"),
    command(4, segments(["rtk test go test ./..."])),
    command(5, envelope + "mrun -n 40 --tail rtk proxy shadowtree test ./pkg", "ok example/pkg 0.1s", 3),
    command(6, envelope + "rtk bypass bun test"),
  ], "source");
  expect(trace.events.filter(event => event.kind === "test")).toEqual([
    expect.objectContaining({ line: 2, seconds: 2, package_seconds: 0.3, exit_code: 0 }),
    expect.objectContaining({ line: 3 }),
    expect.objectContaining({ line: 4 }),
    expect.objectContaining({ line: 5, wrapper: "shadowtree", package_seconds: 0.1 }),
    expect.objectContaining({ line: 6 }),
  ]);
});

test("inexact envelopes and invalid launcher options stay unclassified", () => {
  for (const text of [
    envelope.replace(`. '${tracker}'`, `. '/other/exec-track.sh'`) + "go test ./...",
    envelope.replace(`'${tracker}'`, tracker).replace(`'${tracker}'`, tracker) + "go test ./...",
    envelope.replace("__mekugi_e() { return $?; }; ", "") + "go test ./...",
    envelope + "mrun go test ./...",
    envelope + "mrun --max-tokens 0 go test ./...",
    envelope + "mrun --tail -- go test ./...",
    envelope + "mrun -n 5 -n 6 go test ./...",
    envelope + "{ __mekugi_b 0 && :; go test ./...; __mekugi_e 0 && :; }; { __mekugi_b 1 && :; true; __mekugi_e 1 && :; }",
  ]) {
    expect(workflowTrace([command(1, text)], "source").events.filter(event => event.kind === "test")).toEqual([]);
  }
});

test("a sole test ending a ; or && list is recognized, with && failures left unattributed", () => {
  const exited = (time: number, text: string, exitCode: number, output = "") => {
    const event = command(time, text, output, 2);
    (event.payload.item as { exit_code: number }).exit_code = exitCode;
    return event;
  };
  const trace = workflowTrace([
    exited(1, "shadowtree fmt; mrun --max-tokens 4500 go test . -count=1", 1, "FAIL"),
    exited(2, "shadowtree fmt && mrun --max-tokens 4500 rtk proxy shadowtree test .", 0, "ok example/pkg 0.4s"),
    exited(3, "shadowtree fmt &&\n  go test ./...", 1, "FAIL"),
    exited(4, envelope + "{ __mekugi_b 0 && :; shadowtree fmt; __mekugi_e 0 && :; } && { __mekugi_b 1 && :; mrun --max-tokens 7000 rtk proxy go test . -count=1; __mekugi_e 1 && :; }", 0),
  ], "source");
  expect(trace.events.filter(event => event.kind === "test")).toEqual([
    expect.objectContaining({ line: 1, exit_code: 1, wrapper: undefined }),
    // The record's duration also covers `shadowtree fmt`, so it is not the test's duration.
    expect.objectContaining({ line: 2, exit_code: 0, wrapper: "shadowtree", package_seconds: 0.4, seconds: undefined }),
    expect.objectContaining({ line: 3, exit_code: undefined }),
    expect.objectContaining({ line: 4, exit_code: 0, wrapper: undefined }),
  ]);
});

test("lists with a non-final test, two tests, || or other operators stay unclassified", () => {
  for (const text of [
    "go test ./... && shadowtree fmt",
    "go test ./...; true",
    "shadowtree fmt; go test ./...; bun test",
    "go test ./a && go test ./b",
    "shadowtree fmt || go test ./...",
    "shadowtree fmt & go test ./...",
    "shadowtree fmt | go test ./...",
    "shadowtree fmt && && go test ./...",
    "go build ./... &&",
    "exit 0; go test ./...",
  ]) {
    expect(workflowTrace([command(1, text)], "source").events.filter(event => event.kind === "test")).toEqual([]);
  }
});
