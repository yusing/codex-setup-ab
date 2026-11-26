import { open, stat } from "node:fs/promises";
import type { RunawayGuardConfig, RunawayGuardTrigger } from "./types";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function normalizeRunawayGuardConfig(config?: RunawayGuardConfig): RunawayGuardConfig | undefined {
  if (!config) return undefined;
  const normalized: RunawayGuardConfig = {};
  if (config.max_turns !== undefined) {
    if (!Number.isSafeInteger(config.max_turns) || config.max_turns < 1) {
      throw new Error("--max-turns must be a positive integer");
    }
    normalized.max_turns = config.max_turns;
  }
  if (config.max_total_tokens !== undefined) {
    if (!Number.isSafeInteger(config.max_total_tokens) || config.max_total_tokens < 1) {
      throw new Error("--max-total-tokens must be a positive integer");
    }
    normalized.max_total_tokens = config.max_total_tokens;
  }
  if (config.repeated_error_limit !== undefined) {
    if (!Number.isSafeInteger(config.repeated_error_limit) || config.repeated_error_limit < 0) {
      throw new Error("--stuck-loop-limit must be a non-negative integer");
    }
    if (config.repeated_error_limit > 0) normalized.repeated_error_limit = config.repeated_error_limit;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function hasActiveRunawayGuard(config?: RunawayGuardConfig): boolean {
  if (!config) return false;
  return (config.max_turns !== undefined && config.max_turns > 0)
    || (config.max_total_tokens !== undefined && config.max_total_tokens > 0)
    || (config.repeated_error_limit !== undefined && config.repeated_error_limit > 0);
}

export function normalizeErrorSignature(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(" | ")
    .replace(/0x[0-9a-f]+/gi, "0x<hex>")
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, "<ts>")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, 240);
}

function extractUsageTokens(value: unknown): number | undefined {
  if (!isObject(value)) return undefined;
  const total = nonNegativeInt(value.total_tokens);
  if (total !== undefined) return total;
  const input = nonNegativeInt(value.input_tokens);
  const output = nonNegativeInt(value.output_tokens);
  if (input !== undefined || output !== undefined) {
    return (input ?? 0) + (output ?? 0);
  }
  return undefined;
}

function extractMessage(value: unknown): string {
  if (typeof value === "string") return value;
  if (isObject(value)) {
    if (typeof value.message === "string") return value.message;
    if (typeof value.detail === "string") return value.detail;
    if (typeof value.error === "string") return value.error;
    if (isObject(value.error) && typeof value.error.message === "string") return value.error.message;
  }
  return "";
}

function extractFailureSignature(event: JsonObject): { kind: "error"; signature: string } | { kind: "success" } | undefined {
  const payload = isObject(event.payload) ? event.payload : undefined;

  if (event.type === "error") {
    const msg = normalizeErrorSignature(extractMessage(event));
    return msg ? { kind: "error", signature: `error:${msg}` } : undefined;
  }
  if (event.type === "turn.failed") {
    const msg = normalizeErrorSignature(extractMessage(event.error ?? event));
    return msg ? { kind: "error", signature: `turn.failed:${msg}` } : undefined;
  }
  if (event.type === "event_msg" && payload) {
    if (payload.type === "error") {
      const msg = normalizeErrorSignature(extractMessage(payload));
      return msg ? { kind: "error", signature: `error:${msg}` } : undefined;
    }
    if (payload.type === "item_completed" && isObject(payload.item)) {
      const item = payload.item;
      if (item.type === "CommandExecution") {
        const exitCode = typeof item.exit_code === "number" ? item.exit_code : undefined;
        if (exitCode === 0) return { kind: "success" };
        if (exitCode !== undefined && exitCode !== 0) {
          const cmd = normalizeErrorSignature(typeof item.command === "string" ? item.command : "");
          const err = normalizeErrorSignature(extractMessage(item.stderr ?? item.aggregated_output ?? item.error));
          return { kind: "error", signature: `cmd:${cmd}|exit:${exitCode}|${err}` };
        }
      }
    }
  }
  if (event.method === "item/completed" && isObject(event.params) && isObject(event.params.item)) {
    const item = event.params.item;
    if (item.type === "commandExecution" || item.type === "command_execution") {
      const exitCode = typeof item.exitCode === "number" ? item.exitCode : typeof item.exit_code === "number" ? item.exit_code : undefined;
      const failed = item.status === "failed" || (exitCode !== undefined && exitCode !== 0);
      if (!failed && (item.status === "completed" || exitCode === 0)) return { kind: "success" };
      if (failed) {
        const cmd = normalizeErrorSignature(typeof item.command === "string" ? item.command : "");
        const err = normalizeErrorSignature(extractMessage(item.error ?? item.aggregatedOutput ?? item.aggregated_output ?? item.stderr));
        return { kind: "error", signature: `cmd:${cmd}|exit:${exitCode ?? "failed"}|${err}` };
      }
    }
    if (item.type === "mcpToolCall" || item.type === "toolCall" || item.type === "functionCall") {
      const failed = item.status === "failed" || Boolean(item.error);
      if (!failed && item.status === "completed") return { kind: "success" };
      if (failed) {
        const name = normalizeErrorSignature(String(item.tool ?? item.name ?? ""));
        const args = normalizeErrorSignature(typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? ""));
        const err = normalizeErrorSignature(extractMessage(item.error));
        return { kind: "error", signature: `tool:${name}|args:${args}|${err}` };
      }
    }
  }
  if (event.type === "item.completed" && isObject(event.item)) {
    const item = event.item;
    if (item.type === "command_execution") {
      const exitCode = typeof item.exit_code === "number" ? item.exit_code : undefined;
      const failed = item.status === "failed" || (exitCode !== undefined && exitCode !== 0);
      if (!failed && (item.status === "completed" || exitCode === 0)) return { kind: "success" };
      if (failed) {
        const cmd = normalizeErrorSignature(typeof item.command === "string" ? item.command : "");
        const err = normalizeErrorSignature(extractMessage(item.error ?? item.aggregated_output ?? item.stderr));
        return { kind: "error", signature: `cmd:${cmd}|exit:${exitCode ?? "failed"}|${err}` };
      }
    }
    if (item.type === "mcp_tool_call" || item.type === "tool_call" || item.type === "function_call") {
      const failed = item.status === "failed" || Boolean(item.error);
      if (!failed && item.status === "completed") return { kind: "success" };
      if (failed) {
        const name = normalizeErrorSignature(String(item.tool ?? item.name ?? ""));
        const args = normalizeErrorSignature(typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? ""));
        const err = normalizeErrorSignature(extractMessage(item.error));
        return { kind: "error", signature: `tool:${name}|args:${args}|${err}` };
      }
    }
    if (item.type === "error") {
      const msg = normalizeErrorSignature(extractMessage(item));
      return msg ? { kind: "error", signature: `error:${msg}` } : undefined;
    }
  }
  return undefined;
}

export class RunawayGuardMonitor {
  private turns = 0;
  private cumulativeTokens = 0;
  private incrementalTokens = 0;
  private seenResponseIds = new Set<string>();
  private lastErrorSignature: string | undefined;
  private consecutiveErrors = 0;
  private triggeredResult: RunawayGuardTrigger | undefined;

  constructor(private readonly config: RunawayGuardConfig) {}

  get triggered(): RunawayGuardTrigger | undefined {
    return this.triggeredResult;
  }

  get observedTurns(): number {
    return this.turns;
  }

  get observedTokens(): number {
    return Math.max(this.cumulativeTokens, this.incrementalTokens);
  }

  get observedConsecutiveErrors(): number {
    return this.consecutiveErrors;
  }

  consumeLine(line: string): RunawayGuardTrigger | undefined {
    if (this.triggeredResult) return this.triggeredResult;
    const trimmed = line.trim();
    if (!trimmed) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return undefined;
    }
    if (!isObject(parsed)) return undefined;
    return this.consumeEvent(parsed);
  }

  consumeEvent(event: JsonObject): RunawayGuardTrigger | undefined {
    if (this.triggeredResult) return this.triggeredResult;
    const payload = isObject(event.payload) ? event.payload : undefined;

    const isTurnStart = event.type === "turn.started";
    const isTurnComplete = event.type === "turn.completed"
      || event.type === "turn.failed"
      || event.type === "turn_completed"
      || event.type === "response.completed"
      || (event.type === "event_msg" && (payload?.type === "turn_complete" || payload?.type === "task_complete"));

    if (isTurnStart && this.config.max_turns && this.config.max_turns > 0 && this.turns >= this.config.max_turns) {
      return this.trigger("max_turns", `Started turn ${this.turns + 1}, exceeding max_turns limit (${this.config.max_turns})`, this.turns + 1, this.config.max_turns);
    }
    if (isTurnComplete) {
      this.turns += 1;
    }

    if (event.type === "event_msg" && payload?.type === "token_count" && isObject(payload.info)) {
      const total = extractUsageTokens(payload.info.total_token_usage);
      if (total !== undefined) {
        this.cumulativeTokens = Math.max(this.cumulativeTokens, total);
      } else {
        const last = extractUsageTokens(payload.info.last_token_usage);
        if (last !== undefined) this.incrementalTokens += last;
      }
    } else if (event.type === "token_usage_record" && payload) {
      const responseId = typeof payload.response_id === "string" && payload.response_id.trim() ? payload.response_id.trim() : undefined;
      if (!responseId || !this.seenResponseIds.has(responseId)) {
        if (responseId) this.seenResponseIds.add(responseId);
        const tokens = extractUsageTokens(payload.usage);
        if (tokens !== undefined) this.incrementalTokens += tokens;
      }
    } else if (event.type === "response.completed" && isObject(event.response)) {
      const responseId = typeof event.response.id === "string" && event.response.id.trim() ? event.response.id.trim() : undefined;
      if (!responseId || !this.seenResponseIds.has(responseId)) {
        if (responseId) this.seenResponseIds.add(responseId);
        const tokens = extractUsageTokens(event.response.usage);
        if (tokens !== undefined) this.incrementalTokens += tokens;
      }
    } else if (isObject(event.usage)) {
      const tokens = extractUsageTokens(event.usage);
      if (tokens !== undefined) this.incrementalTokens += tokens;
    }

    if (this.config.max_turns && this.config.max_turns > 0 && this.turns > this.config.max_turns) {
      return this.trigger("max_turns", `Completed ${this.turns} turns, exceeding max_turns limit (${this.config.max_turns})`, this.turns, this.config.max_turns);
    }

    const tokens = this.observedTokens;
    if (this.config.max_total_tokens && this.config.max_total_tokens > 0 && tokens > this.config.max_total_tokens) {
      return this.trigger("max_total_tokens", `Observed ${tokens} total tokens, exceeding max_total_tokens limit (${this.config.max_total_tokens})`, tokens, this.config.max_total_tokens);
    }

    if (this.config.repeated_error_limit && this.config.repeated_error_limit > 0) {
      const signal = extractFailureSignature(event);
      if (signal?.kind === "success") {
        this.lastErrorSignature = undefined;
        this.consecutiveErrors = 0;
      } else if (signal?.kind === "error") {
        if (signal.signature === this.lastErrorSignature) {
          this.consecutiveErrors += 1;
        } else {
          this.lastErrorSignature = signal.signature;
          this.consecutiveErrors = 1;
        }
        if (this.consecutiveErrors >= this.config.repeated_error_limit) {
          return this.trigger(
            "repeated_error_loop",
            `Repeated identical error ${this.consecutiveErrors} consecutive times (limit ${this.config.repeated_error_limit}): ${signal.signature}`,
            this.consecutiveErrors,
            this.config.repeated_error_limit,
          );
        }
      }
    }

    return undefined;
  }

  private trigger(reason: RunawayGuardTrigger["reason"], detail: string, observed: number, limit: number): RunawayGuardTrigger {
    this.triggeredResult = { triggered: true, reason, detail, observed, limit };
    return this.triggeredResult;
  }
}

export interface RunawayGuardHandle {
  stop(): Promise<RunawayGuardTrigger | undefined>;
  triggered(): RunawayGuardTrigger | undefined;
}

export function startRunawayGuard(options: {
  stdoutPath: string;
  config?: RunawayGuardConfig;
  controller: AbortController;
  pollIntervalMs?: number;
  onTrigger?: (trigger: RunawayGuardTrigger) => void;
}): RunawayGuardHandle {
  const { stdoutPath, config, controller, pollIntervalMs = 1000, onTrigger } = options;
  if (!config || !hasActiveRunawayGuard(config)) {
    return { stop: async () => undefined, triggered: () => undefined };
  }

  const monitor = new RunawayGuardMonitor(config);
  let offset = 0;
  let remainder = "";
  let stopped = false;
  let inFlight: Promise<void> | undefined;

  const poll = async (): Promise<void> => {
    if (stopped || monitor.triggered) return;
    try {
      const info = await stat(stdoutPath);
      if (info.size <= offset) return;
      const length = info.size - offset;
      const handle = await open(stdoutPath, "r");
      try {
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        offset += bytesRead;
        const chunk = remainder + buffer.subarray(0, bytesRead).toString("utf8");
        const lines = chunk.split("\n");
        remainder = lines.pop() ?? "";
        for (const line of lines) {
          const triggered = monitor.consumeLine(line);
          if (triggered) {
            stopped = true;
            clearInterval(timer);
            onTrigger?.(triggered);
            if (!controller.signal.aborted) controller.abort(new Error(triggered.detail));
            return;
          }
        }
      } finally {
        await handle.close();
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "ENOENT") {
        // Ignore transient read errors while the container is writing stdout.
      }
    }
  };

  const runPoll = (): void => {
    if (stopped || inFlight || monitor.triggered) return;
    inFlight = poll().finally(() => { inFlight = undefined; });
  };

  const timer = setInterval(runPoll, Math.max(25, pollIntervalMs));
  timer.unref?.();
  runPoll();

  return {
    triggered: () => monitor.triggered,
    async stop(): Promise<RunawayGuardTrigger | undefined> {
      stopped = true;
      clearInterval(timer);
      if (inFlight) await inFlight;
      return monitor.triggered;
    },
  };
}
