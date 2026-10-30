import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildMekugi, readMekugiBuild } from "./provenance";
import { sha256 } from "./state";
import { checked } from "./process";

test("build freezing never extracts source on the host; the build consumes the archive", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-ab-freeze-test-"));
  try {
    const source = join(root, "checkout");
    const output = join(root, "output");
    const tools = join(root, "tools");
    for (const directory of [source, output, tools]) await mkdir(directory);
    await writeFile(join(source, "dirty.go"), "dirty source");
    const python = Bun.which("python3")!;
    await writeFile(join(tools, "python3"), `#!${python}
import runpy, sys, tarfile
def forbidden(*args, **kwargs):
    raise AssertionError('host source extraction is forbidden')
tarfile.TarFile.extractall = forbidden
sys.argv = sys.argv[1:]
runpy.run_path(sys.argv[0], run_name='__main__')
`, { mode: 0o755 });
    const docker = join(tools, "docker");
    await writeFile(docker, `#!${python}
from pathlib import Path
import sys, tarfile
args = sys.argv[1:]
if args[0] == 'image':
    print('sha256:' + 'a' * 64)
elif args[0] == 'container':
    print('No such container', file=sys.stderr)
    sys.exit(1)
elif args[0] == 'create':
    mounts = [args[i + 1] for i, value in enumerate(args) if value == '-v']
    archive = Path(next(value.removesuffix(':/source.tar:ro') for value in mounts if value.endswith(':/source.tar:ro')))
    output = Path(next(value.removesuffix(':/output') for value in mounts if value.endswith(':/output')))
    with tarfile.open(archive) as frozen:
        frozen.extractall(output.parent / 'fixture-container', filter='data')
    payload = (output.parent / 'fixture-container/dirty.go').read_bytes()
    for binary in ('mekugi', 'mekugi-exec'):
        (output / binary).write_bytes(payload)
    print('fixture-container')
`, { mode: 0o755 });
    const result = await checked([process.execPath, "-e", `
      import { buildMekugi } from ${JSON.stringify(join(import.meta.dir, "provenance.ts"))};
      console.log(await buildMekugi(${JSON.stringify({ source, outputParent: output, image: "fixture", docker })}));
    `], { env: { ...process.env, PATH: `${tools}:${process.env.PATH}` } });
    const directory = result.stdout.trim();
    expect(await readdir(directory)).not.toContain("source");
    const build = await readMekugiBuild(directory);
    expect(build.binaries.mekugi).toBe(await sha256(join(source, "dirty.go")));
    expect(build.command.join(" ")).toContain('extractall("/tmp/build", filter="data")');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("build identity rejects altered archives and executables; output cannot contain itself", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-ab-build-test-"));
  try {
    await mkdir(join(root, "bin"));
    for (const name of ["source.tar", "build_inputs.py", "bin/mekugi", "bin/mekugi-exec"]) await writeFile(join(root, name), name);
    await writeFile(join(root, "build.json"), JSON.stringify({
      schema: "codex-ab.mekugi-build.v1", image_id: `sha256:${"a".repeat(64)}`,
      source_archive_sha256: await sha256(join(root, "source.tar")), archiver_sha256: await sha256(join(root, "build_inputs.py")),
      command: ["go", "build"], binaries: { mekugi: await sha256(join(root, "bin/mekugi")), mekugi_exec: await sha256(join(root, "bin/mekugi-exec")) },
    }));
    expect((await readMekugiBuild(root)).schema).toBe("codex-ab.mekugi-build.v1");
    await writeFile(join(root, "bin/mekugi"), "changed");
    await expect(readMekugiBuild(root)).rejects.toThrow("provenance changed");
    await writeFile(join(root, "bin/mekugi"), "bin/mekugi");
    await expect(readMekugiBuild(root)).resolves.toMatchObject({ binaries: { mekugi: await sha256(join(root, "bin/mekugi")) } });
    await writeFile(join(root, "bin/mekugi-exec"), "changed");
    await expect(readMekugiBuild(root)).rejects.toThrow("provenance changed");
    await writeFile(join(root, "bin/mekugi-exec"), "bin/mekugi-exec");
    await writeFile(join(root, "source.tar"), "changed");
    await expect(readMekugiBuild(root)).rejects.toThrow("provenance changed");
    await expect(buildMekugi({ source: root, outputParent: root, image: "unused" })).rejects.toThrow("outside");
  } finally { await rm(root, { recursive: true, force: true }); }
});
