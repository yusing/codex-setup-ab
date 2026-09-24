import { access, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { JUDGE_MODEL, runSemanticJudge } from "./semantic-judge";
import { readState, withRunLock, writeState } from "./state";
import { embeddedFallbackPricing, fetchPricing, type PricingSnapshot } from "./usage";
import type { ArmName, CommandEvidence, JudgePass, JudgeReport, RunState } from "./types";

const CANDIDATES = ["candidate-1", "candidate-2"] as const;
const SCORE_KEYS = ["correctness", "completeness", "maintainability", "test_quality"] as const;
type ScoreKey = (typeof SCORE_KEYS)[number];
type Candidate = (typeof CANDIDATES)[number];

export const OUTPUT_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object", additionalProperties: false,
  required: ["scores", "evidence", "issues", "winner", "rationale"],
  properties: {
    scores: {
      type: "object", additionalProperties: false, required: [...CANDIDATES],
      properties: Object.fromEntries(CANDIDATES.map(id => [id, {
        type: "object", additionalProperties: false,
        required: [...SCORE_KEYS],
        properties: Object.fromEntries(SCORE_KEYS.map(key => [key, { type: "number", minimum: 0, maximum: 5 }])),
      }])),
    },
    evidence: { type: "array", items: { type: "string", minLength: 1 } },
    issues: { type: "array", items: {
      type: "object", additionalProperties: false, required: ["candidate", "severity", "detail"],
      properties: {
        candidate: { type: "string", enum: [...CANDIDATES] },
        severity: { type: "string", enum: ["critical", "major", "minor"] },
        detail: { type: "string", minLength: 1 },
      },
    } },
    winner: { type: "string", enum: [...CANDIDATES, "tie", "none"] },
    rationale: { type: "string", minLength: 1 },
  },
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function lastAgentMessage(jsonl: string): string {
  let found = "";
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    if (!isRecord(value)) continue;
    const item = isRecord(value.item) ? value.item : undefined;
    if (value.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") found = item.text;
    if (value.type === "message" && typeof value.message === "string") found = value.message;
  }
  if (!found) throw new Error("judge produced no final agent message");
  return found;
}

function exactObject(value: unknown, fields: readonly string[], context: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${context} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new Error(`${context} must contain exactly: ${fields.join(", ")}`);
  }
  return value;
}

function candidate(value: unknown, context: string): Candidate {
  if (value !== "candidate-1" && value !== "candidate-2") throw new Error(`${context} must be candidate-1 or candidate-2`);
  return value;
}

function nonemptyString(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${context} must be a nonempty string`);
  return value;
}

export function validateJudgePass(value: unknown, pass: 1 | 2, presentation: [ArmName, ArmName], passing: Record<Candidate, boolean>): JudgePass {
  const root = exactObject(value, ["scores", "evidence", "issues", "winner", "rationale"], `judge pass ${pass}`);
  const rawScores = exactObject(root.scores, CANDIDATES, `judge pass ${pass}.scores`);
  const scores = {} as JudgePass["scores"];
  for (const id of CANDIDATES) {
    const source = exactObject(rawScores[id], SCORE_KEYS, `judge pass ${pass}.scores.${id}`);
    const validated = {} as Record<ScoreKey, number>;
    for (const key of SCORE_KEYS) {
      const score = source[key];
      if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 5) throw new Error(`judge pass ${pass}.scores.${id}.${key} must be a finite number from 0 to 5`);
      validated[key] = score;
    }
    scores[id] = { ...validated, weighted_total: Number(((validated.correctness * 50 + validated.completeness * 20 + validated.maintainability * 20 + validated.test_quality * 10) / 5).toFixed(2)) };
  }

  if (!Array.isArray(root.evidence)) throw new Error(`judge pass ${pass}.evidence must be an array`);
  const evidence = root.evidence.map((item, index) => nonemptyString(item, `judge pass ${pass}.evidence[${index}]`));
  if (!Array.isArray(root.issues)) throw new Error(`judge pass ${pass}.issues must be an array`);
  const issues: JudgePass["issues"] = root.issues.map((item, index) => {
    const issue = exactObject(item, ["candidate", "severity", "detail"], `judge pass ${pass}.issues[${index}]`);
    const severity = issue.severity;
    if (severity !== "critical" && severity !== "major" && severity !== "minor") throw new Error(`judge pass ${pass}.issues[${index}].severity is invalid`);
    return { candidate: candidate(issue.candidate, `judge pass ${pass}.issues[${index}].candidate`), severity, detail: nonemptyString(issue.detail, `judge pass ${pass}.issues[${index}].detail`) };
  });
  const winner = root.winner;
  if (winner !== "candidate-1" && winner !== "candidate-2" && winner !== "tie" && winner !== "none") throw new Error(`judge pass ${pass}.winner is invalid`);
  const critical = new Set(issues.filter(issue => issue.severity === "critical").map(issue => issue.candidate));
  if ((winner === "candidate-1" || winner === "candidate-2") && !passing[winner]) throw new Error(`judge pass ${pass} selected a candidate whose required benchmark gates failed or were not run`);
  if ((winner === "candidate-1" || winner === "candidate-2") && critical.has(winner)) throw new Error(`judge pass ${pass} selected a candidate with a critical issue`);
  if (winner === "tie" && CANDIDATES.some(id => !passing[id] || critical.has(id))) throw new Error(`judge pass ${pass} selected a tie containing an ineligible candidate`);
  return { pass, presentation, scores, evidence, issues, winner, rationale: nonemptyString(root.rationale, `judge pass ${pass}.rationale`) };
}

export function mappedWinner(pass: JudgePass): ArmName | "tie" | "none" {
  if (pass.winner === "tie" || pass.winner === "none") return pass.winner;
  return pass.presentation[pass.winner === "candidate-1" ? 0 : 1];
}

export async function readJudgeResponse(runDirectory: string, pass: number): Promise<unknown> {
  const state = await readState(runDirectory);
  const attempt = state.judge?.attempts?.filter(item => item.pass === pass).at(-1);
  return JSON.parse(lastAgentMessage(await readFile(join(runDirectory, attempt?.stdout_path ?? `evaluator/judge/output/pass-${pass}.jsonl`), "utf8")));
}

export function summarizeCheck(check: CommandEvidence): Record<string, unknown> {
  const failed = new Set<string>();
  const counts: Record<string, number> = { run: 0, pass: 0, fail: 0, skip: 0 };
  for (const line of check.stdout.split("\n")) {
    let event: Record<string, unknown>;
    try { event = JSON.parse(line); } catch { continue; }
    if (!isRecord(event) || typeof event.Action !== "string") continue;
    if (typeof event.Test === "string" && Object.hasOwn(counts, event.Action)) counts[event.Action]!++;
    if (event.Action === "fail") failed.add(typeof event.Test === "string" ? event.Test : "<package>");
  }
  return {
    command: check.command, exit_code: check.exit_code,
    validation_error: check.validation_error ?? null, elapsed_ms: check.elapsed_ms,
    test_events: counts, failed_tests: [...failed],
    stdout_bytes: Buffer.byteLength(check.stdout), stderr_bytes: Buffer.byteLength(check.stderr),
  };
}

export async function assertRecoverableJudge(runDir: string, state: RunState): Promise<void> {
  const prior = state.judge;
  if (prior?.status !== "failed" || prior.error !== "Error: source-only failure requires an explicitly required public interface" ||
      prior.failed_pass !== 1 || prior.passes.length ||
      prior.attempts?.filter(item => item.pass === 1 && item.stage === "assessment" && item.status === "complete").length !== 1 ||
      prior.attempts?.some(item => item.pass === 2 && (item.stage !== "harness-1" || item.status !== "canceled"))) {
    throw new Error("recovery requires the saved pass-1 source-only validation failure and an interrupted first pass-2 harness");
  }
  const exists = async (path: string) => access(path).then(() => true, () => false);
  if (await exists(join(runDir, "evaluator/semantic/pass-2/round-1")) ||
      await exists(join(runDir, "evaluator/semantic/pass-2/round-2")) ||
      !(await Promise.all(CANDIDATES.map(id => exists(join(runDir, "evaluator/semantic/pass-2/existing", id, "__existing_tests/evidence.json"))))).every(Boolean)) {
    throw new Error("recovery requires completed existing tests and no started pass-2 behavioral checks");
  }
}

export async function judgeRunUnlocked(runDirectory: string, authFile: string, dockerBin = process.env.CODEX_AB_DOCKER_BIN ?? "docker", signal?: AbortSignal, recover = false): Promise<JudgeReport> {
  const runDir = resolve(runDirectory);
  const state = await readState(runDir);
  if (state.invalidity_reasons?.length) throw new Error(`judge refuses an infrastructure-invalid run: ${state.invalidity_reasons.join("; ")}`);
  if (state.status !== "complete" || !state.results?.stock || !state.results.current) throw new Error("judge requires a complete pair");
  if (recover) await assertRecoverableJudge(runDir, state);
  else if (state.judge) throw new Error("judge already started for this immutable run; it cannot be resumed or retried");
  const auth = resolve(authFile);
  if (((await stat(auth)).mode & 0o777) & 0o077) throw new Error("auth file must be mode 0600");

  if (!state.criteria) throw new Error("judge requires task-derived criteria");
  const pricing = (state.pricing ?? await fetchPricing()) as PricingSnapshot;
  if (!state.pricing) state.pricing = pricing;
  if (!pricing.models[JUDGE_MODEL]) state.judge_pricing = {
    captured_at: new Date().toISOString(), rate: embeddedFallbackPricing(JUDGE_MODEL),
  };
  await writeState(runDir, state);
  return runSemanticJudge(runDir, state, auth, dockerBin, signal, recover);
}

export async function judgeRun(runDirectory: string, authFile: string, dockerBin = process.env.CODEX_AB_DOCKER_BIN ?? "docker"): Promise<JudgeReport> {
  return withRunLock(resolve(runDirectory), () => judgeRunUnlocked(runDirectory, authFile, dockerBin));
}
