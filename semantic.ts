import { dependencyImage } from "./dependencies";
import { join, posix } from "node:path";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { exec } from "./process";
import { writeState } from "./state";
import { runOwnedContainer } from "./container";
import supervisorSource from "./semantic-supervisor.txt" with { type: "text" };
import { semanticCheckHash, validateVerification, validateVerifierRecord, type SemanticVerification } from "./semantic-protocol";
import { validateEvaluatorControls, type EvaluatorControls, type EvaluatorQualification } from "./semantic-qualification";
import type { ArmName, CommandEvidence, RunState } from "./types";

export interface BehavioralCriterion {
  id: string;
  description: string;
  required_interface?: string;
}

export interface CriteriaContract {
  schema: "codex-ab.criteria.v1";
  task_sha256: string;
  criteria: BehavioralCriterion[];
  preparation: string;
  allowed_paths?: string[];
  existing_tests: string;
  /** Unchanged baseline test files rerun against candidate production code. */
  retained_tests?: { patterns: string[]; command: string };
  evaluator_guidance?: string;
  qualification: "not-run";
  /** Optional independent assertions for the predetermined existing-test gate. */
  existing_test_verification?: SemanticVerification;
  /** Frozen with the task and retained only in evaluator inputs. */
  evaluator_controls?: EvaluatorControls;
}

export interface SemanticCheck {
  criterion: string;
  files: Array<{ path: string; source: string }>;
  command: string[];
  rationale: string;
  verification?: SemanticVerification;
  /** Python modules used only by evaluator wiring, checked without candidate imports. */
  evaluator_dependencies?: string[];
  repair?: { defect: string; retained_inputs: string[]; retained_assertions: string[]; retained_edge_cases: string[]; retained_failure_conditions: string[] };
}

export interface CriterionEvidence {
  schema?: "codex-ab.criterion-evidence.v2";
  criterion: string;
  status: "pass" | "fail" | "unassessed";
  basis: "executed" | "source-only";
  reasoning: string;
  check?: SemanticCheck;
  execution?: CommandEvidence;
  qualification?: EvaluatorQualification;
  /** Raw supervisor result before evaluator qualification affects eligibility. */
  probe_status?: "pass" | "fail" | "unassessed";
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected an object");
  return value as Record<string, unknown>;
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateCriteria(value: unknown, taskSha256: string): CriteriaContract {
  const contract = object(value);
  if (contract.schema !== "codex-ab.criteria.v1" || contract.task_sha256 !== taskSha256) throw new Error("criteria must bind the predetermined task SHA-256");
  if (!Array.isArray(contract.criteria) || !contract.criteria.length) throw new Error("criteria must not be empty");
  const ids = new Set<string>();
  for (const value of contract.criteria) {
    const criterion = object(value);
    if (!nonempty(criterion.id) || !/^[a-zA-Z0-9_-]+$/.test(criterion.id) || ids.has(criterion.id) ||
        !nonempty(criterion.description) || (criterion.required_interface !== undefined && !nonempty(criterion.required_interface))) {
      throw new Error("invalid or duplicate behavioral criterion");
    }
    ids.add(criterion.id);
  }
  if (contract.evaluator_guidance !== undefined && !nonempty(contract.evaluator_guidance)) throw new Error("criteria evaluator_guidance must be a nonempty string");
  if (!nonempty(contract.preparation) || !nonempty(contract.existing_tests)) throw new Error("criteria require dependency preparation and existing test commands");
  if (contract.retained_tests !== undefined) {
    const retained = contract.retained_tests as Record<string, unknown>;
    if (!retained || typeof retained !== "object" || Array.isArray(retained) || !nonempty(retained.command) || !Array.isArray(retained.patterns) || !retained.patterns.length ||
        !retained.patterns.every(pattern => nonempty(pattern) && !pattern.startsWith("/") && !pattern.split("/").some(part => part === ".." || part === ".git"))) {
      throw new Error("retained_tests requires a command and relative baseline file patterns");
    }
  }
  if (contract.allowed_paths !== undefined && (!Array.isArray(contract.allowed_paths) || !contract.allowed_paths.length ||
      !contract.allowed_paths.every(path => typeof path === "string" && path.length > 0 && !path.startsWith("/") &&
        !path.split("/").some(part => part === ".." || part === ".git" || !part)))) {
    throw new Error("allowed_paths must name explicit task-required relative files");
  }
  if (contract.existing_test_verification !== undefined) validateVerification(contract.existing_test_verification);
  if (contract.evaluator_controls !== undefined) validateEvaluatorControls(contract.evaluator_controls, [...ids]);
  // Qualification claims require separate retained evidence; this path makes none.
  if (contract.qualification !== "not-run") throw new Error("criteria qualification must be not-run; no oracle qualification has been executed");
  if (Object.hasOwn(contract, "black_box")) throw new Error("prewritten hidden checks are no longer supported; use task-derived semantic assessment");
  return contract as unknown as CriteriaContract;
}

export function validateSemanticChecks(value: unknown, contract: CriteriaContract): SemanticCheck[] {
  if (!Array.isArray(value)) throw new Error("judge checks must be an array");
  const ids = new Set<string>();
  return value.map(item => {
    const check = object(item);
    if (!nonempty(check.criterion) || ids.has(check.criterion) ||
        !contract.criteria.some(criterion => criterion.id === check.criterion)) throw new Error("unknown or repeated criterion");
    ids.add(check.criterion);
    if (!Array.isArray(check.command) || !check.command.length || !check.command.every(nonempty) ||
        !nonempty(check.rationale) || !Array.isArray(check.files)) throw new Error("judge check requires command, rationale and files");
    const paths = new Set<string>();
    for (const item of check.files) {
      const file = object(item);
      if (!nonempty(file.path) || file.path.includes("\\") || file.path.startsWith("/") ||
          file.path.split("/").some(part => part === ".." || part === ".git" || !part) ||
          posix.normalize(file.path) !== file.path || paths.has(file.path) || typeof file.source !== "string") {
        throw new Error("unsafe or duplicate judge harness path");
      }
      paths.add(file.path);
    }
    if (check.verification !== undefined) validateVerification(check.verification);
    if (check.evaluator_dependencies !== undefined && (!Array.isArray(check.evaluator_dependencies) ||
        !check.evaluator_dependencies.every(item => typeof item === "string" && /^[a-zA-Z_]\w*$/.test(item)))) throw new Error("invalid evaluator-only Python dependencies");
    if (check.repair !== undefined) {
      const repair = object(check.repair);
      if (!nonempty(repair.defect) || !["retained_inputs", "retained_assertions", "retained_edge_cases", "retained_failure_conditions"].every(key =>
          Array.isArray(repair[key]) && (repair[key] as unknown[]).length > 0 && (repair[key] as unknown[]).every(nonempty))) throw new Error("repair requires an auditable defect and retained obligations");
    }
    return check as unknown as SemanticCheck;
  });
}

export function checkOutcome(check: SemanticCheck, execution: CommandEvidence): CriterionEvidence {
  const verifier = execution.verifier;
  const expected = check.verification?.cases.length ?? 0;
  const valid = validateVerifierRecord(verifier, check, expected);
  const status = valid?.status === "passed" ? "pass"
    : valid && ["assertion_failure", "candidate_error"].includes(valid.status) ? "fail" : "unassessed";
  return {
    schema: "codex-ab.criterion-evidence.v2", criterion: check.criterion, status, basis: "executed",
    reasoning: valid?.detail ?? "No valid supervisor completion record was retained; command output and exit status alone cannot establish behavioral coverage.",
    check, execution,
  };
}

/** Output vocabulary is candidate-controlled and cannot relabel a failure. */
export function retainedOutcome(evidence: CriterionEvidence): CriterionEvidence { return evidence; }

/** Warm only pinned baseline code; checks share its immutable image seed. */
export async function prepareEvaluatorCache(runDir: string, state: RunState, docker: string, signal?: AbortSignal): Promise<void> {
  const arm = Object.keys(state.arms).find(arm => state.evaluation?.mode !== "reuse" || !state.imported_arms?.[arm]);
  if (!arm || !await access(join(runDir, "evaluator", arm, "go.mod")).then(() => true, () => false)) return;
  const root = join(runDir, "evaluator/compiler-cache");
  const base = dependencyImage(state);
  const timeout = Math.min(state.timeout_seconds, 120);
  const key = createHash("sha256").update(JSON.stringify({ version: 4, base,
    commit: state.source.base_commit, timeout, operator: state.operator, limits: state.resource_limits })).digest("hex");
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(join(root, "warm.json"), JSON.stringify({ key, base_image: base,
    base_commit: state.source.base_commit, timeout_seconds: timeout, resource_limits: state.resource_limits,
    command: "git clone --no-hardlinks /seed.git /tmp/base && cd /tmp/base && git checkout --detach $BASE_COMMIT && go test -c -o /tmp/baseline-cache.test ." }, null, 2));
  if (state.evaluator_cache_image && state.evaluator_cache_image.key !== key) throw new Error("evaluator cache inputs changed");
  const tag = `codex-ab-evaluator-cache:${key}`;
  const inspect = () => exec([docker, "image", "inspect", "--format", "{{.Id}}", state.evaluator_cache_image?.image_id ?? tag], { signal });
  let image = await inspect();
  if (image.canceled || signal?.aborted) throw new Error("compiler cache warming canceled");
  if (image.exitCode === 0) {
    const id = image.stdout.trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(id)) throw new Error("invalid evaluator cache image identity");
    if (state.evaluator_cache_image && state.evaluator_cache_image.image_id !== id) throw new Error("evaluator cache image changed");
    state.evaluator_cache_image = { key, image_id: id };
    return;
  }
  if (state.evaluator_cache_image) throw new Error("pinned evaluator cache image unavailable");
  if (!/no such (image|object)/i.test(image.stderr)) {
    process.stderr.write("[grade] optional baseline cache image unavailable; using dependency image cache\n");
    return;
  }
  process.stderr.write("[grade] warming shared baseline compiler cache offline\n");
  const result = await runOwnedContainer({ docker, name: `codex-ab-${state.id}-compiler-cache`, signal,
    timeoutMs: timeout * 1000, snapshotImage: `codex-ab-evaluator-warm:${crypto.randomUUID()}`,
    onSnapshot: async image_id => { await writeFile(join(root, "warm-image.json"), JSON.stringify({ image_id })); },
    createArgs: ["--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--cpus", state.resource_limits.cpus, "--memory", state.resource_limits.memory,
      "--tmpfs", "/tmp:exec,size=4g,mode=1777", "-v", `${join(runDir, "seed.git")}:/seed.git:ro`,
      "-e", "GOCACHE=/opt/task-deps/go-build", "-e", "GOPROXY=off", "-e", "GOSUMDB=off",
      "-e", `BASE_COMMIT=${state.source.base_commit}`, base, "sh", "-c",
      'git clone --no-hardlinks /seed.git /tmp/base && cd /tmp/base && git checkout --detach "$BASE_COMMIT" && go test -c -o /tmp/baseline-cache.test .'],
    stdoutFile: join(root, "warm.stdout"), stderrFile: join(root, "warm.stderr"),
  });
  if (result.canceled || signal?.aborted) throw new Error("compiler cache warming canceled");
  if (result.timedOut || result.exitCode !== 0) process.stderr.write(`[grade] baseline cache warming ${result.timedOut ? "timed out" : `exited ${result.exitCode}`}; retaining available compiler entries\n`);
  if (!result.snapshotImageId) throw new Error("compiler cache warming image was not retained");
  // Go's best-effort access-time updates otherwise copy aged immutable payloads
  // into every OverlayFS upper layer. Keep payloads readable/executable but owned
  // by root; native action indexes and all newly produced entries remain writable.
  const sealed = await runOwnedContainer({ docker, name: `codex-ab-${state.id}-compiler-cache-seal`, signal, timeoutMs: 60_000,
    snapshotImage: `codex-ab-evaluator-sealed:${crypto.randomUUID()}`, snapshotUser: `${state.operator.uid}:${state.operator.gid}`,
    onSnapshot: async image_id => { await writeFile(join(root, "sealed-image.json"), JSON.stringify({ image_id })); },
    createArgs: ["--network", "none", "--user", "0:0", "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "FOWNER",
      "--security-opt", "no-new-privileges", "--cpus", state.resource_limits.cpus, "--memory", state.resource_limits.memory,
      result.snapshotImageId, "python3", "-c", `import os,pathlib,stat
for path in pathlib.Path('/opt/task-deps/go-build').rglob('*'):
    mode=path.lstat().st_mode
    if stat.S_ISREG(mode) and (path.name.endswith('-d') or path.parent.name.endswith('-d')):
        os.chown(path,0,0,follow_symlinks=False)
        path.chmod(0o555 if mode & 0o111 else 0o444)
`], stdoutFile: join(root, "seal.stdout"), stderrFile: join(root, "seal.stderr"),
  });
  if (sealed.exitCode !== 0 || sealed.timedOut || sealed.canceled || signal?.aborted || !sealed.snapshotImageId) throw new Error("compiler cache publication failed; see evaluator/compiler-cache/seal.stderr");
  state.evaluator_cache_image = { key, image_id: sealed.snapshotImageId };
  await writeState(runDir, state);
  const published = await exec([docker, "tag", sealed.snapshotImageId, tag], { signal });
  if (published.exitCode !== 0 || published.canceled || signal?.aborted) throw new Error("compiler cache publication failed");
}

export async function executeSemanticCheck(options: {
  runDir: string; state: RunState; candidate: string; output: string; name: string;
  check: SemanticCheck; docker: string; signal?: AbortSignal; arm?: ArmName;
  /** Baseline source tree whose files matching these patterns replace the candidate's. */
  retained?: { patterns: string[]; baseline: string };
}): Promise<CriterionEvidence> {
  const { runDir, state, check } = options;
  await mkdir(options.output, { recursive: true, mode: 0o700 });
  const harnessPath = join(options.output, "harness.json");
  const supervisorOutput = join(options.output, "supervisor");
  await mkdir(supervisorOutput, { recursive: true, mode: 0o700 });
  await rm(join(supervisorOutput, "result.json"), { force: true });
  const resultUid = process.getuid?.() ?? 1000, resultGid = process.getgid?.() ?? 1000;
  const candidateUid = resultUid === 65534 ? 65533 : 65534;
  // Leave time to kill an unprivileged child and persist its protected record
  // before the host's outer container deadline. Short budgets retain 100ms.
  const executionBudget = Math.max(0.1, state.timeout_seconds - 2);
  await writeFile(harnessPath, JSON.stringify({ ...check,
    check_sha256: semanticCheckHash(check), candidate_uid: candidateUid, candidate_gid: candidateUid,
    result_uid: resultUid, result_gid: resultGid,
    execution_timeout_seconds: executionBudget,
    case_timeout_seconds: Math.min(executionBudget, 120),
    preparation: options.state.criteria?.contract.preparation ?? "true",
    ...(options.retained ? { retained: { patterns: options.retained.patterns } } : {}) }, null, 2), { mode: 0o600 });
  const started = new Date();
  const result = await runOwnedContainer({
    docker: options.docker, name: options.name, signal: options.signal,
    timeoutMs: state.timeout_seconds * 1000,
    createArgs: ["--network", "none", "--user", "0:0", "--cap-drop", "ALL",
      "--cap-add", "SETUID", "--cap-add", "SETGID", "--cap-add", "CHOWN", "--cap-add", "FOWNER", "--cap-add", "DAC_OVERRIDE", "--cap-add", "KILL",
      "--security-opt", "no-new-privileges", "--cpus", state.resource_limits.cpus,
      "--memory", state.resource_limits.memory, "--tmpfs", "/tmp:exec,size=4g,mode=1777",
      "-e", "GOPROXY=off", "-e", "GOSUMDB=off",
      "-e", "XDG_STATE_HOME=/tmp/state", "-e", "XDG_CONFIG_HOME=/tmp/config",
      "-e", "MEKUGI_RUNTIME_DIR=/tmp/runtime",
      "-e", "PYTHONDONTWRITEBYTECODE=1", "-v", `${options.candidate}:/candidate:ro`,
      "-v", `${harnessPath}:/harness.json:ro`, "-v", `${supervisorOutput}:/verifier-results:rw`,
      ...(options.retained ? ["-v", `${options.retained.baseline}:/baseline:ro`] : []),
      ...(options.arm && !state.dependency_image ? ["-v", `${join(runDir, "arms", options.arm, "grader-go-pkg-cache")}:/home/ubuntu/go/pkg:ro`,
        ...(state.profile !== "godoxy-icons" ? ["-v", `${join(runDir, "arms", options.arm, "grader-bun-cache")}:/home/ubuntu/.bun/install/cache:ro`] : [])] : []),
      state.evaluator_cache_image?.image_id ?? dependencyImage(state), "python3", "-I", "-c", supervisorSource],
  });
  const saved = await readFile(join(supervisorOutput, "result.json"), "utf8").then(value => {
    try { return JSON.parse(value) as unknown; } catch { return undefined; }
  }, () => undefined);
  let verifier = validateVerifierRecord(saved, check, check.verification?.cases.length ?? 0);
  if (verifier?.status === "passed" && result.exitCode !== 0) verifier = undefined;
  if (result.timedOut || result.canceled) verifier = {
    schema: "codex-ab.verifier-result.v1", check_sha256: semanticCheckHash(check),
    status: result.canceled ? "canceled" : "timeout", completed: 0,
    expected: check.verification?.cases.length ?? 0, detail: result.canceled ? "Evaluation was canceled." : "Evaluation timed out.", cases: [],
  };
  const execution: CommandEvidence = {
    ...(verifier ? { verifier } : {}),
    command: JSON.stringify(check.command), started_at: started.toISOString(), elapsed_ms: result.elapsedMs,
    exit_code: result.timedOut || result.canceled ? -1 : result.exitCode, stdout: result.stdout, stderr: result.stderr,
  };
  const outcome = checkOutcome(check, execution);
  const evidence = options.retained ? retainedOutcome(outcome) : outcome;
  await writeFile(join(options.output, "evidence.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  return evidence;
}
