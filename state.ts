import { createReadStream } from "node:fs";
import { chmod, mkdir, rename, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RunState } from "./types";

/** Serialize whole lifecycle operations, not just their final state writes. */
export async function withRunLock<T>(runDir: string, operation: () => Promise<T>): Promise<T> {
  const lock = join(runDir, ".operation-lock");
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("run is locked by another operation; do not resume or start a second attempt");
    throw error;
  }
  try { return await operation(); }
  finally { await rmdir(lock); }
}

export async function readState(runDir: string): Promise<RunState> {
  const value = await Bun.file(join(runDir, "run.json")).json() as RunState;
  if (value.schema_version !== 1) throw new Error(`unsupported run schema: ${String(value.schema_version)}`);
  return value;
}

export async function writeState(runDir: string, state: RunState): Promise<void> {
  const target = join(runDir, "run.json");
  const temporary = join(dirname(target), `.run-${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, target);
}

async function contentSignature(path: string): Promise<string> {
  const info = await stat(path, { bigint: true });
  return [info.dev, info.ino, info.size, info.mode, info.mtimeNs, info.ctimeNs].join(":");
}

/** Hash the current file and reject concurrent identity changes. */
export async function sha256(path: string): Promise<string> {
  const before = await contentSignature(path);
  const hash = new Bun.CryptoHasher("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (await contentSignature(path) !== before) throw new Error(`file changed while hashing: ${path}`);
  return hash.digest("hex");
}
