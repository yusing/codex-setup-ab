import { expect, test } from "bun:test";
import { explainResources, resourceExplanationMarkdown } from "./assessment-explanation";
import { sessionDiagnostics } from "./diagnostics";
import type { MeteredRollouts } from "./usage";

function usage(input: number, output: number, requests: number | null): MeteredRollouts {
  const totals = { input_tokens: input, output_tokens: output, total_tokens: input + output,
    cached_input_tokens: 0, cache_write_input_tokens: 0, reasoning_output_tokens: 0 };
  return { complete: true, warnings: [], totals: { ...totals, estimated_api_usd: null, command_seconds: null },
    sessions: [sessionDiagnostics("root", [{ type: "session_meta", payload: {} }])],
    agents: [{ thread_id: "root", model: "gpt-6.1-sol", method: "token_usage_record", usage: totals,
      estimated_api_usd: null, request_count: requests, mean_input_tokens: requests ? input / requests : null,
      max_input_tokens: null, cost_components: { uncached_input_usd: null, cached_input_usd: null, cache_write_input_usd: null, output_usd: null } }] };
}

test("resource explanations distinguish requests, replayed context and output for every selected arm", () => {
  const comparisons = explainResources([
    { arm: "stock", label: "Direct", usage: usage(1000, 100, 2) },
    { arm: "current", label: "Mekugi old", usage: usage(3000, 80, 3) },
    { arm: "arm-3", label: "Mekugi new", usage: usage(500, 150, 1) },
  ]);
  expect(comparisons).toHaveLength(2);
  expect(comparisons[0]!.summary).toContain("1,980 more tokens");
  expect(comparisons[0]!.drivers.join(" ")).toContain("+2,000 input tokens and −20 output tokens");
  expect(comparisons[0]!.drivers.join(" ")).toContain("Mean input per request was 1,000 vs 500");
  expect(comparisons[1]!.summary).toContain("450 fewer tokens");
  expect(resourceExplanationMarkdown(comparisons)).toContain("cannot identify an instruction's effect");
});

test("missing request evidence stays unknown even when aggregate usage is complete", () => {
  const a = usage(1000, 100, null);
  const b = usage(1000, 100, 2);
  expect(explainResources([{ arm: "a", label: "A", usage: a }, { arm: "b", label: "B", usage: b }])[0])
    .toMatchObject({ summary: "B and A used the same total tokens (1,100 each).", drivers: expect.arrayContaining([expect.stringContaining("counts and mean context sizes are unknown")]) });
  a.complete = false;
  expect(explainResources([{ arm: "a", label: "A", usage: a }, { arm: "b", label: "B", usage: b }])[0]!.drivers).toEqual([]);
});

test("delegation and provider-only attempts remain separate observed contributors", () => {
  const a = usage(1000, 100, 2), b = usage(3000, 100, 4);
  b.sessions[0]!.parent_thread_id = "parent";
  b.codex_visible_requests = { root: 2 };
  const text = explainResources([{ arm: "a", label: "Direct", usage: a }, { arm: "b", label: "Router", usage: b }])[0]!.drivers.join(" ");
  expect(text).toContain("Delegated agents used 3,100 tokens for Router vs 0 for Direct");
  expect(text).toContain("2 attempts were absent from Codex's request log");
  expect(text).toContain("Counts alone do not distinguish retries");
});
