const PROVIDER_USAGE_KEYS = ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_tokens"] as const;
export type ProviderAttemptUsage = Record<(typeof PROVIDER_USAGE_KEYS)[number], number>;

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
 * Read one provider attempt's usage counts. A failed attempt without usage recorded
 * no tokens ("none"); any other attempt must record every count, or null is returned.
 */
export function providerAttemptUsage(attempt: unknown): ProviderAttemptUsage | "none" | null {
  if (!isObject(attempt)) return null;
  if (!isObject(attempt.usage) && attempt.status !== "completed") return "none";
  const recorded = isObject(attempt.usage) ? attempt.usage : {};
  const coverage = ["complete_attempts", "incomplete_attempts", "unknown_attempts", "missing_attempts"];
  if (coverage.some(key => Object.hasOwn(recorded, key))
    && (recorded.complete_attempts !== 1 || coverage.slice(1).some(key => recorded[key] !== 0))) return null;
  const counts = Object.fromEntries(PROVIDER_USAGE_KEYS.map(key => [key, recorded[key]]));
  return Object.values(counts).every(value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    ? counts as ProviderAttemptUsage : null;
}
