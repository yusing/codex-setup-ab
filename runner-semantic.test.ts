import { expect, spyOn, test } from "bun:test";
import { cp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runBenchmark } from "./workflow";
import { checked } from "./process";
import { readState, writeState, sha256 } from "./state";
import { gradeArm, runPair } from "./runner";
import { prepareSemanticAssessment } from "./semantic-assessment";
import * as containers from "./container";
import { prepareEvaluatorCache } from "./semantic";
import * as processes from "./process";
import { JUDGE_DISABLED_FEATURES } from "./judge-boundary";
import { runnerFixture } from "./test-support/runner-fixture";

const { root, source, home, task, fixtureCriteria, base, future, fixtureVerification, fixtureRepair, fixtureControls, file, prepare, prepared, brokenFirstCandidate2Check, fakeOwnedDocker } = await runnerFixture();

test("predetermined semantic criteria flow through both frozen candidates and reversed blind passes", async () => {
  const criteriaPath = join(root, "criteria.json");
  await file(criteriaPath, JSON.stringify({ schema: "codex-ab.criteria.v1", task_sha256: await sha256(task),
    criteria: [{ id: "fixture", description: "Make the fixture better." }],
    preparation: "true", existing_tests: "true", existing_test_verification: fixtureVerification, evaluator_controls: fixtureControls, qualification: "not-run" }));
  const run = await prepare({ source, baseCommit: base, forbiddenCommit: future, taskPath: task,
    criteriaPath, outputParent: root, currentHome: home, image: "fixture-image", cpus: "2", memory: "4g", timeoutSeconds: 30 });
  const state = await readState(run);
  expect(state.profile).toBe("task");
  state.pricing = { fetched_at: new Date().toISOString(), source: "fallback", catalog_url: "fixture", assumptions: [], warnings: [], models: {} };
  await writeState(run, state);
  const auth = join(root, "semantic-auth.json"); await file(auth, "{}\n", 0o600);
  const fake = await fakeOwnedDocker(0);
  await runBenchmark({ runDir: run, authFile: auth, dockerBin: fake.path });
  const done = await readState(run);
  expect(done.judge?.status).toBe("complete");
  expect(done.judge?.passes.map(pass => pass.presentation)).toEqual([["stock", "current"], ["current", "stock"]]);
  expect(done.judge?.attempts).toHaveLength(4);
  expect(done.results?.stock?.grade?.passed).toBe(true);
  expect(done.results?.current?.grade?.semantic?.["pass-2"]?.[0]?.status).toBe("pass");
  const log = await readFile(fake.log, "utf8");
  expect(log.indexOf("-current-capture")).toBeLessThan(log.indexOf("-judge-1-harness"));
  expect(log.indexOf("-stock-capture")).toBeLessThan(log.indexOf("-judge-1-harness"));
  const modelLaunches = log.split("\n").filter(line => (line.includes(" exec --json ") || line.includes(" headless --yolo ")) && !line.includes("-judge-"));
  expect(modelLaunches.every(line => line.includes(`--network codex-ab-${state.id}-provider`))).toBe(true);
  const judgeLaunches = log.split("\n").filter(line => / create (?:--rm )?--name codex-ab-.*-judge-[12]-(?:harness-1|assessment)-1 /.test(line));
  expect(judgeLaunches).toHaveLength(4);
  const firstHarnessFinish = Math.min(
    log.indexOf(`FINISH codex-ab-${state.id}-judge-1-harness-1-1`),
    log.indexOf(`FINISH codex-ab-${state.id}-judge-2-harness-1-1`),
  );
  expect(log.indexOf(`start --attach codex-ab-${state.id}-judge-1-harness-1-1`)).toBeLessThan(firstHarnessFinish);
  expect(log.indexOf(`start --attach codex-ab-${state.id}-judge-2-harness-1-1`)).toBeLessThan(firstHarnessFinish);
  expect(judgeLaunches.every(line => line.includes("--network codex-ab-") && line.includes("-judge-provider-"))).toBe(true);
  expect(modelLaunches.every(line => !line.includes("/evaluator/"))).toBe(true);
  const evaluatorLaunches = log.split("\n").filter(line => line.includes("create ") && line.includes("-semantic-"));
  expect(evaluatorLaunches.every(line => line.includes("--network none") && !line.includes("auth.json") && !line.includes("docker.sock"))).toBe(true);
  expect(evaluatorLaunches.every(line => line.includes("XDG_STATE_HOME=/tmp/state") &&
    line.includes("XDG_CONFIG_HOME=/tmp/config") && line.includes("MEKUGI_RUNTIME_DIR=/tmp/runtime"))).toBe(true);
  expect(judgeLaunches.every(line => line.includes('sandbox_mode="read-only"') && line.includes('service_tier="default"'))).toBe(true);
  for (const pass of [1, 2]) for (const stage of ["harness-1", "assessment"]) {
    const config = await readFile(join(fake.stateDir, `codex-ab-${state.id}-judge-${pass}-${stage}-1.config.toml`), "utf8");
    for (const feature of JUDGE_DISABLED_FEATURES) expect(config).toContain(`${feature} = false`);
  }
  expect(done.judge?.service_tier).toBe("default");
  expect(done.judge?.attempts?.every(attempt => attempt.service_tier === "default")).toBe(true);
  expect(evaluatorLaunches.every(line => !line.includes(":/build-cache") && !line.includes("GOCACHE=/tmp/go-build"))).toBe(true);
  expect(evaluatorLaunches.every(line => !line.includes("--read-only") && line.includes(":/candidate:ro") && line.includes(":/harness.json:ro"))).toBe(true);
  expect(evaluatorLaunches.every(line => line.includes(done.evaluator_cache_image!.image_id) && !line.includes(":/compiler-seed"))).toBe(true);
  expect(judgeLaunches.every(line => !line.includes(":/compiler-seed") && !line.includes(":/cache"))).toBe(true);
  for (const home of [...Object.values(done.arm_attempts!).map(attempt => attempt!.codex_home), ...done.judge!.usage_homes]) {
    expect(await Bun.file(join(run, home, "cache/remote_plugin_catalog/download.json")).exists()).toBe(false);
    expect(await Bun.file(join(run, home, "plugins/cache/tool.js")).text()).toBe("plugin source\n");
    expect(await Bun.file(join(run, home, "auth.json")).text()).toBe("{}\n");
  }
});
test("parallel semantic passes preserve the initiating failure", async () => {
  const run = await prepared();
  const auth = join(root, "parallel-failure-auth.json"); await file(auth, "{}\n", 0o600);
  const fake = await fakeOwnedDocker(0, false, false, "", false, false, { pass: 2, omit: "criteria" });
  await expect(runBenchmark({ runDir: run, authFile: auth, dockerBin: fake.path })).rejects.toThrow("missing per-criterion assessment");
  const failed = await readState(run);
  expect(failed.judge?.status).toBe("failed");
  expect(failed.judge?.failed_pass).toBe(2);
  expect(failed.judge?.error).toContain("missing per-criterion assessment");
  expect(failed.judge?.attempts?.find(attempt => attempt.pass === 2 && attempt.stage === "assessment")?.status).toBe("complete");
});

test("live semantic source assessments reject missing qualitative aspects", async () => {
  const run = await prepared();
  const auth = join(root, "missing-aspects-auth.json"); await file(auth, "{}\n", 0o600);
  const fake = await fakeOwnedDocker(0, false, false, "", false, false, { pass: 2, omit: "quality_aspects" });
  await expect(runBenchmark({ runDir: run, authFile: auth, dockerBin: fake.path })).rejects.toThrow("quality_aspects");
  const failed = await readState(run);
  expect(failed.judge?.status).toBe("failed");
  expect(failed.judge?.failed_pass).toBe(2);
  expect(failed.judge?.winner).toBe("none");
  expect(failed.judge?.passes.some(pass => pass.pass === 2)).toBe(false);
});
test("judge executable-check failures use operator-facing stage names", async () => {
  const run = await prepared();
  const auth = join(root, "harness-failure-auth.json");
  await file(auth, "{}\n", 0o600);
  const fake = await fakeOwnedDocker(0, false, false, "", false, false, undefined, 1);
  await expect(runBenchmark({ runDir: run, authFile: auth, dockerBin: fake.path })).rejects.toThrow("semantic judge pass 1, executable checks, round 1 failed (9)");
  expect((await readState(run)).judge?.status).toBe("failed");
});
test.each(["missing", "malformed", "symlink"])("harness plan artifacts reject %s files before checks execute", async fault => {
  const run = await prepared();
  const auth = join(root, `artifact-${fault}-auth.json`); await file(auth, "{}\n", 0o600);
  const fake = await fakeOwnedDocker(0);
  const action = fault === "missing" ? 'rm "$harness/checks.json"' : fault === "malformed"
    ? 'printf invalid > "$harness/checks.json"' : 'rm "$harness/checks.json"; ln -s outside "$harness/checks.json"';
  const script = await readFile(fake.path, "utf8");
  expect(script).toContain('> "$harness/checks.json"');
  await writeFile(fake.path, script.replace('> "$harness/checks.json"', '> "$harness/checks.json"\n        ' + action));
  await expect(runBenchmark({ runDir: run, authFile: auth, dockerBin: fake.path })).rejects.toThrow(
    fault === "missing" ? "ENOENT" : fault === "malformed" ? "invalid semantic harness plan JSON" : "ELOOP");
  expect((await readFile(fake.log, "utf8"))).not.toContain("-round-1-");
});
test("baseline compiler cache is image-pinned without a per-run cache copy", async () => {
  const run = await prepared(); const state = await readState(run);
  await file(join(run, "evaluator/stock/go.mod"), "module fixture\n");
  const result = { exitCode: 0, timedOut: false, canceled: false, elapsedMs: 1, stdout: "", stderr: "" };
  const image = `sha256:${"c".repeat(64)}`;
  let built = false;
  const warm = spyOn(processes, "exec").mockImplementation(async () =>
    ({ ...result, exitCode: built ? 0 : 1, stdout: built ? image : "", stderr: built ? "" : "No such image" }));
  const launch = spyOn(containers, "runOwnedContainer").mockImplementation(async options => {
    expect(options.createArgs).toContain("--network");
    expect(options.createArgs).toContain(state.resource_limits.memory);
    expect(options.createArgs).toContain(state.resource_limits.cpus);
    if (options.name.endsWith("-seal")) {
      expect(options.timeoutMs).toBe(60_000);
      expect(options.snapshotUser).toBe("1000:1000");
      expect(options.createArgs).toContain("0:0");
    } else {
      expect(options.timeoutMs).toBe(state.timeout_seconds * 1000);
      expect(options.createArgs.at(-1)).toContain('go test -c');
    }
    built = true;
    await options.onSnapshot?.(image);
    return { ...result, cleanupVerified: true, snapshotImageId: image };
  });
  try {
    await prepareEvaluatorCache(run, state, "unused");
    expect(state.evaluator_cache_image?.image_id).toBe(image);
    expect(await Bun.file(join(run, "evaluator/compiler-cache/go-build")).exists()).toBe(false);
    const other = structuredClone(state); delete other.evaluator_cache_image;
    const builds = launch.mock.calls.length;
    await prepareEvaluatorCache(run, other, "unused");
    expect(other.evaluator_cache_image as typeof state.evaluator_cache_image).toEqual(state.evaluator_cache_image);
    expect(launch.mock.calls).toHaveLength(builds);
    warm.mockResolvedValue({ ...result, canceled: true });
    await expect(prepareEvaluatorCache(run, state, "unused")).rejects.toThrow("warming canceled");
  } finally { warm.mockRestore(); launch.mockRestore(); }
});
test("semantic file boundaries reject unrelated changes", async () => {
  const criteriaPath = join(root, "boundary-criteria.json");
  await file(criteriaPath, JSON.stringify({ schema: "codex-ab.criteria.v1", task_sha256: await sha256(task),
    criteria: [{ id: "fixture", description: "Make the fixture better." }], allowed_paths: ["internal/router/router.go"],
    preparation: "true", existing_tests: "true", existing_test_verification: fixtureVerification, evaluator_controls: fixtureControls, qualification: "not-run" }));
  const run = await prepare({ source, baseCommit: base, forbiddenCommit: future, taskPath: task,
    criteriaPath, outputParent: root, currentHome: home, image: "fixture-image", cpus: "2", memory: "4g", timeoutSeconds: 30 });
  const state = await readState(run);
  state.results = { stock: { changed_files: ["forbidden.txt"] } as import("./types").ArmResult };
  const patch = join(root, "boundary.patch"); await file(patch, "");
  const fake = await fakeOwnedDocker(0);
  const grade = await gradeArm(fake.path, run, state, "stock", patch, new AbortController().signal);
  expect(grade?.passed).toBe(false);
  expect(grade?.preparation.exit_code).toBe(1);
  expect(grade?.preparation.stderr).toContain("forbidden.txt");
});

test("completed semantic check time and artifacts survive a later author failure", async () => {
  const criteriaPath = join(root, "timing-criteria.json");
  await file(criteriaPath, JSON.stringify({ schema: "codex-ab.criteria.v1", task_sha256: await sha256(task),
    criteria: [{ id: "fixture", description: "Make the fixture better." }],
    preparation: "true", existing_tests: "true", existing_test_verification: fixtureVerification, evaluator_controls: fixtureControls, qualification: "not-run" }));
  const run = await prepare({ source, baseCommit: base, forbiddenCommit: future, taskPath: task,
    criteriaPath, outputParent: root, currentHome: home, image: "fixture-image", cpus: "2", memory: "4g", timeoutSeconds: 30 });
  const auth = join(root, "timing-auth.json"); await file(auth, "{}\n", 0o600);
  const fake = await fakeOwnedDocker(0);
  const state = await runPair({ runDir: run, authFile: auth, dockerBin: fake.path });
  await expect(prepareSemanticAssessment({ runDir: run, state, contract: state.criteria!.contract, pass: 1,
    order: ["stock", "current"], docker: fake.path, ask: async () => { throw new Error("author unavailable"); } })).rejects.toThrow("author unavailable");
  const captured = JSON.parse(await readFile(join(run, "evaluator/semantic/pass-1/existing/candidate-1/__existing_tests/evidence.json"), "utf8"));
  const diagnostic = await Bun.file(join(run, "evaluator/semantic/pass-1/existing-command/candidate-1/__existing_test_command/evidence.json")).json();
  expect((await readState(run)).results!.stock!.grade!.elapsed_ms).toBe(captured.execution.elapsed_ms + diagnostic.execution.elapsed_ms);
  expect(captured.execution.elapsed_ms).toBeGreaterThan(0);
  expect(diagnostic.execution.elapsed_ms).toBeGreaterThan(0);
});

/** Wrap a fake Docker so candidate 2's round-1 evaluator wiring is broken in every pass. */
test("harness repair keeps a successful check when the judge resubmits it", async () => {
  const criteriaPath = join(root, "repair-criteria.json");
  await file(criteriaPath, JSON.stringify({ schema: "codex-ab.criteria.v1", task_sha256: await sha256(task),
    criteria: [{ id: "fixture", description: "Make the fixture better." }],
    preparation: "true", existing_tests: "true", existing_test_verification: fixtureVerification, evaluator_controls: fixtureControls, qualification: "not-run" }));
  const run = await prepare({ source, baseCommit: base, forbiddenCommit: future, taskPath: task,
    criteriaPath, outputParent: root, currentHome: home, image: "fixture-image", cpus: "2", memory: "4g", timeoutSeconds: 30 });
  const auth = join(root, "repair-auth.json"); await file(auth, "{}\n", 0o600);
  const fake = await fakeOwnedDocker(0);
  const state = await runPair({ runDir: run, authFile: auth, dockerBin: fake.path });
  // Only candidate 2's wiring is broken, so round 2 may repair it but not candidate 1's pass.
  const docker = await brokenFirstCandidate2Check(fake.path, "repair-docker");
  const check = { criterion: "fixture", files: [], command: ["true"], rationale: "Fixture behavior checked.", verification: fixtureVerification, repair: fixtureRepair };
  const asked: { stage: string; prompt: string; schema: any }[] = [];
  const evidence = await prepareSemanticAssessment({ runDir: run, state, contract: state.criteria!.contract, pass: 1,
    order: ["stock", "current"], docker, ask: async (stage, prompt, schema) => {
      asked.push({ stage, prompt, schema });
      return { "candidate-1": [check], "candidate-2": [check] };
    } });
  expect(asked.map(item => item.stage)).toEqual(["harness-1", "harness-2"]);
  expect(asked[1]!.prompt).toContain(`Criteria eligible for repair, by candidate: {"candidate-1":[],"candidate-2":["fixture"]}.`);
  expect(asked[1]!.schema.properties["candidate-1"].maxItems).toBe(0);
  expect(asked[1]!.schema.properties["candidate-2"].items.properties.criterion.enum).toEqual(["fixture"]);
  expect(evidence.candidates["candidate-1"][0]?.status).toBe("pass");
  expect(evidence.candidates["candidate-2"][0]?.status).toBe("pass");
  expect(evidence.history["candidate-1"].map(item => item.criterion)).toEqual(["__existing_test_command", "__existing_tests", "fixture"]);
  expect(evidence.history["candidate-2"].map(item => item.status)).toEqual(["unassessed", "pass", "unassessed", "pass"]);
});

test("prepare makes base-only independent clones and an audited secret-free snapshot", async () => {
  const run = await prepared();
  const state = await readState(run);
  expect(state.source.base_commit).toBe(base);
  expect(state.source.forbidden_commit).toBe(future);
  for (const arm of ["stock", "current"] as const) {
    const repo = join(run, state.arms[arm].repository);
    expect((await checked(["git", "-C", repo, "rev-parse", "HEAD"])).stdout.trim()).toBe(base);
    expect((await checked(["git", "-C", repo, "remote"])).stdout.trim()).toBe("");
    expect((await checked(["git", "-C", repo, "branch", "--show-current"])).stdout.trim()).toBe("work");
    expect(state.arms[arm].repository).toMatch(/^sessions\/[0-9a-f-]+\/repo$/);
    expect((await Bun.spawn(["git", "-C", repo, "cat-file", "-e", `${future}^{commit}`]).exited)).not.toBe(0);
  }
  const manifest = await readFile(join(run, state.snapshot_manifest), "utf8");
  const manifestDocument = JSON.parse(manifest) as { created_at: string };
  expect(state.current_snapshot.captured_at).toBe(manifestDocument.created_at);
  expect(state.current_snapshot.manifest_sha256).toBe((await checked(["sha256sum", join(run, state.snapshot_manifest)])).stdout.split(/\s+/)[0]);
  expect(manifest).not.toContain("auth.json");
  expect(manifest).not.toContain("history.jsonl");
  expect(manifest).not.toContain("mekugi.config.toml");
  expect(manifest).toContain(".cache/skills-mgr/remote-skills/content/current-modern/SKILL.md");
  expect(manifest).toContain(".cache/go-modern-guidelines/v0.1.1/go-modern-guidelines");
  expect(await readFile(join(run, "snapshots/current/home/ubuntu/new-guidance/committed.md"), "utf8")).toBe("automatically cloned guidance\n");
  expect(await readFile(join(run, "snapshots/current/home/ubuntu/.local/share/mise/migrations/runtime-symlink-dirs-v2"), "utf8")).toBe("ok\n");
  expect(manifest).toContain(".local/share/mise/migrations/runtime-symlink-dirs-v2");
  expect(state.runtime_tools.current_setup_installs).toBe(await realpath(join(home, ".local/share/mise/installs")));
  await expect(stat(join(run, "snapshots/current/mise/installs"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(join(run, "snapshots/current/incremental.json"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(state.runtime_tools.current_setup_mise_sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(state.runtime_tools.current_setup_files_sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(await Bun.file(resolve(run, state.runtime_tools.current_setup_installs, "fixture-runner/1/bin/project-runner")).exists()).toBe(true);
  expect(await Bun.file(join(run, state.criteria!.path)).exists()).toBe(true);
  expect(await Bun.file(join(run, state.arms.stock.repository, "criteria.json")).exists()).toBe(false);
});


test("prepare fails before creating a run when the Codex companion is missing", async () => {
  const bad = join(root, "missing-companion/bin/codex");
  await file(bad, "#!/bin/sh\necho codex-cli 0.154.0\n", 0o755);
  expect(prepare({ source, baseCommit: base, forbiddenCommit: future, taskPath: task, criteriaPath: fixtureCriteria,
    outputParent: root, currentHome: home, image: "fixture-image", cpus: "2", memory: "4g", timeoutSeconds: 30, codexBinary: bad })).rejects.toThrow();
});

test("prepare clones configuration and preserves tracked changes without a guidance allowlist", async () => {
  const currentHome = join(root, "current-without-small-task");
  await cp(home, currentHome, { recursive: true });
  await rm(join(currentHome, ".codex/SMALL-TASK.md"));
  await file(join(currentHome, ".codex/AGENTS.md"), "current uncommitted instructions\n");
  await file(join(currentHome, "new-guidance/arbitrary-name.md"), "new tracked guidance\n");
  await checked(["git", "-C", currentHome, "add", "new-guidance/arbitrary-name.md"]);
  const statusBefore = (await checked(["git", "-C", currentHome, "status", "--porcelain"])).stdout;
  const run = await prepare({ source, baseCommit: base, forbiddenCommit: future, taskPath: task, criteriaPath: fixtureCriteria,
    outputParent: root, currentHome, image: "fixture-image", cpus: "2", memory: "4g", timeoutSeconds: 30,
    codexBinary: join(currentHome, ".local/bin/codex") });
  const snapshot = join(run, "snapshots/current/home/ubuntu");
  expect(await Bun.file(join(snapshot, ".codex/SMALL-TASK.md")).exists()).toBe(false);
  expect(await readFile(join(snapshot, ".codex/AGENTS.md"), "utf8")).toBe("current uncommitted instructions\n");
  expect(await readFile(join(snapshot, "new-guidance/arbitrary-name.md"), "utf8")).toBe("new tracked guidance\n");
  expect((await checked(["git", "-C", snapshot, "remote"])).stdout.trim()).toBe("");
  expect((await checked(["git", "-C", snapshot, "rev-parse", "--is-shallow-repository"])).stdout.trim()).toBe("true");
  expect((await checked(["git", "-C", snapshot, "worktree", "list", "--porcelain"])).stdout.match(/^worktree /gm)?.length).toBe(1);
  expect(await Bun.file(join(snapshot, ".git/objects/info/alternates")).exists()).toBe(false);
  const snapshotManifest = JSON.parse(await readFile(join(run, (await readState(run)).snapshot_manifest), "utf8"));
  expect(snapshotManifest.configuration_repository.commit).toBe((await checked(["git", "-C", currentHome, "rev-parse", "HEAD"])).stdout.trim());
  expect(snapshotManifest.configuration_repository.tracked_worktree_changes).toContain(".codex/SMALL-TASK.md");
  expect((await checked(["git", "-C", currentHome, "status", "--porcelain"])).stdout).toBe(statusBefore);
  expect((await readState(run)).current_snapshot.manifest_sha256).toMatch(/^[0-9a-f]{64}$/);
});
