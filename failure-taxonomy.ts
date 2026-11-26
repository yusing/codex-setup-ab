import type { adaptiveBehaviorEvidence } from "./behavioral-evidence";
import type { WorkflowEvent } from "./mechanisms";
import type { ArmResult } from "./types";
import type { MeteredRollouts } from "./usage";

export type FailureBucket =
  | "timeout_or_budget"
  | "infra_failure"
  | "edit_conflict"
  | "tool_error"
  | "context_rot"
  | "regression"
  | "localization"
  | "unclassified";

export interface FailureSignal {
  bucket: FailureBucket;
  evidence: string[];
}

export interface ArmFailureInput {
  arm: string;
  result?: ArmResult | null;
  usage?: MeteredRollouts | null;
  behavior?: ReturnType<typeof adaptiveBehaviorEvidence> | null;
  allowed_paths?: string[];
  invalidity_reasons?: string[];
  auto_compact_limit?: number | null;
}

export interface ArmFailureClassification {
  arm: string;
  passed: boolean;
  buckets: FailureBucket[];
  signals: FailureSignal[];
}

export interface TrajectoryArmInput {
  arm: string;
  result?: ArmResult | null;
  usage?: MeteredRollouts | null;
}

export interface TrajectoryDivergence {
  step_index: number;
  failed_event: string | null;
  passing_event: string | null;
}

export interface TrajectoryDiff {
  failed_arm: string;
  passing_arm: string;
  changed_files: {
    only_in_passing: string[];
    only_in_failed: string[];
    shared: string[];
  };
  commands: {
    failed_arm_total: number;
    passing_arm_total: number;
    delta: number;
    failed_arm_errors: number;
    passing_arm_errors: number;
    error_delta: number;
    failed_arm_retries: number;
    passing_arm_retries: number;
    retry_delta: number;
  };
  turns: {
    failed_arm: number | null;
    passing_arm: number | null;
    delta: number | null;
  };
  tokens: {
    total_tokens_delta: number | null;
    input_tokens_delta: number | null;
    cached_input_tokens_delta: number | null;
    uncached_input_tokens_delta: number | null;
    output_tokens_delta: number | null;
    cache_hit_rate_failed: number | null;
    cache_hit_rate_passing: number | null;
    cache_hit_rate_delta: number | null;
  };
  first_divergence: TrajectoryDivergence | null;
}

const DEFAULT_CONTEXT_PRESSURE_TOKENS = 200_000;

function orderedEvents(usage?: MeteredRollouts | null): WorkflowEvent[] {
  if (!usage?.sessions?.length) return [];
  const sessions = [...usage.sessions].sort((a, b) => {
    const aRoot = a.parent_thread_id === null ? 0 : 1;
    const bRoot = b.parent_thread_id === null ? 0 : 1;
    return aRoot - bRoot || a.thread_id.localeCompare(b.thread_id);
  });
  const events: Array<{ event: WorkflowEvent; ts: number; order: number }> = [];
  let order = 0;
  for (const session of sessions) {
    for (const event of session.workflow?.events ?? []) {
      const ts = Date.parse(event.timestamp);
      events.push({ event, ts: Number.isFinite(ts) ? ts : 0, order: order++ });
    }
  }
  events.sort((a, b) => a.ts - b.ts || a.event.line - b.event.line || a.order - b.order);
  return events.map(item => item.event);
}

function commandEvents(events: WorkflowEvent[]): WorkflowEvent[] {
  const commandLines = new Set<string>();
  const result: WorkflowEvent[] = [];
  for (const event of events) {
    if (event.kind === "command") {
      commandLines.add(`${event.timestamp}:${event.line}`);
      result.push(event);
    }
  }
  for (const event of events) {
    if (event.kind === "test" && !commandLines.has(`${event.timestamp}:${event.line}`)) {
      result.push(event);
    }
  }
  return result;
}

function countCommandRetries(cmds: WorkflowEvent[]): number {
  let retries = 0;
  for (let i = 1; i < cmds.length; i++) {
    const prev = cmds[i - 1]!;
    if (prev.exit_code !== undefined && prev.exit_code !== 0) retries++;
  }
  return retries;
}

function maxConsecutiveCommandFailures(cmds: WorkflowEvent[]): number {
  let best = 0;
  let current = 0;
  for (const cmd of cmds) {
    if (cmd.exit_code !== undefined && cmd.exit_code !== 0) {
      current++;
      if (current > best) best = current;
    } else {
      current = 0;
    }
  }
  return best;
}

function normalizePath(path: string): string {
  return path.replace(/^\.\//, "").replace(/^\/+/, "");
}

function matchesAllowedPath(filePath: string, allowedPaths: string[]): boolean {
  const file = normalizePath(filePath);
  for (const raw of allowedPaths) {
    const pattern = normalizePath(raw);
    if (!pattern) continue;
    if (file === pattern) return true;
    const prefix = pattern.endsWith("/") ? pattern : `${pattern}/`;
    if (file.startsWith(prefix)) return true;
    try {
      if (new Bun.Glob(pattern).match(file)) return true;
    } catch {
      /* Ignore invalid glob patterns and rely on literal/prefix checks. */
    }
  }
  return false;
}

function totalTurns(usage?: MeteredRollouts | null): number | null {
  if (!usage?.agents?.length) return null;
  if (usage.agents.some(agent => agent.request_count === null || !Number.isFinite(agent.request_count))) return null;
  return usage.agents.reduce((sum, agent) => sum + agent.request_count!, 0);
}

function aggregateToolSeconds(usage?: MeteredRollouts | null): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const session of usage?.sessions ?? []) {
    for (const [name, seconds] of Object.entries(session.observed_tool_seconds_by_name ?? {})) {
      if (Number.isFinite(seconds) && seconds >= 0) {
        totals[name] = (totals[name] ?? 0) + seconds;
      }
    }
  }
  return totals;
}

export function classifyArmFailure(input: ArmFailureInput): ArmFailureClassification {
  const { arm, result, usage, behavior, allowed_paths, invalidity_reasons, auto_compact_limit } = input;
  const passed = behavior?.behavior === "pass"
    && behavior.evaluation_validity === "valid"
    && result?.exit_code === 0
    && !result.timed_out
    && !result.canceled
    && !result.lifecycle_error
    && !result.collection_error
    && !(invalidity_reasons?.length);
  if (passed) {
    return { arm, passed: true, buckets: [], signals: [] };
  }

  const signals: FailureSignal[] = [];
  const add = (bucket: FailureBucket, evidence: string[]): void => {
    if (evidence.length) signals.push({ bucket, evidence });
  };

  // 1. timeout_or_budget
  const timeoutEvidence: string[] = [];
  if (result?.timed_out === true) {
    const elapsed = Number.isFinite(result.agent_elapsed_ms) ? ` after ${(result.agent_elapsed_ms / 1000).toFixed(1)}s` : "";
    timeoutEvidence.push(`Candidate timed out (timed_out=true${elapsed})`);
  } else if (result?.exit_code === 124) {
    timeoutEvidence.push("Candidate exited with timeout status code 124");
  }
  add("timeout_or_budget", timeoutEvidence);

  // 2. infra_failure
  const infraEvidence: string[] = [];
  if (!result) {
    infraEvidence.push("No arm result was captured");
  } else {
    if (result.lifecycle_error) infraEvidence.push(`lifecycle_error: ${result.lifecycle_error}`);
    if (result.collection_error) infraEvidence.push(`collection_error: ${result.collection_error}`);
    if (result.grade?.evaluator_error) infraEvidence.push(`evaluator_error: ${result.grade.evaluator_error}`);
    if (result.grade?.supplemental_infrastructure_error) {
      infraEvidence.push(`supplemental_infrastructure_error: ${result.grade.supplemental_infrastructure_error}`);
    }
    if (result.exit_code === 137) infraEvidence.push("Candidate exited with code 137 (SIGKILL / possible OOM)");
  }
  if (invalidity_reasons?.length) {
    infraEvidence.push(`invalidity_reasons: ${invalidity_reasons.join("; ")}`);
  }
  add("infra_failure", infraEvidence);

  const events = orderedEvents(usage);
  const editEvents = events.filter(event => event.kind === "edit");
  const cmds = commandEvents(events);
  const toolSeconds = aggregateToolSeconds(usage);
  const totalToolCalls = (usage?.sessions ?? []).reduce((sum, session) => sum + (session.tool_calls ?? 0), 0);

  // 3. edit_conflict
  const editEvidence: string[] = [];
  const failedEdits = editEvents.filter(event => event.exit_code !== undefined && event.exit_code !== 0);
  if (failedEdits.length >= 2) {
    editEvidence.push(`${failedEdits.length} failed edit events recorded in workflow trace`);
  }
  if (result && result.changed_files.length === 0) {
    if (editEvents.length > 0) {
      editEvidence.push(`Recorded ${editEvents.length} edit event(s) in workflow trace but changed_files is empty`);
    } else {
      const patchTools = Object.keys(toolSeconds).filter(name => /apply_patch|edit_file|replace|patch/i.test(name));
      if (patchTools.length > 0) {
        editEvidence.push(`Patch/edit tool invoked (${patchTools.join(", ")}) but changed_files is empty`);
      }
    }
  }
  add("edit_conflict", editEvidence);

  // 4. tool_error
  const toolErrorEvidence: string[] = [];
  const failedCmds = cmds.filter(event => event.exit_code !== undefined && event.exit_code !== 0);
  const streak = maxConsecutiveCommandFailures(cmds);
  const failRate = cmds.length ? failedCmds.length / cmds.length : 0;
  if ((cmds.length >= 3 && failRate >= 0.4) || failedCmds.length >= 3 || streak >= 3) {
    toolErrorEvidence.push(`${failedCmds.length}/${cmds.length} commands exited non-zero (${(failRate * 100).toFixed(0)}%)`);
    if (streak >= 3) toolErrorEvidence.push(`${streak} consecutive failing commands`);
  }
  add("tool_error", toolErrorEvidence);

  // 5. context_rot
  const contextEvidence: string[] = [];
  const compactions = usage?.journal?.compactions?.length ?? 0;
  if (compactions >= 2) {
    contextEvidence.push(`${compactions} context compactions recorded`);
  }
  const threads = Object.values(usage?.journal?.threads ?? {});
  if (threads.some(thread => (thread.empty_outcomes !== null && thread.empty_outcomes >= 2) || thread.last_outcome_empty === true)) {
    contextEvidence.push("Journal recorded repeated or trailing empty outcomes");
  }
  const maxInput = Math.max(0, ...(usage?.agents ?? []).map(agent => agent.max_input_tokens ?? 0));
  const threshold = auto_compact_limit ?? DEFAULT_CONTEXT_PRESSURE_TOKENS;
  if (maxInput >= threshold) {
    contextEvidence.push(`Peak input tokens (${maxInput}) reached context pressure threshold (${threshold})`);
  }
  let lastEditIndex = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.kind === "edit") { lastEditIndex = i; break; }
  }
  const turns = totalTurns(usage);
  if (lastEditIndex >= 0 && events.length - 1 - lastEditIndex >= 10) {
    contextEvidence.push(`${events.length - 1 - lastEditIndex} trailing workflow events after last edit without progress`);
  } else if (lastEditIndex === -1 && events.length >= 15 && (turns ?? 0) >= 15) {
    contextEvidence.push(`${events.length} workflow events across ${turns} turns with no edits`);
  }
  add("context_rot", contextEvidence);

  // 6. regression
  const regressionEvidence: string[] = [];
  const semantic = result?.grade?.semantic;
  if (semantic) {
    const failedExisting = new Set<string>();
    const passedNew = new Set<string>();
    let newCount = 0;
    for (const [group, rows] of Object.entries(semantic)) {
      const isExistingGroup = group.includes("existing") || group.includes("retained");
      for (const row of rows) {
        if (isExistingGroup || row.criterion === "__existing_tests") {
          if (row.status === "fail" || row.probe_status === "fail") failedExisting.add(row.criterion);
        } else {
          newCount++;
          if (row.status === "pass") passedNew.add(row.criterion);
        }
      }
    }
    if (failedExisting.size > 0 && (passedNew.size > 0 || (newCount === 0 && (result?.changed_files.length ?? 0) > 0))) {
      regressionEvidence.push(`Failed existing/regression gate(s): ${[...failedExisting].sort().join(", ")}`);
      if (passedNew.size > 0) {
        regressionEvidence.push(`Passed new criteria: ${[...passedNew].sort().join(", ")}`);
      }
    }
  }
  add("regression", regressionEvidence);

  // 7. localization
  const localizationEvidence: string[] = [];
  if (allowed_paths?.length && result?.changed_files.length) {
    const outOfScope = result.changed_files.filter(file => !matchesAllowedPath(file, allowed_paths)).sort();
    if (outOfScope.length) {
      localizationEvidence.push(`Changed files outside allowed scope: ${outOfScope.join(", ")}`);
    }
  }
  if (result && result.changed_files.length === 0 && editEvents.length === 0) {
    if (totalToolCalls >= 8 || cmds.length >= 6) {
      localizationEvidence.push(`High exploration (${totalToolCalls} tool calls, ${cmds.length} commands) with no file edits or changed files`);
    }
    const allToolSecs = Object.values(toolSeconds).reduce((sum, s) => sum + s, 0);
    if (allToolSecs > 0) {
      const readSearchSecs = Object.entries(toolSeconds)
        .filter(([name]) => /read|search|grep|glob|find|list|rg/i.test(name))
        .reduce((sum, [, s]) => sum + s, 0);
      const ratio = readSearchSecs / allToolSecs;
      if (ratio >= 0.75) {
        localizationEvidence.push(`Read/search tools accounted for ${(ratio * 100).toFixed(0)}% of tool time with no changed files`);
      }
    }
  }
  add("localization", localizationEvidence);

  // 8. unclassified fallback
  if (!signals.length) {
    signals.push({
      bucket: "unclassified",
      evidence: ["Failed without matching a specific deterministic failure taxonomy signal"],
    });
  }

  return {
    arm,
    passed: false,
    buckets: signals.map(signal => signal.bucket),
    signals,
  };
}

function formatTraceStep(event: WorkflowEvent): string {
  const target = event.target ? `(${event.target})` : "";
  const exit = event.exit_code !== undefined ? `[exit=${event.exit_code}]` : "";
  return `${event.kind}${target}${exit}`;
}

export function diffTrajectories(failedArm: TrajectoryArmInput, passingArm: TrajectoryArmInput): TrajectoryDiff {
  const failedFiles = new Set(failedArm.result?.changed_files ?? []);
  const passingFiles = new Set(passingArm.result?.changed_files ?? []);
  const only_in_passing = [...passingFiles].filter(file => !failedFiles.has(file)).sort();
  const only_in_failed = [...failedFiles].filter(file => !passingFiles.has(file)).sort();
  const shared = [...failedFiles].filter(file => passingFiles.has(file)).sort();

  const failedEvents = orderedEvents(failedArm.usage);
  const passingEvents = orderedEvents(passingArm.usage);
  const failedCmds = commandEvents(failedEvents);
  const passingCmds = commandEvents(passingEvents);
  const failedErrors = failedCmds.filter(e => e.exit_code !== undefined && e.exit_code !== 0).length;
  const passingErrors = passingCmds.filter(e => e.exit_code !== undefined && e.exit_code !== 0).length;
  const failedRetries = countCommandRetries(failedCmds);
  const passingRetries = countCommandRetries(passingCmds);

  const failedTurns = totalTurns(failedArm.usage);
  const passingTurns = totalTurns(passingArm.usage);

  const bothComplete = Boolean(failedArm.usage?.complete && passingArm.usage?.complete);
  const fTotals = failedArm.usage?.totals;
  const pTotals = passingArm.usage?.totals;
  const cacheHitRate = (totals?: MeteredRollouts["totals"]): number | null =>
    totals && totals.input_tokens > 0 ? totals.cached_input_tokens / totals.input_tokens : null;
  const failedCacheRate = bothComplete ? cacheHitRate(fTotals) : null;
  const passingCacheRate = bothComplete ? cacheHitRate(pTotals) : null;

  let first_divergence: TrajectoryDivergence | null = null;
  if (failedEvents.length > 0 || passingEvents.length > 0) {
    const failedSteps = failedEvents.map(formatTraceStep);
    const passingSteps = passingEvents.map(formatTraceStep);
    const maxLen = Math.max(failedSteps.length, passingSteps.length);
    for (let i = 0; i < maxLen; i++) {
      const fStep = failedSteps[i] ?? null;
      const pStep = passingSteps[i] ?? null;
      if (fStep !== pStep) {
        first_divergence = { step_index: i, failed_event: fStep, passing_event: pStep };
        break;
      }
    }
  }

  return {
    failed_arm: failedArm.arm,
    passing_arm: passingArm.arm,
    changed_files: { only_in_passing, only_in_failed, shared },
    commands: {
      failed_arm_total: failedCmds.length,
      passing_arm_total: passingCmds.length,
      delta: failedCmds.length - passingCmds.length,
      failed_arm_errors: failedErrors,
      passing_arm_errors: passingErrors,
      error_delta: failedErrors - passingErrors,
      failed_arm_retries: failedRetries,
      passing_arm_retries: passingRetries,
      retry_delta: failedRetries - passingRetries,
    },
    turns: {
      failed_arm: failedTurns,
      passing_arm: passingTurns,
      delta: failedTurns !== null && passingTurns !== null ? failedTurns - passingTurns : null,
    },
    tokens: {
      total_tokens_delta: bothComplete && fTotals && pTotals ? fTotals.total_tokens - pTotals.total_tokens : null,
      input_tokens_delta: bothComplete && fTotals && pTotals ? fTotals.input_tokens - pTotals.input_tokens : null,
      cached_input_tokens_delta: bothComplete && fTotals && pTotals ? fTotals.cached_input_tokens - pTotals.cached_input_tokens : null,
      uncached_input_tokens_delta: bothComplete && fTotals && pTotals
        ? (fTotals.input_tokens - fTotals.cached_input_tokens) - (pTotals.input_tokens - pTotals.cached_input_tokens) : null,
      output_tokens_delta: bothComplete && fTotals && pTotals ? fTotals.output_tokens - pTotals.output_tokens : null,
      cache_hit_rate_failed: failedCacheRate,
      cache_hit_rate_passing: passingCacheRate,
      cache_hit_rate_delta: failedCacheRate !== null && passingCacheRate !== null ? failedCacheRate - passingCacheRate : null,
    },
    first_divergence,
  };
}

export function failureTaxonomyMarkdown(
  classifications: ArmFailureClassification[],
  diffs: TrajectoryDiff[],
  labels: Record<string, string> = {},
): string {
  const failed = classifications.filter(item => !item.passed);
  if (!failed.length) return "";
  const escape = (text: string): string => text.replaceAll("|", "\\|").replaceAll("\n", " ");
  const signed = (value: number | null): string => value === null ? "unknown" : value > 0 ? `+${value}` : String(value);
  const pctSigned = (value: number | null): string => value === null ? "unknown" : `${value > 0 ? "+" : ""}${(value * 100).toFixed(1)}pp`;
  const rows = failed.map(item => {
    const evidence = item.signals.flatMap(signal => signal.evidence.map(line => `${signal.bucket}: ${line}`)).join("; ");
    return `| ${labels[item.arm] ?? item.arm} | ${item.buckets.join(", ")} | ${escape(evidence)} |`;
  });
  const diffSection = diffs.length
    ? `\n\n### Trajectory diff against passing sibling\n\n${diffs.map(diff => {
      const fLabel = labels[diff.failed_arm] ?? diff.failed_arm;
      const pLabel = labels[diff.passing_arm] ?? diff.passing_arm;
      const lines = [
        `- **${fLabel} vs. ${pLabel}**:`,
        `  - Changed files: ${diff.changed_files.shared.length} shared; only in passing (${diff.changed_files.only_in_passing.length}): ${diff.changed_files.only_in_passing.join(", ") || "none"}; only in failed (${diff.changed_files.only_in_failed.length}): ${diff.changed_files.only_in_failed.join(", ") || "none"}.`,
        `  - Commands & turns (failed minus passing): commands ${diff.commands.failed_arm_total} vs. ${diff.commands.passing_arm_total} (${signed(diff.commands.delta)}); errors ${diff.commands.failed_arm_errors} vs. ${diff.commands.passing_arm_errors} (${signed(diff.commands.error_delta)}); retries ${diff.commands.failed_arm_retries} vs. ${diff.commands.passing_arm_retries} (${signed(diff.commands.retry_delta)}); turns ${signed(diff.turns.delta)}.`,
        `  - Tokens & cache (failed minus passing): total ${signed(diff.tokens.total_tokens_delta)}, uncached input ${signed(diff.tokens.uncached_input_tokens_delta)}, cache hit rate ${pctSigned(diff.tokens.cache_hit_rate_delta)}.`,
      ];
      if (diff.first_divergence) {
        lines.push(`  - First divergence (step ${diff.first_divergence.step_index}): failed=${diff.first_divergence.failed_event ?? "end"} vs. passing=${diff.first_divergence.passing_event ?? "end"}.`);
      }
      return lines.join("\n");
    }).join("\n")}`
    : "";
  return `## Automated failure taxonomy\n\nDeterministic classification of non-passing arms from captured execution, grading, workflow, and usage evidence.\n\n| Arm | Failure buckets | Evidence |\n| --- | --- | --- |\n${rows.join("\n")}${diffSection}\n\n`;
}

