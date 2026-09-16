import { readFile, realpath } from "node:fs/promises";
import { dirname, join, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { validateCriteria, type CriteriaContract } from "./semantic";

interface TaskPack {
  schema: "codex-ab.task-pack.v1";
  id: string;
  source: { repository: string; base_commit: string; forbidden_commit: string };
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
