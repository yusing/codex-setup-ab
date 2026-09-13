import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, lstat, rm, symlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotToolStore, verifySnapshotIdentities } from "./snapshot";

test("incremental snapshots reuse old copies, isolate live edits, and survive base cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-ab-snapshot-test-"));
  try {
    const live = join(root, "live"), first = join(root, "first"), second = join(root, "second");
    await mkdir(live);
    await writeFile(join(live, "same"), "same");
    await writeFile(join(live, "changed"), "before");
    await writeFile(join(live, "removed"), "old");
    await symlink("same", join(live, "alias"));
    const initial = await snapshotToolStore(live, first);
    await writeFile(join(live, "changed"), "after!");
    await writeFile(join(live, "added"), "new");
    await rm(join(live, "removed"));
    const stats = await snapshotToolStore(live, second, { root: first, files: initial.files, sourceRoot: live, capturedAt: new Date(0).toISOString() });
    expect(stats.linked).toBe(1);
    expect(stats.files.map(file => file.path)).toEqual(["added", "alias", "changed", "same"]);
    for (const entry of stats.files.filter(file => file.type === "file")) {
      expect(entry.sha256).toBe(new Bun.CryptoHasher("sha256").update(await readFile(join(second, entry.path))).digest("hex"));
    }
    expect(stats.copied).toBe(2);
    expect((await lstat(join(first, "same"))).ino).toBe((await lstat(join(second, "same"))).ino);
    expect((await lstat(join(live, "same"))).ino).not.toBe((await lstat(join(second, "same"))).ino);
    expect(await readFile(join(first, "changed"), "utf8")).toBe("before");
    expect(await Bun.file(join(second, "removed")).exists()).toBe(false);
    await writeFile(join(live, "same"), "live edit");
    await rm(first, { recursive: true });
    expect(await readFile(join(second, "alias"), "utf8")).toBe("same");
    expect(await readFile(join(second, "changed"), "utf8")).toBe("after!");
    await expect(snapshotToolStore(live, join(root, "bad"), { root: live, files: initial.files, sourceRoot: live, capturedAt: new Date(0).toISOString() })).rejects.toThrow("independent");
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
    expect((await snapshotToolStore(live, next, { root: old, files: [], sourceRoot: live, capturedAt: new Date(0).toISOString() })).linked).toBe(0);
    expect((await lstat(join(live, "nested/file"))).ino).not.toBe((await lstat(join(next, "nested/file"))).ino);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("incremental metadata reuse remains isolated and detects restored-timestamp edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-ab-snapshot-test-"));
  try {
    const live = join(root, "live"), first = join(root, "first"), second = join(root, "second");
    await mkdir(live);
    await writeFile(join(live, "large"), "unchanged payload");
    const initial = await snapshotToolStore(live, first);
    const capturedAt = new Date(Date.now() + 1_000).toISOString();
    const next = await snapshotToolStore(live, second, { root: first, files: initial.files, sourceRoot: live, capturedAt });
    expect(next.linked).toBe(1);
    expect(await verifySnapshotIdentities(second, next.files)).toBe(true);
    await rm(first, { recursive: true });
    expect(await verifySnapshotIdentities(second, next.files)).toBe(true);

    const before = await lstat(join(second, "large"));
    await writeFile(join(second, "large"), "modified payload!");
    await utimes(join(second, "large"), before.atime, before.mtime);
    expect(await verifySnapshotIdentities(second, next.files)).toBe(false);
    expect(await readFile(join(live, "large"), "utf8")).toBe("unchanged payload");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("legacy manifests cannot authorize corrupted base content", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-ab-snapshot-test-"));
  try {
    const live = join(root, "live"), first = join(root, "first"), second = join(root, "second");
    await mkdir(live);
    await writeFile(join(live, "tool"), "trusted");
    const initial = await snapshotToolStore(live, first);
    await writeFile(join(first, "tool"), "altered");
    const legacyFiles = initial.files.map(({ identity: _identity, ...file }) => file);
    const next = await snapshotToolStore(live, second, {
      root: first, files: legacyFiles, sourceRoot: live, capturedAt: new Date(Date.now() + 1_000).toISOString(),
    });
    expect(next.linked).toBe(0);
    expect(next.copied).toBe(1);
    expect(await readFile(join(second, "tool"), "utf8")).toBe("trusted");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a retained base remains reusable after its original live store is removed", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-ab-snapshot-test-"));
  try {
    const original = join(root, "original"), replacement = join(root, "replacement");
    const first = join(root, "first"), second = join(root, "second");
    await mkdir(original);
    await mkdir(replacement);
    await writeFile(join(original, "tool"), "payload");
    await writeFile(join(replacement, "tool"), "payload");
    const initial = await snapshotToolStore(original, first);
    await rm(original, { recursive: true });
    const next = await snapshotToolStore(replacement, second, {
      root: first, files: initial.files, sourceRoot: original, capturedAt: new Date().toISOString(),
    });
    expect(next.linked).toBe(1);
    expect(await readFile(join(second, "tool"), "utf8")).toBe("payload");
  } finally { await rm(root, { recursive: true, force: true }); }
});
