import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { checked, exec } from "./process";
import { snapshotToolStore, verifySnapshotIdentities, type PreviousSnapshot, type SnapshotFile } from "./snapshot";
import { ISOLATION_SCRIPTS } from "./isolation";
import { readMekugiBuild } from "./provenance";
import { loadTaskPack } from "./task-pack";
import { validateCriteria } from "./semantic";
import { validateMekugiFlags } from "./mekugi";
import { sha256, writeState } from "./state";
import type { RunState, BenchmarkProfile, CodexLauncher, ReasoningEffort } from "./types";

export interface PrepareOptions {
  comparison?: import("./types").Comparison;
  protectMekugi?: boolean;
  mekugiBuild?: string;
  mekugiSource?: string;
  mekugiFlags?: string[];
  snapshotBase?: string;
  profile?: BenchmarkProfile;
  reasoningEffort?: ReasoningEffort;
  source: string;
  baseCommit: string;
  forbiddenCommit: string;
  taskPath: string;
  taskPackPath?: string;
  criteriaPath?: string;
  acceptancePath?: string;
  outputParent?: string;
  reviewTreatment?: string;
  currentHome: string;
  image: string;
  cpus: string;
  memory: string;
  timeoutSeconds: number;
  currentLauncher?: CodexLauncher;
  mekugiBinary?: string;
  mekugiShellBinary?: string;
  codexBinary?: string;
}

function progress(message: string): void { process.stderr.write(`[prepare] ${message}\n`); }

async function exists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch { return false; } }

async function makeDirectoriesWritable(root: string): Promise<void> {
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop()!;
    const info = await lstat(directory);
    await chmod(directory, info.mode | 0o200);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) pending.push(join(directory, entry.name));
    }
  }
}

async function copyCacheTree(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  try {
    await checked(["cp", "-al", `${source}/.`, destination]);
  } catch {
    await makeDirectoriesWritable(destination);
    await rm(destination, { recursive: true, force: true });
    await mkdir(destination, { recursive: true });
    await checked(["cp", "-a", `${source}/.`, destination]);
  }
  await makeDirectoriesWritable(destination);
}

async function copyRequired(source: string, target: string): Promise<void> {
  if (!(await exists(source))) throw new Error(`current setup dependency is missing: ${source}`);
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: true, dereference: false, preserveTimestamps: true });
}

async function copyRemoteSkillCache(home: string, destination: string): Promise<void> {
  const config = JSON.parse(await readFile(join(home, ".skills-mgr/.skills-mgr.json"), "utf8")) as {
    skills?: Record<string, { remote?: { name?: string } }>;
  };
  const wanted = new Set(Object.values(config.skills ?? {}).map(skill => skill.remote?.name).filter((name): name is string => Boolean(name)));
  const sourceRoot = join(home, ".cache/skills-mgr/remote-skills");
  const entries = join(sourceRoot, "entries");
  const copied = new Set<string>();
  for (const name of await readdir(entries)) {
    if (!name.endsWith(".json")) continue;
    const sourceEntry = join(entries, name);
    const entry = JSON.parse(await readFile(sourceEntry, "utf8")) as { name?: string; content?: string };
    if (!entry.name || !wanted.has(entry.name) || !entry.content) continue;
    const normalized = entry.content.replaceAll("\\", "/");
    if (!/^content\/[A-Za-z0-9._-]+$/.test(normalized)) throw new Error(`unsafe remote skill cache path: ${entry.content}`);
    await copyRequired(sourceEntry, join(destination, ".cache/skills-mgr/remote-skills/entries", name));
    await copyRequired(join(sourceRoot, normalized), join(destination, ".cache/skills-mgr/remote-skills", normalized));
    copied.add(entry.name);
  }
  const missing = [...wanted].filter(name => !copied.has(name));
  if (missing.length) throw new Error(`enabled remote skill cache entries are missing: ${missing.join(", ")}`);
}

async function manifest(root: string): Promise<Array<{ path: string; type: string; sha256?: string; target?: string }>> {
  const result: Array<{ path: string; type: string; sha256?: string; target?: string }> = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (dir === root && entry.name === ".git") continue;
      const full = join(dir, entry.name);
      const name = relative(root, full);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isSymbolicLink()) result.push({ path: name, type: "symlink", target: await readlink(full) });
      else if (entry.isFile()) result.push({ path: name, type: "file", sha256: await sha256(full) });
    }
  }
  await walk(root);
  return result;
}

function stockConfig(reasoningEffort: ReasoningEffort): string {
  return [
    'model = "gpt-6-astra"', `model_reasoning_effort = "${reasoningEffort}"`, 'service_tier = "default"',
    'approval_policy = "never"', 'sandbox_mode = "danger-full-access"', 'network_access = "enabled"',
    '', '[projects."/workspace"]', 'trust_level = "trusted"', '',
  ].join("\n");
}

export async function verifyPreparedInputs(runDir: string, state: RunState): Promise<void> {
  if (state.task.path !== "control/task.md" || (state.acceptance && state.acceptance.path !== "evaluator/acceptance_test.go" && !/^reports\/regrade-[A-Za-z0-9]+\/acceptance_test\.go$/.test(state.acceptance.path))) throw new Error("copied benchmark control path changed");
  const stock = join(runDir, "snapshots/stock/home/ubuntu");
  const sameSetup = state.comparison === "same-setup";
  if (sameSetup && (state.arms.stock.home_template !== state.arms.current.home_template || state.execution.current_launcher !== "mekugi")) throw new Error("same-setup treatment identity changed");
  if (!sameSetup && state.arms.stock.home_template !== "snapshots/stock/home/ubuntu") throw new Error("stock setup identity changed");
  const stockFiles = await manifest(stock);
  if (stockFiles.length !== 1 || stockFiles[0].path !== ".codex/config.toml" || stockFiles[0].type !== "file"
    || await readFile(join(stock, ".codex/config.toml"), "utf8") !== stockConfig(state.execution.reasoning_effort)) throw new Error("stock setup snapshot changed");
  validateMekugiFlags(state.mekugi_flags ?? []);
  if (state.mekugi_exports && (await sha256(join(runDir, state.mekugi_exports.validator.path)) !== state.mekugi_exports.validator.sha256 || await sha256(join(runDir, state.mekugi_exports.reader.path)) !== state.mekugi_exports.reader.sha256)) {
    throw new Error("Mekugi capture validator changed");
  }
  for (const file of state.protected_runtime?.scripts ?? []) {
    if (await sha256(join(runDir, file.path)) !== file.sha256) throw new Error("runtime isolation script changed");
  }
  for (const file of state.mekugi_build?.files ?? []) {
    if (await sha256(join(runDir, file.path)) !== file.sha256) throw new Error("Mekugi build input changed");
  }
  for (const control of [state.task, state.acceptance, state.criteria, state.task_pack]) {
    if (control && await sha256(join(runDir, control.path)) !== control.sha256) throw new Error("copied benchmark control changed");
  }
  if (state.criteria) {
    if (state.criteria.path !== "evaluator/criteria.json") throw new Error("criteria control path changed");
    const contract = validateCriteria(JSON.parse(await readFile(join(runDir, state.criteria.path), "utf8")), state.task.sha256);
    if (JSON.stringify(contract) !== JSON.stringify(state.criteria.contract)) throw new Error("predetermined criteria changed");
  }
  if (await sha256(join(runDir, state.runtime_tools.bun)) !== state.runtime_tools.bun_sha256) throw new Error("snapshotted Bun changed");
  const manifestPath = join(runDir, state.snapshot_manifest);
  if (await sha256(manifestPath) !== state.current_snapshot.manifest_sha256) throw new Error("snapshot manifest changed");
  const recorded = JSON.parse(await readFile(manifestPath, "utf8")) as { files: unknown };
  const currentTemplate = join(runDir, state.arms.current.home_template);
  if (JSON.stringify(await manifest(currentTemplate)) !== JSON.stringify(recorded.files)) throw new Error("current setup snapshot changed");
  if (await sha256(join(currentTemplate, ".local/bin/mise")) !== state.runtime_tools.current_setup_mise_sha256) {
    throw new Error("snapshotted current setup runtime changed");
  }
  const setupInstalls = join(runDir, state.runtime_tools.current_setup_installs);
  const setupFilesPath = join(runDir, state.runtime_tools.current_setup_files);
  if (await sha256(setupFilesPath) !== state.runtime_tools.current_setup_files_sha256) {
    throw new Error("snapshotted current setup file manifest changed");
  }
  const setupFiles = JSON.parse(await readFile(setupFilesPath, "utf8")) as { files: SnapshotFile[] };
  const hasIdentities = Array.isArray(setupFiles.files) && setupFiles.files.every(file => file.identity !== undefined);
  const setupIsUnchanged = hasIdentities
    ? await verifySnapshotIdentities(setupInstalls, setupFiles.files)
    : JSON.stringify(await manifest(setupInstalls)) === JSON.stringify(setupFiles.files);
  if (!setupIsUnchanged) {
    throw new Error("snapshotted current setup installations changed");
  }
  if (state.execution.current_launcher === "mekugi") {
    const mekugi = state.runtime_tools.mekugi_sha256;
    if (!mekugi || await sha256(join(currentTemplate, ".local/bin/mekugi")) !== mekugi) throw new Error("snapshotted Mekugi changed");
    const shell = state.runtime_tools.mekugi_shell_sha256;
    if (!shell || await sha256(join(currentTemplate, ".local/bin/shell")) !== shell) throw new Error("snapshotted Mekugi shell helper changed or is missing");
  }
}

async function snapshotCurrent(home: string, destination: string, mekugiBinary: string | undefined, mekugiShellBinary: string | undefined, miseBinary: string, reviewTreatment?: string): Promise<string> {
  const repository = (await checked(["git", "-C", home, "rev-parse", "--show-toplevel"])).stdout.trim();
  if (await realpath(repository) !== await realpath(home)) throw new Error("--current-home must be the configuration repository root");
  await checked(["git", "clone", "--depth=1", "--no-local", "--no-hardlinks", pathToFileURL(repository).href, destination]);
  await checked(["git", "-C", destination, "remote", "remove", "origin"]);
  const commit = (await checked(["git", "-C", destination, "rev-parse", "HEAD"])).stdout.trim();
  const tree = (await checked(["git", "-C", destination, "rev-parse", "HEAD^{tree}"])).stdout.trim();
  // Include current tracked edits, additions and deletions without copying the
  // host's index, Git configuration, untracked credentials or session state.
  const changed = (await checked(["git", "-C", home, "diff", "--name-only", "-z", commit, "--"])).stdout.split("\0").filter(Boolean);
  for (const item of changed) {
    const target = join(destination, item);
    await rm(target, { force: true });
    if (await exists(join(home, item))) await copyRequired(join(home, item), target);
  }
  // Runtime materializations are not authored configuration. Keep these
  // supplements separate from the Git-owned instructions, roles and skills.
  for (const item of [".codex/hooks", ".codex/.tmp/bundled-marketplaces/openai-bundled", ".agents/skills"]) {
    await copyRequired(join(home, item), join(destination, item));
  }
  if (await exists(join(home, ".codex/herdr-agent-state.sh"))) {
    await copyRequired(join(home, ".codex/herdr-agent-state.sh"), join(destination, ".codex/herdr-agent-state.sh"));
  }
  await copyRemoteSkillCache(home, destination);
  await copyRequired(join(home, ".cache/go-modern-guidelines/v0.1.1"), join(destination, ".cache/go-modern-guidelines/v0.1.1"));
  // The read-only tool store has already been migrated on the source home.
  // Preserve its completion records so mise does not try to migrate it again.
  const miseMigrations = ".local/share/mise/migrations";
  if (await exists(join(home, miseMigrations))) {
    await copyRequired(join(home, miseMigrations), join(destination, miseMigrations));
  }
  await copyRequired(miseBinary, join(destination, ".local/bin/mise"));
  await chmod(join(destination, ".local/bin/mise"), 0o755);
  if (mekugiBinary) {
    await copyRequired(mekugiBinary, join(destination, ".local/bin/mekugi"));
    await chmod(join(destination, ".local/bin/mekugi"), 0o755);
  }
  if (mekugiShellBinary) {
    await copyRequired(mekugiShellBinary, join(destination, ".local/bin/shell"));
    await chmod(join(destination, ".local/bin/shell"), 0o755);
  }
  const treatmentFiles: Array<{ source: string; destination: string; before_sha256: string; after_sha256: string }> = [];
  if (reviewTreatment) {
    for (const path of [".codex", ".codex/agents"]) {
      if (!(await lstat(join(destination, path))).isDirectory()) throw new Error(`treatment destination is not a real directory: ${path}`);
    }
    for (const [source, target] of REVIEW_TREATMENT_FILES) {
      const destinationPath = join(destination, target);
      if (!(await lstat(destinationPath)).isFile()) throw new Error(`treatment destination is not a regular file: ${target}`);
      const before = await sha256(destinationPath);
      await copyFile(join(reviewTreatment, source), destinationPath);
      treatmentFiles.push({ source, destination: target, before_sha256: before, after_sha256: await sha256(destinationPath) });
    }
  }
  const configPath = join(destination, ".codex/config.toml");
  let config = await readFile(configPath, "utf8");
  config = config.replace(/\n\[projects\.[\s\S]*?(?=\n\[(?!projects\.)|$)/g, "");
  config += '\n[projects."/workspace"]\ntrust_level = "trusted"\n';
  await writeFile(configPath, config, { mode: 0o600 });
  const output = join(dirname(destination), "snapshot-manifest.json");
  await writeFile(output, `${JSON.stringify({ created_at: new Date().toISOString(), source_home: home,
    review_treatment: reviewTreatment ? { source: reviewTreatment, files: treatmentFiles } : null,
    configuration_repository: { path: repository, commit, tree, tracked_worktree_changes: changed }, adaptations: [
    "configuration repository shallow-cloned independently with its remote removed; current tracked working-tree changes overlaid",
    "project trust entries replaced with /workspace",
    "untracked home files excluded except explicit runtime supplements; no host auth, session history or Mekugi state copied",
    "mise copied to /home/ubuntu/.local/bin with its migration completion records; its complete installed tool store captured separately",
    ...(mekugiBinary ? ["Mekugi launcher and matching shell helper copied to /home/ubuntu/.local/bin without host Mekugi state"] : []),
    "only currently referenced remote-skill cache entries/content copied; stale generations and Git stores excluded",
    "existing go-modern-guidelines v0.1.1 provider copied without installation or update",
  ], files: await manifest(destination) }, null, 2)}\n`);
  return output;
}

async function verifyClone(seed: string, repository: string, base: string, tree: string, forbidden: string): Promise<void> {
  const head = (await checked(["git", "-C", repository, "rev-parse", "HEAD"])).stdout.trim();
  const actualTree = (await checked(["git", "-C", repository, "rev-parse", "HEAD^{tree}"])).stdout.trim();
  if (head !== base || actualTree !== tree) throw new Error(`clone identity mismatch: ${head}/${actualTree}`);
  if ((await checked(["git", "-C", repository, "remote"])).stdout.trim()) throw new Error("clone retained a remote");
  if (await exists(join(repository, ".git/objects/info/alternates"))) throw new Error("clone uses object alternates");
  const worktrees = (await checked(["git", "-C", repository, "worktree", "list", "--porcelain"])).stdout.match(/^worktree /gm) ?? [];
  if (worktrees.length !== 1) throw new Error("clone is linked to another worktree");
  if ((await exec(["git", "-C", repository, "cat-file", "-e", `${forbidden}^{commit}`])).exitCode === 0) {
    throw new Error("forbidden future solution commit is present in an arm clone");
  }
  const seedObjects = join(seed, "objects");
  const cloneObjects = join(repository, ".git/objects");
  const seedInodes = new Set<string>();
  async function collect(dir: string, set?: Set<string>): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) await collect(p, set);
      else if (entry.isFile()) {
        const s = await stat(p);
        const key = `${s.dev}:${s.ino}`;
        if (set) set.add(key); else if (seedInodes.has(key)) throw new Error(`clone object is hardlinked to seed: ${p}`);
      }
    }
  }
  await collect(seedObjects, seedInodes);
  await collect(cloneObjects);
}

export const GODOXY_ICONS = {
  base_commit: "c335ef2d83d9fb8a774cb70b9b628ade54c654a2",
  base_tree: "56e1c3edff2087bbede0a6f2cc6628c937ea6cc2",
  forbidden_commit: "c67dabf1a880c858979d852bdc7bac9239d061c1",
  submodules: {
    goutils: "b7df9d8ce9b7c46db4dc33db5be692834d13b72e",
    "internal/go-oidc": "6080c3426efca50aca57fe85e6306cf0ce4e22ef",
    "internal/gopsutil": "aef7076194a18442395d7f483fa7f54a1b39f061",
  },
} as const;

export function verifyGodoxyIdentity(source: RunState["source"], submodules: RunState["submodules"]): void {
  if (source.base_commit !== GODOXY_ICONS.base_commit || source.base_tree !== GODOXY_ICONS.base_tree
    || source.forbidden_commit !== GODOXY_ICONS.forbidden_commit
    || submodules?.length !== 3 || new Set(submodules.map(sub => sub.path)).size !== 3
    || submodules.some(sub => GODOXY_ICONS.submodules[sub.path as keyof typeof GODOXY_ICONS.submodules] !== sub.sha)) {
    throw new Error("godoxy-icons benchmark identity mismatch");
  }
}

export async function verifyRepositoryIsolation(repository: string): Promise<void> {
  if ((await checked(["git", "-C", repository, "remote"])).stdout.trim()) throw new Error("root repository retained a remote");
  const webui = (await checked(["git", "-C", repository, "submodule", "status", "--", "webui"])).stdout;
  const registered = await exec(["git", "-C", repository, "config", "--get", "submodule.webui.url"]);
  if (registered.exitCode === 0 || !webui.startsWith("-") || await exists(join(repository, "webui/.git"))
    || (await exists(join(repository, "webui")) && (await readdir(join(repository, "webui"))).length > 0)) {
    throw new Error("webui must remain uninitialized and empty");
  }
}

export async function initializeSubmodules(repository: string, submodules: NonNullable<RunState["submodules"]>): Promise<void> {
  for (const sub of submodules) {
    const seed = await mkdtemp(join(tmpdir(), "codex-ab-submodule-"));
    try {
      await checked(["git", "init", "--bare", seed]);
      await checked(["git", "-C", seed, "fetch", "--depth=1", pathToFileURL(sub.source).href, `${sub.sha}:refs/heads/benchmark`]);
      const target = join(repository, sub.path);
      await checked(["git", "clone", "--no-local", "--no-hardlinks", "--branch", "benchmark", seed, target]);
      await checked(["git", "-C", target, "remote", "remove", "origin"]);
      await checked(["git", "-C", repository, "submodule", "init", "--", sub.path]);
    } finally {
      await rm(seed, { recursive: true, force: true });
    }
  }
  await verifySubmodules(repository, submodules);
}

export async function verifySubmodules(repository: string, submodules: NonNullable<RunState["submodules"]>): Promise<void> {
  for (const sub of submodules) {
    const target = join(repository, sub.path);
    const head = (await checked(["git", "-C", target, "rev-parse", "HEAD"])).stdout.trim();
    const link = (await checked(["git", "-C", repository, "ls-tree", "HEAD", "--", sub.path])).stdout.trim();
    const dirty = (await checked(["git", "-C", target, "status", "--porcelain", "--untracked-files=all"])).stdout.trim();
    const rootDiff = (await checked(["git", "-C", repository, "diff", "HEAD", "--", sub.path])).stdout.trim();
    const remotes = (await checked(["git", "-C", target, "remote"])).stdout.trim();
    const initialized = (await checked(["git", "-C", repository, "submodule", "status", "--", sub.path])).stdout;
    if (head !== sub.sha || !initialized.startsWith(` ${sub.sha} ${sub.path}`) || !link.startsWith(`160000 commit ${sub.sha}\t`) || dirty || remotes || rootDiff) {
      throw new Error(`submodule ${sub.path} is not clean, exact, and remote-free`);
    }
    if (await exists(join(target, ".git/objects/info/alternates"))) throw new Error(`submodule ${sub.path} uses alternates`);
  }
}

const REVIEW_TREATMENT_FILES = [
  ["parent-agents.md", ".codex/AGENTS.md"],
  ["review-correctness.toml", ".codex/agents/review-correctness.toml"],
  ["review-simplify.toml", ".codex/agents/review-simplify.toml"],
  ["web-reviewer.toml", ".codex/agents/web-reviewer.toml"],
] as const;

export async function prepare(options: PrepareOptions): Promise<string> {
  const build = options.mekugiBuild ? await readMekugiBuild(options.mekugiBuild) : undefined;
  if (build) options = { ...options, currentLauncher: "mekugi",
    mekugiBinary: join(options.mekugiBuild!, "bin/mekugi"), mekugiShellBinary: join(options.mekugiBuild!, "bin/shell"),
    mekugiSource: join(options.mekugiBuild!, "source") };
  const pack = options.taskPackPath ? await loadTaskPack(options.taskPackPath) : undefined;
  if (pack) options = { ...options, profile: "task", baseCommit: pack.manifest.source.base_commit,
    forbiddenCommit: pack.manifest.source.forbidden_commit, taskPath: pack.taskPath, acceptancePath: undefined };
  const profile = options.profile ?? (options.criteriaPath ? "task" : "mekugi");
  const mekugiFlags = validateMekugiFlags(options.mekugiFlags ?? []);
  const comparison = options.comparison ?? "stock-current";
  if (!["stock-current", "same-setup"].includes(comparison)) throw new Error("comparison must be stock-current or same-setup");
  const currentLauncher = options.currentLauncher ?? (comparison === "same-setup" ? "mekugi" : "codex");
  if (comparison === "same-setup" && !options.mekugiSource) throw new Error("same-setup requires --mekugi-source for capturer-owned export validation");
  if (comparison === "same-setup" && currentLauncher !== "mekugi") throw new Error("same-setup requires the Mekugi launcher");
  if (options.protectMekugi && (currentLauncher !== "mekugi" || !options.mekugiSource)) throw new Error("protected runtime requires Mekugi and matching --mekugi-source or --mekugi-build");
  if (options.mekugiFlags?.length && currentLauncher !== "mekugi") throw new Error("Mekugi flags require the Mekugi launcher");
  const reasoningEffort = options.reasoningEffort ?? "medium";
  if (!["mekugi", "godoxy-icons", "skills-mgr-bundle", "task"].includes(profile)) throw new Error("unknown benchmark profile");
  if (!["codex", "mekugi"].includes(currentLauncher)) throw new Error("current launcher must be codex or mekugi");
  if (options.mekugiBinary && currentLauncher !== "mekugi") throw new Error("--mekugi-bin requires --current-launcher mekugi");
  if (!["medium", "xhigh"].includes(reasoningEffort)) throw new Error("reasoning effort must be medium or xhigh");
  if (profile === "godoxy-icons" && (!options.taskPath || !options.acceptancePath)) throw new Error("godoxy-icons requires explicit task and acceptance");
  if (profile === "godoxy-icons" && (options.baseCommit !== GODOXY_ICONS.base_commit || options.forbiddenCommit !== GODOXY_ICONS.forbidden_commit)) {
    throw new Error("godoxy-icons benchmark identity mismatch");
  }
  if (profile === "task" && !options.criteriaPath && !pack) throw new Error("task profile requires predetermined --criteria");
  if (profile === "skills-mgr-bundle" && !options.acceptancePath) throw new Error("skills-mgr-bundle requires explicit acceptance");
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined || uid <= 0 || gid <= 0) throw new Error("prepare requires a non-root POSIX operator identity");
  const reviewTreatment = options.reviewTreatment ? await realpath(options.reviewTreatment) : undefined;
  if (reviewTreatment) {
    for (const [source] of REVIEW_TREATMENT_FILES) {
      const path = join(reviewTreatment, source);
      if (!(await lstat(path)).isFile()) throw new Error(`treatment input is not a regular file: ${source}`);
      const content = await readFile(path, "utf8");
      if (!content.trim()) throw new Error(`empty treatment input: ${source}`);
      if (source.endsWith(".toml")) Bun.TOML.parse(content);
    }
  }
  const source = await realpath(options.source);
  const taskPath = await realpath(options.taskPath);
  const criteriaPath = options.criteriaPath ? await realpath(options.criteriaPath) : undefined;
  const criteriaContract = pack?.contract ?? (criteriaPath ? validateCriteria(JSON.parse(await readFile(criteriaPath, "utf8")), await sha256(taskPath)) : undefined);
  const acceptancePath = options.acceptancePath ? await realpath(options.acceptancePath) : undefined;
  const codexBinary = await realpath(options.codexBinary ?? join(options.currentHome, ".local/bin/codex"));
  const codexVersion = (await checked([codexBinary, "--version"])).stdout.trim();
  if (!/^codex-cli \d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(codexVersion)) throw new Error(`unexpected Codex version: ${codexVersion}`);
  const codexSha256 = await sha256(codexBinary);
  const codeModeHost = await realpath(join(dirname(codexBinary), "codex-code-mode-host"));
  const codeModeHostStat = await stat(codeModeHost);
  if (!codeModeHostStat.isFile() || (codeModeHostStat.mode & 0o111) === 0) throw new Error(`Codex code-mode host is not executable: ${codeModeHost}`);
  const miseBinary = await realpath(join(options.currentHome, ".local/bin/mise"));
  const miseStat = await stat(miseBinary);
  if (!miseStat.isFile() || (miseStat.mode & 0o111) === 0) throw new Error(`current setup manager is not executable: ${miseBinary}`);
  const miseSha256 = await sha256(miseBinary);
  if (options.mekugiShellBinary && currentLauncher !== "mekugi") throw new Error("--mekugi-shell-bin requires --current-launcher mekugi");
  const mekugiBinary = currentLauncher === "mekugi"
    ? await realpath(options.mekugiBinary ?? join(options.currentHome, "go/bin/mekugi"))
    : undefined;
  const mekugiStat = mekugiBinary ? await stat(mekugiBinary) : undefined;
  if (mekugiStat && (!mekugiStat.isFile() || (mekugiStat.mode & 0o111) === 0)) throw new Error(`Mekugi launcher is not executable: ${mekugiBinary}`);
  const mekugiSha256 = mekugiBinary ? await sha256(mekugiBinary) : undefined;
  const mekugiShellBinary = mekugiBinary
    ? await realpath(options.mekugiShellBinary ?? join(dirname(mekugiBinary), "shell"))
    : undefined;
  const mekugiShellStat = mekugiShellBinary ? await stat(mekugiShellBinary) : undefined;
  if (mekugiShellStat && (!mekugiShellStat.isFile() || (mekugiShellStat.mode & 0o111) === 0)) throw new Error(`Mekugi shell helper is not executable: ${mekugiShellBinary}`);
  const mekugiShellSha256 = mekugiShellBinary ? await sha256(mekugiShellBinary) : undefined;
  const codeModeHostSha256 = await sha256(codeModeHost);
  const currentConfig = await readFile(join(options.currentHome, ".codex/config.toml"), "utf8");
  const configured = (key: string): string | undefined => currentConfig.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, "m"))?.[1];
  if (configured("model") !== "gpt-6-astra" || configured("model_reasoning_effort") !== "medium") {
    throw new Error("current setup must configure model gpt-6-astra with medium reasoning for this benchmark");
  }
  const serviceTier = configured("service_tier");
  if (!serviceTier) throw new Error("current setup does not declare service_tier");
  if (!(await exists(join(source, ".git")))) throw new Error(`source is not a Git worktree: ${source}`);
  const runDir = await mkdtemp(join(options.outputParent ?? tmpdir(), "codex-ab-"));
  await chmod(runDir, 0o700);
  progress(`created isolated run ${runDir}`);
  for (const dir of ["control", "evaluator", "arms", "snapshots", "artifacts"]) await mkdir(join(runDir, dir), { recursive: true });
  await copyFile(taskPath, join(runDir, "control/task.md"));
  if (criteriaContract) await writeFile(join(runDir, "evaluator/criteria.json"), JSON.stringify(criteriaContract, null, 2));
  if (pack) await writeFile(join(runDir, "evaluator/task-pack.json"), JSON.stringify(pack.snapshot, null, 2));
  if (acceptancePath) await copyFile(acceptancePath, join(runDir, "evaluator/acceptance_test.go"));

  let buildProvenance: RunState["mekugi_build"];
  if (build) {
    const directory = join(runDir, "artifacts/mekugi-build");
    await mkdir(directory);
    const files: Array<{ path: string; sha256: string }> = [];
    for (const name of ["source.tar", "build_inputs.py", "build.json", "build.stdout", "build.stderr", "build-result.json"]) {
      const target = join(directory, name);
      await copyFile(join(options.mekugiBuild!, name), target);
      files.push({ path: relative(runDir, target), sha256: await sha256(target) });
    }
    if (await sha256(join(directory, "source.tar")) !== build.source_archive_sha256 ||
        await sha256(join(directory, "build_inputs.py")) !== build.archiver_sha256 ||
        JSON.stringify(JSON.parse(await readFile(join(directory, "build.json"), "utf8"))) !== JSON.stringify(build) ||
        mekugiSha256 !== build.binaries.mekugi || mekugiShellSha256 !== build.binaries.shell) throw new Error("build inputs changed during preparation");
    options.mekugiSource = join(directory, "source");
    await mkdir(options.mekugiSource);
    await checked(["python3", "-c",
      "import sys, tarfile; tarfile.open(sys.argv[1]).extractall(sys.argv[2], filter='data')",
      join(directory, "source.tar"), options.mekugiSource]);
    buildProvenance = { identity: build, files };
  }
  const seed = join(runDir, "seed.git");
  await checked(["git", "init", "--bare", seed]);
  await checked(["git", "-C", seed, "fetch", "--depth=1", `file://${source}`, `${options.baseCommit}:refs/heads/benchmark`]);
  const base = (await checked(["git", "-C", seed, "rev-parse", "refs/heads/benchmark"])).stdout.trim();
  if (base !== options.baseCommit) throw new Error(`requested base resolved to ${base}`);
  const tree = (await checked(["git", "-C", seed, "rev-parse", `${base}^{tree}`])).stdout.trim();
  const sourceTimestamp = Number((await checked(["git", "-C", seed, "show", "-s", "--format=%ct", base])).stdout.trim());
  const submodules: NonNullable<RunState["submodules"]> = [];
  if (profile === "godoxy-icons") {
    for (const path of ["goutils", "internal/go-oidc", "internal/gopsutil"]) {
      const entry = (await checked(["git", "-C", seed, "ls-tree", base, "--", path])).stdout;
      const sha = entry.match(/^160000 commit ([0-9a-f]{40})\t/)?.[1];
      if (!sha) throw new Error(`missing gitlink: ${path}`);
      submodules.push({ path, sha, source: await realpath(join(source, path)) });
    }
  }
  if (profile === "godoxy-icons") verifyGodoxyIdentity({
    path: source, base_commit: base, base_tree: tree, source_timestamp: sourceTimestamp, forbidden_commit: options.forbiddenCommit,
  }, submodules);
  for (const arm of ["stock", "current"] as const) {
    const repo = join(runDir, "arms", arm, "repo");
    await mkdir(dirname(repo), { recursive: true });
    await checked(["git", "clone", "--no-local", "--no-hardlinks", "--branch", "benchmark", seed, repo]);
    await checked(["git", "-C", repo, "remote", "remove", "origin"]);
    await initializeSubmodules(repo, submodules);
    if (profile === "godoxy-icons") await verifyRepositoryIsolation(repo);
    await verifyClone(seed, repo, base, tree, options.forbiddenCommit);
  }
  progress("verified independent base-only clones");

  const currentTemplate = join(runDir, "snapshots/current/home/ubuntu");
  await mkdir(currentTemplate, { recursive: true });
  const snapshotManifest = await snapshotCurrent(options.currentHome, currentTemplate, mekugiBinary, mekugiShellBinary, miseBinary, reviewTreatment);
  const currentSetupInstalls = join(runDir, "snapshots/current/mise/installs");
  let previousSnapshot: PreviousSnapshot | undefined;
  let preflightCache: NonNullable<RunState["runtime_tools"]["preflight_cache"]> | undefined;
  if (options.snapshotBase) {
    const previousRun = await realpath(options.snapshotBase);
    const previousState = JSON.parse(await readFile(join(previousRun, "run.json"), "utf8")) as RunState;
    if (previousState.status !== "complete") throw new Error("snapshot base must be a completed benchmark");
    const previousManifestPath = join(previousRun, previousState.snapshot_manifest);
    if (await sha256(previousManifestPath) !== previousState.current_snapshot.manifest_sha256) {
      throw new Error("snapshot base current-home manifest changed");
    }
    const previousManifest = JSON.parse(await readFile(previousManifestPath, "utf8")) as { source_home?: unknown };
    if (typeof previousManifest.source_home !== "string") throw new Error("snapshot base has no source home");
    const previousFilesPath = join(previousRun, previousState.runtime_tools.current_setup_files);
    if (await sha256(previousFilesPath) !== previousState.runtime_tools.current_setup_files_sha256) {
      throw new Error("snapshot base tool manifest changed");
    }
    const previousFiles = JSON.parse(await readFile(previousFilesPath, "utf8")) as { files?: unknown };
    if (!Array.isArray(previousFiles.files)) throw new Error("snapshot base tool manifest has no files");
    previousSnapshot = {
      root: join(previousRun, previousState.runtime_tools.current_setup_installs),
      files: previousFiles.files as SnapshotFile[],
      sourceRoot: join(previousManifest.source_home, ".local/share/mise/installs"),
      capturedAt: previousState.current_snapshot.captured_at,
    };
    const matchingRuntime = previousState.source.base_commit === base && previousState.source.base_tree === tree &&
      previousState.runtime_tools.codex_sha256 === codexSha256;
    let cacheArm: "stock" | "current" | undefined;
    for (const arm of ["stock", "current"] as const) {
      if (previousState.results?.[arm] &&
          await exists(join(previousRun, "arms", arm, "grader-go-cache")) &&
          await exists(join(previousRun, "arms", arm, "grader-go-pkg-cache"))) {
        cacheArm = arm;
        break;
      }
    }
    if (matchingRuntime && cacheArm) {
      const goBuild = join(runDir, "artifacts/preflight-cache/go-build");
      const goPkg = join(runDir, "artifacts/preflight-cache/go-pkg");
      const previousBun = join(previousRun, "arms", cacheArm, "grader-bun-cache");
      const bun = await exists(previousBun) ? join(runDir, "artifacts/preflight-cache/bun") : undefined;
      await Promise.all([
        copyCacheTree(join(previousRun, "arms", cacheArm, "grader-go-cache"), goBuild),
        copyCacheTree(join(previousRun, "arms", cacheArm, "grader-go-pkg-cache"), goPkg),
        ...(bun ? [copyCacheTree(previousBun, bun)] : []),
      ]);
      preflightCache = {
        go_build: relative(runDir, goBuild), go_pkg: relative(runDir, goPkg),
        bun: bun ? relative(runDir, bun) : undefined, source_run: previousRun,
      };
    }
  }
  progress("snapshotting installed tools incrementally");
  const { files: setupFiles, ...snapshotStats } = await snapshotToolStore(join(options.currentHome, ".local/share/mise/installs"), currentSetupInstalls, previousSnapshot);
  await writeFile(join(runDir, "snapshots/current/incremental.json"), `${JSON.stringify({ base: options.snapshotBase ?? null, ...snapshotStats }, null, 2)}\n`);
  progress(`tool snapshot: reused ${snapshotStats.linked} files (${snapshotStats.linkedBytes} bytes), copied ${snapshotStats.copied} files (${snapshotStats.copiedBytes} bytes)`);
  const currentSetupFiles = join(runDir, "snapshots/current/mise-files.json");
  await writeFile(currentSetupFiles, `${JSON.stringify({ files: setupFiles }, null, 2)}\n`);

  const snapshotDocument = JSON.parse(await readFile(snapshotManifest, "utf8")) as { created_at?: unknown };
  if (typeof snapshotDocument.created_at !== "string") throw new Error("current snapshot manifest has no capture timestamp");
  const stockTemplate = join(runDir, "snapshots/stock/home/ubuntu");
  await mkdir(join(stockTemplate, ".codex"), { recursive: true });
  await writeFile(join(stockTemplate, ".codex/config.toml"), stockConfig(reasoningEffort), { mode: 0o600 });
  const bunSource = join(options.currentHome, ".local/share/mise/installs/bun/1.4.2/bin/bun");
  const bunTarget = join(runDir, "snapshots/runtime/bin/bun");
  await copyRequired(bunSource, bunTarget);
  await chmod(bunTarget, 0o755);
  progress("captured repository-based current and minimal stock setup templates");

  let mekugiExports: RunState["mekugi_exports"];
  if (mekugiBinary && options.mekugiSource) {
    const validatorPath = "snapshots/runtime/analyze_capture.py";
    const readerPath = "snapshots/runtime/benchmark_jsonl.py";
    await copyRequired(join(options.mekugiSource, "benchmarks/benchmark_jsonl.py"), join(runDir, readerPath));
    await copyRequired(join(options.mekugiSource, "benchmarks/analyze_capture.py"), join(runDir, validatorPath));
    mekugiExports = { capture: "artifacts/current/mekugi/capture.jsonl", metrics: "artifacts/current/mekugi/metrics.json",
      validator: { path: validatorPath, sha256: await sha256(join(runDir, validatorPath)) },
      reader: { path: readerPath, sha256: await sha256(join(runDir, readerPath)) } };
  }

  let protectedRuntime: RunState["protected_runtime"];
  if (options.protectMekugi) {
    const scripts = [];
    for (const name of ISOLATION_SCRIPTS) {
      const path = `snapshots/runtime/isolation/${name}`;
      await copyRequired(join(options.mekugiSource!, "benchmarks", name), join(runDir, path));
      await chmod(join(runDir, path), 0o755);
      scripts.push({ path, sha256: await sha256(join(runDir, path)) });
    }
    protectedRuntime = { boundary: "direct-egress-vs-router-only", scripts };
  }
  const state: RunState = {
    profile,
    comparison,
    mekugi_flags: mekugiFlags,
    protected_runtime: protectedRuntime,
    mekugi_build: buildProvenance,
    mekugi_exports: mekugiExports,
    submodules,
    schema_version: 1,
    id: basename(runDir),
    created_at: new Date().toISOString(),
    status: "prepared",
    source: { path: source, base_commit: base, base_tree: tree, source_timestamp: sourceTimestamp, forbidden_commit: options.forbiddenCommit },
    task: { path: "control/task.md", sha256: await sha256(join(runDir, "control/task.md")) },
    task_pack: pack ? { id: pack.manifest.id, path: "evaluator/task-pack.json", sha256: await sha256(join(runDir, "evaluator/task-pack.json")) } : undefined,
    criteria: criteriaContract ? { path: "evaluator/criteria.json", sha256: await sha256(join(runDir, "evaluator/criteria.json")), contract: criteriaContract } : undefined,
    acceptance: acceptancePath ? { path: "evaluator/acceptance_test.go", sha256: await sha256(join(runDir, "evaluator/acceptance_test.go")) } : undefined,
    image: options.image,
    execution: { model: "gpt-6-astra", reasoning_effort: reasoningEffort, service_tier: serviceTier, current_launcher: currentLauncher },
    resource_limits: { cpus: options.cpus, memory: options.memory },
    timeout_seconds: options.timeoutSeconds,
    snapshot_manifest: relative(runDir, snapshotManifest),
    current_snapshot: { captured_at: snapshotDocument.created_at, manifest_sha256: await sha256(snapshotManifest) },
    runtime_tools: {
      bun: relative(runDir, bunTarget), bun_sha256: await sha256(bunTarget),
      codex_source: codexBinary, codex_version: codexVersion, codex_sha256: codexSha256,
      codex_code_mode_host_source: codeModeHost,
      current_setup_installs: relative(runDir, currentSetupInstalls),
      current_setup_files: relative(runDir, currentSetupFiles), current_setup_files_sha256: await sha256(currentSetupFiles),
      current_setup_mise_sha256: miseSha256,
      preflight_cache: preflightCache,
      codex_code_mode_host_sha256: codeModeHostSha256,
      mekugi_source: mekugiBinary, mekugi_sha256: mekugiSha256,
      mekugi_shell_source: mekugiShellBinary, mekugi_shell_sha256: mekugiShellSha256,
      codex_code_mode_host_size: codeModeHostStat.size,
    },
    operator: { uid, gid },
    arms: {
      stock: { repository: "arms/stock/repo", home_template: comparison === "same-setup" ? "snapshots/current/home/ubuntu" : "snapshots/stock/home/ubuntu" },
      current: { repository: "arms/current/repo", home_template: "snapshots/current/home/ubuntu" },
    },
  };
  await writeState(runDir, state);
  return runDir;
}
