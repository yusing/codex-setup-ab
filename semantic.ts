import { join, posix } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { runOwnedContainer } from "./container";
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
  black_box?: SemanticCheck[];
  qualification: "not-run";
}

export interface SemanticCheck {
  criterion: string;
  files: Array<{ path: string; source: string }>;
  command: string[];
  rationale: string;
}

export interface CriterionEvidence {
  criterion: string;
  status: "pass" | "fail" | "unassessed";
  basis: "executed" | "source-only";
  reasoning: string;
  check?: SemanticCheck;
  execution?: CommandEvidence;
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
  if (!nonempty(contract.preparation) || !nonempty(contract.existing_tests)) throw new Error("criteria require dependency preparation and existing test commands");
  if (contract.allowed_paths !== undefined && (!Array.isArray(contract.allowed_paths) || !contract.allowed_paths.length ||
      !contract.allowed_paths.every(path => typeof path === "string" && path.length > 0 && !path.startsWith("/") &&
        !path.split("/").some(part => part === ".." || part === ".git" || !part)))) {
    throw new Error("allowed_paths must name explicit task-required relative files");
  }
  // Qualification claims require separate retained evidence; this path makes none.
  if (contract.qualification !== "not-run") throw new Error("criteria qualification must be not-run; no oracle qualification has been executed");
  if (contract.black_box !== undefined) {
    const checks = validateSemanticChecks(contract.black_box, contract as unknown as CriteriaContract);
    if (checks.some(check => !(contract.criteria as BehavioralCriterion[]).find(criterion => criterion.id === check.criterion)?.required_interface)) {
      throw new Error("prewritten black-box checks require an explicitly fixed public interface");
    }
  }
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
    return check as unknown as SemanticCheck;
  });
}

export function checkOutcome(check: SemanticCheck, execution: CommandEvidence): CriterionEvidence {
  const output = `${execution.stdout}\n${execution.stderr}`;
  const harnessFailure = execution.exit_code < 0 || execution.exit_code === 125 || (execution.exit_code !== 0 &&
    /(?:undefined:|cannot find (?:module|package)|ModuleNotFoundError|ERR_MODULE_NOT_FOUND|ImportError|SyntaxError|ReferenceError|TypeError:.*is not a function|has no field or method|has no attribute|cannot import name|command not found|no such file or directory|HARNESS_ERROR:)/i.test(output));
  return {
    criterion: check.criterion, status: harnessFailure ? "unassessed" : execution.exit_code === 0 ? "pass" : "fail",
    basis: "executed", reasoning: harnessFailure ? "The evaluator could not execute a usable check; repair its harness without changing the required outcome." : check.rationale,
    check, execution,
  };
}

// Candidate source is mounted read-only. Only added harness files and private temporary
// storage are writable. The interpreter never sees model credentials or a Docker socket.
const CHECK_PROGRAM = `
import hashlib, json, os, pathlib, shutil, subprocess, sys
candidate, harness = pathlib.Path('/candidate'), json.load(open('/harness.json'))
workspace = pathlib.Path('/tmp/evaluation')
shutil.copytree(candidate, workspace, symlinks=True)
def fingerprints(root):
    result = {}
    for path in root.rglob('*'):
        rel = str(path.relative_to(root))
        if path.is_symlink():
            result[rel] = ('link', os.readlink(path))
        elif path.is_file():
            result[rel] = ('file', hashlib.sha256(path.read_bytes()).hexdigest())
    return result
baseline = fingerprints(workspace)
prepared = subprocess.run(['sh', '-lc', harness.get('preparation', 'true')], cwd=workspace)
if prepared.returncode:
    print('HARNESS_ERROR: evaluator dependency preparation failed', file=sys.stderr)
    raise SystemExit(125)
for item in harness['files']:
    target = workspace / item['path']
    if target.exists() or target.is_symlink() or not target.resolve().is_relative_to(workspace):
        raise SystemExit('HARNESS_ERROR: harness must not overwrite candidate files or traverse symlinks')
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(item['source'])
try:
    result = subprocess.run(harness['command'], cwd=workspace)
except OSError as error:
    print('HARNESS_ERROR: ' + str(error), file=sys.stderr)
    raise SystemExit(125)
def current_identity(relative):
    path = workspace / relative
    if path.is_symlink():
        return ('link', os.readlink(path))
    if path.is_file():
        return ('file', hashlib.sha256(path.read_bytes()).hexdigest())
    return None
if any(current_identity(path) != identity for path, identity in baseline.items()):
    print('HARNESS_ERROR: check modified candidate implementation', file=sys.stderr)
    raise SystemExit(125)
raise SystemExit(result.returncode)
`;

export async function executeSemanticCheck(options: {
  runDir: string; state: RunState; candidate: string; output: string; name: string;
  check: SemanticCheck; docker: string; signal?: AbortSignal; arm?: ArmName;
}): Promise<CriterionEvidence> {
  const { runDir, state, check } = options;
  await mkdir(options.output, { recursive: true, mode: 0o700 });
  const harnessPath = join(options.output, "harness.json");
  await writeFile(harnessPath, JSON.stringify({ ...check, preparation: options.state.criteria?.contract.preparation ?? "true" }, null, 2), { mode: 0o600 });
  const started = new Date();
  const result = await runOwnedContainer({
    docker: options.docker, name: options.name, signal: options.signal,
    timeoutMs: state.timeout_seconds * 1000,
    createArgs: ["--network", "none", "--read-only", "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges", "--cpus", state.resource_limits.cpus,
      "--memory", state.resource_limits.memory, "--tmpfs", "/tmp:exec,size=4g,mode=1777",
      "-e", "GOCACHE=/tmp/go-build", "-e", "GOPROXY=off", "-e", "GOSUMDB=off",
      "-e", "PYTHONDONTWRITEBYTECODE=1", "-v", `${options.candidate}:/candidate:ro`,
      "-v", `${harnessPath}:/harness.json:ro`,
      ...(options.arm ? ["-v", `${join(runDir, "arms", options.arm, "grader-go-pkg-cache")}:/home/ubuntu/go/pkg:ro`,
        "-v", `${join(runDir, state.runtime_tools.bun)}:/usr/local/bin/bun:ro`,
        ...(state.profile !== "godoxy-icons" ? ["-v", `${join(runDir, "arms", options.arm, "grader-bun-cache")}:/home/ubuntu/.bun/install/cache:ro`] : [])] : []),
      state.image_id ?? state.image, "python3", "-c", CHECK_PROGRAM],
  });
  const execution: CommandEvidence = {
    command: JSON.stringify(check.command), started_at: started.toISOString(), elapsed_ms: result.elapsedMs,
    exit_code: result.timedOut || result.canceled ? -1 : result.exitCode, stdout: result.stdout, stderr: result.stderr,
  };
  const evidence = checkOutcome(check, execution);
  await writeFile(join(options.output, "evidence.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  return evidence;
}
