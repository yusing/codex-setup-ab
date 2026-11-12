import { cp, lstat, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { readCandidateManifest, readRegularEvidence } from "./candidate-evidence";
import { executeFixedVerifier, fixedTreeIdentity, validateFixedVerifierConfig, type FixedVerifierConfig, type FixedVerifierResult } from "./fixed-verifier";
import { armExecutionSucceeded, readState, sha256, withRunLock, writeState } from "./state";
import { armNames, type ArmName, type CommandEvidence, type RunState } from "./types";

function relativeInput(value: string): string {
  if (!value || value.startsWith("/") || value.includes("\\") || /[\0\r\n]/.test(value)
    || value.split("/").some(part => !part || part === "." || part === "..")) throw new Error("fixed input paths must be safe run-relative paths");
  return value;
}
const armKey = (value: string) => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)) throw new Error("invalid fixed verifier arm key");
  return value;
};

function assertNoHistoricalFixedInputs(state: RunState): void {
  if (state.planned_imports?.length || Object.keys(state.imported_arms ?? {}).length || state.imported_control || state.evaluation?.mode === "reuse") {
    throw new Error("configured fixed-verifier mode does not yet support historical imports or evaluation reuse; prepare a fresh fixed comparison");
  }
}

interface VerifiedFixedInputs { config: FixedVerifierConfig; taskDirectory: string; promptPath: string }

async function validateInputs(runDir: string, state: RunState, configPath: string, taskDirectory: string,
  promptPath: string): Promise<VerifiedFixedInputs> {
  relativeInput(promptPath);
  const config = validateFixedVerifierConfig(JSON.parse((await readRegularEvidence(configPath)).toString("utf8")));
  const [task, verifier, prompt, frozenPrompt] = await Promise.all([
    fixedTreeIdentity(taskDirectory), fixedTreeIdentity(join(taskDirectory, config.verifier.path)),
    readRegularEvidence(join(taskDirectory, promptPath)), readRegularEvidence(join(runDir, relativeInput(state.task.path))),
  ]);
  if (task.sha256 !== config.task.tree_sha256 || verifier.sha256 !== config.verifier.tree_sha256) throw new Error("fixed input task or verifier tree differs from pinned configuration");
  const hash = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  if (hash(prompt) !== state.task.sha256 || hash(frozenPrompt) !== state.task.sha256) {
    throw new Error("original fixed task prompt does not match the prepared candidate task SHA-256");
  }
  return { config, taskDirectory, promptPath };
}

/** Verify both task identity and exact prompt binding without starting a container. */
export async function verifyFixedInputs(runDir: string, state: RunState): Promise<VerifiedFixedInputs> {
  const fixed = state.fixed_verifier;
  if (!fixed || fixed.mode !== "fixed-verifier") throw new Error("run has no configured fixed verifier");
  assertNoHistoricalFixedInputs(state);
  const configPath = join(runDir, relativeInput(fixed.config_path));
  if (await sha256(configPath) !== fixed.config_sha256) throw new Error("retained fixed verifier configuration identity changed");
  return validateInputs(runDir, state, configPath, join(runDir, relativeInput(fixed.task_directory)), relativeInput(fixed.prompt_path));
}

async function snapshotInputs(runDir: string, state: RunState, options: { configPath: string; taskDir: string; promptPath?: string },
  destination: string): Promise<NonNullable<RunState["fixed_verifier"]>> {
  const configPath = resolve(options.configPath), taskDirectory = resolve(options.taskDir), promptPath = options.promptPath ?? "instruction.md";
  await validateInputs(runDir, state, configPath, taskDirectory, promptPath);
  try { await lstat(destination); throw new Error("fixed input snapshot already exists; existing evidence will not be overwritten"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const parent = join(destination, "..");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(parent, ".fixed-inputs-"));
  try {
    await writeFile(join(staging, "config.json"), await readRegularEvidence(configPath), { mode: 0o600 });
    await cp(taskDirectory, join(staging, "task"), { recursive: true, dereference: false, verbatimSymlinks: true,
      errorOnExist: true, force: false, filter: source => basename(source).toLowerCase() !== ".git" });
    await validateInputs(runDir, state, join(staging, "config.json"), join(staging, "task"), promptPath);
    await rename(staging, destination);
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
  return { mode: "fixed-verifier", config_path: relative(runDir, join(destination, "config.json")),
    config_sha256: await sha256(join(destination, "config.json")), task_directory: relative(runDir, join(destination, "task")), prompt_path: promptPath };
}

/** Configure a new prepared run. This operation makes no model or Docker calls. */
export async function configureFixedVerifierRun(options: {
  runDir: string; configPath: string; taskDir: string; promptPath?: string;
}): Promise<NonNullable<RunState["fixed_verifier"]>> {
  const runDir = resolve(options.runDir);
  return withRunLock(runDir, async () => {
    const state = await readState(runDir);
    if (state.status !== "prepared" || state.finishing || state.judge || Object.keys(state.results ?? {}).length || Object.keys(state.arm_attempts ?? {}).length) {
      throw new Error("configure-fixed requires a new prepared run before any candidate or judge attempt");
    }
    if (state.fixed_verifier) throw new Error("fixed verifier is already configured; prepare a new run to change its immutable inputs");
    assertNoHistoricalFixedInputs(state);
    const fixed = await snapshotInputs(runDir, state, options, join(runDir, "evaluator/fixed-inputs"));
    state.fixed_verifier = fixed;
    state.evaluation = { mode: "fresh" };
    await writeState(runDir, state);
    return fixed;
  });
}

async function executeArm(runDir: string, state: RunState, arm: ArmName, inputs: VerifiedFixedInputs,
  output: string, docker: string, signal?: AbortSignal): Promise<FixedVerifierResult> {
  armKey(arm);
  const result = state.results?.[arm];
  if (!state.arms[arm] || !armExecutionSucceeded(result)) throw new Error(`fixed verification requires successful retained candidate execution for ${arm}`);
  if (result.capture_identity?.status !== "verified") throw new Error("fixed verification requires a trusted candidate capture manifest; legacy capture is unverified");
  const manifest = await readCandidateManifest(join(runDir, relativeInput(result.capture_identity.manifest_path)), join(runDir, relativeInput(result.patch_path)));
  if (manifest.base_commit !== state.source.base_commit || manifest.base_tree !== state.source.base_tree
    || manifest.captured_tree !== result.capture_identity.tree || manifest.patch_sha256 !== result.capture_identity.patch_sha256) {
    throw new Error("fixed verifier candidate identity differs from the retained run capture");
  }
  const candidate = join(runDir, "evaluator", arm);
  let exists = false;
  try { exists = (await lstat(candidate)).isDirectory(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (!exists) {
    // runner imports verifyFixedInputs, so load reconstruction only when needed.
    const { gradeArm } = await import("./runner");
    await gradeArm(docker, runDir, state, arm, join(runDir, relativeInput(result.patch_path)), signal ?? new AbortController().signal);
  }
  return executeFixedVerifier({ config: inputs.config, taskDirectory: inputs.taskDirectory, candidate,
    candidateManifestPath: join(runDir, relativeInput(result.capture_identity.manifest_path)), patchPath: join(runDir, relativeInput(result.patch_path)),
    output, docker, name: `codex-ab-fixed-${crypto.randomUUID()}`, signal });
}

async function freshOutput(runDir: string, arm: ArmName): Promise<string> {
  const directory = join(runDir, "evaluator/fixed", armKey(arm));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return mkdtemp(join(directory, "attempt-"));
}

function appendResult(state: RunState, runDir: string, arm: ArmName, output: string, fixed: FixedVerifierResult): void {
  state.fixed_verifiers ??= {};
  state.fixed_verifiers[arm] ??= [];
  state.fixed_verifiers[arm]!.push({ result_path: relative(runDir, join(output, "result.json")), result: fixed });
}

/** Caller owns the run lock. Ordinary task failures finish normally; invalid evaluation does not. */
export async function runFixedVerifiersUnlocked(runDir: string, docker = "docker", signal?: AbortSignal): Promise<void> {
  const state = await readState(runDir);
  const inputs = await verifyFixedInputs(runDir, state);
  if (state.judge) throw new Error("configured fixed mode cannot combine an adaptive judge with the original verifier score");
  const arms = state.selected_arms ?? armNames(state);
  if (!arms.length) throw new Error("fixed verification requires retained candidate arms");
  const failures: string[] = [];
  for (const arm of arms) {
    if (signal?.aborted) throw new Error("fixed verification canceled; prior attempt evidence is retained");
    const output = await freshOutput(runDir, arm);
    const fixed = await executeArm(runDir, state, arm, inputs, output, docker, signal);
    appendResult(state, runDir, arm, output, fixed);
    const ready: CommandEvidence = { command: "verify pinned fixed inputs and trusted candidate reconstruction",
      started_at: fixed.started_at, elapsed_ms: 0, exit_code: 0, stdout: "", stderr: "" };
    const valid = fixed.evaluation_validity === "valid", passed = valid && fixed.behavioral_result === "pass";
    const gate: CommandEvidence = { command: "original fixed verifier reward gate", started_at: fixed.started_at,
      elapsed_ms: fixed.elapsed_ms, exit_code: valid ? passed ? 0 : 1 : -1,
      stdout: JSON.stringify({ result_path: relative(runDir, join(output, "result.json")), reward: fixed.reward,
        execution_status: fixed.execution_status, original_exit_code: fixed.exit_code }), stderr: valid ? "" : fixed.reason };
    state.results![arm]!.grade = { preparation: ready, router_suite: gate, elapsed_ms: fixed.elapsed_ms,
      fixed, passed, ...(!valid ? { evaluator_error: fixed.reason } : {}) };
    await writeState(runDir, state);
    if (!valid) failures.push(`${arm}: ${fixed.reason}`);
  }
  if (failures.length) throw new Error(`fixed verification unavailable; retained evidence: ${failures.join("; ")}`);
}

/** Supplemental fixed verification retains the existing adaptive grade and reports separately. */
export async function verifyFixedArm(options: {
  runDir: string; arm: ArmName; configPath: string; taskDir: string; promptPath?: string; dockerBin?: string; signal?: AbortSignal;
}): Promise<FixedVerifierResult> {
  const runDir = resolve(options.runDir);
  return withRunLock(runDir, async () => {
    const state = await readState(runDir);
    if (state.status !== "complete") throw new Error("supplemental fixed verification requires completed candidate execution");
    if (state.fixed_verifier) throw new Error("use the configured fixed verifier without supplemental config arguments");
    if (!state.arms[options.arm] || !armExecutionSucceeded(state.results?.[options.arm])) throw new Error("supplemental fixed verification requires a successful retained arm");
    const output = await freshOutput(runDir, options.arm);
    const pinned = await snapshotInputs(runDir, state, options, join(output, "inputs"));
    const inputs = await validateInputs(runDir, state, join(runDir, pinned.config_path), join(runDir, pinned.task_directory), pinned.prompt_path);
    const fixed = await executeArm(runDir, state, options.arm, inputs, output, options.dockerBin ?? process.env.CODEX_AB_DOCKER_BIN ?? "docker", options.signal);
    appendResult(state, runDir, options.arm, output, fixed);
    await writeState(runDir, state);
    return fixed;
  });
}
