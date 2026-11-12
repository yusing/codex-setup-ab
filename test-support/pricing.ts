import { embeddedFallbackPricing, type PricingSnapshot } from "../usage";

/** Frozen fixture values avoid production catalog lookup during orchestration tests. */
export function fixturePricing(): PricingSnapshot {
  const models = ["gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-sol", "gpt-6-luna",
    "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "grok-4.7", "grok:grok-4.7"];
  return { fetched_at: "2026-01-01T00:00:00.000Z", source: "fallback", catalog_url: "fixture://pricing",
    assumptions: ["Model-free test fixture using embedded rates; no catalog request."], warnings: [],
    models: Object.fromEntries(models.map(model => [model, embeddedFallbackPricing(model)])) };
}
