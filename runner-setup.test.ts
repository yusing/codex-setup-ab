import { expect, spyOn, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, readlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { verifyPreparedInputs } from "./prepare";
import { runBenchmark } from "./workflow";
import { prepareTrials, readTrialSet } from "./trials";
import { main, parseMekugiFlags } from "./cli";
import { checked } from "./process";
import { readState, writeState, sha256 } from "./state";
import { preflightRun, runPair } from "./runner";
import * as bundles from "./bundle";
import { runnerFixture } from "./test-support/runner-fixture";

const { root, source, home, task, fixtureCriteria, mekugiSource, base, future, brewPrefix, fixtureVerification, fixtureControls, file, prepare, mekugiComparisonOptions, fakeOwnedDocker } = await runnerFixture();

test("same-setup uses one immutable configuration for both arms and rejects drift", async () => {
  await mkdir(join(root, "capture-source"), { recursive: true });

  const run = await prepare({ source, baseCommit: base, forbiddenCommit: future, taskPath: task,
    criteriaPath: fixtureCriteria, outputParent: root, currentHome: home, image: "fixture-image",
    cpus: "2", memory: "4g", timeoutSeconds: 30, comparison: "same-setup",
    mekugiFlags: [], mekugiSource: join(root, "capture-source") });
  expect(await readlink(join(run, "snapshots/current/home/ubuntu/linked-guidance"))).toBe("AGENTS.md");
  const state = await readState(run);
  expect(state.operator).toEqual({ uid: 1000, gid: 1000 });
  expect(state.execution.current_launcher).toBe("mekugi");
  expect(state.arms.stock.home_template).toBe(state.arms.current.home_template);
  expect(state.mekugi_flags).toEqual([]);
  await verifyPreparedInputs(run, state);
  const auth = join(root, "same-setup-auth.json");
  await file(auth, "{}\n", 0o600);
  const fake = await fakeOwnedDocker(0);
  expect((await runPair({ runDir: run, authFile: auth, dockerBin: fake.path })).status).toBe("complete");
  const launches = (await readFile(fake.log, "utf8")).split("\n").filter(line => (line.includes(" exec --json ") || line.includes(" headless --yolo ")));
  expect(launches).toHaveLength(2);
  expect(launches.some(line => line.includes(" mise exec -- codex exec "))).toBe(true);
  expect(launches.some(line => line.includes(" mise exec -- sh -c ") && line.includes("mekugi --capture-output=/mekugi-exports/capture.jsonl --debug codex headless --yolo "))).toBe(true);
  expect(launches.every(line => line.includes(`${state.runtime_tools.current_setup_installs}:${state.runtime_tools.current_setup_installs}:ro`))).toBe(true);
  const runtime = await readState(run);
  expect(runtime.runtime_homes?.stock?.image_id).not.toBe(runtime.runtime_homes?.current?.image_id);
  for (const arm of ["stock", "current"] as const) {
    expect(launches.find(line => line.includes(`--name codex-ab-${state.id}-${arm} `))).toContain(`${runtime.runtime_homes![arm]!.image_id} mise exec`);
  }
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
  const profile = join(run, state.arms.current.home_template, ".bash_profile");
  const initialized = await checked(["bash", "--noprofile", "--norc", "-c", '. "$1"; printf "%s" "$PATH"', "profile-check", profile]);
  expect(initialized.stdout).toStartWith("/opt/task-deps/python/bin:/fixture-python/bin:");
});

test("stock-mekugi shares configured tools while isolating current-home guidance", async () => {
  const captureSource = join(root, "stock-mekugi-capture-source");
  await mkdir(captureSource, { recursive: true });

  const run = await prepare({ source, baseCommit: base, forbiddenCommit: future, taskPath: task,
    criteriaPath: fixtureCriteria, outputParent: root, currentHome: home, image: "fixture-image",
    cpus: "2", memory: "4g", timeoutSeconds: 30, comparison: "stock-mekugi",
    mekugiFlags: [], mekugiSource: captureSource });
  const state = await readState(run);
  expect(state.execution).toMatchObject({ current_launcher: "mekugi", service_tier: "default" });
  expect(state.arms.stock.home_template).toBe("snapshots/stock/home/ubuntu");
  expect(state.arms.current.home_template).toBe("snapshots/stock-mekugi/home/ubuntu");
  expect(state.runtime_tools.current_setup_installs).toBe(await realpath(join(home, ".local/share/mise/installs")));
  for (const arm of ["stock", "current"] as const) {
    const template = join(run, state.arms[arm].home_template);
    const configValues = Bun.TOML.parse(await readFile(join(template, ".codex/config.toml"), "utf8")) as Record<string, unknown>;
    expect(configValues.network_access).toBeUndefined();
    const identity = await checked(["git", "-C", join(run, state.arms[arm].repository), "-c", "user.useConfigOnly=true", "var", "GIT_AUTHOR_IDENT"]);
    expect(identity.stdout).toStartWith("Task Agent <agent@example.invalid>");
    expect(await readFile(join(template, ".config/mise/config.toml"), "utf8")).toBe('[tools]\n"fixture-runner" = "1"\n');
    expect(await Bun.file(join(template, ".local/bin/mise")).exists()).toBe(false);
    expect(await Bun.file(join(template, "AGENTS.md")).exists()).toBe(false);
    expect(await Bun.file(join(template, ".codex/AGENTS.md")).exists()).toBe(false);
    expect(await Bun.file(join(template, ".codex/hooks.json")).exists()).toBe(false);
    const config = join(template, ".config/mise/config.toml");
    const original = await readFile(config, "utf8");
    await writeFile(config, `${original}# drift\n`);
    await expect(verifyPreparedInputs(run, state)).rejects.toThrow("setup snapshot changed");
    await writeFile(config, original);
  }
  await verifyPreparedInputs(run, state);

  const auth = join(root, "stock-mekugi-auth.json");
  await file(auth, "{}\n", 0o600);
  const fake = await fakeOwnedDocker(0);
  expect((await runPair({ runDir: run, authFile: auth, dockerBin: fake.path })).status).toBe("complete");
  const launches = (await readFile(fake.log, "utf8")).split("\n").filter(line => (line.includes(" exec --json ") || line.includes(" headless --yolo ")));
  expect(launches).toHaveLength(2);
  expect(launches.some(line => line.includes(" codex exec --json ") && !line.includes(" mekugi "))).toBe(true);
  expect(launches.every(line => line.includes(`${brewPrefix}:${brewPrefix}:ro`) && line.includes(`HOMEBREW_PREFIX=${brewPrefix}`))).toBe(true);
  expect(launches.every(line => line.includes("PATH=/opt/task-deps/python/bin:"))).toBe(true);
  expect(launches.some(line => line.includes(" sh -c ") && line.includes(" mekugi --capture-output=/mekugi-exports/capture.jsonl --debug codex headless --yolo "))).toBe(true);
  expect(launches.every(line => line.includes(" mise exec ") && line.includes(`${state.runtime_tools.current_setup_installs}:${state.runtime_tools.current_setup_installs}:ro`)
    && line.includes(`MISE_INSTALLS_DIR=${state.runtime_tools.current_setup_installs}`))).toBe(true);
  expect(launches.every(line => line.includes(`${state.runtime_tools.current_setup_mise_source}:/home/ubuntu/.local/bin/mise:ro`))).toBe(true);
  expect(launches.find(line => line.includes(" codex exec --json ") && !line.includes(" mekugi "))).not.toContain("/home/ubuntu/.local/bin/mekugi:ro");
  expect(launches.find(line => line.includes(" mekugi "))).not.toContain(":/home/ubuntu/.local/bin/mekugi:ro");
  expect(launches.find(line => line.includes(" mekugi "))).toContain("--tmpfs /home/ubuntu/.local/state/mekugi/debug:size=4g,mode=0700,uid=1000,gid=1000");
  const exportPreflight = (await readFile(fake.log, "utf8")).split("\n").find(line => line.includes(" create ") && line.includes("-preflight-mekugi "))!;
  expect(exportPreflight).toContain("/artifacts/preflight-mekugi:/mekugi-exports");
  expect(exportPreflight).toContain("mekugi-metrics mekugi --debug --capture-output=/mekugi-exports/capture.jsonl codex --version");
  await expect(prepare({ source, baseCommit: base, forbiddenCommit: future, taskPath: task,
    criteriaPath: fixtureCriteria, outputParent: root, currentHome: home, image: "fixture-image",
    cpus: "2", memory: "4g", timeoutSeconds: 30, comparison: "stock-mekugi",
    reviewTreatment: join(root, "unused-treatment"), mekugiSource: captureSource })).rejects.toThrow("does not accept");
});

test.each(["gpt-6.1-sol", "gpt-6.1-terra"] as const)("stock-mekugi accepts an explicit %s/high pair with the selected model", async (model) => {
  const captureSource = join(root, `${model}-stock-mekugi-capture-source`);
  await mkdir(captureSource, { recursive: true });
  const run = await prepare({ source, baseCommit: base, forbiddenCommit: future, taskPath: task,
    criteriaPath: fixtureCriteria, outputParent: root, currentHome: home, image: "fixture-image",
    cpus: "2", memory: "4g", timeoutSeconds: 30, comparison: "stock-mekugi",
    model, reasoningEffort: "high", mekugiSource: captureSource });
  const state = await readState(run);
  expect(state.execution).toMatchObject({ model, reasoning_effort: "high", current_launcher: "mekugi" });
  for (const template of [state.arms.stock.home_template, state.arms.current.home_template]) {
    const config = await readFile(join(run, template, ".codex/config.toml"), "utf8");
    expect(config).toContain(`model = "${model}"`);
    expect(config).toContain('model_reasoning_effort = "high"');
  }
  await verifyPreparedInputs(run, state);
  await expect(prepare({ source, baseCommit: base, forbiddenCommit: future, taskPath: task,
    criteriaPath: fixtureCriteria, outputParent: root, currentHome: home, image: "fixture-image",
    cpus: "2", memory: "4g", timeoutSeconds: 30, comparison: "stock-mekugi",
    model: "gpt-6-sol" as never, mekugiSource: captureSource })).rejects.toThrow("unsupported benchmark model");
  await expect(prepare({ source, baseCommit: base, forbiddenCommit: future, taskPath: task,
    criteriaPath: fixtureCriteria, outputParent: root, currentHome: home, image: "fixture-image",
    cpus: "2", memory: "4g", timeoutSeconds: 30, comparison: "stock-mekugi",
    model: "grok:grok-4.6" as never, mekugiSource: captureSource })).rejects.toThrow("unsupported benchmark model");
});

test.each(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const)("stock-mekugi preserves %s reasoning and rejects unknown efforts", async (effort) => {
  const captureSource = join(root, "low-stock-mekugi-capture-source");
  await mkdir(captureSource, { recursive: true });
  const options = { source, baseCommit: base, forbiddenCommit: future, taskPath: task,
    criteriaPath: fixtureCriteria, outputParent: root, currentHome: home, image: "fixture-image",
    cpus: "2", memory: "4g", timeoutSeconds: 30, comparison: "stock-mekugi" as const,
    model: "gpt-6-astra" as const, mekugiSource: captureSource };
  const run = await prepare({ ...options, reasoningEffort: effort });
  const state = await readState(run);
  expect(state.execution.reasoning_effort).toBe(effort);
  for (const template of [state.arms.stock.home_template, state.arms.current.home_template]) {
    expect(await readFile(join(run, template, ".codex/config.toml"), "utf8"))
      .toContain(`model_reasoning_effort = "${effort}"`);
  }
  await verifyPreparedInputs(run, state);
  await expect(prepare({ ...options, reasoningEffort: "unknown" as "low" }))
    .rejects.toThrow("reasoning effort must be one of:");
});

test("duplicate-output launches equal controls with distinct treatment and per-arm exports", async () => {
  const comparison = "duplicate-output";
  const currentHome = join(root, "duplicate-output-sol-home");
  await cp(home, currentHome, { recursive: true });
  await writeFile(join(currentHome, ".codex/config.toml"), 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "high"\nservice_tier = "default"\n');
  const run = await prepare({ ...mekugiComparisonOptions(), comparison, currentHome,
    model: "gpt-6.1-sol", reasoningEffort: "high",
    autoCompactLimit: undefined });
  const state = await readState(run);
  expect(state.comparison).toBe(comparison);
  expect(state.execution).toMatchObject({ model: "gpt-6.1-sol", reasoning_effort: "high" });
  expect(state.auto_compact_limit).toBe(undefined);
  expect(state.execution.current_launcher).toBe("mekugi");
  expect(state.arms.stock.home_template).toBe("snapshots/current/home/ubuntu");
  expect(state.arms.current.home_template).toBe(state.arms.stock.home_template);
  expect((await stat(join(run, state.arms.current.home_template, ".local/share/mise/installs"))).isDirectory()).toBe(true);
  expect(state.runtime_tools.mekugi_sha256).toBe(await sha256(resolve(run, state.runtime_tools.mekugi_source!)));
  expect(state.mekugi_exports).toBeUndefined();
  for (const arm of ["stock", "current"] as const) {
    expect(state.mekugi_exports_by_arm?.[arm]).toMatchObject({
      capture: join(dirname(state.arms[arm].repository), "exports/capture.jsonl"), metrics: join(dirname(state.arms[arm].repository), "exports/metrics.json"),
    });
  }
  await verifyPreparedInputs(run, state);
  const auth = join(root, `${comparison}-auth.json`);
  await file(auth, "{}\n", 0o600);
  const fake = await fakeOwnedDocker(0);
  expect((await runPair({ runDir: run, authFile: auth, dockerBin: fake.path })).status).toBe("complete");
  const log = (await readFile(fake.log, "utf8")).split("\n");
  const launches = log.filter(line => ["stock", "current"].some(arm => line.includes(`--name codex-ab-${state.id}-${arm} --label `)));
  expect(launches).toHaveLength(2);
  const snapshot = JSON.parse(await readFile(join(run, state.snapshot_manifest), "utf8"));
  for (const arm of ["stock", "current"] as const) {
    const launch = launches.find(line => line.includes(`codex-ab-${state.id}-${arm} --label`))!;
    expect(launch).toContain("mise exec -- sh -c ");
    const treatment = String(arm === "current");
    expect(launch).toContain(`mekugi --deduplicate-output=${treatment} --capture-output=/mekugi-exports/capture.jsonl --debug codex headless --yolo`);
    expect(launch.includes("model_auto_compact_token_limit=")).toBe(false);
    expect(launch).toContain("--cpus 2 --memory 4g");
    expect(launch).toContain(`--model ${state.execution.model}`);
    expect(launch).toContain(`model_reasoning_effort="${state.execution.reasoning_effort}"`);
    expect(launch).toContain(`service_tier="${state.execution.service_tier}"`);
    const preflight = log.find(line => line.includes(" create ") && line.includes(`-preflight-mekugi-${arm} --label`))!;
    expect(preflight).toContain("--network none");
    expect(preflight).toContain(`--deduplicate-output=${treatment}`);
    expect(preflight).toContain("codex --version");
    expect(preflight).toContain(`${join(run, "artifacts/preflight-mekugi", arm)}:/mekugi-exports`);
    const stagedHome = preflight.match(/-v (\S+):\/home\/ubuntu /)![1]!;
    expect(preflight).toContain(`${stagedHome}:${snapshot.source_home} `);
    expect(launch).toContain(`${join(run, dirname(state.arms[arm].repository), "home/ubuntu/.codex")}:/runtime-state/codex`);
    expect(launch).not.toContain(`${snapshot.source_home}:${snapshot.source_home}`);
    expect(log.indexOf(preflight)).toBeLessThan(log.indexOf(launch));
    expect(launch).toContain(`${dirname(join(run, state.mekugi_exports_by_arm![arm]!.capture))}:/mekugi-exports`);
    expect(launch).toContain(`${state.runtime_tools.current_setup_installs}:${state.runtime_tools.current_setup_installs}:ro`);
  }
}, 30_000);

test("retired journal comparisons and prepared flags fail before containers", async () => {
  await expect(prepare({ ...mekugiComparisonOptions(), comparison: "journal-compaction" }))
    .rejects.toThrow("retired");
  const run = await prepare(mekugiComparisonOptions());
  const original = await readState(run);
  for (const changed of [
    { ...original, comparison: "journal-compaction" as const },
    { ...original, mekugi_flags: ["--mode=mekugi"] },
  ]) {
    await writeState(run, changed);
    await expect(preflightRun(run, "/must-not-be-launched")).rejects.toThrow();
  }
});

test("stock-mekugi records an optional shared compaction limit for both arms", async () => {
  const options = { ...mekugiComparisonOptions(), comparison: "stock-mekugi" as const };
  expect((await readState(await prepare(options))).auto_compact_limit).toBe(4096);
  expect((await readState(await prepare({ ...options, autoCompactLimit: undefined }))).auto_compact_limit).toBeUndefined();
  await expect(prepare({ ...options, autoCompactLimit: 0 })).rejects.toThrow("must be a positive integer");
});

test("duplicate-output rejects an unsupported enabled treatment before launching either arm", async () => {
  const run = await prepare({ ...mekugiComparisonOptions(), comparison: "duplicate-output", autoCompactLimit: undefined });
  const state = await readState(run);
  const fake = await fakeOwnedDocker(0);
  await file(fake.path, (await readFile(fake.path, "utf8")).replace("      *-preflight-grok)", `      *-preflight-mekugi-current) echo unsupported-duplicate-output >&2; status=2 ;;
      *-preflight-grok)`), 0o755);
  const auth = join(root, "unsupported-duplicate-output-auth.json");
  await file(auth, "{}\n", 0o600);
  await expect(runPair({ runDir: run, authFile: auth, dockerBin: fake.path }))
    .rejects.toThrow("selected Mekugi launcher failed before inference: unsupported-duplicate-output");
  const log = await readFile(fake.log, "utf8");
  expect(log).toContain("--deduplicate-output=false");
  expect(log).toContain("--deduplicate-output=true");
  for (const arm of ["stock", "current"]) expect(log).not.toContain(`--name codex-ab-${state.id}-${arm} --label`);
});

test("duplicate-output owns its boolean treatment and rejects asymmetric boundaries", async () => {
  const options = { ...mekugiComparisonOptions(), comparison: "duplicate-output" as const, autoCompactLimit: undefined };
  for (const mekugiFlags of [["--deduplicate-output"], ["--deduplicate-output=false"], ["--deduplicate-output=true"]]) {
    await expect(prepare({ ...options, mekugiFlags })).rejects.toThrow("owns its treatment flag");
  }
  await expect(prepare({ ...options, protectMekugi: true })).rejects.toThrow("same ordinary container boundary");
  await expect(prepare({ ...options, autoCompactLimit: 4096 })).rejects.toThrow("requires stock-mekugi");
});

test("duplicate-output preflight rejects replay drift and binary tampering", async () => {
  const run = await prepare({ ...mekugiComparisonOptions(), comparison: "duplicate-output",
    autoCompactLimit: undefined });
  const original = await readState(run);
  const tamperers: Array<(state: typeof original) => void> = [
    state => { state.auto_compact_limit = 4096; },
    state => { state.mekugi_flags = ["--deduplicate-output=false"]; },
    state => { state.arms.stock.home_template = "snapshots/stock/home/ubuntu"; },
    state => { state.execution.current_launcher = "codex"; },
    state => { delete state.mekugi_exports_by_arm!.stock; },
    state => { delete state.mekugi_exports_by_arm!.current; },
    state => { state.mekugi_exports_by_arm!.current!.capture = "artifacts/stock/mekugi/capture.jsonl"; },
    state => { state.mekugi_exports_by_arm!.current!.metrics = "artifacts/stock/mekugi/metrics.json"; },
    state => { delete state.runtime_tools.mekugi_sha256; },
    state => { delete state.runtime_tools.mekugi_exec_source; delete state.runtime_tools.mekugi_exec_sha256; },
  ];
  for (const tamper of tamperers) {
    const changed = structuredClone(original);
    tamper(changed);
    await expect(verifyPreparedInputs(run, changed)).rejects.toThrow();
  }
  await file(join(run, original.arms.current.home_template, ".local/bin/mekugi"), "#!/bin/sh\nexit 7\n", 0o755);
  await expect(preflightRun(run, "/must-not-be-launched")).rejects.toThrow("changed");
});

test("stock-mekugi CLI records the compact limit and restricts it to prepare", async () => {
  let stdout = "";
  const capture = spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stdout += chunk.toString(); return true;
  }) as typeof process.stdout.write);
  try {
    expect(await main(["prepare", "--source", source, "--base", base, "--forbidden", future,
      "--task", task, "--criteria", fixtureCriteria, "--current-home", home,
      "--codex-bin", join(home, ".local/bin/codex"), "--mekugi-bin", join(home, "go/bin/mekugi"),
      "--output-parent", root, "--comparison", "stock-mekugi", "--auto-compact-limit", "8192",
      "--mekugi-source", mekugiSource])).toBe(0);
  } finally { capture.mockRestore(); }
  expect((await readState(stdout.trim())).auto_compact_limit).toBe(8192);
  for (const command of ["run", "prepare-trials", "prepare-suite"]) {
    await expect(main([command, "--auto-compact-limit", "4096"])).rejects.toThrow("unknown option");
  }
});

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

  await writeFile(join(isolatedHome, ".codex/config.toml"), 'model = "some-other-model"\nmodel_reasoning_effort = "xhigh"\nservice_tier = "default"\n');
  const captureSource = join(root, "stock-mekugi-minimal-capture-source");
  await mkdir(captureSource, { recursive: true });

  const run = await prepare({ source, baseCommit: base, forbiddenCommit: future, taskPath: task,
    criteriaPath: fixtureCriteria, outputParent: root, currentHome: isolatedHome, image: "fixture-image",
    cpus: "2", memory: "4g", timeoutSeconds: 30, comparison: "stock-mekugi",
    mekugiFlags: [], mekugiSource: captureSource });
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
    mekugiFlags: [], mekugiSource: captureSource });
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
  const options = { source, baseCommit: base, forbiddenCommit: future, taskPath: task,
    criteriaPath: fixtureCriteria, outputParent: root, currentHome: home, image: "fixture-image",
    cpus: "2", memory: "4g", timeoutSeconds: 30, comparison: "codex-mekugi-grok" as const,
    mekugiFlags: [], mekugiSource: captureSource, grokBinary: grokBin };
  await expect(prepare({ ...options, mekugiFlags: ["--grok=false"] })).rejects.toThrow("unsupported");
  const run = await prepare(options);
  const state = await readState(run);
  expect(state.execution).toMatchObject({ current_launcher: "grok", model: "grok:grok-4.7", reasoning_effort: "high", service_tier: "default" });
  expect(await readFile(join(run, "snapshots/stock-mekugi/home/ubuntu/.codex/config.toml"), "utf8"))
    .toContain('model_reasoning_effort = "high"');
  expect(await readFile(join(run, "snapshots/stock-grok/home/ubuntu/.grok/config.toml"), "utf8"))
    .toContain('default_reasoning_effort = "high"');
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
  const launches = (await readFile(fake.log, "utf8")).split("\n").filter(line => (line.includes(" exec --json ") || line.includes(" headless --yolo ")) || line.includes(" grok --prompt-file "));
  expect(launches.some(line => line.includes(" mekugi --capture-output=/mekugi-exports/capture.jsonl --debug headless --yolo ") && line.includes(" --model grok:grok-4.7 ") && line.includes('model_reasoning_effort="high"'))).toBe(true);
  expect(launches.some(line => line.includes(" grok --prompt-file /control/task.md --cwd /workspace -m grok-4.7 --reasoning-effort high ") && line.includes("GROK_HOME=/home/ubuntu/.grok"))).toBe(true);
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
  for (const script of state.protected_runtime!.scripts) {
    expect(await readFile(join(run, script.path), "utf8")).not.toMatch(/BENCH|benchmark|codex-ab/);
  }
  expect(state.execution.current_launcher).toBe("mekugi");
  expect(state.arms.stock.home_template).toBe(state.arms.current.home_template);
  await verifyPreparedInputs(run, state);
  const auth = join(root, "protected-auth.json");
  await file(auth, "{}\n", 0o600);
  const fake = await fakeOwnedDocker(0);
  const wrong = await fakeOwnedDocker(0, false, false, "", true);
  await expect(preflightRun(run, wrong.path)).rejects.toThrow("container Codex hash differs from prepared source");
  await runPair({ runDir: run, authFile: auth, dockerBin: fake.path });
  const launches = (await readFile(fake.log, "utf8")).split("\n").filter(line => (line.includes(" exec --json ") || line.includes(" headless --yolo ")));
  expect(launches.find(line => line.includes(" mise exec -- codex exec "))!).not.toContain("--cap-add");
  expect(launches.find(line => line.includes(" mise exec -- sh -c "))!).toContain("--cap-add SYS_ADMIN");
  expect(launches.find(line => line.includes(" mise exec -- sh -c "))!).toContain("/usr/local/libexec/mekugi-agent-check.py:ro");
  expect(launches.find(line => line.includes(" mise exec -- sh -c "))!).toContain("--tmpfs /mekugi-debug:size=4g,mode=0700");
  expect(launches.find(line => line.includes(" mise exec -- sh -c "))!).toContain("--tmpfs /mekugi-runtime/state/mekugi/debug:size=4g,mode=0700");
  expect(launches.find(line => line.includes(" mise exec -- sh -c "))!).toContain("MEKUGI_DEBUG_TMPDIR=/mekugi-debug");
  const preflight = (await readFile(fake.log, "utf8")).split("\n").find(line => line.includes("-isolation-probe") && line.includes(" create "))!;
  expect(preflight).toContain("mekugi-metrics mekugi");
  expect(preflight).toContain("--debug --capture-output=/mekugi-exports/capture.jsonl codex --version");
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
  await file(join(build, "bin/mekugi-exec"), "#!/bin/sh\nexit 0\n", 0o755);
  await file(join(build, "bin/mekugi"), "#!/bin/sh\nexec \"$@\"\n", 0o755);
  for (const name of ["build.stdout", "build.stderr", "build-result.json"]) await file(join(build, name), "fixture\n");
  await file(join(build, "build.json"), JSON.stringify({ schema: "codex-ab.mekugi-build.v1",
    image_id: `sha256:${"a".repeat(64)}`, source_archive_sha256: await sha256(join(build, "source.tar")),
    archiver_sha256: await sha256(join(build, "build_inputs.py")), command: ["go", "build"],
    binaries: { mekugi: await sha256(join(build, "bin/mekugi")), mekugi_exec: await sha256(join(build, "bin/mekugi-exec")) } }));
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
  expect(state.mekugi_build?.files).toHaveLength(8);
  expect(await readFile(join(run, "artifacts/mekugi-build/source/dirty-guidance.md"), "utf8")).toContain("uncommitted");
  const grok = join(root, "build-grok");
  await file(grok, "#!/bin/sh\necho grok 1.0.30\n", 0o755);
  const grokRun = await prepare({ ...buildOptions, comparison: "codex-mekugi-grok",
    mekugiFlags: [], grokBinary: grok });
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
  const movedPrototype = `${run}-moved`;
  await rename(run, movedPrototype);
  try {
    const trial = (await readTrialSet(trials)).trials[0]!;
    const directory = join(trials, trial.run_dir);
    await preflightRun(directory, fake.path);
    expect(await readFile(fake.log, "utf8")).not.toContain(":/home/ubuntu/.local/bin/mekugi:ro");
  } finally { await rename(movedPrototype, run); }
  expect(await Bun.file(join(run, "artifacts/mekugi-build/source/dirty-guidance.md")).exists()).toBe(true);
  await file(join(run, "reports/report.json"), "{}");
  await file(join(run, "reports/report.md"), "fixture report");
  await bundles.collectBundle(run);
  expect(await sha256(join(run, "reports/bundle/mekugi-build/source.tar"))).toBe(state.mekugi_build!.identity.source_archive_sha256);
  await file(join(run, "artifacts/mekugi-build/source.tar"), "changed");
  await expect(verifyPreparedInputs(run, state)).rejects.toThrow("build input changed");
});

test("Mekugi argument arrays cannot redirect benchmark-owned exports", () => {
  expect(parseMekugiFlags('["--deduplicate-output=false"]')).toEqual(["--deduplicate-output=false"]);
  for (const value of ['["codex"]', '["--capture-output=/tmp/elsewhere"]', '["--config=other"]', '{}', '[3]']) {
    expect(() => parseMekugiFlags(value)).toThrow();
  }
  expect(() => parseMekugiFlags('["--model-protocol=native"]')).toThrow();
  expect(() => parseMekugiFlags('["--debug=false"]')).toThrow();
  expect(parseMekugiFlags('["--shell-guard=false","--ansi-faint=off"]')).toEqual(["--shell-guard=false", "--ansi-faint=off"]);
});

test("task-pack CLI freezes pinned controls without exposing checks to either arm", async () => {
  const directory = join(root, "portable-pack");
  await file(join(directory, "task.md"), "Improve the fixture.\n");
  await file(join(directory, "manifest.json"), JSON.stringify({
    schema: "codex-ab.task-pack.v1", id: "fixture-pack", prompt: "task.md",
    source: { repository: "https://example.test/fixture.git", base_commit: base, forbidden_commit: future, reference_commit: future },
    criteria: { schema: "codex-ab.criteria.v1", criteria: [{ id: "fixture", description: "Improve the fixture" }],
      preparation: "true", existing_tests: "true", existing_test_verification: fixtureVerification, evaluator_controls: fixtureControls, qualification: "not-run" },
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
  expect(state.upstream_reference).toMatchObject({ base_commit: base, end_commit: future });
  const index = await Bun.file(join(run, "evaluator/upstream/index.json")).json();
  expect(index.commits).toEqual([{ commit: future, subject: "future", patch: `${future}.patch` }]);
  const patch = join(run, `evaluator/upstream/${future}.patch`), original = await readFile(patch, "utf8");
  expect(original).toContain("+oracle that arms must not see");
  for (const arm of ["stock", "current"] as const) {
    expect(await Bun.file(join(run, state.arms[arm].repository, "manifest.json")).exists()).toBe(false);
    expect(await Bun.file(join(run, state.arms[arm].repository, "future.txt")).exists()).toBe(false);
    expect(await Bun.spawn(["git", "-C", join(run, state.arms[arm].repository), "cat-file", "-e", `${future}^{commit}`], { stderr: "ignore" }).exited).not.toBe(0);
  }
  await verifyPreparedInputs(run, state);
  state.pricing = { fetched_at: new Date().toISOString(), source: "fallback", catalog_url: "fixture", assumptions: [], warnings: [], models: {} };
  await writeState(run, state);
  const auth = join(root, "pack-auth.json"); await file(auth, "{}\n", 0o600);
  const fake = await fakeOwnedDocker(0);
  const trials = await prepareTrials({ runDir: run, count: 2, outputParent: root, dockerBin: fake.path });
  const trial = join(trials, (await readTrialSet(trials)).trials[0]!.run_dir);
  expect((await readState(trial)).upstream_reference).toEqual(state.upstream_reference);
  expect(await sha256(join(trial, `evaluator/upstream/${future}.patch`))).toBe(await sha256(patch));
  await runBenchmark({ runDir: run, authFile: auth, dockerBin: fake.path });
  expect(await sha256(join(run, "reports/bundle/task-pack.json"))).toBe(state.task_pack!.sha256);
  for (const file of state.upstream_reference!.files) {
    expect(await sha256(join(run, "reports/bundle/upstream", basename(file.path)))).toBe(file.sha256);
  }
  const log = await readFile(fake.log, "utf8");
  const judgeLaunches = log.split("\n").filter(line => line.includes(" create ") && /-judge-[12]-(?:harness|assessment)/.test(line));
  expect(judgeLaunches).toHaveLength(4);
  for (const launch of judgeLaunches) expect(launch).toContain(`${join(run, "evaluator/upstream")}:/reference:ro`);
  const agentLaunches = log.split("\n").filter(line => line.includes(" create ") && ["stock", "current"].some(arm => line.includes(` --name codex-ab-${state.id}-${arm} `)));
  expect(agentLaunches).toHaveLength(2);
  for (const launch of agentLaunches) expect(launch).not.toContain("/reference");
  for (const pass of [1, 2]) for (const stage of ["harness-1", "assessment"]) {
    const prompt = await readFile(join(fake.stateDir, `codex-ab-${state.id}-judge-${pass}-${stage}-1.prompt`), "utf8");
    expect(prompt).toContain("Read index.json, relevant commit patches, and changes.patch");
    expect(prompt).toContain("Assess final results, not candidate commit correspondence");
    if (stage === "assessment") {
      expect(prompt).toContain("Lead with the decisive implementation difference");
      expect(prompt).toContain("at most three short sentences");
      expect(prompt).toContain("do not infer them from source quality");
      expect(prompt).not.toContain("input_tokens");
    }
  }
  expect(await readFile(join(run, "reports/report.md"), "utf8")).toContain("Task pack: fixture-pack");
  await writeFile(patch, `${original}\nchanged`);
  await expect(verifyPreparedInputs(run, state)).rejects.toThrow("upstream reference changed");
  await writeFile(patch, original);
  await file(join(run, state.task_pack!.path), "{}");
  await expect(verifyPreparedInputs(run, state)).rejects.toThrow("control changed");
  await expect(main(["prepare", "--task-pack", join(directory, "manifest.json")])).rejects.toThrow("requires --source");
  await expect(main(["prepare", "--task-pack", join(directory, "manifest.json"), "--source", source, "--base", base])).rejects.toThrow("cannot override");
});
