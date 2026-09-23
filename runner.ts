import { dependencyImage, ensureDependencyImage, generatedDependencyDirectories } from "./dependencies";
import { chmod, copyFile, cp, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { exec, checked, type ExecResult } from "./process";
import { createOwnedNetwork, OwnedContainerError, runOwnedContainer, withOwnedNetwork, type OwnedNetwork } from "./container";
import { initializeSubmodules, verifyGodoxyIdentity, verifyPreparedInputs } from "./prepare";
import candidateSource from "./candidate-script.txt" with { type: "text" };
import { executorOwnership, protectedArgs, protectedPreflight } from "./isolation";
import { TOOLHOST_SMOKE_SCRIPT } from "./toolhost";
import { readState, writeState, withRunLock } from "./state";
import { importControl } from "./control";
import type { ArmName, ArmResult, CommandEvidence, RunState } from "./types";

export interface RunOptions { runDir: string; authFile: string; grokAuthFile?: string; dockerBin?: string; arm?: ArmName; controlRun?: string; controlBundleSha256?: string; signal?: AbortSignal }

const arms: ArmName[] = ["stock", "current"];
function progress(message: string): void { process.stderr.write(`[run] ${message}\n`); }

function prepareAssets(state: RunState): string {
  if (!state.criteria) throw new Error("run requires task-derived semantic criteria");
  return state.criteria.contract.preparation;
}

function containerArgs(state: RunState): string[] {
  return ["--cpus", state.resource_limits.cpus, "--memory", state.resource_limits.memory];
}

function currentSetupMounts(runDir: string, state: RunState, arm: ArmName = "current"): string[] {
  const usesCurrentSetup = state.comparison === "same-setup" || (state.mentor?.setup === "current")
    || (arm === "current" && state.comparison !== "stock-mekugi" && state.comparison !== "codex-mekugi-grok" && state.mentor?.setup !== "stock");
  if (!usesCurrentSetup) return [];
  return ["-v", `${resolve(runDir, state.runtime_tools.current_setup_installs)}:/home/ubuntu/.local/share/mise/installs:ro`];
}

function imageRef(state: RunState): string { return dependencyImage(state); }

async function inspectCandidate(docker: string, runDir: string, state: RunState, repository: string, label: string,
  signal: AbortSignal, baseline: boolean, clean: boolean, capture?: string, discardDependencies?: string[]): Promise<void> {
  const spec = { mode: capture ? "capture" : "verify", baseline, clean, discardDependencies, base: state.source.base_commit,
    tree: state.source.base_tree, forbidden: state.source.forbidden_commit, icons: state.profile === "godoxy-icons", submodules: state.submodules ?? [] };
  const result = await runOwnedContainer({ docker, name: `codex-ab-${state.id}-${label}`, signal, timeoutMs: 60_000,
    createArgs: [...containerArgs(state), "--network", "none", "-e", "GIT_OPTIONAL_LOCKS=0", "-v", `${repository}:/workspace${capture ? "" : ":ro"}`,
      "-v", `${resolve(runDir, state.runtime_tools.bun)}:/usr/local/bin/bun:ro`, ...(capture ? ["-v", `${capture}:/capture`] : []),
      imageRef(state), "bun", "-e", candidateSource, JSON.stringify(spec)] });
  if (result.exitCode !== 0 || result.timedOut || result.canceled) throw new Error(`candidate ${label} verification failed: ${result.stderr.trim()}`);
}

async function setupArm(runDir: string, state: RunState, arm: ArmName, authFile: string, grokAuthFile?: string): Promise<{ home: string; output: string }> {
  const armRoot = join(runDir, "arms", arm);
  const home = join(armRoot, "home/ubuntu");
  const output = join(runDir, "artifacts", arm);
  await cp(join(runDir, state.arms[arm].home_template), home, { recursive: true, force: false, verbatimSymlinks: true });
  await mkdir(join(home, ".codex"), { recursive: true, mode: 0o700 });
  await copyFile(authFile, join(home, ".codex/auth.json"));
  await chmod(home, 0o700);
  await chmod(join(home, ".codex"), 0o700);
  await mkdir(join(home, "go/pkg"), { recursive: true });
  await mkdir(join(home, ".local/share/mise/installs"), { recursive: true });
  await mkdir(join(home, ".bun/install/cache"), { recursive: true });
  if (state.comparison === "codex-mekugi-grok") {
    if (!grokAuthFile) throw new Error("codex-mekugi-grok requires --grok-auth-file");
    await mkdir(join(home, ".grok"), { recursive: true, mode: 0o700 });
    await copyFile(grokAuthFile, join(home, ".grok/auth.json"));
    await chmod(join(home, ".grok/auth.json"), 0o600);
  }
  await chmod(join(home, ".codex/auth.json"), 0o600);
  await mkdir(output, { recursive: true });
  return { home, output };
}

async function preflightChecks(docker: string, state: RunState, runDir: string, signal: AbortSignal): Promise<string> {
  await verifyPreparedInputs(runDir, state);
  if (state.profile === "godoxy-icons") verifyGodoxyIdentity(state.source, state.submodules);
  // Resolve the mutable tag before any checks, so every check and launch uses
  // the same image even if another process retags the operator's image.
  const reference = state.image_id ?? state.image;
  const inspected = await exec([docker, "image", "inspect", "--format", "{{.Id}}", reference], { signal });
  const image = inspected.stdout.trim();
  if (inspected.exitCode !== 0) {
    throw new Error(`cannot resolve immutable image ID for ${reference}: ${inspected.stderr.trim() || `docker image inspect exited ${inspected.exitCode}`}`);
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(image)) {
    throw new Error(`Docker returned an invalid image ID for ${reference}: ${image || "(empty output)"}`);
  }
  if (state.image_id && image !== state.image_id) throw new Error("prepared image changed");
  state.image_id = image;
  for (const arm of arms) await inspectCandidate(docker, runDir, state, resolve(runDir, state.arms[arm].repository), `preflight-${arm}-baseline`, signal, true, true);
  const prefix = `codex-ab-${state.id}-preflight`;
  progress(`checking bare Codex image ${image}`);
  const check = await runOwnedContainer({ docker, name: `${prefix}-image`, signal, createArgs: [image, "sh", "-lc", "printf 'codex_path=%s\\n' \"$(command -v codex || true)\"; if command -v hpatch >/dev/null || command -v mekugi >/dev/null; then printf 'mekugi_path=%s\\n' \"$(command -v mekugi)\"; exit 8; fi; codex --version"] });
  if (check.exitCode !== 0) throw new Error(`image is not a bare Codex image (${check.exitCode}): ${[check.stdout.trim(), check.stderr.trim()].filter(Boolean).join("; ")}`);
  if (!check.stdout.includes("codex_path=/usr/local/bin/codex")) throw new Error(`image Codex is not the direct /usr/local/bin/codex entry: ${check.stdout.trim()}`);
  const containerVersion = check.stdout.split("\n").map(line => line.trim()).find(line => line.startsWith("codex-cli "));
  if (containerVersion !== state.runtime_tools.codex_version) {
    throw new Error(`unexpected container Codex version: expected ${state.runtime_tools.codex_version}, got ${containerVersion ?? check.stdout.trim()}. Rebuild ${state.image} from the selected host Codex and prepare a new run; the preset runner does this automatically`);
  }
  const identity = await runOwnedContainer({ docker, name: `${prefix}-identity`, signal, createArgs: [image, "sh", "-lc", "printf '%s:%s\\n' \"$(id -u)\" \"$(id -g)\""] });
  const expectedIdentity = `${state.operator.uid}:${state.operator.gid}`;
  if (identity.exitCode !== 0 || identity.stdout.trim() !== expectedIdentity) throw new Error(`container operator identity must be ${expectedIdentity}, got ${identity.stdout.trim()}`);
  const binaryHash = await runOwnedContainer({ docker, name: `${prefix}-hash`, signal, createArgs: [image, "sha256sum", "/usr/local/bin/codex", "/usr/local/bin/codex-code-mode-host", ...(state.protected_runtime ? ["/usr/local/libexec/codex-real"] : [])] });
  const hashes = binaryHash.stdout.trim().split("\n").map(line => line.trim().split(/\s+/)[0]);
  if (binaryHash.exitCode !== 0 || hashes[0] !== state.runtime_tools.codex_sha256 || hashes[1] !== state.runtime_tools.codex_code_mode_host_sha256 || (state.protected_runtime && hashes[2] !== state.runtime_tools.codex_sha256)) {
    throw new Error(`container Codex hash differs from prepared source: ${binaryHash.stdout.trim()}`);
  }
  progress("checking required provider network reachability without model inference");
  const providerEndpoints = [
    ["chatgpt", "https://chatgpt.com/"],
    ...(state.comparison === "codex-mekugi-grok" ? [["grok", "https://cli-chat-proxy.grok.com/"]] : []),
  ];
  const networkChecks: Array<{ provider: string; endpoint: string; result: Awaited<ReturnType<typeof runOwnedContainer>> }> = [];
  await withOwnedNetwork(docker, `${prefix}-provider`, signal, async providerNetwork => {
    for (const [provider, endpoint] of providerEndpoints) {
      const result = await runOwnedContainer({ docker, name: `${prefix}-network-${provider}`, signal, timeoutMs: 30_000,
        createArgs: ["--network", providerNetwork, image, "curl", "--silent", "--show-error", "--output", "/dev/null", "--write-out", "%{http_code}",
          "--connect-timeout", "10", "--max-time", "20", endpoint] });
      networkChecks.push({ provider, endpoint, result });
      if (result.exitCode !== 0 || !/^[1-5][0-9]{2}$/.test(result.stdout.trim())) {
        await writeFile(join(runDir, "artifacts/preflight-network.json"), JSON.stringify(networkChecks, null, 2));
        throw new Error(`container cannot reach the ${provider} provider over its isolated Docker network: ${result.stderr.trim() || `curl exited ${result.exitCode}`}. Fix Docker DNS, IPv6, NAT, or firewall forwarding before starting paid inference`);
      }
    }
  });
  await writeFile(join(runDir, "artifacts/preflight-network.json"), JSON.stringify(networkChecks, null, 2));
  progress("exercising the local code-mode host protocol without model access");
  const toolHost = await runOwnedContainer({ docker, name: `${prefix}-toolhost`, signal, timeoutMs: 15_000, createArgs: ["--network", "none", image, "node", "-e", TOOLHOST_SMOKE_SCRIPT] });
  if (toolHost.exitCode !== 0 || toolHost.stdout.trim() !== "CODEX_AB_TOOL_HOST_OK") throw new Error(`code-mode tool host smoke failed: ${[toolHost.stdout.trim(), toolHost.stderr.trim()].filter(Boolean).join("; ")}`);
  const currentHome = resolve(runDir, state.arms.current.home_template);
  const workspace = resolve(runDir, state.arms.current.repository);
  if (state.comparison === "stock-mekugi" || state.comparison === "codex-mekugi-grok" || state.mentor?.setup === "stock") {
    const mekugiHome = resolve(runDir, state.comparison === "codex-mekugi-grok" ? state.arms.stock.home_template : state.arms.current.home_template);
    progress(state.comparison === "codex-mekugi-grok" ? "checking the isolated Codex+Mekugi and Grok setups offline" : "checking the minimal stock-plus-Mekugi setup offline");
    const dependencies = await runOwnedContainer({ docker, name: `${prefix}-setup`, signal, createArgs: ["--network", "none",
      "-v", `${mekugiHome}:/setup:ro`, image, "sh", "-lc",
      "cp -a /setup/. /home/ubuntu/ && export PATH=/home/ubuntu/.local/bin:/usr/local/bin:/usr/bin:/bin && test -r /home/ubuntu/.codex/config.toml && test -x /home/ubuntu/.local/bin/mekugi && test \"$(command -v shell)\" = /home/ubuntu/.local/bin/shell && (env -u MEKUGI_RUNTIME_DIR -u CODEX_THREAD_ID shell >/tmp/codex-ab-shell.stdout 2>/tmp/codex-ab-shell.stderr; test \"$?\" = 1) && grep -Fxq 'shell: CODEX_THREAD_ID is unavailable' /tmp/codex-ab-shell.stderr"] });
    if (dependencies.exitCode !== 0) throw new Error(`stock-plus-Mekugi setup cannot run offline unchanged in the container: ${[dependencies.stdout.trim(), dependencies.stderr.trim()].filter(Boolean).join("; ")}`);
    if (state.comparison === "codex-mekugi-grok") {
      const grokHome = resolve(runDir, state.arms.current.home_template);
      const grokCheck = await runOwnedContainer({ docker, name: `${prefix}-grok`, signal, createArgs: ["--network", "none",
        "-v", `${grokHome}:/setup:ro`, image, "sh", "-lc",
        "cp -a /setup/. /home/ubuntu/ && test -x /home/ubuntu/.grok/bin/grok && /home/ubuntu/.grok/bin/grok --version"] });
      await writeFile(join(runDir, "artifacts/preflight-grok.json"), JSON.stringify(grokCheck, null, 2));
      if (grokCheck.exitCode !== 0) throw new Error(`isolated Grok executable cannot run offline: ${[grokCheck.stdout.trim(), grokCheck.stderr.trim()].filter(Boolean).join("; ")}`);
      if (state.runtime_tools.grok_version && !grokCheck.stdout.includes(state.runtime_tools.grok_version.split(" ")[1] ?? "")) {
        throw new Error(`unexpected container Grok version: ${grokCheck.stdout.trim()}`);
      }
    }
  } else {
    progress("checking the complete current setup and registered Go hook offline");
    const hookEvent = JSON.stringify({ hook_event_name: "PostToolUse", cwd: "/workspace", tool_input: { cmd: "skills-mgr get golang-best-practices" }, tool_response: { exit_code: 0 } });
    const mekugiCheck = state.execution.current_launcher === "mekugi"
      ? " && test -x /home/ubuntu/.local/bin/mekugi && test \"$(command -v shell)\" = /home/ubuntu/.local/bin/shell && (env -u MEKUGI_RUNTIME_DIR -u CODEX_THREAD_ID shell >/tmp/codex-ab-shell.stdout 2>/tmp/codex-ab-shell.stderr; test \"$?\" = 1) && grep -Fxq 'shell: CODEX_THREAD_ID is unavailable' /tmp/codex-ab-shell.stderr"
      : "";
    const dependencies = await runOwnedContainer({ docker, name: `${prefix}-setup`, signal, createArgs: ["--network", "none", "-e", `CODEX_AB_HOOK_EVENT=${hookEvent}`,
      "-v", `${currentHome}:/setup:ro`, "-v", `${workspace}:/workspace:ro`, ...currentSetupMounts(runDir, state), image, "sh", "-lc",
      `cp -a /setup/. /home/ubuntu/ && export PATH=/home/ubuntu/.local/bin:/usr/local/bin:/usr/bin:/bin && test -r /home/ubuntu/.codex/config.toml && : >/home/ubuntu/.codex/.write-check && rm /home/ubuntu/.codex/.write-check && cd /home/ubuntu && missing_tools="$(mise ls --current --missing --no-header)" && if test -n "$missing_tools"; then printf "missing current setup tools: %s\n" "$missing_tools" >&2; exit 1; fi && cd /workspace && mise exec -- sh -lc 'skills-mgr list >/dev/null && rtk --version >/dev/null && test -x /home/ubuntu/.codex/hooks/bin/session_start_context && test "$(skills-mgr get use-modern-go/scripts/VERSION)" = v0.1.1 && skills-mgr get use-modern-go >/tmp/use-modern-go && test "$(wc -c </tmp/use-modern-go)" -gt 224 && grep -q "Modern Go Guidelines CLI" /tmp/use-modern-go && if test -f /workspace/go.mod; then printf "%s\n" "$CODEX_AB_HOOK_EVENT" | /home/ubuntu/.codex/hooks/bin/go_guidelines | grep -q "Modern Go Guidelines v0.1.1: /workspace/go.mod.*END_GO_GUIDELINES sha256="; fi'${mekugiCheck}`] });
    if (/\[WARN\] migrate:/.test(`${dependencies.stdout}\n${dependencies.stderr}`)) {
      throw new Error("current setup mise migration failed against the read-only tool snapshot; prepare again from a home with completed mise migrations");
    }
    if (dependencies.exitCode !== 0) throw new Error(`current setup cannot run offline unchanged in the container: ${[dependencies.stdout.trim(), dependencies.stderr.trim()].filter(Boolean).join("; ")}`);
  }
  if (state.execution.current_launcher === "mekugi" || state.comparison === "codex-mekugi-grok") {
    progress("checking selected Mekugi flags and exports offline without model access");
    const launch = await runOwnedContainer({ docker, name: `${prefix}-mekugi`, signal, timeoutMs: 30000,
      createArgs: ["--network", "none", "-v", `${state.comparison === "codex-mekugi-grok" ? resolve(runDir, state.arms.stock.home_template) : currentHome}:/setup:ro`, image, "sh", "-lc",
        'cp -a /setup/. /home/ubuntu/ && export PATH=/home/ubuntu/.local/bin:/usr/local/bin:/usr/bin:/bin && mekugi "$@" --capture-output=/tmp/capture.jsonl --metrics-output=/tmp/metrics.json codex --version',
        "preflight", ...(state.mekugi_flags ?? [])] });
    await writeFile(join(runDir, "artifacts/preflight-mekugi.json"), JSON.stringify(launch, null, 2));
    if (launch.exitCode !== 0) throw new Error(`selected Mekugi launcher failed before inference: ${launch.stderr.trim()}`);
  }
  await ensureDependencyImage(docker, runDir, state, signal);
  const dependencyBase = dependencyImage(state);
  if (state.profile !== "godoxy-icons") {
    progress("compiling the exact base and task dependencies in an ephemeral container");
    const bun = resolve(runDir, state.runtime_tools.bun);
    const cacheArgs = ["--network", "none"];
    const compile = await runOwnedContainer({ docker, name: `${prefix}-compile`, signal, timeoutMs: 10 * 60 * 1000, createArgs: ["--cpus", state.resource_limits.cpus, "--memory", state.resource_limits.memory, ...cacheArgs,
      "-v", `${resolve(runDir, "seed.git")}:/seed:ro`, "-v", `${bun}:/usr/local/bin/bun:ro`, dependencyBase, "sh", "-lc",
      `git clone --no-hardlinks /seed /tmp/preflight >/dev/null && git -C /tmp/preflight checkout ${state.source.base_commit} >/dev/null && cd /tmp/preflight && ${prepareAssets(state)} && git diff --quiet HEAD --`] });
    if (compile.exitCode !== 0) throw new Error(`base dependency/compile preflight failed: ${compile.stderr.trim()}`);
  } else {
    const repository = resolve(runDir, state.arms.stock.repository);
    const compile = await runOwnedContainer({ docker, name: `${prefix}-compile`, signal, timeoutMs: 10 * 60 * 1000,
      createArgs: [...containerArgs(state), "--network", "none", "-v", `${repository}:/baseline:ro`, dependencyBase, "sh", "-lc",
        `cp -a /baseline /tmp/preflight && cd /tmp/preflight && ${prepareAssets(state)} && ${state.criteria!.contract.existing_tests} && git diff --exit-code HEAD -- && test "$(git rev-parse HEAD)" = ${state.source.base_commit} && test -z "$(git remote)" && ! git config --get submodule.webui.url && test "$(git submodule status -- webui | cut -c1)" = - && test -z "$(ls -A webui)" && ${state.submodules!.map(sub => `test -z "$(git -C ${sub.path} remote)" && test "$(git submodule status -- ${sub.path} | cut -c1)" = ' ' && test -z "$(git -C ${sub.path} status --porcelain --untracked-files=all)" && test "$(git -C ${sub.path} rev-parse HEAD)" = ${sub.sha}`).join(" && ")}`] });
    await writeFile(join(runDir, "artifacts/preflight-icons.json"), JSON.stringify(compile, null, 2));
    if (compile.exitCode !== 0) throw new Error(`icons preflight failed: ${compile.stdout.trim()} ${compile.stderr.trim()}`);
  }
  if (state.protected_runtime) await protectedPreflight(docker, runDir, state, signal);
  progress("preflight passed without model inference");
  return image;

}

async function preflight(docker: string, state: RunState, runDir: string, externalSignal?: AbortSignal): Promise<string> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (externalSignal?.aborted) controller.abort();
  externalSignal?.addEventListener("abort", cancel, { once: true });
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    if (controller.signal.aborted) throw new Error("preflight canceled; no model was launched");
    const imageId = await preflightChecks(docker, state, runDir, controller.signal);
    if (controller.signal.aborted) throw new Error("preflight canceled; no model was launched");
    return imageId;
  } finally {
    externalSignal?.removeEventListener("abort", cancel);
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

export async function preflightRunUnlocked(runDirectory: string, dockerBin = process.env.CODEX_AB_DOCKER_BIN ?? "docker"): Promise<void> {
  const runDir = resolve(runDirectory);
  const state = await readState(runDir);
  if (state.status !== "prepared") throw new Error(`preflight requires a prepared run, got ${state.status}`);
  state.image_id = await preflight(dockerBin, state, runDir);
  await writeState(runDir, state);
}

async function prewarm(docker: string, runDir: string, state: RunState, arm: ArmName, home: string, signal: AbortSignal): Promise<void> {
  const name = `codex-ab-${state.id}-${arm}-agent-warm`;
  const repo = resolve(runDir, state.arms[arm].repository);
  const bun = resolve(runDir, state.runtime_tools.bun);
  const command = prepareAssets(state);
  const result = await runOwnedContainer({ docker, name, signal, createArgs: [...containerArgs(state),
    "-v", `${repo}:/workspace`, "-v", `${home}:/home/ubuntu`,
    "--network", "none",
    "-v", `${bun}:/usr/local/bin/bun:ro`, imageRef(state), "sh", "-lc", command] });
  if (result.exitCode !== 0) throw new Error(`${arm} cache prewarm failed: ${result.stderr.trim()}`);
  await inspectCandidate(docker, runDir, state, repo, `${arm}-warm-verify`, signal, true, true);
}
export async function gradeArm(docker: string, runDir: string, state: RunState, arm: ArmName, patchPath: string, signal: AbortSignal): Promise<ArmResult["grade"]> {
  if (!state.criteria) throw new Error("run requires task-derived semantic criteria");
  const evaluator = join(runDir, "evaluator", arm);
  await checked(["git", "clone", "--no-local", "--no-hardlinks", join(runDir, "seed.git"), evaluator]);
  await checked(["git", "-C", evaluator, "checkout", state.source.base_commit]);
  await checked(["git", "-C", evaluator, "remote", "remove", "origin"]);
  await initializeSubmodules(evaluator, state.submodules ?? []);
  await inspectCandidate(docker, runDir, state, evaluator, `${arm}-grade-verify`, signal, true, false);
  const patchStat = await Bun.file(patchPath).size;
  if (patchStat > 0) await checked(["git", "-C", evaluator, "apply", "--binary", patchPath]);
  await inspectCandidate(docker, runDir, state, evaluator, `${arm}-grade-verify`, signal, true, false);
  const allowedPaths = state.criteria.contract.allowed_paths;
  const forbiddenChanges = allowedPaths ? (state.results?.[arm]?.changed_files ?? []).filter(path => !allowedPaths.includes(path)) : [];
  const ready: CommandEvidence = { command: "immutable candidate capture and task-required change boundaries", started_at: new Date().toISOString(),
    elapsed_ms: 0, exit_code: forbiddenChanges.length ? 1 : 0, stdout: "", stderr: forbiddenChanges.length ? `Outside task change boundary: ${forbiddenChanges.join(", ")}` : "" };
  const pending: CommandEvidence = { ...ready, command: "semantic checks pending independent judges", exit_code: -1 };
  return { preparation: ready, router_suite: pending, elapsed_ms: 0, passed: false };
}

async function runArm(docker: string, runDir: string, state: RunState, arm: ArmName, home: string, output: string, providerNetwork: string, task: string, signal: AbortSignal): Promise<ArmResult> {
  const name = `codex-ab-${state.id}-${arm}`;
  const repository = resolve(runDir, state.arms[arm].repository);
  const stdoutPath = join(output, "codex.jsonl");
  const stderrPath = join(output, "codex.stderr");
  const patchPath = join(output, "changes.patch");
  const started = new Date();
  progress(`${arm}: agent started`);
  let result: ExecResult | undefined;
  let lifecycleError: string | undefined;
  const exportArm = state.comparison === "codex-mekugi-grok" ? "stock" : "current";
  const exportArgs = state.mekugi_exports_by_arm?.[arm] || (arm === exportArm && state.mekugi_exports)
    ? ["--capture-output=/mekugi-exports/capture.jsonl", "--metrics-output=/mekugi-exports/metrics.json"] : [];
  const exportMount = exportArgs.length ? ["-v", `${join(output, "mekugi")}:/mekugi-exports`] : [];
  if (exportArgs.length) await mkdir(join(output, "mekugi"), { recursive: true, mode: 0o700 });
  const protectedArm = arm === "current" && state.protected_runtime;
  const runtime = join(output, "runtime");
  const ownedPaths = [repository, home, join(output, "mekugi"), runtime];
  if (protectedArm) await mkdir(runtime, { recursive: true });
  const grokArm = state.comparison === "codex-mekugi-grok" && arm === "current";
  const mekugiArm = state.comparison === "mentor-handoff" || (state.comparison === "codex-mekugi-grok" ? arm === "stock" : arm === "current" && state.execution.current_launcher === "mekugi");
  const grokCommand = grokArm
    ? ["grok", "--prompt-file", "/control/task.md", "--cwd", "/workspace", "-m", "grok-4.6", "--reasoning-effort", state.execution.reasoning_effort, "--always-approve", "--sandbox", "off", "--output-format", "json", "--disable-web-search"]
    : undefined;
  const mentorFlags = state.mentor ? ["--main-mentor-handoff=false", `--mentor-handoff=${arm === "current"}`] : [];
  const codexLauncher = mekugiArm ? ["mekugi", ...(state.mekugi_flags ?? []), ...mentorFlags, ...exportArgs, "codex"] : ["codex"];
  const launcher = grokCommand ?? (mekugiArm && (state.comparison === "stock-mekugi" || state.comparison === "codex-mekugi-grok" || state.mentor?.setup === "stock") ? codexLauncher : arm === "current" || state.comparison === "same-setup" || state.mentor?.setup === "current" ? ["mise", "exec", "--", ...codexLauncher] : ["codex"]);
  const grokPath = grokArm ? ["-e", "PATH=/home/ubuntu/.grok/bin:/home/ubuntu/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/local/go/bin", "-e", "GROK_HOME=/home/ubuntu/.grok"] : ["-e", "PATH=/home/ubuntu/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/local/go/bin"];
  const grokTask = grokArm ? ["-v", `${join(runDir, state.task.path)}:/control/task.md:ro`] : [];
  try {
    if (protectedArm) await executorOwnership(docker, state, `${name}-own`, ownedPaths, false);
    result = await runOwnedContainer({ docker, name, signal, stdin: grokArm ? undefined : task, stdoutFile: stdoutPath, stderrFile: stderrPath, timeoutMs: state.timeout_seconds * 1000, createArgs: [...containerArgs(state), "--network", providerNetwork, ...(grokArm ? [] : ["-i"]), ...grokPath,
      "-v", `${repository}:/workspace`, "-v", `${home}:/home/ubuntu`, ...currentSetupMounts(runDir, state, arm), ...exportMount, ...grokTask,
      ...(state.mentor ? ["-v", `${join(runDir, "control")}:/benchmark-control:ro`] : []),
      ...(protectedArm ? protectedArgs(runDir, state, runtime) : []),
      imageRef(state), ...launcher, ...(grokArm ? [] : ["exec", "--json", "--color", "never", "--dangerously-bypass-hook-trust", "-C", "/workspace", "--model", state.execution.model,
      "-c", `model_reasoning_effort=${JSON.stringify(state.execution.reasoning_effort)}`, "-c", `service_tier=${JSON.stringify(state.execution.service_tier)}`, "-c", 'approval_policy="never"', "-c", 'sandbox_mode="danger-full-access"',
      ...(state.mentor ? ["-c", 'features.multi_agent_v2=true', "-c", 'agents.benchmark_worker.description="Fixed benchmark implementation role"', "-c", 'agents.benchmark_worker.config_file="/benchmark-control/mentor-child.toml"', "-c", 'model_instructions_file="/benchmark-control/mentor-parent.md"'] : []),
      "-"])] });
  } catch (error) {
    lifecycleError = error instanceof Error ? error.message : String(error);
    if (error instanceof OwnedContainerError && error.result) result = error.result;
  }
  if (protectedArm) {
    try { await executorOwnership(docker, state, `${name}-restore`, ownedPaths, true); }
    catch (error) { lifecycleError = `${lifecycleError ?? ""} ${String(error)}`.trim(); }
  }
  const finishedAt = new Date().toISOString();
  progress(`${arm}: agent stopped after ${Math.round((result?.elapsedMs ?? 0) / 1000)}s${lifecycleError ? ` (${lifecycleError})` : ""}`);
  return {
    arm,
    anonymous_id: arm === "stock" ? "candidate-1" : "candidate-2",
    container: name,
    started_at: started.toISOString(),
    finished_at: finishedAt,
    agent_elapsed_ms: result?.elapsedMs ?? 0,
    exit_code: result?.exitCode ?? -1,
    timed_out: result?.timedOut ?? false,
    canceled: result?.canceled === true || signal.aborted,
    patch_path: patchPath.slice(runDir.length + 1),
    stdout_path: stdoutPath.slice(runDir.length + 1),
    stderr_path: stderrPath.slice(runDir.length + 1),
    changed_files: [],
    head_after_agent: "",
    lifecycle_error: lifecycleError,
  };
}

async function collectArm(docker: string, runDir: string, state: RunState, arm: ArmName, result: ArmResult, discardDependencies?: string[]): Promise<void> {
  const repository = resolve(runDir, state.arms[arm].repository);
  const patchPath = join(runDir, result.patch_path);
  try {
    // Cleanup has completed before collection. Use a fresh signal so canceled
    // inference can still preserve its available patch without launching models.
    await inspectCandidate(docker, runDir, state, repository, `${arm}-capture`, new AbortController().signal, false, false, dirname(patchPath), discardDependencies);
    for (const path of [patchPath, join(dirname(patchPath), "result.json")]) {
      if (!(await lstat(path)).isFile()) throw new Error("capture artifact must be a regular file");
    }
    const metadata = JSON.parse(await readFile(join(dirname(patchPath), "result.json"), "utf8")) as { changed_files?: unknown; head_after_agent?: unknown };
    if (!Array.isArray(metadata.changed_files) || metadata.changed_files.some(value => typeof value !== "string")
      || typeof metadata.head_after_agent !== "string" || !/^[0-9a-f]{40}$/.test(metadata.head_after_agent)) throw new Error("invalid capture metadata");
    result.changed_files = metadata.changed_files;
    result.head_after_agent = metadata.head_after_agent;
  } catch (error) {
    result.collection_error = error instanceof Error ? error.message : String(error);
    // Do not follow or overwrite a candidate-created capture symlink on failure.
    progress(`${arm}: inference evidence persisted but patch collection failed: ${result.collection_error}`);
  }
}

export async function runPairUnlocked(options: RunOptions): Promise<RunState> {
  const runDir = resolve(options.runDir);
  const state = await readState(runDir);
  if (state.status !== "prepared") throw new Error(`run is ${state.status}; prepare a new run instead of resuming or restarting it`);
  if (!state.criteria) throw new Error("run has no evaluator contract; prepare with --criteria");
  if (options.arm && options.arm !== "stock") throw new Error("single-arm runs support stock controls only");
  if (options.controlRun && options.arm) throw new Error("--control-run selects the current treatment arm; do not pass --arm");
  if (Boolean(options.controlRun) !== Boolean(options.controlBundleSha256)) throw new Error("--control-run requires --control-bundle-sha256 and vice versa");
  const docker = options.dockerBin ?? process.env.CODEX_AB_DOCKER_BIN ?? "docker";
  state.image_id = await preflight(docker, state, runDir, options.signal);
  const imported = options.controlRun ? await importControl(runDir, state, options.controlRun, options.controlBundleSha256!) : undefined;
  await writeState(runDir, state);
  const controller = new AbortController();
  if (options.signal?.aborted) controller.abort();
  const externalCancel = () => controller.abort();
  options.signal?.addEventListener("abort", externalCancel, { once: true });
  const activeArms: ArmName[] = imported ? ["current"] : options.arm ? [options.arm] : arms;
  const selectedArms: ArmName[] = imported ? arms : activeArms;
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  let providerNetwork: OwnedNetwork | undefined;
  try {
    providerNetwork = await createOwnedNetwork(docker, `codex-ab-${state.id}-provider`, controller.signal);
    const auth = resolve(options.authFile);
    const authMode = (await import("node:fs/promises")).stat(auth).then(s => s.mode & 0o777);
    if ((await authMode) & 0o077) throw new Error("auth file must not be accessible by group or others (expected mode 0600)");
    const setupResults = await Promise.allSettled(activeArms.map(async arm => [arm, await setupArm(runDir, state, arm, auth, options.grokAuthFile)] as const));
    const setupFailure = setupResults.find(result => result.status === "rejected");
    if (setupFailure?.status === "rejected") throw setupFailure.reason;
    const setups = Object.fromEntries(setupResults.map(result => (result as PromiseFulfilledResult<readonly [ArmName, Awaited<ReturnType<typeof setupArm>>]>).value)) as Partial<Record<ArmName, Awaited<ReturnType<typeof setupArm>>>>;
    if (controller.signal.aborted) throw new Error("canceled during private arm setup; no model was launched");
    state.status = "running";
    state.results = imported ? { stock: imported } : {};
    state.selected_arms = selectedArms;
    await writeState(runDir, state);
    progress("preparing identical task dependencies for both arms");
    const warmed = await Promise.allSettled(activeArms.map(arm => prewarm(docker, runDir, state, arm, setups[arm]!.home, controller.signal)));
    const warmFailure = warmed.find(result => result.status === "rejected");
    if (warmFailure?.status === "rejected") throw warmFailure.reason;
    if (controller.signal.aborted) throw new Error("canceled during dependency prewarm; no agent was launched");
    const generatedDependencies = Object.fromEntries(await Promise.all(activeArms.map(async arm =>
      [arm, await generatedDependencyDirectories(resolve(runDir, state.arms[arm].repository))] as const)));
    await verifyPreparedInputs(runDir, state);
    const task = await readFile(join(runDir, state.task.path), "utf8");
    if (controller.signal.aborted) throw new Error("canceled while reading the task; no agent was launched");
    for (const arm of activeArms) {
      const repo = resolve(runDir, state.arms[arm].repository);
      await inspectCandidate(docker, runDir, state, repo, `${arm}-launch-verify`, controller.signal, true, true);
    }
    const order = state.arm_order ?? "concurrent";
    if (!["concurrent", "stock-first", "current-first"].includes(order)) throw new Error("invalid arm execution order");
    progress(`agent execution order: ${order}`);
    state.arm_attempts = imported ? { stock: { codex_home: "arms/stock/home/ubuntu/.codex", container: imported.container,
      started_at: imported.started_at, finished_at: imported.finished_at, status: "stopped" } } : {};
    const batches: ArmName[][] = order === "concurrent" ? [activeArms]
      : (order === "stock-first" ? arms : [...arms].reverse()).filter(arm => activeArms.includes(arm)).map(arm => [arm]);
    for (const batch of batches) {
      if (controller.signal.aborted) break;
      for (const arm of batch) state.arm_attempts[arm] = {
        codex_home: `arms/${arm}/home/ubuntu/.codex`,
        grok_home: state.comparison === "codex-mekugi-grok" ? `arms/${arm}/home/ubuntu/.grok` : undefined,
        container: `codex-ab-${state.id}-${arm}`,
        started_at: new Date().toISOString(),
        status: "started",
      };
      await writeState(runDir, state);
      const settled = await Promise.allSettled(batch.map(arm => runArm(docker, runDir, state, arm, setups[arm]!.home, setups[arm]!.output, providerNetwork!.name, task, controller.signal)));
      settled.forEach((item, index) => {
        const arm = batch[index]!;
        const attempt = state.arm_attempts![arm]!;
        attempt.finished_at = new Date().toISOString();
        if (item.status === "fulfilled") {
          state.results![arm] = item.value;
          attempt.status = "stopped";
        } else {
          attempt.status = "failed";
          attempt.error = String(item.reason);
          const message = `${arm}: failed to collect result: ${String(item.reason)}`;
          state.error = state.error ? `${state.error}; ${message}` : message;
          progress(message);
        }
      });
      await writeState(runDir, state);
    }
    const collected = await Promise.allSettled(activeArms.map(async arm => {
      const result = state.results?.[arm];
      if (result && !result.lifecycle_error) {
        await collectArm(docker, runDir, state, arm, result, generatedDependencies[arm]);
      }
    }));
    const collectionFailure = collected.find(result => result.status === "rejected");
    if (collectionFailure?.status === "rejected") state.error = String(collectionFailure.reason);
    await writeState(runDir, state);
    if (!controller.signal.aborted && selectedArms.every(arm => state.results?.[arm] && !state.results[arm]!.lifecycle_error && !state.results[arm]!.collection_error)) {
      progress(`${options.arm ? "selected agent" : "both agents"} stopped; starting evaluator-only grading`);
      const graded = await Promise.allSettled(selectedArms.map(async arm => {
        const result = state.results![arm]!;
        result.grade = await gradeArm(docker, runDir, state, arm, join(runDir, result.patch_path), controller.signal);
        progress(`${arm}: prepared for independent semantic assessment`);
      }));
      const gradeFailure = graded.find(result => result.status === "rejected");
      if (gradeFailure?.status === "rejected") throw gradeFailure.reason;
    }
    for (const result of Object.values(state.results)) {
      if (result?.collection_error) state.error = state.error ? `${state.error}; ${result.collection_error}` : result.collection_error;
    }
    state.status = !controller.signal.aborted && selectedArms.every(arm => state.results?.[arm] && !state.results[arm]!.lifecycle_error && !state.results[arm]!.collection_error && state.results[arm]!.grade) ? "complete" : "partial";
    await writeState(runDir, state);
    return state;
  } catch (error) {
    state.status = "partial";
    state.error = error instanceof Error ? error.message : String(error);
    await writeState(runDir, state);
    throw error;
  } finally {
    await providerNetwork?.remove();
    options.signal?.removeEventListener("abort", externalCancel);
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

export async function preflightRun(runDirectory: string, dockerBin = process.env.CODEX_AB_DOCKER_BIN ?? "docker"): Promise<void> {
  return withRunLock(resolve(runDirectory), () => preflightRunUnlocked(runDirectory, dockerBin));
}

export async function runPair(options: RunOptions): Promise<RunState> {
  return withRunLock(resolve(options.runDir), () => runPairUnlocked(options));
}
