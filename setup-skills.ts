import { readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { checked } from "./process";

const selectionPath = ".skills-mgr/.skills-mgr.json";
interface SkillEntry { enabled?: boolean | string; [key: string]: unknown }
interface SkillRegistry { skills?: Record<string, SkillEntry>; [key: string]: unknown }

function registry(text: string): SkillRegistry {
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value) || !value.skills || typeof value.skills !== "object" || Array.isArray(value.skills)
    || Object.values(value.skills).some(item => !item || typeof item !== "object" || Array.isArray(item))) throw new Error("Invalid setup skill registry");
  return value;
}

/** Read only selection metadata, never execute skill conditions or expose skill bodies. */
export async function setupSkills(directory: string, revision?: string) {
  if (revision === "stock") return [];
  let text: string;
  if (revision) {
    const commit = (await checked(["git", "-C", directory, "rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`])).stdout.trim();
    if (!(await checked(["git", "-C", directory, "ls-tree", "--name-only", commit, "--", selectionPath])).stdout.trim()) return [];
    text = (await checked(["git", "-C", directory, "show", `${commit}:${selectionPath}`])).stdout;
  } else {
    try { text = await readFile(join(directory, selectionPath), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  return Object.entries(registry(text).skills!).sort(([a], [b]) => a.localeCompare(b)).map(([name, entry]) => ({
    name, enabled: entry.enabled === true || typeof entry.enabled === "string", conditional: typeof entry.enabled === "string",
  }));
}

export async function validateSkillSelection(template: string, selection: Record<string, boolean>): Promise<void> {
  const available = new Set((await setupSkills(template)).map(skill => skill.name));
  for (const name of Object.keys(selection)) if (!available.has(name)) throw new Error(`Skill is unavailable in this setup: ${name}`);
}

/** Adapt only a disposable arm home. Host and frozen setup bytes stay intact. */
export async function applySkillSelection(template: string, selection?: Record<string, boolean>): Promise<void> {
  if (!selection || !Object.keys(selection).length) return;
  await validateSkillSelection(template, selection);
  const path = join(template, selectionPath);
  if (!(await realpath(dirname(path))).startsWith(resolve(template) + sep)) throw new Error("Skill registry directory escapes the arm home");
  const config = registry(await readFile(path, "utf8"));
  for (const [name, enabled] of Object.entries(selection)) config.skills![name] = { ...config.skills![name], enabled };
  await rm(path, { force: true });
  await writeFile(path, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}
