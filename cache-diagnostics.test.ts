import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performanceComparison, performanceMarkdown } from "./diagnostics";
import { applyMekugiProviderUsage, meterRollouts, type PricingSnapshot, type Usage } from "./usage";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

const pricing: PricingSnapshot = {
  fetched_at: "2026-09-25T00:00:00Z", source: "fallback", catalog_url: "test://prices",
  assumptions: [], warnings: [], models: Object.fromEntries(["model-a", "model-b"].map(model => [model, {
    model_id: model, source: "test", prompt: 0.001, completion: 0.01,
    input_cache_read: 0.0001, input_cache_write: 0.00125, overrides: [],
  }])),
};

function usage(input: number, cached = 0): Usage {
  return { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0,
    output_tokens: 0, reasoning_output_tokens: 0, total_tokens: input };
}
function record(id: string, value: Usage, thread = "root") {
  return { type: "token_usage_record", payload: { thread_id: thread, response_id: id,
    usage: value, thread_token_usage: value, turn_token_usage: value } };
}
function model(name = "model-a") {
  return { type: "turn_context", payload: { model: name } };
}
async function homeWith(events: unknown[]) {
  const home = await mkdtemp(join(tmpdir(), "cache-diagnostics-test-"));
  homes.push(home);
  await mkdir(join(home, "sessions"));
  await writeFile(join(home, "sessions", "root.jsonl"), [
    { type: "session_meta", payload: { id: "root" } }, model(), ...events,
  ].map(event => JSON.stringify(event)).join("\n") + "\n");
  return home;
}
async function metered(inputs: number[], cached = inputs.map(() => 0)) {
  return meterRollouts(await homeWith(inputs.map((input, i) => record(`r${i}`, usage(input, cached[i])))), pricing);
}
function attempt(input: number, cached = 0, status = "completed") {
  return { model: "model-a", status, usage: { input_tokens: input, cached_input_tokens: cached,
    output_tokens: 0, reasoning_tokens: 0 } };
}

test("observed five-request gap is first-request cache behavior, with prewarm outside paired totals", async () => {
  const stock = await metered([18473, 19127, 26503, 27645, 28503], [12160, 18304, 18944, 26368, 27520]);
  const currentInputs = [18015, 18703, 26144, 26804, 27708];
  const currentCached = [0, 17792, 18560, 25984, 26624];
  const current = await metered(currentInputs, currentCached);
  expect(applyMekugiProviderUsage(current, { exchanges: [
    { sequence: 0, thread_id: "root", request_kind: "prewarm", provider_attempts: [attempt(12091)] },
    ...currentInputs.map((input, i) => ({ sequence: i + 1, thread_id: "root", request_kind: "turn",
      provider_attempts: [attempt(input, currentCached[i])] })),
  ] }, pricing)).toBeNull();
  const arms = [{ arm: "stock", usage: stock }, { arm: "current", usage: current }];
  expect(performanceComparison(arms)!.current_minus_stock.uncached_input_by_phase)
    .toEqual({ first_requests: 11702, later_requests: -243 });
  expect((current.totals.input_tokens - current.totals.cached_input_tokens)
    - (stock.totals.input_tokens - stock.totals.cached_input_tokens)).toBe(11459);
  expect(current.cache_usage?.prewarm).toMatchObject({ usage: usage(12091), request_count: 1 });
  expect(current.cache_usage?.prewarm?.estimated_api_usd).toBeCloseTo(12.091);
  expect(current.cache_usage?.requests).toHaveLength(5);
  expect(stock.cache_usage?.prewarm).toBeNull();
  const markdown = performanceMarkdown(arms).toLowerCase();
  expect(markdown).toContain("first");
  expect(markdown).toContain("later");
  expect(markdown).toContain("prewarm");
  expect(markdown).toMatch(/unknown|not observed|unavailable/);
});

test("cumulative-only or incomplete evidence leaves both phase deltas unknown", async () => {
  const cumulative = await meterRollouts(await homeWith([
    { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: usage(100, 40) } } },
  ]), pricing);
  expect(cumulative.cache_usage?.requests).toBeNull();
  const precise = await metered([100], [40]);
  for (const current of [cumulative, { ...precise, complete: false }]) {
    expect(performanceComparison([{ arm: "stock", usage: precise }, { arm: "current", usage: current }])!
      .current_minus_stock.uncached_input_by_phase).toEqual({ first_requests: null, later_requests: null });
  }
});

test("changing models within a thread does not create a second first request", async () => {
  const stock = await metered([100, 200], [0, 100]);
  const current = await meterRollouts(await homeWith([
    record("first", usage(110)), model("model-b"), record("second", usage(220, 100)),
  ]), pricing);
  expect(current.agents).toHaveLength(2);
  expect(performanceComparison([{ arm: "stock", usage: stock }, { arm: "current", usage: current }])!
    .current_minus_stock.uncached_input_by_phase).toEqual({ first_requests: 10, later_requests: 20 });
});

test("rollout request evidence deduplicates updates without reordering and excludes removed responses", async () => {
  const home = await homeWith([
    record("first", usage(90)), record("second", usage(200, 100)),
    record("first", usage(100)), record("excluded", usage(900)),
  ]);
  const result = await meterRollouts(home, pricing, { response_ids: ["excluded"], command_ids: [] });
  expect(result.cache_usage).toEqual({ requests: [
    { thread_id: "root", model: "model-a", usage: usage(100) },
    { thread_id: "root", model: "model-a", usage: usage(200, 100) },
  ], prewarm: null });
  expect(result.totals.input_tokens).toBe(300);
});

test("capture replaces rollout evidence with metered retry attempts and separate prewarm", async () => {
  const result = await metered([100, 200]);
  expect(applyMekugiProviderUsage(result, { exchanges: [
    { sequence: 1, thread_id: "root", request_kind: "prewarm", provider_attempts: [attempt(90)] },
    { sequence: 2, thread_id: "root", request_kind: "turn", provider_attempts: [attempt(100)] },
    { sequence: 3, thread_id: "root", request_kind: "turn", provider_attempts: [
      attempt(180, 100, "failed"), { model: "model-a", status: "failed" }, attempt(200, 180),
    ] },
  ] }, pricing)).toBeNull();
  expect(result.cache_usage?.requests).toEqual([100, 180, 200].map((input, i) => ({
    thread_id: "root", model: "model-a", usage: usage(input, [0, 100, 180][i]),
  })));
  expect(result.cache_usage?.prewarm).toEqual({ usage: usage(90), request_count: 1, estimated_api_usd: 0.09 });
  expect(result.totals.input_tokens).toBe(480);
  expect(result.codex_visible_requests).toEqual({ root: 2 });
});

test("invalid capture preserves all rollout evidence atomically", async () => {
  const result = await metered([100]);
  const before = structuredClone(result);
  expect(applyMekugiProviderUsage(result, { exchanges: [
    { sequence: 1, thread_id: "root", request_kind: "prewarm", provider_attempts: [attempt(90)] },
    { sequence: 2, thread_id: "root", request_kind: "turn", provider_attempts: [attempt(100)] },
    { sequence: 3, thread_id: "root", request_kind: "turn", provider_attempts: [{ model: "model-a", status: "completed" }] },
  ] }, pricing)).not.toBeNull();
  expect(result).toEqual(before);
});

test("provider completion order cannot change the first-request phase", async () => {
  const stock = await metered([100, 200]);
  const current = await metered([100, 200]);
  const metrics = { exchanges: [
    { sequence: 2, thread_id: "root", request_kind: "turn", provider_attempts: [attempt(200)] },
    { sequence: 1, thread_id: "root", request_kind: "turn", provider_attempts: [attempt(100)] },
  ] };
  const before = structuredClone(metrics);
  expect(applyMekugiProviderUsage(current, metrics, pricing)).toBeNull();
  expect(metrics).toEqual(before);
  expect(current.cache_usage?.requests?.map(request => request.usage.input_tokens)).toEqual([100, 200]);
  expect(performanceComparison([{ arm: "stock", usage: stock }, { arm: "current", usage: current }])!
    .current_minus_stock.uncached_input_by_phase).toEqual({ first_requests: 0, later_requests: 0 });

  for (const sequence of [undefined, 2]) {
    const ambiguous = { exchanges: [metrics.exchanges[0], { ...metrics.exchanges[1], sequence }] };
    expect(applyMekugiProviderUsage(current, ambiguous, pricing)).toBeNull();
    expect(current.cache_usage?.requests).toBeNull();
    expect(current.totals.input_tokens).toBe(300);
  }
});
