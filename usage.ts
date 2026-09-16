import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { sessionDiagnostics, type SessionDiagnostics } from "./diagnostics";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const OPENROUTER_TIMEOUT_MS = 8_000;
const GROK_LONG_CONTEXT_TOKENS = 200_000;
const GROK_USD_TICKS_PER_DOLLAR = 10_000_000_000;
const LONG_CONTEXT_TOKENS = 272_000;

export const USAGE_KEYS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
] as const;

export type Usage = Record<(typeof USAGE_KEYS)[number], number>;

export interface PriceOverride {
  min_prompt_tokens: number;
  /** OpenRouter activates overrides strictly above its threshold; stock fallback tiers use >=. */
  min_prompt_tokens_exclusive?: boolean;
  prompt?: number | null;
  completion?: number | null;
  input_cache_read?: number | null;
  input_cache_write?: number | null;
}

export interface ModelPricing {
  model_id: string;
  source: string;
  /** All prices are USD per token. A null price is unknown; zero is a known free tier. */
  prompt: number | null;
  completion: number | null;
  input_cache_read: number | null;
  input_cache_write: number | null;
  overrides: PriceOverride[];
}

export interface PricingSnapshot {
  fetched_at: string;
  source: "openrouter+fallback" | "fallback";
  catalog_url: string;
  assumptions: string[];
  warnings: string[];
  models: Record<string, ModelPricing>;
}

export interface CostComponents {
  uncached_input_usd: number | null;
  cached_input_usd: number | null;
  cache_write_input_usd: number | null;
  output_usd: number | null;
}

export interface AgentUsage {
  model: string;
  thread_id: string;
  method: "token_usage_record" | "token_count.total_token_usage (request-cost approximation)" | "grok_usage.session (provider-recorded cost)" | "grok_usage.session (list-price estimate)";
  usage: Usage;
  estimated_api_usd: number | null;
  request_count: number | null;
  mean_input_tokens: number | null;
  max_input_tokens: number | null;
  cost_components: CostComponents;
}

export interface MeteredRollouts {
  sessions: SessionDiagnostics[];
  agents: AgentUsage[];
  totals: Usage & {
    estimated_api_usd: number | null;
    command_seconds: number | null;
  };
  warnings: string[];
  complete: boolean;
}

type JsonObject = Record<string, unknown>;

interface SessionFile {
  path: string;
  threadId: string;
  events: JsonObject[];
  lines: number[];
}

interface UsageCandidate {
  key: string | null;
  fileThreadId: string;
  ownerThreadId: string;
  model: string;
  usage: Usage;
}

interface RequestUsage {
  threadId: string;
  model: string;
  usage: Usage;
  excluded?: boolean;
}

const FALLBACK_USD_PER_MILLION: Record<string, {
  prompt: number;
  completion: number;
  input_cache_read: number;
  input_cache_write?: number;
  long_prompt?: number;
  long_completion?: number;
  long_input_cache_read?: number;
  long_input_cache_write?: number;
}> = {
  "gpt-6-astra": { prompt: 10, completion: 50, input_cache_read: 1, input_cache_write: 12.5, long_prompt: 20, long_completion: 75, long_input_cache_read: 2, long_input_cache_write: 25 },
  "gpt-6-astra-pro": { prompt: 10, completion: 50, input_cache_read: 1, input_cache_write: 12.5, long_prompt: 20, long_completion: 75, long_input_cache_read: 2, long_input_cache_write: 25 },
  "gpt-5.6-sol": { prompt: 4, completion: 20, input_cache_read: 0.4, input_cache_write: 5, long_prompt: 8, long_completion: 30, long_input_cache_read: 0.8, long_input_cache_write: 10 },
  "gpt-5.6-terra": { prompt: 2, completion: 12, input_cache_read: 0.2, input_cache_write: 2.5, long_prompt: 4, long_completion: 18, long_input_cache_read: 0.4, long_input_cache_write: 5 },
  "gpt-5.6-luna": { prompt: 0.2, completion: 1.2, input_cache_read: 0.02, input_cache_write: 0.25, long_prompt: 0.4, long_completion: 1.8, long_input_cache_read: 0.04, long_input_cache_write: 0.5 },
  "grok-4.6": { prompt: 2, completion: 6, input_cache_read: 0.5, long_prompt: 4, long_completion: 12, long_input_cache_read: 1 },
  "grok:grok-4.6": { prompt: 2, completion: 6, input_cache_read: 0.5, long_prompt: 4, long_completion: 12, long_input_cache_read: 1 },
};

function emptyUsage(): Usage {
  return {
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
  };
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function addUsage(target: Usage, source: Usage): void {
  for (const key of USAGE_KEYS) target[key] += source[key];
}

function usageFrom(value: unknown, context: string, warnings: string[]): Usage | null {
  if (!isObject(value)) {
    warnings.push(`${context}: missing usage object`);
    return null;
  }
  const usage = emptyUsage();
  let valid = true;
  for (const key of USAGE_KEYS) {
    const tokenCount = value[key];
    if (typeof tokenCount !== "number" || !Number.isSafeInteger(tokenCount) || tokenCount < 0) {
      warnings.push(`${context}: ${key} is missing or invalid`);
      valid = false;
      continue;
    }
    usage[key] = tokenCount;
  }
  return valid ? usage : null;
}

function modelSlug(model: string): string {
  return model.trim().toLowerCase().split("/").at(-1) ?? "";
}

function fallbackPricing(model: string, rates: (typeof FALLBACK_USD_PER_MILLION)[string]): ModelPricing {
  const perToken = (rate: number) => rate / 1_000_000;
  const overrides: PriceOverride[] = [];
  if (rates.long_prompt !== undefined) {
    overrides.push({
      min_prompt_tokens: model.includes("grok-4.6") ? GROK_LONG_CONTEXT_TOKENS : LONG_CONTEXT_TOKENS,
      min_prompt_tokens_exclusive: !model.includes("grok-4.6"),
      prompt: perToken(rates.long_prompt),
      completion: perToken(rates.long_completion!),
      input_cache_read: perToken(rates.long_input_cache_read!),
      ...(rates.long_input_cache_write !== undefined ? { input_cache_write: perToken(rates.long_input_cache_write) } : {}),
    });
  }
  return {
    model_id: model,
    source: `fallback:${model}`,
    prompt: perToken(rates.prompt),
    completion: perToken(rates.completion),
    input_cache_read: perToken(rates.input_cache_read),
    input_cache_write: rates.input_cache_write === undefined ? null : perToken(rates.input_cache_write),
    overrides,
  };
}

function nullablePrice(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

function openRouterPricing(item: JsonObject): ModelPricing | null {
  const id = typeof item.id === "string" ? item.id : "";
  if (!id || id.toLowerCase().includes(":batch") || !isObject(item.pricing)) return null;
  const overrides: PriceOverride[] = [];
  if (Array.isArray(item.pricing.overrides)) {
    for (const raw of item.pricing.overrides) {
      if (!isObject(raw) || typeof raw.min_prompt_tokens !== "number" || raw.min_prompt_tokens <= 0) continue;
      overrides.push({
        min_prompt_tokens: raw.min_prompt_tokens,
        min_prompt_tokens_exclusive: true,
        ...(Object.hasOwn(raw, "prompt") ? { prompt: nullablePrice(raw.prompt) } : {}),
        ...(Object.hasOwn(raw, "completion") ? { completion: nullablePrice(raw.completion) } : {}),
        ...(Object.hasOwn(raw, "input_cache_read") ? { input_cache_read: nullablePrice(raw.input_cache_read) } : {}),
        ...(Object.hasOwn(raw, "input_cache_write") ? { input_cache_write: nullablePrice(raw.input_cache_write) } : {}),
      });
    }
  }
  return {
    model_id: id,
    source: `openrouter:${id}`,
    prompt: nullablePrice(item.pricing.prompt),
    completion: nullablePrice(item.pricing.completion),
    input_cache_read: nullablePrice(item.pricing.input_cache_read),
    input_cache_write: nullablePrice(item.pricing.input_cache_write),
    overrides,
  };
}

/** Capture one reproducible pricing input for both A/B arms. */
export async function fetchPricing(): Promise<PricingSnapshot> {
  const models: Record<string, ModelPricing> = {};
  for (const [model, rates] of Object.entries(FALLBACK_USD_PER_MILLION)) {
    models[model] = fallbackPricing(model, rates);
  }

  const warnings: string[] = [];
  let fetchedCatalog = false;
  try {
    const response = await fetch(OPENROUTER_MODELS_URL, {
      headers: { Accept: "application/json", "User-Agent": "codex-ab-benchmark" },
      signal: AbortSignal.timeout(OPENROUTER_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body: unknown = await response.json();
    if (!isObject(body) || !Array.isArray(body.data)) throw new Error("catalog response has no data array");
    fetchedCatalog = true;
    for (const item of body.data) {
      if (!isObject(item)) continue;
      const parsed = openRouterPricing(item);
      if (!parsed) continue;
      const fullId = parsed.model_id.toLowerCase();
      models[fullId] = parsed;
      const slug = modelSlug(fullId);
      const existing = models[slug];
      if (!existing || fullId === slug || fullId === `openai/${slug}`) models[slug] = parsed;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`OpenRouter pricing unavailable; stock-model fallback rates used (${message})`);
  }

  return {
    fetched_at: new Date().toISOString(),
    source: fetchedCatalog ? "openrouter+fallback" : "fallback",
    catalog_url: OPENROUTER_MODELS_URL,
    assumptions: [
      "Prices are public list API rates in USD per token, not ChatGPT or Codex subscription rates.",
      "Each request selects its own long-context tier; OpenRouter overrides apply strictly above min_prompt_tokens, embedded OpenAI fallback tiers apply at or above 272000 input tokens, and the Grok fallback tier applies at or above 200000 input tokens.",
      "Input includes cached input, cache writes are billed separately, and reasoning is already a subset of output.",
      "OpenRouter values take precedence when an exact model slug is available; embedded stock rates are the fallback.",
      "A missing price remains null; an explicit zero is retained as a known zero rate.",
    ],
    warnings,
    models,
  };
}

async function jsonlPaths(root: string): Promise<string[]> {
  const paths: string[] = [];
  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) paths.push(path);
    }
  }
  await visit(join(root, "sessions"));
  await visit(join(root, "archived_sessions"));
  return paths.sort();
}

function responseKey(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const nested = responseKey(JSON.parse(trimmed));
        if (nested) return nested;
      } catch {
        // Ordinary response IDs are opaque strings, not JSON.
      }
    }
    return trimmed;
  }
  if (!isObject(value)) return null;
  for (const key of ["response", "response_id", "id"]) {
    if (Object.hasOwn(value, key)) {
      const nested = responseKey(value[key]);
      if (nested) return nested;
    }
  }
  return null;
}

function durationSeconds(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (!isObject(value)) return null;
  const seconds = typeof value.secs === "number" ? value.secs : 0;
  const nanos = typeof value.nanos === "number" ? value.nanos : 0;
  if (!Number.isFinite(seconds) || !Number.isFinite(nanos) || seconds < 0 || nanos < 0) return null;
  return seconds + nanos / 1e9;
}

function ratesFor(pricing: PricingSnapshot, model: string): ModelPricing | null {
  const normalized = model.trim().toLowerCase();
  const withoutProvider = normalized.replace(/^grok:/, "");
  const withoutBuildAlias = withoutProvider.replace(/^(grok-4\.6)-build$/, "$1");
  return pricing.models[normalized] ?? pricing.models[modelSlug(normalized)]
    ?? pricing.models[withoutProvider] ?? pricing.models[withoutBuildAlias] ?? null;
}

function requestCost(usage: Usage, rates: ModelPricing): CostComponents {
  let prompt = rates.prompt;
  let completion = rates.completion;
  let cacheRead = rates.input_cache_read;
  let cacheWrite = rates.input_cache_write;
  for (const override of [...rates.overrides].sort((a, b) => a.min_prompt_tokens - b.min_prompt_tokens)) {
    const belowBoundary = override.min_prompt_tokens_exclusive
      ? usage.input_tokens <= override.min_prompt_tokens
      : usage.input_tokens < override.min_prompt_tokens;
    if (belowBoundary) continue;
    if (Object.hasOwn(override, "prompt")) prompt = override.prompt ?? null;
    if (Object.hasOwn(override, "completion")) completion = override.completion ?? null;
    if (Object.hasOwn(override, "input_cache_read")) cacheRead = override.input_cache_read ?? null;
    if (Object.hasOwn(override, "input_cache_write")) cacheWrite = override.input_cache_write ?? null;
  }
  const uncached = Math.max(usage.input_tokens - usage.cached_input_tokens, 0);
  const cost = (tokens: number, price: number | null): number | null =>
    tokens === 0 ? 0 : price === null || !Number.isFinite(price) ? null : tokens * price;
  return {
    uncached_input_usd: cost(uncached, prompt),
    cached_input_usd: cost(usage.cached_input_tokens, cacheRead),
    cache_write_input_usd: cost(usage.cache_write_input_tokens, cacheWrite),
    output_usd: cost(usage.output_tokens, completion),
  };
}

export interface MeterExclusions {
  response_ids: string[];
  command_ids: string[];
}

/** Meter every rollout in a dedicated per-arm Codex home. */
export async function meterRollouts(codexHome: string, pricing: PricingSnapshot, exclusions?: MeterExclusions): Promise<MeteredRollouts> {
  const warnings = [...pricing.warnings];
  let complete = true;
  const files: SessionFile[] = [];
  let paths: string[] = [];
  try {
    paths = await jsonlPaths(codexHome);
  } catch (error) {
    warnings.push(`cannot enumerate rollout files: ${error instanceof Error ? error.message : String(error)}`);
    complete = false;
  }

  for (const path of paths) {
    let contents: string;
    try {
      contents = await readFile(path, "utf8");
    } catch (error) {
      warnings.push(`${path}: cannot read rollout (${error instanceof Error ? error.message : String(error)})`);
      complete = false;
      continue;
    }
    const events: JsonObject[] = [];
    const eventLines: number[] = [];
    const lines = contents.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index].trim()) continue;
      try {
        const event: unknown = JSON.parse(lines[index]);
        if (!isObject(event)) throw new Error("event is not an object");
        events.push(event);
        eventLines.push(index + 1);
      } catch (error) {
        warnings.push(`${path}:${index + 1}: invalid JSONL (${error instanceof Error ? error.message : String(error)})`);
        complete = false;
      }
    }
    const metaEvent = events.find((event) => event.type === "session_meta" && isObject(event.payload));
    const meta = metaEvent && isObject(metaEvent.payload) ? metaEvent.payload : null;
    const threadId = typeof meta?.id === "string" ? meta.id : typeof meta?.session_id === "string" ? meta.session_id : "";
    if (!threadId) {
      warnings.push(`${path}: missing session_meta thread id`);
      complete = false;
      continue;
    }
    files.push({ path, threadId, events, lines: eventLines });
  }

  if (files.length === 0) {
    warnings.push("no readable Codex rollout sessions found");
    complete = false;
  }

  const knownThreads = new Set(files.map((file) => file.threadId));
  const candidates: UsageCandidate[] = [];
  const fallbackByThread = new Map<string, Pick<RequestUsage, "model" | "usage">>();
  const modelsSeenByThread = new Map<string, Set<string>>();
  const commandIds = new Set<string>();
  let commandSeconds = 0;

  for (const file of files) {
    let currentModel = "unknown";
    for (const event of file.events) {
      const payload = isObject(event.payload) ? event.payload : {};
      if (event.type === "turn_context" && typeof payload.model === "string") currentModel = payload.model;
      if (event.type === "world_state" && isObject(payload.state) && typeof payload.state.model === "string") currentModel = payload.state.model;
      if (currentModel !== "unknown") {
        const seen = modelsSeenByThread.get(file.threadId) ?? new Set<string>();
        seen.add(currentModel);
        modelsSeenByThread.set(file.threadId, seen);
      }

      if (event.type === "token_usage_record") {
        const usage = usageFrom(payload.usage, `${file.path}: token_usage_record`, warnings);
        if (!usage) {
          complete = false;
          continue;
        }
        const declared = typeof payload.thread_id === "string" ? payload.thread_id : typeof payload.session_id === "string" ? payload.session_id : file.threadId;
        const ownerThreadId = knownThreads.has(declared) ? declared : file.threadId;
        const key = responseKey(payload.response_id);
        if (!key) {
          warnings.push(`${file.path}: token_usage_record has no usable response_id; cross-rollout deduplication is not guaranteed`);
          complete = false;
        }
        candidates.push({ key, fileThreadId: file.threadId, ownerThreadId, model: currentModel, usage });
      }

      if (event.type === "event_msg" && payload.type === "token_count" && isObject(payload.info)) {
        const usage = usageFrom(payload.info.total_token_usage, `${file.path}: token_count.total_token_usage`, warnings);
        if (usage) fallbackByThread.set(file.threadId, { model: currentModel, usage });
        else complete = false;
      }

      if (event.type === "event_msg" && payload.type === "item_completed" && isObject(payload.item) && payload.item.type === "CommandExecution") {
        const id = typeof payload.item.id === "string" ? payload.item.id : null;
        if (id && commandIds.has(id)) continue;
        const duration = durationSeconds(payload.item.duration);
        if (duration === null) {
          warnings.push(`${file.path}: completed command has missing or invalid duration`);
          complete = false;
        } else {
          if (!id || !exclusions?.command_ids.includes(id)) commandSeconds += duration;
          if (id) commandIds.add(id);
        }
      }
    }
  }

  const chosen = new Map<string, UsageCandidate>();
  const requests: RequestUsage[] = [];
  for (const candidate of candidates) {
    if (!candidate.key) {
      requests.push({ threadId: candidate.ownerThreadId, model: candidate.model, usage: candidate.usage });
      continue;
    }
    const prior = chosen.get(candidate.key);
    if (!prior) {
      chosen.set(candidate.key, candidate);
      continue;
    }
    const candidateDirect = candidate.fileThreadId === candidate.ownerThreadId ? 1 : 0;
    const priorDirect = prior.fileThreadId === prior.ownerThreadId ? 1 : 0;
    if (candidate.ownerThreadId !== prior.ownerThreadId) {
      warnings.push(`response_id ${candidate.key} names conflicting owning threads; using the best direct record`);
      complete = false;
    }
    if (candidateDirect > priorDirect || (candidateDirect === priorDirect && candidate.usage.total_tokens >= prior.usage.total_tokens)) {
      chosen.set(candidate.key, candidate);
    }
  }
  for (const id of exclusions?.response_ids ?? []) {
    if (!chosen.has(id)) throw new Error(`excluded response not found: ${id}`);
  }
  for (const id of exclusions?.command_ids ?? []) {
    if (!commandIds.has(id)) throw new Error(`excluded command not found: ${id}`);
  }
  // Keep a zero-valued owner record to prevent cumulative fallback from
  // restoring excluded usage, including when all of a thread's requests go.
  for (const candidate of chosen.values()) requests.push({
    threadId: candidate.ownerThreadId, model: candidate.model,
    excluded: exclusions?.response_ids.includes(candidate.key!) ?? false,
    usage: exclusions?.response_ids.includes(candidate.key!) ? emptyUsage() : candidate.usage,
  });


  const threadsWithRecords = new Set(requests.map((request) => request.threadId));
  for (const [threadId, fallback] of fallbackByThread) {
    if (threadsWithRecords.has(threadId)) continue;
    requests.push({ threadId, model: fallback.model, usage: fallback.usage });
    warnings.push(`${threadId}: token_count.total_token_usage is cumulative and priced as one request; long-context cost is approximate`);
    const models = modelsSeenByThread.get(threadId);
    if (models && models.size > 1) {
      warnings.push(`${threadId}: cumulative token_count cannot be split across ${models.size} models`);
      complete = false;
    }
  }

  const meteredThreads = new Set(requests.map((request) => request.threadId));
  let hasUnmeteredThread = files.length === 0;
  for (const threadId of knownThreads) {
    if (meteredThreads.has(threadId)) continue;
    warnings.push(`${threadId}: session has no usable token usage; API cost is unknown`);
    complete = false;
    hasUnmeteredThread = true;
  }

  const groups = new Map<string, { threadId: string; model: string; usage: Usage; requests: Usage[]; approximate: boolean }>();
  for (const request of requests) {
    const key = `${request.threadId}\u0000${request.model}`;
    let group = groups.get(key);
    if (!group) {
      group = { threadId: request.threadId, model: request.model, usage: emptyUsage(), requests: [], approximate: !threadsWithRecords.has(request.threadId) };
      groups.set(key, group);
    }
    addUsage(group.usage, request.usage);
    if (!request.excluded) group.requests.push(request.usage);
  }

  const agents: AgentUsage[] = [];
  for (const group of groups.values()) {
    const rates = ratesFor(pricing, group.model);
    let estimated: number | null = 0;
    const costs: CostComponents = { uncached_input_usd: 0, cached_input_usd: 0, cache_write_input_usd: 0, output_usd: 0 };
    if (!rates) {
      for (const key of Object.keys(costs) as Array<keyof CostComponents>) costs[key] = null;
      estimated = null;
      warnings.push(`${group.threadId}/${group.model}: no API price for model`);
      complete = false;
    } else {
      for (const request of group.requests) {
        const components = requestCost(request, rates);
        for (const key of Object.keys(costs) as Array<keyof CostComponents>) {
          if (components[key] === null) costs[key] = null;
          else if (costs[key] !== null) costs[key] += components[key];
        }
      }
      const values = Object.values(costs);
      if (values.some(value => value === null)) {
        estimated = null;
        warnings.push(`${group.threadId}/${group.model}: required API price component is missing`);
        complete = false;
      } else {
        estimated = values.reduce<number>((total, value) => total + value!, 0);
      }
    }
    agents.push({
      model: group.model,
      thread_id: group.threadId,
      method: group.approximate ? "token_count.total_token_usage (request-cost approximation)" : "token_usage_record",
      usage: group.usage,
      request_count: group.approximate ? null : group.requests.length,
      mean_input_tokens: group.approximate || group.requests.length === 0 ? null : group.usage.input_tokens / group.requests.length,
      max_input_tokens: group.approximate || group.requests.length === 0 ? null : group.requests.reduce((peak, request) => Math.max(peak, request.input_tokens), 0),
      cost_components: costs,
      estimated_api_usd: estimated,
    });
  }
  agents.sort((a, b) => a.thread_id.localeCompare(b.thread_id) || a.model.localeCompare(b.model));

  const usageTotals = emptyUsage();
  let estimatedTotal: number | null = 0;
  for (const agent of agents) {
    addUsage(usageTotals, agent.usage);
    if (agent.estimated_api_usd === null) estimatedTotal = null;
    else if (estimatedTotal !== null) estimatedTotal += agent.estimated_api_usd;
  }
  if (hasUnmeteredThread) estimatedTotal = null;

  return {
    agents,
    sessions: files.map(file => sessionDiagnostics(file.threadId, file.events, file.path, file.lines)),
    totals: { ...usageTotals, estimated_api_usd: estimatedTotal, command_seconds: commandSeconds },
    warnings: [...new Set(warnings)],
    complete,
  };
}

export async function meterGrokHome(grokHome: string, pricing: PricingSnapshot): Promise<MeteredRollouts> {
  const warnings = [...pricing.warnings];
  const usagePath = join(grokHome, "sessions");
  const agents: AgentUsage[] = [];
  const totals = emptyUsage();
  let estimatedTotal: number | null = 0;
  let complete = true;
  let found = false;
  const markIncomplete = (warning: string): void => {
    warnings.push(warning);
    complete = false;
    estimatedTotal = null;
  };
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name === "usage.json") {
        found = true;
        let parsed: unknown;
        try { parsed = JSON.parse(await readFile(path, "utf8")); }
        catch (error) {
          markIncomplete(`${path}: cannot parse Grok usage (${error instanceof Error ? error.message : String(error)})`);
          continue;
        }
        if (!isObject(parsed) || !isObject(parsed.session)) {
          markIncomplete(`${path}: Grok usage.json has no session totals`);
          continue;
        }
        const session = parsed.session;
        const model = typeof session.primaryModelId === "string" ? session.primaryModelId : "grok-4.6";
        const usage: Usage = {
          input_tokens: typeof session.inputTokens === "number" ? session.inputTokens : 0,
          cached_input_tokens: typeof session.cachedReadTokens === "number" ? session.cachedReadTokens : 0,
          cache_write_input_tokens: typeof session.cacheCreationTokens === "number" ? session.cacheCreationTokens : 0,
          output_tokens: typeof session.outputTokens === "number" ? session.outputTokens : 0,
          reasoning_output_tokens: typeof session.reasoningTokens === "number" ? session.reasoningTokens : 0,
          total_tokens: typeof session.totalTokens === "number" ? session.totalTokens : 0,
        };
        if ([session.inputTokens, session.outputTokens, session.totalTokens].some(value => typeof value !== "number")) {
          markIncomplete(`${path}: Grok usage totals are incomplete`);
        }
        const modelCalls = typeof session.modelCalls === "number" && Number.isSafeInteger(session.modelCalls) && session.modelCalls >= 0
          ? session.modelCalls : null;
        const emptyCosts: CostComponents = {
          uncached_input_usd: null, cached_input_usd: null, cache_write_input_usd: null, output_usd: null,
        };
        let costs = emptyCosts;
        let estimated: number | null = null;
        let method: AgentUsage["method"];
        const recordedTicks = typeof session.costUsdTicks === "number" && Number.isSafeInteger(session.costUsdTicks)
          && session.costUsdTicks >= 0 && session.costIsPartial !== true ? session.costUsdTicks : null;
        if (recordedTicks !== null) {
          estimated = recordedTicks / GROK_USD_TICKS_PER_DOLLAR;
          method = "grok_usage.session (provider-recorded cost)";
        } else {
          method = "grok_usage.session (list-price estimate)";
          const rates = ratesFor(pricing, model);
          if (!rates) {
            markIncomplete(`${path}: no API price for Grok model ${model}`);
          } else if (modelCalls !== 1 && rates.overrides.length > 0) {
            markIncomplete(`${path}: per-request Grok usage is unavailable for tiered pricing`);
          } else {
            costs = requestCost(usage, rates);
            const values = Object.values(costs);
            if (values.some(value => value === null)) {
              markIncomplete(`${path}: required Grok API price component is missing`);
            } else {
              estimated = values.reduce<number>((sum, value) => sum + value!, 0);
            }
          }
        }
        agents.push({
          model,
          thread_id: typeof parsed.sessionId === "string" ? parsed.sessionId : entry.name,
          method,
          usage,
          estimated_api_usd: estimated,
          request_count: modelCalls,
          mean_input_tokens: modelCalls !== null && modelCalls > 0 ? usage.input_tokens / modelCalls : null,
          max_input_tokens: modelCalls === 1 ? usage.input_tokens : null,
          cost_components: costs,
        });
        addUsage(totals, usage);
        if (estimated === null) estimatedTotal = null;
        else if (estimatedTotal !== null) estimatedTotal += estimated;
      }
    }
  };
  try { await visit(usagePath); }
  catch (error) {
    markIncomplete(`cannot enumerate Grok usage: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!found) markIncomplete("no readable Grok usage.json found");
  return { agents, sessions: [], totals: { ...totals, estimated_api_usd: estimatedTotal, command_seconds: null }, warnings: [...new Set(warnings), "Grok command timing is unavailable from usage.json"], complete };
}
