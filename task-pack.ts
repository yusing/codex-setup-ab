import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { validateCriteria, type CriteriaContract } from "./semantic";
import { checked } from "./process";
import { sha256 } from "./state";
import type { RunState } from "./types";

interface TaskPack {
  schema: "codex-ab.task-pack.v1";
  id: string;
  source: { repository: string; base_commit: string; forbidden_commit: string; reference_commit?: string };
  prompt: string;
  criteria: Omit<CriteriaContract, "task_sha256">;
}

const hash = (text: string): string => createHash("sha256").update(text).digest("hex");

export async function loadTaskPack(path: string): Promise<{
  manifest: TaskPack; taskPath: string; contract: CriteriaContract;
  snapshot: { manifest: TaskPack; files: Record<string, { sha256: string; content: string }> };
}> {
  const manifestPath = await realpath(path);
  const directory = dirname(manifestPath);
  const manifestText = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(manifestText) as TaskPack;
  if (manifest?.schema !== "codex-ab.task-pack.v1" || typeof manifest.id !== "string" || !/^[a-z0-9-]+$/.test(manifest.id) ||
      typeof manifest.source?.repository !== "string" || !manifest.source.repository.startsWith("https://") ||
      !/^[a-f0-9]{40}$/.test(manifest.source.base_commit) || !/^[a-f0-9]{40}$/.test(manifest.source.forbidden_commit) ||
      manifest.source.base_commit === manifest.source.forbidden_commit) throw new Error("invalid pinned task pack");
  if (manifest.source.reference_commit !== undefined && (typeof manifest.source.reference_commit !== "string" || !/^[a-f0-9]{40}$/.test(manifest.source.reference_commit) ||
      manifest.source.reference_commit === manifest.source.base_commit)) throw new Error("invalid upstream reference endpoint");
  const files: Record<string, { sha256: string; content: string }> = {
    "manifest.json": { sha256: hash(manifestText), content: manifestText },
  };
  async function asset(name: string): Promise<{ path: string; content: string }> {
    if (typeof name !== "string" || !name || isAbsolute(name) || name.split(/[\\/]/).some(part => !part || part === ".." || part === ".")) {
      throw new Error("unsafe task pack asset");
    }
    const path = await realpath(join(directory, name));
    const rel = relative(directory, path);
    if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error("task pack asset escapes pack");
    const content = await readFile(path, "utf8");
    files[name] = { sha256: hash(content), content };
    return { path, content };
  }
  const task = await asset(manifest.prompt);
  const contract = validateCriteria({ ...manifest.criteria, task_sha256: hash(task.content) }, hash(task.content));
  return { manifest, taskPath: task.path, contract, snapshot: { manifest, files } };
}

/** Freeze source evidence outside every implementation mount. */
export async function snapshotUpstreamReference(runDir: string, source: string, pin: TaskPack["source"]): Promise<RunState["upstream_reference"]> {
  if (!pin.reference_commit) return undefined;
  const base = pin.base_commit, end = pin.reference_commit;
  await checked(["git", "-C", source, "merge-base", "--is-ancestor", base, end]);
  await checked(["git", "-C", source, "merge-base", "--is-ancestor", pin.forbidden_commit, end]);
  const commits = (await checked(["git", "-C", source, "rev-list", "--reverse", "--ancestry-path", `${base}..${end}`])).stdout.trim().split("\n");
  const root = join(runDir, "evaluator/upstream");
  await mkdir(root, { recursive: true });
  const files: Array<{ path: string; sha256: string }> = [];
  const index: Array<{ commit: string; subject: string; patch: string }> = [];
  for (const commit of commits) {
    const patch = `${commit}.patch`;
    await checked(["git", "-C", source, "show", "--format=fuller", "--binary", "--no-ext-diff", "--no-textconv", "--diff-merges=first-parent", commit, "--"], { stdoutFile: join(root, patch) });
    index.push({ commit, subject: (await checked(["git", "-C", source, "show", "-s", "--format=%s", commit])).stdout.trim(), patch });
    files.push({ path: `evaluator/upstream/${patch}`, sha256: await sha256(join(root, patch)) });
  }
  await checked(["git", "-C", source, "diff", "--binary", "--no-ext-diff", "--no-textconv", base, end, "--"], { stdoutFile: join(root, "changes.patch") });
  await writeFile(join(root, "index.json"), JSON.stringify({ repository: pin.repository, base_commit: base, end_commit: end, commits: index }, null, 2));
  for (const name of ["index.json", "changes.patch"]) files.push({ path: `evaluator/upstream/${name}`, sha256: await sha256(join(root, name)) });
  return { base_commit: base, end_commit: end, files };
}
