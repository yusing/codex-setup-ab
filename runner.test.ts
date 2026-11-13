import { expect, spyOn, test } from "bun:test";
import { chmod, cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { verifyPreparedInputs, verifySubmodules, initializeSubmodules, verifyRepositoryIsolation, verifyGodoxyIdentity, GODOXY_ICONS } from "./prepare";
import { runBenchmark } from "./workflow";
import { main } from "./cli";
import { checked } from "./process";
import { readState, writeState, sha256 } from "./state";
import { preflightRun, runPair } from "./runner";
import * as containers from "./container";
import { buildReport } from "./report";
import { type PricingSnapshot } from "./usage";
import { readToolStoreManifest } from "./snapshot";
import { miseToolMounts } from "./isolation";
import { runnerFixture } from "./test-support/runner-fixture";

const { root, source, home, task, fixtureCriteria, base, future, brewPrefix, file, prepare, prepared, fakeOwnedDocker } = await runnerFixture();

test.each(["absent", "disabled", "enabled"])("preflight checks the environment without executing optional guidance (%s skill)", async availability => {
  const configuredHome = join(root, `guidance-home-${availability}`);
  await cp(home, configuredHome, { recursive: true, verbatimSymlinks: true });
  await file(join(configuredHome, ".skills-mgr/.skills-mgr.json"), JSON.stringify({ schema_revision: 3,
    skills: availability === "absent" ? {} : { "use-modern-go": { enabled: availability === "enabled" ? "lang go" : false, remote: { name: "use-modern-go" } } } }));
  await file(join(configuredHome, ".codex/hooks.json"), JSON.stringify({ hooks: { PostToolUse: [
    { hooks: [{ type: "command", command: "/home/ubuntu/.codex/hooks/bin/go_guidelines" }] },
  ] } }));
  const run = await prepared(30, "codex", configuredHome);
  const fake = await fakeOwnedDocker(0);
  const script = await readFile(fake.path, "utf8");
  await file(fake.path, script.replace("    status=0", `    status=0
    case "$(cat '${fake.stateDir}/'$name)" in
      *'skills-mgr get '*|*'skills-mgr list'*|*'rtk --version'*|*'/hooks/bin/'*) echo unexpected-guidance-check >&2; status=31 ;;
    esac`));
  await preflightRun(run, fake.path);
  const state = await readState(run);
  expect(state.status).toBe("prepared");
  expect(state.preflight?.status).toBe("complete");
  expect(state.arm_attempts).toBeUndefined();
  expect(await Bun.file(join(fake.stateDir, `network-codex-ab-${state.id}-preflight-provider`)).exists()).toBe(false);
  const log = await readFile(fake.log, "utf8");
  expect(log).toContain("mise ls --current --missing --no-header");
  expect(log).toContain("-preflight-environment-stock");
  expect(log).toContain("-preflight-environment-current");
  expect(log).toContain("for interpreter in python python3");
  expect(log).not.toContain("go generate");
  expect(log).not.toContain("-preflight-compile");
  expect(log).toContain(" bun -e ");
  expect(log).not.toContain(`${state.runtime_tools.bun}:/usr/local/bin/bun`);
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

test("benchmark attributes a preflight failure to preflight while retaining its report", async () => {
  const run = await prepared();
  const fake = await fakeOwnedDocker(0, false, false, "", false, true);
  await expect(runBenchmark({ runDir: run, authFile: "/unused-auth", dockerBin: fake.path })).rejects.toThrow("cannot reach the chatgpt provider");
  const failed = await readState(run);
  expect(failed.preflight?.status).toBe("failed");
  expect(failed.preflight?.error).toContain("cannot reach the chatgpt provider");
  expect(failed.finishing).toMatchObject({ status: "complete" });
  expect(failed.finishing?.error).toBeUndefined();
  expect(failed.arm_attempts).toBeUndefined();
  expect(failed.judge).toBeUndefined();
  const report = await Bun.file(join(run, "reports/bundle/report.json")).json();
  expect(report.preflight).toEqual(failed.preflight);
  expect(report.measurement_complete).toBe(false);
  expect(await Bun.file(join(run, "reports/report.md")).text()).toContain(`preflight: ${failed.preflight!.error}`);
  const log = await readFile(fake.log, "utf8");
  expect(log).not.toContain("-warm ");
  expect(log).not.toContain("-judge-");
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

test("preflight pins shared dependencies without repeating task preparation or tests", async () => {
  const run = await prepared();
  const fake = await fakeOwnedDocker(0);
  await preflightRun(run, fake.path);
  const state = await readState(run);
  expect(state.dependency_image?.image_id).toBe(`sha256:${"a".repeat(64)}`);
  const log = await readFile(fake.log, "utf8");
  expect(log).not.toContain("-preflight-compile");
  expect(log).not.toContain("-semantic-");
  expect(log).not.toContain("preflight-cache");
});

test("preflight qualifies the immutable image in one credential-free owned lifecycle", async () => {
  const run = await prepared();
  const fake = await fakeOwnedDocker(0);
  await preflightRun(run, fake.path);
  const log = (await readFile(fake.log, "utf8")).split("\n");
  const creates = log.filter(line => line.includes(" create ") && /-preflight-(image|identity|hash|toolhost) /.test(line));
  expect(creates).toHaveLength(1);
  expect(creates[0]).toContain("--network none sha256:");
  expect(creates[0]).not.toContain(" -v ");
  expect(creates[0]).not.toContain("--env");
  const state = await readState(run);
  expect(await Bun.file(join(fake.stateDir, `codex-ab-${state.id}-preflight-image`)).exists()).toBe(false);
});

test("preflight bounds a stalled image qualification attachment and verifies cleanup", async () => {
  const run = await prepared();
  const fake = await fakeOwnedDocker(0);
  await file(fake.path, (await readFile(fake.path, "utf8")).replace("*-preflight-image) printf", "*-preflight-image) sleep 1; printf"), 0o755);
  const original = containers.runOwnedContainer;
  let qualificationTimeout: number | undefined;
  const owned = spyOn(containers, "runOwnedContainer").mockImplementation(options => {
    if (!options.name.endsWith("-preflight-image")) return original(options);
    qualificationTimeout = options.timeoutMs;
    return original({ ...options, timeoutMs: options.timeoutMs === undefined ? undefined : 100 });
  });
  try {
    await expect(preflightRun(run, fake.path)).rejects.toThrow("immutable image qualification failed: Docker attachment timed out");
    expect(qualificationTimeout).toBe(30_000);
    expect(await Bun.file(join(fake.stateDir, `codex-ab-${(await readState(run)).id}-preflight-image`)).exists()).toBe(false);
  } finally { owned.mockRestore(); }
});

test.each([
  ["codex_path=/usr/local/bin/codex", "codex_path=/wrapped/codex", "image Codex is not the direct"],
  ["1000:1000", "0:0", "container operator identity must be 1000:1000, got 0:0"],
  ["CODEX_AB_TOOL_HOST_OK", "wrong protocol result", "code-mode tool host smoke failed: wrong protocol result"],
])("preflight preserves the diagnostic for %s", async (before, after, message) => {
  const run = await prepared();
  const fake = await fakeOwnedDocker(0);
  await file(fake.path, (await readFile(fake.path, "utf8")).replace(before, after), 0o755);
  await expect(preflightRun(run, fake.path)).rejects.toThrow(message);
  expect((await readState(run)).status).toBe("prepared");
  expect(await Bun.file(join(fake.stateDir, `codex-ab-${(await readState(run)).id}-preflight-image`)).exists()).toBe(false);
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
  await expect(preflightRun(run, fake.path)).rejects.toThrow("container Codex hash differs from prepared source");
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

test("Rust tools outside the mise store are recorded, mounted read-only, and verified", async () => {
  const privateHome = join(root, "rust-runtime-home");
  await cp(home, privateHome, { recursive: true });
  const cargoBin = join(privateHome, ".cargo/bin"), rustup = join(privateHome, ".rustup");
  await file(join(cargoBin, "rustup"), "rustup fixture", 0o755);
  await symlink("rustup", join(cargoBin, "rustc"));
  await file(join(rustup, "toolchains/fixture/bin/rustc"), "rustc fixture", 0o755);
  await mkdir(join(privateHome, ".local/share/mise/installs/rust"));
  await symlink(cargoBin, join(privateHome, ".local/share/mise/installs/rust/1"));
  const run = await prepared(30, "codex", privateHome);
  const state = await readState(run);
  const manifest = await readToolStoreManifest(join(run, state.runtime_tools.current_setup_files));
  expect(manifest.rust!.cargo_files.every(file => file.sha256 === undefined)).toBe(true);
  await verifyPreparedInputs(run, state);
  const parse = spyOn(JSON, "parse");
  try {
    const mounts = await miseToolMounts(run, state);
    for (let call = 0; call < 5; call++) expect(await miseToolMounts(run, state)).toEqual(mounts);
    expect(parse).not.toHaveBeenCalled();
  } finally { parse.mockRestore(); }
  const auth = join(root, "rust-auth.json"); await file(auth, "{}", 0o600);
  const fake = await fakeOwnedDocker(0);
  expect((await runPair({ runDir: run, authFile: auth, dockerBin: fake.path })).status).toBe("complete");
  const calls = (await readFile(fake.log, "utf8")).split("\n").filter(line => line.includes(" create ") && line.includes("MISE_INSTALLS_DIR="));
  expect(calls.length).toBeGreaterThan(1);
  for (const call of calls) {
    expect(call).toContain(`${cargoBin}:${cargoBin}:ro`);
    expect(call).toContain(`${cargoBin}:/home/ubuntu/.cargo/bin:ro`);
    expect(call).toContain(`${rustup}:${rustup}:ro`);
    expect(call).toContain(`RUSTUP_HOME=${rustup}`);
    expect(call).toContain("MISE_AUTO_INSTALL=0");
  }
  await file(join(rustup, "toolchains/fixture/bin/rustc"), "changed toolchain");
  await expect(verifyPreparedInputs(run, await readState(run))).rejects.toThrow("Rust runtime changed");
  await writeFile(join(run, state.runtime_tools.current_setup_files), "changed inventory");
  await expect(verifyPreparedInputs(run, state)).rejects.toThrow("snapshotted current setup file manifest changed");
});
test("Linuxbrew drift and missing offline environment tools stop before inference", async () => {
  const run = await prepared();
  const state = await readState(run);
  const manifest = await readToolStoreManifest(join(run, state.runtime_tools.current_setup_files));
  expect(manifest.linuxbrew?.prefix).toBe(brewPrefix);
  const extra = join(brewPrefix, "bin/new-tool");
  await file(extra, "changed installation");
  try {
    await expect(preflightRun(run, "/must-not-run")).rejects.toThrow("Linuxbrew installation changed");
  } finally { await rm(extra); }
  const fake = await fakeOwnedDocker(0);
  await file(fake.path, (await readFile(fake.path, "utf8")).replace("*-preflight-environment-*) : ;;", "*-preflight-environment-*) echo 'task Python missing' >&2; status=127 ;;"), 0o755);
  await expect(preflightRun(run, fake.path)).rejects.toThrow("candidate environment preflight failed");
  expect((await readFile(fake.log, "utf8"))).not.toContain(" exec --json ");
  expect((await readState(run)).status).toBe("prepared");
});
test("a dangling login profile preserves the captured shell fallback", async () => {
  const privateHome = join(root, "dangling-profile-home");
  await cp(home, privateHome, { recursive: true });
  await rm(join(privateHome, ".bash_profile"));
  await symlink("missing-profile", join(privateHome, ".bash_profile"));
  await file(join(privateHome, ".profile"), 'export PROFILE_FALLBACK=loaded\nexport PATH="/fallback-python/bin:$PATH"\n');
  await checked(["git", "-C", privateHome, "add", ".profile"]);
  const run = await prepared(30, "codex", privateHome);
  const state = await readState(run);
  const template = join(run, state.arms.current.home_template);
  const result = await checked(["bash", "--noprofile", "--norc", "-c", '. "$HOME/.bash_profile"; printf "%s:%s" "$PROFILE_FALLBACK" "$PATH"'], { env: { HOME: template } });
  expect(result.stdout).toStartWith("loaded:/opt/task-deps/python/bin:/fallback-python/bin:");
});
test("Mekugi rejects changed controls and snapshot files before Docker is invoked", async () => {
  for (const path of ["control/task.md", "evaluator/criteria.json", "snapshots/current/home/ubuntu/AGENTS.md", "snapshots/stock/home/ubuntu/AGENTS.md"]) {
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
  expect(log).toContain(`${state.runtime_tools.current_setup_installs}:${state.runtime_tools.current_setup_installs}:ro`);
  const agentWarmCalls = log.split("\n").filter(line => line.includes(" create ") && /-agent-warm /.test(line));
  expect(agentWarmCalls).toHaveLength(2);
  expect(agentWarmCalls.every(line => line.includes("--network none") && !line.includes("go-pkg-cache"))).toBe(true);
  expect(log).not.toContain("grader-go-pkg-cache");
  expect(log).not.toContain("grader-bun-cache");
  expect(agentWarmCalls.every(line => line.includes("/repo:/workspace"))).toBe(true);
  expect(log).not.toContain("-evaluator-warm ");
  const candidateChecks = log.split("\n").filter(line => line.includes(" create ") && line.includes("-grade-verify "));
  expect(candidateChecks).toHaveLength(4);
  expect(candidateChecks.every(line => line.includes("--network none"))).toBe(true);
  const agentContainers = log.split("\n").filter(line => ["stock", "current"].some(arm => line.includes(`--name codex-ab-${state.id}-${arm} --label `)));
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

test("current-only execution launches Mekugi and finishes without a stock agent or judge", async () => {
  const run = await prepared(30, "mekugi");
  const auth = join(root, "current-only-auth.json"); await file(auth, "{}\n", 0o600);
  const fake = await fakeOwnedDocker(0);
  await runBenchmark({ runDir: run, authFile: auth, dockerBin: fake.path, arm: "current" });
  const state = await readState(run);
  expect(state.status).toBe("complete");
  expect(state.selected_arms).toEqual(["current"]);
  expect(Object.keys(state.results!)).toEqual(["current"]);
  expect(Object.keys(state.arm_attempts!)).toEqual(["current"]);
  expect(state.finishing?.status).toBe("complete");
  expect(state.judge).toBeUndefined();
  const log = await readFile(fake.log, "utf8");
  expect(log).toContain(" mise exec -- mekugi codex headless --yolo ");
  expect(log).not.toContain(` create --rm --name codex-ab-${state.id}-stock --label `);
  expect(log).not.toContain("-stock-agent-warm ");
  expect(await readFile(join(run, "reports/report.md"), "utf8")).toContain("This single-arm run has no paired winner.");
  expect(await Bun.file(join(run, "reports/bundle/MANIFEST.sha256")).exists()).toBe(true);
});
test("current arm can launch through the snapshotted Mekugi wrapper", async () => {
  const run = await prepared(30, "mekugi");
  const stateBefore = await readState(run);
  expect(stateBefore.execution.current_launcher).toBe("mekugi");
  expect(stateBefore.runtime_tools.mekugi_sha256).toBe(await sha256(join(home, "go/bin/mekugi")));
  expect(await Bun.file(join(run, "snapshots/current/home/ubuntu/.local/bin/mekugi")).exists()).toBe(false);
  expect(await Bun.file(join(run, "snapshots/current/home/ubuntu/.local/bin/shell")).exists()).toBe(false);
  const auth = join(root, "mekugi-auth.json"); await file(auth, "{}\n", 0o600); await chmod(auth, 0o600);
  const fake = await fakeOwnedDocker(0);
  const state = await runPair({ runDir: run, authFile: auth, dockerBin: fake.path });
  expect(state.status).toBe("complete");
  const log = await readFile(fake.log, "utf8");
  expect(log).toContain(" mise exec -- mekugi codex headless --yolo ");
});

test("Mekugi executable absence and tampering fail before any container or inference", async () => {
  const run = await prepared(30, "mekugi");
  const missingSource = await readState(run);
  delete missingSource.runtime_tools.mekugi_source;
  await writeState(run, missingSource);
  await expect(preflightRun(run, "/must-not-be-launched")).rejects.toThrow("snapshotted Mekugi changed");

  const changedRun = await prepared(30, "mekugi");
  await file(join(changedRun, "snapshots/current/home/ubuntu/.local/bin/mekugi"), "#!/bin/sh\nexit 0\n", 0o755);
  await expect(preflightRun(changedRun, "/must-not-be-launched")).rejects.toThrow("current setup snapshot changed");

  const missingHashRun = await prepared(30, "mekugi");
  const state = await readState(missingHashRun);
  delete state.runtime_tools.mekugi_sha256;
  await writeState(missingHashRun, state);
  await expect(preflightRun(missingHashRun, "/must-not-be-launched")).rejects.toThrow("snapshotted Mekugi changed");
});

test("prepare pins the executable Mekugi pair", async () => {
  const options = {
    source, baseCommit: base, forbiddenCommit: future, taskPath: task, criteriaPath: fixtureCriteria,
    outputParent: root, currentHome: home, image: "fixture-image", cpus: "2", memory: "4g", timeoutSeconds: 30,
    codexBinary: join(home, ".local/bin/codex"), currentLauncher: "mekugi" as const,
    mekugiBinary: join(root, "missing-mekugi"),
  };
  await expect(prepare(options)).rejects.toThrow("ENOENT");
  const nonExecutable = join(root, "non-executable-mekugi");
  await file(nonExecutable, "fixture\n", 0o644);
  await expect(prepare({ ...options, mekugiBinary: nonExecutable })).rejects.toThrow("Mekugi launcher is not executable");

  const selectedMekugi = join(root, "separate-bin/mekugi");
  const selectedContent = "#!/bin/sh\nexec \"$@\"\n";
  await file(selectedMekugi, selectedContent, 0o755);
  await expect(prepare({ ...options, mekugiBinary: selectedMekugi })).rejects.toThrow("ENOENT");
  await file(join(root, "separate-bin/mekugi-exec"), "#!/bin/sh\nexit 0\n", 0o755);
  const run = await prepare({ ...options, mekugiBinary: selectedMekugi });
  const state = await readState(run);
  expect(state.runtime_tools.mekugi_source).toBe("snapshots/runtime/mekugi");
  expect(state.runtime_tools.mekugi_in_image).toBe(true);
  expect(state.runtime_tools.mekugi_sha256).toBe(await sha256(selectedMekugi));
  expect(await Bun.file(join(run, "snapshots/current/home/ubuntu/.local/bin/mekugi")).exists()).toBe(false);
  await verifyPreparedInputs(run, state);
  await file(selectedMekugi, "changed binary\n");
  await verifyPreparedInputs(run, state);
  const fake = await fakeOwnedDocker(0);
  await preflightRun(run, fake.path);
  expect(await readFile(resolve(run, state.runtime_tools.mekugi_source!), "utf8")).toBe(selectedContent);
  expect(state.runtime_tools.mekugi_exec_sha256).toBe(await sha256(join(run, state.runtime_tools.mekugi_exec_source!)));
  await file(resolve(run, state.runtime_tools.mekugi_exec_source!), "tampered helper\n");
  await expect(verifyPreparedInputs(run, state)).rejects.toThrow("Mekugi companion changed");
  await file(resolve(run, state.runtime_tools.mekugi_exec_source!), "#!/bin/sh\nexit 0\n", 0o755);
  await file(resolve(run, state.runtime_tools.mekugi_source!), "tampered snapshot\n");
  await expect(verifyPreparedInputs(run, state)).rejects.toThrow("snapshotted Mekugi changed");
});

test("runner records timeouts and stops its exact session containers", async () => {
  const run = await prepared(1);
  const auth = join(root, "timeout-auth.json"); await file(auth, "{}\n", 0o600); await chmod(auth, 0o600);
  const fake = await fakeOwnedDocker(2);
  const state = await runPair({ runDir: run, authFile: auth, dockerBin: fake.path });
  expect(state.results?.stock?.timed_out).toBe(true);
  expect(state.results?.current?.timed_out).toBe(true);
  expect(state.status).toBe("partial");
  expect(state.results?.stock?.grade).toBeUndefined();
  expect(state.results?.current?.grade).toBeUndefined();
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
