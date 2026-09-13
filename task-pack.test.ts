import { expect, test } from "bun:test";
import { mkdtemp, cp, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadTaskPack } from "./task-pack";

test("portable packs pin source, task boundaries and fingerprint every expanded check", async () => {
  for (const id of ["gin-context-copy", "nvm-download-no-eval"]) {
    const pack = await loadTaskPack(join(import.meta.dir, "tasks", id, "manifest.json"));
    expect(pack.manifest.id).toBe(id);
    expect(pack.manifest.source.base_commit).toHaveLength(40);
    expect(pack.contract.task_sha256).toHaveLength(64);
    expect(pack.contract.allowed_paths).toHaveLength(1);
    expect(pack.contract.black_box).toHaveLength(1);
    expect(Object.values(pack.snapshot.files).every(file => file.sha256.length === 64 && file.content.length > 0)).toBe(true);
    expect(pack.contract.black_box![0]!.files[0]!.source).not.toContain("source_file");
  }
});

test("pack fingerprints change with check contents and reject escaping assets", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-ab-pack-"));
  try {
    const directory = join(root, "pack");
    await cp(join(import.meta.dir, "tasks/nvm-download-no-eval"), directory, { recursive: true });
    const manifestPath = join(directory, "manifest.json");
    const before = await loadTaskPack(manifestPath);
    await writeFile(join(directory, "blackbox.sh"), "exit 1\n");
    const after = await loadTaskPack(manifestPath);
    expect(before.snapshot.files["blackbox.sh"]!.sha256).not.toBe(after.snapshot.files["blackbox.sh"]!.sha256);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.prompt = "../outside";
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(loadTaskPack(manifestPath)).rejects.toThrow("unsafe");
    await writeFile(join(root, "outside"), "external");
    await symlink(join(root, "outside"), join(directory, "external"));
    manifest.prompt = "external";
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(loadTaskPack(manifestPath)).rejects.toThrow("escapes");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
