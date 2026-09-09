import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { checked, exec } from "./process";
import { sha256, writeState } from "./state";
import type { RunState } from "./types";

export interface PrepareOptions {
  source: string;
  baseCommit: string;
  forbiddenCommit: string;
  taskPath: string;
  acceptancePath?: string;
  outputParent?: string;
  currentHome: string;
  image: string;
  cpus: string;
  memory: string;
  timeoutSeconds: number;
  codexBinary?: string;
}

function progress(message: string): void { process.stderr.write(`[prepare] ${message}\n`); }

async function exists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch { return false; } }

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

async function snapshotCurrent(home: string, destination: string): Promise<string> {
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
  const binarySources: Record<string, string> = {
    "skills-mgr": join(home, ".local/share/mise/installs/go-github-com-yusing-skills-mgr/0.0.0-20260908072306-37a730da5ab5/bin/skills-mgr"),
    "rtk": join(home, ".local/share/mise/installs/aqua-rtk-ai-rtk/0.48.0/rtk"),
  };
  for (const [name, source] of Object.entries(binarySources)) {
    const target = join(destination, ".local/bin", name);
    await copyRequired(source, target);
    await chmod(target, 0o755);
  }
  const configPath = join(destination, ".codex/config.toml");
  let config = await readFile(configPath, "utf8");
  config = config.replace(/\n\[projects\.[\s\S]*?(?=\n\[(?!projects\.)|$)/g, "");
  config += '\n[projects."/workspace"]\ntrust_level = "trusted"\n';
  await writeFile(configPath, config, { mode: 0o600 });
  const output = join(dirname(destination), "snapshot-manifest.json");
  await writeFile(output, `${JSON.stringify({ created_at: new Date().toISOString(), source_home: home,
    configuration_repository: { path: repository, commit, tree, tracked_worktree_changes: changed }, adaptations: [
    "configuration repository shallow-cloned independently with its remote removed; current tracked working-tree changes overlaid",
    "project trust entries replaced with /workspace",
    "untracked home files excluded except explicit runtime supplements; no host auth, session history or Hpatch state copied",
    "skills-mgr and rtk copied to /home/ubuntu/.local/bin",
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

export async function prepare(options: PrepareOptions): Promise<string> {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined || uid <= 0 || gid <= 0) throw new Error("prepare requires a non-root POSIX operator identity");
  const source = await realpath(options.source);
  const taskPath = await realpath(options.taskPath);
  const acceptancePath = options.acceptancePath ? await realpath(options.acceptancePath) : undefined;
  const codexBinary = await realpath(options.codexBinary ?? join(options.currentHome, ".local/bin/codex"));
  const codexVersion = (await checked([codexBinary, "--version"])).stdout.trim();
  if (codexVersion !== "codex-cli 0.153.4") throw new Error(`expected Codex 0.153.4, got ${codexVersion}`);
  const codexSha256 = await sha256(codexBinary);
  const codeModeHost = await realpath(join(dirname(codexBinary), "codex-code-mode-host"));
  const codeModeHostStat = await stat(codeModeHost);
  if (!codeModeHostStat.isFile() || (codeModeHostStat.mode & 0o111) === 0) throw new Error(`Codex code-mode host is not executable: ${codeModeHost}`);
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
  if (acceptancePath) await copyFile(acceptancePath, join(runDir, "evaluator/acceptance_test.go"));

  const seed = join(runDir, "seed.git");
  await checked(["git", "init", "--bare", seed]);
  await checked(["git", "-C", seed, "fetch", "--depth=1", `file://${source}`, `${options.baseCommit}:refs/heads/benchmark`]);
  const base = (await checked(["git", "-C", seed, "rev-parse", "refs/heads/benchmark"])).stdout.trim();
  if (base !== options.baseCommit) throw new Error(`requested base resolved to ${base}`);
  const tree = (await checked(["git", "-C", seed, "rev-parse", `${base}^{tree}`])).stdout.trim();
  const sourceTimestamp = Number((await checked(["git", "-C", seed, "show", "-s", "--format=%ct", base])).stdout.trim());
  for (const arm of ["stock", "current"] as const) {
    const repo = join(runDir, "arms", arm, "repo");
    await mkdir(dirname(repo), { recursive: true });
    await checked(["git", "clone", "--no-local", "--no-hardlinks", "--branch", "benchmark", seed, repo]);
    await checked(["git", "-C", repo, "remote", "remove", "origin"]);
    await verifyClone(seed, repo, base, tree, options.forbiddenCommit);
  }
  progress("verified independent base-only clones");

  const currentTemplate = join(runDir, "snapshots/current/home/ubuntu");
  await mkdir(currentTemplate, { recursive: true });
  const snapshotManifest = await snapshotCurrent(options.currentHome, currentTemplate);
  const snapshotDocument = JSON.parse(await readFile(snapshotManifest, "utf8")) as { created_at?: unknown };
  if (typeof snapshotDocument.created_at !== "string") throw new Error("current snapshot manifest has no capture timestamp");
  const stockTemplate = join(runDir, "snapshots/stock/home/ubuntu");
  await mkdir(join(stockTemplate, ".codex"), { recursive: true });
  await writeFile(join(stockTemplate, ".codex/config.toml"), [
    'model = "gpt-6-astra"', 'model_reasoning_effort = "medium"', 'service_tier = "default"',
    'approval_policy = "never"', 'sandbox_mode = "danger-full-access"', 'network_access = "enabled"',
    '', '[projects."/workspace"]', 'trust_level = "trusted"', '',
  ].join("\n"), { mode: 0o600 });
  const bunSource = join(options.currentHome, ".local/share/mise/installs/bun/1.4.2/bin/bun");
  const bunTarget = join(runDir, "snapshots/runtime/bin/bun");
  await copyRequired(bunSource, bunTarget);
  await chmod(bunTarget, 0o755);
  progress("captured repository-based current and minimal stock setup templates");

  const state: RunState = {
    schema_version: 1,
    id: basename(runDir),
    created_at: new Date().toISOString(),
    status: "prepared",
    source: { path: source, base_commit: base, base_tree: tree, source_timestamp: sourceTimestamp, forbidden_commit: options.forbiddenCommit },
    task: { path: "control/task.md", sha256: await sha256(join(runDir, "control/task.md")) },
    acceptance: acceptancePath ? { path: "evaluator/acceptance_test.go", sha256: await sha256(join(runDir, "evaluator/acceptance_test.go")) } : undefined,
    image: options.image,
    execution: { model: "gpt-6-astra", reasoning_effort: "medium", service_tier: serviceTier },
    resource_limits: { cpus: options.cpus, memory: options.memory },
    timeout_seconds: options.timeoutSeconds,
    snapshot_manifest: relative(runDir, snapshotManifest),
    current_snapshot: { captured_at: snapshotDocument.created_at, manifest_sha256: await sha256(snapshotManifest) },
    runtime_tools: {
      bun: relative(runDir, bunTarget), bun_sha256: await sha256(bunTarget),
      codex_source: codexBinary, codex_version: codexVersion, codex_sha256: codexSha256,
      codex_code_mode_host_source: codeModeHost,
      codex_code_mode_host_sha256: codeModeHostSha256,
      codex_code_mode_host_size: codeModeHostStat.size,
    },
    operator: { uid, gid },
    arms: {
      stock: { repository: "arms/stock/repo", home_template: "snapshots/stock/home/ubuntu" },
      current: { repository: "arms/current/repo", home_template: "snapshots/current/home/ubuntu" },
    },
  };
  await writeState(runDir, state);
  return runDir;
}
