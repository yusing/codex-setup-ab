import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildMekugi, readMekugiBuild } from "./provenance";
import { sha256 } from "./state";

test("build identity rejects altered archives and executables; output cannot contain itself", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-ab-build-test-"));
  try {
    await mkdir(join(root, "bin"));
    for (const name of ["source.tar", "build_inputs.py", "bin/mekugi", "bin/shell"]) await writeFile(join(root, name), name);
    await writeFile(join(root, "build.json"), JSON.stringify({
      schema: "codex-ab.mekugi-build.v1", image_id: `sha256:${"a".repeat(64)}`,
      source_archive_sha256: await sha256(join(root, "source.tar")), archiver_sha256: await sha256(join(root, "build_inputs.py")),
      command: ["go", "build"], binaries: { mekugi: await sha256(join(root, "bin/mekugi")), shell: await sha256(join(root, "bin/shell")) },
    }));
    expect((await readMekugiBuild(root)).schema).toBe("codex-ab.mekugi-build.v1");
    await writeFile(join(root, "bin/shell"), "changed");
    await expect(readMekugiBuild(root)).rejects.toThrow("provenance changed");
    await expect(buildMekugi({ source: root, outputParent: root, image: "unused" })).rejects.toThrow("outside");
  } finally { await rm(root, { recursive: true, force: true }); }
});
