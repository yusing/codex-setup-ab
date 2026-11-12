import { lstat, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { sha256 } from "./state";

export const ROLLOUT_SCHEMA = "codex-ab.rollouts.v2" as const;
export interface RolloutFile { path: string; sha256: string }
export interface RolloutManifest {
  schema: typeof ROLLOUT_SCHEMA;
  arms: Record<string, RolloutFile[]>;
}

/** The same two namespaces and JSONL selection drive metering and retention. */
export async function rolloutPaths(home: string): Promise<string[]> {
  const paths: string[] = [];
  async function visit(directory: string): Promise<void> {
    let info;
    try { info = await lstat(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("rollout namespace must be a real directory");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (!entry.isFile()) throw new Error("rollout evidence contains a non-regular file");
      else if (entry.name.endsWith(".jsonl")) paths.push(path);
    }
  }
  await visit(join(home, "sessions"));
  await visit(join(home, "archived_sessions"));
  return paths.sort();
}

export async function rolloutIdentity(home: string): Promise<RolloutFile[]> {
  return Promise.all((await rolloutPaths(home)).map(async path => ({ path: relative(home, path), sha256: await sha256(path) })));
}

export function readRolloutManifest(value: unknown): RolloutManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid rollout manifest");
  const record = value as Record<string, unknown>;
  if (record.schema !== ROLLOUT_SCHEMA) throw new Error("imports require codex-ab.rollouts.v2 evidence for active and archived sessions");
  const source = record.arms;
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("invalid rollout manifest arms");
  const arms: Record<string, RolloutFile[]> = {};
  for (const [arm, files] of Object.entries(source)) {
    if (!Array.isArray(files)) throw new Error("invalid rollout manifest files");
    const seen = new Set<string>();
    arms[arm] = files.map(file => {
      if (!file || typeof file.path !== "string" || !file.path || file.path.startsWith("/")
        || file.path.split("/").some((part: string) => !part || part === "." || part === "..")
        || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error("invalid rollout file identity");
      const path = file.path;
      if (!/^(sessions|archived_sessions)\/.+\.jsonl$/.test(path) || seen.has(path)) throw new Error("invalid or duplicate rollout file path");
      seen.add(path);
      return { path, sha256: file.sha256 };
    }).sort((a, b) => a.path.localeCompare(b.path));
  }
  return { schema: ROLLOUT_SCHEMA, arms };
}

export async function verifyRolloutIdentity(home: string, expected: RolloutFile[]): Promise<void> {
  const actual = await rolloutIdentity(home);
  const sorted = [...expected].sort((a, b) => a.path.localeCompare(b.path));
  const ordered = [...actual].sort((a, b) => a.path.localeCompare(b.path));
  if (ordered.length !== sorted.length) throw new Error("control rollout file list changed");
  if (ordered.some((file, index) => file.path !== sorted[index]!.path || file.sha256 !== sorted[index]!.sha256)) {
    throw new Error("control rollout bytes differ from the published bundle");
  }
}
