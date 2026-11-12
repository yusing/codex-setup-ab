import { createHash } from "node:crypto";

/** Assertions live in the supervisor, outside the candidate's process and UID. */
export interface SemanticVerification {
  schema: "codex-ab.verification.v1";
  cases: SemanticProbe[];
}

export type SemanticProbe = {
  id: string;
  kind: "command";
  /** Interpreter and entrypoint wiring, separate from behavioral input arguments. */
  command: string[];
  /** Frozen case data appended to command. Without this field, all argv is frozen. */
  args?: string[];
  stdin?: string;
  expected_exit: number;
  format: "text" | "json";
  /** Exact text, or JSON text compared structurally. Never executed as code. */
  expected: string;
} | {
  id: string;
  kind: "python-call";
  module: string;
  callable: string;
  /** JSON object containing args (array) and kwargs (object). */
  input: string;
  expected: string;
};

export interface VerifierRecord {
  schema: "codex-ab.verifier-result.v1";
  check_sha256: string;
  status: "passed" | "assertion_failure" | "candidate_error" | "evaluator_wiring" | "executor_setup" | "incomplete" | "timeout" | "canceled";
  completed: number;
  expected: number;
  detail: string;
  cases: Array<{ id: string; status: "pass" | "fail"; exit_code: number; stdout: string; stderr: string }>;
}

export function semanticCheckHash(check: object): string {
  return createHash("sha256").update(JSON.stringify(check)).digest("hex");
}

function json(value: unknown, field: string): void {
  if (typeof value !== "string") throw new Error(`${field} must be JSON text`);
  try {
    JSON.parse(value, (_key, item: unknown) => {
      if (typeof item === "number" && !Number.isFinite(item)) throw new Error("nonfinite value");
      return item;
    });
  } catch { throw new Error(`${field} must be finite valid JSON`); }
}

export function validateVerification(value: unknown): SemanticVerification {
  if (!value || typeof value !== "object") throw new Error("verification must be an object");
  const verification = value as SemanticVerification;
  if (verification.schema !== "codex-ab.verification.v1" || !Array.isArray(verification.cases) ||
      !verification.cases.length || verification.cases.length > 256) throw new Error("verification requires 1..256 supervisor-owned cases");
  const ids = new Set<string>();
  for (const item of verification.cases) {
    if (!item || typeof item.id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(item.id) || ids.has(item.id)) throw new Error("invalid or duplicate verification case");
    ids.add(item.id);
    if (item.kind === "command") {
      if (!Array.isArray(item.command) || !item.command.length || !item.command.every(part => typeof part === "string" && part.length > 0) ||
          (item.args !== undefined && (!Array.isArray(item.args) || !item.args.every(part => typeof part === "string"))) ||
          (item.stdin !== undefined && typeof item.stdin !== "string") || !Number.isSafeInteger(item.expected_exit) || item.expected_exit < 0 || item.expected_exit > 255 ||
          !["text", "json"].includes(item.format) || typeof item.expected !== "string") throw new Error("invalid command verification case");
      if (item.format === "json") json(item.expected, "expected");
    } else if (item.kind === "python-call") {
      if (typeof item.module !== "string" || !/^[a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*$/.test(item.module) ||
          typeof item.callable !== "string" || !/^[a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*$/.test(item.callable)) throw new Error("invalid Python call target");
      json(item.expected, "expected"); json(item.input, "input");
      const input = JSON.parse(item.input);
      if (!input || typeof input !== "object" || !Array.isArray(input.args) || !input.kwargs || typeof input.kwargs !== "object" || Array.isArray(input.kwargs) ||
          Object.keys(input).some(key => !["args", "kwargs"].includes(key))) throw new Error("Python call input requires only args and kwargs");
    } else throw new Error("unknown verification case kind");
  }
  return verification;
}

/** A missing, malformed or mismatched record never attests completion. */
export function validateVerifierRecord(value: unknown, check: object, expected: number): VerifierRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as VerifierRecord;
  const declared = (check as { verification?: SemanticVerification }).verification?.cases ?? [];
  if (declared.length !== expected) return undefined;
  if (record.schema !== "codex-ab.verifier-result.v1" || record.check_sha256 !== semanticCheckHash(check) ||
      !["passed", "assertion_failure", "candidate_error", "evaluator_wiring", "executor_setup", "incomplete", "timeout", "canceled"].includes(record.status) ||
      !Number.isSafeInteger(record.completed) || record.completed < 0 || record.completed > expected || record.expected !== expected ||
      typeof record.detail !== "string" || !Array.isArray(record.cases) || record.cases.length !== record.completed ||
      record.cases.some(item => !item || typeof item.id !== "string" || !["pass", "fail"].includes(item.status) ||
        !Number.isSafeInteger(item.exit_code) || typeof item.stdout !== "string" || typeof item.stderr !== "string")) return undefined;
  if (record.cases.some((item, index) => item.id !== declared[index]?.id)) return undefined;
  if (record.status === "passed" && (expected === 0 || record.completed !== expected || record.cases.some(item => item.status !== "pass"))) return undefined;
  if (record.status === "assertion_failure" && !record.cases.some(item => item.status === "fail")) return undefined;
  return record;
}
