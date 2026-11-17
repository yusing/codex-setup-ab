import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { sha256 } from "./state";

export interface MekugiBuild {
  schema: "codex-ab.mekugi-build.v1";
  image_id: string;
  source_archive_sha256: string;
  archiver_sha256: string;
  command: string[];
  binaries: { mekugi: string; mekugi_exec?: string };
}

export async function readMekugiBuild(directory: string): Promise<MekugiBuild> {
  const root = resolve(directory);
  const manifest = JSON.parse(await readFile(join(root, "build.json"), "utf8")) as MekugiBuild;
  if (manifest.schema !== "codex-ab.mekugi-build.v1" || !/^sha256:[a-f0-9]{64}$/.test(manifest.image_id) ||
      manifest.source_archive_sha256 !== await sha256(join(root, "source.tar")) ||
      manifest.archiver_sha256 !== await sha256(join(root, "build_inputs.py")) ||
      manifest.binaries?.mekugi !== await sha256(join(root, "bin/mekugi")) ||
      (manifest.binaries.mekugi_exec !== undefined && manifest.binaries.mekugi_exec !== await sha256(join(root, "bin/mekugi-exec")))) throw new Error("Mekugi build provenance changed");
  return manifest;
}
