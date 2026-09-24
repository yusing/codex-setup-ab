import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, readlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepare, verifyPreparedInputs, verifySubmodules, initializeSubmodules, verifyRepositoryIsolation, verifyGodoxyIdentity, GODOXY_ICONS } from "./prepare";
import { finishBenchmark, runBenchmark } from "./workflow";
import { prepareTrials, readTrialSet, reportTrials, runTrials } from "./trials";
import { main, parseMekugiFlags } from "./cli";
import { checked } from "./process";
import { readState, writeState, sha256 } from "./state";
import { MEKUGI_EXPORT_SCRIPTS } from "./support/mekugi";
import { gradeArm, preflightRun, runPair } from "./runner";
import { prepareSemanticAssessment } from "./semantic-assessment";
import * as bundles from "./bundle";
import { buildReport } from "./report";
import type { PricingSnapshot } from "./usage";

let root: string;
let source: string;
let home: string;
let task: string;
let fixtureCriteria: string;
let mentorMekugiSource: string;
let base: string;
let future: string;
let codexHash: string;
let codeModeHostHash: string;

async function file(path: string, content = "fixture\n", mode?: number): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content, mode === undefined ? undefined : { mode });
}

async function fixtureHome(): Promise<string> {
  const h = join(root, "fixture-home");
  for (const name of ["config.toml", "overridden_base_instructions.md", "AGENTS.md", "LARGE-TASK.md", "SMALL-TASK.md", "IMPLEMENTATION.md", "hooks.json", "herdr-agent-state.sh"]) {
    await file(join(h, ".codex", name), name === "config.toml" ? '"model" = "gpt-6-astra"\n"model_reasoning_effort" = "medium"\n"service_tier" = "default"\n["projects"."/old"]\ntrust_level = "trusted"\n' : "fixture\n");
  }
  await file(join(h, "AGENTS.md"));
  await symlink("AGENTS.md", join(h, "linked-guidance"));
  await file(join(h, "new-guidance/committed.md"), "automatically cloned guidance\n");
  await file(join(h, ".codex/hooks/bin/session_start_context"), "#!/bin/sh\n", 0o755);
  for (const role of ["review-correctness", "review-simplify", "web-reviewer"]) {
    await file(join(h, ".codex/agents", `${role}.toml`), `name = "${role}"\ndeveloper_instructions = "original"\n`);
  }
  await file(join(h, ".codex/agents/worker.toml"));
  await file(join(h, ".codex/.tmp/bundled-marketplaces/openai-bundled/.materialization-key"));
  await file(join(h, ".agents/skills/example/SKILL.md"));
  await file(join(h, ".skills-mgr/skills/example/SKILL.md"));
  await file(join(h, ".skills-mgr/.skills-mgr.json"), JSON.stringify({ schema_revision: 3, skills: { "use-modern-go": { enabled: "lang go", remote: { name: "use-modern-go" } } } }));
  await file(join(h, ".cache/skills-mgr/remote-skills/entries/modern.json"), JSON.stringify({ name: "use-modern-go", content: "content/current-modern" }));
  await file(join(h, ".cache/skills-mgr/remote-skills/content/current-modern/scripts/VERSION"), "v0.1.1\n");
  await file(join(h, ".cache/skills-mgr/remote-skills/content/current-modern/SKILL.md"), "full remote body\n");
  await file(join(h, ".local/share/mise/migrations/runtime-symlink-dirs-v2"), "ok\n");
  await file(join(h, ".cache/go-modern-guidelines/v0.1.1/go-modern-guidelines"), "#!/bin/sh\necho guideline\n", 0o755);
  await file(join(h, ".local/share/mise/installs/go-github-com-yusing-skills-mgr/0.0.0-20260908072306-37a730da5ab5/bin/skills-mgr"), "fixture\n", 0o755);
  await file(join(h, ".local/share/mise/installs/aqua-rtk-ai-rtk/0.48.0/rtk"), "fixture\n", 0o755);
  await file(join(h, ".local/share/mise/installs/fixture-runner/1/bin/project-runner"), "#!/bin/sh\nexit 0\n", 0o755);
  await symlink("./1", join(h, ".local/share/mise/installs/fixture-runner/latest"));
  await symlink("project-runner", join(h, ".local/share/mise/installs/fixture-runner/1/bin/alias"));
  await file(join(h, ".local/bin/mise"), `#!/bin/sh
case "$*" in
  *'ls --current --missing --no-header'*) exit 0 ;;
  *'ls --current --json'*) printf '%s\\n' '{"fixture-runner":[{"version":"1","install_path":"/home/ubuntu/.local/share/mise/installs/fixture-runner/1","installed":true,"active":true}]}' ;;
  'exec -- '*) exit 2 ;;
esac
`, 0o755);
  await file(join(h, ".local/share/mise/installs/bun/1.4.2/bin/bun"), "#!/bin/sh\nprintf '1.4.2\\n'\n", 0o755);
  const codex = join(h, ".local/bin/codex");
  await file(join(h, "go/bin/mekugi"), "#!/bin/sh\nexec \"$@\"\n", 0o755);
  await file(join(h, "go/bin/shell"), "#!/bin/sh\necho 'shell: CODEX_THREAD_ID is unavailable' >&2\nexit 1\n", 0o755);
  await file(codex, "#!/bin/sh\necho codex-cli 0.154.0\n", 0o755);
  codexHash = (await checked(["sha256sum", codex])).stdout.split(/\s+/)[0]!;
  const codeModeHost = join(h, ".local/bin/codex-code-mode-host");
  await file(codeModeHost, "#!/bin/sh\nexit 0\n", 0o755);
  codeModeHostHash = (await checked(["sha256sum", codeModeHost])).stdout.split(/\s+/)[0]!;
  await file(join(h, ".codex/auth.json"), "must-not-copy\n", 0o600);
  await file(join(h, ".codex/history.jsonl"), "must-not-copy\n");
  await file(join(h, ".codex/mekugi.config.toml"), "must-not-copy\n");
  await file(join(h, ".gitignore"), ".codex/auth.json\n.codex/history.jsonl\n.codex/mekugi.config.toml\n.cache/\n.local/\n.agents/\n.codex/.tmp/\n.codex/hooks/bin/\n");
  await checked(["git", "init", h]);
  await checked(["git", "-C", h, "config", "user.email", "fixture@example.invalid"]);
  await checked(["git", "-C", h, "config", "user.name", "Fixture"]);
  await checked(["git", "-C", h, "add", "."]);
  await checked(["git", "-C", h, "commit", "-m", "configuration"]);
  return h;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "codex-ab-test-"));
  source = join(root, "source");
  await mkdir(join(source, "internal/router"), { recursive: true });
  await checked(["git", "init", source]);
  await checked(["git", "-C", source, "config", "user.email", "fixture@example.invalid"]);
  await checked(["git", "-C", source, "config", "user.name", "Fixture"]);
  await file(join(source, "go.mod"), "module fixture\n\ngo 1.26\n");
  await file(join(source, "internal/router/router.go"), "package router\n");
  await checked(["git", "-C", source, "add", "."]);
  await checked(["git", "-C", source, "commit", "-m", "base"]);
  base = (await checked(["git", "-C", source, "rev-parse", "HEAD"])).stdout.trim();
  await file(join(source, "future.txt"), "oracle that arms must not see\n");
  await checked(["git", "-C", source, "add", "."]);
  await checked(["git", "-C", source, "commit", "-m", "future"]);
  future = (await checked(["git", "-C", source, "rev-parse", "HEAD"])).stdout.trim();
  task = join(root, "task.md"); fixtureCriteria = join(root, "fixture-criteria.json");
  mentorMekugiSource = join(root, "mentor-mekugi-source");
  await mkdir(mentorMekugiSource, { recursive: true });

  await file(task, "Make the fixture better.\n");
  await file(fixtureCriteria, JSON.stringify({ schema: "codex-ab.criteria.v1", task_sha256: await sha256(task),
    criteria: [{ id: "fixture", description: "Make the fixture better." }],
    preparation: "true", existing_tests: "true", qualification: "not-run" }));
  home = await fixtureHome();
});

afterAll(async () => { await rm(root, { recursive: true, force: true }); });

async function prepared(timeoutSeconds = 30, currentLauncher: "codex" | "mekugi" = "codex", currentHome = home): Promise<string> {
  return prepare({ source, baseCommit: base, forbiddenCommit: future, taskPath: task, criteriaPath: fixtureCriteria,
    outputParent: root, currentHome, image: "fixture-image", cpus: "2", memory: "4g", timeoutSeconds,
    codexBinary: join(currentHome, ".local/bin/codex"), currentLauncher,
    mekugiBinary: currentLauncher === "mekugi" ? join(currentHome, "go/bin/mekugi") : undefined });
}

async function mentorPrepared(setup: "stock" | "current"): Promise<string> {
  return prepare({ source, baseCommit: base, forbiddenCommit: future, taskPath: task, criteriaPath: fixtureCriteria,
    outputParent: root, currentHome: home, image: "fixture-image", cpus: "2", memory: "4g", timeoutSeconds: 30,
    comparison: "mentor-handoff", mentorSetup: setup, reasoningEffort: "high", mekugiSource: mentorMekugiSource });
}

test("same-setup uses one immutable configuration for both arms and rejects drift", async () => {
  await mkdir(join(root, "capture-source"), { recursive: true });

  const run = await prepare({ source, baseCommit: base, forbiddenCommit: future, taskPath: task,
    criteriaPath: fixtureCriteria, outputParent: root, currentHome: home, image: "fixture-image",
    cpus: "2", memory: "4g", timeoutSeconds: 30, comparison: "same-setup",
    mekugiFlags: ["--mode=mekugi"], mekugiSource: join(root, "capture-source") });
  expect(await readlink(join(run, "snapshots/current/home/ubuntu/linked-guidance"))).toBe("AGENTS.md");
  const state = await readState(run);
  expect(state.operator).toEqual({ uid: 1000, gid: 1000 });
  expect(state.execution.current_launcher).toBe("mekugi");
  expect(state.arms.stock.home_template).toBe(state.arms.current.home_template);
  expect(state.mekugi_flags).toEqual(["--mode=mekugi"]);
  await verifyPreparedInputs(run, state);
  const auth = join(root, "same-setup-auth.json");
  await file(auth, "{}\n", 0o600);
  const fake = await fakeOwnedDocker(0);
  expect((await runPair({ runDir: run, authFile: auth, dockerBin: fake.path })).status).toBe("complete");
  const launches = (await readFile(fake.log, "utf8")).split("\n").filter(line => line.includes(" exec --json "));
  expect(launches).toHaveLength(2);
  expect(launches.some(line => line.includes(" mise exec -- codex exec "))).toBe(true);
  expect(launches.some(line => line.includes(" mise exec -- mekugi --mode=mekugi --capture-output=/mekugi-exports/capture.jsonl --metrics-output=/mekugi-exports/metrics.json codex exec "))).toBe(true);
  expect(launches.every(line => line.includes(`${state.runtime_tools.current_setup_installs}:/home/ubuntu/.local/share/mise/installs:ro`))).toBe(true);
  expect(await readlink(join(run, "arms/current/home/ubuntu/linked-guidance"))).toBe("AGENTS.md");
  await file(join(run, "reports/report.json"), "{}");
  await file(join(run, "reports/report.md"), "fixture report");
  await file(join(run, state.mekugi_exports!.capture), "retained capture");
  await file(join(run, state.mekugi_exports!.metrics), "{}");
  await bundles.collectBundle(run);
  expect(await Bun.file(join(run, "reports/bundle/mekugi-capture.jsonl")).exists()).toBe(true);
  await rm(join(run, state.mekugi_exports!.capture));
  await bundles.collectBundle(run);
  expect(await Bun.file(join(run, "reports/bundle/mekugi-capture.jsonl")).exists()).toBe(false);
  await file(join(run, "snapshots/stock/home/ubuntu/AGENTS.md"), "unexpected judge guidance\n");
  await expect(verifyPreparedInputs(run, state)).rejects.toThrow("stock setup snapshot changed");
  await rm(join(run, "snapshots/stock/home/ubuntu/AGENTS.md"));
  state.arms.stock.home_template = "snapshots/stock/home/ubuntu";
  await expect(verifyPreparedInputs(run, state)).rejects.toThrow("identity changed");
  const adaptedConfig = Bun.TOML.parse(await readFile(join(run, "snapshots/current/home/ubuntu/.codex/config.toml"), "utf8")) as Record<string, unknown>;
  expect(adaptedConfig.projects).toEqual({ "/workspace": { trust_level: "trusted" } });
});

test("stock-mekugi isolates the launcher without current-home guidance", async () => {
  const captureSource = join(root, "stock-mekugi-capture-source");
  await mkdir(captureSource, { recursive: true });

  const run = await prepare({ source, baseCommit: base, forbiddenCommit: future, taskPath: task,
    criteriaPath: fixtureCriteria, outputParent: root, currentHome: home, image: "fixture-image",
    cpus: "2", memory: "4g", timeoutSeconds: 30, comparison: "stock-mekugi",
    mekugiFlags: ["--mode=mekugi"], mekugiSource: captureSource });
  const state = await readState(run);
  expect(state.execution).toMatchObject({ current_launcher: "mekugi", service_tier: "default" });
  expect(state.arms.stock.home_template).toBe("snapshots/stock/home/ubuntu");
  expect(state.arms.current.home_template).toBe("snapshots/stock-mekugi/home/ubuntu");
  expect(state.runtime_tools.current_setup_installs).toBe("snapshots/current/mise/installs");
  expect((await stat(join(run, state.runtime_tools.current_setup_installs))).isDirectory()).toBe(true);
  await expect(stat(join(run, state.runtime_tools.current_setup_installs, "fixture-runner"))).rejects.toMatchObject({ code: "ENOENT" });
  await verifyPreparedInputs(run, state);

  const auth = join(root, "stock-mekugi-auth.json");
  await file(auth, "{}\n", 0o600);
  const fake = await fakeOwnedDocker(0);
  expect((await runPair({ runDir: run, authFile: auth, dockerBin: fake.path })).status).toBe("complete");
  const launches = (await readFile(fake.log, "utf8")).split("\n").filter(line => line.includes(" exec --json "));
  expect(launches).toHaveLength(2);
  expect(launches.some(line => line.includes(" codex exec --json ") && !line.includes(" mekugi "))).toBe(true);
  expect(launches.some(line => line.includes(" mekugi --mode=mekugi --capture-output=/mekugi-exports/capture.jsonl --metrics-output=/mekugi-exports/metrics.json codex exec --json "))).toBe(true);
  expect(launches.every(line => !line.includes(" mise exec ") && !line.includes("/home/ubuntu/.local/share/mise/installs:ro"))).toBe(true);
  await expect(prepare({ source, baseCommit: base, forbiddenCommit: future, taskPath: task,
    criteriaPath: fixtureCriteria, outputParent: root, currentHome: home, image: "fixture-image",
    cpus: "2", memory: "4g", timeoutSeconds: 30, comparison: "stock-mekugi",
    reviewTreatment: join(root, "unused-treatment"), mekugiSource: captureSource })).rejects.toThrow("does not accept");
});

test("stock-mekugi accepts an explicit Sol/high pair without mentor handoff", async () => {
  const captureSource = join(root, "sol-stock-mekugi-capture-source");
  await mkdir(captureSource, { recursive: true });
  const run = await prepare({ source, baseCommit: base, forbiddenCommit: future, taskPath: task,
    criteriaPath: fixtureCriteria, outputParent: root, currentHome: home, image: "fixture-image",
    cpus: "2", memory: "4g", timeoutSeconds: 30, comparison: "stock-mekugi",
    model: "gpt-6-sol", reasoningEffort: "high", mekugiSource: captureSource });
  const state = await readState(run);
  expect(state.execution).toMatchObject({ model: "gpt-6-sol", reasoning_effort: "high", current_launcher: "mekugi" });
  expect(state.mentor).toBeUndefined();
  for (const template of [state.arms.stock.home_template, state.arms.current.home_template]) {
    const config = await readFile(join(run, template, ".codex/config.toml"), "utf8");
    expect(config).toContain('model = "gpt-6-sol"');
    expect(config).toContain('model_reasoning_effort = "high"');
  }
  await verifyPreparedInputs(run, state);
  await expect(prepare({ source, baseCommit: base, forbiddenCommit: future, taskPath: task,
    criteriaPath: fixtureCriteria, outputParent: root, currentHome: home, image: "fixture-image",
    cpus: "2", memory: "4g", timeoutSeconds: 30, comparison: "stock-mekugi",
    model: "grok:grok-4.6", mekugiSource: captureSource })).rejects.toThrow("unsupported benchmark model");
});

for (const setup of ["stock", "current"] as const) {
  test(`mentor-handoff uses the same ${setup} setup and launches Mekugi mentor-off/on with dual exports`, async () => {
    const run = await mentorPrepared(setup);
    const state = await readState(run);
    const selectedHome = setup === "stock" ? "snapshots/stock-mekugi/home/ubuntu" : "snapshots/current/home/ubuntu";
    expect(state.comparison).toBe("mentor-handoff");
    expect(state.mentor).toMatchObject({ setup, child_model: "gpt-6-luna", child_effort: "medium" });
    expect(state.execution).toMatchObject({ model: "gpt-6-sol", reasoning_effort: "high", current_launcher: "mekugi" });
    expect(state.arms.stock.home_template).toBe(selectedHome);
    expect(state.arms.current.home_template).toBe(selectedHome);
    expect(state.mekugi_exports).toBeUndefined();
    expect(state.mekugi_exports_by_arm?.stock).toMatchObject({
      capture: "artifacts/stock/mekugi/capture.jsonl", metrics: "artifacts/stock/mekugi/metrics.json",
    });
    expect(state.mekugi_exports_by_arm?.current).toMatchObject({
      capture: "artifacts/current/mekugi/capture.jsonl", metrics: "artifacts/current/mekugi/metrics.json",
    });
    expect(state.mentor?.parent_prompt.path).toBe("control/mentor-parent.md");
    expect(state.mentor?.child_config.path).toBe("control/mentor-child.toml");
    const parent = await readFile(join(run, state.mentor!.parent_prompt.path), "utf8");
    const child = await readFile(join(run, state.mentor!.child_config.path), "utf8");
    expect(parent).toContain("Spawn exactly one subagent");
    expect(child).toContain('model = "gpt-6-luna"');
    expect(child).toContain('model_reasoning_effort = "medium"');
    await verifyPreparedInputs(run, state);

    const auth = join(root, `mentor-${setup}-auth.json`);
    await file(auth, "{}\n", 0o600);
    const fake = await fakeOwnedDocker(0);
    expect((await runPair({ runDir: run, authFile: auth, dockerBin: fake.path })).status).toBe("complete");
    const creates = (await readFile(fake.log, "utf8")).split("\n")
      .filter(line => / create --rm --name codex-ab-.*-(?:stock|current) --label /.test(line));
    expect(creates).toHaveLength(2);
    const stock = creates.find(line => line.includes(`codex-ab-${state.id}-stock --label`))!;
    const current = creates.find(line => line.includes(`codex-ab-${state.id}-current --label`))!;
    expect(stock).toContain("mekugi --main-mentor-handoff=false --mentor-handoff=false --capture-output=/mekugi-exports/capture.jsonl --metrics-output=/mekugi-exports/metrics.json codex exec --json");
    expect(current).toContain("mekugi --main-mentor-handoff=false --mentor-handoff=true --capture-output=/mekugi-exports/capture.jsonl --metrics-output=/mekugi-exports/metrics.json codex exec --json");
    expect(stock).toContain(`${join(run, "artifacts/stock/mekugi")}:/mekugi-exports`);
    expect(current).toContain(`${join(run, "artifacts/current/mekugi")}:/mekugi-exports`);
    expect(stock).toContain('agents.benchmark_worker.config_file="/benchmark-control/mentor-child.toml"');
    expect(current).toContain('model_instructions_file="/benchmark-control/mentor-parent.md"');
    expect(stock).toContain("--model gpt-6-sol");
    expect(current).toContain('model_reasoning_effort="high"');
    if (setup === "current") {
      expect(stock).toContain("mise exec -- mekugi");
      expect(current).toContain("mise exec -- mekugi");
    } else {
      expect(stock).not.toContain("mise exec -- mekugi");
      expect(current).not.toContain("mise exec -- mekugi");
    }
    await file(join(run, "reports/report.json"), "{}\n");
    await file(join(run, "reports/report.md"), "fixture report\n");
    await bundles.collectBundle(run);
    expect(await readFile(join(run, "reports/bundle/analyze_capture.py"), "utf8")).toBe(MEKUGI_EXPORT_SCRIPTS["analyze_capture.py"]);
    expect(await readFile(join(run, "reports/bundle/benchmark_jsonl.py"), "utf8")).toBe(MEKUGI_EXPORT_SCRIPTS["benchmark_jsonl.py"]);
  }, 30_000);
}

test("mentor-handoff rejects prepared matrix identity drift", async () => {
  const run = await mentorPrepared("current");
  const original = await readState(run);
  await verifyPreparedInputs(run, original);
  const tamperers: Array<(state: typeof original) => void> = [
    state => { state.mentor!.setup = "stock"; },
    state => { state.arms.stock.home_template = "snapshots/stock/home/ubuntu"; },
    state => { state.arms.current.home_template = "snapshots/stock/home/ubuntu"; },
    state => { state.execution.current_launcher = "codex"; },
    state => { state.execution.model = "gpt-6-astra"; },
    state => { state.execution.reasoning_effort = "medium"; },
    state => { state.mentor!.child_model = "gpt-6-sol" as never; },
    state => { state.mentor!.child_effort = "high" as never; },
    state => { state.mekugi_exports_by_arm!.stock = undefined; },
    state => { state.mekugi_exports_by_arm!.current = undefined; },
    state => { state.mekugi_exports_by_arm!.current!.capture = "artifacts/stock/mekugi/capture.jsonl"; },
    state => { state.mekugi_exports_by_arm!.current!.metrics = "artifacts/stock/mekugi/metrics.json"; },
  ];
  for (const tamper of tamperers) {
    const changed = structuredClone(original);
    tamper(changed);
    await expect(verifyPreparedInputs(run, changed)).rejects.toThrow("mentor matrix identity changed");
  }
});

test("mentor-handoff task and handoff controls are checked before Docker is invoked", async () => {
  const paths = ["control/task.md", "control/mentor-parent.md", "control/mentor-child.toml"];
  for (const path of paths) {
    const run = await mentorPrepared("stock");
    await file(join(run, path), "tampered task control\n");
    const fake = await fakeOwnedDocker(0);
    await expect(preflightRun(run, fake.path)).rejects.toThrow(path === "control/mentor-parent.md" || path === "control/mentor-child.toml"
      ? "mentor control changed" : "copied benchmark control changed");
    expect(await Bun.file(fake.log).exists()).toBe(false);
  }
}, 30_000);

for (const comparison of ["stock-current", "same-setup"] as const) {
  for (const cachePresent of [false, true]) {
    test(`${comparison} prepares with bundled marketplace cache ${cachePresent ? "present" : "absent"}`, async () => {
      const isolatedHome = await mkdtemp(join(root, "marketplace-home-"));
      await cp(home, isolatedHome, { recursive: true });
      const marketplace = ".codex/.tmp/bundled-marketplaces/openai-bundled";
      if (!cachePresent) await rm(join(isolatedHome, marketplace), { recursive: true });
      const captureSource = join(root, "marketplace-capture-source");
      await mkdir(captureSource, { recursive: true });

      const run = await prepare({ source, baseCommit: base, forbiddenCommit: future, taskPath: task,
        criteriaPath: fixtureCriteria, outputParent: root, currentHome: isolatedHome, image: "fixture-image",
        cpus: "2", memory: "4g", timeoutSeconds: 30, comparison, mekugiSource: captureSource });
      const marker = join(run, "snapshots/current/home/ubuntu", marketplace, ".materialization-key");
      expect(await Bun.file(marker).exists()).toBe(cachePresent);
      if (cachePresent) expect(await readFile(marker, "utf8")).toBe("fixture\n");
      await verifyPreparedInputs(run, await readState(run));
    });
  }
}

test("stock-mekugi does not require unused current-home runtime supplements", async () => {
  const isolatedHome = join(root, "stock-mekugi-minimal-home");
  await cp(home, isolatedHome, { recursive: true });
  await rm(join(isolatedHome, ".codex/.tmp/bundled-marketplaces/openai-bundled"), { recursive: true });

  await rm(join(isolatedHome, ".local/bin/mise"));
  await writeFile(join(isolatedHome, ".codex/config.toml"), 'model = "some-other-model"\nmodel_reasoning_effort = "xhigh"\nservice_tier = "default"\n');
  const captureSource = join(root, "stock-mekugi-minimal-capture-source");
  await mkdir(captureSource, { recursive: true });

  const run = await prepare({ source, baseCommit: base, forbiddenCommit: future, taskPath: task,
    criteriaPath: fixtureCriteria, outputParent: root, currentHome: isolatedHome, image: "fixture-image",
    cpus: "2", memory: "4g", timeoutSeconds: 30, comparison: "stock-mekugi",
    mekugiFlags: ["--mode=mekugi"], mekugiSource: captureSource });
  await verifyPreparedInputs(run, await readState(run));
});
for (const projectConfig of [
  'projects = { "/old" = { trust_level = "trusted" } }\n',
  'projects."/old".trust_level = "trusted"\n',
  '["projects"."/old"]\ntrust_level = "trusted"\n',
]) {
  test(`trust adaptation preserves multiline strings with ${projectConfig.trim()}`, async () => {
    const configHome = await mkdtemp(join(root, "config-home-"));
    await cp(home, configHome, { recursive: true });
    const config = 'model = "gpt-6-astra"\nmodel_reasoning_effort = "medium"\nservice_tier = "default"\ndeveloper_instructions = """\n[projects.example]\nKeep this text.\n"""\n' + projectConfig;
    await file(join(configHome, ".codex/config.toml"), config);
    const run = await prepare({ source, baseCommit: base, forbiddenCommit: future, taskPath: task,
      criteriaPath: fixtureCriteria, outputParent: root, currentHome: configHome, image: "fixture-image",
      cpus: "2", memory: "4g", timeoutSeconds: 30 });
    const adapted = Bun.TOML.parse(await readFile(join(run, "snapshots/current/home/ubuntu/.codex/config.toml"), "utf8"));
    expect(adapted).toEqual({ ...Bun.TOML.parse(config), projects: { "/workspace": { trust_level: "trusted" } } });
    await verifyPreparedInputs(run, await readState(run));
  });
}

test("current snapshot overlays exact tracked worktree state across renames, index deletions, and path type changes", async () => {
  const overlayHome = join(root, "overlay-home");
  await cp(home, overlayHome, { recursive: true });
  await checked(["git", "-C", overlayHome, "mv", "AGENTS.md", "RENAMED.md"]);
  await rm(join(overlayHome, ".codex/agents"), { recursive: true });
  await file(join(overlayHome, ".codex/agents"), "roles intentionally replaced\n");
  await checked(["git", "-C", overlayHome, "add", "-A"]);
  await checked(["git", "-C", overlayHome, "rm", "--cached", "new-guidance/committed.md"]);

  await rm(join(overlayHome, "RENAMED.md"));
  await file(join(overlayHome, "RENAMED.md/private.txt"), "must not enter snapshot\n");
  const captureSource = join(root, "overlay-capture-source");
  await mkdir(captureSource, { recursive: true });

  const run = await prepare({ source, baseCommit: base, forbiddenCommit: future, taskPath: task,
    criteriaPath: fixtureCriteria, outputParent: root, currentHome: overlayHome, image: "fixture-image",
    cpus: "2", memory: "4g", timeoutSeconds: 30, comparison: "stock-mekugi",
    mekugiFlags: ["--mode=mekugi"], mekugiSource: captureSource });
  const snapshot = join(run, "snapshots/current/home/ubuntu");
  expect(await Bun.file(join(snapshot, "AGENTS.md")).exists()).toBe(false);
  expect(await Bun.file(join(snapshot, "RENAMED.md/private.txt")).exists()).toBe(false);
  await expect(stat(join(snapshot, "RENAMED.md"))).rejects.toThrow();
  expect(await Bun.file(join(snapshot, "new-guidance/committed.md")).exists()).toBe(false);
  expect((await stat(join(snapshot, ".codex/agents"))).isFile()).toBe(true);
  await verifyPreparedInputs(run, await readState(run));
});



test("codex-mekugi-grok isolates Codex+Mekugi from the Grok CLI", async () => {
  const captureSource = join(root, "grok-capture-source");
  await mkdir(captureSource, { recursive: true });

  const grokBin = join(root, "grok-bin");
  await file(grokBin, "#!/bin/sh\necho grok 1.0.30\n", 0o755);
  const grokAuth = join(root, "grok-auth.json");
  await file(grokAuth, "{}\n", 0o600);
  const run = await prepare({ source, baseCommit: base, forbiddenCommit: future, taskPath: task,
    criteriaPath: fixtureCriteria, outputParent: root, currentHome: home, image: "fixture-image",
    cpus: "2", memory: "4g", timeoutSeconds: 30, comparison: "codex-mekugi-grok",
    mekugiFlags: ["--mode=mekugi", "--grok"], mekugiSource: captureSource, grokBinary: grokBin });
  const state = await readState(run);
  expect(state.execution).toMatchObject({ current_launcher: "grok", model: "grok:grok-4.6", service_tier: "default" });
  expect(state.arms.stock.home_template).toBe("snapshots/stock-mekugi/home/ubuntu");
  expect(state.arms.current.home_template).toBe("snapshots/stock-grok/home/ubuntu");
  expect(state.runtime_tools.current_setup_installs).toBe("snapshots/current/mise/installs");
  expect((await stat(join(run, state.runtime_tools.current_setup_installs))).isDirectory()).toBe(true);
  await expect(stat(join(run, state.runtime_tools.current_setup_installs, "fixture-runner"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(join(run, "snapshots/current/incremental.json"))).rejects.toMatchObject({ code: "ENOENT" });
  await verifyPreparedInputs(run, state);

  const auth = join(root, "codex-mekugi-grok-auth.json");
  await file(auth, "{}\n", 0o600);
  state.pricing = { fetched_at: new Date().toISOString(), source: "fallback", catalog_url: "fixture", assumptions: [], warnings: [], models: {} };
  await writeState(run, state);
  const fake = await fakeOwnedDocker(0);
  const trials = await prepareTrials({ runDir: run, count: 2, outputParent: root, dockerBin: fake.path });
  await checked(["bun", join(import.meta.dir, "cli.ts"), "run-trials", "--trial-set", trials,
    "--auth-file", auth, "--grok-auth-file", grokAuth, "--docker-bin", fake.path, "--confirm-paid-inference"]);
  expect((await readTrialSet(trials)).status).toBe("complete");

  await runBenchmark({ runDir: run, authFile: auth, grokAuthFile: grokAuth, dockerBin: fake.path });
  expect((await readState(run)).status).toBe("complete");
  const launches = (await readFile(fake.log, "utf8")).split("\n").filter(line => line.includes(" exec --json ") || line.includes(" grok --prompt-file "));
  expect(launches.some(line => line.includes(" mekugi --mode=mekugi --grok --capture-output=/mekugi-exports/capture.jsonl --metrics-output=/mekugi-exports/metrics.json codex exec --json ") && line.includes(" --model grok:grok-4.6 "))).toBe(true);
  expect(launches.some(line => line.includes(" grok --prompt-file /control/task.md --cwd /workspace -m grok-4.6 ") && line.includes("GROK_HOME=/home/ubuntu/.grok"))).toBe(true);
  expect(launches.every(line => !line.includes(" mise exec "))).toBe(true);
  const comparison = JSON.parse(await readFile(join(run, "reports/bundle/setup-comparison.json"), "utf8"));
  expect(comparison.stock).toContain("Mekugi");
  expect(comparison.current).toContain("Grok CLI");
  expect(comparison.current).not.toContain("Audited current-home");
}, 60_000);

test("protected runtime snapshots owner scripts without changing the direct arm", async () => {
  const owner = join(root, "isolation-owner");
  await mkdir(owner, { recursive: true });
  const run = await prepare({ source, baseCommit: base, forbiddenCommit: future, taskPath: task,
    criteriaPath: fixtureCriteria, outputParent: root, currentHome: home, image: "fixture-image",
    cpus: "2", memory: "4g", timeoutSeconds: 30, comparison: "same-setup",
    protectMekugi: true, mekugiSource: owner });
  const state = await readState(run);
  expect(state.protected_runtime?.boundary).toBe("direct-egress-vs-router-only");
  expect(state.protected_runtime?.scripts).toHaveLength(3);
  expect(state.execution.current_launcher).toBe("mekugi");
  expect(state.arms.stock.home_template).toBe(state.arms.current.home_template);
  await verifyPreparedInputs(run, state);
  const auth = join(root, "protected-auth.json");
  await file(auth, "{}\n", 0o600);
  const fake = await fakeOwnedDocker(0);
  const wrong = await fakeOwnedDocker(0, false, false, "", true);
  await expect(preflightRun(run, wrong.path)).rejects.toThrow("container Codex hash differs from prepared source");
  await runPair({ runDir: run, authFile: auth, dockerBin: fake.path });
  const launches = (await readFile(fake.log, "utf8")).split("\n").filter(line => line.includes(" exec --json "));
  expect(launches.find(line => line.includes(" mise exec -- codex exec "))!).not.toContain("--cap-add");
  expect(launches.find(line => line.includes(" mise exec -- mekugi "))!).toContain("--cap-add SYS_ADMIN");
  expect(launches.find(line => line.includes(" mise exec -- mekugi "))!).toContain("/usr/local/libexec/mekugi-agent-check.py:ro");
  await file(join(run, state.protected_runtime!.scripts[0]!.path), "changed");
  await expect(verifyPreparedInputs(run, state)).rejects.toThrow("isolation script changed");
});

test("Mekugi build inputs are pinned, bundled and independent of the live checkout", async () => {
  const build = join(root, "mekugi-build");
  const context = join(root, "build-context");
  await file(join(context, "dirty-guidance.md"), "uncommitted compiled guidance\n");
  await mkdir(build);
  await checked(["tar", "-cf", join(build, "source.tar"), "-C", context, "."]);
  await file(join(build, "build_inputs.py"), "# archive owner\n");
  await file(join(build, "bin/mekugi"), "#!/bin/sh\nexec \"$@\"\n", 0o755);
  await file(join(build, "bin/shell"), "#!/bin/sh\nexit 1\n", 0o755);
  for (const name of ["build.stdout", "build.stderr", "build-result.json"]) await file(join(build, name), "fixture\n");
  await file(join(build, "build.json"), JSON.stringify({ schema: "codex-ab.mekugi-build.v1",
    image_id: `sha256:${"a".repeat(64)}`, source_archive_sha256: await sha256(join(build, "source.tar")),
    archiver_sha256: await sha256(join(build, "build_inputs.py")), command: ["go", "build"],
    binaries: { mekugi: await sha256(join(build, "bin/mekugi")), shell: await sha256(join(build, "bin/shell")) } }));
  const buildOptions = { source, baseCommit: base, forbiddenCommit: future, taskPath: task,
    criteriaPath: fixtureCriteria, outputParent: root, currentHome: home, image: "fixture-image",
    cpus: "2", memory: "4g", timeoutSeconds: 30, comparison: "same-setup" as const, mekugiBuild: build };
  const mutateCodex = join(root, "mutate-build/codex");
  await file(mutateCodex, `#!/bin/sh\nprintf '%s' changed > '${join(build, "build_inputs.py")}'\necho codex-cli 0.154.0\n`, 0o755);
  await cp(join(home, ".local/bin/codex-code-mode-host"), join(root, "mutate-build/codex-code-mode-host"));
  await expect(prepare({ ...buildOptions, codexBinary: mutateCodex })).rejects.toThrow("build inputs changed");
  await file(join(build, "build_inputs.py"), "# archive owner\n");
  const run = await prepare({ source, baseCommit: base, forbiddenCommit: future, taskPath: task,
    criteriaPath: fixtureCriteria, outputParent: root, currentHome: home, image: "fixture-image",
    cpus: "2", memory: "4g", timeoutSeconds: 30, comparison: "same-setup", mekugiBuild: build });
  const state = await readState(run);
  expect(state.mekugi_build?.files).toHaveLength(6);
  expect(await readFile(join(run, "artifacts/mekugi-build/source/dirty-guidance.md"), "utf8")).toContain("uncommitted");
  const grok = join(root, "build-grok");
  await file(grok, "#!/bin/sh\necho grok 1.0.30\n", 0o755);
  const grokRun = await prepare({ ...buildOptions, comparison: "codex-mekugi-grok",
    mekugiFlags: ["--grok"], grokBinary: grok });
  expect((await readState(grokRun)).execution.current_launcher).toBe("grok");
  await rm(build, { recursive: true });
  await rm(context, { recursive: true });
  await verifyPreparedInputs(run, state);
  state.pricing = { fetched_at: new Date().toISOString(), source: "fallback", catalog_url: "fixture", assumptions: [], warnings: [], models: {} };
  await writeState(run, state);
  const fake = await fakeOwnedDocker(0);
  const trials = await prepareTrials({ runDir: run, count: 2, outputParent: root, dockerBin: fake.path });
  for (const trial of (await readTrialSet(trials)).trials) {
    const copy = join(trials, trial.run_dir);
    await verifyPreparedInputs(copy, await readState(copy));
    expect(await Bun.file(join(copy, "artifacts/mekugi-build/source/dirty-guidance.md")).exists()).toBe(false);
    for (const file of state.mekugi_build!.files) expect(await sha256(join(copy, file.path))).toBe(file.sha256);
  }
  expect(await Bun.file(join(run, "artifacts/mekugi-build/source/dirty-guidance.md")).exists()).toBe(true);
  await file(join(run, "reports/report.json"), "{}");
  await file(join(run, "reports/report.md"), "fixture report");
  await bundles.collectBundle(run);
  expect(await sha256(join(run, "reports/bundle/mekugi-build/source.tar"))).toBe(state.mekugi_build!.identity.source_archive_sha256);
  await file(join(run, "artifacts/mekugi-build/source.tar"), "changed");
  await expect(verifyPreparedInputs(run, state)).rejects.toThrow("build input changed");
});

test("Mekugi argument arrays cannot redirect benchmark-owned exports", () => {
  expect(parseMekugiFlags('["--mode=mekugi"]')).toEqual(["--mode=mekugi"]);
  for (const value of ['["codex"]', '["--capture-output=/tmp/elsewhere"]', '["--config=other"]', '{}', '[3]']) {
    expect(() => parseMekugiFlags(value)).toThrow();
  }
});

test("task-pack CLI freezes pinned controls without exposing checks to either arm", async () => {
  const directory = join(root, "portable-pack");
  await file(join(directory, "task.md"), "Improve the fixture.\n");
  await file(join(directory, "manifest.json"), JSON.stringify({
    schema: "codex-ab.task-pack.v1", id: "fixture-pack", prompt: "task.md",
    source: { repository: "https://example.test/fixture.git", base_commit: base, forbidden_commit: future },
    criteria: { schema: "codex-ab.criteria.v1", criteria: [{ id: "fixture", description: "Improve the fixture" }],
      preparation: "true", existing_tests: "true", qualification: "not-run" },
  }));
  let stdout = "";
  const capture = spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stdout += chunk.toString(); return true;
  }) as typeof process.stdout.write);
  try {
    expect(await main(["prepare", "--task-pack", join(directory, "manifest.json"), "--source", source,
      "--current-home", home, "--codex-bin", join(home, ".local/bin/codex"), "--output-parent", root])).toBe(0);
  } finally { capture.mockRestore(); }
  const run = stdout.trim();
  const state = await readState(run);
  expect(state.source.base_commit).toBe(base);
  expect(state.source.forbidden_commit).toBe(future);
  expect(state.profile).toBe("task");
  expect(state.task_pack?.id).toBe("fixture-pack");
  for (const arm of ["stock", "current"] as const) {
    expect(await Bun.file(join(run, state.arms[arm].repository, "manifest.json")).exists()).toBe(false);
  }
  await verifyPreparedInputs(run, state);
  state.pricing = { fetched_at: new Date().toISOString(), source: "fallback", catalog_url: "fixture", assumptions: [], warnings: [], models: {} };
  await writeState(run, state);
  const auth = join(root, "pack-auth.json"); await file(auth, "{}\n", 0o600);
  const fake = await fakeOwnedDocker(0);
  await runBenchmark({ runDir: run, authFile: auth, dockerBin: fake.path });
  expect(await sha256(join(run, "reports/bundle/task-pack.json"))).toBe(state.task_pack!.sha256);
  expect(await readFile(join(run, "reports/report.md"), "utf8")).toContain("Task pack: fixture-pack");
  await file(join(run, state.task_pack!.path), "{}");
  await expect(verifyPreparedInputs(run, state)).rejects.toThrow("control changed");
  await expect(main(["prepare", "--task-pack", join(directory, "manifest.json")])).rejects.toThrow("requires --source");
  await expect(main(["prepare", "--task-pack", join(directory, "manifest.json"), "--source", source, "--base", base])).rejects.toThrow("cannot override");
});

test("predetermined semantic criteria flow through both frozen candidates and reversed blind passes", async () => {
  const criteriaPath = join(root, "criteria.json");
  await file(criteriaPath, JSON.stringify({ schema: "codex-ab.criteria.v1", task_sha256: await sha256(task),
    criteria: [{ id: "fixture", description: "Make the fixture better." }],
    preparation: "true", existing_tests: "true", qualification: "not-run" }));
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
  const modelLaunches = log.split("\n").filter(line => line.includes(" exec --json ") && !line.includes("-judge-"));
  expect(modelLaunches.every(line => line.includes(`--network codex-ab-${state.id}-provider`))).toBe(true);
  const judgeLaunches = log.split("\n").filter(line => / create --rm --name codex-ab-.*-judge-[12]-(?:harness-1|assessment)-1 /.test(line));
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
  expect(judgeLaunches.every(line => line.includes('sandbox_mode="danger-full-access"') && !line.includes('service_tier="fast"'))).toBe(true);
});
test("parallel semantic passes preserve the initiating failure", async () => {
  const run = await prepared();
  const state = await readState(run);
  state.pricing = { fetched_at: new Date().toISOString(), source: "fallback", catalog_url: "fixture", assumptions: [], warnings: [], models: {} };
  await writeState(run, state);
  const auth = join(root, "parallel-failure-auth.json"); await file(auth, "{}\n", 0o600);
  const fake = await fakeOwnedDocker(0, false, false, "", false, false, 2);
  await expect(runBenchmark({ runDir: run, authFile: auth, dockerBin: fake.path })).rejects.toThrow("missing per-criterion assessment");
  const failed = await readState(run);
  expect(failed.judge?.status).toBe("failed");
  expect(failed.judge?.failed_pass).toBe(2);
  expect(failed.judge?.error).toContain("missing per-criterion assessment");
  expect(failed.judge?.attempts?.find(attempt => attempt.pass === 2 && attempt.stage === "assessment")?.status).toBe("complete");
});
test("semantic file boundaries reject unrelated changes", async () => {
  const criteriaPath = join(root, "boundary-criteria.json");
  await file(criteriaPath, JSON.stringify({ schema: "codex-ab.criteria.v1", task_sha256: await sha256(task),
    criteria: [{ id: "fixture", description: "Make the fixture better." }], allowed_paths: ["internal/router/router.go"],
    preparation: "true", existing_tests: "true", qualification: "not-run" }));
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
    preparation: "true", existing_tests: "true", qualification: "not-run" }));
  const run = await prepare({ source, baseCommit: base, forbiddenCommit: future, taskPath: task,
    criteriaPath, outputParent: root, currentHome: home, image: "fixture-image", cpus: "2", memory: "4g", timeoutSeconds: 30 });
  const auth = join(root, "timing-auth.json"); await file(auth, "{}\n", 0o600);
  const fake = await fakeOwnedDocker(0);
  const state = await runPair({ runDir: run, authFile: auth, dockerBin: fake.path });
  await expect(prepareSemanticAssessment({ runDir: run, state, contract: state.criteria!.contract, pass: 1,
    order: ["stock", "current"], docker: fake.path, ask: async () => { throw new Error("author unavailable"); } })).rejects.toThrow("author unavailable");
  const captured = JSON.parse(await readFile(join(run, "evaluator/semantic/pass-1/existing/candidate-1/__existing_tests/evidence.json"), "utf8"));
  expect((await readState(run)).results!.stock!.grade!.elapsed_ms).toBe(captured.execution.elapsed_ms);
  expect(captured.execution.elapsed_ms).toBeGreaterThan(0);
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
  expect(await Bun.file(join(run, "arms/stock/repo/criteria.json")).exists()).toBe(false);
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

async function fakeDocker(sleepSeconds: number): Promise<{ path: string; log: string }> {
  const path = join(root, `fake-docker-${sleepSeconds}.sh`);
  const log = join(root, `fake-docker-${sleepSeconds}.log`);
  await file(path, `#!/bin/sh\nset -eu\nprintf '%s %s\\n' \"$(date +%s%N)\" \"$*\" >> '${log}'\ncase \" $* \" in\n  *' image inspect '*) printf '%s\\n' 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' ;;\n  *' codex exec '*) trap 'exit 143' TERM INT; sleep ${sleepSeconds}; printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}' ;;\n  *'id -u'*) printf '%s\\n' '1000:1000' ;;\n  *' sha256sum /usr/local/bin/codex '*) printf '%s  %s\\n' '${codexHash}' '/usr/local/bin/codex' ;;\n  *' sh -lc '*) printf '%s\\n' 'codex_path=/usr/local/bin/codex' 'codex-cli 0.154.0' ;;\nesac\n`, 0o755);
  return { path, log };
}

async function fakeOwnedDocker(sleepSeconds: number, failWarm = false, missingHost = false, candidatePatch = "", wrongProtectedBinary = false, networkFailure = false,
  invalidAssessmentPass?: 1 | 2): Promise<{ path: string; log: string; stateDir: string }> {
  const path = join(root, `fake-owned-docker-${crypto.randomUUID()}.sh`);
  const log = `${path}.log`;
  const stateDir = `${path}.state`;
  await file(`${path}.patch`, candidatePatch);
  const judgeAssessment = (includeCriteria: boolean) => JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({
    scores: { "candidate-1": { correctness: 5, completeness: 5, maintainability: 5, test_quality: 5 }, "candidate-2": { correctness: 5, completeness: 5, maintainability: 5, test_quality: 5 } },
    evidence: ["fixture semantic assessment"], issues: [], winner: "tie", rationale: "Both fixtures meet the criterion.",
    ...(includeCriteria ? { criteria: Object.fromEntries(["candidate-1", "candidate-2"].map(id => [id, [{ criterion: "fixture", status: "pass", basis: "executed", reasoning: "Executed fixture assertion." }]])) } : {}),
  }) } });
  const validAssessment = judgeAssessment(true);
  const invalidAssessment = judgeAssessment(false);
  await file(path, `#!/bin/sh
set -u
mkdir -p '${stateDir}'
printf '%s %s\\n' "$(date +%s%N)" "$*" >> '${log}'
operation="$1"; shift
case "$operation" in
  network)
    action="$1"; shift
    case "$action" in
      create)
        name=; owner=; previous=
        for argument in "$@"; do
          [ "$previous" = --label ] && owner="\${argument#codex-ab.owner=}"
          name="$argument"; previous="$argument"
        done
        printf '%s' "$owner" >'${stateDir}/network-'$name
        echo "network-$name"
        ;;
      inspect)
        name=; for argument in "$@"; do name="$argument"; done
        if [ ! -f '${stateDir}/network-'$name ]; then echo "Error: No such network: $name" >&2; exit 1; fi
        cat '${stateDir}/network-'$name
        ;;
      rm)
        name="$1"
        rm -f '${stateDir}/network-'$name
        echo "$name"
        ;;
    esac
    ;;
  create)
    name=; previous=
    for argument in "$@"; do
      if [ "$previous" = --name ]; then name="$argument"; fi
      case "$argument" in
        *:/capture) printf '%s' "\${argument%:/capture}" >'${stateDir}/'$name.capture ;;
      esac
      previous="$argument"
    done
    test -n "$name" || exit 2
    printf '%s\\n' "$*" >'${stateDir}/'$name
    echo "$name"
    ;;
  start)
    name=; for argument in "$@"; do name="$argument"; done
    test -f '${stateDir}/'$name || exit 3
    status=0
    case "$name" in
      *-isolation-codex) printf '%s\\n' 'codex-cli 0.154.0' ;;
      *-isolation-probe) printf '%s\\n' CODEX_AB_PROTECTED_RUNTIME_OK ;;
      *-preflight-image) printf '%s\\n' 'codex_path=/usr/local/bin/codex' 'codex-cli 0.154.0' ;;
      *-preflight-identity) printf '%s\\n' '1000:1000' ;;
      *-preflight-hash) ${missingHost ? `printf '%s  %s\\n' '${codexHash}' '/usr/local/bin/codex'; status=1` : `printf '%s  %s\\n%s  %s\\n' '${codexHash}' '/usr/local/bin/codex' '${codeModeHostHash}' '/usr/local/bin/codex-code-mode-host'; printf '%s  %s\\n' '${wrongProtectedBinary ? "bad" : codexHash}' '/usr/local/libexec/codex-real'`} ;;
      *-preflight-network-*) ${networkFailure ? "echo 'curl: (7) Network unreachable' >&2; status=7" : "printf '%s' '403'"} ;;
      *-preflight-toolhost) printf '%s\\n' 'CODEX_AB_TOOL_HOST_OK' ;;
      *-preflight-grok) printf '%s\\n' 'grok 1.0.30' ;;
      *-warm) ${failWarm ? "echo prewarm-failed >&2; status=9" : ":"} ;;
      *-capture)
        capture=$(cat '${stateDir}/'$name.capture)
        cp '${path}.patch' "$capture/changes.patch"
        printf '%s' '{"changed_files":[],"head_after_agent":"${base}"}' >"$capture/result.json"
        rm -f '${stateDir}/'$name.capture
        ;;
      *-judge-*-harness-*)
        cat >/dev/null
        sleep 0.1
        printf '%s\\n' '${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(Object.fromEntries(["candidate-1", "candidate-2"].map(id => [id, [{ criterion: "fixture", files: [{ path: "extra.cjs", source: "if (1 !== 1) process.exit(1)" }], command: ["node", "extra.cjs"], rationale: "Fixture behavior checked." }]]))) } })}'
        ;;
      *-judge-*-assessment-*)
        cat >/dev/null
        ${invalidAssessmentPass ? `case "$name" in
          *-judge-${invalidAssessmentPass}-assessment-*) printf '%s\\n' '${invalidAssessment}' ;;
          *) sleep 0.2; printf '%s\\n' '${validAssessment}' ;;
        esac` : `printf '%s\\n' '${validAssessment}'`}
        ;;
      *-judge-1|*-judge-2)
        cat >/dev/null
        printf '%s\\n' '${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ scores: { "candidate-1": { correctness: 5, completeness: 5, maintainability: 5, test_quality: 5 }, "candidate-2": { correctness: 5, completeness: 5, maintainability: 5, test_quality: 5 } }, evidence: ["fixture source assessment"], issues: [], winner: "tie", rationale: "Both fixtures satisfy the task." }) } })}'
        ;;
      *-stock|*-current)
        trap 'exit 143' TERM INT
        sleep ${sleepSeconds}
        printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}'
        ;;
    esac
    printf '%s FINISH %s\\n' "$(date +%s%N)" "$name" >> '${log}'
    rm -f '${stateDir}/'$name
    exit "$status"
    ;;
  container)
    test "$1" = inspect || exit 4
    target=; for argument in "$@"; do target="$argument"; done
    if [ ! -f '${stateDir}/'$target ]; then echo "Error: No such object: $target" >&2; exit 1; fi
    case " $* " in
      *'codex-ab.owner'*) sed -n 's/.*codex-ab.owner=\\([^ ]*\\).*/\\1/p' '${stateDir}/'$target ;;
      *) echo "$target" ;;
    esac
    ;;
  rm)
    name=; for argument in "$@"; do name="$argument"; done
    rm -f '${stateDir}/'$name
    ;;
  image)
    echo 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    ;;
esac
`, 0o755);
  return { path, log, stateDir };
}

test("non-paid preflight leaves a prepared run unstarted", async () => {
  const run = await prepared();
  const fake = await fakeOwnedDocker(0);
  await preflightRun(run, fake.path);
  const state = await readState(run);
  expect(state.status).toBe("prepared");
  expect(await Bun.file(join(fake.stateDir, `network-codex-ab-${state.id}-preflight-provider`)).exists()).toBe(false);
  const log = await readFile(fake.log, "utf8");
  expect(log).toContain("mise ls --current --missing --no-header");
  expect(log).not.toContain("go generate");
  expect(log).toContain("cd /tmp/preflight && true && git diff --quiet HEAD --");
});

test("preflight rejects unavailable provider networking before inference", async () => {
  const run = await prepared();
  const fake = await fakeOwnedDocker(0, false, false, "", false, true);
  await expect(preflightRun(run, fake.path)).rejects.toThrow("Fix Docker DNS, IPv6, NAT, or firewall forwarding before starting paid inference");
  expect((await readState(run)).status).toBe("prepared");
  const log = await readFile(fake.log, "utf8");
  expect(log).toContain("network create --ipv6 --label codex-ab.owner=");
  expect(log).toContain("--network codex-ab-");
  expect(log).toContain("network rm codex-ab-");
  expect(log).toContain("-preflight-network-chatgpt");
  expect(log).not.toMatch(/-(stock|current) /);
  const evidence = JSON.parse(await readFile(join(run, "artifacts/preflight-network.json"), "utf8"));
  expect(evidence).toMatchObject([{ provider: "chatgpt", endpoint: "https://chatgpt.com/", result: { exitCode: 7 } }]);
});

test("preflight reports the missing image and Docker cause", async () => {
  const run = await prepared();
  const docker = join(root, "missing-image-docker");
  await file(docker, "#!/bin/sh\necho 'No such image: fixture-image' >&2\nexit 1\n", 0o755);
  await expect(preflightRun(run, docker)).rejects.toThrow("cannot resolve immutable image ID for fixture-image: No such image: fixture-image");
});

test("an externally canceled pair stops before Docker preflight", async () => {
  const run = await prepared();
  const fake = await fakeOwnedDocker(0);
  await expect(runPair({ runDir: run, authFile: join(root, "unused-auth"), dockerBin: fake.path, signal: AbortSignal.abort() }))
    .rejects.toThrow("preflight canceled; no model was launched");
  expect(await Bun.file(fake.log).exists()).toBe(false);
});

test("preflight pins shared dependencies and compiles offline without cache mounts", async () => {
  const run = await prepared();
  const fake = await fakeOwnedDocker(0);
  await preflightRun(run, fake.path);
  const state = await readState(run);
  expect(state.dependency_image?.image_id).toBe(`sha256:${"a".repeat(64)}`);
  const compile = (await readFile(fake.log, "utf8")).split("\n").find(line => line.includes("-preflight-compile "))!;
  expect(compile).toContain("--network none");
  expect(compile).not.toContain("preflight-cache");
});

test("preflight reports expected and actual Codex versions with a rebuild action", async () => {
  const run = await prepared();
  const state = await readState(run);
  state.runtime_tools.codex_version = "codex-cli 0.155.0";
  await writeState(run, state);
  const fake = await fakeOwnedDocker(0);
  await expect(preflightRun(run, fake.path)).rejects.toThrow(
    "expected codex-cli 0.155.0, got codex-cli 0.154.0. Rebuild fixture-image",
  );
  expect((await readFile(fake.log, "utf8"))).not.toContain(" codex exec ");
});

test("preflight rejects an image missing the recorded code-mode host", async () => {
  const run = await prepared();
  const fake = await fakeOwnedDocker(0, false, true);
  expect(preflightRun(run, fake.path)).rejects.toThrow("container Codex hash differs from prepared source");
  expect((await readState(run)).status).toBe("prepared");
});


test("preflight rejects changes inside the current setup tool store", async () => {
  const privateHome = join(root, "mutation-home");
  await cp(home, privateHome, { recursive: true });
  const run = await prepared(30, "codex", privateHome);
  const state = await readState(run);
  await file(resolve(run, state.runtime_tools.current_setup_installs, "fixture-runner/1/bin/project-runner"), "changed after preparation\n", 0o755);
  await expect(preflightRun(run, "/must-not-be-launched")).rejects.toThrow("current setup installations changed");
});
test("Mekugi rejects changed controls and snapshot files before Docker is invoked", async () => {
  for (const path of ["control/task.md", "evaluator/criteria.json", "snapshots/runtime/bin/bun", "snapshots/current/home/ubuntu/AGENTS.md", "snapshots/stock/home/ubuntu/AGENTS.md"]) {
    const run = await prepared();
    await file(join(run, path), "changed after preparation\n");
    await expect(preflightRun(run, "/must-not-be-launched")).rejects.toThrow("changed");
  }
}, 15_000);

test("runner starts both arms concurrently, grades both, and refuses a rerun", async () => {
  const run = await prepared();
  const auth = join(root, "auth.json"); await file(auth, "{}\n", 0o600); await chmod(auth, 0o600);
  const fake = await fakeOwnedDocker(0.35);
  const state = await runPair({ runDir: run, authFile: auth, dockerBin: fake.path });
  expect(state.status).toBe("complete");
  expect(state.results?.stock?.grade?.passed).toBe(false);
  expect(state.results?.current?.grade?.passed).toBe(false);
  const log = await readFile(fake.log, "utf8");
  expect(log).toContain(" mise exec -- codex exec ");
  expect(log).toContain(`${state.runtime_tools.current_setup_installs}:/home/ubuntu/.local/share/mise/installs:ro`);
  const agentWarmCalls = log.split("\n").filter(line => /-agent-warm /.test(line));
  expect(agentWarmCalls).toHaveLength(2);
  expect(agentWarmCalls.every(line => line.includes("--network none") && !line.includes("go-pkg-cache"))).toBe(true);
  expect(log).not.toContain("grader-go-pkg-cache");
  expect(log).not.toContain("grader-bun-cache");
  expect(agentWarmCalls.every(line => line.includes("/repo:/workspace"))).toBe(true);
  expect(log).not.toContain("-evaluator-warm ");
  const candidateChecks = log.split("\n").filter(line => line.includes(" create ") && line.includes("-grade-verify "));
  expect(candidateChecks).toHaveLength(4);
  expect(candidateChecks.every(line => line.includes("--network none"))).toBe(true);
  const agentContainers = log.split("\n").filter(line => / create --rm --name codex-ab-.*-(?:stock|current) --label /.test(line));
  expect(agentContainers).toHaveLength(2);
  expect(agentContainers.every(line => line.includes(`--network codex-ab-${state.id}-provider`))).toBe(true);
  expect(log.match(/ codex exec /g)?.length).toBe(2);
  const calls = log.split("\n");
  const agentStarted = calls.filter(line => / start --attach --interactive codex-ab-.*-(stock|current)$/.test(line)).map(line => BigInt(line.split(" ")[0]!));
  expect(Number(agentStarted[1]! - agentStarted[0]!)).toBeLessThan(200_000_000);
  const secondAgent = Math.max(...calls.map((line, index) => / FINISH codex-ab-.*-(stock|current)$/.test(line) ? index : -1));
  const firstGrade = calls.findIndex(line => line.includes("-grade-verify "));
  expect(firstGrade).toBeGreaterThan(secondAgent);
  expect(runPair({ runDir: run, authFile: auth, dockerBin: fake.path })).rejects.toThrow("prepare a new run");

  const pricing: PricingSnapshot = { fetched_at: new Date().toISOString(), source: "fallback", catalog_url: "fixture", assumptions: [], warnings: [], models: {} };
  state.pricing = pricing;
  await writeState(run, state);
  const paths = await buildReport(run);
  expect(await Bun.file(paths.jsonPath).exists()).toBe(true);
  expect(await readFile(paths.markdownPath, "utf8")).toContain("does not establish a causal");
});

test("runner rejects current-only single-arm execution before launch", async () => {
  const run = await prepared();
  await expect(runPair({ runDir: run, authFile: "/must-not-read", dockerBin: "/must-not-launch", arm: "current" }))
    .rejects.toThrow("single-arm runs support stock controls only");
});
test("current arm can launch through the snapshotted Mekugi wrapper", async () => {
  const run = await prepared(30, "mekugi");
  const stateBefore = await readState(run);
  expect(stateBefore.execution.current_launcher).toBe("mekugi");
  expect(stateBefore.runtime_tools.mekugi_sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(await Bun.file(join(run, "snapshots/current/home/ubuntu/.local/bin/mekugi")).exists()).toBe(true);
  expect(stateBefore.runtime_tools.mekugi_shell_sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(await readFile(join(run, "snapshots/current/home/ubuntu/.local/bin/shell"), "utf8"))
    .toBe(await readFile(join(home, "go/bin/shell"), "utf8"));
  expect(stateBefore.runtime_tools.mekugi_shell_source).toBe(join(home, "go/bin/shell"));
  const auth = join(root, "mekugi-auth.json"); await file(auth, "{}\n", 0o600); await chmod(auth, 0o600);
  const fake = await fakeOwnedDocker(0);
  const state = await runPair({ runDir: run, authFile: auth, dockerBin: fake.path });
  expect(state.status).toBe("complete");
  const log = await readFile(fake.log, "utf8");
  expect(log).toContain(" mise exec -- mekugi codex exec ");
  expect(log).toContain("command -v shell");
  expect(log).toContain("shell: CODEX_THREAD_ID is unavailable");
});

test("Mekugi helper absence and tampering fail before any container or inference", async () => {
  const run = await prepared(30, "mekugi");
  await rm(join(run, "snapshots/current/home/ubuntu/.local/bin/shell"));
  await expect(preflightRun(run, "/must-not-be-launched")).rejects.toThrow("current setup snapshot changed");

  const changedRun = await prepared(30, "mekugi");
  await file(join(changedRun, "snapshots/current/home/ubuntu/.local/bin/shell"), "#!/bin/sh\nexit 0\n", 0o755);
  await expect(preflightRun(changedRun, "/must-not-be-launched")).rejects.toThrow("current setup snapshot changed");

  const missingHashRun = await prepared(30, "mekugi");
  const state = await readState(missingHashRun);
  delete state.runtime_tools.mekugi_shell_sha256;
  await writeState(missingHashRun, state);
  await expect(preflightRun(missingHashRun, "/must-not-be-launched"))
    .rejects.toThrow("snapshotted Mekugi shell helper changed or is missing");
});

test("prepare validates and snapshots an explicit Mekugi helper", async () => {
  const options = {
    source, baseCommit: base, forbiddenCommit: future, taskPath: task, criteriaPath: fixtureCriteria,
    outputParent: root, currentHome: home, image: "fixture-image", cpus: "2", memory: "4g", timeoutSeconds: 30,
    codexBinary: join(home, ".local/bin/codex"), currentLauncher: "mekugi" as const,
    mekugiBinary: join(home, "go/bin/mekugi"), mekugiShellBinary: join(root, "missing-shell"),
  };
  await expect(prepare(options)).rejects.toThrow("ENOENT");
  const helper = join(root, "non-executable-shell");
  await file(helper, "fixture\n", 0o644);
  await expect(prepare({ ...options, mekugiShellBinary: helper })).rejects.toThrow("Mekugi shell helper is not executable");
  await expect(prepare({ ...options, currentLauncher: "codex", mekugiBinary: undefined }))
    .rejects.toThrow("--mekugi-shell-bin requires a Mekugi launcher treatment");

  const selectedHelper = join(root, "separate-bin/helper");
  const selectedContent = "#!/bin/sh\n# Explicitly selected helper.\necho 'shell: CODEX_THREAD_ID is unavailable' >&2\nexit 1\n";
  await file(selectedHelper, selectedContent, 0o755);
  const run = await prepare({ ...options, mekugiShellBinary: selectedHelper });
  const state = await readState(run);
  expect(state.runtime_tools.mekugi_shell_source).toBe(selectedHelper);
  expect(state.runtime_tools.mekugi_shell_sha256)
    .toBe((await checked(["sha256sum", selectedHelper])).stdout.split(/\s+/)[0]!);
  expect(await readFile(join(run, "snapshots/current/home/ubuntu/.local/bin/shell"), "utf8")).toBe(selectedContent);
});

test("runner records timeouts and stops its exact session containers", async () => {
  const run = await prepared(1);
  const auth = join(root, "timeout-auth.json"); await file(auth, "{}\n", 0o600); await chmod(auth, 0o600);
  const fake = await fakeOwnedDocker(2);
  const state = await runPair({ runDir: run, authFile: auth, dockerBin: fake.path });
  expect(state.results?.stock?.timed_out).toBe(true);
  expect(state.results?.current?.timed_out).toBe(true);
  const log = await readFile(fake.log, "utf8");
  expect(log).toContain(`rm --force codex-ab-${state.id}-stock`);
  expect(log).toContain(`rm --force codex-ab-${state.id}-current`);
});

test("prewarm failure is persisted as partial and cannot be resumed", async () => {
  const run = await prepared();
  const auth = join(root, "failure-auth.json"); await file(auth, "{}\n", 0o600); await chmod(auth, 0o600);
  const fake = await fakeOwnedDocker(0, true);
  expect(runPair({ runDir: run, authFile: auth, dockerBin: fake.path })).rejects.toThrow("cache prewarm failed");
  const state = await readState(run);
  expect(state.status).toBe("partial");
  expect(state.error).toContain("cache prewarm failed");
  expect(runPair({ runDir: run, authFile: auth, dockerBin: fake.path })).rejects.toThrow("prepare a new run");
});

test("submodule initialization preserves exact isolation and rejects setup changes", async () => {
  const godoxy = join(root, "godoxy");
  await checked(["git", "clone", "--no-local", source, godoxy]);
  await checked(["git", "-C", godoxy, "config", "user.email", "fixture@example.invalid"]);
  await checked(["git", "-C", godoxy, "config", "user.name", "Fixture"]);
  await file(join(godoxy, "internal/homepage/icons/fetch/icons.go"), "package fetch\n");
  const submodules: Array<{ path: string; sha: string; source: string }> = [];
  for (const path of ["goutils", "internal/go-oidc", "internal/gopsutil"]) {
    const sub = join(godoxy, path);
    await mkdir(sub, { recursive: true });
    await checked(["git", "init", sub]);
    await checked(["git", "-C", sub, "config", "user.email", "fixture@example.invalid"]);
    await checked(["git", "-C", sub, "config", "user.name", "Fixture"]);
    await file(join(sub, "tracked.txt"), "baseline\n");
    await checked(["git", "-C", sub, "add", "."]);
    await checked(["git", "-C", sub, "commit", "-m", "submodule base"]);
    const sha = (await checked(["git", "-C", sub, "rev-parse", "HEAD"])).stdout.trim();
    submodules.push({ path, sha, source: sub });
    await checked(["git", "-C", godoxy, "config", "-f", ".gitmodules", `submodule.${path}.path`, path]);
    await checked(["git", "-C", godoxy, "config", "-f", ".gitmodules", `submodule.${path}.url`, `https://example.invalid/${path}`]);
    await checked(["git", "-C", godoxy, "update-index", "--add", "--cacheinfo", `160000,${sha},${path}`]);
  }
  await checked(["git", "-C", godoxy, "config", "-f", ".gitmodules", "submodule.webui.path", "webui"]);
  await checked(["git", "-C", godoxy, "config", "-f", ".gitmodules", "submodule.webui.url", "https://example.invalid/webui"]);
  await checked(["git", "-C", godoxy, "update-index", "--add", "--cacheinfo", `160000,${submodules[0]!.sha},webui`]);
  await checked(["git", "-C", godoxy, "add", "internal/homepage", ".gitmodules"]);
  await checked(["git", "-C", godoxy, "commit", "-m", "gitlinks"]);
  const repository = join(root, "submodule-clone");
  await checked(["git", "clone", "--no-local", godoxy, repository]);
  await checked(["git", "-C", repository, "remote", "remove", "origin"]);
  await initializeSubmodules(repository, submodules);
  await verifyRepositoryIsolation(repository);
  await checked(["git", "-C", repository, "remote", "add", "unexpected", "https://example.invalid/root"]);
  await expect(verifyRepositoryIsolation(repository)).rejects.toThrow("root repository retained a remote");
  await checked(["git", "-C", repository, "remote", "remove", "unexpected"]);
  await checked(["git", "-C", repository, "submodule", "init", "--", "webui"]);
  await expect(verifyRepositoryIsolation(repository)).rejects.toThrow("webui must remain");
  await checked(["git", "-C", repository, "config", "--remove-section", "submodule.webui"]);
  await verifyRepositoryIsolation(repository);
  const initialized = (await checked(["git", "-C", repository, "submodule", "status", "--", ...submodules.map(sub => sub.path)])).stdout.split("\n").filter(Boolean);
  expect(initialized).toHaveLength(3);
  expect(initialized.every(line => line.startsWith(" "))).toBe(true);
  await checked(["git", "-C", repository, "config", "--remove-section", "submodule.goutils"]);
  await expect(verifySubmodules(repository, submodules)).rejects.toThrow("not clean, exact");
  await checked(["git", "-C", repository, "submodule", "init", "--", "goutils"]);
  await file(join(repository, "goutils/tracked.txt"), "candidate change\n");
  await expect(verifySubmodules(repository, submodules)).rejects.toThrow("not clean, exact");
});

test("godoxy profile rejects implicit controls and mismatched pinned identities before setup", async () => {
  await expect(main(["prepare", "--profile", "godoxy-icons"])).rejects.toThrow();
  await expect(main(["prepare", "--profile", "godoxy-icons", "--task", task])).rejects.toThrow();
  const identity = { ...GODOXY_ICONS, path: "/source", source_timestamp: 1 };
  const submodules = Object.entries(GODOXY_ICONS.submodules).map(([path, sha]) => ({ path, sha, source: `/source/${path}` }));
  expect(() => verifyGodoxyIdentity(identity, submodules)).not.toThrow();
  for (const key of ["base_commit", "base_tree", "forbidden_commit"] as const) {
    expect(() => verifyGodoxyIdentity({ ...identity, [key]: "0".repeat(40) }, submodules)).toThrow("identity mismatch");
  }
  expect(() => verifyGodoxyIdentity(identity, [])).toThrow("identity mismatch");
  expect(() => verifyGodoxyIdentity(identity, submodules.map(sub => ({ ...sub, sha: "0".repeat(40) })))).toThrow("identity mismatch");
  expect(() => verifyGodoxyIdentity(identity, [submodules[0]!, submodules[0]!, submodules[0]!])).toThrow("identity mismatch");
  const run = await prepared();
  const state = await readState(run);
  state.profile = "godoxy-icons";
  await writeState(run, state);
  const originalTask = await readFile(join(run, state.task.path), "utf8");
  expect(originalTask).toBe(await readFile(task, "utf8"));
  expect(JSON.parse(await readFile(join(run, state.criteria!.path), "utf8"))).toEqual(JSON.parse(await readFile(fixtureCriteria, "utf8")));
  await expect(preflightRun(run, "/must-not-be-launched")).rejects.toThrow("identity mismatch");
});

test("godoxy preflight rejects changes to the copied controls before container launch", async () => {
  const run = await prepared();
  const state = await readState(run);
  state.profile = "godoxy-icons";
  state.source = { ...state.source, base_commit: GODOXY_ICONS.base_commit, base_tree: GODOXY_ICONS.base_tree, forbidden_commit: GODOXY_ICONS.forbidden_commit };
  state.submodules = Object.entries(GODOXY_ICONS.submodules).map(([path, sha]) => ({ path, sha, source: `/source/${path}` }));
  await writeState(run, state);
  await file(join(run, state.task.path), "changed control\n");
  await expect(preflightRun(run, "/must-not-be-launched")).rejects.toThrow("copied benchmark control changed");
});

test("benchmark owns semantic judging, audit and checksummed bundle", async () => {
  const run = await prepared();
  const state = await readState(run);
  state.pricing = { fetched_at: new Date().toISOString(), source: "fallback", catalog_url: "fixture://pricing", assumptions: [], warnings: [], models: {} };
  await writeState(run, state);
  const auth = join(root, "workflow-auth.json");
  await file(auth, "{}\n", 0o600);
  const fake = await fakeOwnedDocker(0);
  await runBenchmark({ runDir: run, authFile: auth, dockerBin: fake.path });
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
  const state = await readState(run);
  state.pricing = { fetched_at: new Date().toISOString(), source: "fallback", catalog_url: "fixture://pricing", assumptions: [], warnings: [], models: {} };
  await writeState(run, state);
  const auth = join(root, "workflow-failed-auth.json");
  await file(auth, "{}\n", 0o600);
  const fake = await fakeOwnedDocker(0, true);
  await expect(runBenchmark({ runDir: run, authFile: auth, dockerBin: fake.path })).rejects.toThrow("cache prewarm failed");
  expect((await readState(run)).finishing?.status).toBe("failed");
  expect(await Bun.file(join(run, "reports/bundle/report.json")).exists()).toBe(true);
  expect(await readFile(fake.log, "utf8")).not.toContain("-judge-1");
}, 30_000);

for (const fault of ["integrity", "cancel"] as const) {
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
        else process.emit("SIGTERM");
      }
      return original.apply(process.stderr, args);
    } as typeof original;
    try {
      await expect(runBenchmark({ runDir: run, authFile: auth, dockerBin: fake.path })).rejects.toThrow();
    } finally {
      process.stderr.write = original;
    }
    expect(injected).toBe(true);
    expect((await readState(run)).finishing?.status).toBe("failed");
    const bundled = JSON.parse(await readFile(join(run, "reports/bundle/run.json"), "utf8"));
    const report = JSON.parse(await readFile(join(run, "reports/bundle/report.json"), "utf8"));
    expect(bundled.finishing.status).toBe("failed");
    expect(report.finishing.status).toBe("failed");
    expect(report.winner).toBe("none");
    if (fault === "integrity") expect(report.validity).toBe("invalid");
    expect(await Bun.file(join(run, ".operation-lock")).exists()).toBe(false);
    expect(await readFile(fake.log, "utf8")).toContain("-judge-1");
  }, 30_000);
}

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
  expect(finished.judge?.model).toBe("gpt-6-sol");
  expect(finished.judge?.passes).toHaveLength(2);
  const savedPricing = finished.pricing as PricingSnapshot;
  expect(savedPricing.models["gpt-5.6-sol"]).toEqual(oldSolRate);
  expect(savedPricing.models["gpt-6-sol"]).toBeUndefined();
  expect(finished.judge_pricing?.rate.source).toBe("fallback:gpt-6-sol");
  expect(finished.judge_pricing?.rate.completion).toBe(10 / 1_000_000);
  const report = await Bun.file(join(run, "reports/report.json")).json();
  expect(report.pricing.models["gpt-6-sol"].completion).toBe(10 / 1_000_000);
  expect(report.pricing.assumptions).toContainEqual(expect.stringContaining("original run pricing is unchanged"));
  expect(finished.finishing_history).toHaveLength(1);
  expect(await readFile(join(run, finished.finishing_history![0]!.bundle_path, "prior-failure.txt"), "utf8")).toBe("preserve this failure");
  const additional = (await readFile(fake.log, "utf8")).slice(before.length);
  expect(additional).toContain("--model gpt-6-sol");
  expect(additional).not.toContain("-stock ");
  expect(additional).not.toContain("-current ");
  await expect(finishBenchmark({ runDir: run, authFile: auth, dockerBin: fake.path })).rejects.toThrow("failed finishing");
}, 30_000);

test("preflight rejects mise migration warnings even when mise exits successfully", async () => {
  const run = await prepared();
  const fake = await fakeOwnedDocker(0);
  const script = await readFile(fake.path, "utf8");
  await writeFile(fake.path, script.replace('    case "$name" in', `    case "$name" in
      *-preflight-setup) printf '%s\\n' '[WARN] migrate: failed to remove symlink: readonly tool store' >&2 ;;`));
  await expect(preflightRun(run, fake.path)).rejects.toThrow("mise migration failed");
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
  expect((await stat(join(first, "arms/stock/repo/internal/router/router.go"))).ino)
    .not.toBe((await stat(join(second, "arms/stock/repo/internal/router/router.go"))).ino);
  expect(await Bun.file(join(first, "arms/stock/home/ubuntu/.codex/auth.json")).exists()).toBe(false);
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
