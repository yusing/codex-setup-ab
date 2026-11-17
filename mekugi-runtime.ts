import { chmod, copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { sha256 } from "./state";

// Keep the fork's companions together, separate from the stock Codex tool host.
export const MEKUGI_RUNTIME_DIRECTORY = "/usr/local/libexec/mekugi";
export const MEKUGI_RUNTIME_FILES = [
  "mekugi", "mekugi-exec", "mekugi-app-server", "codex-code-mode-host", "bwrap", "mekugi-models.json",
] as const;
export interface MekugiRuntimeFile {
  name: typeof MEKUGI_RUNTIME_FILES[number];
  source: string;
  sha256: string;
}

/** Freeze installed artifacts only. Native runtime compilation is never implicit. */
export async function snapshotMekugiRuntime(runDir: string, launcher: string, nativeDirectory = dirname(launcher)): Promise<MekugiRuntimeFile[]> {
  const files: MekugiRuntimeFile[] = [];
  await mkdir(join(runDir, "snapshots/runtime"), { recursive: true });
  for (const name of MEKUGI_RUNTIME_FILES) {
    const path = name === "mekugi" ? launcher : join(name === "mekugi-exec" ? dirname(launcher) : nativeDirectory, name);
    const info = await stat(path);
    if (!info.isFile() || (name !== "mekugi-models.json" && (info.mode & 0o111) === 0)) {
      throw new Error(`Mekugi runtime artifact is not ${name === "mekugi-models.json" ? "a file" : "executable"}: ${path}`);
    }
    const hash = await sha256(path);
    const source = `snapshots/runtime/${name}`;
    await copyFile(path, join(runDir, source));
    await chmod(join(runDir, source), name === "mekugi-models.json" ? 0o644 : 0o755);
    if (await sha256(join(runDir, source)) !== hash) throw new Error(`Mekugi runtime artifact changed during preparation: ${name}`);
    files.push({ name, source, sha256: hash });
  }
  return files;
}

export async function verifyMekugiRuntime(runDir: string, files: MekugiRuntimeFile[]): Promise<void> {
  if (files.length !== MEKUGI_RUNTIME_FILES.length || MEKUGI_RUNTIME_FILES.some(name => files.filter(file => file.name === name).length !== 1)) {
    throw new Error("Mekugi runtime inventory is incomplete");
  }
  for (const file of files) {
    if (file.source !== `snapshots/runtime/${file.name}` || !/^[a-f0-9]{64}$/.test(file.sha256)
        || await sha256(resolve(runDir, file.source)) !== file.sha256) {
      throw new Error(`snapshotted Mekugi runtime changed: ${file.name}`);
    }
  }
}
