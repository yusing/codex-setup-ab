import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionDiagnostics } from "./diagnostics";
import {
  applyMekugiProviderUsage,
  fetchPricing,
  meterGrokHome,
  meterRollouts,
  readMekugiNativeCost,
  type MeteredRollouts,
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

test("native Mekugi cost reads compact and table reports but not incomplete usage", async () => {
  const home = await mkdtemp(join(tmpdir(), "mekugi-cost-test-"));
  temporaryHomes.push(home);
  const path = join(home, "codex.jsonl");
  const event = (text: string) => JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } });
  await writeFile(path, `${event("ordinary agent answer")}\n${event("Router session usage · Main turn: 356.2K in / 3.9K out, $0.4987 · Total: 356.2K in / 3.9K out, $0.4987 · Mentor gpt-6-astra → gpt-6-sol")}\n`);
  expect(await readMekugiNativeCost(path)).toBe(0.4987);
  const table = "Router session usage\n\n| Agent | Role | Model | Input (cache hit) | Cache write | Output | Reasoning | Input cost (cached + uncached) | Output cost | Total cost | Missing usage |\n| Total | — | — | 356.2K (80.0%) | 0 | 3.9K | 1.4K | $0.3000+$0.1000=$0.4000 | $0.0987 | $0.4987 | 0 |\n\nRouter session API estimates since router startup; reasoning is included in output, and cache writes are included in input.";
  await writeFile(path, `${event(table)}\n`);
  expect(await readMekugiNativeCost(path)).toBe(0.4987);
  await writeFile(path, `${event("Router session usage · Main turn: 10 in / 2 out, cost n/a · Total: 10 in / 2 out, cost n/a")}\n`);
  expect(await readMekugiNativeCost(path)).toBeNull();
  await writeFile(path, `${event(table.replace("$0.4987 | 0 |", "cost n/a | 1 |"))}\n`);
  expect(await readMekugiNativeCost(path)).toBeNull();
  const exported = join(home, "token-metrics.md");
  const typesafe = "\n\n## TypeSafe AI usage\n\n| Agent | Model | Requests | Input | Output | Missing usage | Cost |\n| Total TypeSafe | fixture | 1 | 10 | 2 | 0 | n/a |\n";
  await writeFile(exported, `${table.replace("$0.4987 | 0 |", "$1.2345 | 0 |")}${typesafe}`);
  expect(await readMekugiNativeCost(path, exported)).toBe(1.2345);
  expect(await readMekugiNativeCost(path, join(home, "missing.md"))).toBeNull();
  await writeFile(path, `${event(table)}\n`);
  expect(await readMekugiNativeCost(path, join(home, "missing.md"))).toBe(0.4987);
});

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
    expect(result.agents.find(agent => agent.thread_id === "main")?.request_count).toBe(1);
    expect(result.agents.find(agent => agent.thread_id === "main")?.mean_input_tokens).toBe(120);
    expect(result.agents.find(agent => agent.thread_id === "child")?.request_count).toBe(1);
    expect(result.sessions.find(session => session.thread_id === "child")?.parent_thread_id).toBe("main");
    expect(result.agents.find(agent => agent.thread_id === "main")?.cost_components).toEqual({
      uncached_input_usd: 0.1, cached_input_usd: 0.002, cache_write_input_usd: 0, output_usd: 0.12,
    });
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
    expect(result.agents[0].request_count).toBeNull();
    expect(result.agents[0].mean_input_tokens).toBeNull();
    expect(result.agents[0].max_input_tokens).toBeNull();
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
    expect(snapshot.models["gpt-6-sol"].completion).toBe(10 / 1_000_000);
    expect(snapshot.models["gpt-6-sol"].overrides[0].completion).toBe(15 / 1_000_000);
    expect(snapshot.models["gpt-6-luna"].input_cache_write).toBe(0.125 / 1_000_000);
    expect(snapshot.models["gpt-6-luna"].overrides[0].input_cache_write).toBe(0.25 / 1_000_000);
    // Retain older list rates for pricing historical runs with recorded models.
    expect(snapshot.models["gpt-5.6-sol"].completion).toBe(20 / 1_000_000);
    expect(snapshot.models["gpt-5.6-terra"].overrides[0].min_prompt_tokens).toBe(272_000);
    expect(snapshot.models["gpt-5.6-luna"].input_cache_write).toBe(0.25 / 1_000_000);
    expect(snapshot.models["grok-4.7"].prompt).toBe(1.6 / 1_000_000);
    expect(snapshot.models["grok:grok-4.7"].completion).toBe(4.8 / 1_000_000);
    expect(snapshot.models["grok-4.7"].overrides[0]).toMatchObject({
      min_prompt_tokens: 200_000, min_prompt_tokens_exclusive: false,
      prompt: 3.2 / 1_000_000, completion: 9.6 / 1_000_000, input_cache_read: 0.8 / 1_000_000,
    });
    expect(snapshot.warnings.join("\n")).toContain("offline for test");
    expect(() => JSON.stringify(snapshot)).not.toThrow();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("meterGrokHome prices the current Grok build alias from aggregate usage", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-ab-grok-usage-"));
  await mkdir(join(home, "sessions/workspace/session"), { recursive: true });
  await writeFile(join(home, "sessions/workspace/session/usage.json"), JSON.stringify({
    sessionId: "grok-session",
    session: { inputTokens: 100, outputTokens: 20, cachedReadTokens: 10, cacheCreationTokens: 0, reasoningTokens: 5, totalTokens: 120, modelCalls: 2, primaryModelId: "grok-4.7-build" },
  }));
  const result = await meterGrokHome(home, pricing({ "grok-4.7": {
    model_id: "grok-4.7", source: "fallback:grok-4.7", prompt: 1.6 / 1_000_000, completion: 4.8 / 1_000_000, input_cache_read: 0.4 / 1_000_000, input_cache_write: null, overrides: [],
  } }));
  expect(result.complete).toBe(true);
  expect(result.totals.input_tokens).toBe(100);
  expect(result.totals.cached_input_tokens).toBe(10);
  expect(result.totals.output_tokens).toBe(20);
  expect(result.agents[0]?.model).toBe("grok-4.7-build");
  expect(result.agents[0]?.max_input_tokens).toBeNull();
  expect(result.agents[0]?.method).toBe("grok_usage.session (list-price estimate)");
  expect(result.totals.estimated_api_usd).toBeCloseTo((90 * 1.6 + 10 * 0.4 + 20 * 4.8) / 1_000_000);
});

test("meterGrokHome uses complete provider cost instead of applying tiers to session totals", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-ab-grok-provider-cost-"));
  await mkdir(join(home, "sessions/workspace/session"), { recursive: true });
  await writeFile(join(home, "sessions/workspace/session/usage.json"), JSON.stringify({
    sessionId: "grok-provider-session",
    session: { inputTokens: 250_000, outputTokens: 1_000, cachedReadTokens: 200_000, cacheCreationTokens: 0, reasoningTokens: 500, totalTokens: 251_000, modelCalls: 4, primaryModelId: "grok-4.6-build", costUsdTicks: 1_234_567_890 },
  }));
  const result = await meterGrokHome(home, pricing({ "grok-4.6": {
    model_id: "grok-4.6", source: "fallback:grok-4.6", prompt: 2 / 1_000_000, completion: 6 / 1_000_000, input_cache_read: 0.5 / 1_000_000, input_cache_write: null,
    overrides: [{ min_prompt_tokens: 200_000, min_prompt_tokens_exclusive: false, prompt: 4 / 1_000_000, completion: 12 / 1_000_000, input_cache_read: 1 / 1_000_000 }],
  } }));
  expect(result.complete).toBe(true);
  expect(result.totals.estimated_api_usd).toBeCloseTo(0.123456789);
  expect(result.totals.command_seconds).toBeNull();
  expect(result.agents[0]?.method).toBe("grok_usage.session (provider-recorded cost)");
  expect(result.agents[0]?.max_input_tokens).toBeNull();
  expect(Object.values(result.agents[0]!.cost_components).every(value => value === null)).toBe(true);
});

test("meterGrokHome marks an unpriced session incomplete", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-ab-grok-unpriced-"));
  await mkdir(join(home, "sessions/workspace/session"), { recursive: true });
  await writeFile(join(home, "sessions/workspace/session/usage.json"), JSON.stringify({
    sessionId: "grok-unpriced-session",
    session: { inputTokens: 100, outputTokens: 20, cachedReadTokens: 10, cacheCreationTokens: 0, reasoningTokens: 5, totalTokens: 120, modelCalls: 2, primaryModelId: "unknown-grok" },
  }));
  const result = await meterGrokHome(home, pricing({}));
  expect(result.complete).toBe(false);
  expect(result.totals.estimated_api_usd).toBeNull();
  expect(result.warnings.join("\n")).toContain("no API price for Grok model unknown-grok");
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

describe("applyMekugiProviderUsage", () => {
  const attempt = (input: number, cached: number, output: number, model = "gpt-6-sol") => ({
    model, status: "completed", usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_tokens: 1 },
  });
  const rollout = (): MeteredRollouts => ({
    complete: true, warnings: [],
    sessions: [sessionDiagnostics("root", [{ type: "session_meta", payload: { id: "root" } }], "root.jsonl")],
    agents: [{
      model: "gpt-6-sol", thread_id: "root", method: "token_usage_record",
      usage: usage({ input_tokens: 300, cached_input_tokens: 200, output_tokens: 30, total_tokens: 330 }),
      estimated_api_usd: null, request_count: 2, mean_input_tokens: 150, max_input_tokens: 200,
      cost_components: { uncached_input_usd: null, cached_input_usd: null, cache_write_input_usd: null, output_usd: null },
    }],
    totals: { ...usage({ input_tokens: 300, cached_input_tokens: 200, output_tokens: 30, total_tokens: 330 }), estimated_api_usd: null, command_seconds: 1.5 },
  });

  test("counts router-side attempts, excludes prewarm, and records Codex-visible requests", () => {
    const metered = rollout();
    expect(applyMekugiProviderUsage(metered, { exchanges: [
      { sequence: 1, request_kind: "prewarm", thread_id: "root", provider_attempts: [attempt(90, 0, 0)] },
      { sequence: 2, request_kind: "turn", thread_id: "root", provider_attempts: [attempt(100, 0, 10)] },
      { sequence: 3, request_kind: "turn", thread_id: "root", provider_attempts: [attempt(180, 100, 5), attempt(200, 180, 20)] },
      { sequence: 4, request_kind: "turn", thread_id: "root", provider_attempts: [{ model: "gpt-6-sol", status: "failed" }] },
    ] })).toBeNull();
    expect(metered.agents).toHaveLength(1);
    expect(metered.agents[0]).toMatchObject({
      method: "mekugi_capture.provider_attempts", request_count: 3, mean_input_tokens: 160, max_input_tokens: 200,
      usage: usage({ input_tokens: 480, cached_input_tokens: 280, output_tokens: 35, reasoning_output_tokens: 3, total_tokens: 515 }),
    });
    expect(metered.totals).toMatchObject({ input_tokens: 480, total_tokens: 515, command_seconds: 1.5 });
    expect(metered.codex_visible_requests).toEqual({ root: 2 });
    expect(metered.warnings.at(-1)).toContain("3 validated provider attempts, excluding prewarm; the Codex rollout recorded 2 requests and 300 input tokens");
  });

  test("keeps rollout usage when capture and rollout disagree or usage is incomplete", () => {
    const cases: Array<[unknown, string]> = [
      [{}, "no provider exchanges"],
      [{ exchanges: [{ sequence: 2, request_kind: "turn", thread_id: "other", provider_attempts: [attempt(1, 0, 1)] }] }, "capture thread other has no Codex rollout"],
      [{ exchanges: [{ sequence: 1, request_kind: "prewarm", thread_id: "root", provider_attempts: [attempt(1, 0, 0)] }] }, "rollout thread root has no captured provider attempts"],
      [{ exchanges: [{ sequence: 2, request_kind: "turn", thread_id: "root", provider_attempts: [{ model: "gpt-6-sol", status: "completed" }] }] }, "exchange 2 has a provider attempt without complete usage"],
    ];
    for (const [metrics, reason] of cases) {
      const metered = rollout();
      expect(applyMekugiProviderUsage(metered, metrics)).toContain(reason);
      expect(metered.agents[0]!.request_count).toBe(2);
      expect(metered.totals.input_tokens).toBe(300);
      expect(metered.codex_visible_requests).toBeUndefined();
    }
  });
});
