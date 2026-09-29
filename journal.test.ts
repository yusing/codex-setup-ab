import { expect, test } from "bun:test";
import { compactionComparisonExclusion, journalEvidence, journalEvidenceMarkdown } from "./journal";
import { validateMekugiFlags } from "./mekugi";

test("journal compaction flag accepts only the supported explicit enum", () => {
  for (const mode of ["auto", "slice", "off"]) expect(validateMekugiFlags([`--journal-compaction=${mode}`])).toEqual([`--journal-compaction=${mode}`]);
  for (const flags of [["--journal-compaction"], ["--journal-compaction=true"], ["--journal-compaction=off", "--journal-compaction=auto"]]) {
    expect(() => validateMekugiFlags(flags)).toThrow();
  }
});

const usage = (input: number, output: number) => ({ input_tokens: input, cached_input_tokens: 0, output_tokens: output, reasoning_tokens: 0 });

test("router compaction has zero observed provider cost; old provenance stays unknown", () => {
  const metrics = { exchanges: [
    { sequence: 3, thread_id: "root", request_kind: "turn", provider_attempts: [{ usage: usage(30, 4) }] },
    { sequence: 1, thread_id: "root", request_kind: "turn", provider_attempts: [{ usage: usage(10, 2) }] },
    { sequence: 2, thread_id: "root", request_kind: "compaction", compaction_answer: "router", compaction_summary_bytes: 200, compaction_changes: 0, compaction_failures: 1, duration_ms: 4, provider_attempts: [] },
    { sequence: 4, thread_id: "root", request_kind: "prewarm", provider_attempts: [{ usage: usage(999, 999) }] },
    { sequence: 5, thread_id: "root", request_kind: "compaction", provider_attempts: [{ usage: usage(8, 2) }] },
  ] };
  const result = journalEvidence(metrics)!;
  expect(result.compactions_known).toBe(true);
  expect(result.compactions[0]).toEqual({ sequence: 2, thread_id: "root", answer: "router", summary_bytes: 200, changes: 0, failures: 1, duration_ms: 4, provider_requests: 0, provider_tokens: 0 });
  expect(result.compactions[1]?.answer).toBe("unknown");
  expect(result.compactions[1]?.summary_bytes).toBeNull();
  expect(result.post_compaction).toEqual({ provider_requests: 2, provider_tokens: 44 });
  expect(journalEvidenceMarkdown([{ label: "A", evidence: result }])).toContain("unknown: 1");
});

test("incomplete order and usage never become zero post-compaction cost", () => {
  const event = { thread_id: "root", request_kind: "compaction", compaction_answer: "provider", provider_attempts: [{ status: "completed" }] };
  expect(journalEvidence({ exchanges: [event] })?.post_compaction).toBeNull();
  expect(journalEvidence({ exchanges: [{ ...event, sequence: 1 }] })?.post_compaction).toEqual({ provider_requests: 1, provider_tokens: null });
  expect(journalEvidence({ exchanges: [{ sequence: 1, thread_id: "root", provider_attempts: [] }] })?.compactions_known).toBe(false);
  expect(journalEvidence({})).toBeNull();
});

test("provider cost uses the arm usage attempt rule", () => {
  const cost = (provider_attempts: unknown[]) => journalEvidence({ exchanges: [{ sequence: 1, thread_id: "root", request_kind: "compaction", provider_attempts }] })!.compactions[0];
  // A failed attempt without usage costs nothing but still counts as a request.
  expect(cost([{ status: "failed" }, { status: "completed", usage: usage(5, 1) }])).toMatchObject({ provider_requests: 2, provider_tokens: 6 });
  // Arm usage rejects partial counts, so compaction cost must not invent a total from them.
  expect(cost([{ status: "completed", usage: { input_tokens: 5, output_tokens: 1 } }])).toMatchObject({ provider_requests: 1, provider_tokens: null });
});

test("cumulative thread counters select latest sequence without adding snapshots", () => {
  const counter = { started_at: "2026-09-29T00:00:00Z", sequence: 4, operations: { plan: 1, log: 2, private: 9 }, standalone_requests: 0, final_answers: 1, final_answer_bytes: 5, empty_outcomes: 1, last_outcome_empty: false };
  const result = journalEvidence({ exchanges: [
    { sequence: 1, request_kind: "turn", thread_id: "__proto__", journal: counter },
    { sequence: 2, request_kind: "turn", thread_id: "__proto__", journal: { ...counter, sequence: 3, final_answer_bytes: 2 } },
    { sequence: 3, request_kind: "turn", thread_id: "other", journal: { ...counter, final_answer_bytes: 9 } },
  ] })!;
  expect(result.threads["__proto__"]?.final_answer_bytes).toBe(5);
  expect(result.threads["__proto__"]?.operations).toEqual({ plan: 1, log: 2 });
  expect(result.threads["__proto__"]?.last_outcome_empty).toBe(false);
  expect(result.threads.other?.final_answer_bytes).toBe(9);
  const reset = journalEvidence({ exchanges: [
    { sequence: 1, request_kind: "turn", thread_id: "root", journal: counter },
    { sequence: 2, request_kind: "turn", thread_id: "root", journal: { ...counter, started_at: "2026-09-30T00:00:00Z", sequence: 1, final_answer_bytes: 0 } },
  ] })!;
  expect(reset.threads.root?.final_answer_bytes).toBe(0);
});

test("compaction comparison excludes absent evidence rather than counting a tie", () => {
  const observed = journalEvidence({ exchanges: [{ sequence: 1, request_kind: "compaction" }] })!;
  const none = journalEvidence({ exchanges: [{ sequence: 1, request_kind: "turn" }] })!;
  expect(compactionComparisonExclusion([observed, observed])).toBeNull();
  expect(compactionComparisonExclusion([observed, none])).toBe("no compaction observed");
  expect(compactionComparisonExclusion([none, observed])).toBe("no compaction observed");
  expect(compactionComparisonExclusion([undefined, observed])).toBe("compaction evidence unavailable");
});
