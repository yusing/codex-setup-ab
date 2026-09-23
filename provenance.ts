import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { tmpdir } from "node:os";
import { checked } from "./process";
import { runOwnedContainer } from "./container";
import { sha256 } from "./state";
import { MEKUGI_BUILD_INPUTS } from "./support/mekugi";

export interface MekugiBuild {
  schema: "codex-ab.mekugi-build.v1";
  image_id: string;
  source_archive_sha256: string;
  archiver_sha256: string;
  command: string[];
  binaries: { mekugi: string; shell: string };
}

export async function buildMekugi(options: { source: string; image: string; outputParent?: string; docker?: string; signal?: AbortSignal }): Promise<string> {
  const source = await realpath(options.source);
  const docker = options.docker ?? "docker";
  const parent = await realpath(options.outputParent ?? tmpdir());
  if (parent === source || relative(source, parent).split("/")[0] !== "..") throw new Error("build output must be outside the source tree");
  const directory = await mkdtemp(join(parent, "codex-ab-build-"));
  await mkdir(join(directory, "source"));
  await writeFile(join(directory, "build_inputs.py"), MEKUGI_BUILD_INPUTS);
  const archiverHash = await sha256(join(directory, "build_inputs.py"));
  process.stderr.write(`[build] freezing Mekugi source, including dirty files and compiled guidance: ${directory}\n`);
  await checked(["python3", join(directory, "build_inputs.py"), source, join(directory, "source.tar"), join(directory, "source")], { signal: options.signal });
  await rm(join(directory, "source"), { recursive: true });
  const sourceHash = await sha256(join(directory, "source.tar"));
  const imageId = (await checked([docker, "image", "inspect", "--format", "{{.Id}}", options.image], { signal: options.signal })).stdout.trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error("build requires an immutable container image");
  await mkdir(join(directory, "bin"));
  const command = ["sh", "-lc", "mkdir /tmp/build && python3 -c 'import tarfile; tarfile.open(\"/source.tar\").extractall(\"/tmp/build\", filter=\"data\")' && cd /tmp/build && go version && go build -trimpath -buildvcs=false -o /output/mekugi ./cmd/mekugi && go build -trimpath -buildvcs=false -o /output/shell ./cmd/shell"];
  process.stderr.write(`[build] compiling both executables from frozen inputs with ${imageId}\n`);
  const result = await runOwnedContainer({
    docker, name: `codex-ab-build-${directory.split("/").at(-1)}`, signal: options.signal, timeoutMs: 900000,
    stdoutFile: join(directory, "build.stdout"), stderrFile: join(directory, "build.stderr"),
    createArgs: ["--cpus", "2", "--memory", "4g", "-v", `${join(directory, "source.tar")}:/source.tar:ro`,
      "-v", `${join(directory, "bin")}:/output`, imageId, ...command],
  });
  await writeFile(join(directory, "build-result.json"), JSON.stringify(result, null, 2));
  if (result.exitCode !== 0 || result.canceled || result.timedOut) throw new Error(`Mekugi build failed; retained logs in ${directory}`);
  if (await sha256(join(directory, "source.tar")) !== sourceHash) throw new Error("source archive changed during build");
  const manifest: MekugiBuild = { schema: "codex-ab.mekugi-build.v1", image_id: imageId,
    source_archive_sha256: sourceHash, archiver_sha256: archiverHash, command,
    binaries: { mekugi: await sha256(join(directory, "bin/mekugi")), shell: await sha256(join(directory, "bin/shell")) } };
  await writeFile(join(directory, "build.json"), JSON.stringify(manifest, null, 2));
  process.stderr.write("[build] captured source and executable identities; no model inference\n");
  return directory;
}

export async function readMekugiBuild(directory: string): Promise<MekugiBuild> {
  const root = resolve(directory);
  const manifest = JSON.parse(await readFile(join(root, "build.json"), "utf8")) as MekugiBuild;
  if (manifest.schema !== "codex-ab.mekugi-build.v1" || !/^sha256:[a-f0-9]{64}$/.test(manifest.image_id) ||
      manifest.source_archive_sha256 !== await sha256(join(root, "source.tar")) ||
      manifest.archiver_sha256 !== await sha256(join(root, "build_inputs.py")) ||
      manifest.binaries?.mekugi !== await sha256(join(root, "bin/mekugi")) ||
      manifest.binaries?.shell !== await sha256(join(root, "bin/shell"))) throw new Error("Mekugi build provenance changed");
  return manifest;
}
