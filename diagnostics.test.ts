import { expect, test } from "bun:test";
import { performanceComparison, performanceMarkdown, sessionDiagnostics } from "./diagnostics";
import type { MeteredRollouts } from "./usage";

function event(type: string, id: string, seconds?: number, name = "exec") {
  return {
    type: "response_item",
    ...(seconds === undefined ? {} : { timestamp: new Date(seconds * 1000).toISOString() }),
    payload: { type, call_id: id, name },
  };
}

test("tool timing unions overlapping spans and counts missing evidence separately", () => {
  const result = sessionDiagnostics("child", [
    { type: "session_meta", payload: { parent_thread_id: "root", agent_role: "review-correctness" } },
    event("custom_tool_call", "a", 0),
    event("function_call", "b", 1, "wait_agent"),
    event("custom_tool_call_output", "a", 3),
    event("function_call_output", "b", 5),
    event("function_call_output", "b", 6),
    event("custom_tool_call", "missing", undefined),
    event("custom_tool_call_output", "missing", 10),
  ]);
  expect(result.tool_calls).toBe(3);
  expect(result.matched_tool_calls).toBe(2);
  expect(result.tool_timing_complete).toBe(false);
  expect(result.observed_tool_blocked_seconds).toBe(5);
  expect(result.observed_tool_seconds_by_name).toEqual({ exec: 3, wait_agent: 4 });
  expect(result.parent_thread_id).toBe("root");
});

test("additional outputs mark first-output timing as partial", () => {
  const result = sessionDiagnostics("root", [
    event("custom_tool_call", "a", 0),
    event("custom_tool_call_output", "a", 1),
    event("custom_tool_call_output", "a", 5),
  ]);
  expect(result.observed_tool_blocked_seconds).toBe(1);
  expect(result.matched_tool_calls).toBe(1);
  expect(result.tool_timing_complete).toBe(false);
});

test("negative timestamp spans are not treated as elapsed time", () => {
  const result = sessionDiagnostics("root", [
    event("custom_tool_call", "a", 5),
    event("custom_tool_call_output", "a", 1),
  ]);
  expect(result.observed_tool_blocked_seconds).toBe(0);
  expect(result.tool_timing_complete).toBe(false);
});

test("incomplete usage cannot produce apparently complete differences or cost components", () => {
  const usage: MeteredRollouts = {
    complete: false, warnings: [], sessions: [], agents: [],
    totals: {
      input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0,
      output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0,
      estimated_api_usd: 0, command_seconds: 0,
    },
  };
  const arms = [{ arm: "stock", usage }, { arm: "current", usage }];
  const delta = performanceComparison(arms)!.current_minus_stock;
  expect(delta.total_tokens).toBeNull();
  expect(delta.estimated_api_usd).toBeNull();
  expect(delta.by_role.root.total_tokens).toBeNull();
  expect(delta.by_role.children.estimated_api_usd).toBeNull();
  expect(Object.values(delta.cost_components)).toEqual([null, null, null, null]);
  expect(performanceMarkdown(arms)).toContain("| stock | unknown | unknown | unknown | unknown |");
});
