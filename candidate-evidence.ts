import { constants } from "node:fs";
import { lstat, open, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";
import { checked } from "./process";

export interface CandidateFile { path: string; mode: "100644" | "100755" | "120000"; sha256: string; size: number }
export interface CandidateManifest {
  schema: "codex-ab.candidate-manifest.v1";
  base_commit: string; base_tree: string; captured_tree: string;
  excluded_directories: string[]; files: CandidateFile[]; changed_files: string[]; patch_sha256: string;
}
const digest = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
export async function readRegularEvidence(path: string): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { if (!(await file.stat()).isFile()) throw new Error(`evidence must be a regular file: ${path}`); return await file.readFile(); }
  finally { await file.close(); }
}
function validPath(path: unknown): path is string {
  return typeof path === "string" && path.length > 0 && !path.startsWith("/") && !path.includes("\0") && !path.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git");
}
export async function readCandidateManifest(path: string, patch: string): Promise<CandidateManifest> {
  const value = JSON.parse((await readRegularEvidence(path)).toString("utf8")) as CandidateManifest;
  if (value.schema !== "codex-ab.candidate-manifest.v1" || ![value.base_commit, value.base_tree, value.captured_tree].every(id => /^[0-9a-f]{40}$/.test(id)) ||
      !Array.isArray(value.files) || !Array.isArray(value.changed_files) || !Array.isArray(value.excluded_directories) ||
      value.files.some(item => !validPath(item.path) || !["100644", "100755", "120000"].includes(item.mode) || !/^[0-9a-f]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.size) || item.size < 0) ||
      value.changed_files.some(path => !validPath(path)) || value.excluded_directories.some(path => typeof path !== "string" || !path.endsWith("node_modules/") || !validPath(path.slice(0, -1))) ||
      new Set(value.files.map(file => file.path)).size !== value.files.length || new Set(value.changed_files).size !== value.changed_files.length ||
      digest(await readRegularEvidence(patch)) !== value.patch_sha256) throw new Error("invalid or changed trusted candidate manifest/patch");
  return value;
}
/** Independent filesystem reader: no Git configuration, attributes, or symlink traversal. */
export async function candidateFiles(root: string): Promise<CandidateFile[]> {
  const entries: CandidateFile[] = [];
  async function visit(directory: string, prefix: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.toLowerCase() === ".git") continue;
      const path = prefix + entry.name, absolute = join(directory, entry.name);
      if (entry.isDirectory()) { await visit(absolute, path + "/"); continue; }
      const stat = await lstat(absolute);
      if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`unsupported reconstructed file: ${path}`);
      const bytes = stat.isSymbolicLink() ? await readlink(absolute, { encoding: "buffer" }) : await readRegularEvidence(absolute);
      entries.push({ path, mode: stat.isSymbolicLink() ? "120000" : stat.mode & 0o111 ? "100755" : "100644", sha256: digest(bytes), size: bytes.length });
    }
  }
  await visit(root, "");
  return entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
export async function verifyCandidateReconstruction(root: string, manifest: CandidateManifest): Promise<void> {
  if (JSON.stringify(await candidateFiles(root)) !== JSON.stringify(manifest.files)) throw new Error("reconstructed candidate contents differ from independent capture manifest");
  const git = (args: string[]) => checked(["git", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", root, ...args]);
  if ((await git(["write-tree"])).stdout.trim() !== manifest.captured_tree) throw new Error("reconstructed Git tree differs from captured tree");
  const changed = (await git(["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", manifest.base_commit])).stdout.split("\0").filter(Boolean).sort();
  if (JSON.stringify(changed) !== JSON.stringify([...manifest.changed_files].sort())) throw new Error("trusted change list and reconstructed patch disagree");
}
