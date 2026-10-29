import { armNames, candidateIds, type CandidateId } from "./types";
import { access, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { JUDGE_MODEL, runSemanticJudge } from "./semantic-judge";
import { armExecutionSucceeded, readState, withRunLock, writeState } from "./state";
import { embeddedFallbackPricing, fetchPricing, type PricingSnapshot } from "./usage";
import type { ArmName, CommandEvidence, JudgePass, JudgeReport, RunState } from "./types";

const SCORE_KEYS = ["correctness", "completeness", "maintainability", "test_quality"] as const;
type ScoreKey = (typeof SCORE_KEYS)[number];
type Candidate = CandidateId;

export function judgeOutputSchema(candidates: CandidateId[]) { return {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object", additionalProperties: false,
  required: ["scores", "evidence", "issues", "winner", "rationale"],
  properties: {
    scores: {
      type: "object", additionalProperties: false, required: [...candidates],
      properties: Object.fromEntries(candidates.map(id => [id, {
        type: "object", additionalProperties: false,
        required: [...SCORE_KEYS],
        properties: Object.fromEntries(SCORE_KEYS.map(key => [key, { type: "number", minimum: 0, maximum: 5 }])),
      }])),
    },
    evidence: { type: "array", items: { type: "string", minLength: 1 } },
    issues: { type: "array", items: {
      type: "object", additionalProperties: false, required: ["candidate", "severity", "detail"],
      properties: {
        candidate: { type: "string", enum: [...candidates] },
        severity: { type: "string", enum: ["critical", "major", "minor"] },
        detail: { type: "string", minLength: 1 },
      },
    } },
    winner: { type: "string", enum: [...candidates, "tie", "none"] },
    rationale: { type: "string", minLength: 1 },
  },
} as const; }

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

function candidate(value: unknown, context: string, candidates: Candidate[]): Candidate {
  if (!candidates.includes(value as Candidate)) throw new Error(`${context} must be ${candidates.join(" or ")}`);
  return value as Candidate;
}

function nonemptyString(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${context} must be a nonempty string`);
  return value;
}

export function validateJudgePass(value: unknown, pass: 1 | 2, presentation: ArmName[], passing: Record<Candidate, boolean>): JudgePass {
  const candidates = candidateIds(presentation.length);
  const root = exactObject(value, ["scores", "evidence", "issues", "winner", "rationale"], `judge pass ${pass}`);
  const rawScores = exactObject(root.scores, candidates, `judge pass ${pass}.scores`);
  const scores = {} as JudgePass["scores"];
  for (const id of candidates) {
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
    return { candidate: candidate(issue.candidate, `judge pass ${pass}.issues[${index}].candidate`, candidates), severity, detail: nonemptyString(issue.detail, `judge pass ${pass}.issues[${index}].detail`) };
  });
  const winner = root.winner as JudgePass["winner"];
  if (!candidates.includes(winner as Candidate) && winner !== "tie" && winner !== "none") throw new Error(`judge pass ${pass}.winner is invalid`);
  const critical = new Set(issues.filter(issue => issue.severity === "critical").map(issue => issue.candidate));
  if ((winner !== "tie" && winner !== "none") && !passing[winner]) throw new Error(`judge pass ${pass} selected a candidate whose required benchmark gates failed or were not run`);
  if ((winner !== "tie" && winner !== "none") && critical.has(winner)) throw new Error(`judge pass ${pass} selected a candidate with a critical issue`);
  if (winner === "tie" && candidates.some(id => !passing[id] || critical.has(id))) throw new Error(`judge pass ${pass} selected a tie containing an ineligible candidate`);
  return { pass, presentation, scores, evidence, issues, winner, rationale: nonemptyString(root.rationale, `judge pass ${pass}.rationale`) };
}

export function mappedWinner(pass: JudgePass): ArmName | "tie" | "none" {
  if (pass.winner === "tie" || pass.winner === "none") return pass.winner;
  return pass.presentation[Number(pass.winner.slice("candidate-".length)) - 1];
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

/** Validation failures whose completed stages can be revalidated without repeating inference. */
const RECOVERABLE_JUDGE_ERRORS = new Set([
  "Error: source-only failure requires an explicitly required public interface",
  "Error: harness repair must not replace a successful check",
  "Error: harness error is not an executed candidate failure",
]);

export async function assertRecoverableJudge(runDir: string, state: RunState): Promise<void> {
  const prior = state.judge;
  let recoverable = RECOVERABLE_JUDGE_ERRORS.has(prior?.error ?? "") ||
    prior?.error === `Error: semantic judge timed out after ${state.timeout_seconds} seconds`;
  // Older setup-commit judges inherited setup A's config without its referenced files.
  // Require the original startup evidence, not an arbitrary nonzero judge exit.
  if (!recoverable && state.comparison === "setup-commits" && prior && prior.error ===
      `Error: semantic judge pass ${prior.failed_pass}, executable checks, round 1 failed (1)`) {
    const attempt = prior.attempts?.filter(item => item.pass === prior.failed_pass &&
      item.stage === "harness-1" && item.status === "failed" && item.error === prior.error).at(-1);
    if (attempt) {
      const [config, snapshot, stdout, stderr] = await Promise.all([
        readFile(join(runDir, attempt.usage_home, "config.toml"), "utf8"),
        readFile(join(runDir, "snapshots/stock/home/ubuntu/.codex/config.toml"), "utf8"),
        readFile(join(runDir, attempt.stdout_path), "utf8"), readFile(join(runDir, attempt.stderr_path), "utf8"),
      ]);
      const instructions = (Bun.TOML.parse(config) as Record<string, unknown>).model_instructions_file;
      recoverable = config === snapshot && typeof instructions === "string" && stdout === "" && stderr.trim() ===
        `Error: failed to read model instructions file ${instructions}: No such file or directory (os error 2)`;
    }
  }
  if (prior?.status !== "failed" || !recoverable || prior.passes.length ||
      prior.attempts?.some(item => item.status === "running")) {
    throw new Error("recovery requires a failed judge with a recoverable validation error, configuration startup failure or timeout, no recorded pass, and no running attempt");
  }
  const exists = async (path: string) => access(path).then(() => true, () => false);
  for (const pass of [1, 2]) {
    const root = join(runDir, "evaluator/semantic", `pass-${pass}`);
    if (!(await Promise.all(candidateIds(armNames(state).length).map(id => exists(join(root, "existing", id, "__existing_tests/evidence.json"))))).every(Boolean)) {
      throw new Error("recovery requires completed existing tests in both passes");
    }
    for (const round of [1, 2]) {
      if (await exists(join(root, `round-${round}`)) && !await exists(join(root, `round-${round}.json`))) {
        throw new Error(`recovery requires no partially executed behavioral checks (pass ${pass}, round ${round})`);
      }
    }
  }
}

export async function judgeRunUnlocked(runDirectory: string, authFile: string, dockerBin = process.env.CODEX_AB_DOCKER_BIN ?? "docker", signal?: AbortSignal, recover = false): Promise<JudgeReport> {
  const runDir = resolve(runDirectory);
  const state = await readState(runDir);
  if (state.invalidity_reasons?.length) throw new Error(`judge refuses an infrastructure-invalid run: ${state.invalidity_reasons.join("; ")}`);
  if (state.status !== "complete" || armNames(state).some(arm => !state.results?.[arm])) throw new Error("judge requires a complete pair");
  if (!armNames(state).every(arm => armExecutionSucceeded(state.results?.[arm]))) throw new Error("judge requires successful agent execution in both arms");
  if (recover) await assertRecoverableJudge(runDir, state);
  else if (state.judge) throw new Error("judge already started for this immutable run; it cannot be resumed or retried");
  const auth = resolve(authFile);
  if (((await stat(auth)).mode & 0o777) & 0o077) throw new Error("auth file must be mode 0600");

  if (!state.criteria) throw new Error("judge requires task-derived criteria");
  const pricing = (state.pricing ?? await fetchPricing()) as PricingSnapshot;
  if (!state.pricing) state.pricing = pricing;
  const judgeModel = recover ? state.judge!.model : JUDGE_MODEL;
  if (!pricing.models[judgeModel] && state.judge_pricing?.rate.model_id !== judgeModel) state.judge_pricing = {
    captured_at: new Date().toISOString(), rate: embeddedFallbackPricing(judgeModel),
  };
  await writeState(runDir, state);
  return runSemanticJudge(runDir, state, auth, dockerBin, signal, recover);
}

export async function judgeRun(runDirectory: string, authFile: string, dockerBin = process.env.CODEX_AB_DOCKER_BIN ?? "docker"): Promise<JudgeReport> {
  return withRunLock(resolve(runDirectory), () => judgeRunUnlocked(runDirectory, authFile, dockerBin));
}
