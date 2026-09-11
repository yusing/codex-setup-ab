import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchPricing,
  meterRollouts,
  type ModelPricing,
  type PricingSnapshot,
  type Usage,
} from "./usage";

const temporaryHomes: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryHomes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function usage(overrides: Partial<Usage> = {}): Usage {
  return {
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
    ...overrides,
  };
}

function rate(overrides: Partial<ModelPricing> = {}): ModelPricing {
  return {
    model_id: "test-model",
    source: "test",
    prompt: 0.001,
    completion: 0.01,
    input_cache_read: 0.0001,
    input_cache_write: 0.00125,
    overrides: [],
    ...overrides,
  };
}

function pricing(models: Record<string, ModelPricing>): PricingSnapshot {
  return {
    fetched_at: "2026-09-09T00:00:00.000Z",
    source: "fallback",
    catalog_url: "test://catalog",
    assumptions: [],
    warnings: [],
    models,
  };
}

async function homeWith(files: Record<string, unknown[]>): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "usage-test-"));
  temporaryHomes.push(home);
  for (const [name, events] of Object.entries(files)) {
    const path = join(home, "sessions", name);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  }
  return home;
}

function meta(id: string, parent?: string) {
  return { type: "session_meta", payload: { id, ...(parent ? { parent_thread_id: parent } : {}) } };
}

function model(name: string) {
  return { type: "turn_context", payload: { model: name } };
}

function record(threadId: string, responseId: unknown, requestUsage: Usage, threadUsage = requestUsage) {
  return {
    type: "token_usage_record",
    payload: {
      thread_id: threadId,
      response_id: responseId,
      usage: requestUsage,
      thread_token_usage: threadUsage,
      turn_token_usage: threadUsage,
    },
  };
}

describe("meterRollouts", () => {
  test("meters main and child once, retaining the latest cumulative response record", async () => {
    const mainFirst = usage({ input_tokens: 100, output_tokens: 10, reasoning_output_tokens: 4, total_tokens: 110 });
    const mainLatest = usage({ input_tokens: 120, cached_input_tokens: 20, output_tokens: 12, reasoning_output_tokens: 5, total_tokens: 132 });
    const child = usage({ input_tokens: 50, output_tokens: 5, reasoning_output_tokens: 2, total_tokens: 55 });
    const home = await homeWith({
      "main.jsonl": [
        meta("main"),
        model("test-model"),
        record("main", "main-response", mainFirst, mainFirst),
        record("main", "main-response", mainLatest, usage({ input_tokens: 220, output_tokens: 22, total_tokens: 242 })),
        // Orchestration can surface the child's record in the parent; the child's own file wins.
        record("child", { response: { id: "child-response" } }, child),
        // A cumulative compatibility event, including its orchestrated aggregate, must not be
        // added when request records are available.
        { type: "event_msg", payload: { type: "token_count", info: {
          total_token_usage: usage({ input_tokens: 9_999, total_tokens: 9_999 }),
          orchestrated_role_token_usage: [{ usage: child }],
        } } },
        { type: "event_msg", payload: { type: "item_completed", item: { type: "CommandExecution", id: "cmd-main", duration: { secs: 1, nanos: 500_000_000 } } } },
      ],
      "child.jsonl": [
        meta("child", "main"),
        model("child-model"),
        record("child", "child-response", child),
        { type: "event_msg", payload: { type: "item_completed", item: { type: "CommandExecution", id: "cmd-child", duration: 0.25 } } },
      ],
    });

    const result = await meterRollouts(home, pricing({ "test-model": rate(), "child-model": rate({ model_id: "child-model" }) }));

    expect(result.complete).toBe(true);
    expect(result.agents).toHaveLength(2);
    expect(result.agents.find((agent) => agent.thread_id === "main")?.usage).toEqual(mainLatest);
    expect(result.agents.find((agent) => agent.thread_id === "child")?.usage).toEqual(child);
    expect(result.totals.input_tokens).toBe(170);
    expect(result.totals.output_tokens).toBe(17);
    expect(result.totals.reasoning_output_tokens).toBe(7);
    expect(result.totals.command_seconds).toBeCloseTo(1.75);
  });

  test("uses only the latest cumulative token_count and labels request pricing approximate", async () => {
    const home = await homeWith({
      "fallback.jsonl": [
        meta("fallback"),
        model("test-model"),
        { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: usage({ input_tokens: 10, output_tokens: 2, total_tokens: 12 }) } } },
        { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: usage({ input_tokens: 25, output_tokens: 5, total_tokens: 30 }) } } },
      ],
    });
    const result = await meterRollouts(home, pricing({ "test-model": rate() }));

    expect(result.agents[0].usage.input_tokens).toBe(25);
    expect(result.agents[0].method).toBe("token_count.total_token_usage (request-cost approximation)");
    expect(result.warnings.join("\n")).toContain("priced as one request");
  });

  test("chooses long-context rates per request and does not bill reasoning twice", async () => {
    const below = usage({ input_tokens: 200_000, output_tokens: 10, reasoning_output_tokens: 8, total_tokens: 200_010 });
    const atThreshold = usage({ input_tokens: 272_000, output_tokens: 10, reasoning_output_tokens: 8, total_tokens: 272_010 });
    const home = await homeWith({
      "tiers.jsonl": [
        meta("tiers"),
        model("tiered"),
        record("tiers", "one", below),
        record("tiers", "two", below),
        record("tiers", "three", atThreshold),
      ],
    });
    const tiered = rate({
      model_id: "tiered",
      source: "fallback:tiered",
      prompt: 0.000001,
      completion: 0.00001,
      input_cache_read: 0,
      input_cache_write: 0,
      overrides: [{ min_prompt_tokens: 272_000, prompt: 0.000002, completion: 0.00002 }],
    });

    const result = await meterRollouts(home, pricing({ tiered }));
    // Two 200k requests use base pricing; only the 272k request uses the override.
    // output_tokens already contains the reasoning subset, so 24 reasoning tokens add no extra cost.
    expect(result.agents[0].estimated_api_usd).toBeCloseTo(2 * (0.2 + 0.0001) + (0.544 + 0.0002), 10);
    expect(result.agents[0].usage.reasoning_output_tokens).toBe(24);
  });

  test("uses OpenRouter's strict long-context boundary while fallback remains inclusive", async () => {
    const equal = usage({ input_tokens: 272_000, total_tokens: 272_000 });
    const above = usage({ input_tokens: 272_001, total_tokens: 272_001 });
    const home = await homeWith({
      "openrouter-tier.jsonl": [
        meta("openrouter-tier"),
        model("openrouter-tier"),
        record("openrouter-tier", "equal", equal),
        record("openrouter-tier", "above", above),
      ],
    });
    const openrouter = rate({
      model_id: "openrouter-tier",
      source: "openrouter:openai/openrouter-tier",
      prompt: 0.000001,
      completion: 0,
      overrides: [{
        min_prompt_tokens: 272_000,
        min_prompt_tokens_exclusive: true,
        prompt: 0.000002,
      }],
    });

    const result = await meterRollouts(home, pricing({ "openrouter-tier": openrouter }));
    expect(result.agents[0].estimated_api_usd).toBeCloseTo(0.272 + 0.544002, 10);
  });

  test("marks a discovered completed session with no usable usage as unknown", async () => {
    const home = await homeWith({
      "no-usage.jsonl": [
        meta("no-usage"),
        model("test-model"),
        { type: "event_msg", payload: { type: "task_complete", message: "done" } },
      ],
    });

    const result = await meterRollouts(home, pricing({ "test-model": rate() }));
    expect(result.agents).toEqual([]);
    expect(result.totals.estimated_api_usd).toBeNull();
    expect(result.complete).toBe(false);
    expect(result.warnings.join("\n")).toContain("session has no usable token usage");
  });

  test("distinguishes a zero price from absent and incomplete prices", async () => {
    const one = usage({ input_tokens: 1, output_tokens: 1, total_tokens: 2 });
    const home = await homeWith({
      "free.jsonl": [meta("free"), model("free"), record("free", "free-r", one)],
      "partial.jsonl": [meta("partial"), model("partial"), record("partial", "partial-r", one)],
      "unknown.jsonl": [meta("unknown"), model("unknown"), record("unknown", "unknown-r", one)],
    });
    const free = rate({ model_id: "free", prompt: 0, completion: 0, input_cache_read: 0, input_cache_write: 0 });
    const partial = rate({ model_id: "partial", prompt: 0, completion: null, input_cache_read: 0, input_cache_write: 0 });
    const result = await meterRollouts(home, pricing({ free, partial }));

    expect(result.agents.find((agent) => agent.model === "free")?.estimated_api_usd).toBe(0);
    expect(result.agents.find((agent) => agent.model === "partial")?.estimated_api_usd).toBeNull();
    expect(result.agents.find((agent) => agent.model === "unknown")?.estimated_api_usd).toBeNull();
    expect(result.totals.estimated_api_usd).toBeNull();
    expect(result.complete).toBe(false);
  });

  test("keeps valid records but marks partial JSONL and partial usage incomplete", async () => {
    const home = await homeWith({
      "partial.jsonl": [
        meta("partial"),
        model("test-model"),
        record("partial", "valid", usage({ input_tokens: 2, total_tokens: 2 })),
        { type: "token_usage_record", payload: { thread_id: "partial", response_id: "bad", usage: { input_tokens: 4 } } },
      ],
    });
    await writeFile(join(home, "sessions", "partial.jsonl"), "{bad json\n", { flag: "a" });
    const result = await meterRollouts(home, pricing({ "test-model": rate() }));

    expect(result.totals.input_tokens).toBe(2);
    expect(result.complete).toBe(false);
    expect(result.warnings.some((warning) => warning.includes("invalid JSONL"))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("cached_input_tokens is missing"))).toBe(true);
  });
});

test("fetchPricing falls back with exact stock rates and serializable provenance", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(new Error("offline for test"))) as typeof fetch;
  try {
    const snapshot = await fetchPricing();
    expect(snapshot.source).toBe("fallback");
    expect(snapshot.models["gpt-6-astra"].prompt).toBe(10 / 1_000_000);
    expect(snapshot.models["gpt-5.6-sol"].completion).toBe(20 / 1_000_000);
    expect(snapshot.models["gpt-5.6-terra"].overrides[0].min_prompt_tokens).toBe(272_000);
    expect(snapshot.models["gpt-5.6-luna"].input_cache_write).toBe(0.25 / 1_000_000);
    expect(snapshot.warnings.join("\n")).toContain("offline for test");
    expect(() => JSON.stringify(snapshot)).not.toThrow();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("explicit exclusions remove deduplicated requests and commands without cumulative fallback", async () => {
  const consumed = usage({ input_tokens: 100, output_tokens: 10, total_tokens: 110 });
  const home = await homeWith({
    "main.jsonl": [
      meta("main"), model("test-model"),
      record("main", "keep", consumed),
      record("child", "remove", consumed),
      { type: "event_msg", payload: { type: "item_completed", item: { type: "CommandExecution", id: "diagnose", duration: 6 } } },
    ],
    "child.jsonl": [
      meta("child", "main"), model("test-model"),
      record("child", "remove", consumed),
      { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: consumed } } },
    ],
  });
  const prices = pricing({ "test-model": rate() });
  const original = await meterRollouts(home, prices);
  const adjusted = await meterRollouts(home, prices, { response_ids: ["remove"], command_ids: ["diagnose"] });
  expect(adjusted.complete).toBe(true);
  expect(adjusted.totals.total_tokens).toBe(110);
  expect(adjusted.totals.estimated_api_usd).toBeCloseTo(original.totals.estimated_api_usd! / 2);
  expect(adjusted.totals.command_seconds).toBe(0);
  expect(adjusted.agents.find(agent => agent.thread_id === "child")?.usage.total_tokens).toBe(0);
  await expect(meterRollouts(home, prices, { response_ids: ["missing"], command_ids: [] })).rejects.toThrow("excluded response not found");
  await expect(meterRollouts(home, prices, { response_ids: [], command_ids: ["missing"] })).rejects.toThrow("excluded command not found");
});
