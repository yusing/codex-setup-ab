import { copyFile, link, lstat, mkdir, readdir, readlink, realpath, symlink } from "node:fs/promises";
import { join, relative } from "node:path";
import { sha256 } from "./state";

export interface SnapshotStats { copied: number; linked: number; copiedBytes: number; linkedBytes: number }
export interface SnapshotFile { path: string; type: string; sha256?: string; target?: string }

/** Reuse only isolated snapshot inodes, never files from the live tool store. */
export async function snapshotToolStore(source: string, destination: string, previous?: string): Promise<SnapshotStats & { files: SnapshotFile[] }> {
  const sourceRoot = await realpath(source);
  const previousRoot = previous ? await realpath(previous) : undefined;
  if (previousRoot && (previousRoot === sourceRoot || previousRoot.startsWith(`${sourceRoot}/`) || sourceRoot.startsWith(`${previousRoot}/`))) {
    throw new Error("incremental snapshot base must be independent of the live tool store");
  }
  const files: SnapshotFile[] = [];
  const stats: SnapshotStats = { copied: 0, linked: 0, copiedBytes: 0, linkedBytes: 0 };
  async function walk(directory: string): Promise<void> {
    const suffix = relative(source, directory);
    await mkdir(join(destination, suffix), { recursive: true });
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const input = join(directory, entry.name);
      const output = join(destination, suffix, entry.name);
      if (entry.isDirectory()) { await walk(input); continue; }
      if (entry.isSymbolicLink()) {
        const target = await readlink(input);
        await symlink(target, output);
        files.push({ path: relative(source, input), type: "symlink", target });
        continue;
      }
      if (!entry.isFile()) throw new Error(`unsupported tool-store entry: ${input}`);
      const current = await lstat(input);
      const old = previousRoot ? join(previousRoot, suffix, entry.name) : undefined;
      let digest: string | undefined;
      let reused = false;
      if (old) {
        const prior = await lstat(old).catch(error => {
          if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
          throw error;
        });
        // Resolve parents too: a symlink in the old tree must not lead into the live home.
        const resolved = prior?.isFile() ? await realpath(old) : undefined;
        if (prior?.isFile() && resolved?.startsWith(`${previousRoot}/`) &&
            prior.size === current.size && prior.mode === current.mode &&
            (prior.dev !== current.dev || prior.ino !== current.ino) &&
            await sha256(old) === (digest = await sha256(input))) {
          try { await link(old, output); reused = true; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error; }
        }
      }
      if (reused) { stats.linked++; stats.linkedBytes += current.size; }
      else { await copyFile(input, output); stats.copied++; stats.copiedBytes += current.size; }
      // Carry verified digests into the manifest instead of rereading the store.
      digest = reused ? digest : await sha256(output);
      files.push({ path: relative(source, input), type: "file", sha256: digest });
    }
  }
  await walk(source);
  return { ...stats, files };
}
