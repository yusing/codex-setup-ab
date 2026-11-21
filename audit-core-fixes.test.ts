import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMekugiProviderUsage, costRankingEligible, meterRollouts, type PricingSnapshot } from "./usage";

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map(dir => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

const pricing: PricingSnapshot = {
  fetched_at: "2026-11-20T00:00:00.000Z",
  source: "test",
  models: {
    "gpt-6-astra": {
      prompt: 0.000002,
      input_cache_read: 0.0000005,
      input_cache_write: 0,
      completion: 0.000008,
      overrides: [],
    },
  },
  warnings: [],
};

describe("core harness audit regression checks", () => {
  test("applyMekugiProviderUsage rejects uncaptured unreconciled_cumulative threads and preserves partial rollout errors", async () => {
    const home = await tempDir("codex-ab-usage-audit-");
    const sessions = join(home, "sessions");
    await mkdir(sessions, { recursive: true });

    await writeFile(join(sessions, "rollout-main.jsonl"), [
      JSON.stringify({ type: "session_meta", payload: { id: "thread-main" } }),
      JSON.stringify({ type: "turn_context", payload: { model: "gpt-6-astra" } }),
      JSON.stringify({ type: "token_usage_record", payload: { response_id: "r1", thread_id: "thread-main", usage: { input_tokens: 100, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 0, total_tokens: 120 } } }),
    ].join("\n") + "\n");
    await writeFile(join(sessions, "rollout-child.jsonl"), [
      JSON.stringify({ type: "session_meta", payload: { id: "thread-child", parent_thread_id: "thread-main" } }),
      JSON.stringify({ type: "turn_context", payload: { model: "gpt-6-astra" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 50, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0, total_tokens: 60 } } } }),
    ].join("\n") + "\n");

    const metered = await meterRollouts(home, pricing);
    expect(metered.unreconciled_cumulative?.map(item => item.thread_id)).toEqual(["thread-child"]);

    const attempt = (input: number, output: number) => [{
      model: "gpt-6-astra",
      status: "completed",
      usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: output, reasoning_tokens: 0 },
    }];

    const err = applyMekugiProviderUsage(metered, {
      exchanges: [{ sequence: 1, request_kind: "turn", thread_id: "thread-main", model: "gpt-6-astra", provider_attempts: attempt(100, 20) }],
    }, pricing, true);
    expect(err).toContain("thread-child");

    await writeFile(join(sessions, "rollout-broken.jsonl"), "{not-json\n");
    const broken = await meterRollouts(home, pricing);
    const applied = applyMekugiProviderUsage(broken, {
      exchanges: [
        { sequence: 1, request_kind: "turn", thread_id: "thread-main", model: "gpt-6-astra", provider_attempts: attempt(100, 20) },
        { sequence: 2, request_kind: "turn", thread_id: "thread-child", model: "gpt-6-astra", provider_attempts: attempt(50, 10) },
      ],
    }, pricing, true);
    expect(applied).toBeNull();
    expect(broken.observation_validity).toBe("partial");
    expect(broken.request_coverage).toBe("unverified");
    expect(costRankingEligible(broken)).toBe(false);
  });
});
