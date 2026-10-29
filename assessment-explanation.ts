import type { MeteredRollouts } from "./usage";

export interface ResourceComparison {
  baseline: string;
  arm: string;
  summary: string;
  drivers: string[];
}

interface MeasuredArm {
  arm: string;
  label: string;
  usage?: MeteredRollouts;
}

const count = (value: number): string => value.toLocaleString("en-US", { maximumFractionDigits: 1 });
const signed = (value: number): string => `${value >= 0 ? "+" : "−"}${count(Math.abs(value))}`;

/** Explain observed accounting, without giving the blinded judge agent logs. */
export function explainResources(arms: MeasuredArm[]): ResourceComparison[] {
  const baseline = arms[0];
  if (!baseline) return [];
  return arms.slice(1).map(arm => {
    const comparison: ResourceComparison = { baseline: baseline.arm, arm: arm.arm, summary: "", drivers: [] };
    const a = baseline.usage, b = arm.usage;
    if (!a?.complete || !b?.complete) return {
      ...comparison,
      summary: `${arm.label} versus ${baseline.label}: resource differences are unknown because complete usage is unavailable.`,
    };
    const gap = b.totals.total_tokens - a.totals.total_tokens;
    comparison.summary = `${arm.label} used ${count(Math.abs(gap))} ${gap < 0 ? "fewer" : "more"} tokens than ${baseline.label} (${count(b.totals.total_tokens)} vs ${count(a.totals.total_tokens)}).`;
    if (gap === 0) comparison.summary = `${arm.label} and ${baseline.label} used the same total tokens (${count(a.totals.total_tokens)} each).`;
    comparison.drivers.push(`The difference is ${signed(b.totals.input_tokens - a.totals.input_tokens)} input tokens and ${signed(b.totals.output_tokens - a.totals.output_tokens)} output tokens. Input includes history processed again on each request, even when cached; reasoning is already included in output.`);

    const requests = (usage: MeteredRollouts): number | null => usage.agents.length && usage.agents.every(agent => agent.request_count !== null)
      ? usage.agents.reduce((sum, agent) => sum + agent.request_count!, 0) : null;
    const requestsA = requests(a), requestsB = requests(b);
    if (requestsA === null || requestsB === null) comparison.drivers.push("Model-request counts and mean context sizes are unknown: cumulative token totals cannot establish how many requests occurred.");
    else {
      comparison.drivers.push(`${arm.label}: ${count(requestsB)} model request${requestsB === 1 ? "" : "s"}; ${baseline.label}: ${count(requestsA)}.${requestsA > 0 && requestsB > 0 ? ` Mean input per request was ${count(b.totals.input_tokens / requestsB)} vs ${count(a.totals.input_tokens / requestsA)} tokens. Request count and context size jointly determine input volume.` : ""}`);
    }

    const children = (usage: MeteredRollouts): number | null => {
      if (!usage.agents.every(agent => usage.sessions.some(session => session.thread_id === agent.thread_id))) return null;
      return usage.agents.filter(agent => usage.sessions.some(session => session.thread_id === agent.thread_id && session.parent_thread_id))
        .reduce((sum, agent) => sum + agent.usage.total_tokens, 0);
    };
    const childrenA = children(a), childrenB = children(b);
    if (childrenA !== null && childrenB !== null && (childrenA || childrenB)) comparison.drivers.push(`Delegated agents used ${count(childrenB)} tokens for ${arm.label} vs ${count(childrenA)} for ${baseline.label}; their ${signed(childrenB - childrenA)}-token difference is included in the totals above.`);

    for (const measured of [baseline, arm]) {
      const usage = measured.usage!;
      if (!usage.codex_visible_requests) continue;
      const provider = requests(usage);
      const visible = Object.values(usage.codex_visible_requests);
      const codexCount = visible.length && visible.every(value => value !== null) ? visible.reduce<number>((sum, value) => sum + value!, 0) : null;
      comparison.drivers.push(`${measured.label}'s request counts include validated provider attempts, excluding prewarm.${provider !== null && codexCount !== null && provider > codexCount ? ` ${count(provider - codexCount)} attempts were absent from Codex's request log.` : ""} Counts alone do not distinguish retries from router-local re-sends.`);
    }
    return comparison;
  });
}

export function resourceExplanationMarkdown(comparisons: ResourceComparison[]): string {
  if (!comparisons.length) return "";
  return `## Why token and request usage differs\n\n${comparisons.map(item => `${item.summary}\n\n${item.drivers.map(driver => `- ${driver}`).join("\n")}`).join("\n\n")}\n\nThese are accounting explanations. Visible workflow evidence can explain observed extra work, but token counts alone cannot identify an instruction's effect or the cause of cache misses.\n`;
}
