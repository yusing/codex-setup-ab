import { lstat, readdir, readlink } from "node:fs/promises";
import { join, relative } from "node:path";
import { sha256 } from "./state";

export interface SnapshotIdentity {
  dev: string;
  ino: string;
  size: string;
  mode: string;
  mtime_ns: string;
  ctime_ns: string;
}
export interface SnapshotFile { path: string; type: string; sha256?: string; target?: string; identity?: SnapshotIdentity }

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

/**
 * Record a sorted, content-addressed manifest of a live tool store without copying
 * or linking any entries.
 */
export async function recordToolStore(source: string): Promise<SnapshotFile[]> {
  const files: SnapshotFile[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const input = join(directory, entry.name);
      const name = relative(source, input);
      if (entry.isDirectory()) {
        await walk(input);
        continue;
      }
      if (entry.isSymbolicLink()) {
        const before = await identity(input);
        const target = await readlink(input);
        const after = await identity(input);
        if (!sameIdentity(before, after)) throw new Error(`tool-store entry changed while recording: ${input}`);
        files.push({ path: name, type: "symlink", target, identity: after });
      } else if (entry.isFile()) {
        const before = await identity(input);
        const digest = await sha256(input);
        const after = await identity(input);
        if (!sameIdentity(before, after)) throw new Error(`tool-store file changed while recording: ${input}`);
        files.push({ path: name, type: "file", sha256: digest, identity: after });
      } else {
        throw new Error(`unsupported tool-store entry: ${input}`);
      }
      if (files.length % 1000 === 0) process.stderr.write(`[prepare] recorded ${files.length} tool-store files\n`);
    }
  }
  await walk(source);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}
