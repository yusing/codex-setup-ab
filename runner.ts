import { armRuntime, parallelWorkTask } from "./arm-settings";
import { applySkillSelection } from "./setup-skills";
import { armNames } from "./types";
import { dependencyImage, ensureDependencyImage, generatedDependencyDirectories, discardDownloadedCatalog, TASK_PATH } from "./dependencies";
import { prepareRuntimeHome, runtimeHomeMounts } from "./runtime-home";
import { chmod, copyFile, cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { exec, checked, type ExecResult } from "./process";
import { createOwnedNetwork, OwnedContainerError, runOwnedContainer, withOwnedNetwork, type OwnedContainerOptions, type OwnedNetwork } from "./container";
import { buildNetworkPolicy, startEgressProxySidecar, type EgressProxySidecar } from "./egress-proxy";
import { classifyCandidateFailure, type CandidateFailureClassification, type CandidateRetryAttempt } from "./candidate-failure";
import { initializeSubmodules, verifyGodoxyIdentity, verifyPreparedInputs } from "./prepare";
import candidateSource from "./candidate-script.txt" with { type: "text" };
import checkEmptySkills from "./minimal-skills.txt" with { type: "text" };
import { readCandidateManifest, readRegularEvidence, verifyCandidateReconstruction } from "./candidate-evidence";
import { verifyFixedInputs } from "./fixed-workflow";
import { executorOwnership, launcherMounts, miseToolMounts, protectedArgs, protectedPreflight } from "./isolation";
import { TOOLHOST_SMOKE_SCRIPT } from "./toolhost";
import { MEKUGI_RUNTIME_DIRECTORY } from "./mekugi-runtime";
import { armExecutionSucceeded, readState, sha256, writeState, withRunLock } from "./state";
import { isPairedMekugiComparison, usesMekugi, mekugiArmFlags, MEKUGI_METRICS_WRAPPER, validateMekugiFlags } from "./mekugi";
import { importArms, importControl } from "./control";
import { evaluationPlan } from "./evaluation";
import { armLabels, presentationLabel } from "./arm-labels";
import { startRunawayGuard } from "./runaway-guard";
import { DEFAULT_PIDS_LIMIT, type ArmImport, type ArmName, type ArmResult, type CommandEvidence, type RunState } from "./types";

export interface RunOptions { runDir: string; authFile: string; grokAuthFile?: string; dockerBin?: string; arm?: ArmName; controlRun?: string; controlBundleSha256?: string; importArms?: ArmImport[]; evaluationMode?: string; evaluationBaselines?: unknown; retryDelaysMs?: number[]; signal?: AbortSignal }

const DEFAULT_RETRY_DELAYS_MS = [5_000, 15_000] as const;

function resolveRetryDelaysMs(override?: number[]): number[] {
  if (override !== undefined) {
    if (override.some(value => !Number.isFinite(value) || value < 0)) throw new Error("invalid retryDelaysMs");
    return [...override];
  }
  const raw = process.env.CODEX_AB_RETRY_DELAYS_MS;
  if (raw === undefined) return [...DEFAULT_RETRY_DELAYS_MS];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const parsed = trimmed.split(",").map(part => Number(part.trim()));
  if (parsed.some(value => !Number.isFinite(value) || value < 0)) throw new Error(`invalid CODEX_AB_RETRY_DELAYS_MS: ${raw}`);
  return parsed;
}

async function isWorkspaceClean(repository: string, baseCommit: string): Promise<boolean> {
  // Refuse to run host git if the candidate tampered with repo-local .git/config filters or hooks.
  const gitConfig = await readFile(join(repository, ".git/config"), "utf8").catch(() => null);
  if (gitConfig === null || /(?:^|\n)\s*(?:clean|smudge|process|textconv|external|fsmonitor|hooksPath|sshCommand)\s*=/i.test(gitConfig)) {
    return false;
  }
  const status = await exec([
    "git", "-c", "safe.directory=*", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null",
    "-c", "status.showUntrackedFiles=normal", "-C", repository, "status", "--porcelain", "--untracked-files=normal",
  ]);
  if (status.exitCode !== 0 || status.stdout.trim() !== "") return false;
  const head = await exec(["git", "-c", "safe.directory=*", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", repository, "rev-parse", "HEAD"]);
  return head.exitCode === 0 && head.stdout.trim() === baseCommit;
}

async function archiveExportDirectory(output: string, attempt: number, exportRoot: string): Promise<void> {
  const entries = await readdir(exportRoot).catch(() => []);
  if (!entries.length) return;
  const destination = join(output, `mekugi-exports.attempt-${attempt}`);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const entry of entries) {
    await rename(join(exportRoot, entry), join(destination, entry));
  }
}

async function archiveAttemptLogs(output: string, attempt: number, stdoutPath: string, stderrPath: string): Promise<{ stdoutPath: string; stderrPath: string }> {
  const archivedStdout = join(output, `codex.attempt-${attempt}.jsonl`);
  const archivedStderr = join(output, `codex.attempt-${attempt}.stderr`);
  for (const [source, destination] of [[stdoutPath, archivedStdout], [stderrPath, archivedStderr]] as const) {
    try { await rename(source, destination); }
    catch { await writeFile(destination, ""); }
  }
  return { stdoutPath: archivedStdout, stderrPath: archivedStderr };
}


function progress(message: string): void { process.stderr.write(`[run] ${message}\n`); }

function prepareAssets(state: RunState): string {
  if (!state.criteria) throw new Error("run requires task-derived semantic criteria");
  return state.criteria.contract.preparation;
}

// Mekugi resolves its Codex child through PATH after mise activates the setup.
const PINNED_LAUNCHER_ENV = 'export PATH="/opt/task-deps/python/bin:/usr/local/bin:$PATH"; exec "$@"';

export function containerArgs(state: RunState): string[] {
  return [
    "--cpus", state.resource_limits.cpus,
    "--memory", state.resource_limits.memory,
    "--pids-limit", String(state.resource_limits.pids_limit ?? DEFAULT_PIDS_LIMIT),
  ];
}

function usesMise(state: RunState, arm: ArmName): boolean {
  return state.comparison !== "codex-mekugi-grok" && (arm === "current" || state.comparison === "setup-commits"
    || state.comparison === "custom" || state.comparison === "same-setup" || state.comparison === "stock-mekugi" || isPairedMekugiComparison(state.comparison));
}

async function currentSetupMounts(runDir: string, state: RunState, arm: ArmName = "current", home?: string): Promise<string[]> {
  const mounts = launcherMounts(runDir, state, arm);
  if (!usesMise(state, arm)) return mounts;
  if (state.comparison === "duplicate-output" || (state.comparison === "setup-commits" || state.comparison === "custom")) {
    const snapshot = JSON.parse(await readFile(join(runDir, state.snapshot_manifest), "utf8")) as { source_home?: string; runtime_home?: string };
    const sourceHome = snapshot.runtime_home ?? snapshot.source_home;
    if (typeof sourceHome !== "string" || !isAbsolute(sourceHome) || sourceHome === "/") throw new Error("invalid current setup home alias");
    if (sourceHome !== "/home/ubuntu" && !state.runtime_homes?.[arm]) {
      mounts.push("-v", `${home ?? resolve(runDir, state.arms[arm].home_template)}:${sourceHome}${home ? "" : ":ro"}`);
    }
  }
  return [...mounts, ...await miseToolMounts(runDir, state)];
}

function imageRef(state: RunState): string { return dependencyImage(state); }

async function inspectCandidate(docker: string, runDir: string, state: RunState, repository: string, label: string,
  signal: AbortSignal, baseline: boolean, clean: boolean, capture?: string, discardDependencies?: string[]): Promise<void> {
  const spec = { mode: capture ? "capture" : "verify", baseline, clean, discardDependencies, base: state.source.base_commit,
    tree: state.source.base_tree, forbidden: state.source.forbidden_commit, icons: state.profile === "godoxy-icons", submodules: state.submodules ?? [] };
  const result = await runOwnedContainer({ docker, name: `codex-ab-${state.id}-${label}`, signal, timeoutMs: 60_000,
    createArgs: [...containerArgs(state), "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "-e", "GIT_OPTIONAL_LOCKS=0", "-v", `${repository}:/workspace:ro`,
      "-v", `${join(runDir, "seed.git")}:/seed.git:ro`,
      ...(capture ? ["-v", `${capture}:/capture`] : []),
      imageRef(state), "bun", "-e", candidateSource, JSON.stringify(spec)] });
  if (result.exitCode !== 0 || result.timedOut || result.canceled) throw new Error(`candidate ${label} verification failed: ${result.stderr.trim()}`);
}

async function setupArm(runDir: string, state: RunState, arm: ArmName, authFile: string, grokAuthFile?: string, docker = "docker", signal?: AbortSignal): Promise<{ home: string; output: string }> {
  const armRoot = dirname(resolve(runDir, state.arms[arm].repository));
  const home = join(armRoot, "home/ubuntu");
  const output = join(runDir, "artifacts", arm);
  const template = join(runDir, state.arms[arm].home_template);
  const cow = state.home_storage === "docker-cow" && !(arm === "current" && (state.protected_runtime || state.comparison === "codex-mekugi-grok"));
  if (!cow) await cp(template, home, { recursive: true, force: false, verbatimSymlinks: true });
  await mkdir(join(home, ".codex"), { recursive: true, mode: 0o700 });
  if (cow && await Bun.file(join(template, ".codex/config.toml")).exists()) await copyFile(join(template, ".codex/config.toml"), join(home, ".codex/config.toml"));
  await copyFile(authFile, join(home, ".codex/auth.json"));
  await chmod(home, 0o700);
  await chmod(join(home, ".codex"), 0o700);
  await mkdir(join(home, "go/pkg"), { recursive: true });
  await mkdir(join(home, ".local/share/mise/installs"), { recursive: true });
  await mkdir(join(home, ".bun/install/cache"), { recursive: true });
  if (state.comparison === "codex-mekugi-grok") {
    if (!grokAuthFile) throw new Error("codex-mekugi-grok requires --grok-auth-file");
    const grokAuth = resolve(grokAuthFile);
    if (((await stat(grokAuth)).mode & 0o077) !== 0) throw new Error("grok auth file must not be accessible by group or others (expected mode 0600)");
    await mkdir(join(home, ".grok"), { recursive: true, mode: 0o700 });
    await copyFile(grokAuth, join(home, ".grok/auth.json"));
    await chmod(join(home, ".grok/auth.json"), 0o600);
  }
  await chmod(join(home, ".codex/auth.json"), 0o600);
  await mkdir(output, { recursive: true });
  if (!cow) await applySkillSelection(home, state.arm_settings?.[arm]?.skills);
  if (cow) {
    const document = JSON.parse(await readFile(join(runDir, state.setup_revisions?.[arm]?.manifest ?? state.snapshot_manifest), "utf8"));
    const current = JSON.parse(await readFile(join(runDir, state.snapshot_manifest), "utf8"));
    const configPath = join(template, ".codex/config.toml");
    const templateConfigSha256 = await Bun.file(configPath).exists() ? await sha256(configPath) : null;
    state.runtime_homes ??= {};
    state.runtime_homes[arm] = { ...await prepareRuntimeHome({ runDir, state, template, auth: authFile, docker, signal,
      identity: { files: document.files, repository: document.configuration_repository, template: state.arms[arm].home_template,
        ...(state.setup_revisions?.[arm] ? {} : { template_config_sha256: templateConfigSha256 }) },
      sourceHome: current.runtime_home ?? current.source_home, skills: state.arm_settings?.[arm]?.skills }) };
  }
  return { home, output };
}

async function preflightChecks(docker: string, state: RunState, runDir: string, signal: AbortSignal): Promise<Map<ArmName, string[]>> {
  if (state.comparison === "journal-compaction") throw new Error("journal-compaction is retired; prepare a supported comparison");
  validateMekugiFlags(state.mekugi_flags ?? [], "retained");
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
  for (const arm of armNames(state)) await inspectCandidate(docker, runDir, state, resolve(runDir, state.arms[arm].repository), `preflight-${arm}-baseline`, signal, true, true);
  const prefix = `codex-ab-${state.id}-preflight`;
  progress(`checking bare Codex image ${image}, operator, binary hashes, and local code-mode host protocol`);
  // These checks use only the immutable image, without credentials or networking.
  // Keep each command's output separate so failures retain their specific diagnosis.
  const commands = [
    ["sh", "-lc", "printf 'codex_path=%s\\n' \"$(command -v codex || true)\"; if command -v hpatch >/dev/null || command -v mekugi >/dev/null; then printf 'mekugi_path=%s\\n' \"$(command -v mekugi)\"; exit 8; fi; codex --version"],
    ["sh", "-lc", "printf '%s:%s\\n' \"$(id -u)\" \"$(id -g)\""],
    ["sha256sum", "/usr/local/bin/codex", "/usr/local/bin/codex-code-mode-host", ...(state.protected_runtime ? ["/usr/local/libexec/codex-real"] : [])],
    ["node", "-e", TOOLHOST_SMOKE_SCRIPT],
  ];
  // Allow time for all checks while also bounding a stalled Docker attachment.
  const qualification = await runOwnedContainer({ docker, name: `${prefix}-image`, signal, timeoutMs: 30_000,
    createArgs: ["--network", "none", image, "node", "-e", `
      const { spawnSync } = require("node:child_process");
      const results = ${JSON.stringify(commands)}.map(([command, ...args], index) => {
        const result = spawnSync(command, args, {
          encoding: "utf8",
          ...(index === 3 ? { timeout: 15000, killSignal: "SIGKILL" } : {}),
        });
        return { exitCode: result.status ?? -1, stdout: result.stdout ?? "",
          stderr: (result.stderr ?? "") + (result.error ? String(result.error) : "") };
      });
      process.stdout.write(JSON.stringify(results));
    `] });
  if (qualification.exitCode !== 0) throw new Error(`immutable image qualification failed: ${qualification.timedOut ? "Docker attachment timed out" : [qualification.stdout.trim(), qualification.stderr.trim()].filter(Boolean).join("; ")}`);
  const [check, identity, binaryHash, toolHost] = JSON.parse(qualification.stdout) as [
    Pick<ExecResult, "exitCode" | "stdout" | "stderr">,
    Pick<ExecResult, "exitCode" | "stdout" | "stderr">,
    Pick<ExecResult, "exitCode" | "stdout" | "stderr">,
    Pick<ExecResult, "exitCode" | "stdout" | "stderr">,
  ];
  if (check.exitCode !== 0) throw new Error(`image is not a bare Codex image (${check.exitCode}): ${[check.stdout.trim(), check.stderr.trim()].filter(Boolean).join("; ")}`);
  if (!check.stdout.includes("codex_path=/usr/local/bin/codex")) throw new Error(`image Codex is not the direct /usr/local/bin/codex entry: ${check.stdout.trim()}`);
  const containerVersion = check.stdout.split("\n").map(line => line.trim()).find(line => line.startsWith("codex-cli "));
  if (containerVersion !== state.runtime_tools.codex_version) {
    throw new Error(`unexpected container Codex version: expected ${state.runtime_tools.codex_version}, got ${containerVersion ?? check.stdout.trim()}. Use the original image or prepare a new run`);
  }
  const expectedIdentity = `${state.operator.uid}:${state.operator.gid}`;
  if (identity.exitCode !== 0 || identity.stdout.trim() !== expectedIdentity) throw new Error(`container operator identity must be ${expectedIdentity}, got ${identity.stdout.trim()}`);
  const hashes = binaryHash.stdout.trim().split("\n").map(line => line.trim().split(/\s+/)[0]);
  if (binaryHash.exitCode !== 0 || hashes[0] !== state.runtime_tools.codex_sha256 || hashes[1] !== state.runtime_tools.codex_code_mode_host_sha256 || (state.protected_runtime && hashes[2] !== state.runtime_tools.codex_sha256)) {
    throw new Error(`container Codex hash differs from prepared source: ${binaryHash.stdout.trim()}`);
  }
  if (toolHost.exitCode !== 0 || toolHost.stdout.trim() !== "CODEX_AB_TOOL_HOST_OK") throw new Error(`code-mode tool host smoke failed: ${[toolHost.stdout.trim(), toolHost.stderr.trim()].filter(Boolean).join("; ")}`);
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
  await ensureDependencyImage(docker, runDir, state, signal);
  const setupImage = dependencyImage(state);
  async function checkSetup(arm: ArmName, options: Omit<OwnedContainerOptions, "docker" | "signal">) {
    const home = await mkdtemp(join("/var/tmp", "codex-ab-preflight-"));
    try {
      await cp(resolve(runDir, state.arms[arm].home_template), home, { recursive: true, verbatimSymlinks: true });
      await chmod(home, 0o700);
      // Stage writable mount parents before Docker inserts read-only runtime files.
      for (const path of [".local/bin", ".grok/bin", ".cargo/bin"]) await mkdir(join(home, path), { recursive: true });
      return await runOwnedContainer({ timeoutMs: 30_000, ...options, docker, signal, createArgs: ["--network", "none",
        "-v", `${home}:/home/ubuntu`, ...await currentSetupMounts(runDir, state, arm, home), ...options.createArgs] });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
  progress("checking each setup and benchmark environment offline");
  for (const arm of armNames(state)) {
    const grokArm = state.comparison === "codex-mekugi-grok" && arm === "current";
    const configuration = grokArm ? ".grok" : ".codex";
    const setupCheck = `test -r /home/ubuntu/${configuration}/config.toml && : >/home/ubuntu/${configuration}/.write-check && rm /home/ubuntu/${configuration}/.write-check`;
    const toolCheck = usesMise(state, arm)
      ? 'cd /home/ubuntu && missing_tools="$(mise ls --current --missing --no-header)" && if test -n "$missing_tools"; then printf "missing configured tools: %s\\n" "$missing_tools" >&2; exit 1; fi && cd /workspace && exec mise exec -- bash -lc "$@"'
      : 'exec bash -lc "$@"';
    const environment = await checkSetup(arm, { name: `${prefix}-environment-${arm}`, timeoutMs: 30000,
      createArgs: ["-e", `PATH=${TASK_PATH}`,
        "-v", `${resolve(runDir, state.arms[arm].repository)}:/workspace:ro`,
        setupImage, "sh", "-c",
        `set -eu; ${setupCheck} && ${toolCheck}`, 'environment-launch',
        ((state.comparison === "setup-commits" || state.comparison === "custom") ? 'export PATH="/opt/task-deps/python/bin:/usr/local/bin:$PATH"; test "$(command -v codex)" = /usr/local/bin/codex || exit 1; ' + (usesMekugi(state, arm) ? 'test "$(command -v mekugi)" = /usr/local/bin/mekugi || exit 1; ' : '') : '') + 'set -eu; git -c user.useConfigOnly=true var GIT_AUTHOR_IDENT; if test -x /opt/task-deps/python/bin/python; then for interpreter in python python3; do test "$(command -v "$interpreter")" = "/opt/task-deps/python/bin/$interpreter"; "$interpreter" -c "import sys; assert sys.prefix == \'/opt/task-deps/python\'"; done; fi; if test -n "${HOMEBREW_PREFIX:-}"; then command -v brew; brew --version; fi', 'environment-check'] });
    await writeFile(join(runDir, `artifacts/preflight-environment-${arm}.json`), JSON.stringify(environment, null, 2));
    if (/\[WARN\] migrate:/.test(`${environment.stdout}\n${environment.stderr}`)) throw new Error(`setup mise migration failed (${arm}) against the read-only tool snapshot; prepare again from a home with completed mise migrations`);
    if (environment.exitCode !== 0 || environment.timedOut || environment.canceled) throw new Error(`candidate environment preflight failed (${arm}, ${armLabels(state)[arm]}): ${[environment.stdout.trim(), environment.stderr.trim()].filter(Boolean).join("; ")}`);
  }
  if (state.comparison === "codex-mekugi-grok") {
    const grokCheck = await checkSetup("current", { name: `${prefix}-grok`, createArgs: [setupImage, "sh", "-lc",
      "test -x /home/ubuntu/.grok/bin/grok && /home/ubuntu/.grok/bin/grok --version"] });
    await writeFile(join(runDir, "artifacts/preflight-grok.json"), JSON.stringify(grokCheck, null, 2));
    if (grokCheck.exitCode !== 0) throw new Error(`isolated Grok executable cannot run offline: ${[grokCheck.stdout.trim(), grokCheck.stderr.trim()].filter(Boolean).join("; ")}`);
    if (state.runtime_tools.grok_version && !grokCheck.stdout.includes(state.runtime_tools.grok_version.split(" ")[1] ?? "")) {
      throw new Error(`unexpected container Grok version: ${grokCheck.stdout.trim()}`);
    }
  }
  const effectiveMekugiFlags = new Map<ArmName, string[]>();
  const mekugiArms = armNames(state).filter(arm => usesMekugi(state, arm));
  if (mekugiArms.length) {
    progress("checking selected Mekugi flags and exports offline without model access");
    const paired = isPairedMekugiComparison(state.comparison) || (state.comparison === "setup-commits" || state.comparison === "custom");
    const grokComparison = state.comparison === "codex-mekugi-grok";
    const nativeRuntime = state.runtime_tools.mekugi_runtime;
    for (const arm of mekugiArms) {
      const name = `${prefix}-mekugi${paired ? `-${arm}` : ""}`;
      const exports = join(runDir, "artifacts/preflight-mekugi", paired ? arm : "");
      await mkdir(exports, { recursive: true, mode: 0o700 });
      const pinnedPath = state.comparison === "setup-commits" || state.comparison === "custom";
      const launcher = ["-v", `${exports}:/mekugi-exports`, setupImage, "sh", "-lc",
        'export PATH=/home/ubuntu/.local/bin:$PATH && exec "$@"', "preflight",
        ...(pinnedPath ? ["mise", "exec", "--", "sh", "-c", PINNED_LAUNCHER_ENV, "pinned-launcher"] : []),
        ...(nativeRuntime ? [] : ["sh", "-c", MEKUGI_METRICS_WRAPPER, "mekugi-metrics"]),
        pinnedPath ? "/usr/local/bin/mekugi" : "mekugi"];
      let flags = mekugiArmFlags(state, arm);
      if (nativeRuntime && (flags.length || grokComparison)) {
        // An unknown flag before --help sends the rest of argv to Codex, so ask for bare help.
        const help = await checkSetup(arm, { name: `${name}-options`, createArgs: [...launcher, "--help"] });
        if (help.exitCode !== 0 || !/^Usage: mekugi\b/m.test(help.stdout)) {
          throw new Error(`could not read the pinned Mekugi launch options before inference: ${help.stderr.trim() || "expected Mekugi usage"}`);
        }
        const supported = new Set(Array.from(
          help.stdout.matchAll(/^[ \t]+-{1,2}([a-z-]+)(?=\s|$)/gm),
          match => match[1],
        ));
        if (grokComparison && !supported.has("grok-auth-file")) {
          throw new Error("codex-mekugi-grok requires a Mekugi build with built-in Grok OAuth routing; the pinned launcher does not advertise --grok-auth-file");
        }
        flags = flags.filter(flag => {
          const name = flag.slice(2).split("=", 1)[0]!;
          if (supported.has(name)) return true;
          if (name !== "deduplicate-output" || state.protected_runtime || grokComparison) {
            throw new Error(`pinned Mekugi does not support --${name}. Remove it from the arm settings or select a compatible Mekugi build`);
          }
          if (!help.stdout.includes("codex headless --yolo")) throw new Error("pinned Mekugi does not support --deduplicate-output and did not advertise the native headless launcher");
          if (state.comparison === "duplicate-output" || flag === "--deduplicate-output=false") {
            throw new Error("pinned Mekugi does not support --deduplicate-output; native output deduplication cannot be disabled. Select a Mekugi build with the switch for an opt-out or duplicate-output comparison");
          }
          return false;
        });
      }
      const launch = await checkSetup(arm, { name, createArgs: [...launcher, ...flags,
          ...(flags.some(flag => flag === "--debug" || flag === "--debug=true") ? [] : ["--debug"]),
          "--capture-output=/mekugi-exports/capture.jsonl", ...(nativeRuntime ? ["--help"] : [...(grokComparison ? [] : ["codex"]), "--version"])] });
      await writeFile(join(runDir, `artifacts/preflight-mekugi${paired ? `-${arm}` : ""}.json`), JSON.stringify({ ...launch, flags }, null, 2));
      if (launch.exitCode !== 0 || (nativeRuntime && !/^Usage: mekugi\b/m.test(launch.stdout))) {
        throw new Error(`selected Mekugi launcher failed before inference: ${launch.stderr.trim() || "expected Mekugi usage"}`);
      }
      effectiveMekugiFlags.set(arm, flags);
      if (nativeRuntime) {
        const runtime = await checkSetup(arm, {
          name: `${prefix}-mekugi-runtime-${arm}`, timeoutMs: 30000,
          createArgs: [setupImage, "sh", "-c", [
            ...nativeRuntime.map(file => `echo '${file.sha256}  ${MEKUGI_RUNTIME_DIRECTORY}/${file.name}' | sha256sum --check --strict`),
            `${MEKUGI_RUNTIME_DIRECTORY}/mekugi-app-server --version`,
            `${MEKUGI_RUNTIME_DIRECTORY}/bwrap --version`,
            `CODEX_CODE_MODE_HOST=${MEKUGI_RUNTIME_DIRECTORY}/codex-code-mode-host node -e "$1"`,
          ].join(" && "), "mekugi-runtime", TOOLHOST_SMOKE_SCRIPT],
        });
        await writeFile(join(runDir, `artifacts/preflight-mekugi-runtime-${arm}.json`), JSON.stringify(runtime, null, 2));
        if (runtime.exitCode !== 0 || !runtime.stdout.includes("CODEX_AB_TOOL_HOST_OK")) {
          throw new Error(`Mekugi native runtime smoke failed before inference: ${[runtime.stdout.trim(), runtime.stderr.trim()].filter(Boolean).join("; ")}`);
        }
      }
    }
  }
  if (state.protected_runtime) await protectedPreflight(docker, runDir, state, signal);
  progress("preflight passed without model inference");
  return effectiveMekugiFlags;

}

async function preflight(docker: string, state: RunState, runDir: string, externalSignal?: AbortSignal): Promise<Map<ArmName, string[]>> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (externalSignal?.aborted) controller.abort();
  externalSignal?.addEventListener("abort", cancel, { once: true });
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  state.preflight = { status: "running", started_at: new Date().toISOString() };
  try {
    await writeState(runDir, state);
    if (controller.signal.aborted) throw new Error("preflight canceled; no model was launched");
    const flags = await preflightChecks(docker, state, runDir, controller.signal);
    if (controller.signal.aborted) throw new Error("preflight canceled; no model was launched");
    state.preflight.status = "complete";
    return flags;
  } catch (error) {
    state.preflight.status = "failed";
    state.preflight.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    externalSignal?.removeEventListener("abort", cancel);
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    state.preflight.finished_at = new Date().toISOString();
    await writeState(runDir, state);
  }
}

export async function preflightRunUnlocked(runDirectory: string, dockerBin = process.env.CODEX_AB_DOCKER_BIN ?? "docker"): Promise<void> {
  const runDir = resolve(runDirectory);
  const state = await readState(runDir);
  if (state.status !== "prepared") throw new Error(`preflight requires a prepared run, got ${state.status}`);
  await preflight(dockerBin, state, runDir);
}

async function prewarm(docker: string, runDir: string, state: RunState, arm: ArmName, home: string, signal: AbortSignal): Promise<void> {
  const name = `codex-ab-${state.id}-${arm}-agent-warm`;
  const repo = resolve(runDir, state.arms[arm].repository);
  const command = prepareAssets(state);
  const cow = state.runtime_homes?.[arm];
  const template = state.arms[arm].home_template;
  const minimal = state.setup_revisions?.[arm]
    ? state.setup_revisions[arm].commit === "stock"
    : ["snapshots/stock/home/ubuntu", "snapshots/stock-mekugi/home/ubuntu"].includes(template);
  const server = usesMekugi(state, arm) && state.runtime_tools.mekugi_runtime
    ? [`${MEKUGI_RUNTIME_DIRECTORY}/mekugi-app-server`] : ["codex", "app-server"];
  const warm = minimal
    ? ["sh", "-c", 'sh -lc "$1" && shift && exec python3 -c "$@"',
      "minimal-warm", command, checkEmptySkills, ...server]
    : ["sh", "-lc", command];
  const result = await runOwnedContainer({ docker, name, signal, snapshotImage: cow ? `codex-ab-home-changes:${crypto.randomUUID()}` : undefined,
    onSnapshot: image_id => { if (cow) cow.image_id = image_id; }, createArgs: [...containerArgs(state),
    "-v", `${repo}:/workspace`, ...(cow ? await runtimeHomeMounts(home) : ["-v", `${home}:/home/ubuntu`]),
    "--network", "none",
    cow?.image_id ?? imageRef(state), ...warm] });
  if (cow && result.snapshotImageId) cow.image_id = result.snapshotImageId;
  if (result.exitCode !== 0) throw new Error(`${presentationLabel(armNames(state).indexOf(arm))} / ${armLabels(state)[arm]} cache prewarm failed: ${result.stderr.trim()}`);
  await inspectCandidate(docker, runDir, state, repo, `${arm}-warm-verify`, signal, true, true, undefined, await generatedDependencyDirectories(repo));
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
  if (patchStat > 0) await checked(["git", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", evaluator, "apply", "--index", "--binary", patchPath]);
  const captured = state.results?.[arm]?.capture_identity;
  if (captured?.status === "verified") {
    const manifest = await readCandidateManifest(join(runDir, captured.manifest_path), patchPath);
    if (manifest.base_commit !== state.source.base_commit || manifest.base_tree !== state.source.base_tree) throw new Error("candidate capture baseline mismatch");
    if (manifest.captured_tree !== captured.tree || manifest.patch_sha256 !== captured.patch_sha256) throw new Error("retained candidate identity differs from manifest");
    await verifyCandidateReconstruction(evaluator, manifest);
    state.results![arm]!.changed_files = manifest.changed_files;
  }
  await inspectCandidate(docker, runDir, state, evaluator, `${arm}-grade-verify`, signal, true, false);
  const allowedPaths = state.criteria.contract.allowed_paths;
  const forbiddenChanges = allowedPaths ? (state.results?.[arm]?.changed_files ?? []).filter(path => !allowedPaths.includes(path)) : [];
  const ready: CommandEvidence = { command: "immutable candidate capture and task-required change boundaries", started_at: new Date().toISOString(),
    elapsed_ms: 0, exit_code: forbiddenChanges.length ? 1 : 0, stdout: "", stderr: forbiddenChanges.length ? `Outside task change boundary: ${forbiddenChanges.join(", ")}` : "" };
  const pending: CommandEvidence = { ...ready, command: "semantic checks pending independent judges", exit_code: -1 };
  return { preparation: ready, router_suite: pending, elapsed_ms: 0, passed: false };
}

async function runArm(docker: string, runDir: string, state: RunState, arm: ArmName, home: string, output: string, providerNetwork: string, internalNetwork: string | undefined, task: string, signal: AbortSignal, mekugiFlags: readonly string[], retryDelays: readonly number[]): Promise<ArmResult> {
  state = armRuntime(state, arm);
  if (state.arm_settings?.[arm]?.parallel_work) task = parallelWorkTask(task);
  const name = `codex-ab-${state.id}-${arm}`;
  const repository = resolve(runDir, state.arms[arm].repository);
  const stdoutPath = join(output, "codex.jsonl");
  const stderrPath = join(output, "codex.stderr");
  const patchPath = join(output, "changes.patch");
  const started = new Date();
  progress(`${presentationLabel(armNames(state).indexOf(arm))} / ${armLabels(state)[arm]}: agent started`);
  let result: ExecResult | undefined;
  let lifecycleError: string | undefined;
  let runawayGuard: ArmResult["runaway_guard"];
  let egressProxy: EgressProxySidecar | undefined;
  let oomKilled: boolean | undefined;
  let failureClassification: CandidateFailureClassification | undefined;
  const retryAttempts: CandidateRetryAttempt[] = [];
  const initialHomeImage = state.runtime_homes?.[arm]?.image_id;
  let homeImage = initialHomeImage;
  const exportArm = state.comparison === "codex-mekugi-grok" ? "stock" : "current";
  const exports = state.mekugi_exports_by_arm?.[arm] ?? (arm === exportArm ? state.mekugi_exports : undefined);
  const exportArgs = exports
    ? ["--capture-output=/mekugi-exports/capture.jsonl", ...(mekugiFlags.some(flag => flag === "--debug" || flag === "--debug=true") ? [] : ["--debug"])] : [];
  const exportRoot = exports ? dirname(resolve(runDir, exports.capture)) : undefined;
  const exportMount = exportRoot ? ["-v", `${exportRoot}:/mekugi-exports`] : [];
  if (exportRoot) await mkdir(exportRoot, { recursive: true, mode: 0o700 });
  const protectedArm = arm === "current" && state.protected_runtime;
  const runtime = join(dirname(repository), "runtime");
  const ownedPaths = [repository, home, ...(exportRoot ? [exportRoot] : []), runtime];
  if (protectedArm) await mkdir(runtime, { recursive: true });
  const grokArm = state.comparison === "codex-mekugi-grok" && arm === "current";
  const mekugiArm = usesMekugi(state, arm);
  const grokCommand = grokArm
    ? ["grok", "--prompt-file", "/control/task.md", "--cwd", "/workspace", "-m", "grok-4.7", "--reasoning-effort", state.execution.reasoning_effort, "--always-approve", "--sandbox", "off", "--output-format", "json", "--disable-web-search"]
    : undefined;
  const codexLauncher = mekugiArm ? [(state.comparison === "setup-commits" || state.comparison === "custom") ? "/usr/local/bin/mekugi" : "mekugi", ...mekugiFlags, ...exportArgs, ...(state.comparison === "codex-mekugi-grok" ? [] : ["codex"])] : [(state.comparison === "setup-commits" || state.comparison === "custom") ? "/usr/local/bin/codex" : "codex"];
  const mekugiLauncher = exportArgs.length ? ["sh", "-c", MEKUGI_METRICS_WRAPPER, "mekugi-metrics", ...codexLauncher] : codexLauncher;
  const launcher = grokCommand ?? (usesMise(state, arm) ? ["mise", "exec", "--", ...((state.comparison === "setup-commits" || state.comparison === "custom") ? ["sh", "-c", PINNED_LAUNCHER_ENV, "pinned-launcher"] : []), ...mekugiLauncher] : mekugiLauncher);
  const grokPath = grokArm ? ["-e", `PATH=/home/ubuntu/.grok/bin:${TASK_PATH}`, "-e", "GROK_HOME=/home/ubuntu/.grok"] : ["-e", `PATH=${TASK_PATH}`];
  const promptPath = join(output, "task.md");
  await writeFile(promptPath, task);
  const grokTask = grokArm ? ["-v", `${promptPath}:/control/task.md:ro`] : [];
  const debugStorage = mekugiArm && !protectedArm
    ? ["--tmpfs", `/home/ubuntu/.local/state/mekugi/debug:size=4g,mode=0700,uid=${state.operator.uid},gid=${state.operator.gid}`] : [];
  if (debugStorage.length) await mkdir(join(home, ".local/state/mekugi/debug"), { recursive: true, mode: 0o700 });
  const executionArgs = grokArm ? [] : [
    ...(mekugiArm ? ["headless", "--yolo", "-c", "bypass_hook_trust=true"] : ["exec", "--json", "--color", "never", "--dangerously-bypass-hook-trust", "-C", "/workspace"]),
    "--model", state.execution.model,
    "-c", `model_reasoning_effort=${JSON.stringify(state.execution.reasoning_effort)}`,
    "-c", `service_tier=${JSON.stringify(state.execution.service_tier)}`,
    "-c", 'approval_policy="never"', "-c", 'sandbox_mode="danger-full-access"',
    ...(state.auto_compact_limit !== undefined ? ["-c", `model_auto_compact_token_limit=${state.auto_compact_limit}`] : []),
    ...(mekugiArm ? [] : ["-"]),
  ];
  const armController = new AbortController();
  if (signal.aborted) armController.abort();
  const onParentAbort = () => armController.abort();
  signal.addEventListener("abort", onParentAbort, { once: true });
  const guard = startRunawayGuard({
    stdoutPath,
    config: state.runaway_guard,
    controller: armController,
    onTrigger: trigger => {
      progress(`${presentationLabel(armNames(state).indexOf(arm))} / ${armLabels(state)[arm]}: runaway guard triggered (${trigger.reason}): ${trigger.detail}`);
    },
  });
  try {
    const closedBookPolicy = state.network_policy?.closed_book ? state.network_policy : undefined;
    if (closedBookPolicy) {
      if (!internalNetwork) throw new Error(`closed-book arm ${arm} is missing its internal Docker network`);
      egressProxy = await startEgressProxySidecar({
        docker,
        name: `${name}-egress-proxy`,
        image: imageRef(state),
        providerNetwork,
        candidateInternalNetwork: internalNetwork,
        allowedHosts: closedBookPolicy.allowed_hosts,
        auditDir: output,
        signal,
      });
    }
    if (protectedArm) await executorOwnership(docker, state, `${name}-own`, ownedPaths, false);

  } catch (error) {
    lifecycleError = error instanceof Error ? error.message : String(error);
  }
  const maxAttempts = retryDelays.length + 1;
  const deadlineMs = started.getTime() + state.timeout_seconds * 1000;
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (lifecycleError || signal.aborted) break;
      const remainingTimeoutMs = deadlineMs - Date.now();
      if (attempt > 1 && remainingTimeoutMs <= 0) break;
      const attemptStartedAt = new Date().toISOString();
      homeImage = initialHomeImage;
      result = undefined;
      oomKilled = undefined;
      failureClassification = undefined;
      try {
        const execution = await runOwnedContainer({ docker, name, signal: armController.signal, snapshotImage: homeImage ? `codex-ab-home-changes:${crypto.randomUUID()}` : undefined,
          onSnapshot: image_id => { homeImage = image_id; }, stdin: grokArm ? undefined : task, stdoutFile: stdoutPath, stderrFile: stderrPath, timeoutMs: attempt === 1 ? state.timeout_seconds * 1000 : remainingTimeoutMs, createArgs: [...containerArgs(state), "--network", internalNetwork ?? providerNetwork, ...(egressProxy ? egressProxy.envArgs : []), "--workdir", "/workspace", ...(grokArm ? [] : ["-i"]), ...grokPath,
          "-v", `${repository}:/workspace`, ...(homeImage ? await runtimeHomeMounts(home) : ["-v", `${home}:/home/ubuntu`]), ...await currentSetupMounts(runDir, state, arm, home), ...exportMount, ...grokTask, ...debugStorage,
          ...(protectedArm ? protectedArgs(runDir, state, runtime) : []),
          homeImage ?? imageRef(state), ...launcher, ...executionArgs] });
        result = execution;
        oomKilled = execution.oomKilled;
        if (execution.snapshotImageId) homeImage = execution.snapshotImageId;
      } catch (error) {
        lifecycleError = error instanceof Error ? error.message : String(error);
        if (error instanceof OwnedContainerError) {
          if (error.result) result = error.result;
          if (error.snapshotImageId) homeImage = error.snapshotImageId;
          if (error.oomKilled !== undefined) oomKilled = error.oomKilled;
        }
      }
      const attemptFinishedAt = new Date().toISOString();
      const shouldClassify = oomKilled === true
        || (result !== undefined && result.exitCode !== 0 && !result.timedOut && !result.canceled && !lifecycleError && !signal.aborted && !armController.signal.aborted);
      if (shouldClassify) {
        const [stderr, stdout] = await Promise.all([
          readFile(stderrPath, "utf8").catch(() => ""),
          readFile(stdoutPath, "utf8").catch(() => ""),
        ]);
        failureClassification = classifyCandidateFailure({
          exitCode: result?.exitCode ?? -1,
          oomKilled,
          stderr,
          stdout,
        });
      }
      if (
        attempt >= maxAttempts
        || signal.aborted
        || armController.signal.aborted
        || lifecycleError
        || !result
        || result.timedOut
        || result.canceled
        || oomKilled === true
        || !failureClassification?.retryable
        || !(await isWorkspaceClean(repository, state.source.base_commit))
      ) break;
      const backoffMs = retryDelays[attempt - 1] ?? 0;
      if (Date.now() + backoffMs >= deadlineMs) break;
      const archived = await archiveAttemptLogs(output, attempt, stdoutPath, stderrPath);
      if (exportRoot) await archiveExportDirectory(output, attempt, exportRoot);
      retryAttempts.push({
        attempt,
        started_at: attemptStartedAt,
        finished_at: attemptFinishedAt,
        exit_code: result.exitCode,
        reason: failureClassification.reason,
        detail: failureClassification.detail,
        stdout_path: relative(runDir, archived.stdoutPath),
        stderr_path: relative(runDir, archived.stderrPath),
      });
      progress(`${presentationLabel(armNames(state).indexOf(arm))} / ${armLabels(state)[arm]}: attempt ${attempt} failed (${failureClassification.reason}); retrying in ${backoffMs}ms`);
      if (backoffMs > 0) {
        try { await delay(backoffMs, undefined, { signal }); }
        catch {
          await writeFile(stdoutPath, "");
          await writeFile(stderrPath, "");
          break;
        }
      }
    }
  } finally {
    runawayGuard = await guard.stop();
    signal.removeEventListener("abort", onParentAbort);
    if (egressProxy) {
      try { await egressProxy.stop(); }
      catch (error) { lifecycleError = `${lifecycleError ?? ""} ${String(error)}`.trim(); }
    }
    if (egressProxy) {
      try { await egressProxy.stop(); }
      catch (error) { lifecycleError = `${lifecycleError ?? ""} ${String(error)}`.trim(); }
    }
  }
  if (protectedArm) {
    try { await executorOwnership(docker, state, `${name}-restore`, ownedPaths, true); }
    catch (error) { lifecycleError = `${lifecycleError ?? ""} ${String(error)}`.trim(); }
  }
  if (!lifecycleError) await discardDownloadedCatalog(home, resolve(runDir, state.arms[arm].home_template));
  const finishedAt = new Date().toISOString();
  const userCanceled = signal.aborted;
  const triggeredByGuard = Boolean(runawayGuard?.triggered) && !userCanceled;
  const totalElapsedMs = retryAttempts.length ? Math.max(result?.elapsedMs ?? 0, Date.now() - started.getTime()) : (result?.elapsedMs ?? 0);
  progress(`${presentationLabel(armNames(state).indexOf(arm))} / ${armLabels(state)[arm]}: agent stopped after ${Math.round(totalElapsedMs / 1000)}s${lifecycleError ? ` (${lifecycleError})` : ""}`);
  return {
    arm,
    anonymous_id: `candidate-${armNames(state).indexOf(arm) + 1}`,
    container: name,
    started_at: started.toISOString(),
    finished_at: finishedAt,
    agent_elapsed_ms: totalElapsedMs,
    exit_code: result?.exitCode ?? -1,
    timed_out: (result?.timedOut ?? false) || triggeredByGuard,
    canceled: userCanceled || (!triggeredByGuard && result?.canceled === true),
    ...(runawayGuard ? { runaway_guard: runawayGuard } : {}),
    ...(oomKilled !== undefined ? { oom_killed: oomKilled } : {}),
    ...(failureClassification ? { failure_classification: failureClassification } : {}),
    ...(retryAttempts.length ? { retry_attempts: retryAttempts } : {}),
    patch_path: patchPath.slice(runDir.length + 1),
    stdout_path: stdoutPath.slice(runDir.length + 1),
    stderr_path: stderrPath.slice(runDir.length + 1),
    changed_files: [],
    head_after_agent: "",
    lifecycle_error: lifecycleError,
    home_image_id: homeImage,
  };
}

async function collectArm(docker: string, runDir: string, state: RunState, arm: ArmName, result: ArmResult, discardDependencies?: string[]): Promise<void> {
  const repository = resolve(runDir, state.arms[arm].repository);
  const patchPath = join(runDir, result.patch_path);
  try {
    // Cleanup has completed before collection. Use a fresh signal so canceled
    // inference can still preserve its available patch without launching models.
    const destination = await mkdtemp(join(dirname(patchPath), "capture-"));
    await inspectCandidate(docker, runDir, state, repository, `${arm}-capture`, new AbortController().signal, false, false, destination, discardDependencies);
    const generatedPatch = join(destination, "changes.patch");
    const manifest = await readCandidateManifest(join(destination, "candidate-manifest.json"), generatedPatch);
    const metadata = JSON.parse((await readRegularEvidence(join(destination, "result.json"))).toString("utf8")) as { head_after_agent?: unknown };
    if (typeof metadata.head_after_agent !== "string" || !/^[0-9a-f]{40}$/.test(metadata.head_after_agent)) throw new Error("invalid capture metadata");
    // Only fresh output was writable in the collector; publish after validation.
    await copyFile(generatedPatch, patchPath, 1);
    const manifestPath = join(dirname(patchPath), "candidate-manifest.json");
    await copyFile(join(destination, "candidate-manifest.json"), manifestPath, 1);
    result.capture_identity = { status: "verified", manifest_path: relative(runDir, manifestPath), tree: manifest.captured_tree, patch_sha256: manifest.patch_sha256 };
    result.changed_files = manifest.changed_files;
    result.head_after_agent = metadata.head_after_agent;
  } catch (error) {
    result.collection_error = error instanceof Error ? error.message : String(error);
    // Do not follow or overwrite a candidate-created capture symlink on failure.
    progress(`${presentationLabel(armNames(state).indexOf(arm))} / ${armLabels(state)[arm]}: inference evidence persisted but patch collection failed: ${result.collection_error}`);
  }
}

export async function runPairUnlocked(options: RunOptions): Promise<RunState> {
  const runDir = resolve(options.runDir);
  const state = await readState(runDir);
  if (state.status !== "prepared") throw new Error(`run is ${state.status}; prepare a new run instead of resuming or restarting it`);
  if (!state.criteria) throw new Error("run has no evaluator contract; prepare with --criteria");
  if (state.fixed_verifier) {
    if (options.importArms?.length || state.planned_imports?.length || options.controlRun || state.evaluation?.mode === "reuse") throw new Error("fixed-verifier runs require fresh arms; historical fixed-verifier reuse is not supported");
    await verifyFixedInputs(runDir, state);
  }
  options = { ...options, importArms: options.importArms ?? state.planned_imports };
  state.evaluation = evaluationPlan(options.evaluationMode ?? state.evaluation?.mode,
    options.evaluationBaselines ?? (options.evaluationMode === "fresh" ? undefined : state.evaluation?.baselines), options.importArms, armNames(state));
  if (options.importArms && (options.arm || options.controlRun || options.controlBundleSha256)) throw new Error("--import-arms cannot be combined with --arm or --control-run");
  if (options.controlRun && options.arm) throw new Error("--control-run selects the current treatment arm; do not pass --arm");
  if (Boolean(options.controlRun) !== Boolean(options.controlBundleSha256)) throw new Error("--control-run requires --control-bundle-sha256 and vice versa");
  const retryDelays = resolveRetryDelaysMs(options.retryDelaysMs);
  const docker = options.dockerBin ?? process.env.CODEX_AB_DOCKER_BIN ?? "docker";
  const mekugiFlags = await preflight(docker, state, runDir, options.signal);
  const imported = options.controlRun ? await importControl(runDir, state, options.controlRun, options.controlBundleSha256!) : undefined;
  const importedResults = options.importArms ? await importArms(runDir, state, options.importArms) : {};
  await writeState(runDir, state);
  const controller = new AbortController();
  if (options.signal?.aborted) controller.abort();
  const externalCancel = () => controller.abort();
  options.signal?.addEventListener("abort", externalCancel, { once: true });
  const arms = armNames(state);
  if (options.arm && !arms.includes(options.arm)) throw new Error("unknown arm key");
  const activeArms: ArmName[] = imported ? ["current"] : options.arm ? [options.arm] : arms.filter(arm => !importedResults[arm]);
  const selectedArms: ArmName[] = imported || options.importArms ? arms : activeArms;
  const labels = armLabels(state);
  const displayArm = (arm: ArmName): string => `${presentationLabel(arms.indexOf(arm))} / ${labels[arm]}`;
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  const providerNetworks: Record<string, OwnedNetwork> = {};
  const internalNetworks: Record<string, OwnedNetwork> = {};
  const appendError = (message: string) => {
    if (!message) return;
    if (!state.error) state.error = message;
    else if (!state.error.includes(message)) state.error = `${state.error}; ${message}`;
  };
  try {
    state.network_policy ??= buildNetworkPolicy({ mode: "closed-book", comparison: state.comparison });
    for (const arm of activeArms) {
      providerNetworks[arm] = await createOwnedNetwork(docker, `codex-ab-${state.id}-provider-${arm}`, controller.signal);
      if (state.network_policy.closed_book) {
        internalNetworks[arm] = await createOwnedNetwork(docker, `codex-ab-${state.id}-candidate-${arm}`, controller.signal, { internal: true });
      }
    }
    const auth = resolve(options.authFile);
    const authMode = (await import("node:fs/promises")).stat(auth).then(s => s.mode & 0o777);
    if ((await authMode) & 0o077) throw new Error("auth file must not be accessible by group or others (expected mode 0600)");
    const setupResults: PromiseSettledResult<readonly [ArmName, Awaited<ReturnType<typeof setupArm>>]>[] = [];
    for (const arm of activeArms) {
      try { setupResults.push({ status: "fulfilled", value: [arm, await setupArm(runDir, state, arm, auth, options.grokAuthFile, docker, controller.signal)] }); }
      catch (reason) { setupResults.push({ status: "rejected", reason }); break; }
    }
    const setupFailure = setupResults.find(result => result.status === "rejected");
    if (setupFailure?.status === "rejected") throw setupFailure.reason;
    const setups = Object.fromEntries(setupResults.map(result => (result as PromiseFulfilledResult<readonly [ArmName, Awaited<ReturnType<typeof setupArm>>]>).value)) as Partial<Record<ArmName, Awaited<ReturnType<typeof setupArm>>>>;
    if (controller.signal.aborted) throw new Error("canceled during private arm setup; no model was launched");
    state.status = "running";
    state.results = imported ? { stock: imported } : importedResults;
    state.selected_arms = selectedArms;
    await writeState(runDir, state);
    progress(activeArms.length === 1 ? "preparing task dependencies for the selected arm" : "preparing identical task dependencies for both arms");
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
      await inspectCandidate(docker, runDir, state, repo, `${arm}-launch-verify`, controller.signal, true, true, undefined, generatedDependencies[arm]);
    }
    const order = state.arm_order ?? "concurrent";
    if (!["concurrent", "stock-first", "current-first"].includes(order)) throw new Error("invalid arm execution order");
    state.arm_attempts = imported ? { stock: { codex_home: join(dirname(state.arms.stock.repository), "home/ubuntu/.codex"), container: imported.container,
      started_at: imported.started_at, finished_at: imported.finished_at, status: "stopped" } } : state.arm_attempts ?? {};
    const batches: ArmName[][] = order === "concurrent" ? [activeArms]
      : (order === "stock-first" ? arms : [...arms].reverse()).filter(arm => activeArms.includes(arm)).map(arm => [arm]);
    progress(`agent execution order: ${order === "concurrent" ? "concurrent" : `${displayArm(batches[0]![0]!)} first`}`);
    for (const batch of batches) {
      if (controller.signal.aborted) break;
      for (const arm of batch) state.arm_attempts[arm] = {
        codex_home: relative(runDir, join(setups[arm]!.home, ".codex")),
        grok_home: state.comparison === "codex-mekugi-grok" ? relative(runDir, join(setups[arm]!.home, ".grok")) : undefined,
        container: `codex-ab-${state.id}-${arm}`,
        started_at: new Date().toISOString(),
        status: "started",
      };
      await writeState(runDir, state);
      const settled = await Promise.allSettled(batch.map(arm => runArm(docker, runDir, state, arm, setups[arm]!.home, setups[arm]!.output, providerNetworks[arm]!.name, internalNetworks[arm]?.name, task, controller.signal, mekugiFlags.get(arm) ?? [], retryDelays)));
      settled.forEach((item, index) => {
        const arm = batch[index]!;
        const attempt = state.arm_attempts![arm]!;
        attempt.finished_at = new Date().toISOString();
        if (item.status === "fulfilled") {
          state.results![arm] = item.value;
          const result = item.value;
          attempt.home_image_id = result.home_image_id;
          attempt.status = armExecutionSucceeded(result) ? "stopped" : "failed";
          if (attempt.status === "failed") {
            attempt.error = result.lifecycle_error
              ?? (result.canceled ? "agent canceled"
                : result.runaway_guard?.triggered ? `runaway guard triggered (${result.runaway_guard.reason}): ${result.runaway_guard.detail}`
                : result.timed_out ? "agent timed out"
                : result.oom_killed ? "agent container OOM-killed"
                : result.failure_classification
                  ? `agent exited with code ${result.exit_code} (${result.failure_classification.reason}: ${result.failure_classification.detail})`
                  : `agent exited with code ${result.exit_code}`);
            const message = `${displayArm(arm)}: ${attempt.error}; see ${result.stderr_path}`;
            state.error = state.error ? `${state.error}; ${message}` : message;
            progress(message);
          }
        } else {
          attempt.status = "failed";
          attempt.error = String(item.reason);
          const message = `${displayArm(arm)}: failed to collect result: ${String(item.reason)}`;
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
    collected.forEach((item, index) => {
      if (item.status === "rejected") {
        const arm = activeArms[index]!;
        const reason = item.reason instanceof Error ? item.reason.message : String(item.reason);
        const result = state.results?.[arm];
        if (result && !result.collection_error) result.collection_error = reason;
        appendError(`${displayArm(arm)}: collection failed: ${reason}`);
      }
    });
    for (const result of Object.values(state.results)) {
      if (result?.collection_error) appendError(result.collection_error);
    }
    await writeState(runDir, state);
    const succeededArms = selectedArms.filter(arm => armExecutionSucceeded(state.results?.[arm]));
    if (!controller.signal.aborted && succeededArms.length > 0) {
      progress(succeededArms.length === selectedArms.length
        ? "all selected candidates captured; starting evaluator-only grading"
        : `${succeededArms.map(displayArm).join(", ")} captured; starting evaluator-only grading for succeeded arm(s)`);
      const graded = await Promise.allSettled(succeededArms.map(async arm => {
        if (state.evaluation?.mode === "reuse" && state.imported_arms?.[arm]) return;
        const result = state.results![arm]!;
        result.grade = await gradeArm(docker, runDir, state, arm, join(runDir, result.patch_path), controller.signal);
        progress(`${displayArm(arm)}: prepared for independent semantic assessment`);
      }));
      await writeState(runDir, state);
      const gradeFailures = graded.flatMap((result, index) => result.status === "rejected"
        ? [{ arm: succeededArms[index]!, reason: result.reason }] : []);
      if (gradeFailures.length === 1) throw gradeFailures[0]!.reason;
      if (gradeFailures.length > 1) {
        throw new Error(gradeFailures.map(item => `${displayArm(item.arm)}: ${item.reason instanceof Error ? item.reason.message : String(item.reason)}`).join("; "));
      }
    }
    const cleanup = await Promise.allSettled([...Object.values(internalNetworks), ...Object.values(providerNetworks)].map(network => network.remove()));
    const cleanupFailure = cleanup.find(item => item.status === "rejected");
    if (cleanupFailure?.status === "rejected") throw cleanupFailure.reason;
    state.status = !controller.signal.aborted && selectedArms.every(arm => armExecutionSucceeded(state.results?.[arm]) && state.results![arm]!.grade) ? "complete" : "partial";
    await writeState(runDir, state);
    return state;
  } catch (error) {
    state.status = "partial";
    appendError(error instanceof Error ? error.message : String(error));
    await writeState(runDir, state);
    throw error;
  } finally {
    await Promise.allSettled([...Object.values(internalNetworks), ...Object.values(providerNetworks)].map(network => network.remove()));
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
