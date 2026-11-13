import { expect, spyOn, test } from "bun:test";
import { cp, readFile, readdir, stat, readlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { verifyPreparedInputs } from "./prepare";
import { reevaluateBenchmark, runBenchmark } from "./workflow";
import { importArms } from "./control";
import { prepareReevaluation } from "./reevaluate";
import { prepareTrials, readTrialSet, reportTrials, runTrials } from "./trials";
import { main } from "./cli";
import { checked } from "./process";
import { readState, writeState, sha256 } from "./state";
import { preflightRun, runPair } from "./runner";
import * as bundles from "./bundle";
import { buildReport } from "./report";
import { runnerFixture } from "./test-support/runner-fixture";

const { root, source, home, task, fixtureCriteria, mekugiSource, base, future, fixtureVerification, fixtureControls, file, prepare, prepared, mekugiComparisonOptions, fakeOwnedDocker, retainedBytes } = await runnerFixture();

test("preflight rejects mise migration warnings even when mise exits successfully", async () => {
  const run = await prepared();
  const fake = await fakeOwnedDocker(0);
  const script = await readFile(fake.path, "utf8");
  await writeFile(fake.path, script.replace('    status=0\n    case "$name" in', `    status=0
    case "$name" in
      *-preflight-environment-current) printf '%s\\n' '[WARN] migrate: failed to remove symlink: readonly tool store' >&2 ;;`));
  await expect(preflightRun(run, fake.path)).rejects.toThrow("mise migration failed");
  const staged = (await readFile(fake.log, "utf8")).split("\n").find(line => line.startsWith("PREFLIGHT_HOME "))!.split(" ")[1]!;
  expect(await Bun.file(join(staged, ".codex/config.toml")).exists()).toBe(false);
  const state = await readState(run);
  expect(state.arm_attempts?.current).toBeUndefined();
});

test("trial CLI pins fresh pairs, alternates launches, and retains self-contained reports without inference", async () => {
  const prototype = await prepared();
  const initial = await readState(prototype);
  initial.pricing = { fetched_at: new Date().toISOString(), source: "fallback", catalog_url: "fixture", assumptions: [], warnings: [], models: {} };
  await writeState(prototype, initial);
  const fake = await fakeOwnedDocker(0.2);
  const made = await checked(["bun", join(import.meta.dir, "cli.ts"), "prepare-trials",
    "--run-dir", prototype, "--count", "2", "--order", "alternating", "--output-parent", root, "--docker-bin", fake.path]);
  const directory = made.stdout.trim();
  const set = await readTrialSet(directory);
  expect(set.status).toBe("prepared");
  expect(set.trials.map(trial => trial.order)).toEqual(["stock-first", "current-first"]);
  expect(set.controls.image_id).toBe(`sha256:${"a".repeat(64)}`);
  const first = join(directory, set.trials[0]!.run_dir);
  const second = join(directory, set.trials[1]!.run_dir);
  const firstState = await readState(first);
  const secondState = await readState(second);
  expect(firstState.runtime_tools.current_setup_installs).toBe(initial.runtime_tools.current_setup_installs);
  expect(secondState.runtime_tools.current_setup_installs).toBe(initial.runtime_tools.current_setup_installs);
  expect(await readlink(resolve(first, firstState.runtime_tools.current_setup_installs, "fixture-runner/latest"))).toBe("./1");
  expect(await readFile(resolve(first, firstState.runtime_tools.current_setup_installs, "fixture-runner/1/bin/alias"), "utf8")).toContain("exit 0");
  await expect(stat(join(first, "snapshots/current/mise/installs"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(join(second, "snapshots/current/mise/installs"))).rejects.toMatchObject({ code: "ENOENT" });
  const snapshot = initial.arms.current.home_template;
  const original = await stat(join(prototype, snapshot, ".codex/AGENTS.md"));
  expect((await stat(join(first, snapshot, ".codex/AGENTS.md"))).ino).not.toBe(original.ino);
  expect((await stat(join(first, firstState.arms.stock.repository, "internal/router/router.go"))).ino)
    .not.toBe((await stat(join(second, secondState.arms.stock.repository, "internal/router/router.go"))).ino);
  expect(await Bun.file(join(first, dirname(firstState.arms.stock.repository), "home/ubuntu/.codex/auth.json")).exists()).toBe(false);
  const auth = join(root, "trials-auth.json"); await file(auth, "{}\n", 0o600);
  await expect(main(["run-trials", "--trial-set", directory])).rejects.toThrow("confirm-paid-inference");
  const executed = await checked(["bun", join(import.meta.dir, "cli.ts"), "run-trials", "--trial-set", directory,
    "--auth-file", auth, "--docker-bin", fake.path, "--confirm-paid-inference"]);
  const markdown = executed.stdout.trim();
  expect(await readFile(markdown, "utf8")).toContain("# Repeated Codex A/B report");
  expect(await readFile(markdown, "utf8")).toContain("## Pair 2: current-first");
  expect((await readTrialSet(directory)).status).toBe("complete");
  for (const [run, leading, trailing] of [[first, "stock", "current"], [second, "current", "stock"]] as const) {
    const state = await readState(run);
    expect(Date.parse(state.results![trailing]!.started_at)).toBeGreaterThanOrEqual(Date.parse(state.results![leading]!.finished_at));
    expect(state.results![leading]!.grade?.passed).toBe(true);
  }
  const report = JSON.parse(await readFile(join(markdown, "..", "report.json"), "utf8"));
  expect(report.planned_pairs).toBe(2);
  // Fixture model output deliberately has no metered rollout history.
  expect(report.eligible_pairs).toBe(0);
  expect(report.current_minus_stock.total_tokens.difference.mean).toBeNull();
  expect(await Bun.file(join(markdown, "..", "trials/1/run.json")).exists()).toBe(true);
  expect(await Bun.file(join(markdown, "..", "trials/1/auth.json")).exists()).toBe(false);
  expect((await readState(prototype)).status).toBe("prepared");
  await expect(runTrials({ directory, authFile: auth, dockerBin: fake.path })).rejects.toThrow("never resume");
  const regenerated = await checked(["bun", join(import.meta.dir, "cli.ts"), "report-trials", "--trial-set", directory]);
  expect(regenerated.stdout.trim()).not.toBe(markdown);
  const changed = await readState(first);
  changed.execution.reasoning_effort = "xhigh";
  await writeState(first, changed);
  const frozen = await reportTrials(directory);
  expect(await readFile(frozen, "utf8")).not.toContain("trial controls or membership changed");
  const retained = JSON.parse(await readFile(join(frozen, "..", "trials/1/run.json"), "utf8"));
  expect(retained.execution.reasoning_effort).toBe("medium");
  await file(join(directory, "evidence/2/stock-changes.patch"), "changed after freezing");
  await file(join(directory, "evidence/1/report.json"), "{}");
  const excluded = await reportTrials(directory);
  expect(await readFile(excluded, "utf8")).toContain("retained bundle evidence changed");
}, 30000);

test("trial failures and cancellation retain every planned pair and never launch unstarted work", async () => {
  const prototype = await prepared();
  const state = await readState(prototype);
  state.pricing = { fetched_at: new Date().toISOString(), source: "fallback", catalog_url: "fixture", assumptions: [], warnings: [], models: {} };
  await writeState(prototype, state);
  const fake = await fakeOwnedDocker(0, true);
  const directory = await prepareTrials({ runDir: prototype, count: 2, outputParent: root, dockerBin: fake.path });
  expect((await readTrialSet(directory)).trials.every(trial => trial.order === "concurrent")).toBe(true);
  const auth = join(root, "failed-trials-auth.json"); await file(auth, "{}\n", 0o600);
  const originalManifest = bundles.writeBundleManifest;
  const frozenUnderLock: string[] = [];
  const manifestSpy = spyOn(bundles, "writeBundleManifest").mockImplementation(async destination => {
    if (destination.startsWith(`${directory}/evidence/`)) {
      const index = destination.split("/").at(-1)!;
      await expect(buildReport(join(directory, "runs", index))).rejects.toThrow("locked");
      frozenUnderLock.push(index);
    }
    await originalManifest(destination);
  });
  try {
    await expect(runTrials({ directory, authFile: auth, dockerBin: fake.path })).rejects.toThrow("trial set incomplete");
  } finally { manifestSpy.mockRestore(); }
  expect(frozenUnderLock).toEqual(["1", "2"]);
  const failed = await readTrialSet(directory);
  expect(failed.status).toBe("partial");
  expect(failed.trials.map(trial => trial.status)).toEqual(["failed", "failed"]);
  expect(await readFile(fake.log, "utf8")).not.toContain(" codex exec ");
  const canceled = await prepareTrials({ runDir: prototype, count: 2, outputParent: root, dockerBin: fake.path });
  await expect(runTrials({ directory: canceled, authFile: auth, dockerBin: fake.path, signal: AbortSignal.abort() }))
    .rejects.toThrow("trial set incomplete");
  expect((await readTrialSet(canceled)).trials.map(trial => trial.status)).toEqual(["prepared", "prepared"]);
  await expect(prepareTrials({ runDir: prototype, count: 1 })).rejects.toThrow("at least 2");
}, 30000);

test("sequential cancellation does not start the second arm", async () => {
  const run = await prepared();
  const state = await readState(run);
  state.arm_order = "stock-first";
  await writeState(run, state);
  const fake = await fakeOwnedDocker(10);
  const auth = join(root, "sequential-cancel-auth.json"); await file(auth, "{}\n", 0o600);
  const controller = new AbortController();
  const pending = runPair({ runDir: run, authFile: auth, dockerBin: fake.path, signal: controller.signal });
  const deadline = Date.now() + 10000;
  while (!(await Bun.file(fake.log).text().catch(() => "")).includes(`start --attach --interactive codex-ab-${state.id}-stock`)) {
    if (Date.now() > deadline) { controller.abort(); await pending.catch(() => {}); throw new Error("stock did not start"); }
    await Bun.sleep(20);
  }
  controller.abort();
  const result = await pending;
  expect(result.status).toBe("partial");
  expect(result.arm_attempts?.current).toBeUndefined();
  expect(result.results?.current).toBeUndefined();
  expect(await readFile(fake.log, "utf8")).not.toContain(`start --attach --interactive codex-ab-${state.id}-current`);
}, 20000);

test.each([false, true])("parallel work %s preserves task and criteria integrity", async parallelWork => {
  const original = await readFile(task, "utf8");
  const run = await prepare({ ...mekugiComparisonOptions(), parallelWork });
  const state = await readState(run);
  const prompt = await readFile(join(run, state.task.path), "utf8");
  expect(prompt.startsWith(original)).toBe(true);
  if (parallelWork) {
    expect(prompt).toContain("Use delegates for independent work in parallel.");
    expect(prompt).toContain("integrate results, and validate the complete result.");
  } else expect(prompt).toBe(original);
  expect(state.criteria!.contract.task_sha256).toBe(await sha256(join(run, state.task.path)));
  expect(await readFile(task, "utf8")).toBe(original);
  await verifyPreparedInputs(run, state);
});

test("reevaluation independently rejudges every retained arm without implementation launches or source writes", async () => {
  const revision = (await checked(["git", "-C", home, "rev-parse", "HEAD"])).stdout.trim();
  const pack = join(root, "reevaluation-pack");
  await file(join(pack, "task.md"), "Make the fixture better.\n");
  await file(join(pack, "manifest.json"), JSON.stringify({ schema: "codex-ab.task-pack.v1", id: "reevaluation-fixture", prompt: "task.md",
    source: { repository: "https://example.test/fixture.git", base_commit: base, forbidden_commit: future, reference_commit: future },
    criteria: { schema: "codex-ab.criteria.v1", criteria: [{ id: "fixture", description: "Make the fixture better." }],
      preparation: "true", existing_tests: "true", existing_test_verification: fixtureVerification, evaluator_controls: fixtureControls, qualification: "not-run" } }));
  const sourceRun = await prepare({ source, baseCommit: base, forbiddenCommit: future, taskPath: task, taskPackPath: join(pack, "manifest.json"),
    outputParent: root, currentHome: home, image: "fixture-image", cpus: "2", memory: "4g", timeoutSeconds: 30,
    comparison: "custom", arms: [{ launcher: "codex", setup_commit: "stock" }, { launcher: "mekugi", setup_commit: revision }, { launcher: "codex", setup_commit: revision }],
    mekugiSource, mekugiBinary: join(home, "go/bin/mekugi"), codexBinary: join(home, ".local/bin/codex") });
  const initial = await readState(sourceRun);
  initial.pricing = { fetched_at: "fixture", source: "fallback", catalog_url: "fixture", assumptions: [], warnings: [], models: {} };
  await writeState(sourceRun, initial);
  const auth = join(root, "reevaluation-auth.json");
  await file(auth, "{}", 0o600);
  const patch = "diff --git a/retained.txt b/retained.txt\nnew file mode 100644\n--- /dev/null\n+++ b/retained.txt\n@@ -0,0 +1 @@\n+retained implementation\n";
  const originalDocker = await fakeOwnedDocker(0, false, false, patch, false, false, undefined, undefined, 3);
  await runBenchmark({ runDir: sourceRun, authFile: auth, dockerBin: originalDocker.path });
  const original = await readState(sourceRun);
  const originalBytes = await retainedBytes(sourceRun);
  const fake = await fakeOwnedDocker(0, false, false, "", false, false, undefined, undefined, 3);
  const executed = await checked(["bun", join(import.meta.dir, "cli.ts"), "reevaluate", "--run-dir", sourceRun,
    "--output-parent", root, "--auth-file", auth, "--docker-bin", fake.path, "--confirm-paid-inference"]);
  const directory = executed.stdout.trim();
  const fresh = await readState(directory);
  const keys = Object.keys(original.arms);
  expect(fresh.id).not.toBe(original.id);
  expect(fresh.finishing?.status).toBe("complete");
  expect(fresh.selected_arms).toEqual(keys);
  expect(fresh.evaluation).toEqual({ mode: "fresh" });
  expect(fresh.judge?.passes.map(pass => pass.presentation)).toEqual([keys, [...keys].reverse()]);
  for (const key of ["source", "task", "criteria", "task_pack", "upstream_reference", "setup_revisions", "runtime_tools", "image_id", "dependency_image", "arm_configurations"] as const) {
    expect(fresh[key]).toEqual(original[key]);
  }
  for (const arm of keys) {
    expect(fresh.imported_arms?.[arm]?.source_run_id).toBe(original.id);
    const { grade: oldGrade, patch_path: oldPatch, stdout_path: oldOut, stderr_path: oldErr, ...oldMeasurement } = original.results![arm]!;
    const { grade: newGrade, patch_path: newPatch, stdout_path: newOut, stderr_path: newErr, ...newMeasurement } = fresh.results![arm]!;
    expect(newMeasurement).toEqual(oldMeasurement);
    expect(newGrade?.passed).toBe(true);
    expect(await sha256(join(directory, newPatch))).toBe(await sha256(join(sourceRun, oldPatch)));
    expect(await sha256(join(directory, newOut))).toBe(await sha256(join(sourceRun, oldOut)));
    expect(await sha256(join(directory, newErr))).toBe(await sha256(join(sourceRun, oldErr)));
    expect(await Bun.file(join(directory, "evaluator", arm, "go.mod")).exists()).toBe(true);
    expect(await readFile(join(directory, "evaluator", arm, "retained.txt"), "utf8")).toBe("retained implementation\n");
    expect(await Bun.file(join(directory, "evaluator", arm, "future.txt")).exists()).toBe(false);
    expect(await Bun.file(join(directory, fresh.arms[arm].repository, "go.mod")).exists()).toBe(false);
  }
  expect(Date.parse(fresh.judge!.started_at)).toBeGreaterThan(Date.parse(original.judge!.finished_at!));
  expect(await Bun.file(join(directory, "reports/bundle/MANIFEST.sha256")).exists()).toBe(true);
  expect((await Bun.file(join(directory, "reports/report.json")).json()).design).toContain("fresh reevaluation of retained implementations");
  expect((await readFile(join(directory, "reports/report.md"), "utf8")).includes("without rerunning implementation agents")).toBe(true);
  expect(await Bun.file(join(directory, "snapshots/current/mise/installs/fixture-runner/1/bin/project-runner")).exists()).toBe(false);
  const log = await readFile(fake.log, "utf8");
  for (const arm of keys) expect(log).not.toContain(`--name codex-ab-${fresh.id}-${arm} `);
  expect(log).not.toContain("-preflight-");
  expect(log).not.toContain("-launch-verify");
  expect(log).toContain("-semantic-");
  expect(log).toContain("-judge-");
  expect(await retainedBytes(sourceRun)).toEqual(originalBytes);

  // The ordinary launch import path must continue requiring a new implementation.
  await expect(importArms(join(root, "unused-import-target"), { ...original, evaluation: { mode: "fresh" } },
    keys.map(arm => ({ target_arm: arm, arm, run_dir: sourceRun })))).rejects.toThrow("at least one fresh arm");
  await expect(main(["reevaluate", "--run-dir", sourceRun])).rejects.toThrow("--confirm-paid-inference");
  await expect(prepareReevaluation(sourceRun, sourceRun)).rejects.toThrow("outside source run");

  const failDocker = join(root, "reevaluation-fail-docker.sh");
  await file(failDocker, `#!/bin/sh\ncase "$*" in *-grade-verify*) echo 'candidate materialization failed' >&2; exit 7 ;; esac\nexec '${fake.path}' "$@"\n`, 0o755);
  const logBeforeFailure = await readFile(fake.log, "utf8");
  const beforeFailure = new Set(await readdir(root));
  try {
    await reevaluateBenchmark({ runDir: sourceRun, outputParent: root, authFile: auth, dockerBin: failDocker });
    throw new Error("expected reevaluation failure");
  } catch (error) {
    expect(String(error)).toContain("retained ");
    expect(String(error)).toContain("candidate materialization failed");
  }
  const failedName = (await readdir(root)).find(name => name.startsWith("task-reevaluation-") && !beforeFailure.has(name));
  expect(failedName).toBeDefined();
  const failedDirectory = join(root, failedName!);
  expect((await readState(failedDirectory)).finishing?.status).toBe("complete");
  expect((await Bun.file(join(failedDirectory, "reports/bundle/report.json")).json()).finishing.status).toBe("complete");
  expect(await readFile(fake.log, "utf8")).toBe(logBeforeFailure);
  expect(await retainedBytes(sourceRun)).toEqual(originalBytes);

  // Valid seals cannot turn a partial selection or invalid publication into an eligible source.
  for (const fault of ["partial", "invalid", "unsealed"] as const) {
    if (fault === "partial") {
      const partial = structuredClone(original);
      partial.selected_arms = [keys[0]!];
      await writeState(sourceRun, partial);
      await cp(join(sourceRun, "run.json"), join(sourceRun, "reports/bundle/run.json"));
    } else if (fault === "invalid") {
      const published = await Bun.file(join(sourceRun, "reports/bundle/report.json")).json();
      published.validity = "invalid";
      await writeFile(join(sourceRun, "reports/bundle/report.json"), JSON.stringify(published));
    } else await writeState(sourceRun, { ...original, id: "changed-after-sealing" });
    if (fault !== "unsealed") await bundles.writeBundleManifest(join(sourceRun, "reports/bundle"));
    await expect(prepareReevaluation(sourceRun, root)).rejects.toThrow();
    expect(await readFile(fake.log, "utf8")).toBe(logBeforeFailure);
    // Restore fixture state and publication before the next rejection case.
    await writeState(sourceRun, original);
    await cp(join(sourceRun, "run.json"), join(sourceRun, "reports/bundle/run.json"));
    await bundles.collectBundle(sourceRun);
    await bundles.finalizeBundle(sourceRun);
  }
}, 60_000);

test("protected reevaluation publishes sealed historical isolation evidence without repeating preflight", async () => {
  const sourceRun = await prepare({ source, baseCommit: base, forbiddenCommit: future, taskPath: task, criteriaPath: fixtureCriteria,
    outputParent: root, currentHome: home, image: "fixture-image", cpus: "2", memory: "4g", timeoutSeconds: 30,
    comparison: "same-setup", protectMekugi: true, mekugiSource });
  const initial = await readState(sourceRun);
  initial.pricing = { fetched_at: "fixture", source: "fallback", catalog_url: "fixture", assumptions: [], warnings: [], models: {} };
  await writeState(sourceRun, initial);
  const auth = join(root, "protected-reevaluation-auth.json");
  await file(auth, "{}", 0o600);
  const originalDocker = await fakeOwnedDocker(0);
  await runBenchmark({ runDir: sourceRun, authFile: auth, dockerBin: originalDocker.path });
  const original = await readState(sourceRun);
  const sourceBundle = join(sourceRun, "reports/bundle");
  const preflight = await readFile(join(sourceBundle, "isolation/preflight.json"), "utf8");
  // The sealed publication, rather than adjacent mutable artifacts, owns imported evidence.
  await writeFile(join(sourceRun, "artifacts/preflight-isolation.json"), "unsealed adjacent evidence\n");
  const originalBytes = await retainedBytes(sourceRun);
  const fake = await fakeOwnedDocker(0);
  const directory = await reevaluateBenchmark({ runDir: sourceRun, outputParent: root, authFile: auth, dockerBin: fake.path });
  const fresh = await readState(directory);
  expect(fresh.finishing?.status).toBe("complete");
  expect(fresh.protected_runtime).toEqual(original.protected_runtime);
  expect(await readFile(join(directory, "artifacts/preflight-isolation.json"), "utf8")).toBe(preflight);
  const bundle = join(directory, "reports/bundle");
  expect(await readFile(join(bundle, "isolation/preflight.json"), "utf8")).toBe(preflight);
  expect((await readFile(join(directory, "reports/report.md"), "utf8")).includes("isolation preflight was not rerun")).toBe(true);
  expect(await Bun.file(join(bundle, "isolation/preflight-source.json")).json()).toEqual({
    execution: "historical", scope: "Source implementation isolation preflight; not rerun for this reevaluation.",
    source_run_id: original.id, bundle_sha256: await sha256(join(sourceBundle, "MANIFEST.sha256")),
    source_path: "isolation/preflight.json", sha256: await sha256(join(sourceBundle, "isolation/preflight.json")),
  });
  const integrity = await Bun.file(join(bundle, "final-integrity.json")).json();
  expect(integrity.passed).toBe(true);
  expect(fresh.imported_arms!.stock!.files).toContainEqual({ path: "artifacts/preflight-isolation.json", sha256: await sha256(join(sourceBundle, "isolation/preflight.json")) });
  const log = await readFile(fake.log, "utf8");
  expect(log).not.toContain("-isolation-");
  expect(log).not.toContain("-preflight-");
  for (const arm of Object.keys(fresh.arms)) expect(log).not.toContain(`--name codex-ab-${fresh.id}-${arm} `);
  expect(fresh.judge?.passes).toHaveLength(2);
  expect(await retainedBytes(sourceRun)).toEqual(originalBytes);

  // Copied controls are checked once, at their destination, before evaluator calls.
  await writeFile(join(sourceRun, original.task.path), "changed task control\n");
  await expect(reevaluateBenchmark({ runDir: sourceRun, outputParent: root, authFile: auth, dockerBin: fake.path }))
    .rejects.toThrow("copied benchmark control changed");
  expect(await readFile(fake.log, "utf8")).toBe(log);
}, 30_000);
