import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, lstat, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotToolStore } from "./snapshot";

test("incremental snapshots reuse old copies, isolate live edits, and survive base cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-ab-snapshot-test-"));
  try {
    const live = join(root, "live"), first = join(root, "first"), second = join(root, "second");
    await mkdir(live);
    await writeFile(join(live, "same"), "same");
    await writeFile(join(live, "changed"), "before");
    await writeFile(join(live, "removed"), "old");
    await symlink("same", join(live, "alias"));
    await snapshotToolStore(live, first);
    await writeFile(join(live, "changed"), "after!");
    await rm(join(live, "removed"));
    const stats = await snapshotToolStore(live, second, first);
    expect(stats.linked).toBe(1);
    expect(stats.files.map(file => file.path)).toEqual(["alias", "changed", "same"]);
    for (const entry of stats.files.filter(file => file.type === "file")) {
      expect(entry.sha256).toBe(new Bun.CryptoHasher("sha256").update(await readFile(join(second, entry.path))).digest("hex"));
    }
    expect(stats.copied).toBe(1);
    expect((await lstat(join(first, "same"))).ino).toBe((await lstat(join(second, "same"))).ino);
    expect((await lstat(join(live, "same"))).ino).not.toBe((await lstat(join(second, "same"))).ino);
    expect(await readFile(join(first, "changed"), "utf8")).toBe("before");
    expect(await Bun.file(join(second, "removed")).exists()).toBe(false);
    await writeFile(join(live, "same"), "live edit");
    await rm(first, { recursive: true });
    expect(await readFile(join(second, "alias"), "utf8")).toBe("same");
    expect(await readFile(join(second, "changed"), "utf8")).toBe("after!");
    await expect(snapshotToolStore(live, join(root, "bad"), live)).rejects.toThrow("independent");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("old parent symlinks cannot cause live files to be linked", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-ab-snapshot-test-"));
  try {
    const live = join(root, "live"), old = join(root, "old"), next = join(root, "next");
    await mkdir(join(live, "nested"), { recursive: true });
    await mkdir(old);
    await writeFile(join(live, "nested/file"), "data");
    await symlink(join(live, "nested"), join(old, "nested"));
    expect((await snapshotToolStore(live, next, old)).linked).toBe(0);
    expect((await lstat(join(live, "nested/file"))).ino).not.toBe((await lstat(join(next, "nested/file"))).ino);
  } finally { await rm(root, { recursive: true, force: true }); }
});
