import { chmod, copyFile, lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, posix, resolve, sep } from "node:path";
import { candidateFiles, readCandidateManifest, readRegularEvidence, verifyCandidateReconstruction, type CandidateFile } from "./candidate-evidence";
import { OwnedContainerError, runOwnedContainer } from "./container";
import type { ExecResult } from "./process";

const SCHEMA = "codex-ab.fixed-verifier.v1" as const;
const SHA256 = /^[a-f0-9]{64}$/;
const IMMUTABLE_IMAGE = /^(?:sha256:[a-f0-9]{64}|[^\s@]+@sha256:[a-f0-9]{64})$/;
const digest = (value: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(value).digest("hex");

export interface FixedVerifierConfig {
  schema: typeof SCHEMA;
  dataset: { name: string; version: string; revision: string };
  task: { id: string; tree_sha256: string };
  verifier: { path: string; tree_sha256: string; command: string[] };
  image: string;
  candidate_mount: string;
  workdir: string;
  user: string;
  timeout_seconds: number;
  resources: { cpus: string; memory: string; pids_limit: number };
  network: "none";
  reward_key: string;
}

export interface FixedTreeIdentity {
  schema: "codex-ab.fixed-tree.v1";
  sha256: string;
  files: CandidateFile[];
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("fixed verifier configuration requires objects");
  return value as Record<string, unknown>;
}
const nonempty = (value: unknown): value is string => typeof value === "string" && !!value.trim() && !/[\0\r\n]/.test(value);
const relativePath = (value: unknown): value is string => nonempty(value) && !isAbsolute(value)
  && !value.split(/[\\/]/).some(part => !part || part === "." || part === "..");
const containerPath = (value: unknown): value is string => nonempty(value) && value.startsWith("/")
  && !value.includes(":") && posix.normalize(value) === value && value !== "/";
function keys(value: Record<string, unknown>, expected: string[]): void {
  if (Object.keys(value).some(key => !expected.includes(key))) throw new Error("unknown fixed verifier configuration field");
}

export function validateFixedVerifierConfig(value: unknown): FixedVerifierConfig {
  const config = object(value), dataset = object(config.dataset), task = object(config.task), verifier = object(config.verifier), resources = object(config.resources);
  keys(config, ["schema", "dataset", "task", "verifier", "image", "candidate_mount", "workdir", "user", "timeout_seconds", "resources", "network", "reward_key"]);
  keys(dataset, ["name", "version", "revision"]); keys(task, ["id", "tree_sha256"]);
  keys(verifier, ["path", "tree_sha256", "command"]); keys(resources, ["cpus", "memory", "pids_limit"]);
  if (config.schema !== SCHEMA || !nonempty(dataset.name) || !nonempty(dataset.version)
    || typeof dataset.revision !== "string" || !/^(?:[a-f0-9]{40}|sha256:[a-f0-9]{64})$/.test(dataset.revision)
    || !nonempty(task.id) || typeof task.tree_sha256 !== "string" || !SHA256.test(task.tree_sha256)
    || !relativePath(verifier.path) || typeof verifier.tree_sha256 !== "string" || !SHA256.test(verifier.tree_sha256)) {
    throw new Error("fixed verifier requires pinned dataset revision, task tree, and verifier tree identities");
  }
  if (!Array.isArray(verifier.command) || !verifier.command.length || verifier.command.some(argument => !nonempty(argument))
    || !verifier.command.some(argument => typeof argument === "string" && argument.startsWith("/tests/") && posix.normalize(argument) === argument)) {
    throw new Error("fixed verifier command must explicitly invoke an unchanged entrypoint under /tests");
  }
  if (typeof config.image !== "string" || !IMMUTABLE_IMAGE.test(config.image)) throw new Error("fixed verifier image must be an immutable digest");
  if (!containerPath(config.candidate_mount) || !containerPath(config.workdir)
    || !(config.workdir === config.candidate_mount || config.workdir.startsWith(`${config.candidate_mount}/`))
    || ["/tests", "/logs", "/tmp", "/proc", "/sys", "/dev", "/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64"].some(
      path => config.candidate_mount === path || (config.candidate_mount as string).startsWith(`${path}/`) || path.startsWith(`${config.candidate_mount}/`))) {
    throw new Error("fixed verifier candidate mount must be a dedicated application path containing its workdir");
  }
  if (typeof config.user !== "string" || !/^\d+:\d+$/.test(config.user)
    || !Number.isSafeInteger(config.timeout_seconds) || Number(config.timeout_seconds) < 1
    || typeof resources.cpus !== "string" || !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(resources.cpus) || Number(resources.cpus) <= 0
    || typeof resources.memory !== "string" || !/^[1-9]\d*(?:[kmgKMG])?$/.test(resources.memory)
    || !Number.isSafeInteger(resources.pids_limit) || Number(resources.pids_limit) < 1
    || config.network !== "none" || !nonempty(config.reward_key)) {
    throw new Error("fixed verifier requires explicit user, positive resource limits, offline network, and reward key");
  }
  return structuredClone(config) as unknown as FixedVerifierConfig;
}

/** Canonical file/type/content/executable-bit identity, with Git metadata excluded. */
export async function fixedTreeIdentity(directory: string): Promise<FixedTreeIdentity> {
  const root = await realpath(directory);
  if (!(await lstat(directory)).isDirectory()) throw new Error("fixed verifier input must be a real directory");
  const files = await candidateFiles(root);
  for (const file of files) if (file.mode === "120000") {
    // A link whose target is outside the pinned tree would introduce unpinned bytes.
    const target = await realpath(join(root, file.path));
    if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error("fixed verifier tree contains an external symlink");
  }
  return { schema: "codex-ab.fixed-tree.v1", sha256: digest(JSON.stringify(files)), files };
}

export interface FixedReward {
  source: "reward.json" | "reward.txt";
  sha256: string;
  rewards: Record<string, number>;
  selected_key: string;
  reward: number;
}

/** Harbor precedence is strict: a present but broken JSON reward never falls back. */
export async function readFixedReward(directory: string, selectedKey: string): Promise<FixedReward> {
  let source: FixedReward["source"] = "reward.json";
  try { await lstat(join(directory, source)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") source = "reward.txt"; else throw error; }
  const path = join(directory, source);
  const info = await lstat(path);
  if (!info.isFile() || info.size > 1024 * 1024) throw new Error("fixed verifier reward must be a regular file of at most 1 MiB");
  const bytes = await readRegularEvidence(path), text = bytes.toString("utf8").trim();
  if (!text) throw new Error("fixed verifier reward is empty");
  if (source === "reward.txt" && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) throw new Error("fixed verifier text reward is not a decimal number");
  const parsed: unknown = source === "reward.json" ? JSON.parse(text) : { reward: Number(text) };
  const rewardMap = object(parsed);
  if (!Object.keys(rewardMap).length || Object.values(rewardMap).some(value => typeof value !== "number" || !Number.isFinite(value))) {
    throw new Error("fixed verifier rewards must be nonempty finite numeric values");
  }
  const reward = rewardMap[selectedKey];
  if (typeof reward !== "number" || reward < 0 || reward > 1) throw new Error("selected fixed verifier reward must exist and be normalized to [0, 1]");
  return { source, sha256: digest(bytes), rewards: rewardMap as Record<string, number>, selected_key: selectedKey, reward };
}

export interface FixedVerifierResult {
  schema: "codex-ab.fixed-result.v1";
  mode: "fixed-verifier";
  execution_status: "completed" | "nonzero" | "timeout" | "canceled" | "infrastructure-error";
  behavioral_result: "pass" | "fail" | "unassessed";
  evaluation_validity: "valid" | "invalid" | "unavailable";
  started_at: string;
  elapsed_ms: number;
  exit_code: number | null;
  reward: FixedReward | null;
  reason: string;
  config: FixedVerifierConfig;
  config_sha256: string;
  identities: { task_tree: string; verifier_tree: string; candidate_tree: string; candidate_manifest_sha256: string; image: string };
  evidence: { stdout: string; stderr: string; rewards: string; task_manifest: string; verifier_manifest: string; candidate_manifest: string };
  cleanup_verified: boolean;
  trust_boundary: "upstream-fixed-verifier";
  methodology_comparable: false;
  limitations: string[];
}

export interface ExecuteFixedVerifierOptions {
  config: FixedVerifierConfig;
  taskDirectory: string;
  candidate: string;
  candidateManifestPath: string;
  patchPath: string;
  output: string;
  docker: string;
  name: string;
  signal?: AbortSignal;
}

export async function executeFixedVerifier(options: ExecuteFixedVerifierOptions): Promise<FixedVerifierResult> {
  const config = validateFixedVerifierConfig(options.config);
  const taskDirectory = resolve(options.taskDirectory), candidate = resolve(options.candidate), output = resolve(options.output);
  for (const path of [taskDirectory, candidate, output]) if (/[:,\0\r\n]/.test(path)) throw new Error("fixed verifier host paths contain unsupported mount characters");
  if (output === candidate || output.startsWith(`${candidate}${sep}`) || output === taskDirectory || output.startsWith(`${taskDirectory}${sep}`)) {
    throw new Error("fixed verifier evidence destination must be outside the pinned inputs");
  }
  const verifierDirectory = join(taskDirectory, config.verifier.path);
  const [taskIdentity, verifierIdentity, manifest] = await Promise.all([
    fixedTreeIdentity(taskDirectory), fixedTreeIdentity(verifierDirectory), readCandidateManifest(options.candidateManifestPath, options.patchPath),
  ]);
  if (taskIdentity.sha256 !== config.task.tree_sha256 || verifierIdentity.sha256 !== config.verifier.tree_sha256) throw new Error("fixed verifier task or verifier tree differs from its pinned identity");
  await verifyCandidateReconstruction(candidate, manifest);
  await mkdir(output, { recursive: true, mode: 0o700 });
  // Never overwrite an earlier invocation or recycle a reward directory.
  await writeFile(join(output, "invocation.json"), `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  const rewards = join(output, "rewards");
  await mkdir(rewards, { mode: 0o700 });
  // The declared task-image user may differ from the host UID. This is a fresh,
  // isolated verifier-output mount; previous logs and evidence are not writable.
  await chmod(rewards, 0o1777);
  await writeFile(join(output, "task-manifest.json"), JSON.stringify(taskIdentity, null, 2), { mode: 0o600 });
  await writeFile(join(output, "verifier-manifest.json"), JSON.stringify(verifierIdentity, null, 2), { mode: 0o600 });
  await copyFile(options.candidateManifestPath, join(output, "candidate-manifest.json"));
  const started = new Date();
  const result: FixedVerifierResult = {
    schema: "codex-ab.fixed-result.v1", mode: "fixed-verifier", execution_status: "infrastructure-error",
    behavioral_result: "unassessed", evaluation_validity: "unavailable", started_at: started.toISOString(), elapsed_ms: 0,
    exit_code: null, reward: null, reason: "Verifier execution did not complete.", config, config_sha256: digest(JSON.stringify(config)),
    identities: { task_tree: taskIdentity.sha256, verifier_tree: verifierIdentity.sha256, candidate_tree: manifest.captured_tree,
      candidate_manifest_sha256: digest(await readRegularEvidence(options.candidateManifestPath)), image: config.image },
    evidence: { stdout: "stdout.log", stderr: "stderr.log", rewards: "rewards", task_manifest: "task-manifest.json",
      verifier_manifest: "verifier-manifest.json", candidate_manifest: "candidate-manifest.json" },
    cleanup_verified: false, trust_boundary: "upstream-fixed-verifier", methodology_comparable: false,
    limitations: [
      "The pinned upstream verifier owns its assertions and reward protocol; this adapter does not independently qualify its sensitivity or prevent candidate code inside that verifier from attempting reward spoofing.",
      "Offline networking, read-only candidate source, explicit resource/user settings, and this adapter may differ from original benchmark controls.",
      "Task/verifier pins identify supplied bytes; they do not prove official FHE 1.1 provenance, full-corpus coverage, matched model/provider controls, or leaderboard comparability.",
    ],
  };
  let execution: ExecResult | undefined;
  try {
    const owned = await runOwnedContainer({ docker: options.docker, name: options.name, signal: options.signal,
      timeoutMs: config.timeout_seconds * 1000, stdoutFile: join(output, result.evidence.stdout), stderrFile: join(output, result.evidence.stderr),
      createArgs: ["--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--user", config.user, "--cpus", config.resources.cpus, "--memory", config.resources.memory,
        "--pids-limit", String(config.resources.pids_limit), "--workdir", config.workdir,
        "--mount", `type=bind,src=${candidate},dst=${config.candidate_mount},readonly`,
        "--mount", `type=bind,src=${verifierDirectory},dst=/tests,readonly`,
        "--mount", `type=bind,src=${rewards},dst=/logs/verifier`,
        "--entrypoint", config.verifier.command[0]!, config.image, ...config.verifier.command.slice(1)],
    });
    execution = owned;
    result.cleanup_verified = owned.cleanupVerified;
    result.exit_code = owned.exitCode;
    result.elapsed_ms = owned.elapsedMs;
    result.execution_status = owned.canceled ? "canceled" : owned.timedOut ? "timeout" : owned.exitCode === 0 ? "completed" : "nonzero";
    try { result.reward = await readFixedReward(rewards, config.reward_key); }
    catch (error) { result.reason = `No usable original verifier reward: ${error instanceof Error ? error.message : String(error)}`; }
    await verifyCandidateReconstruction(candidate, manifest);
    if ((await fixedTreeIdentity(taskDirectory)).sha256 !== taskIdentity.sha256) throw new Error("pinned task/verifier inputs changed during execution");
    // Harbor consumes a reward after ordinary process termination, including a
    // nonzero test exit. Preserve that score contract and expose exit status
    // separately; a timeout, cancellation, or cleanup error cannot use it.
    if ((result.execution_status === "completed" || result.execution_status === "nonzero") && result.reward) {
      result.evaluation_validity = "valid";
      result.behavioral_result = result.reward.reward === 1 ? "pass" : "fail";
      result.reason = `Original pinned verifier terminated with exit ${owned.exitCode} and recorded ${config.reward_key}=${result.reward.reward}.`;
    } else if (result.execution_status !== "completed") {
      result.evaluation_validity = "unavailable";
      result.reason = `Original verifier ${result.execution_status}; any retained reward is not accepted as a behavioral result.`;
    } else result.evaluation_validity = "invalid";
  } catch (error) {
    if (error instanceof OwnedContainerError) execution = error.result;
    result.execution_status = options.signal?.aborted ? "canceled" : "infrastructure-error";
    result.exit_code = execution?.exitCode ?? result.exit_code;
    result.elapsed_ms = execution?.elapsedMs ?? Math.max(0, Date.now() - started.getTime());
    result.behavioral_result = "unassessed";
    result.evaluation_validity = "unavailable";
    result.reason = error instanceof Error ? error.message : String(error);
  }
  // Creating empty logs after a pre-start failure makes evidence paths resolvable
  // without fabricating stdout or hiding an existing captured stream.
  for (const file of [result.evidence.stdout, result.evidence.stderr]) {
    try { await writeFile(join(output, file), "", { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  await writeFile(join(output, "result.json"), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return result;
}
