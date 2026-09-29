import { providerAttemptUsage } from "./usage";

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}
function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export interface CompactionEvidence {
  sequence: number | null;
  thread_id: string | null;
  answer: "router" | "provider" | "unknown";
  summary_bytes: number | null;
  changes: number | null;
  failures: number | null;
  duration_ms: number | null;
  provider_requests: number | null;
  provider_tokens: number | null;
}

export interface JournalThreadCounters {
  started_at: string;
  sequence: number;
  operations: Record<string, number>;
  standalone_requests: number | null;
  final_answers: number | null;
  final_answer_bytes: number | null;
  empty_outcomes: number | null;
  last_outcome_empty: boolean | null;
}

export interface JournalEvidence {
  compactions_known: boolean;
  compactions: CompactionEvidence[];
  post_compaction: { provider_requests: number | null; provider_tokens: number | null } | null;
  threads: Record<string, JournalThreadCounters>;
}

/** Count provider cost with the same attempt rule as Mekugi arm usage. */
function providerCost(exchange: RecordValue): { provider_requests: number | null; provider_tokens: number | null } {
  if (!Array.isArray(exchange.provider_attempts)) return { provider_requests: null, provider_tokens: null };
  const provider_requests = exchange.provider_attempts.length;
  let tokens = 0;
  for (const attempt of exchange.provider_attempts) {
    const usage = providerAttemptUsage(attempt);
    if (usage === "none") continue;
    if (!usage) return { provider_requests, provider_tokens: null };
    tokens += usage.input_tokens + usage.output_tokens;
    if (!Number.isSafeInteger(tokens)) return { provider_requests, provider_tokens: null };
  }
  return { provider_requests, provider_tokens: tokens };
}

/** Read validated exports without inventing provenance for historical snapshots. */
export function journalEvidence(metrics: unknown): JournalEvidence | null {
  const exchanges = record(metrics).exchanges;
  if (!Array.isArray(exchanges)) return null;
  const entries = exchanges.map(record);
  const ordered = entries.every(entry => count(entry.sequence) !== null)
    && new Set(entries.map(entry => entry.sequence)).size === entries.length;
  if (ordered) entries.sort((a, b) => Number(a.sequence) - Number(b.sequence));
  const result: JournalEvidence = { compactions_known: entries.every(entry => ["turn", "prewarm", "compaction"].includes(String(entry.request_kind))), compactions: [], post_compaction: null, threads: Object.create(null) };
  let afterFirst = false;
  for (const entry of entries) {
    if (entry.request_kind === "prewarm") continue;
    if (entry.request_kind === "compaction") {
      result.compactions.push({
        sequence: count(entry.sequence), thread_id: typeof entry.thread_id === "string" ? entry.thread_id : null,
        answer: entry.compaction_answer === "router" || entry.compaction_answer === "provider" ? entry.compaction_answer : "unknown",
        summary_bytes: count(entry.compaction_summary_bytes), changes: count(entry.compaction_changes), failures: count(entry.compaction_failures),
        duration_ms: count(entry.duration_ms), ...providerCost(entry),
      });
      if (ordered && result.compactions_known && !afterFirst) result.post_compaction = { provider_requests: 0, provider_tokens: 0 };
      afterFirst = true;
    }
    if (afterFirst && result.post_compaction) {
      const cost = providerCost(entry);
      for (const key of ["provider_requests", "provider_tokens"] as const) {
        const current = result.post_compaction[key], next = cost[key];
        result.post_compaction[key] = current === null || next === null ? null : count(current + next);
      }
    }
    const counters = record(entry.journal), sequence = count(counters.sequence);
    if (typeof entry.thread_id !== "string" || !entry.thread_id || sequence === null
      || typeof counters.started_at !== "string" || !Number.isFinite(Date.parse(counters.started_at))) continue;
    const previous = result.threads[entry.thread_id];
    if (previous && previous.started_at === counters.started_at && previous.sequence >= sequence) continue;
    // A new tracking period is meaningful only with ordered exchange evidence.
    if (previous && previous.started_at !== counters.started_at && !ordered) continue;
    const operations: Record<string, number> = {};
    for (const op of ["plan", "add", "set", "log", "remove", "read", "edit", "delete", "list"]) {
      const value = count(record(counters.operations)[op]);
      if (value !== null) operations[op] = value;
    }
    result.threads[entry.thread_id] = {
      started_at: counters.started_at, sequence, operations,
      standalone_requests: count(counters.standalone_requests), final_answers: count(counters.final_answers),
      final_answer_bytes: count(counters.final_answer_bytes), empty_outcomes: count(counters.empty_outcomes),
      last_outcome_empty: typeof counters.last_outcome_empty === "boolean" ? counters.last_outcome_empty : null,
    };
  }
  return result;
}

export function journalEvidenceMarkdown(arms: Array<{ label: string; evidence?: JournalEvidence | null }>): string {
  if (!arms.some(arm => arm.evidence && (arm.evidence.compactions.length || Object.keys(arm.evidence.threads).length))) return "";
  const shown = (value: number | null | undefined): string => value == null ? "unknown" : String(value);
  const rows = arms.map(({ label, evidence }) => {
    const compactions = evidence?.compactions;
    const provenance = compactions && evidence.compactions_known ? ["router", "provider", "unknown"].map(answer => `${answer}: ${compactions.filter(event => event.answer === answer).length}`).join(", ") : "unknown";
    return `| ${label} | ${evidence?.compactions_known ? compactions?.length : "unknown"} | ${provenance} | ${shown(evidence?.post_compaction?.provider_requests)} | ${shown(evidence?.post_compaction?.provider_tokens)} |`;
  });
  return `## Journal and compaction evidence\n\n| Arm | compactions | answerer | provider requests from first compaction | provider tokens from first compaction |\n| --- | ---: | --- | ---: | ---: |\n${rows.join("\n")}\n\nPost-compaction cost includes the first compaction and excludes prewarm. Unknown provenance in older exports stays unknown. Router answers with no provider attempts record zero provider tokens, not estimated savings. Per-thread cumulative journal counters are retained in each arm's JSON usage evidence.\n`;
}

/** A paired compaction comparison needs observed compaction in both arms. */
export function compactionComparisonExclusion(arms: Array<JournalEvidence | undefined>): string | null {
  if (arms.some(arm => arm?.compactions_known && arm.compactions.length === 0)) return "no compaction observed";
  if (arms.length !== 2 || arms.some(arm => !arm?.compactions_known)) return "compaction evidence unavailable";
  return null;
}
