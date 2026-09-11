import type { CostComponents, MeteredRollouts } from "./usage";
import { workflowTrace, type WorkflowTrace } from "./mechanisms";

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

export interface SessionDiagnostics {
  thread_id: string;
  parent_thread_id: string | null;
  agent_role: string | null;
  tool_calls: number;
  matched_tool_calls: number;
  tool_timing_complete: boolean;
  observed_tool_blocked_seconds: number;
  observed_tool_seconds_by_name: Record<string, number>;
  workflow: WorkflowTrace;
}

function unionSeconds(spans: Array<[number, number]>): number {
  let total = 0;
  let end = -Infinity;
  for (const [start, stop] of [...spans].sort((a, b) => a[0] - b[0])) {
    total += Math.max(0, stop - Math.max(start, end));
    end = Math.max(end, stop);
  }
  return total / 1000;
}

/** First matched output bounds observed blocking, not CPU time or nested command duration. */
export function sessionDiagnostics(threadId: string, events: RecordValue[], source = threadId, lines?: number[]): SessionDiagnostics {
  const metadata = record(events.find(event => event.type === "session_meta")?.payload);
  const spawn = record(record(record(metadata.source).subagent).thread_spawn);
  const parent = metadata.parent_thread_id ?? spawn.parent_thread_id;
  const calls = new Map<string, { name: string; start: number }>();
  const spans: Array<[number, number]> = [];
  const byName = new Map<string, Array<[number, number]>>();
  let toolCalls = 0;
  let matched = 0;
  let unmatchedOutputs = 0;
  for (const event of events) {
    if (event.type !== "response_item") continue;
    const payload = record(event.payload);
    const timestamp = typeof event.timestamp === "string" ? Date.parse(event.timestamp) : NaN;
    const id = typeof payload.call_id === "string" ? payload.call_id : null;
    if (payload.type === "function_call" || payload.type === "custom_tool_call") {
      toolCalls++;
      if (id && Number.isFinite(timestamp)) calls.set(id, {
        name: typeof payload.name === "string" ? payload.name : "unknown",
        start: timestamp,
      });
    } else if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
      const call = id ? calls.get(id) : undefined;
      if (!call || !Number.isFinite(timestamp) || timestamp < call.start) {
        unmatchedOutputs++;
        continue;
      }
      calls.delete(id!);
      matched++;
      const span: [number, number] = [call.start, timestamp];
      spans.push(span);
      const namedSpans = byName.get(call.name) ?? [];
      namedSpans.push(span);
      byName.set(call.name, namedSpans);
    }
  }
  return {
    thread_id: threadId,
    parent_thread_id: typeof parent === "string" ? parent : null,
    agent_role: typeof metadata.agent_role === "string" ? metadata.agent_role : null,
    tool_calls: toolCalls,
    matched_tool_calls: matched,
    tool_timing_complete: matched === toolCalls && unmatchedOutputs === 0,
    observed_tool_blocked_seconds: unionSeconds(spans),
    observed_tool_seconds_by_name: Object.fromEntries([...byName].map(([name, intervals]) => [name, unionSeconds(intervals)])),
    workflow: workflowTrace(events, source, lines),
  };
}

interface UsageDifference {
  total_tokens: number | null;
  estimated_api_usd: number | null;
}

export interface PerformanceComparison {
  scope: string;
  current_minus_stock: UsageDifference & {
    cost_components: CostComponents;
    by_role: Record<"root" | "children", UsageDifference>;
  };
}

export function performanceComparison(arms: Array<{ arm: string; usage: MeteredRollouts }>): PerformanceComparison | null {
  const stock = arms.find(item => item.arm === "stock")?.usage;
  const current = arms.find(item => item.arm === "current")?.usage;
  if (!stock || !current) return null;
  const costs = ["uncached_input_usd", "cached_input_usd", "cache_write_input_usd", "output_usd"] as const;
  const sumCost = (usage: MeteredRollouts, key: typeof costs[number]): number | null =>
    !usage.complete ? null : usage.agents.reduce<number | null>((total, agent) =>
      total === null || agent.cost_components[key] === null ? null : total + agent.cost_components[key]!, 0);
  const roles = (usage: MeteredRollouts, child: boolean) => usage.agents.filter(agent =>
    Boolean(usage.sessions.find(session => session.thread_id === agent.thread_id)?.parent_thread_id) === child);
  const delta = (a: number | null, b: number | null) => a === null || b === null ? null : b - a;
  const componentDelta = (key: keyof CostComponents): number | null => delta(sumCost(stock, key), sumCost(current, key));
  return {
    scope: "Observed accounting differences, not causal attribution; root and child time can overlap.",
    current_minus_stock: {
      total_tokens: stock.complete && current.complete ? current.totals.total_tokens - stock.totals.total_tokens : null,
      estimated_api_usd: stock.complete && current.complete ? delta(stock.totals.estimated_api_usd, current.totals.estimated_api_usd) : null,
      cost_components: {
        uncached_input_usd: componentDelta("uncached_input_usd"),
        cached_input_usd: componentDelta("cached_input_usd"),
        cache_write_input_usd: componentDelta("cache_write_input_usd"),
        output_usd: componentDelta("output_usd"),
      },
      by_role: Object.fromEntries([false, true].map(child => {
        const a = roles(stock, child);
        const b = roles(current, child);
        const cost = (agents: typeof a) => agents.reduce<number | null>((total, agent) =>
          total === null || agent.estimated_api_usd === null ? null : total + agent.estimated_api_usd, 0);
        const tokens = (agents: typeof a) => agents.reduce((total, agent) => total + agent.usage.total_tokens, 0);
        return [child ? "children" : "root", {
          total_tokens: stock.complete && current.complete ? tokens(b) - tokens(a) : null,
          estimated_api_usd: stock.complete && current.complete ? delta(cost(a), cost(b)) : null,
        }];
      })) as Record<"root" | "children", UsageDifference>,
    },
  };
}

export function performanceMarkdown(arms: Array<{ arm: string; usage: MeteredRollouts }>): string {
  const number = (value: number | null | undefined, digits = 0) => value == null ? "unknown" : value.toFixed(digits);
  const rows = arms.flatMap(({ arm, usage }) => usage.agents.map(agent => {
    const session = usage.sessions.find(item => item.thread_id === agent.thread_id);
    const role = session?.parent_thread_id ? session.agent_role ?? "child" : "root";
    return `| ${arm} / ${role} | ${number(agent.request_count)} | ${number(agent.mean_input_tokens)} | ${number(agent.max_input_tokens)} | ${agent.usage.input_tokens - agent.usage.cached_input_tokens} | ${agent.usage.cached_input_tokens} | ${agent.usage.output_tokens} | ${number(agent.estimated_api_usd, 6)} |`;
  }));
  const timing = arms.flatMap(({ arm, usage }) => usage.sessions.map(session =>
    `- ${arm} / ${session.parent_thread_id ? session.agent_role ?? "child" : "root"}: ${session.tool_calls} outer tool calls; ${number(session.observed_tool_blocked_seconds, 3)} observed blocked seconds; timing ${session.tool_timing_complete ? "complete" : "partial"}. By tool: ${Object.entries(session.observed_tool_seconds_by_name).map(([name, seconds]) => `${name}=${number(seconds, 3)}s`).join(", ") || "none"}.`));
  const componentRows = arms.map(({ arm, usage }) => {
    const sum = (key: keyof NonNullable<typeof usage.agents[number]["cost_components"]>): number | null =>
      !usage.complete || usage.agents.length === 0 || usage.agents.some(agent => agent.cost_components[key] == null) ? null
        : usage.agents.reduce((total, agent) => total + agent.cost_components![key]!, 0);
    return `| ${arm} | ${number(sum("uncached_input_usd"), 6)} | ${number(sum("cached_input_usd"), 6)} | ${number(sum("cache_write_input_usd"), 6)} | ${number(sum("output_usd"), 6)} |`;
  });
  const comparison = performanceComparison(arms);
  const delta = comparison?.current_minus_stock;
  const difference = delta ? `
### Where the measured difference sits

- Current minus stock: ${number(delta.total_tokens)} tokens and estimated USD ${number(delta.estimated_api_usd, 6)}.
${Object.entries(delta.by_role).map(([role, value]) => `- ${role}: ${number(value.total_tokens)} additional tokens; estimated USD ${number(value.estimated_api_usd, 6)} difference.`).join("\n")}
${Object.entries(delta.cost_components).map(([component, value]) => `- ${component}: USD ${number(value, 6)} difference.`).join("\n")}
` : "";
  return `## Programmatic performance breakdown

These figures come from deduplicated usage records and tool timestamps, without a model request. Input tokens include context replayed on every request, not just newly read text. Cached input is still counted and billed at its recorded rate. Cumulative-only records cannot establish request counts or context sizes.

| Arm / role | model requests | mean input/request | peak input/request | uncached input | cached input | output | estimated USD |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${rows.join("\n") || "| unavailable | | | | | | | |"}

### Estimated cost components

Per-request model and long-context rates are applied before summation; reasoning is already included in output.

| Arm | uncached input USD | cached input USD | cache writes USD | output USD |
| --- | ---: | ---: | ---: | ---: |
${componentRows.join("\n")}
${difference}
### Tool blocking

${timing.join("\n") || "- No session timing available."}

Tool spans end at the first matched output and are unioned within each session. Additional or unmatched outputs and missing timestamps mark timing partial: observed spans are lower bounds, not inferred zero time or proof of terminal completion. Child spans can overlap the parent's work: do not sum them into elapsed time. Command durations can overlap model generation and are not the same as blocked time. These measurements locate observed overhead but do not prove which instruction, launcher, or model behavior caused it.
`;
}
