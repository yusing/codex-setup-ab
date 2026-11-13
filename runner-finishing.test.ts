import { expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { verifyPreparedInputs } from "./prepare";
import { finishBenchmark, runBenchmark } from "./workflow";
import { checked } from "./process";
import { readState, writeState, sha256 } from "./state";
import { preflightRun, runPair } from "./runner";
import { assertRecoverableJudge, judgeRun } from "./judge";
import * as bundles from "./bundle";
import * as usage from "./usage";
import { buildReport } from "./report";
import { type PricingSnapshot } from "./usage";
import { runnerFixture } from "./test-support/runner-fixture";

const { root, source, home, task, fixtureCriteria, base, future, file, prepare, prepared, fakeOwnedDocker } = await runnerFixture();

test("benchmark owns semantic judging, audit and checksummed bundle", async () => {
  const run = await prepared();
  const auth = join(root, "workflow-auth.json");
  await file(auth, "{}\n", 0o600);
  const fake = await fakeOwnedDocker(0);
  const originalWrite = process.stderr.write;
  let operatorLog = "";
  process.stderr.write = function (...args: Parameters<typeof originalWrite>) {
    operatorLog += String(args[0]);
    return originalWrite.apply(process.stderr, args);
  } as typeof originalWrite;
  const meter = spyOn(usage, "meterRollouts");
  try {
    await runBenchmark({ runDir: run, authFile: auth, dockerBin: fake.path });
    const completed = await readState(run);
    expect(meter.mock.calls).toHaveLength(completed.selected_arms!.length + completed.judge!.usage_homes.length);
  } finally {
    process.stderr.write = originalWrite;
    meter.mockRestore();
  }
  expect(operatorLog).toContain("A / Codex (minimal setup): agent started");
  expect(operatorLog).toContain("B / Codex (current-home setup): agent started");
  expect(operatorLog).toContain("semantic pass 2: A / Codex (current-home setup); B / Codex (minimal setup)");
  expect(operatorLog).toContain("semantic pass 1, executable checks, round 1");
  expect(operatorLog).toContain("[grade] semantic pass 2, A / Codex (current-home setup)");
  expect(operatorLog).not.toMatch(/\[run\] (?:stock|current):|agent execution order: (?:stock|current)-first|\[(?:judge|grade)\].*(?:candidate-\d|harness-\d)/);
  const finished = await readState(run);
  expect(finished.finishing?.status).toBe("complete");
  expect(finished.judge?.passes).toHaveLength(2);
  expect(finished.results?.current?.grade?.passed).toBe(true);
  const bundle = join(run, "reports/bundle");
  expect(JSON.parse(await readFile(join(bundle, "final-integrity.json"), "utf8")).passed).toBe(true);
  expect(await readFile(join(bundle, "MANIFEST.sha256"), "utf8")).toContain("interaction-audit.json");
  expect(await Bun.file(join(bundle, "auth.json")).exists()).toBe(false);
  const log = await readFile(fake.log, "utf8");
  expect(log).toContain("/candidates/candidate-1:ro");
  expect(log).toContain("-semantic-");
  await expect(runBenchmark({ runDir: run, authFile: auth, dockerBin: fake.path })).rejects.toThrow("prepare a new run");
}, 30_000);

test("benchmark preserves a partial report and bundle after non-inference preparation failure", async () => {
  const run = await prepared();
  const auth = join(root, "workflow-failed-auth.json");
  await file(auth, "{}\n", 0o600);
  const fake = await fakeOwnedDocker(0, true);
  await expect(runBenchmark({ runDir: run, authFile: auth, dockerBin: fake.path })).rejects.toThrow("cache prewarm failed");
  expect((await readState(run)).finishing?.status).toBe("complete");
  expect(await Bun.file(join(run, "reports/bundle/report.json")).exists()).toBe(true);
  expect(await readFile(fake.log, "utf8")).not.toContain("-judge-1");
}, 30_000);

test("failed agent execution preserves evidence and skips graders, judges and finishing retries", async () => {
  const run = await prepared();
  const auth = join(root, "failed-agent-auth.json"); await file(auth, "{}", 0o600);
  const fake = await fakeOwnedDocker(0);
  const script = await readFile(fake.path, "utf8");
  const failingScript = script.replace("      *-stock|", "      *-stock) echo launcher-failed >&2; status=9 ;;\n      ");
  expect(failingScript).not.toBe(script);
  await file(fake.path, failingScript);
  await expect(runBenchmark({ runDir: run, authFile: auth, dockerBin: fake.path })).rejects.toThrow("agent exited with code 9");
  const failed = await readState(run);
  expect(failed.status).toBe("partial");
  expect(failed.arm_attempts?.stock?.status).toBe("failed");
  expect(failed.results?.stock?.exit_code).toBe(9);
  expect(failed.results?.stock?.grade).toBeUndefined();
  expect(failed.results?.current?.grade).toBeUndefined();
  expect(failed.finishing?.status).toBe("complete");
  expect(await readFile(join(run, failed.results!.stock!.stderr_path), "utf8")).toContain("launcher-failed");
  expect(await Bun.file(join(run, failed.results!.stock!.patch_path)).exists()).toBe(true);
  expect(await Bun.file(join(run, "reports/bundle/report.json")).exists()).toBe(true);
  const log = await readFile(fake.log, "utf8");
  expect(log).not.toContain("-grade-verify");
  expect(log).not.toContain("-judge-");
  // Older runners incorrectly marked nonzero exits complete.
  failed.status = "complete";
  await writeState(run, failed);
  await expect(judgeRun(run, auth, fake.path)).rejects.toThrow("successful agent execution");
  await expect(finishBenchmark({ runDir: run, authFile: auth, dockerBin: fake.path })).rejects.toThrow("complete execution");
  expect(await readFile(fake.log, "utf8")).toBe(log);
});

for (const fault of ["integrity", "cancel", "collection", "finalization"] as const) {
  test(`finishing ${fault} cannot leave a successful bundled outcome`, async () => {
    const run = await prepared();
    const state = await readState(run);
    state.pricing = { fetched_at: new Date().toISOString(), source: "fallback", catalog_url: "fixture://pricing", assumptions: [], warnings: [], models: {} };
    await writeState(run, state);
    const auth = join(root, `${fault}-auth.json`);
    await file(auth, "{}\n", 0o600);
    const fake = await fakeOwnedDocker(0);
    const original = process.stderr.write;
    let injected = false;
    process.stderr.write = function (...args: Parameters<typeof original>) {
      if (!injected && String(args[0]).includes("[finish] metering")) {
        injected = true;
        if (fault === "integrity") writeFileSync(join(run, "control/task.md"), "changed after execution");
        else if (fault === "cancel") process.emit("SIGTERM");
      }
      return original.apply(process.stderr, args);
    } as typeof original;
    const meter = spyOn(usage, "meterRollouts");
    const collect = bundles.collectBundle;
    const finalize = bundles.finalizeBundle;
    const collectSpy = spyOn(bundles, "collectBundle").mockImplementation(async directory => {
      if (fault !== "collection") return collect(directory);
      await mkdir(join(directory, "reports/bundle"), { recursive: true });
      throw new Error("partial collection failure");
    });
    let finalizations = 0;
    const finalizeSpy = spyOn(bundles, "finalizeBundle").mockImplementation(async directory => {
      if (fault === "finalization" && finalizations++ === 0) throw new Error("finalization failure");
      return finalize(directory);
    });
    try {
      await expect(runBenchmark({ runDir: run, authFile: auth, dockerBin: fake.path })).rejects.toThrow();
      const completed = await readState(run);
      expect(meter.mock.calls).toHaveLength(completed.selected_arms!.length + completed.judge!.usage_homes.length);
    } finally {
      process.stderr.write = original;
      meter.mockRestore();
      collectSpy.mockRestore();
      finalizeSpy.mockRestore();
    }
    expect(injected).toBe(true);
    expect((await readState(run)).finishing?.status).toBe("failed");
    const bundled = JSON.parse(await readFile(join(run, "reports/bundle/run.json"), "utf8"));
    const report = JSON.parse(await readFile(join(run, "reports/bundle/report.json"), "utf8"));
    expect(bundled.finishing.status).toBe("failed");
    expect(report.finishing.status).toBe("failed");
    await bundles.verifyBundleManifest(join(run, "reports/bundle"), await sha256(join(run, "reports/bundle/MANIFEST.sha256")));
    expect(report.winner).toBe("none");
    if (fault === "integrity") expect(report.validity).toBe("invalid");
    expect(await Bun.file(join(run, ".operation-lock")).exists()).toBe(false);
    expect(await readFile(fake.log, "utf8")).toContain("-judge-1");
  }, 30_000);
}

test("standalone report sealing failure refreshes failed state and bundle", async () => {
  const run = await prepared();
  const auth = join(root, "refresh-auth.json");
  await file(auth, "{}\n", 0o600);
  const fake = await fakeOwnedDocker(0);
  await runBenchmark({ runDir: run, authFile: auth, dockerBin: fake.path });
  const finalize = bundles.finalizeBundle;
  let finalizations = 0;
  const seal = spyOn(bundles, "finalizeBundle").mockImplementation(async directory => {
    if (finalizations++ === 0) throw new Error("report sealing failed");
    return finalize(directory);
  });
  try {
    await expect(buildReport(run)).rejects.toThrow("report sealing failed");
  } finally { seal.mockRestore(); }
  expect(finalizations).toBe(2);
  expect((await readState(run)).finishing).toMatchObject({ status: "failed", error: "Error: report sealing failed" });
  for (const path of ["reports/report.json", "reports/bundle/run.json", "reports/bundle/report.json"]) {
    expect((await Bun.file(join(run, path)).json()).finishing.status).toBe("failed");
  }
  expect((await Bun.file(join(run, "reports/report.json")).json()).winner).toBe("none");
  await bundles.verifyBundleManifest(join(run, "reports/bundle"), await sha256(join(run, "reports/bundle/MANIFEST.sha256")));
}, 30_000);

test("review treatment overlays only the isolated current home and is hash verified", async () => {
  const treatment = join(root, "review-treatment");
  await file(join(treatment, "parent-agents.md"), "review before implementation\n");
  for (const role of ["review-correctness", "review-simplify", "web-reviewer"]) {
    await file(join(treatment, `${role}.toml`), `name = "${role}"\ndeveloper_instructions = "wait for final readiness"\n`);
  }
  const before = await readFile(join(home, ".codex/AGENTS.md"), "utf8");
  const run = await prepare({
    source, baseCommit: base, forbiddenCommit: future, taskPath: task, criteriaPath: fixtureCriteria,
    outputParent: root, currentHome: home, image: "fixture-image", cpus: "2", memory: "4g", timeoutSeconds: 30,
    codexBinary: join(home, ".local/bin/codex"), reviewTreatment: treatment,
  });
  const state = await readState(run);
  expect(state.profile).toBe("task");
  expect(state.execution.current_launcher).toBe("codex");
  expect(await readFile(join(home, ".codex/AGENTS.md"), "utf8")).toBe(before);
  expect(await readFile(join(run, state.arms.current.home_template, ".codex/AGENTS.md"), "utf8")).toBe("review before implementation\n");
  const manifest = JSON.parse(await readFile(join(run, state.snapshot_manifest), "utf8"));
  expect(manifest.review_treatment.files).toHaveLength(4);
  expect(manifest.review_treatment.files[0].before_sha256).not.toBe(manifest.review_treatment.files[0].after_sha256);
  await file(join(run, state.arms.current.home_template, ".codex/AGENTS.md"), "tampered");
  await expect(preflightRun(run, "/must-not-run")).rejects.toThrow("changed");
}, 30_000);

test("finish recovers pre-judge reporting failure without restarting candidates", async () => {
  const run = await prepared();
  const auth = join(root, "finish-auth.json");
  await file(auth, "{}\n", 0o600);
  const fake = await fakeOwnedDocker(0);
  const state = await runPair({ runDir: run, authFile: auth, dockerBin: fake.path });
  const oldSolRate = { model_id: "gpt-5.6-sol", source: "fixture:old-sol", prompt: 4 / 1_000_000,
    completion: 20 / 1_000_000, input_cache_read: 0.4 / 1_000_000, input_cache_write: 5 / 1_000_000, overrides: [] };
  state.pricing = { fetched_at: new Date().toISOString(), source: "fallback", catalog_url: "fixture://pricing",
    assumptions: [], warnings: [], models: { "gpt-5.6-sol": oldSolRate } };
  state.finishing = { status: "failed", started_at: new Date().toISOString(), bundle_path: "reports/bundle", error: "evidence pack too large before any judge request" };
  state.judge = { status: "failed", started_at: new Date().toISOString(), model: "gpt-5.6-sol", reasoning_effort: "high", service_tier: "priority", passes: [], winner: "none", usage_homes: [], attempts: [], error: "prompt preparation failed before launch" };
  await writeState(run, state);
  await file(join(run, "reports/bundle/prior-failure.txt"), "preserve this failure");
  const before = await readFile(fake.log, "utf8");
  await finishBenchmark({ runDir: run, authFile: auth, dockerBin: fake.path });
  const finished = await readState(run);
  expect(finished.finishing?.status).toBe("complete");
  expect(finished.judge?.model).toBe("gpt-6.1-sol");
  expect(finished.judge?.passes).toHaveLength(2);
  const savedPricing = finished.pricing as PricingSnapshot;
  expect(savedPricing.models["gpt-5.6-sol"]).toEqual(oldSolRate);
  expect(savedPricing.models["gpt-6.1-sol"]).toBeUndefined();
  expect(finished.judge_pricing?.rate.source).toBe("fallback:gpt-6.1-sol");
  expect(finished.judge_pricing?.rate.completion).toBe(10 / 1_000_000);
  const report = await Bun.file(join(run, "reports/report.json")).json();
  expect(report.pricing.models["gpt-6.1-sol"].completion).toBe(10 / 1_000_000);
  expect(report.pricing.assumptions).toContainEqual(expect.stringContaining("original run pricing is unchanged"));
  expect(finished.finishing_history).toHaveLength(1);
  expect(await readFile(join(run, finished.finishing_history![0]!.bundle_path, "prior-failure.txt"), "utf8")).toBe("preserve this failure");
  const additional = (await readFile(fake.log, "utf8")).slice(before.length);
  expect(additional).toContain("--model gpt-6.1-sol");
  expect(additional).not.toContain("-stock ");
  expect(additional).not.toContain("-current ");
  await expect(finishBenchmark({ runDir: run, authFile: auth, dockerBin: fake.path })).rejects.toThrow("failed finishing");
}, 30_000);

test.each(["timeout", "configuration", "tool-host"])("finish recovers %s harness startup without changing completed candidate or existing-test evidence", async failure => {
  let run: string;
  if (failure === "configuration") {
    const setupHome = join(root, "recover-config-home");
    await cp(home, setupHome, { recursive: true, verbatimSymlinks: true });
    await file(join(setupHome, ".codex/config.toml"), 'model_instructions_file = "/missing/setup-instructions.md"\n' + await readFile(join(home, ".codex/config.toml"), "utf8"));
    await checked(["git", "-C", setupHome, "add", ".codex/config.toml"]);
    await checked(["git", "-C", setupHome, "commit", "-m", "configured instructions"]);
    run = await prepare({ source, baseCommit: base, forbiddenCommit: future, taskPath: task, criteriaPath: fixtureCriteria,
      outputParent: root, currentHome: setupHome, image: "fixture-image", cpus: "2", memory: "4g", timeoutSeconds: 30,
      comparison: "setup-commits", setupACommit: "HEAD", setupBCommit: "HEAD" });
  } else run = await prepared();
  const auth = join(root, "recover-timeout-auth.json");
  await file(auth, "{}\n", 0o600);
  const fake = await fakeOwnedDocker(0);
  await runBenchmark({ runDir: run, authFile: auth, dockerBin: fake.path });
  const state = await readState(run);
  const judge = state.judge!;
  const arms = ["stock", "current"] as const;
  const savedResults = arms.map(arm => {
    const { grade: _grade, ...result } = state.results![arm]!;
    return result;
  });
  const savedPass = judge.passes[0]!;
  const candidateOutputs = await Promise.all(arms.map(arm => readFile(join(run, state.results![arm]!.stdout_path), "utf8")));
  judge.status = "failed";
  judge.service_tier = "fast";
  judge.error = failure === "timeout" ? `Error: semantic judge timed out after ${state.timeout_seconds} seconds`
    : failure === "configuration" ? "Error: semantic judge pass 1, executable checks, round 1 failed (1)"
    : `Error: ENOENT: no such file or directory, open '${join(run, "evaluator/judge/pass-1-harness-1-1/harness/checks.json")}'`;
  judge.failed_pass = 1;
  judge.passes = [];
  judge.winner = "none";
  judge.attempts = judge.attempts!.filter(item => item.stage === "harness-1");
  for (const attempt of judge.attempts) {
    attempt.service_tier = "fast";
    attempt.status = attempt.pass === 1 ? "failed" : "canceled";
    if (failure === "configuration") {
      attempt.error = attempt.pass === 1 ? judge.error : "Error: semantic judge canceled";
      await writeFile(join(run, attempt.stdout_path), "");
      await writeFile(join(run, attempt.stderr_path), attempt.pass === 1
        ? "Error: failed to read model instructions file /missing/setup-instructions.md: No such file or directory (os error 2)\n" : "");
      await cp(join(run, "snapshots/stock/home/ubuntu/.codex/config.toml"), join(run, attempt.usage_home, "config.toml"));
    }
    if (failure === "tool-host") {
      attempt.error = attempt.pass === 1 ? judge.error : "Error: semantic judge canceled";
      await writeFile(join(run, attempt.stderr_path), "ERROR codex_core::tools::router: error=code-mode host is disabled\n");
      const config = join(run, attempt.usage_home, "config.toml");
      await writeFile(config, (await readFile(config, "utf8")).replace("code_mode_host = true", "code_mode_host = false"));
    }
  }
  judge.usage_homes = judge.attempts.map(item => item.usage_home);
  const priorAttempts = structuredClone(judge.attempts);
  const attemptOutputs = await Promise.all(priorAttempts.map(item => readFile(join(run, item.stdout_path), "utf8")));
  const existingPaths = [1, 2].flatMap(pass => ["candidate-1", "candidate-2"].map(candidate =>
    join(run, `evaluator/semantic/pass-${pass}/existing/${candidate}/__existing_tests/evidence.json`)));
  const existingEvidence = await Promise.all(existingPaths.map(path => readFile(path, "utf8")));
  for (const pass of [1, 2]) {
    await rm(join(run, `evaluator/judge/pass-${pass}-assessment-1`), { recursive: true });
    await rm(join(run, `evaluator/semantic/pass-${pass}/round-1`), { recursive: true });
    await rm(join(run, `evaluator/semantic/pass-${pass}/round-1.json`));
  }
  state.finishing = { status: "failed", started_at: new Date().toISOString(), bundle_path: "reports/bundle", error: judge.error };
  await writeState(run, state);
  await expect(finishBenchmark({ runDir: run, authFile: auth, dockerBin: fake.path })).rejects.toThrow("--recover-judge");
  const toolManifest = join(run, state.runtime_tools.current_setup_files);
  const toolManifestHash = await sha256(toolManifest);
  if (failure === "configuration") {
    await file(join(state.runtime_tools.current_setup_installs, "fixture-runner/1/bin/project-runner"), "changed after execution\n");
    await expect(verifyPreparedInputs(run, state)).rejects.toThrow("current setup installations changed");
    for (const [path, message] of [[toolManifest, "snapshotted current setup file manifest changed"],
      [join(run, state.task.path), "copied benchmark control changed"]] as const) {
      const retained = await readFile(path);
      await writeFile(path, "tampered control\n");
      await expect(verifyPreparedInputs(run, state, "judging")).rejects.toThrow(message);
      await writeFile(path, retained);
    }
  }
  if (failure === "tool-host") {
    const failed = priorAttempts.find(attempt => attempt.status === "failed")!;
    for (const [path, replacement] of [[failed.stderr_path, "unrelated evaluator failure"],
      [`${failed.usage_home}/config.toml`, "[features]\ncode_mode_host = true\n"]] as const) {
      const retained = await readFile(join(run, path), "utf8");
      await writeFile(join(run, path), replacement);
      await expect(assertRecoverableJudge(run, state)).rejects.toThrow("recovery requires a failed judge");
      await writeFile(join(run, path), retained);
    }
  }

  for (const error of ["Error: provider authentication failed", `Error: semantic judge timed out after ${state.timeout_seconds + 1} seconds`]) {
    await expect(assertRecoverableJudge(run, { ...state, judge: { ...judge, error } })).rejects.toThrow("recovery requires a failed judge");
  }
  await expect(assertRecoverableJudge(run, { ...state, judge: { ...judge, status: "complete" } })).rejects.toThrow("recovery requires a failed judge");
  if (failure === "configuration") {
    const failed = priorAttempts.find(attempt => attempt.status === "failed")!;
    for (const [path, replacement] of [[failed.stdout_path, "model request output"], [failed.stderr_path, "provider authentication failed"],
      [`${failed.usage_home}/config.toml`, 'model_instructions_file = "/different/instructions.md"\n']] as const) {
      const retained = await readFile(join(run, path), "utf8");
      await writeFile(join(run, path), replacement);
      await expect(assertRecoverableJudge(run, state)).rejects.toThrow("recovery requires a failed judge");
      await writeFile(join(run, path), retained);
    }
  }
  await expect(assertRecoverableJudge(run, { ...state, judge: { ...judge, passes: [savedPass] } })).rejects.toThrow("no recorded pass");
  await expect(assertRecoverableJudge(run, { ...state, judge: { ...judge,
    attempts: judge.attempts.map((item, index) => index === 0 ? { ...item, status: "running" } : item),
  } })).rejects.toThrow("no running attempt");
  await rm(existingPaths[3]!);
  await expect(assertRecoverableJudge(run, state)).rejects.toThrow("completed existing tests in both passes");
  await writeFile(existingPaths[3]!, existingEvidence[3]!);
  const partialRound = join(run, "evaluator/semantic/pass-2/round-1");
  await mkdir(partialRound);
  await expect(assertRecoverableJudge(run, state)).rejects.toThrow("partially executed behavioral checks (pass 2, round 1)");
  await rm(partialRound, { recursive: true });

  const priorLog = await readFile(fake.log, "utf8");
  await finishBenchmark({ runDir: run, authFile: auth, dockerBin: fake.path, recoverJudge: true });
  const finished = await readState(run);
  expect(finished.finishing?.status).toBe("complete");
  expect(finished.judge?.status).toBe("complete");
  expect(finished.judge?.service_tier).toBe("default");
  expect(finished.judge?.passes).toHaveLength(2);
  expect(finished.judge?.recovery).toMatchObject({ previous_error: judge.error, reused_passes: [] });
  expect(finished.judge?.attempts?.filter(item => item.stage === "harness-1" && item.attempt === 1)).toEqual(priorAttempts);
  expect(await Promise.all(priorAttempts.map(item => readFile(join(run, item.stdout_path), "utf8")))).toEqual(attemptOutputs);
  expect(await Promise.all(existingPaths.map(path => readFile(path, "utf8")))).toEqual(existingEvidence);
  expect(arms.map(arm => {
    const { grade: _grade, ...result } = finished.results![arm]!;
    return result;
  })).toEqual(savedResults);
  expect(await Promise.all(arms.map(arm => readFile(join(run, finished.results![arm]!.stdout_path), "utf8")))).toEqual(candidateOutputs);
  for (const pass of [1, 2]) {
    expect(finished.judge?.attempts?.find(item => item.pass === pass && item.stage === "harness-1" && item.attempt === 2)?.status).toBe("complete");
    expect(finished.judge?.attempts?.find(item => item.pass === pass && item.stage === "harness-1" && item.attempt === 2)?.service_tier).toBe("default");
  }
  const addedLog = (await readFile(fake.log, "utf8")).slice(priorLog.length);
  expect(addedLog).toContain("-judge-1-harness-1-2");
  expect(addedLog).toContain("-judge-2-harness-1-2");
  const firstHarnessFinish = Math.min(...[1, 2].map(pass => addedLog.indexOf(`FINISH codex-ab-${state.id}-judge-${pass}-harness-1-2`)));
  for (const pass of [1, 2]) {
    expect(addedLog.indexOf(`start --attach codex-ab-${state.id}-judge-${pass}-harness-1-2`)).toBeLessThan(firstHarnessFinish);
  }
  expect(addedLog).not.toMatch(/-semantic-[12]-existing-/);
  expect(addedLog).not.toContain("-stock ");
  expect(addedLog).not.toContain("-current ");
  expect(addedLog).not.toContain(`${state.runtime_tools.current_setup_installs}:`);
  expect(await sha256(toolManifest)).toBe(toolManifestHash);
  expect(finished.finishing_history).toHaveLength(1);
  expect(await Bun.file(join(run, "reports/bundle/semantic/pass-1/plans/harness-1-2/checks.json")).exists()).toBe(true);
}, 30_000);
