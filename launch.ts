import { parseArmConfigurations } from "./arms";
import { REASONING_EFFORTS } from "./types";
import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { exec, checked } from "./process";
import { prepare, type PrepareOptions } from "./prepare";
import { sha256 } from "./state";
import { runBenchmark } from "./workflow";
import { prepareTrials, runTrials } from "./trials";
import { validateMekugiFlags } from "./mekugi";
import type { CliOptions } from "./cli-options";

export const COMPARISONS = [
  { id: "custom", title: "Custom composition", a: "First setup", b: "Additional setups", description: "Compare two or more Codex or Mekugi setups with Stock guidance or a committed revision." },
  { id: "setup-commits", title: "Setup commit versus setup commit", a: "Setup commit A", b: "Setup commit B", description: "Compare two configuration revisions with the same launcher and pinned runtime binaries." },
  { id: "stock-current", title: "Minimal versus current setup", a: "Codex · minimal setup", b: "Codex · current setup", description: "Measure the complete instruction and tool setup." },
  { id: "same-setup", title: "Current Codex versus Mekugi", a: "Codex · current setup", b: "Mekugi · current setup", description: "Keep guidance fixed; change the launcher." },
  { id: "stock-mekugi", title: "Minimal Codex versus minimal Mekugi", a: "Codex · minimal setup", b: "Mekugi · minimal setup", description: "Isolate the launcher with minimal guidance." },
  { id: "duplicate-output", title: "Duplicate output off versus on", a: "Mekugi · projection off", b: "Mekugi · projection on", description: "Keep the current setup and compare output projection." },
  { id: "codex-mekugi-grok", title: "Mekugi versus Grok CLI", a: "Mekugi · Grok", b: "Grok CLI", description: "Compare launchers on the fixed Grok model." },
];

export function taskCatalog() {
  const userRoot = homedir();
  return [
    { id: "nvm-download-no-eval", title: "NVM download arguments", source: process.env.CODEX_AB_SOURCE_DIR ?? join(tmpdir(), "codex-ab-nvm-source"), timeout: 1800, effort: "medium", pack: "tasks/nvm-download-no-eval/manifest.json", repository: "https://github.com/nvm-sh/nvm.git" },
    { id: "skills-mgr-agent-cli", title: "Skills manager repository-to-agent workflow", source: process.env.CODEX_AB_SKILLS_MGR_SOURCE ?? join(userRoot, "projects/skills-mgr"), timeout: 7200, effort: "xhigh", pack: "tasks/skills-mgr-agent-cli/manifest.json" },
    { id: "session-retention", title: "Mekugi coordination checkpoints", source: process.env.CODEX_AB_MEKUGI_SOURCE ?? join(userRoot, "projects/mekugi"), timeout: 3600, effort: "xhigh", pack: "tasks/session-retention/manifest.json" },
    { id: "sqlite-utils-history", title: "sqlite-utils multi-commit upgrade", source: process.env.CODEX_AB_SQLITE_UTILS_SOURCE ?? join(tmpdir(), "codex-ab-sqlite-utils-source"), timeout: 3300, effort: "xhigh", pack: "tasks/sqlite-utils-history/manifest.json",
      repository: "https://github.com/simonw/sqlite-utils.git", compactLimit: 200000, preset: "stock-mekugi" },
    ...["gin-context-copy", "flask-ipv6-server-name", "express-transfer-encoding"].map(id => ({ id, title: id === "gin-context-copy" ? "Gin context copy" : id === "flask-ipv6-server-name" ? "Flask IPv6 server name" : "Express transfer encoding", source: join(userRoot, "projects", id.split("-")[0]!), timeout: 1800, effort: "medium", pack: `tasks/${id}/manifest.json` })),
    { id: "custom", title: "Custom task or portable pack", source: "", timeout: 1800, effort: "medium", pack: "" },
  ];
}
export function launchDefaults(): CliOptions {
  return {
    preset: "stock-current", task: "nvm-download-no-eval", model: "gpt-6-astra", count: "1", order: "concurrent",
    "current-home": homedir(), image: process.env.CODEX_AB_IMAGE ?? "codex-ab:0.1.0",
    "docker-bin": process.env.CODEX_AB_DOCKER_BIN ?? "docker",
    "codex-bin": process.env.CODEX_AB_CODEX_BIN ?? join(homedir(), ".local/bin/codex"),
    "mekugi-source": process.env.CODEX_AB_MEKUGI_SOURCE ?? join(homedir(), "projects/mekugi"),
    "mekugi-bin": process.env.CODEX_AB_MEKUGI_BIN ?? join(homedir(), "go/bin/mekugi"),
    "grok-bin": process.env.CODEX_AB_GROK_BIN ?? join(homedir(), ".grok/bin/grok"),
    "auth-file": process.env.CODEX_AB_AUTH_FILE ?? join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json"),
    "grok-auth-file": process.env.CODEX_AB_GROK_AUTH_FILE ?? join(homedir(), ".grok/auth.json"),
  };
}
const stringOption = (o: CliOptions, key: string, fallback = ""): string => typeof o[key] === "string" ? o[key] as string : fallback;
function positive(value: string, label: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) throw new Error(`${label} must be a positive integer`);
  return Number(value);
}
export function launchConfiguration(input: CliOptions): { prepare: PrepareOptions; count: number; order: "concurrent" | "alternating"; docker: string; auth: string; grokAuth: string; prepareOnly: boolean } {
  const defaults = taskCatalog().find(task => task.id === input.task);
  const taskDefaults: CliOptions = defaults?.preset && !input.preset && !input.comparison
    ? { preset: defaults.preset } : {};
  const o: CliOptions = { ...launchDefaults(), ...taskDefaults, ...input };
  const task = taskCatalog().find(task => task.id === o.task);
  if (!task) throw new Error("Choose a supported task");
  const preset = stringOption(o, "comparison", stringOption(o, "preset"));
  const comparison = preset === "current-vs-current-mekugi" ? "same-setup" : preset;
  if (!COMPARISONS.some(item => item.id === comparison)) throw new Error("Choose a supported comparison");
  if (o["current-launcher"] && !["codex", "mekugi"].includes(String(o["current-launcher"]))) throw new Error("Current launcher must be codex or mekugi");
  if (task.id === "session-retention" && !["stock-current", "setup-commits"].includes(comparison)) throw new Error("Mekugi comparisons require a task outside Mekugi; choose another task");
  if (o["journal-compaction"] !== undefined) throw new Error("Journal compaction is no longer supported");
  const flags = validateMekugiFlags(o["mekugi-flags"] ? JSON.parse(stringOption(o, "mekugi-flags")) : []);
  const count = positive(stringOption(o, "count", "1"), "Repeat count");
  const order = stringOption(o, "order", "concurrent");
  if (order !== "concurrent" && order !== "alternating") throw new Error("Order must be concurrent or alternating");
  const model = comparison === "codex-mekugi-grok" ? "grok:grok-4.7" : stringOption(o, "model", "gpt-6-astra");
  if (comparison !== "codex-mekugi-grok" && !["gpt-6-astra", "gpt-6.1-sol"].includes(model)) throw new Error("Model must be gpt-6-astra or gpt-6.1-sol");
  const effort = stringOption(o, "reasoning-effort", comparison === "codex-mekugi-grok" ? "high" : task.effort);
  if (!REASONING_EFFORTS.some(value => value === effort)) throw new Error(`Choose reasoning effort: ${REASONING_EFFORTS.join(", ")}`);
  // Apply the same Codex context limit to both minimal launcher arms.
  const limitText = o["auto-compact-limit"] ?? (comparison === "stock-mekugi" && task.compactLimit ? String(task.compactLimit) : undefined);
  const limit = limitText === undefined ? undefined : positive(String(limitText), "Compaction token limit");
  if (limit !== undefined && comparison !== "stock-mekugi") throw new Error("A compaction token limit applies only to stock-mekugi");
  const customArms = comparison === "custom" ? parseArmConfigurations(JSON.parse(stringOption(o, "arms", "[]"))) : undefined;
  if (comparison !== "custom" && o.arms !== undefined) throw new Error("--arms requires the custom comparison");
  const mekugi = customArms ? customArms.some(arm => arm.launcher === "mekugi") : !["stock-current", "setup-commits"].includes(comparison) || o["current-launcher"] === "mekugi";
  if (["stock-mekugi", "codex-mekugi-grok"].includes(comparison) && o["review-treatment"]) throw new Error("This comparison does not accept a reviewer overlay");
  if (o["protect-mekugi"] && (!mekugi || ["stock-mekugi", "codex-mekugi-grok", "duplicate-output"].includes(comparison))) throw new Error("Protected runtime requires current-setup Mekugi or same-setup");
  if (comparison === "duplicate-output" && flags.some(flag => flag === "--deduplicate-output" || flag.startsWith("--deduplicate-output="))) throw new Error("The paired feature comparison owns its treatment flag and requires Mekugi Codex routing");
  if (o["mekugi-build"] && (input["mekugi-bin"] || input["mekugi-source"])) throw new Error("A captured Mekugi build owns its source and executable");
  const setupACommit = stringOption(o, "setup-a-commit").trim();
  const setupBCommit = stringOption(o, "setup-b-commit").trim();
  if (comparison === "setup-commits" ? !setupACommit || !setupBCommit : Boolean(setupACommit || setupBCommit)) throw new Error("Choose both setup commits only for setup-commits");
  if (["setup-commits", "custom"].includes(comparison) && (o["review-treatment"] || o["protect-mekugi"])) throw new Error("Setup commits cannot use reviewer overlays or asymmetric protected runtime");
  const source = stringOption(o, "source", task.source);
  if (!source.trim()) throw new Error("Source checkout is required");
  const custom = task.id === "custom";
  const pack = stringOption(o, "task-pack", task.pack);
  if (custom && !pack && ["base", "forbidden", "task-file", "criteria"].some(key => !stringOption(o, key))) throw new Error("A custom task needs a pack, or base, forbidden commit, task file, and criteria file");
  if (pack && ["base", "forbidden", "task-file", "criteria", "profile"].some(key => o[key] !== undefined)) throw new Error("A task pack owns its profile, commits, prompt, and criteria");
  const cpus = stringOption(o, "cpus", "2");
  if (!Number.isFinite(Number(cpus)) || Number(cpus) <= 0) throw new Error("CPU limit must be positive");
  const memory = stringOption(o, "memory", "4g");
  if (!/^[1-9]\d*(?:[bkmg])?$/i.test(memory)) throw new Error("Memory limit must be positive, for example 4g");
  const profile = stringOption(o, "profile", "task");
  if (!["mekugi", "task", "skills-mgr-bundle", "godoxy-icons"].includes(profile)) throw new Error("Unknown task profile");
  return {
    prepare: {
      arms: customArms,
      setupACommit: setupACommit || undefined, setupBCommit: setupBCommit || undefined,
      comparison: comparison as PrepareOptions["comparison"], model: model as PrepareOptions["model"], reasoningEffort: effort as PrepareOptions["reasoningEffort"],
      parallelWork: o["parallel-work"] === true,
      source: source.trim() ? resolve(source) : "", profile: profile as PrepareOptions["profile"],
      baseCommit: stringOption(o, "base"),
      forbiddenCommit: stringOption(o, "forbidden"),
      taskPath: resolve(stringOption(o, "task-file", "tasks/session-retention/task.md")),
      criteriaPath: pack ? undefined : resolve(stringOption(o, "criteria")),
      taskPackPath: pack ? resolve(pack) : undefined,
      currentHome: resolve(stringOption(o, "current-home")), image: stringOption(o, "image"), cpus, memory,
      timeoutSeconds: positive(stringOption(o, "timeout", String(task.timeout)), "Timeout"), autoCompactLimit: limit,
      codexBinary: stringOption(o, "codex-bin"), bunBinary: stringOption(o, "bun-bin") || undefined,
      currentLauncher: mekugi ? comparison === "codex-mekugi-grok" ? "grok" : "mekugi" : "codex",
      mekugiSource: mekugi && !o["mekugi-build"] ? stringOption(o, "mekugi-source") : undefined,
      mekugiBinary: mekugi && !o["mekugi-build"] ? stringOption(o, "mekugi-bin") : undefined,
      mekugiBuild: stringOption(o, "mekugi-build") || undefined, mekugiFlags: mekugi ? flags : [],
      grokBinary: comparison === "codex-mekugi-grok" ? stringOption(o, "grok-bin") : undefined,
      protectMekugi: o["protect-mekugi"] === true, reviewTreatment: stringOption(o, "review-treatment") || undefined,
      outputParent: stringOption(o, "output-parent") || undefined,
    },
    count, order, docker: stringOption(o, "docker-bin"), auth: stringOption(o, "auth-file"), grokAuth: stringOption(o, "grok-auth-file"), prepareOnly: o["prepare-only"] === true,
  };
}

export async function ensureLaunchImage(options: { image: string; codexBinary: string; docker: string; signal?: AbortSignal }, progress: (message: string) => void): Promise<void> {
  const codex = await realpath(options.codexBinary);
  const host = join(dirname(codex), "codex-code-mode-host");
  await Promise.all([access(codex, constants.X_OK), access(host, constants.X_OK)]);
  const [codexHash, hostHash] = await Promise.all([sha256(codex), sha256(host)]);
  const execute = (args: string[]) => exec([options.docker, ...args], { signal: options.signal });
  const inspect = await execute(["image", "inspect", "--format", "{{.Id}}", options.image]);
  let reason = "";
  if (inspect.exitCode !== 0) {
    if (!/No such image|not found/i.test(inspect.stderr)) throw new Error(`Cannot inspect Docker image: ${inspect.stderr.trim()}`);
    reason = "missing image";
  } else {
    const identity = await execute(["run", "--rm", "--network", "none", options.image, "sh", "-lc", 'printf "%s:%s\\n" "$(id -u)" "$(id -g)"']);
    if (identity.exitCode !== 0) throw new Error(`Cannot verify operator identity: ${identity.stderr.trim()}`);
    if (identity.stdout.trim() !== "1000:1000") reason = `operator identity is ${identity.stdout.trim()}`;
    if (!reason) {
      const hashes = await execute(["run", "--rm", "--network", "none", options.image, "sha256sum", "/usr/local/bin/codex", "/usr/local/bin/codex-code-mode-host"]);
      if (hashes.exitCode !== 0) throw new Error(`Cannot verify Codex binaries: ${hashes.stderr.trim()}`);
      if (hashes.stdout.trim() !== `${codexHash}  /usr/local/bin/codex\n${hostHash}  /usr/local/bin/codex-code-mode-host`) reason = "Codex binaries differ from the selected host pair";
    }
    if (!reason) {
      const bun = await execute(["run", "--rm", "--network", "none", options.image, "bun", "--version"]);
      if (bun.exitCode !== 0) {
        if (bun.exitCode === 125) throw new Error(`Cannot verify container Bun: ${bun.stderr.trim()}`);
        reason = "container Bun is missing or cannot run through PATH";
      }
    }
  }
  if (!reason) { progress("Image identity and Codex binaries match; container Bun runs through PATH"); return; }
  progress(`Building image ${options.image} (${reason})`);
  // Inherit streams so the workbench receives build progress, not a silent buffered build.
  const child = Bun.spawn([options.docker, "build", "--build-context", `codex_binary=${dirname(codex)}`, "--build-arg", `CODEX_SHA256=${codexHash}`, "--build-arg", `CODEX_CODE_MODE_HOST_SHA256=${hostHash}`, "--build-arg", "BENCH_UID=1000", "--build-arg", "BENCH_GID=1000", "-t", options.image, "."], { stdout: "inherit", stderr: "inherit" });
  const cancel = () => child.kill("SIGTERM");
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  try { if (await child.exited !== 0) throw new Error("Image build failed; see build output"); }
  finally { options.signal?.removeEventListener("abort", cancel); }
}
export async function runLaunch(o: CliOptions): Promise<string> {
  const config = launchConfiguration(o);
  if (!config.prepareOnly && o["confirm-paid-inference"] !== true) throw new Error("launch starts paid inference; pass --confirm-paid-inference or --prepare-only");
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel); process.on("SIGTERM", cancel);
  const progress = (message: string) => process.stderr.write(`[launch] ${message}\n`);
  try {
    const task = taskCatalog().find(item => item.id === (o.task ?? launchDefaults().task));
    if (task?.repository && !await Bun.file(join(config.prepare.source, ".git/HEAD")).exists()) {
      let exists = true;
      try { await stat(config.prepare.source); } catch { exists = false; }
      if (exists) await checked(["git", "-C", config.prepare.source, "rev-parse", "--git-dir"], { signal: controller.signal });
      else { progress(`Cloning ${task.title} source to ${config.prepare.source}`); await checked(["git", "clone", task.repository, config.prepare.source], { signal: controller.signal }); }
    }
    progress("Checking container image");
    await ensureLaunchImage({ image: config.prepare.image, codexBinary: config.prepare.codexBinary!, docker: config.docker, signal: controller.signal }, progress);
    controller.signal.throwIfAborted();
    progress("Preparing isolated workspaces");
    let directory = await prepare(config.prepare);
    process.stdout.write(`${directory}\n`);
    controller.signal.throwIfAborted();
    if (config.count > 1) {
      progress(`Preparing ${config.count} fresh trial pairs`);
      directory = await prepareTrials({ runDir: directory, count: config.count, schedule: config.order, dockerBin: config.docker, outputParent: config.prepare.outputParent });
      process.stdout.write(`${directory}\n`);
    }
    controller.signal.throwIfAborted();
    if (!config.prepareOnly) {
      progress("Starting preflight, agents, grading, and reporting");
      if (config.count > 1) await runTrials({ directory, authFile: config.auth, grokAuthFile: config.grokAuth, dockerBin: config.docker, signal: controller.signal });
      else await runBenchmark({ runDir: directory, authFile: config.auth, grokAuthFile: config.grokAuth, dockerBin: config.docker, signal: controller.signal });
    }
    controller.signal.throwIfAborted();
    return directory;
  } finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
}
