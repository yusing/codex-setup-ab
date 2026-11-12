import { expect, test } from "bun:test";
import { qualitySelection } from "./quality-selection";
import { CURRENT_SCORE_RUBRIC, LEGACY_SCORE_RUBRIC, type JudgePass } from "./types";
const score = (weighted_total:number|null) => ({rubric:LEGACY_SCORE_RUBRIC,correctness:4,completeness:4,maintainability:4,test_quality:4,weighted_total});
function pass():JudgePass { return {pass:1,presentation:["stock","current"],scores:{"candidate-1":score(90),"candidate-2":score(80)},issues:[],evidence:[],winner:"candidate-2",rationale:"Holistic judgment."}; }
test("fresh holistic choice can differ from weighted leader with explicit disagreement",()=>{
  const result=qualitySelection([pass()],["stock","current"],false);
  expect(result.passes[0].weighted_score_leaders).toEqual(["stock"]);
  expect(result.passes[0].holistic_judge_preference).toBe("current");
  expect(result.passes[0].eligible_selection).toBe("current");
  expect(result.passes[0].preference_comparison_available).toBe(true);
  expect(result.has_score_preference_disagreement).toBe(true);
});
test("historical scores have no invented holistic preference; failed gates and missing totals stay excluded",()=>{
  const p=pass(); p.winner="candidate-1";
  expect(qualitySelection([p],["stock","current"],true).passes[0].holistic_judge_preference).toBeNull();
  expect(qualitySelection([p],["current"],false).passes[0].weighted_score_leaders).toEqual(["current"]);
  p.scores["candidate-2"].weighted_total=null;
  expect(qualitySelection([p],["stock","current"],false).passes[0].weighted_score_leaders).toEqual([]);
});

test("missing or nonfinite totals make score disagreement unavailable, never a manufactured disagreement",()=>{
  for (const total of [null, NaN, Infinity, undefined]) {
    const p=pass(); p.scores["candidate-1"].weighted_total=total as number|null;
    const result=qualitySelection([p],["stock","current"],false);
    expect(result.passes[0]).toMatchObject({weighted_score_leaders:[],weighted_comparison_available:false,
      preference_comparison_available:false,eligible_selection:"none",disagreement:false});
    expect(result.has_score_preference_disagreement).toBe(false);
  }
});

test("rubrics must match across reversed passes before weighted comparisons are available",()=>{
  const second=pass(); second.pass=2; second.presentation=["current","stock"];
  Object.values(second.scores).forEach(score=>score.rubric=CURRENT_SCORE_RUBRIC);
  const result=qualitySelection([pass(),second],["stock","current"],false);
  expect(result.passes.every(item=>!item.weighted_comparison_available&&item.weighted_score_leaders.length===0)).toBe(true);
  expect(result.has_score_preference_disagreement).toBe(false);
});

test("critical findings remove that candidate from ranking and ineligible raw preferences stay visible",()=>{
  const p=pass(); p.winner="candidate-1";
  p.issues=[{candidate:"candidate-1",severity:"critical",detail:"Required safety condition failed."}];
  const result=qualitySelection([p],["stock","current"],false).passes[0];
  expect(result).toMatchObject({quality_eligibility:["current"],weighted_score_leaders:["current"],
    holistic_judge_preference:"stock",recorded_selection:"stock",eligible_selection:"none",selection_eligible:false,
    weighted_comparison_available:true,preference_comparison_available:false,disagreement:false});
});

test("tie and no-selection semantics distinguish unavailable preferences from actual score disagreement",()=>{
  const p=pass(); p.winner="tie";
  expect(qualitySelection([p],["stock","current"],false).passes[0]).toMatchObject({selection_eligible:true,disagreement:true});
  p.scores["candidate-2"].weighted_total=90;
  expect(qualitySelection([p],["stock","current"],false).passes[0]).toMatchObject({selection_eligible:true,disagreement:false});
  expect(qualitySelection([p],["current"],false).passes[0]).toMatchObject({selection_eligible:false,disagreement:false});
  p.winner="none";
  expect(qualitySelection([p],["stock","current"],false).passes[0]).toMatchObject({preference_comparison_available:false,disagreement:false});
  expect(qualitySelection([p],[],false).passes[0]).toMatchObject({weighted_score_leaders:[],weighted_comparison_available:false});
  expect(qualitySelection([p],["stock","current"],true).passes[0]).toMatchObject({holistic_judge_preference:null,preference_comparison_available:false});
});
