import type { MeteredRollouts } from "./usage";

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
}

export interface WorkflowEvent {
  kind: "spawn" | "ready" | "message" | "review_result" | "command" | "edit" | "test" | "wait" | "copy_fallback";
  line: number;
  timestamp: string;
  target?: string;
  isolated_context?: boolean;
  seconds?: number;
  package_seconds?: number;
  wrapper?: "shadowtree";
  exit_code?: number;
  verdict?: "COMMENT" | "FIX" | "APPROVE";
  finding?: string;
}

export interface WorkflowTrace {
  source: string;
  events: WorkflowEvent[];
  encrypted_messages: number;
  agent_path: string | null;
}

function seconds(value: unknown): number | undefined {
  const data = object(value);
  const result = typeof value === "number" ? value
    : typeof data.secs === "number" ? data.secs + (typeof data.nanos === "number" ? data.nanos / 1e9 : 0) : NaN;
  return Number.isFinite(result) && result >= 0 ? result : undefined;
}

function literalShellScript(command: string): string {
  const wrapper = /^shell (?:bash|sh) \$'((?:\\.|[^'\\])*)'$/.exec(command.trim());
  if (!wrapper) return command;
  // Decode only the literal escape forms emitted by this helper, never evaluate shell/code.
  if (/\\(?![nrt\\'])/.test(wrapper[1]!)) return "";
  const escapes: Record<string, string> = { n: "\n", r: "\r", t: "\t", "\\": "\\", "'": "'" };
  return wrapper[1]!.replace(/\\([nrt\\'])/g, (_, key: string) => escapes[key]!);
}

/** Recognize simple literal commands only. Shell control flow/expansion stays unknown. */
function shellCommands(script: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let quote: "'" | '"' | null = null;
  const finishWord = (): void => { if (word) words.push(word); word = ""; };
  const finishCommand = (): void => { finishWord(); if (words.length) commands.push(words); words = []; };
  for (let index = 0; index < script.length; index++) {
    const char = script[index]!;
    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
      continue;
    }
    if (char === "$" || char === "`") return [];
    if (char === "\\") {
      const next = script[++index];
      if (next === undefined) return [];
      if (quote === '"' && !['$', '`', '"', "\\", "\n"].includes(next)) return [];
      if (next !== "\n") word += next;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; continue; }
    if ("|&<>(){}".includes(char)) return [];
    if (char === "#" && !word) {
      while (index < script.length && script[index] !== "\n") index++;
      finishCommand();
    } else if (char === ";" || char === "\n") finishCommand();
    else if (/\s/.test(char)) finishWord();
    else word += char;
  }
  if (quote) return [];
  finishCommand();
  if (commands.some(words => /^(?:if|then|elif|else|fi|for|while|until|case|esac|do|done|select|function|eval|source|\.)$/.test(words[0]!))) return [];
  return commands;
}

/** Classify visible execution records, never execute logged code or treat task prose as actions. */
export function workflowTrace(events: ObjectValue[], source: string, lines?: number[]): WorkflowTrace {
  const metadata = object(events.find(event => event.type === "session_meta")?.payload);
  const trace: WorkflowTrace = { source, events: [], encrypted_messages: 0, agent_path: typeof metadata.agent_path === "string" ? metadata.agent_path : null };
  const completedCommands = new Set<string>();
  for (const [index, event] of events.entries()) {
    const payload = object(event.payload);
    if (event.type === "response_item" && payload.type === "agent_message") {
      if (Array.isArray(payload.content) && payload.content.some(block => object(block).type === "encrypted_content")) trace.encrypted_messages++;
    }
    if (typeof event.timestamp !== "string" || !Number.isFinite(Date.parse(event.timestamp))) continue;
    const base = { line: lines?.[index] ?? index + 1, timestamp: event.timestamp };
    if (event.type === "response_item" && payload.type === "agent_message" && Array.isArray(payload.content)) {
      const text = payload.content.filter(block => object(block).type === "input_text").map(block => object(block).text).filter(value => typeof value === "string").join("\n");
      const verdict = /^#+ Recommendation: (COMMENT|FIX|APPROVE)\s*$/m.exec(text)?.[1] as WorkflowEvent["verdict"];
      if (verdict && typeof payload.author === "string") {
        // Retain only the short assessment heading, not private assignment/message bodies.
        const finding = /^\*\*(?:CRITICAL|HIGH|MEDIUM|LOW),[^\n]*?: ([^\n*]{1,180})\*\*$/m.exec(text)?.[1];
        trace.events.push({ ...base, kind: "review_result", target: payload.author, verdict, finding });
      }
    }
    if (event.type === "response_item" && (payload.type === "function_call" || payload.type === "custom_tool_call")) {
      const name = typeof payload.name === "string" ? payload.name.split(".").at(-1)! : "";
      const input = typeof (payload.arguments ?? payload.input) === "string" ? String(payload.arguments ?? payload.input) : "";
      let args: ObjectValue = {};
      try { args = object(JSON.parse(input)); } catch { /* Custom tool programs are not JSON. */ }
      if (name === "spawn_agent" && typeof args.task_name === "string") trace.events.push({ ...base, kind: "spawn", target: args.task_name, isolated_context: args.fork_turns === "none" });
      // An initial assignment mentioning the future signal is not a readiness event.
      if ((name === "send_message" || name === "followup_task") && typeof args.message === "string"
        && /^\s*main done\b/i.test(args.message)) {
        trace.events.push({ ...base, kind: "ready", target: typeof args.target === "string" ? args.target : undefined });
      } else if ((name === "send_message" || name === "followup_task") && typeof args.target === "string") {
        trace.events.push({ ...base, kind: "message", target: args.target });
      }
      if (name === "wait_agent") trace.events.push({ ...base, kind: "wait" });
    }
    if (event.type !== "event_msg" || payload.type !== "item_completed") continue;
    const item = object(payload.item);
    if (item.type === "FileChange" && item.status === "completed" && Object.keys(object(item.changes)).length > 0) {
      trace.events.push({ ...base, kind: "edit" });
    }
    if (item.type !== "CommandExecution" || item.status !== "completed") continue;
    if (typeof item.id === "string") {
      if (completedCommands.has(item.id)) continue;
      completedCommands.add(item.id);
    }
    trace.events.push({ ...base, kind: "command", seconds: seconds(item.duration), exit_code: typeof item.exit_code === "number" ? item.exit_code : undefined });
    const argv = Array.isArray(item.command) && item.command.every(part => typeof part === "string") ? item.command : [];
    const shell = argv.length >= 3 && /(?:^|\/)(?:bash|sh|zsh)$/.test(argv[0]!) && /^-[a-z]*c$/.test(argv[1]!);
    const command = literalShellScript(typeof item.command === "string" ? item.command : shell ? argv[2]! : argv.join(" "));
    const output = typeof item.aggregated_output === "string" ? item.aggregated_output : "";
    // Only completed command records are classified. Quoted instructions in prompts are ignored.
    const commands = shellCommands(command).map(words => words[0] === "rtk" ? words.slice(1) : words);
    const testCommands = commands.filter(words => (words[0] === "pytest")
      || (["go", "bun", "npm"].includes(words[0] ?? "") && words[1] === "test")
      || (words[0] === "shadowtree" && (words[1] === "test" || words[1] === "check")));
    if (commands.length === 1 && testCommands.length === 1 && !testCommands[0]!.some(word => /^--?(?:h|help|list)$/.test(word))) {
      const packageTimes = [...output.matchAll(/^ok\s+\S+\s+(\d+(?:\.\d+)?)s(?:\s|$)/gm)];
      trace.events.push({ ...base, kind: "test", seconds: seconds(item.duration),
        wrapper: commands.length === 1 && testCommands[0]![0] === "shadowtree" ? "shadowtree" : undefined,
        exit_code: typeof item.exit_code === "number" && commands.length === 1 ? item.exit_code : undefined,
        // Sum package durations only for a single reported package; parallel suites are not additive.
        package_seconds: packageTimes.length === 1 ? Number(packageTimes[0]![1]) : undefined });
    }
    if (/overlayfs/i.test(output) && /(?:cop(?:y|ied|ying)|fallback)/i.test(output)) trace.events.push({ ...base, kind: "copy_fallback" });
  }
  return trace;
}

export interface ReviewPolicy {
  source: string;
  line: number;
  gated_review: boolean;
}

export function reviewPolicy(text: string, source: string): ReviewPolicy {
  const gate = /Send ["“]main done["”] only after implementation, documentation, and all required validation\s+are finished\./.exec(text);
  return {
    source, line: gate ? text.slice(0, gate.index).split("\n").length : 1,
    gated_review: Boolean(gate) && /not requests for action/.test(text)
      && /without acknowledgments, further\s+inspection, or interim findings/.test(text),
  };
}

export interface MechanismFinding {
  mechanism: string;
  explanation: string;
  evidence: string[];
  limitation: string;
}

export interface MechanismReport {
  findings: MechanismFinding[];
  unknowns: string[];
}

export interface MechanismArm {
  arm: string;
  usage: MeteredRollouts;
  policy?: ReviewPolicy;
}

function reference(trace: WorkflowTrace, event: WorkflowEvent): string {
  return `${trace.source}:${event.line} (${event.timestamp}; ${event.kind})`;
}

export function explainMechanisms(arms: MechanismArm[], labels: Record<string, string> = {}): MechanismReport {
  const findings: MechanismFinding[] = [];
  const unknowns = new Set<string>();
  for (const { arm, usage, policy } of arms) {
    for (const root of usage.sessions.filter(session => !session.parent_thread_id)) {
      const trace = root.workflow;
      if (!trace) continue;
      const children = usage.sessions.filter(session => session.parent_thread_id === root.thread_id && session.agent_role?.startsWith("review"));
      if (children.length && !policy?.gated_review) unknowns.add(`${labels[arm] ?? arm}: no recognized captured review-gate instruction; the observed behavior is not attributed to a policy.`);
      for (const child of children) {
        const childTrace = child.workflow;
        if (!childTrace) continue;
        const targetsChild = (event: WorkflowEvent): boolean => Boolean(childTrace.agent_path && event.target
          && (event.target === childTrace.agent_path || event.target === childTrace.agent_path.split("/").at(-1)));
        const finding = trace.events.find(event => event.kind === "review_result" && targetsChild(event) && (event.verdict === "COMMENT" || event.verdict === "FIX"));
        const firstResult = trace.events.find(event => event.kind === "review_result" && targetsChild(event));
        const firstTest = trace.events.find(event => event.kind === "test" && event.exit_code === 0);
        const ready = trace.events.find(event => event.kind === "ready" && targetsChild(event))
          ?? trace.events.filter(event => event.kind === "message" && targetsChild(event) && firstResult && firstTest
            && Date.parse(event.timestamp) < Date.parse(firstResult.timestamp) && Date.parse(event.timestamp) > Date.parse(firstTest.timestamp)).at(-1);
        const before = childTrace.events.filter(event => ready && Date.parse(event.timestamp) < Date.parse(ready.timestamp));
        const wait = before.find(event => event.kind === "wait");
        const preparation = before.filter(event => event.kind === "command" && wait && Date.parse(event.timestamp) < Date.parse(wait.timestamp));
        const launch = trace.events.find(event => event.kind === "spawn" && event.isolated_context && targetsChild(event));
        if (launch && preparation.length && wait && Date.parse(launch.timestamp) < Date.parse(preparation[0]!.timestamp)) findings.push({
          mechanism: `${labels[arm] ?? arm}: review started with a separate preparation context`,
          explanation: "The parent launched this reviewer with fork_turns=none, so the reviewer did not inherit the parent’s conversation. The child performed its own command work before waiting for the parent. This creates a second context-processing path rather than reusing the parent’s accumulated context, and adds input processing before the parent’s later contact. Its recorded cost is included in the reviewer accounting below.",
          evidence: [reference(trace, launch), reference(childTrace, preparation[0]!), reference(childTrace, wait)],
          limitation: "Independent preparation can improve review quality. These records establish separate work, not that the same files were successfully read or that preparation could safely be omitted.",
        });
        if (!ready) { unknowns.add(`${labels[arm] ?? arm}: no visible actual review-readiness signal; review phases cannot be reconstructed.`); continue; }
        const after = trace.events.filter(event => Date.parse(event.timestamp) > Date.parse(ready.timestamp));
        const edit = after.find(event => event.kind === "edit" && finding && Date.parse(event.timestamp) > Date.parse(finding.timestamp));
        const testsBefore = trace.events.filter(event => event.kind === "test" && event.exit_code === 0 && Date.parse(event.timestamp) < Date.parse(ready.timestamp));
        const testsAfter = after.filter(event => edit && event.kind === "test" && Date.parse(event.timestamp) > Date.parse(edit.timestamp));
        const reready = after.find(event => (event.kind === "ready" || event.kind === "message") && targetsChild(event)
          && testsAfter.length && Date.parse(event.timestamp) > Date.parse(testsAfter[0]!.timestamp));
        const approval = after.find(event => event.kind === "review_result" && targetsChild(event) && event.verdict === "APPROVE"
          && reready && Date.parse(event.timestamp) > Date.parse(reready.timestamp));
        if (preparation.length && wait && policy?.gated_review) findings.push({
          mechanism: `${labels[arm] ?? arm}: early reviewer launch did not permit early substantive review`,
          explanation: "The captured instructions require the parent to finish implementation and validation before sending “main done”, and prohibit the reviewer from inspecting milestones or returning interim findings. The trace shows reviewer familiarization and waiting before a parent message following test execution. This policy overlaps preparation, but schedules substantive review after initial validation rather than overlapping defect discovery with implementation.",
          evidence: [`${policy.source}:${policy.line} (captured review gate)`, reference(childTrace, preparation[0]!), reference(childTrace, wait), reference(trace, ready)],
          limitation: ready.kind === "ready" ? "The instruction-to-sequence match supports this scheduling mechanism, not an exact estimate of time saved by another policy."
            : "No explicit readiness signal was recognized in the parent message. Its timing is compatible with the prescribed handoff, but does not establish readiness or intent. The policy explains required scheduling, not proven transcript-level compliance.",
        });
        if (finding && Date.parse(finding.timestamp) > Date.parse(ready.timestamp) && edit && testsBefore.length && testsAfter.length && reready && approval) findings.push({
          mechanism: `${labels[arm] ?? arm}: edits after initial validation forced a second validation/review cycle`,
          explanation: `Successful test execution preceded a parent message to this reviewer; the message’s intent is not needed to establish the following sequence. The reviewer returned ${finding.verdict}${finding.finding ? ` with the finding “${finding.finding.replace(/\.$/, "")}”` : " with findings"}. A completed file change was then recorded, followed by tests and another parent message to the same reviewer, who returned APPROVE. Initial validation therefore did not cover the final edited state. This adds sequential edit/test/re-review work, plus model requests processing the accumulated conversation, rather than just additional code output.`,
          evidence: [reference(trace, testsBefore.at(-1)!), reference(trace, ready), reference(trace, finding), reference(trace, edit), ...testsAfter.map(event => reference(trace, event)), reference(trace, reready), reference(trace, approval)],
          limitation: "The visible sequence supports a review-driven correction cycle. The reported defect is a reviewer assessment, not an independently rerun reproducer; this rule does not prove the exact edit repaired it or that the cycle was avoidable.",
        });
      }
      const fallback = trace.events.find(event => event.kind === "copy_fallback");
      const wrapped = trace.events.filter(event => event.kind === "test" && event.wrapper === "shadowtree" && event.seconds !== undefined && event.package_seconds !== undefined && event.seconds > event.package_seconds + 1);
      if (fallback && wrapped.length) findings.push({
        mechanism: `${labels[arm] ?? arm}: environment preparation made short tests expensive to invoke`,
        explanation: `Execution output reports an overlayfs/copy fallback. In the same session, single-package test commands took ${wrapped.map(event => `${event.seconds!.toFixed(3)}s overall versus ${event.package_seconds!.toFixed(3)}s reported by the package`).join("; ")}. The command includes work outside the package test timer; repeating validation pays that surrounding work again.`,
        evidence: [reference(trace, fallback), ...wrapped.map(event => reference(trace, event))],
        limitation: "The time difference includes setup, build and command overhead. It cannot all be attributed to copying, nor does this isolate the launcher’s causal effect.",
      });
    }
    if (usage.sessions.some(session => session.workflow?.encrypted_messages)) unknowns.add(`${labels[arm] ?? arm}: some received agent messages are encrypted; their findings and intent are not inferred.`);
    if (!usage.sessions.some(session => session.workflow?.events.length)) unknowns.add(`${labels[arm] ?? arm}: no recognized visible workflow events; missing evidence is not evidence of no overhead.`);
  }
  const stock = arms.find(arm => arm.arm === "stock")?.usage;
  const current = arms.find(arm => arm.arm === "current")?.usage;
  if (stock?.complete && current?.complete) {
    const roots = (usage: MeteredRollouts) => usage.agents.filter(agent => usage.sessions.some(session => session.thread_id === agent.thread_id && !session.parent_thread_id));
    const a = roots(stock), b = roots(current);
    if (a.length && b.length && [...a, ...b].every(agent => agent.request_count !== null)) {
      const requestsA = a.reduce((sum, agent) => sum + agent.request_count!, 0), requestsB = b.reduce((sum, agent) => sum + agent.request_count!, 0);
      if (requestsA > 0 && requestsB > requestsA) {
        const inputA = a.reduce((sum, agent) => sum + agent.usage.input_tokens, 0);
        const inputB = b.reduce((sum, agent) => sum + agent.usage.input_tokens, 0);
        const meanA = inputA / requestsA, meanB = inputB / requestsB;
        const deltaInput = inputB - inputA;
        const countComponent = (requestsB - requestsA) * (meanA + meanB) / 2;
        const contextComponent = (meanB - meanA) * (requestsA + requestsB) / 2;
        const tokens = (value: number): string => value.toLocaleString("en-US", { maximumFractionDigits: 1 });
        const componentDetail = deltaInput > 0
          ? `A symmetric algebraic decomposition associates approximately ${tokens(countComponent)} tokens (${(countComponent / deltaInput * 100).toFixed(1)}%) with the request-count difference and ${tokens(contextComponent)} tokens (${(contextComponent / deltaInput * 100).toFixed(1)}%) with the difference in mean input per request.`
          : deltaInput === 0
            ? `The request-count and mean-input components cancel: approximately ${tokens(countComponent)} and ${tokens(contextComponent)} tokens respectively.`
            : `The ${tokens(deltaInput)}-token difference is the sum of an approximately ${tokens(countComponent)}-token request-count component and ${tokens(contextComponent)}-token mean-input component.`;
        const cachedCostA = a.every(agent => agent.cost_components.cached_input_usd !== null)
          ? a.reduce((sum, agent) => sum + agent.cost_components.cached_input_usd!, 0) : null;
        const cachedCostB = b.every(agent => agent.cost_components.cached_input_usd !== null)
          ? b.reduce((sum, agent) => sum + agent.cost_components.cached_input_usd!, 0) : null;
        const uncachedCostA = a.every(agent => agent.cost_components.uncached_input_usd !== null)
          ? a.reduce((sum, agent) => sum + agent.cost_components.uncached_input_usd!, 0) : null;
        const uncachedCostB = b.every(agent => agent.cost_components.uncached_input_usd !== null)
          ? b.reduce((sum, agent) => sum + agent.cost_components.uncached_input_usd!, 0) : null;
        const cacheWriteCostA = a.every(agent => agent.cost_components.cache_write_input_usd !== null)
          ? a.reduce((sum, agent) => sum + agent.cost_components.cache_write_input_usd!, 0) : null;
        const cacheWriteCostB = b.every(agent => agent.cost_components.cache_write_input_usd !== null)
          ? b.reduce((sum, agent) => sum + agent.cost_components.cache_write_input_usd!, 0) : null;
        const outputCostA = a.every(agent => agent.cost_components.output_usd !== null)
          ? a.reduce((sum, agent) => sum + agent.cost_components.output_usd!, 0) : null;
        const outputCostB = b.every(agent => agent.cost_components.output_usd !== null)
          ? b.reduce((sum, agent) => sum + agent.cost_components.output_usd!, 0) : null;
        const signedUsd = (value: number): string => `${value >= 0 ? "+" : "-"}$${Math.abs(value).toFixed(6)}`;
        const costDetail = cachedCostA !== null && cachedCostB !== null && uncachedCostA !== null && uncachedCostB !== null
          && cacheWriteCostA !== null && cacheWriteCostB !== null && outputCostA !== null && outputCostB !== null
          ? ` The model-priced cost components differ by ${signedUsd(cachedCostB - cachedCostA)} cached input, ${signedUsd(uncachedCostB - uncachedCostA)} uncached input, ${signedUsd(cacheWriteCostB - cacheWriteCostA)} cache writes, and ${signedUsd(outputCostB - outputCostA)} output.`
          : "";
        const hidden = (usage: MeteredRollouts, agents: typeof a, requests: number, name: string): string => {
          if (!usage.codex_visible_requests) return "";
          const visible = [...new Set(agents.map(agent => agent.thread_id))].reduce<number | null>((sum, id) => {
            const count = usage.codex_visible_requests![id];
            return sum === null || count == null ? null : sum + count;
          }, 0);
          return visible === null || visible >= requests ? ""
            : ` ${requests - visible} of ${name}'s ${requests} requests were provider attempts that Codex did not record, such as router-local tool re-sends or retries.`;
        };
        const hiddenDetail = hidden(current, b, requestsB, `${labels.current ?? "the current"} parent`) + hidden(stock, a, requestsA, `${labels.stock ?? "the stock"} parent`);
        findings.push({
          mechanism: "Extra workflow turns repeatedly process accumulated context",
          explanation: `${labels.current ?? "The current"} parent made ${requestsB} model requests versus ${requestsA} for ${labels.stock ?? "stock"} and processed ${inputB.toLocaleString("en-US")} versus ${inputA.toLocaleString("en-US")} input tokens, a difference of ${deltaInput.toLocaleString("en-US")}.${hiddenDetail} ${componentDetail} Every request processes accumulated history again; caching reduces its price but not its token count.${costDetail}`,
          evidence: [hiddenDetail
            ? "Validated Mekugi provider attempts (excluding prewarm), Codex-recorded request counts, and per-root usage in the tables below."
            : "Deduplicated per-root token usage, request counts, and model-specific cost components in the tables below."],
          limitation: "This symmetric accounting decomposition is not a causal counterfactual. It shows where the measured delta sits; visible workflow events are needed to explain why each additional request occurred, and provider cache-key decisions remain unknown.",
        });
      }
    }
  }
  unknowns.add("Unrecognized command forms and opaque messages are not classified. No rule infers a general causal effect from this single pair, or explains cache misses from token counts alone.");
  return { findings, unknowns: [...unknowns] };
}

export function mechanismsMarkdown(report: MechanismReport): string {
  return `## Why the observed workflow added work\n\nThis section uses deterministic evidence rules, not a model-generated explanation. Each conclusion names the mechanism, its supporting events, and what those events cannot establish.\n\n${report.findings.map(finding => `### ${finding.mechanism}\n\n${finding.explanation}\n\nEvidence:\n${finding.evidence.map(item => `- ${item}`).join("\n")}\n\nLimit: ${finding.limitation}`).join("\n\n") || "No supported behavioral mechanism could be established from the available visible events. Accounting alone is not a causal explanation."}\n\n### Unresolved causes and coverage\n\n${report.unknowns.map(item => `- ${item}`).join("\n")}\n`;
}
