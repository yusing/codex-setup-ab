import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArmImport, ArmName, ArmResult, CandidateId, EvaluationPlan, JudgePass, RunState } from "./types";
import type { CriterionEvidence } from "./semantic";

export function evaluationPlan(mode: unknown, baselines: unknown, imports: ArmImport[] | undefined, arms: ArmName[]): EvaluationPlan {
  const selected = mode ?? (imports?.length ? "reuse" : "fresh");
  if (selected !== "reuse" && selected !== "fresh") throw new Error("Evaluation mode must be reuse or fresh");
  if (selected === "fresh") {
    if (baselines !== undefined) throw new Error("Evaluation baselines require reuse mode");
    return { mode: selected };
  }
  if (!imports?.length) throw new Error("Evaluation reuse requires historical arm imports");
  const imported = imports.map(item => item.target_arm);
  const fresh = arms.filter(arm => !imported.includes(arm));
  if (baselines !== undefined && (!baselines || typeof baselines !== "object" || Array.isArray(baselines))) throw new Error("Evaluation baselines must map fresh arms to imported slots");
  const mappings = Object.fromEntries(fresh.map(arm => [arm, imported.at(-1)!]));
  for (const [arm, baseline] of Object.entries(baselines ?? {})) {
    if (!fresh.includes(arm) || typeof baseline !== "string" || !imported.includes(baseline)) throw new Error("Each evaluation baseline must map a fresh arm to an imported slot");
    mappings[arm] = baseline;
  }
  return { mode: selected, baselines: mappings };
}

export interface HistoricalPass {
  presentation: ArmName[];
  score: JudgePass["scores"][CandidateId];
  criteria: CriterionEvidence[];
  existing: CriterionEvidence;
  issues: JudgePass["issues"];
  rationale: string;
  quality_aspects?: NonNullable<JudgePass["quality_aspects"]>[CandidateId];
}
export interface HistoricalEvaluation {
  grade: NonNullable<ArmResult["grade"]>;
  passes: Record<1 | 2, HistoricalPass>;
}

/** Preserve failed and unassessed outcomes as well as successful evaluations. */
export function historicalEvaluation(source: RunState, arm: ArmName): HistoricalEvaluation {
  const grade = source.results?.[arm]?.grade;
  const unavailable = () => new Error(`Historical arm ${arm} lacks a complete retained evaluation; choose fresh evaluation`);
  if (!grade || source.judge?.status !== "complete") throw unavailable();
  const passes = {} as HistoricalEvaluation["passes"];
  for (const number of [1, 2] as const) {
    const pass: JudgePass | undefined = source.judge.passes.find(item => item.pass === number);
    const index: number = pass?.presentation.indexOf(arm) ?? -1;
    const id: CandidateId = `candidate-${index + 1}`;
    const score = pass?.scores[id], criteria = pass?.criteria?.[id];
    const existing = grade.semantic?.[`pass-${number}-existing`]?.[0];
    if (index < 0 || !score || !criteria || !existing
      || !source.criteria?.contract.criteria.every(item => criteria.some(result => result.criterion === item.id))) throw unavailable();
    passes[number] = { presentation: pass!.presentation, score, criteria, existing, issues: pass!.issues.filter(issue => issue.candidate === id), rationale: pass!.rationale,
      ...(pass!.quality_aspects ? { quality_aspects: pass!.quality_aspects[id] } : {}) };
  }
  return { grade, passes };
}

export async function retainedEvaluations(runDir: string, state: RunState): Promise<Record<ArmName, HistoricalEvaluation>> {
  if (state.evaluation?.mode !== "reuse") return {};
  return Object.fromEntries(await Promise.all(Object.entries(state.imported_arms ?? {}).map(async ([arm, imported]) => {
    const source = JSON.parse(await readFile(join(runDir, imported.directory, "source-run.json"), "utf8")) as RunState;
    return [arm, historicalEvaluation(source, imported.source_arm)];
  })));
}
