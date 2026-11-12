import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, isAbsolute } from "node:path";
import { checked } from "./process";
import { executeSemanticCheck, type CriterionEvidence, type SemanticCheck } from "./semantic";
import { semanticCheckHash } from "./semantic-protocol";
import type { RunState } from "./types";
import supervisorSource from "./semantic-supervisor.txt" with { type: "text" };

export interface EvaluatorControls {
  schema: "codex-ab.evaluator-controls.v1";
  cases: Array<{
    id: string;
    role: "reference" | "baseline" | "negative" | "alternative";
    base: "baseline" | "reference";
    /** Exact source mutations, frozen before execution and applied only to the pinned control tree. */
    patches?: Array<{ path: string; before_sha256: string; after_sha256: string; diff: string }>;
    files: Array<{ path: string; source: string | null }>;
    expected: Record<string, "pass" | "fail">;
    /** An interface adapter; input values, cases and expectations stay unchanged. */
    python_target?: { module: string; callable: string };
  }>;
}

export interface EvaluatorQualification {
  schema: "codex-ab.evaluator-qualification.v1";
  status: "qualified" | "failed" | "incomplete" | "not-run";
  scope: string[];
  check_sha256: string;
  controls_sha256?: string;
  task_sha256: string;
  evaluator_version: "supervisor-v1";
  evaluator_model: string;
  runtime_image?: string;
  supervisor_sha256?: string;
  reference_commit?: string;
  results: Array<{ control: string; role: string; expected: "pass" | "fail"; matched: boolean; evidence: CriterionEvidence }>;
  limitations: string[];
}

export function validateEvaluatorControls(value: unknown, criteria: string[]): EvaluatorControls {
  if (!value || typeof value !== "object") throw new Error("invalid evaluator controls");
  const controls = value as EvaluatorControls;
  if (controls.schema !== "codex-ab.evaluator-controls.v1" || !Array.isArray(controls.cases) || !controls.cases.length) throw new Error("evaluator controls require cases");
  const seen = new Set<string>();
  for (const item of controls.cases) {
    if (!item || !/^[a-zA-Z0-9_-]+$/.test(item.id) || seen.has(item.id) || !["reference", "baseline", "negative", "alternative"].includes(item.role) ||
        !["baseline", "reference"].includes(item.base) || !Array.isArray(item.files) || item.patches !== undefined && !Array.isArray(item.patches)
        || !item.expected || typeof item.expected !== "object" || Array.isArray(item.expected) ||
        Object.entries(item.expected).some(([id, status]) => !criteria.includes(id) || !["pass", "fail"].includes(status))) throw new Error("invalid evaluator control case");
    seen.add(item.id);
    const paths = new Set<string>();
    for (const patch of item.patches ?? []) {
      if (!patch || typeof patch.path !== "string" || !/^[a-zA-Z0-9_./-]+$/.test(patch.path)
        || patch.path.startsWith("/") || patch.path.split("/").some(part => !part || part === "." || part === ".." || part === ".git")
        || paths.has(patch.path) || !/^[a-f0-9]{64}$/.test(patch.before_sha256) || !/^[a-f0-9]{64}$/.test(patch.after_sha256)
        || typeof patch.diff !== "string" || !patch.diff.endsWith("\n")
        || patch.diff.split("\n").filter(line => line.startsWith("diff --git ")).join("\n") !== `diff --git a/${patch.path} b/${patch.path}`
        || patch.diff.split("\n").filter(line => line.startsWith("--- ")).join("\n") !== `--- a/${patch.path}`
        || patch.diff.split("\n").filter(line => line.startsWith("+++ ")).join("\n") !== `+++ b/${patch.path}`
        || /^(?:old mode|new mode|new file mode|deleted file mode|rename |copy |GIT binary patch|Binary files)/m.test(patch.diff))
        throw new Error("invalid precise evaluator control patch");
      paths.add(patch.path);
    }
    for (const file of item.files) {
      if (!file || typeof file.path !== "string" || !file.path || file.path.startsWith("/") || file.path.includes("\\") ||
          file.path.split("/").some(part => !part || part === ".." || part === "." || part === ".git") || paths.has(file.path) ||
          !(file.source === null || typeof file.source === "string")) throw new Error("unsafe evaluator control file");
      paths.add(file.path);
    }
    if (item.python_target && (!/^[a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*$/.test(item.python_target.module) ||
        !/^[a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*$/.test(item.python_target.callable))) throw new Error("invalid control interface adapter");
  }
  return controls;
}

/** Run frozen evaluator-only controls through the same executor as candidates. */
export async function qualifySemanticCheck(options: {
  runDir: string; output: string; state: RunState; check: SemanticCheck;
  controls?: EvaluatorControls; docker: string; signal?: AbortSignal; evaluatorModel: string;
}): Promise<EvaluatorQualification> {
  const { state, check, controls } = options;
  const record: EvaluatorQualification = {
    schema: "codex-ab.evaluator-qualification.v1", status: "not-run", scope: [check.criterion],
    check_sha256: semanticCheckHash(check), task_sha256: state.task.sha256,
    evaluator_version: "supervisor-v1", evaluator_model: options.evaluatorModel,
    runtime_image: state.evaluator_cache_image?.image_id ?? state.dependency_image?.image_id ?? state.image_id ?? state.image,
    supervisor_sha256: createHash("sha256").update(supervisorSource).digest("hex"),
    reference_commit: state.upstream_reference?.end_commit, results: [],
    limitations: ["Qualification covers only the declared control implementations and cases; judge order reversal is a bias check, not independent ground truth."],
  };
  await mkdir(options.output, { recursive: true, mode: 0o700 });
  if (controls) {
    validateEvaluatorControls(controls, state.criteria!.contract.criteria.map(item => item.id));
    record.controls_sha256 = createHash("sha256").update(JSON.stringify({ controls, baseline: state.source.base_commit, reference: state.upstream_reference })).digest("hex");
    for (const control of controls.cases.filter(item => item.expected[check.criterion])) {
      const root = join(options.output, control.id);
      const tree = join(root, "candidate");
      await mkdir(tree, { recursive: true, mode: 0o700 });
      await checked(["git", "--git-dir", join(options.runDir, "seed.git"), "archive", "--format=tar", "-o", join(root, "baseline.tar"), state.source.base_commit]);
      await checked(["tar", "-xf", join(root, "baseline.tar"), "-C", tree]);
      if (control.base === "reference") {
        const pin = state.upstream_reference?.files.find(item => item.path.endsWith("/changes.patch"));
        if (!pin) throw new Error("reference qualification requires a pinned upstream reference");
        const patch = await readFile(join(options.runDir, pin.path));
        if (createHash("sha256").update(patch).digest("hex") !== pin.sha256) throw new Error("qualification reference patch changed");
        await checked(["git", "-C", tree, "apply", "--binary", join(options.runDir, pin.path)]);
      }
      for (const [index, patch] of (control.patches ?? []).entries()) {
        let path = tree;
        for (const [offset, part] of patch.path.split("/").entries()) {
          path = join(path, part);
          const entry = await lstat(path);
          if (entry.isSymbolicLink() || (offset === patch.path.split("/").length - 1 ? !entry.isFile() : !entry.isDirectory()))
            throw new Error("control patch traverses a symlink or nonregular input");
        }
        const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
        if (hash(await readFile(path)) !== patch.before_sha256) throw new Error("control patch preimage differs from its frozen identity");
        const patchPath = join(root, `source-${index}.patch`);
        await writeFile(patchPath, patch.diff, { mode: 0o600 });
        await checked(["git", "-C", tree, "apply", "--no-index", "--check", patchPath]);
        await checked(["git", "-C", tree, "apply", "--no-index", patchPath]);
        if (hash(await readFile(path)) !== patch.after_sha256) throw new Error("control patch postimage differs from its frozen identity");
      }
      for (const file of control.files) {
        const path = join(tree, file.path);
        let parentPath = tree;
        for (const part of file.path.split("/").slice(0, -1)) {
          parentPath = join(parentPath, part);
          const entry = await lstat(parentPath).catch(() => undefined);
          if (entry?.isSymbolicLink() || (entry && !entry.isDirectory())) throw new Error("control file traverses a candidate symlink or file");
          if (!entry) await mkdir(parentPath);
        }
        const parent = await realpath(dirname(path));
        const rel = relative(tree, parent);
        if (isAbsolute(rel) || rel === ".." || rel.startsWith("../")) throw new Error("control file traverses a candidate symlink");
        await rm(path, { recursive: false, force: true });
        if (file.source !== null) await writeFile(path, file.source);
      }
      const adapted = structuredClone(check);
      if (control.python_target && adapted.verification) adapted.verification.cases = adapted.verification.cases.map(item =>
        item.kind === "python-call" ? { ...item, ...control.python_target } : item);
      const evidence = await executeSemanticCheck({ runDir: options.runDir, state, candidate: tree, output: join(root, "execution"),
        name: `codex-ab-${state.id}-qualification-${crypto.randomUUID()}`, check: adapted, docker: options.docker, signal: options.signal });
      record.results.push({ control: control.id, role: control.role, expected: control.expected[check.criterion]!,
        matched: evidence.status === control.expected[check.criterion], evidence });
      // Frozen criteria/reference identities plus execution evidence are retained.
      // Avoid publishing a redundant complete repository for every control/check.
      await rm(tree, { recursive: true, force: true });
      await rm(join(root, "baseline.tar"));
    }
    const complete = ["reference", "alternative", "baseline", "negative"].every(role => record.results.some(item => item.role === role)) &&
      record.results.some(item => item.role === "reference" && item.expected === "pass") &&
      record.results.some(item => item.role === "alternative" && item.expected === "pass") &&
      record.results.some(item => item.role === "negative" && item.expected === "fail");
    record.status = record.results.some(item => !item.matched) ? "failed" : complete ? "qualified" : "incomplete";
    if (!complete) record.limitations.push("Each criterion requires reference, baseline, negative and valid alternative controls before qualification is complete.");
  } else record.limitations.push("No frozen task-specific controls were supplied; adaptive evaluator validity is unqualified.");
  await writeFile(join(options.output, "qualification.json"), JSON.stringify(record, null, 2), { mode: 0o600 });
  return record;
}
