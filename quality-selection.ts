import { scoreComparisonIssue } from "./judge";
import type { ArmName, JudgePass } from "./types";

/** Preserve the distinct, intentional fresh and historical selection policies. */
export function qualitySelection(passes: JudgePass[], behaviorallyEligible: ArmName[], historical: boolean) {
  const eligible = new Set(behaviorallyEligible);
  const sharedIssue = scoreComparisonIssue(passes) ?? null;
  const observations = passes.map(pass => {
    const map = (id: string) => /^candidate-[1-9][0-9]*$/.test(id) ? pass.presentation[Number(id.slice(10)) - 1] ?? "none" : id;
    const qualityEligible = pass.presentation.filter((arm, index) => eligible.has(arm)
      && !pass.issues.some(issue => issue.candidate === `candidate-${index + 1}` && issue.severity === "critical"));
    const available = Object.entries(pass.scores).filter(([id, score]) => qualityEligible.includes(map(id))
      && typeof score.weighted_total === "number" && Number.isFinite(score.weighted_total));
    const issue = sharedIssue ?? (new Set(pass.presentation).size !== pass.presentation.length
      ? "The presentation repeats an arm; candidate identity is ambiguous."
      : !qualityEligible.length ? "No candidate has eligible behavioral and quality evidence."
      : qualityEligible.some(arm => !available.some(([id]) => map(id) === arm))
        ? "An eligible candidate has an incomplete or nonfinite weighted total." : null);
    const highest = Math.max(...available.map(([, score]) => score.weighted_total!));
    const leaders = issue ? [] : available.filter(([, score]) => score.weighted_total === highest).map(([id]) => map(id));
    const preference = historical ? null : map(pass.winner);
    const selected = map(pass.winner);
    const selectionEligible = selected === "tie" ? qualityEligible.length === pass.presentation.length && qualityEligible.length > 0
      : selected !== "none" && qualityEligible.includes(selected);
    const comparisonAvailable = !issue && selectionEligible && preference !== null;
    return { pass: pass.pass, weighted_score_leaders: leaders, holistic_judge_preference: preference,
      recorded_selection: selected, eligible_selection: !issue && selectionEligible ? selected : "none",
      quality_eligibility: qualityEligible, selection_eligible: !issue && selectionEligible,
      weighted_comparison_available: !issue, preference_comparison_available: comparisonAvailable, comparison_issue: issue,
      disagreement: comparisonAvailable && (preference === "tie" ? leaders.length !== pass.presentation.length : !leaders.includes(preference!)) };
  });
  return { schema: "codex-ab.quality-selection.v1", policy: historical ? "eligible-weighted-score" : "holistic-judge-preference",
    behavioral_eligibility: [...eligible], passes: observations,
    has_score_preference_disagreement: observations.some(pass => pass.disagreement),
    interpretation: "Weighted-score leaders and holistic preferences are separate. Reversed order checks presentation bias; it is not independent ground-truth validation." };
}
