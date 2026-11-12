const PROVIDER_USAGE_KEYS = ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_tokens"] as const;
export type ProviderAttemptUsage = Record<(typeof PROVIDER_USAGE_KEYS)[number], number>;

export function validCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Preserve runtime namespaces while reading validated family and historical snapshots. */
export function mekugiMetricRuntimes(metrics: unknown): Array<{ capture?: string; metrics: Record<string, unknown>; exchanges: unknown[] }> | null {
  if (!isObject(metrics)) return null;
  if (metrics.schema !== "mekugi.capture.family.v1") return Array.isArray(metrics.exchanges) ? [{ metrics, exchanges: metrics.exchanges }] : null;
  if (!Array.isArray(metrics.runtimes) || !metrics.runtimes.length) return null;
  const runtimes = [];
  for (const runtime of metrics.runtimes) {
    if (!isObject(runtime) || typeof runtime.capture !== "string" || !isObject(runtime.metrics)
      || !Array.isArray(runtime.metrics.exchanges)) return null;
    runtimes.push({ capture: runtime.capture, metrics: runtime.metrics, exchanges: runtime.metrics.exchanges });
  }
  return runtimes;
}

/**
 * Read provider counts only when recorded. A failed request can still be billable;
 * absence of usage never proves zero. Explicit all-zero counters remain valid.
 */
export function providerAttemptUsage(attempt: unknown): ProviderAttemptUsage | "none" | null {
  if (!isObject(attempt)) return null;
  const recorded = isObject(attempt.usage) ? attempt.usage : {};
  const coverage = ["complete_attempts", "incomplete_attempts", "unknown_attempts", "missing_attempts"];
  if (coverage.some(key => Object.hasOwn(recorded, key))
    && (recorded.complete_attempts !== 1
      // Current Mekugi omits the unreachable unknown state; older snapshots record it as zero.
      || coverage.slice(1).some(key => recorded[key] !== 0 && !(key === "unknown_attempts" && !Object.hasOwn(recorded, key))))) return null;
  const counts = Object.fromEntries(PROVIDER_USAGE_KEYS.map(key => [key, recorded[key]]));
  return Object.values(counts).every(validCounter)
    && Number(counts.cached_input_tokens) <= Number(counts.input_tokens)
    && Number(counts.reasoning_tokens) <= Number(counts.output_tokens)
    && Number.isSafeInteger(Number(counts.input_tokens) + Number(counts.output_tokens))
    ? counts as ProviderAttemptUsage : null;
}
