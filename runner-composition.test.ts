import { expect, spyOn, test } from "bun:test";
import { cp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { verifyPreparedInputs } from "./prepare";
import { runBenchmark } from "./workflow";
import { importArms } from "./control";
import { prepareTrials, readTrialSet } from "./trials";
import { checked } from "./process";
import { readState, writeState, sha256 } from "./state";
import { preflightRun, runPair } from "./runner";
import { judgeRun } from "./judge";
import * as bundles from "./bundle";
import * as usage from "./usage";
import * as mekugi from "./mekugi";
import * as runtimeHomes from "./runtime-home";
import { buildReport } from "./report";
import { embeddedFallbackPricing } from "./usage";
import { JUDGE_DISABLED_FEATURES } from "./judge-boundary";
import { runnerFixture } from "./test-support/runner-fixture";

const { root, source, home, task, fixtureCriteria, mekugiSource, base, future, file, prepare, fakeOwnedDocker } = await runnerFixture();

test("current setup defaults do not constrain independently selected arm models", async () => {
  const currentHome = join(root, "different-model-home");
  await cp(home, currentHome, { recursive: true, verbatimSymlinks: true });
  await writeFile(join(currentHome, ".codex/config.toml"), 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "high"\nservice_tier = "default"\n');
  const run = await prepare({ source, baseCommit: base, forbiddenCommit: future, taskPath: task, criteriaPath: fixtureCriteria,
    outputParent: root, currentHome, image: "fixture-image", cpus: "2", memory: "4g", timeoutSeconds: 30,
    codexBinary: join(home, ".local/bin/codex"), armSettings: { stock: { model: "gpt-6.1-terra" }, current: { model: "gpt-6-astra" } } });
  const state = await readState(run);
  await verifyPreparedInputs(run, state);
  expect(state.arm_settings).toEqual({ stock: { model: "gpt-6.1-terra" }, current: { model: "gpt-6-astra" } });
});

test("custom composition prepares independent launcher and stock/revision choices", async () => {
  const revision = (await checked(["git", "-C", home, "rev-parse", "HEAD"])).stdout.trim();
  for (const secondSetup of ["stock", revision]) {
    const arms = [
      { launcher: "codex" as const, setup_commit: "stock" },
      { launcher: "mekugi" as const, setup_commit: secondSetup },
      { launcher: "codex" as const, setup_commit: revision },
      { launcher: "mekugi" as const, setup_commit: secondSetup === "stock" ? revision : "stock" },
    ];
    const run = await prepare({ source, baseCommit: base, forbiddenCommit: future, taskPath: task, criteriaPath: fixtureCriteria,
      outputParent: root, currentHome: home, image: "fixture-image", cpus: "2", memory: "4g", timeoutSeconds: 30,
      comparison: "custom", arms, mekugiSource, mekugiBinary: join(home, "go/bin/mekugi"), codexBinary: join(home, ".local/bin/codex") });
    const state = await readState(run);
    expect(state.arm_configurations).toEqual(arms);
    await verifyPreparedInputs(run, state);
    for (const [index, arm] of Object.keys(state.arms).entries()) {
      const template = join(run, state.arms[arm]!.home_template);
      expect(await Bun.file(join(template, ".codex/AGENTS.md")).exists()).toBe(arms[index]!.setup_commit !== "stock");
      expect(await Bun.file(join(template, ".config/mise/config.toml")).exists()).toBe(true);
    }
    const fake = await fakeOwnedDocker(0, false, false, "", false, false, undefined, undefined, 4);
    await preflightRun(run, fake.path);
  }
}, 30_000);

test("custom composition snapshots tracked worktree edits using a separate runtime home", async () => {
  const config = join(root, "worktree-configuration");
  await checked(["git", "clone", "--no-local", home, config]);
  await file(join(config, ".codex/AGENTS.md"), "optimized instruction\n");
  await rm(join(config, ".codex/SMALL-TASK.md"));
  const before = (await checked(["git", "-C", config, "status", "--porcelain"])).stdout;
  const arms = [{ launcher: "codex" as const, setup_commit: "stock" },
    { launcher: "codex" as const, setup_commit: "HEAD" },
    { launcher: "codex" as const, setup_commit: "worktree" }];
  const run = await prepare({ source, baseCommit: base, forbiddenCommit: future, taskPath: task, criteriaPath: fixtureCriteria,
    outputParent: root, currentHome: config, runtimeHome: home, image: "fixture-image", cpus: "2", memory: "4g", timeoutSeconds: 30,
    comparison: "custom", arms });
  const state = await readState(run);
  const frozen = join(run, state.arms.current!.home_template);
  const edited = join(run, state.arms["arm-3"]!.home_template);
  expect(await readFile(join(frozen, ".codex/AGENTS.md"), "utf8")).toBe("fixture\n");
  expect(await readFile(join(edited, ".codex/AGENTS.md"), "utf8")).toBe("optimized instruction\n");
  expect(await Bun.file(join(edited, ".codex/SMALL-TASK.md")).exists()).toBe(false);
  expect(state.setup_revisions?.["arm-3"]?.worktree).toBe(true);
  const manifest = JSON.parse(await readFile(join(run, state.setup_revisions!["arm-3"]!.manifest), "utf8"));
  expect(manifest.configuration_repository.tracked_worktree_changes).toContain(".codex/AGENTS.md");
  expect(state.runtime_tools.current_setup_installs).toBe(await realpath(join(home, ".local/share/mise/installs")));
  await verifyPreparedInputs(run, state);
  expect((await checked(["git", "-C", config, "status", "--porcelain"])).stdout).toBe(before);
  const auth = join(root, "worktree-auth.json");
  await file(auth, "{}\n", 0o600);
  const fake = await fakeOwnedDocker(0, false, false, "", false, false, undefined, undefined, 3);
  const runtime = spyOn(runtimeHomes, "prepareRuntimeHome").mockResolvedValue({ key: "fixture", image_id: `sha256:${"a".repeat(64)}` });
  try {
    await runPair({ runDir: run, authFile: auth, dockerBin: fake.path, arm: "arm-3" });
    expect(runtime.mock.calls[0]?.[0].sourceHome).toBe(home);
  } finally { runtime.mockRestore(); }
}, 30_000);

test("custom composition executes and blindly assesses every isolated arm, then retains all trial controls", async () => {
  const revision = (await checked(["git", "-C", home, "rev-parse", "HEAD"])).stdout.trim();
  const run = await prepare({ source, baseCommit: base, forbiddenCommit: future, taskPath: task, criteriaPath: fixtureCriteria,
    outputParent: root, currentHome: home, image: "fixture-image", cpus: "2", memory: "4g", timeoutSeconds: 30,
    comparison: "custom", arms: [{ launcher: "codex", setup_commit: revision }, { launcher: "mekugi", setup_commit: revision }, { launcher: "mekugi", setup_commit: "HEAD" }],
    armSettings: { stock: { model: "gpt-6.1-terra", reasoning_effort: "high", cpus: "3", memory: "5g", timeout_seconds: 45, auto_compact_limit: 12345, parallel_work: true, skills: { "use-modern-go": false } }, current: { mekugi_flags: ["--shell-guard=false"] }, "arm-3": { mekugi_flags: ["--shell-guard=true"] } },
    mekugiSource, mekugiBinary: join(home, "go/bin/mekugi"), codexBinary: join(home, ".local/bin/codex") });
  const initial = await readState(run);
  const keys = ["stock", "current", "arm-3"];
  expect(Object.keys(initial.arms)).toEqual(keys);
  expect(new Set(Object.values(initial.arms).map(arm => arm.repository)).size).toBe(3);
  expect(Object.keys(initial.setup_revisions!)).toEqual(keys);
  expect(Object.keys(initial.mekugi_exports_by_arm!)).toEqual(["current", "arm-3"]);
  await verifyPreparedInputs(run, initial);
  initial.pricing = { fetched_at: "fixture", source: "fallback", catalog_url: "fixture", assumptions: [], warnings: [], models: {} };
  await writeState(run, initial);
  const fake = await fakeOwnedDocker(0, false, false, "", false, false, undefined, undefined, 3);
  const trials = await prepareTrials({ runDir: run, count: 2, schedule: "alternating", outputParent: root, dockerBin: fake.path });
  const set = await readTrialSet(trials);
  const copied = await readState(join(trials, set.trials[0]!.run_dir));
  expect(copied.arm_configurations).toEqual(initial.arm_configurations);
  expect(copied.arm_settings).toEqual(initial.arm_settings);
  expect(await Bun.file(join(trials, set.trials[0]!.run_dir, copied.arms["arm-3"]!.repository, "go.mod")).exists()).toBe(true);
  const auth = join(root, "custom-auth.json");
  await file(auth, "{}", 0o600);
  const ready = await readState(run);
  ready.arm_order = "current-first";
  await writeState(run, ready);
  const originalWrite = process.stderr.write;
  let operatorLog = "";
  process.stderr.write = function (...args: Parameters<typeof originalWrite>) {
    operatorLog += String(args[0]);
    return originalWrite.apply(process.stderr, args);
  } as typeof originalWrite;
  const meter = spyOn(usage, "meterRollouts");
  const validate = spyOn(mekugi, "validateMekugiExports");
  try {
    await runBenchmark({ runDir: run, authFile: auth, dockerBin: fake.path });
    expect(validate.mock.calls.map(call => call[2]).sort()).toEqual(["arm-3", "current"]);
    // Native accounting can fall back to rollout accounting, but neither is repeated.
    const requests = meter.mock.calls.map(call => JSON.stringify([call[0], call[3] ?? "rollout"]));
    expect(new Set(requests).size).toBe(requests.length);
    expect(requests.length).toBeGreaterThanOrEqual(keys.length + (await readState(run)).judge!.usage_homes.length);
  } finally {
    process.stderr.write = originalWrite;
    meter.mockRestore();
    validate.mockRestore();
  }
  expect(operatorLog).toContain("agent execution order: Setup 3 / Codex + Mekugi (setup " + revision.slice(0, 12) + ") first");
  const finished = await readState(run);
  expect(finished.selected_arms).toEqual(keys);
  expect(finished.judge?.passes.map(pass => pass.presentation)).toEqual([keys, [...keys].reverse()]);
  expect(finished.judge?.passes.every(pass => Object.keys(pass.scores).length === 3)).toBe(true);
  expect(keys.every(arm => finished.results?.[arm]?.grade?.passed)).toBe(true);
  const log = await readFile(fake.log, "utf8");
  expect(log).toContain("/candidates/candidate-3:ro");
  expect(log).toContain(`--name codex-ab-${initial.id}-arm-3 `);
  const launches = keys.map(arm => log.split("\n").find(line => line.includes(" create ") && line.includes(`--name codex-ab-${initial.id}-${arm} `))!);
  expect(launches[0]).toContain("/usr/local/bin/codex");
  expect(launches[1]).toContain("/usr/local/bin/mekugi");
  expect(launches[2]).toContain("/usr/local/bin/mekugi");
  expect(launches[0]).toContain("--model gpt-6.1-terra");
  expect(launches[0]).toContain('model_reasoning_effort="high"');
  expect(launches[0]).toContain("--cpus 3 --memory 5g");
  expect(launches[0]).toContain("model_auto_compact_token_limit=12345");
  expect(launches[1]).toContain("--shell-guard=false");
  expect(launches[2]).toContain("--shell-guard=true");
  expect(launches[1]).not.toContain("gpt-6.1-terra");
  expect(await readFile(join(run, "artifacts/stock/task.md"), "utf8")).toContain("## Parallel work");
  expect(await readFile(join(run, "artifacts/current/task.md"), "utf8")).not.toContain("## Parallel work");
  expect((await Bun.file(join(run, initial.arms.stock.home_template, ".skills-mgr/.skills-mgr.json")).json()).skills["use-modern-go"].enabled).toBe("lang go");
  expect(log.indexOf(launches[2]!)).toBeLessThan(log.indexOf(launches[1]!));
  expect(log.indexOf(launches[1]!)).toBeLessThan(log.indexOf(launches[0]!));
  const report = await Bun.file(join(run, "reports/report.json")).json();
  expect(Object.keys(report.arms)).toEqual(keys);
  expect(report.setup.arm_settings).toEqual(initial.arm_settings);
  expect(Object.keys(report.baseline_differences_percent)).toEqual(["current", "arm-3"]);
  expect(report.winner).toBe("none"); // Fake execution deliberately provides no usage or provider capture.
  expect(await Bun.file(join(run, "reports/bundle/arm-3-snapshot-manifest.json")).exists()).toBe(true);
  await file(join(run, initial.arms["arm-3"]!.home_template, ".codex/AGENTS.md"), "tampered");
  await expect(verifyPreparedInputs(run, finished)).rejects.toThrow("arm-3 setup revision snapshot changed");
}, 30_000);

test.each(["reuse", "fresh"])("historical multi-arm imports execute one new candidate with %s evaluation", async mode => {
  const revision = (await checked(["git", "-C", home, "rev-parse", "HEAD"])).stdout.trim();
  const options = { source, baseCommit: base, forbiddenCommit: future, taskPath: task, criteriaPath: fixtureCriteria,
    outputParent: root, currentHome: home, image: "fixture-image", cpus: "2", memory: "4g", timeoutSeconds: 30,
    comparison: "custom" as const, arms: [{ launcher: "codex" as const, setup_commit: "stock" },
      { launcher: "mekugi" as const, setup_commit: revision }, { launcher: "codex" as const, setup_commit: revision }],
    mekugiSource, mekugiBinary: join(home, "go/bin/mekugi"), codexBinary: join(home, ".local/bin/codex") };
  const sourceRun = await prepare(options);
  const sourceState = await readState(sourceRun);
  sourceState.pricing = { fetched_at: "fixture", source: "fallback", catalog_url: "fixture", assumptions: [], warnings: [], models: { "gpt-6-astra": embeddedFallbackPricing("gpt-6-astra") } };
  await writeState(sourceRun, sourceState);
  const auth = join(root, "import-auth.json");
  await file(auth, "{}", 0o600);
  const first = await fakeOwnedDocker(0, false, false, "", false, false, undefined, undefined, 3);
  await runBenchmark({ runDir: sourceRun, authFile: auth, dockerBin: first.path });
  const completed = await readState(sourceRun);
  // One retained pass predates qualitative evidence; the other records it.
  delete completed.judge!.passes[0]!.quality_aspects;
  for (const pass of completed.judge!.passes) for (const score of Object.values(pass.scores)) {
    delete score.simplicity; delete score.performance; delete score.approach; delete score.rubric;
  }
  const recoveryPath = "artifacts/recovery/docker-timing.json";
  await file(join(sourceRun, recoveryPath), JSON.stringify({ Id: "recovered-container", State: { ExitCode: 0 } }));
  completed.results!.current!.recovery = { source_run_id: completed.id, source_arm: "current", collected_at: "2026-10-30T08:00:00.000Z",
    container_id: "recovered-container", timing_source: "docker-inspect", controller_elapsed_available: false,
    caveats: ["The original controller was canceled by the user. Later container completion does not erase that cancellation."],
    files: [{ path: recoveryPath, sha256: await sha256(join(sourceRun, recoveryPath)) }] };
  await writeState(sourceRun, completed);
  for (const arm of ["current", "arm-3"]) await file(join(sourceRun, completed.arm_attempts![arm]!.codex_home, "sessions/usage.jsonl"), [
    { type: "session_meta", payload: { id: arm } },
    { type: "turn_context", payload: { model: "gpt-6-astra" } },
    { type: "token_usage_record", payload: { response_id: arm, usage: { input_tokens: 10, cached_input_tokens: 2, cache_write_input_tokens: 0, output_tokens: 3, reasoning_output_tokens: 1, total_tokens: 13 } } },
  ].map(event => JSON.stringify(event)).join("\n") + "\n");
  await buildReport(sourceRun);
  const bundleHash = await sha256(join(sourceRun, "reports/bundle/MANIFEST.sha256"));
  const run = await prepare(options);
  const ready = await readState(run);
  ready.planned_imports = [{ target_arm: "stock", run_dir: sourceRun, arm: "current", bundle_sha256: bundleHash },
    { target_arm: "current", run_dir: sourceRun, arm: "arm-3" }];
  ready.pricing = sourceState.pricing;
  await writeState(run, ready);
  const fake = await fakeOwnedDocker(0, false, false, "", false, false, undefined, undefined, mode === "reuse" ? 1 : 3);
  if (mode === "reuse") await writeFile(fake.path, (await readFile(fake.path, "utf8")).replaceAll("if (1 !== 1)", "if (2 !== 2)"));
  await runBenchmark({ runDir: run, authFile: auth, dockerBin: fake.path, evaluationMode: mode });
  const finished = await readState(run);
  expect(finished.status).toBe("complete");
  expect(finished.finishing?.status).toBe("complete");
  expect(finished.judge?.passes.map(pass => pass.presentation)).toEqual([["stock", "current", "arm-3"], ["arm-3", "current", "stock"]]);
  const log = await readFile(fake.log, "utf8");
  for (const arm of ["stock", "current"]) expect(log).not.toContain(`--name codex-ab-${finished.id}-${arm} `);
  expect(log).toContain(`--name codex-ab-${finished.id}-arm-3 `);
  if (mode === "reuse") {
    expect(finished.judge!.winner).toBe("none");
    expect(finished.judge!.passes.every(pass => pass.winner === "none")).toBe(true);
    expect(finished.results!.stock!.grade).toEqual(completed.results!.current!.grade);
    expect(finished.results!.current!.grade).toEqual(completed.results!["arm-3"]!.grade);
    expect(log).not.toContain(`${finished.id}-stock-grade-verify`);
    expect(log).not.toContain("round-1-candidate-2-fixture");
    expect(log).not.toContain("/evaluator/stock:/candidates/");
    expect(finished.judge!.passes[0]!.scores["candidate-1"]).toEqual(completed.judge!.passes[0]!.scores["candidate-2"]);
    expect(finished.judge!.passes[1]!.scores["candidate-3"]).toEqual(completed.judge!.passes[1]!.scores["candidate-2"]);
    for (const id of ["candidate-1", "candidate-2"] as const) {
      expect(finished.judge!.passes[0]!.quality_aspects![id].simplicity).toMatchObject({ status: "unassessed", basis: "none" });
    }
    expect(finished.judge!.passes[0]!.quality_aspects!["candidate-3"].simplicity).toEqual({
      status: "satisfactory", basis: "source", reasoning: "candidate-3 / candidate-3 / candidate-3 uses a focused implementation for simplicity.",
    });
    expect(finished.judge!.passes[1]!.quality_aspects!["candidate-3"].simplicity).toEqual({
      status: "satisfactory", basis: "source", reasoning: "candidate-3 / candidate-3 / candidate-3 uses a focused implementation for simplicity.",
    });
    expect(finished.judge!.passes[1]!.quality_aspects!["candidate-2"].simplicity.reasoning).toBe("candidate-2 / candidate-2 / candidate-2 uses a focused implementation for simplicity.");
    expect(finished.judge!.passes[1]!.quality_aspects!["candidate-1"].simplicity.reasoning).toBe("candidate-1 / candidate-1 / candidate-1 uses a focused implementation for simplicity.");
    const seed = await Bun.file(join(run, "evaluator/semantic/pass-1/historical.json")).json();
    expect(seed["candidate-1"].criteria[0].check.files[0].source).toContain("process.exit");
    expect(seed["candidate-1"].criteria[0].check.files[0].source).toContain("1 !== 1");
    expect(finished.results!["arm-3"]!.grade!.semantic!["pass-1"]![0]!.check!.files[0]!.source).toContain("2 !== 2");
    const prompt = await readFile(join(fake.stateDir, `codex-ab-${finished.id}-judge-1-harness-1-1.prompt`), "utf8");
    expect(prompt).toContain("Start from those tests and assessments, not a new test design");
    expect(prompt).toContain("Preserve the same behavioral outcomes, assertions, edge cases, and failure conditions");
  }
  const report = await Bun.file(join(run, "reports/report.json")).json();
  expect(report.evaluation.mode).toBe(mode);
  expect(report.arm_labels.stock).toContain("Codex + Mekugi");
  expect(report.arm_labels.current).toContain(revision.slice(0, 12));
  expect(report.arms.stock.usage.totals.input_tokens).toBe(10);
  expect(report.arms.current.usage.totals.input_tokens).toBe(10);
  expect(report.setup.imported_arms.stock.source_arm).toBe("current");
  const recovery = finished.results!.stock!.recovery!;
  expect(recovery.source_run_id).toBe(completed.id);
  expect(recovery.files[0]!.path).toBe(`evaluator/imported-arms/stock/${recoveryPath}`);
  expect(report.recovery.stock).toEqual(recovery);
  expect(report.efficiency.faster).toBeNull();
  expect(report.baseline_differences_percent.current.agent_elapsed_ms).toBeNull();
  expect(await sha256(join(run, "reports/bundle", recovery.files[0]!.path))).toBe(recovery.files[0]!.sha256);
  if (mode === "reuse") {
    expect(report.winner).toBe("none");
    expect(report.score_comparison_issue).toContain("different scoring rubrics");
    expect(report.judge.result.passes[0].quality_aspects["candidate-1"].approach.status).toBe("unassessed");
    expect(await readFile(join(run, "reports/report.md"), "utf8")).toContain("| candidate-1 | approach | unassessed | none |");
  }
  expect(await sha256(join(sourceRun, "reports/bundle/MANIFEST.sha256"))).toBe(bundleHash);
  await rename(sourceRun, sourceRun + "-moved");
  await buildReport(run);
  expect((await Bun.file(join(run, "reports/report.json")).json()).arms.stock.usage.totals.input_tokens).toBe(10);
  expect(await Bun.file(join(run, "reports/bundle/evaluator/imported-arms/stock/run.json")).exists()).toBe(true);
  expect(await Bun.file(join(run, "reports/bundle", finished.results!.stock!.stdout_path)).exists()).toBe(false);
  expect((await Bun.file(join(run, "reports/bundle/final-integrity.json")).json()).passed).toBe(true);
  const nestedDirectory = join(root, "nested-recovery-import");
  const mutableEvidenceRoot = join(run, finished.imported_arms!.stock!.directory);
  const mutableEvidenceState = await readState(mutableEvidenceRoot);
  delete mutableEvidenceState.results!.current!.recovery;
  await writeState(mutableEvidenceRoot, mutableEvidenceState);
  const nested = await importArms(nestedDirectory, structuredClone(finished), [{ target_arm: "current", run_dir: run, arm: "stock" }]);
  expect(nested.current!.recovery!.files[0]!.path).toBe(`evaluator/imported-arms/current/${recoveryPath}`);
  expect(nested.current!.recovery!.source_run_id).toBe(completed.id);
  expect(nested.current!.recovery!.caveats).toEqual(recovery.caveats);
  expect(await sha256(join(nestedDirectory, nested.current!.recovery!.files[0]!.path))).toBe(recovery.files[0]!.sha256);
  await file(join(run, recovery.files[0]!.path), "changed sanitized timing evidence\n");
  await expect(bundles.collectBundle(run)).rejects.toThrow("finishing integrity checks failed");
  expect((await readState(run)).invalidity_reasons).toContain("finishing control integrity check failed");
}, 30_000);

test.each(["codex", "mekugi"] as const)("setup commits freeze both revisions with shared %s runtime", async launcher => {
  const setupHome = join(root, `revision-home-${launcher}`);
  await cp(home, setupHome, { recursive: true, verbatimSymlinks: true });
  const configPath = join(setupHome, ".codex/config.toml");
  const historicalConfig = join(setupHome, "historical-config.toml");
  const originalConfig = 'model_instructions_file = "/missing/setup-instructions.md"\n' + await readFile(configPath, "utf8");
  await file(historicalConfig, originalConfig);
  await rm(configPath);
  await symlink(historicalConfig, configPath);
  const mekugiSettings = '[service_tiers]\n"gpt-6.1-sol" = "default"\n[features]\nshell_guard = true\n[orchestration.reviewers]\ncorrectness = "review-correctness"\nsimplification = "review-simplify"\n';
  await file(join(setupHome, "historical-mekugi.toml"), mekugiSettings);
  await mkdir(join(setupHome, ".config/mekugi"), { recursive: true });
  await symlink(join(setupHome, "historical-mekugi.toml"), join(setupHome, ".config/mekugi/config.toml"));
  await file(join(setupHome, ".local/bin/codex"), "#!/bin/sh\necho historical-codex\n", 0o755);
  await file(join(setupHome, ".local/bin/check_project"), "#!/bin/sh\necho setup-utility\n", 0o755);
  await checked(["git", "-C", setupHome, "add", "-f", ".local/bin/codex", ".local/bin/check_project", ".codex/config.toml", "historical-config.toml", ".config/mekugi/config.toml", "historical-mekugi.toml"]);
  await checked(["git", "-C", setupHome, "commit", "-m", "historical config and launcher"]);
  const first = (await checked(["git", "-C", setupHome, "rev-parse", "HEAD"])).stdout.trim();
  await rm(configPath);
  await symlink("../historical-config.toml", configPath);
  await checked(["git", "-C", setupHome, "rm", "--cached", ".local/bin/codex"]);
  await cp(join(home, ".local/bin/codex"), join(setupHome, ".local/bin/codex"));
  await file(join(setupHome, ".codex/AGENTS.md"), "second revision\n");
  await file(join(setupHome, ".codex/hooks/revision.ts"), "second hook source\n");
  await checked(["git", "-C", setupHome, "add", ".codex"]);
  await checked(["git", "-C", setupHome, "commit", "-m", "second setup"]);
  const second = (await checked(["git", "-C", setupHome, "rev-parse", "HEAD"])).stdout.trim();
  await file(join(setupHome, ".codex/AGENTS.md"), "dirty live guidance\n");
  await file(join(setupHome, ".codex/hooks/revision.ts"), "dirty hook source\n");
  await file(historicalConfig, originalConfig + "# dirty live config\n");
  const options = { source, baseCommit: base, forbiddenCommit: future, taskPath: task,
    criteriaPath: fixtureCriteria, outputParent: root, currentHome: setupHome, image: "fixture-image",
    cpus: "2", memory: "4g", timeoutSeconds: 30, comparison: "setup-commits" as const,
    setupACommit: first, setupBCommit: second, currentLauncher: launcher,
    mekugiSource: launcher === "mekugi" ? mekugiSource : undefined };
  const run = await prepare(options);
  const state = await readState(run);
  expect(state.setup_revisions?.stock.commit).toBe(first);
  expect(state.setup_revisions?.current.commit).toBe(second);
  const a = join(run, state.arms.stock.home_template);
  const b = join(run, state.arms.current.home_template);
  expect(await readFile(join(a, ".codex/AGENTS.md"), "utf8")).toBe("fixture\n");
  for (const snapshot of [a, b]) {
    expect(await readFile(join(snapshot, ".codex/config.toml"), "utf8")).not.toContain("dirty live config");
    expect((Bun.TOML.parse(await readFile(join(snapshot, ".codex/config.toml"), "utf8")) as Record<string, unknown>).projects).toEqual({ "/workspace": { trust_level: "trusted" } });
    if (launcher === "mekugi") {
      const adapted = Bun.TOML.parse(await readFile(join(snapshot, ".config/mekugi/config.toml"), "utf8"));
      expect(adapted).toEqual({ service_tiers: { "gpt-6.1-sol": "default" }, features: { shell_guard: true } });
      const manifest = await Bun.file(join(dirname(snapshot), "snapshot-manifest.json")).json();
      expect(manifest.adaptations.some((entry: string) => entry.includes("orchestration.reviewers omitted"))).toBe(true);
      expect((await checked(["git", "-C", snapshot, "show", "HEAD:historical-mekugi.toml"])).stdout).toBe(mekugiSettings);
    }
  }
  expect(await readFile(join(setupHome, ".config/mekugi/config.toml"), "utf8")).toBe(mekugiSettings);
  expect(await readFile(historicalConfig, "utf8")).toBe(originalConfig + "# dirty live config\n");
  expect(await Bun.file(join(a, ".codex/hooks/revision.ts")).exists()).toBe(false);
  expect(await readFile(join(b, ".codex/AGENTS.md"), "utf8")).toBe("second revision\n");
  expect(await readFile(join(b, ".codex/hooks/revision.ts"), "utf8")).toBe("second hook source\n");
  expect(await readFile(join(setupHome, ".codex/AGENTS.md"), "utf8")).toBe("dirty live guidance\n");
  expect(await sha256(join(a, ".codex/hooks/bin/session_start_context"))).toBe(await sha256(join(b, ".codex/hooks/bin/session_start_context")));
  await verifyPreparedInputs(run, state);
  if (launcher === "mekugi") {
    const changed = structuredClone(state);
    changed.mekugi_exports_by_arm!.stock!.capture = changed.mekugi_exports_by_arm!.current!.capture;
    await expect(verifyPreparedInputs(run, changed)).rejects.toThrow("per-arm exports changed");
  }
  const auth = join(root, `revision-auth-${launcher}.json`);
  await file(auth, "{}\n", 0o600);
  const fake = await fakeOwnedDocker(0);
  if (launcher === "mekugi") {
    state.pricing = { fetched_at: new Date().toISOString(), source: "fallback", catalog_url: "fixture", assumptions: [], warnings: [], models: {} };
    await writeState(run, state);
    const trials = await prepareTrials({ runDir: run, count: 2, outputParent: root, dockerBin: fake.path });
    const set = await readTrialSet(trials);
    expect(set.controls.setup_revisions).toEqual(state.setup_revisions);
    for (const trial of set.trials) {
      const directory = join(trials, trial.run_dir);
      const trialState = await readState(directory);
      expect(trialState.preflight).toBeUndefined();
      await verifyPreparedInputs(directory, trialState);
    }
    await writeFile(fake.log, "");
  }
  expect((await runPair({ runDir: run, authFile: auth, dockerBin: fake.path })).status).toBe("complete");
  const calls = (await readFile(fake.log, "utf8")).split("\n");
  const stagedHomes = calls.filter(line => line.startsWith("PREFLIGHT_HOME ")).map(line => line.split(" ")[1]!);
  expect(stagedHomes).toHaveLength(launcher === "mekugi" ? 4 : 2);
  expect(new Set(stagedHomes).size).toBe(stagedHomes.length);
  for (const staged of stagedHomes) expect(await Bun.file(join(staged, ".codex/config.toml")).exists()).toBe(false);
  for (const snapshot of [a, b]) expect(await readFile(join(snapshot, ".local/bin/check_project"), "utf8")).toBe("#!/bin/sh\necho setup-utility\n");
  if (launcher === "mekugi") {
    const preflights = calls.filter(line => line.includes(" create ") && line.includes("mekugi-metrics") && line.includes("codex --version"));
    expect(preflights).toHaveLength(2);
    expect(preflights.every(line => line.includes(":/home/ubuntu "))).toBe(true);
    expect(preflights.every(line => !line.includes(":/setup:ro"))).toBe(true);
  }
  const launches = calls.filter(line => (line.includes(" exec --json ") || line.includes(" headless --yolo ")));
  expect(launches).toHaveLength(2);
  expect(launches.every(line => line.includes(" --workdir /workspace "))).toBe(true);
  expect(launches.every(line => line.includes(" mise exec -- "))).toBe(true);
  expect(launches.every(line => line.includes('export PATH="/opt/task-deps/python/bin:/usr/local/bin:$PATH"; exec "$@"'))).toBe(true);
  expect(launches.every(line => line.includes(launcher === "mekugi" ? "/usr/local/bin/mekugi --capture-output" : "/usr/local/bin/codex exec"))).toBe(true);
  if (launcher === "mekugi") {
    expect(launches.every(line => line.includes("codex headless --yolo -c bypass_hook_trust=true --model"))).toBe(true);
    expect(launches.every(line => !line.includes("codex exec --json"))).toBe(true);
    expect(launches.every(line => !line.includes("--color never") && !line.includes(" -C /workspace"))).toBe(true);
  }
  expect(launches.every(line => line.includes(`${state.runtime_tools.current_setup_installs}:${state.runtime_tools.current_setup_installs}:ro`))).toBe(true);
  const completed = await readState(run);
  completed.pricing = { fetched_at: new Date().toISOString(), source: "fallback", catalog_url: "fixture", assumptions: [], warnings: [], models: {} };
  await writeState(run, completed);
  const report = await buildReport(run);
  const markdown = await readFile(report.markdownPath, "utf8");
  const reported = await Bun.file(report.jsonPath).json();
  if (launcher === "mekugi") for (const arm of ["stock", "current"]) {
    expect(markdown).toContain(`### ${reported.arm_labels[arm]}`);
  }
  if (launcher === "mekugi") for (const arm of ["stock", "current"]) {
    expect(reported.arms[arm].usage.warnings.some((warning: string) => warning.includes("Mekugi provider-attempt accounting"))).toBe(true);
  }
  expect(markdown).toContain(`commit ${first}; tree ${state.setup_revisions!.stock.tree}`);
  expect(markdown).toContain(`commit ${second}; tree ${state.setup_revisions!.current.tree}`);
  const candidateConfigs = await Promise.all([a, b].map(snapshot => readFile(join(snapshot, ".codex/config.toml"), "utf8")));
  expect((await judgeRun(run, auth, fake.path)).status).toBe("complete");
  const judged = await readState(run);
  for (const attempt of judged.judge!.attempts!) {
    const mounted = join(fake.stateDir, `codex-ab-${state.id}-judge-${attempt.pass}-${attempt.stage}-${attempt.attempt}.config.toml`);
    expect(Bun.TOML.parse(await readFile(mounted, "utf8"))).toEqual({ model: "gpt-6.1-sol", model_reasoning_effort: "high",
      service_tier: "default", approval_policy: "never", sandbox_mode: "read-only", web_search: "disabled",
      features: { code_mode_host: true, ...Object.fromEntries(JUDGE_DISABLED_FEATURES.map(feature => [feature, false])) },
      mcp_servers: { source_reader: { command: "node", args: ["/reader/reader.mjs"], required: true, default_tools_approval_mode: "approve", enabled_tools: ["list_files", "read_file", "write_check_plan"] } },
      projects: { "/workspace": { trust_level: "trusted" } } });
  }
  expect(await Promise.all([a, b].map(snapshot => readFile(join(snapshot, ".codex/config.toml"), "utf8")))).toEqual(candidateConfigs);
  await bundles.collectBundle(run);
  expect(await Bun.file(join(run, "reports/bundle/setup-a-snapshot-manifest.json")).exists()).toBe(true);
  await file(join(a, ".codex/AGENTS.md"), "tampered\n");
  await expect(verifyPreparedInputs(run, state)).rejects.toThrow("stock setup revision snapshot changed");
  await expect(prepare({ ...options, setupACommit: "missing-ref" })).rejects.toThrow();
  await expect(prepare({ ...options, setupBCommit: undefined })).rejects.toThrow("requires both");
}, 15_000);

test.each([false, true])("preparation accepts a relative output parent (symlink: %s)", async linked => {
  const parent = linked ? join(root, "linked-output") : root;
  if (linked) await symlink(root, parent);
  const run = await prepare({ source, baseCommit: base, forbiddenCommit: future, taskPath: task,
    criteriaPath: fixtureCriteria, currentHome: home, outputParent: relative(process.cwd(), parent),
    image: "fixture-image", cpus: "2", memory: "4g", timeoutSeconds: 30 });
  expect(run).toBe(await realpath(run));
  await verifyPreparedInputs(run, await readState(run));
});
