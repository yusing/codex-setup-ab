export type CandidateFailureExecution = "infrastructure_failure" | "model_failure" | "unknown";

export type CandidateFailureReason =
  | "container_oom_killed"
  | "provider_transient_error"
  | "provider_auth_or_quota"
  | "runtime_cli_error"
  | "model_error"
  | "unknown_nonzero_exit";

export interface CandidateFailureClassification {
  execution: CandidateFailureExecution;
  reason: CandidateFailureReason;
  retryable: boolean;
  detail: string;
}

export interface CandidateRetryAttempt {
  attempt: number;
  started_at: string;
  finished_at: string;
  exit_code: number;
  reason: CandidateFailureReason;
  detail: string;
  stdout_path: string;
  stderr_path: string;
}

export interface CandidateFailureInput {
  exitCode: number;
  oomKilled?: boolean;
  stderr?: string;
  stdout?: string;
}

const MAX_DETAIL_LENGTH = 240;

export function sanitizeDiagnosticDetail(raw: string, maxLength = MAX_DETAIL_LENGTH): string {
  const redacted = raw
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, "[REDACTED_KEY]")
    .replace(/\b(api[_-]?key|x-api-key|authorization)\s*([:=])\s*[^\s,"';]+/gi, "$1$2[REDACTED]")
    .replace(/\b(access_token|refresh_token|id_token|token)\s*([:=])\s*["']?[A-Za-z0-9._~+/=-]{16,}["']?/gi, "$1$2[REDACTED]")
    .replace(/\s+/g, " ")
    .trim();
  if (redacted.length <= maxLength) return redacted;
  return `${redacted.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

interface ParsedDiagnostics {
  stderrLines: string[];
  jsonlErrors: string[];
  plainStdoutLines: string[];
  streamDisconnectedBeforeCompletion: string | undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function collectErrorStrings(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  const record = asRecord(value);
  if (!record) return [];
  const parts: string[] = [];
  for (const key of ["code", "type", "message", "detail", "reason"] as const) {
    const field = record[key];
    if (typeof field === "string" && field.trim()) parts.push(field.trim());
  }
  if (record.error !== undefined) parts.push(...collectErrorStrings(record.error));
  if (record.response !== undefined) {
    const response = asRecord(record.response);
    if (response?.error !== undefined) parts.push(...collectErrorStrings(response.error));
  }
  return parts;
}

function parseDiagnostics(stderr = "", stdout = ""): ParsedDiagnostics {
  const stderrLines = stderr.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const jsonlErrors: string[] = [];
  const plainStdoutLines: string[] = [];
  let streamDisconnectLine: string | undefined;
  let completedAfterDisconnect = false;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      plainStdoutLines.push(line);
      continue;
    }
    const event = asRecord(parsed);
    if (!event) continue;
    const type = typeof event.type === "string" ? event.type : undefined;
    if (type === "turn.completed" || type === "response.completed") {
      if (streamDisconnectLine) completedAfterDisconnect = true;
      continue;
    }
    if (type === "item.completed") {
      const item = asRecord(event.item);
      if (item?.type === "agent_message" && streamDisconnectLine) {
        completedAfterDisconnect = true;
      } else if (item?.type === "error") {
        const message = collectErrorStrings(item).join(": ");
        if (message) {
          if (/stream\s+disconnected/i.test(message)) {
            streamDisconnectLine = message;
            completedAfterDisconnect = false;
          } else {
            jsonlErrors.push(message);
          }
        }
      }
      continue;
    }
    if (type === "error" || type === "turn.failed" || type === "response.failed" || type === "run.failed" || type === "session.failed" || type === "item.failed") {
      const parts = collectErrorStrings(event.error !== undefined ? event.error : event);
      const message = parts.length ? parts.join(": ") : "";
      if (message) {
        if (/stream\s+disconnected/i.test(message)) {
          streamDisconnectLine = message;
          completedAfterDisconnect = false;
        } else {
          jsonlErrors.push(message);
        }
      }
      continue;
    }
    if (!type && event.error !== undefined) {
      const message = collectErrorStrings(event.error).join(": ");
      if (message) {
        if (/stream\s+disconnected/i.test(message)) {
          streamDisconnectLine = message;
          completedAfterDisconnect = false;
        } else {
          jsonlErrors.push(message);
        }
      }
    }
  }

  for (const line of stderrLines) {
    if (/stream\s+disconnected/i.test(line) && !completedAfterDisconnect) {
      streamDisconnectLine ??= line;
    }
  }

  return {
    stderrLines,
    jsonlErrors,
    plainStdoutLines,
    streamDisconnectedBeforeCompletion: completedAfterDisconnect ? undefined : streamDisconnectLine,
  };
}

const AUTH_OR_QUOTA_PATTERNS: readonly RegExp[] = [
  /\b(?:http|status(?:\s+code)?)\s*[:=]?\s*(?:401|403)\b/i,
  /\b401\s+unauthorized\b/i,
  /\b403\s+forbidden\b/i,
  /\binvalid_api_key\b/i,
  /\b(?:invalid|incorrect)\s+api[\s_-]*key\b/i,
  /\binsufficient_quota\b/i,
  /\b(?:exceeded\s+your\s+current\s+quota|quota\s+exceeded)\b/i,
  /\bbilling_hard_limit_reached\b/i,
  /\bcredit\s+balance\s+is\s+too\s+low\b/i,
  /\bauthentication\s+failed\b/i,
  /\b(?:invalid_auth|token_expired|refresh_token_reused)\b/i,
];

const TRANSIENT_PROVIDER_PATTERNS: readonly RegExp[] = [
  /\b(?:http|status(?:\s+code)?)\s*[:=]?\s*429\b/i,
  /\b429\s+too\s+many\s+requests\b/i,
  /\btoo\s+many\s+requests\b/i,
  /\brate[\s_-]*limit/i,
  /selected\s+model\s+is\s+at\s+capacity/i,
  /\bmodel\s+is\s+at\s+capacity\b/i,
  /\b(?:http|status(?:\s+code)?)\s*[:=]?\s*(?:502|503|504)\b/i,
  /\b(?:http|status(?:\s+code)?)\s*[:=]?\s*500\b/i,
  /\b500\s+internal\s+server\s+error\b/i,
  /\binternal\s+server\s+error\b/i,
  /\bserver_error\b/i,
  /\b502\s+bad\s+gateway\b/i,
  /\b503\s+service\s+unavailable\b/i,
  /\b504\s+gateway\s+timeout\b/i,
  /\bbad\s+gateway\b/i,
  /\bservice\s+unavailable\b/i,
  /\bgateway\s+timeout\b/i,
  /\boverloaded(?:_error)?\b/i,
  /\b(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH)\b/,
  /\btls\s+handshake\s+timeout\b/i,
  /\bsocket\s+hang\s+up\b/i,
  /\bconnection\s+reset\s+by\s+peer\b/i,
  /\bconnection\s+closed\s+before\s+message\s+completed\b/i,
];

const RUNTIME_CLI_PATTERNS: readonly RegExp[] = [
  /\bcommand\s+not\s+found\b/i,
  /\bcannot\s+execute\b/i,
  /\bENOENT\b/,
  /(?:codex|mekugi|grok|mise|launcher|\/usr\/local\/bin\/|exec)[^\n]*no\s+such\s+file\s+or\s+directory/i,
  /no\s+such\s+file\s+or\s+directory[^\n]*(?:codex|mekugi|grok|mise|launcher)/i,
];

const MODEL_FAILURE_PATTERNS: readonly RegExp[] = [
  /\bmax[\s_-]*(?:steps|turns)\b/i,
  /\bmaximum\s+number\s+of\s+(?:steps|turns)\b/i,
  /\b(?:step|turn)\s+limit\s+(?:reached|exceeded)\b/i,
  /\b(?:refusal|model\s+refused|content_policy|content_filter|safety_violation)\b/i,
  /\bcontext_length_exceeded\b/i,
  /\bmaximum\s+context\s+length\b/i,
  /\bmodel_error\b/i,
];

function firstMatch(lines: readonly string[], patterns: readonly RegExp[]): string | undefined {
  for (const line of lines) {
    if (patterns.some(pattern => pattern.test(line))) return line;
  }
  return undefined;
}

export function classifyCandidateFailure(input: CandidateFailureInput): CandidateFailureClassification {
  if (input.oomKilled === true) {
    return {
      execution: "infrastructure_failure",
      reason: "container_oom_killed",
      retryable: false,
      detail: sanitizeDiagnosticDetail(`Container was OOM-killed (exit ${input.exitCode})`),
    };
  }

  const diagnostics = parseDiagnostics(input.stderr, input.stdout);
  const allDiagnosticLines = [
    ...diagnostics.jsonlErrors,
    ...diagnostics.stderrLines,
    ...diagnostics.plainStdoutLines,
  ];

  // Check auth/billing/quota before transient 429 so quota-exhausted 429s are never retried.
  const authMatch = firstMatch(allDiagnosticLines, AUTH_OR_QUOTA_PATTERNS);
  if (authMatch) {
    return {
      execution: "infrastructure_failure",
      reason: "provider_auth_or_quota",
      retryable: false,
      detail: sanitizeDiagnosticDetail(authMatch),
    };
  }

  const transientMatch = firstMatch(allDiagnosticLines, TRANSIENT_PROVIDER_PATTERNS)
    ?? diagnostics.streamDisconnectedBeforeCompletion;
  if (transientMatch) {
    return {
      execution: "infrastructure_failure",
      reason: "provider_transient_error",
      retryable: true,
      detail: sanitizeDiagnosticDetail(transientMatch),
    };
  }

  const cliMatch = firstMatch([...diagnostics.stderrLines, ...diagnostics.plainStdoutLines], RUNTIME_CLI_PATTERNS);
  if (input.exitCode === 126 || input.exitCode === 127 || cliMatch) {
    return {
      execution: "infrastructure_failure",
      reason: "runtime_cli_error",
      retryable: false,
      detail: sanitizeDiagnosticDetail(cliMatch ?? `Runtime CLI launch failed with exit code ${input.exitCode}`),
    };
  }

  const modelMatch = firstMatch(allDiagnosticLines, MODEL_FAILURE_PATTERNS);
  if (modelMatch) {
    return {
      execution: "model_failure",
      reason: "model_error",
      retryable: false,
      detail: sanitizeDiagnosticDetail(modelMatch),
    };
  }

  const fallbackDetail = diagnostics.jsonlErrors[0]
    ?? diagnostics.stderrLines[0]
    ?? diagnostics.plainStdoutLines[0]
    ?? `Candidate exited with nonzero code ${input.exitCode}`;
  return {
    execution: "unknown",
    reason: "unknown_nonzero_exit",
    retryable: false,
    detail: sanitizeDiagnosticDetail(fallbackDetail),
  };
}
