import { expect, test } from "bun:test";
import { classifyArmFailure, diffTrajectories, failureTaxonomyMarkdown } from "./failure-taxonomy";
import type { adaptiveBehaviorEvidence } from "./behavioral-evidence";
import type { ArmResult } from "./types";
import type { MeteredRollouts } from "./usage";
import type { WorkflowEvent } from "./mechanisms";

const passBehavior = (): ReturnType<typeof adaptiveBehaviorEvidence> => ({
  behavior: "pass",
  evaluation_validity: "valid",
  evidence: "verified",
  coverage: { required: 2, verified_pass: 2, verified_fail: 0, unassessed: 0, complete: true },
  issues: [],
});

const failBehavior = (): ReturnType<typeof adaptiveBehaviorEvidence> => ({
  behavior: "fail",
  evaluation_validity: "valid",
  evidence: "verified",
  coverage: { required: 2, verified_pass: 0, verified_fail: 1, unassessed: 1, complete: false },
  issues: [],
});

const baseResult = (overrides: Partial<ArmResult> = {}): ArmResult => ({
  arm: "current",
  anonymous_id: "candidate-1",
  container: "c1",
  started_at: "2026-11-26T00:00:00Z",
  finished_at: "2026-11-26T00:01:00Z",
  agent_elapsed_ms: 60_000,
  exit_code: 0,
  timed_out: false,
  canceled: false,
  patch_path: "changes.patch",
  stdout_path: "stdout.log",
  stderr_path: "stderr.log",
  changed_files: ["src/app.ts"],
  head_after_agent: "abc123",
  ...overrides,
});

const makeUsage = (overrides: {
  events?: WorkflowEvent[];
  tool_calls?: number;
  tool_seconds?: Record<string, number>;
  request_count?: number | null;
  max_input_tokens?: number | null;
  totals?: Partial<MeteredRollouts["totals"]>;
  complete?: boolean;
  journal?: MeteredRollouts["journal"];
} = {}): MeteredRollouts => ({
  complete: overrides.complete ?? true,
  warnings: [],
  journal: overrides.journal,
  sessions: [{
    thread_id: "root-1",
    parent_thread_id: null,
    agent_role: null,
    tool_calls: overrides.tool_calls ?? (overrides.events?.length ?? 0),
    matched_tool_calls: overrides.tool_calls ?? (overrides.events?.length ?? 0),
    tool_timing_complete: true,
    observed_tool_blocked_seconds: 1,
    observed_tool_seconds_by_name: overrides.tool_seconds ?? {},
    workflow: {
      source: "rollout.jsonl",
      events: overrides.events ?? [],
      encrypted_messages: 0,
      agent_path: null,
    },
  }],
  agents: [{
    model: "gpt-6-astra",
    thread_id: "root-1",
    method: "token_usage_record",
    usage: {
      input_tokens: overrides.totals?.input_tokens ?? 1000,
      cached_input_tokens: overrides.totals?.cached_input_tokens ?? 500,
      cache_write_input_tokens: overrides.totals?.cache_write_input_tokens ?? 0,
      output_tokens: overrides.totals?.output_tokens ?? 200,
      reasoning_output_tokens: overrides.totals?.reasoning_output_tokens ?? 50,
      total_tokens: overrides.totals?.total_tokens ?? 1200,
    },
    estimated_api_usd: overrides.totals?.estimated_api_usd ?? 0.05,
    request_count: overrides.request_count === undefined ? 5 : overrides.request_count,
    mean_input_tokens: 500,
    max_input_tokens: overrides.max_input_tokens === undefined ? 1000 : overrides.max_input_tokens,
    cost_components: { uncached_input_usd: 0.01, cached_input_usd: 0.01, cache_write_input_usd: 0, output_usd: 0.03 },
  }],
  totals: {
    input_tokens: overrides.totals?.input_tokens ?? 1000,
    cached_input_tokens: overrides.totals?.cached_input_tokens ?? 500,
    cache_write_input_tokens: overrides.totals?.cache_write_input_tokens ?? 0,
    output_tokens: overrides.totals?.output_tokens ?? 200,
    reasoning_output_tokens: overrides.totals?.reasoning_output_tokens ?? 50,
    total_tokens: overrides.totals?.total_tokens ?? 1200,
    estimated_api_usd: overrides.totals?.estimated_api_usd ?? 0.05,
    command_seconds: overrides.totals?.command_seconds ?? 1.5,
  },
});

const evt = (kind: WorkflowEvent["kind"], line: number, extra: Partial<WorkflowEvent> = {}): WorkflowEvent => ({
  kind,
  line,
  timestamp: new Date(Date.parse("2026-11-26T00:00:00Z") + line * 1000).toISOString(),
  ...extra,
});

test("passing arm returns passed=true with no failure buckets and empty markdown", () => {
  const c = classifyArmFailure({ arm: "stock", result: baseResult(), usage: makeUsage(), behavior: passBehavior() });
  expect(c).toEqual({ arm: "stock", passed: true, buckets: [], signals: [] });
  expect(failureTaxonomyMarkdown([c], [])).toBe("");
});

test("classifies timeout_or_budget and infra_failure deterministically", () => {
  const timedOut = classifyArmFailure({
    arm: "current",
    result: baseResult({ timed_out: true, agent_elapsed_ms: 180_000 }),
    behavior: failBehavior(),
  });
  expect(timedOut.buckets).toContain("timeout_or_budget");

  const infra = classifyArmFailure({
    arm: "current",
    result: baseResult({ exit_code: 137, lifecycle_error: "container killed", collection_error: "missing patch" }),
    behavior: failBehavior(),
  });
  expect(infra.buckets).toContain("infra_failure");
  const infraSignal = infra.signals.find(s => s.bucket === "infra_failure")!;
  expect(infraSignal.evidence.some(e => e.includes("lifecycle_error"))).toBe(true);
  expect(infraSignal.evidence.some(e => e.includes("137"))).toBe(true);
});

test("classifies edit_conflict on repeated failed edits or zero changed files after edits", () => {
  const zeroChanged = classifyArmFailure({
    arm: "current",
    result: baseResult({ changed_files: [] }),
    usage: makeUsage({ events: [evt("edit", 1), evt("edit", 2)] }),
    behavior: failBehavior(),
  });
  expect(zeroChanged.buckets).toContain("edit_conflict");

  const patchToolZero = classifyArmFailure({
    arm: "current",
    result: baseResult({ changed_files: [] }),
    usage: makeUsage({ tool_seconds: { apply_patch: 1.2 } }),
    behavior: failBehavior(),
  });
  expect(patchToolZero.buckets).toContain("edit_conflict");
});

test("classifies tool_error on elevated command failure rate or repeated failing commands", () => {
  const toolErr = classifyArmFailure({
    arm: "current",
    result: baseResult(),
    usage: makeUsage({
      events: [
        evt("command", 1, { exit_code: 1 }),
        evt("command", 2, { exit_code: 1 }),
        evt("command", 3, { exit_code: 1 }),
        evt("command", 4, { exit_code: 0 }),
      ],
    }),
    behavior: failBehavior(),
  });
  expect(toolErr.buckets).toContain("tool_error");
});

test("classifies context_rot on compactions, peak input pressure, or long trailing turns", () => {
  const compacted = classifyArmFailure({
    arm: "current",
    result: baseResult(),
    usage: makeUsage({
      max_input_tokens: 210_000,
      journal: {
        compactions_known: true,
        compactions: [
          { sequence: 1, thread_id: "root-1", answer: "router", summary_bytes: 500, changes: 1, failures: 0, duration_ms: 100, provider_requests: 1, provider_tokens: 1000 },
          { sequence: 2, thread_id: "root-1", answer: "router", summary_bytes: 600, changes: 1, failures: 0, duration_ms: 100, provider_requests: 1, provider_tokens: 1000 },
        ],
        post_compaction: null,
        threads: {},
      },
    }),
    behavior: failBehavior(),
  });
  expect(compacted.buckets).toContain("context_rot");

  const trailingEvents = [evt("edit", 1), ...Array.from({ length: 11 }, (_, i) => evt("command", i + 2, { exit_code: 0 }))];
  const trailing = classifyArmFailure({
    arm: "current",
    result: baseResult(),
    usage: makeUsage({ events: trailingEvents }),
    behavior: failBehavior(),
  });
  expect(trailing.buckets).toContain("context_rot");
});

test("classifies regression when existing tests fail while new criteria pass", () => {
  const reg = classifyArmFailure({
    arm: "current",
    result: baseResult({
      grade: {
        preparation: { command: "prep", started_at: "", elapsed_ms: 10, exit_code: 0, stdout: "", stderr: "" },
        router_suite: { command: "test", started_at: "", elapsed_ms: 10, exit_code: 1, stdout: "", stderr: "" },
        elapsed_ms: 20,
        passed: false,
        semantic: {
          "pass-1-existing": [{ criterion: "__existing_tests", status: "fail", basis: "executed", reasoning: "broke legacy test" }],
          "pass-1": [{ criterion: "new-feature", status: "pass", basis: "executed", reasoning: "works" }],
        },
      },
    }),
    behavior: failBehavior(),
  });
  expect(reg.buckets).toContain("regression");
});

test("classifies localization on out-of-scope edits or high read/search ratio without edits", () => {
  const outOfScope = classifyArmFailure({
    arm: "current",
    result: baseResult({ changed_files: ["src/app.ts", "vendor/unrelated.ts"] }),
    allowed_paths: ["src/"],
    behavior: failBehavior(),
  });
  expect(outOfScope.buckets).toContain("localization");

  const readOnlyLoop = classifyArmFailure({
    arm: "current",
    result: baseResult({ changed_files: [] }),
    usage: makeUsage({
      tool_calls: 10,
      tool_seconds: { grep_search: 8.5, read_file: 1.5 },
    }),
    behavior: failBehavior(),
  });
  expect(readOnlyLoop.buckets).toContain("localization");
});

test("falls back to unclassified when no specific deterministic signal matches", () => {
  const unc = classifyArmFailure({
    arm: "current",
    result: baseResult({ changed_files: ["src/app.ts"] }),
    usage: makeUsage({ events: [evt("edit", 1), evt("command", 2, { exit_code: 0 })] }),
    behavior: failBehavior(),
  });
  expect(unc.buckets).toEqual(["unclassified"]);
});

test("diffTrajectories computes file diff, command/retry/turn/token deltas, and first divergence", () => {
  const failed = {
    arm: "current",
    result: baseResult({ arm: "current", changed_files: ["src/a.ts", "src/wrong.ts"] }),
    usage: makeUsage({
      request_count: 8,
      totals: { input_tokens: 4000, cached_input_tokens: 1000, output_tokens: 800, total_tokens: 4800 },
      events: [
        evt("command", 1, { exit_code: 0 }),
        evt("edit", 2),
        evt("command", 3, { exit_code: 1 }),
        evt("command", 4, { exit_code: 1 }),
        evt("command", 5, { exit_code: 0 }),
      ],
    }),
  };
  const passing = {
    arm: "stock",
    result: baseResult({ arm: "stock", changed_files: ["src/a.ts", "src/right.ts"] }),
    usage: makeUsage({
      request_count: 5,
      totals: { input_tokens: 2000, cached_input_tokens: 1000, output_tokens: 400, total_tokens: 2400 },
      events: [
        evt("command", 1, { exit_code: 0 }),
        evt("edit", 2),
        evt("command", 3, { exit_code: 0 }),
      ],
    }),
  };
  const diff = diffTrajectories(failed, passing);
  expect(diff.changed_files).toEqual({
    only_in_passing: ["src/right.ts"],
    only_in_failed: ["src/wrong.ts"],
    shared: ["src/a.ts"],
  });
  expect(diff.commands).toEqual({
    failed_arm_total: 4,
    passing_arm_total: 2,
    delta: 2,
    failed_arm_errors: 2,
    passing_arm_errors: 0,
    error_delta: 2,
    failed_arm_retries: 2,
    passing_arm_retries: 0,
    retry_delta: 2,
  });
  expect(diff.turns).toEqual({ failed_arm: 8, passing_arm: 5, delta: 3 });
  expect(diff.tokens.total_tokens_delta).toBe(2400);
  expect(diff.tokens.uncached_input_tokens_delta).toBe(2000);
  expect(diff.tokens.cache_hit_rate_failed).toBeCloseTo(0.25);
  expect(diff.tokens.cache_hit_rate_passing).toBeCloseTo(0.5);
  expect(diff.tokens.cache_hit_rate_delta).toBeCloseTo(-0.25);
  expect(diff.first_divergence).toEqual({
    step_index: 2,
    failed_event: "command[exit=1]",
    passing_event: "command[exit=0]",
  });

  const md = failureTaxonomyMarkdown(
    [classifyArmFailure({ arm: "current", result: failed.result, usage: failed.usage, behavior: failBehavior() })],
    [diff],
    { stock: "Stock", current: "Current" },
  );
  expect(md).toContain("## Automated failure taxonomy");
  expect(md).toContain("### Trajectory diff against passing sibling");
  expect(md).toContain("First divergence (step 2)");
  expect(md).toContain("src/right.ts");
});

