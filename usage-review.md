# Usage accounting review handoff

## Scope and contract

- `usage.ts` exports `fetchPricing(): Promise<PricingSnapshot>` and
  `meterRollouts(codexHome: string, pricing: PricingSnapshot): Promise<MeteredRollouts>`.
- The meter returns JSON-safe `{ agents, totals, warnings, complete }`. Each agent is one
  thread/model pair with `model`, `thread_id`, `method`, six token counters, and nullable
  `estimated_api_usd`. Totals add the same counters plus nullable API USD and summed command
  duration in seconds.
- A missing model/rate needed by nonzero usage produces `null`, a warning, and `complete: false`.
  Explicit zero prices remain known zero prices.
- `token_usage_record.payload.usage` is preferred. Response IDs are deduplicated globally; a
  record in its owning thread's file wins over a parent copy, then the largest repeated cumulative
  record wins. Nested/JSON-encoded response identifiers are accepted defensively.
- `event_msg/token_count.info.total_token_usage` is used only for threads with no request records.
  Its method and warning explicitly call per-request pricing an approximation. Orchestrated-role
  aggregates are never added.
- Pricing is per request. OpenRouter overrides activate strictly above `min_prompt_tokens`; the
  embedded stock fallback convention remains inclusive at 272,000 input tokens.
  Cached input is a subset of input, cache-write input is a separate billing component, and
  reasoning output is reported but not added to output for billing.
- `fetchPricing` snapshots the public OpenRouter model catalog with an 8-second timeout and retains
  embedded exact fallback rates for Astra, Astra Pro, Sol, Terra, and Luna. The timestamp, source,
  catalog URL, assumptions, and fetch warning are included in the serializable snapshot.

## Validation

- `bun test usage.test.ts`: 8 passed, 0 failed, 34 assertions.
- `bun build usage.ts --target=bun`: passed.
- Tests cover mixed main/child records without double counting, a parent orchestrated aggregate,
  nested response ID dedup, repeated response and cumulative token-count records, command-duration
  sum, per-request long-context tiers, reasoning subset billing, zero versus absent prices, unknown
  models, malformed JSONL, partial usage, and fallback snapshot serialization.
  Equality and threshold+1 fixtures separately cover OpenRouter's exclusive tier boundary, while
  the fallback equality fixture remains inclusive. A discovered completed session with no usable
  usage is also covered and produces unknown total cost.

## Evidence and remaining review questions

- Local Codex protocol source defines `TokenUsageRecord.usage` as one completed response and
  `turn_token_usage`/`thread_token_usage` as cumulative fields
  (`/home/ubuntu/projects/codex/codex-rs/protocol/src/protocol.rs:2237` and
  `/home/ubuntu/projects/codex/codex-rs/core/src/state/session.rs:160`). The implementation bills
  only `usage`.
- Command time assumes completed `CommandExecution` items own a numeric or `{secs,nanos}` duration;
  malformed/missing duration marks the result incomplete.
- Please independently inspect whether parent rollouts can persist a child's request record under
  a different response-ID representation, and whether the direct-file/largest-total tie-break is
  sufficient for every duplication path.
- Please inspect whether fallback `total_token_usage` can include child/orchestrated usage despite
  child rollouts also existing. The implementation ignores explicit orchestrated aggregates but
  cannot disaggregate a cumulative total whose producer already folded them in.
- OpenRouter is an external schema. Missing/invalid catalog price components stay null rather than
  being silently inferred. Embedded fallback applies only when the model does not match catalog
  data, following the requested OpenRouter-first behavior.
- Every discovered thread without any usable request or cumulative usage now makes total cost
  unknown and the result incomplete. The rollout does not persist a definitive count of Responses
  API completions whose provider response omitted usage, so one omitted response inside an
  otherwise metered thread remains undetectable; no cost is silently invented for it.
