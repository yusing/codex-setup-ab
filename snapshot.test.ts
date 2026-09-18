import { expect, test } from "bun:test";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordToolStore, verifySnapshotIdentities } from "./snapshot";

test("records a sorted manifest without creating a destination", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-ab-snapshot-record-"));
  try {
    const store = join(root, "store");
    const destination = join(root, "destination-must-not-exist");
    await mkdir(join(store, "nested"), { recursive: true });
    await writeFile(join(store, "z-tool"), "z payload");
    await writeFile(join(store, "nested", "a-tool"), "a payload");
    await chmod(join(store, "z-tool"), 0o644);
    await symlink("nested/a-tool", join(store, "alias"));

    const files = await recordToolStore(store);
    expect(files.map(file => file.path)).toEqual(["alias", "nested/a-tool", "z-tool"]);
    expect(files.find(file => file.path === "alias")).toMatchObject({
      type: "symlink",
      target: "nested/a-tool",
    });
    const recorded = files.find(file => file.path === "nested/a-tool");
    expect(recorded).toMatchObject({ type: "file" });
    expect(recorded?.sha256).toBe(
      new Bun.CryptoHasher("sha256").update(await readFile(join(store, "nested/a-tool"))).digest("hex"),
    );
    const actual = await lstat(join(store, "nested/a-tool"), { bigint: true });
    expect(recorded?.identity?.ino).toBe(String(actual.ino));
    expect(recorded?.identity?.mode).toBe(String(actual.mode));
    expect(await Bun.file(destination).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verification detects content, additions, deletions, modes, and literal symlink changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-ab-snapshot-verify-"));
  try {
    const store = join(root, "store");
    await mkdir(store);
    await writeFile(join(store, "tool"), "payload");
    await chmod(join(store, "tool"), 0o644);
    await symlink("tool", join(store, "alias"));
    const files = await recordToolStore(store);

    expect(await verifySnapshotIdentities(store, files)).toBe(true);

    await writeFile(join(store, "tool"), "changed payload");
    expect(await verifySnapshotIdentities(store, files)).toBe(false);
    await writeFile(join(store, "tool"), "payload");
    expect(await verifySnapshotIdentities(store, files)).toBe(true);

    await chmod(join(store, "tool"), 0o755);
    expect(await verifySnapshotIdentities(store, files)).toBe(false);
    await chmod(join(store, "tool"), 0o644);
    expect(await verifySnapshotIdentities(store, files)).toBe(true);

    await writeFile(join(store, "added"), "new");
    expect(await verifySnapshotIdentities(store, files)).toBe(false);
    await rm(join(store, "added"));
    expect(await verifySnapshotIdentities(store, files)).toBe(true);

    await rm(join(store, "tool"));
    expect(await verifySnapshotIdentities(store, files)).toBe(false);
    await writeFile(join(store, "tool"), "payload");
    await chmod(join(store, "tool"), 0o644);
    expect(await verifySnapshotIdentities(store, files)).toBe(true);

    await rm(join(store, "alias"));
    await symlink("missing", join(store, "alias"));
    expect(await verifySnapshotIdentities(store, files)).toBe(false);
    await rm(join(store, "alias"));
    await symlink("tool", join(store, "alias"));
    expect(await verifySnapshotIdentities(store, files)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verification accepts copied files and symlinks with the recorded literals", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-ab-snapshot-copy-"));
  try {
    const store = join(root, "store");
    const copy = join(root, "copy");
    await mkdir(store);
    await writeFile(join(store, "tool"), "trusted");
    await symlink("./tool", join(store, "alias"));
    const files = await recordToolStore(store);

    await cp(store, copy, { recursive: true, verbatimSymlinks: true });
    expect(await verifySnapshotIdentities(copy, files)).toBe(true);

    await writeFile(join(copy, "tool"), "altered");
    expect(await verifySnapshotIdentities(copy, files)).toBe(false);
    await writeFile(join(copy, "tool"), "trusted");
    expect(await verifySnapshotIdentities(copy, files)).toBe(true);

    await rm(join(copy, "alias"));
    await symlink("other", join(copy, "alias"));
    expect(await verifySnapshotIdentities(copy, files)).toBe(false);
    expect(await readlink(join(copy, "alias"))).toBe("other");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects unsupported tool-store entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-ab-snapshot-entry-"));
  try {
    const store = join(root, "store");
    await mkdir(store);
    const pipe = join(store, "unsupported");
    const result = Bun.spawnSync(["mkfifo", pipe]);
    expect(result.exitCode).toBe(0);
    await expect(recordToolStore(store)).rejects.toThrow("unsupported tool-store entry");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
