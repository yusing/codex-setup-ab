import { copyFile, link, lstat, mkdir, readdir, readlink, realpath, symlink } from "node:fs/promises";
import { join, relative } from "node:path";
import { sha256 } from "./state";

export interface SnapshotStats { copied: number; linked: number; copiedBytes: number; linkedBytes: number }
export interface SnapshotIdentity {
  dev: string;
  ino: string;
  size: string;
  mode: string;
  mtime_ns: string;
  ctime_ns: string;
}
export interface SnapshotFile { path: string; type: string; sha256?: string; target?: string; identity?: SnapshotIdentity }
export interface PreviousSnapshot {
  root: string;
  files: SnapshotFile[];
  sourceRoot: string;
  capturedAt: string;
}

async function identity(path: string): Promise<SnapshotIdentity> {
  const value = await lstat(path, { bigint: true });
  return {
    dev: String(value.dev), ino: String(value.ino), size: String(value.size), mode: String(value.mode),
    mtime_ns: String(value.mtimeNs), ctime_ns: String(value.ctimeNs),
  };
}

function sameIdentity(left: SnapshotIdentity, right: SnapshotIdentity | undefined): boolean {
  return right !== undefined && Object.keys(left).every(key => left[key as keyof SnapshotIdentity] === right[key as keyof SnapshotIdentity]);
}

/** Verify that a prepared snapshot has not changed without rereading all file contents. */
export async function verifySnapshotIdentities(root: string, expected: SnapshotFile[]): Promise<boolean> {
  const recorded = new Map(expected.map(file => [file.path, file]));
  let seen = 0;
  let valid = true;
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const name = relative(root, path);
      if (entry.isDirectory()) { await walk(path); continue; }
      const wanted = recorded.get(name);
      seen++;
      if (!wanted) { valid = false; continue; }
      if (entry.isSymbolicLink()) {
        // A fresh copy has a new inode; the literal target is its complete content.
        if (wanted.type !== "symlink" || wanted.target !== await readlink(path)) valid = false;
      } else if (!entry.isFile() || wanted.type !== "file") {
        valid = false;
      } else {
        const actual = await identity(path);
        if (wanted.identity && actual.mode !== wanted.identity.mode) {
          valid = false;
        } else if (!sameIdentity(actual, wanted.identity) && (!wanted.sha256 || await sha256(path) !== wanted.sha256)) {
          // Link creation and deletion legitimately change ctime. A digest fallback
          // distinguishes those lifecycle changes from content tampering.
          valid = false;
        }
      }
    }
  }
  await walk(root);
  return valid && seen === expected.length;
}

/** Reuse only isolated snapshot inodes, never files from the live tool store. */
export async function snapshotToolStore(source: string, destination: string, previous?: PreviousSnapshot): Promise<SnapshotStats & { files: SnapshotFile[] }> {
  const sourceRoot = await realpath(source);
  const previousRoot = previous ? await realpath(previous.root) : undefined;
  if (previousRoot && (previousRoot === sourceRoot || previousRoot.startsWith(`${sourceRoot}/`) || sourceRoot.startsWith(`${previousRoot}/`))) {
    throw new Error("incremental snapshot base must be independent of the live tool store");
  }
  const previousFiles = previous ? new Map(previous.files.map(file => [file.path, file])) : undefined;
  const previousSourceRoot = previous
    ? await realpath(previous.sourceRoot).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    })
    : undefined;
  const unchangedBefore = previous && previousSourceRoot === sourceRoot
    ? Date.parse(previous.capturedAt)
    : Number.NaN;
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
        files.push({ path: relative(source, input), type: "symlink", target, identity: await identity(output) });
        continue;
      }
      if (!entry.isFile()) throw new Error(`unsupported tool-store entry: ${input}`);
      const current = await lstat(input);
      const old = previousRoot ? join(previousRoot, suffix, entry.name) : undefined;
      const name = relative(source, input);
      const recorded = previousFiles?.get(name);
      let digest: string | undefined;
      let reused = false;
      if (old) {
        const prior = await lstat(old).catch(error => {
          if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
          throw error;
        });
        // Resolve parents too: a symlink in the old tree must not lead into the live home.
        const resolved = prior?.isFile() ? await realpath(old) : undefined;
        const eligibleBaseFile = prior?.isFile() && resolved?.startsWith(`${previousRoot}/`) &&
            prior.size === current.size && prior.mode === current.mode &&
            (prior.dev !== current.dev || prior.ino !== current.ino);
        const recordedSnapshotIsUnchanged = eligibleBaseFile && recorded?.sha256 !== undefined && recorded.identity !== undefined &&
          sameIdentity(await identity(old), recorded.identity);
        const liveFilePredatesSnapshot = recordedSnapshotIsUnchanged && Number.isFinite(unchangedBefore) && current.ctimeMs <= unchangedBefore;
        const contentsMatch = eligibleBaseFile && (liveFilePredatesSnapshot
          ? (digest = recorded!.sha256)
          : await sha256(old!) === (digest = await sha256(input)));
        if (eligibleBaseFile && contentsMatch) {
          try { await link(old, output); reused = true; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error; }
        }
      }
      if (reused) { stats.linked++; stats.linkedBytes += current.size; }
      else { await copyFile(input, output); stats.copied++; stats.copiedBytes += current.size; }
      // Carry verified digests into the manifest instead of rereading the store.
      digest = reused ? digest : await sha256(output);
      files.push({ path: name, type: "file", sha256: digest, identity: await identity(output) });
    }
  }
  await walk(source);
  return { ...stats, files };
}
