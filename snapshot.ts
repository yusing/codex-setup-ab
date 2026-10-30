import { lstat, readdir, readFile, readlink, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { gunzipSync } from "node:zlib";
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

export interface ToolStoreManifest {
  files: SnapshotFile[];
  linuxbrew?: { prefix: string; files: SnapshotFile[] };
  rust?: { cargo_bin: string; rustup: string; cargo_files: SnapshotFile[]; rustup_files: SnapshotFile[] };
}

export interface ToolStoreMountRoots {
  readonly linuxbrew?: { readonly prefix: string };
  readonly rust?: { readonly cargo_bin: string; readonly rustup: string };
}

// Retain only mount roots, never the parsed file inventory. Full verification
// reads still decode every record and refresh this projection for their consumers.
const toolStoreMounts = new Map<string, { version: string; roots: ToolStoreMountRoots }>();

async function toolStoreManifestVersion(path: string): Promise<string> {
  const value = await stat(path, { bigint: true });
  return [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(":");
}

export async function readToolStoreManifest(path: string): Promise<ToolStoreManifest> {
  const version = await toolStoreManifestVersion(path);
  const bytes = await readFile(path);
  const manifest = JSON.parse((path.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8")) as ToolStoreManifest;
  toolStoreMounts.set(path, { version, roots: {
    ...(manifest.linuxbrew ? { linuxbrew: { prefix: manifest.linuxbrew.prefix } } : {}),
    ...(manifest.rust ? { rust: { cargo_bin: manifest.rust.cargo_bin, rustup: manifest.rust.rustup } } : {}),
  } });
  return manifest;
}

export async function readToolStoreMountRoots(path: string): Promise<ToolStoreMountRoots> {
  const cached = toolStoreMounts.get(path);
  if (cached?.version === await toolStoreManifestVersion(path)) return cached.roots;
  // Legacy retained runs need no new metadata. Decode their manifest once on a
  // cold mount-only path; subsequent calls use the same compact projection.
  await readToolStoreManifest(path);
  return toolStoreMounts.get(path)!.roots;
}

/** Record metadata for a read-only host mount without reading tool payloads. */
export async function recordToolStore(source: string): Promise<SnapshotFile[]> {
  const files: SnapshotFile[] = [];
  let lastProgress = performance.now();
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
        files.push({ path: name, type: "file", identity: await identity(input) });
      } else {
        throw new Error(`unsupported tool-store entry: ${input}`);
      }
      if (performance.now() - lastProgress >= 5000) {
        process.stderr.write(`[prepare] recorded metadata for ${files.length} tool-store files (no content reads)\n`);
        lastProgress = performance.now();
      }
    }
  }
  await walk(source);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}
