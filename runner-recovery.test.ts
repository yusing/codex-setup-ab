import { expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { finishBenchmark, runBenchmark } from "./workflow";
import { readState, writeState } from "./state";
import { assertRecoverableJudge } from "./judge";
import { embeddedFallbackPricing, type PricingSnapshot } from "./usage";
import { runnerFixture } from "./test-support/runner-fixture";

const { root, file, prepared, brokenFirstCandidate2Check, fakeOwnedDocker } = await runnerFixture();

for (const judgeModel of ["gpt-6.1-sol", "gpt-6-sol"] as const) {
for (const failure of ["validation", "timeout", ...(judgeModel === "gpt-6.1-sol" ? ["executed-failure", "missing-new-aspects"] as const : [])] as const) {
test(`${judgeModel} ${failure} judge recovery reuses saved pass 1 and runs only incomplete pass 2`, async () => {
  const run = await prepared();
  const auth = join(root, "recover-judge-auth.json");
  await file(auth, "{}\n", 0o600);
  const fake = await fakeOwnedDocker(0);
  await runBenchmark({ runDir: run, authFile: auth, dockerBin: fake.path });
  const state = await readState(run);
  const judge = state.judge!;
  judge.model = judgeModel;
  const recordedPricing = state.pricing as PricingSnapshot;
  delete recordedPricing.models[judgeModel];
  const supplementalPricing = { captured_at: new Date().toISOString(), rate: embeddedFallbackPricing(judgeModel) };
  state.judge_pricing = supplementalPricing;
  const saved = judge.attempts!.find(item => item.pass === 1 && item.stage === "assessment")!;
  if (failure === "validation") {
    const harness = judge.attempts!.find(item => item.pass === 1 && item.stage === "harness-1")!;
    const plan = await Bun.file(join(run, "evaluator/semantic/pass-1/plans/harness-1-1/checks.json")).json();
    await writeFile(join(run, harness.stdout_path), JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(plan) } }) + "\n");
  }
  const event = JSON.parse((await readFile(join(run, saved.stdout_path), "utf8")).trim());
  const response = JSON.parse(event.item.text);
  if (failure === "timeout" || failure === "missing-new-aspects") {
    delete response.quality_aspects;
    for (const score of Object.values(response.scores) as Array<Record<string, unknown>>) {
      delete score.simplicity; delete score.performance; delete score.approach;
    }
  }
  response.criteria["candidate-2"][0] = { criterion: "fixture", status: "fail", basis: failure === "executed-failure" ? "executed" : "source-only", reasoning: "Unverified failure observation." };
  response.winner = "candidate-1";
  event.item.text = JSON.stringify(response);
  await writeFile(join(run, saved.stdout_path), `${JSON.stringify(event)}\n`);
  judge.status = "failed";
  judge.error = failure === "timeout" ? `Error: semantic judge timed out after ${state.timeout_seconds} seconds` :
    failure === "executed-failure" ? "Error: harness error is not an executed candidate failure" :
      "Error: source-only failure requires an explicitly required public interface";
  judge.failed_pass = 1;
  judge.passes = [];
  judge.winner = "none";
  judge.attempts = judge.attempts!.filter(item => item.pass === 1 || item.stage === "harness-1");
  for (const item of judge.attempts) if (item.pass === 2) item.status = "canceled";
  judge.usage_homes = judge.attempts.map(item => item.usage_home);
  await rm(join(run, "evaluator/semantic/pass-2/round-1.json"));
  await expect(assertRecoverableJudge(run, state)).rejects.toThrow("partially executed behavioral checks (pass 2, round 1)");
  await rm(join(run, "evaluator/judge/pass-2-assessment-1"), { recursive: true });
  await rm(join(run, "evaluator/semantic/pass-2/round-1"), { recursive: true });
  const repaired = JSON.parse(await readFile(join(run, "evaluator/semantic/pass-1/round-1.json"), "utf8"));
  repaired.candidates["candidate-1"][0].execution.stdout = "repaired pass-1 evidence";
  await writeFile(join(run, "evaluator/semantic/pass-1/round-2.json"), JSON.stringify(repaired));
  state.finishing = { status: "failed", started_at: new Date().toISOString(), bundle_path: "reports/bundle", error: judge.error };
  await writeState(run, state);
  await expect(finishBenchmark({ runDir: run, authFile: auth, dockerBin: fake.path })).rejects.toThrow("--recover-judge");
  const priorLog = await readFile(fake.log, "utf8");
  if (failure === "missing-new-aspects") {
    const missing = await fakeOwnedDocker(0, false, false, "", false, false, { pass: 2, omit: "quality_aspects" });
    await expect(finishBenchmark({ runDir: run, authFile: auth, dockerBin: missing.path, recoverJudge: true })).rejects.toThrow("quality_aspects");
    const rejected = await readState(run);
    expect(rejected.judge?.failed_pass).toBe(2);
    expect(rejected.judge?.winner).toBe("none");
    expect(rejected.judge?.passes[0]?.quality_aspects?.["candidate-1"].simplicity).toMatchObject({ status: "unassessed", basis: "none" });
    return;
  }
  await finishBenchmark({ runDir: run, authFile: auth, dockerBin: fake.path, recoverJudge: true });
  const finished = await readState(run);
  expect(finished.finishing?.status).toBe("complete");
  expect(finished.judge?.model).toBe(judgeModel);
  expect(finished.judge_pricing).toEqual(supplementalPricing);
  expect((finished.pricing as PricingSnapshot).models[judgeModel]).toBeUndefined();
  expect(finished.judge?.status).toBe("complete");
  expect(finished.judge?.recovery?.reused_passes).toEqual([1]);
  if (failure === "timeout") {
    for (const id of ["candidate-1", "candidate-2"] as const) for (const key of ["simplicity", "performance", "approach"] as const) {
      expect(finished.judge?.passes[0]?.quality_aspects?.[id][key]).toMatchObject({ status: "unassessed", basis: "none" });
      expect(finished.judge?.passes[1]?.quality_aspects?.[id][key]).toMatchObject({ status: "satisfactory", basis: "source" });
    }
    const published = await Bun.file(join(run, "reports/report.json")).json();
    expect(published.judge.result.passes[0].quality_aspects["candidate-1"].approach.status).toBe("unassessed");
  }
  expect(finished.judge?.passes[0]?.criteria?.["candidate-2"][0]?.status).toBe("unassessed");
  expect(finished.judge?.passes[0]?.criteria?.["candidate-1"][0]?.execution?.stdout).toBe("repaired pass-1 evidence");
  expect(finished.judge?.attempts?.find(item => item.pass === 2 && item.stage === "harness-1" && item.attempt === 2)?.status).toBe("complete");
  const addedLog = (await readFile(fake.log, "utf8")).slice(priorLog.length);
  expect(addedLog).toContain(`--model ${judgeModel}`);
  expect(addedLog).toContain("-judge-2-harness-1-2");
  expect(addedLog).not.toContain("-judge-1-");
  expect(addedLog).not.toContain("-stock ");
  expect(addedLog).not.toContain("-current ");
  expect(finished.finishing_history).toHaveLength(1);
}, 30_000);

}
}

test("judge recovery replays a saved repair that resubmitted a successful check", async () => {
  const run = await prepared();
  const auth = join(root, "recover-repair-auth.json");
  await file(auth, "{}\n", 0o600);
  const fake = await fakeOwnedDocker(0);
  const docker = await brokenFirstCandidate2Check(fake.path, "recover-repair-docker");
  await runBenchmark({ runDir: run, authFile: auth, dockerBin: docker });
  // Rewind to the pre-fix failure: pass 1 threw on its saved round-2 plan before executing it,
  // which canceled pass 2's repair stage. Completed round-1 evidence and harness responses remain.
  const state = await readState(run);
  const judge = state.judge!;
  judge.status = "failed";
  judge.error = "Error: harness repair must not replace a successful check";
  judge.failed_pass = 1;
  judge.passes = [];
  judge.winner = "none";
  judge.attempts = judge.attempts!.filter(item => item.stage !== "assessment");
  for (const item of judge.attempts) if (item.pass === 2 && item.stage === "harness-2") item.status = "canceled";
  judge.usage_homes = judge.attempts.map(item => item.usage_home);
  for (const pass of [1, 2]) {
    await rm(join(run, `evaluator/judge/pass-${pass}-assessment-1`), { recursive: true });
    await rm(join(run, `evaluator/semantic/pass-${pass}/round-2`), { recursive: true });
    await rm(join(run, `evaluator/semantic/pass-${pass}/round-2.json`));
  }
  state.finishing = { status: "failed", started_at: new Date().toISOString(), bundle_path: "reports/bundle", error: judge.error };
  await writeState(run, state);
  const priorLog = await readFile(fake.log, "utf8");
  await finishBenchmark({ runDir: run, authFile: auth, dockerBin: docker, recoverJudge: true });
  const finished = await readState(run);
  expect(finished.finishing?.status).toBe("complete");
  expect(finished.judge?.status).toBe("complete");
  expect(finished.judge?.recovery?.reused_passes).toEqual([1, 2]);
  expect(finished.judge?.passes.map(pass => pass.criteria?.["candidate-2"][0]?.status)).toEqual(["pass", "pass"]);
  const addedLog = (await readFile(fake.log, "utf8")).slice(priorLog.length);
  expect(addedLog).not.toContain("-judge-1-harness-");
  expect(addedLog).not.toContain("-judge-2-harness-1-");
  expect(addedLog).toContain("-judge-2-harness-2-2");
  expect(addedLog).toContain("-judge-1-assessment-1");
  expect(addedLog).toContain("-judge-2-assessment-1");
  expect(addedLog).not.toMatch(/-semantic-[12]-(?:existing|round-1)-/);
  expect(addedLog).toContain("-semantic-1-round-2-candidate-2-fixture");
  expect(addedLog).not.toContain("-semantic-1-round-2-candidate-1-");
  expect(addedLog).not.toContain("-stock ");
  expect(addedLog).not.toContain("-current ");
}, 30_000);
