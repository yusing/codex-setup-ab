import { chmod, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RunState } from "./types";

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

export async function sha256(path: string): Promise<string> {
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(await Bun.file(path).arrayBuffer());
  return hash.digest("hex");
}
