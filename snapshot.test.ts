import { expect, test } from "bun:test";
import { chmod, cp, lstat, mkdir, mkdtemp, readlink, rm, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordToolStore, verifySnapshotIdentities } from "./snapshot";

async function createStore(root: string): Promise<string> {
  const store = join(root, "store");
  await mkdir(join(store, "nested"), { recursive: true });
  await writeFile(join(store, "z-tool"), "z payload");
  await writeFile(join(store, "nested", "a-tool"), "a payload");
  await chmod(join(store, "z-tool"), 0o644);
  await symlink("nested/a-tool", join(store, "alias"));
  return store;
}

async function withTemporaryRoot<T>(prefix: string, callback: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("records sorted metadata without creating a destination or hashing payloads", async () => {
  await withTemporaryRoot("codex-ab-snapshot-record-", async root => {
    const store = await createStore(root);
    const destination = join(root, "destination-must-not-exist");

    const files = await recordToolStore(store);
    expect(files.map(file => file.path)).toEqual(["alias", "nested/a-tool", "z-tool"]);
    expect(files.find(file => file.path === "alias")).toMatchObject({
      type: "symlink",
      target: "nested/a-tool",
    });

    const recorded = files.find(file => file.path === "nested/a-tool");
    expect(recorded).toMatchObject({ type: "file", identity: expect.any(Object) });
    expect(recorded?.sha256).toBeUndefined();
    const actual = await lstat(join(store, "nested/a-tool"), { bigint: true });
    expect(recorded?.identity).toEqual({
      dev: String(actual.dev),
      ino: String(actual.ino),
      size: String(actual.size),
      mode: String(actual.mode),
      mtime_ns: String(actual.mtimeNs),
      ctime_ns: String(actual.ctimeNs),
    });
    expect(await Bun.file(destination).exists()).toBe(false);
  });
});

test("records a sparse large regular file without a payload hash", async () => {
  await withTemporaryRoot("codex-ab-snapshot-sparse-", async root => {
    const store = join(root, "store");
    const sparse = join(store, "sparse-tool");
    const sparseSize = 8 * 1024 * 1024 * 1024;
    await mkdir(store);
    await writeFile(sparse, "");
    await truncate(sparse, sparseSize);

    const [recorded] = await recordToolStore(store);
    expect(recorded).toMatchObject({ path: "sparse-tool", type: "file" });
    expect(recorded?.sha256).toBeUndefined();
    expect(recorded?.identity?.size).toBe(String(sparseSize));
  });
});

test("unchanged metadata verifies and same-size rewrites remain rejected after restoring mtime", async () => {
  await withTemporaryRoot("codex-ab-snapshot-verify-", async root => {
    const store = await createStore(root);
    const tool = join(store, "z-tool");
    const restoredMtime = new Date("2000-01-01T00:00:00.000Z");
    await utimes(tool, restoredMtime, restoredMtime);

    const files = await recordToolStore(store);
    expect(await verifySnapshotIdentities(store, files)).toBe(true);

    const recorded = files.find(file => file.path === "z-tool");
    expect(recorded?.sha256).toBeUndefined();
    // Some host filesystems expose millisecond-granularity change times.
    await Bun.sleep(20);
    await writeFile(tool, "x payload");
    await utimes(tool, restoredMtime, restoredMtime);

    const actual = await lstat(tool, { bigint: true });
    expect(String(actual.mtimeNs)).toBe(recorded?.identity?.mtime_ns);
    expect(String(actual.ctimeNs)).not.toBe(recorded?.identity?.ctime_ns);
    expect(await verifySnapshotIdentities(store, files)).toBe(false);
  });
});

test("verification rejects additions, deletions, mode changes, and changed symlink literals", async () => {
  await withTemporaryRoot("codex-ab-snapshot-addition-", async root => {
    const store = await createStore(root);
    const files = await recordToolStore(store);
    await writeFile(join(store, "added"), "new");
    expect(await verifySnapshotIdentities(store, files)).toBe(false);
  });

  await withTemporaryRoot("codex-ab-snapshot-deletion-", async root => {
    const store = await createStore(root);
    const files = await recordToolStore(store);
    await rm(join(store, "z-tool"));
    expect(await verifySnapshotIdentities(store, files)).toBe(false);
  });

  await withTemporaryRoot("codex-ab-snapshot-mode-", async root => {
    const store = await createStore(root);
    const files = await recordToolStore(store);
    await chmod(join(store, "z-tool"), 0o755);
    expect(await verifySnapshotIdentities(store, files)).toBe(false);
  });

  await withTemporaryRoot("codex-ab-snapshot-symlink-", async root => {
    const store = await createStore(root);
    const files = await recordToolStore(store);
    await rm(join(store, "alias"));
    await symlink("z-tool", join(store, "alias"));
    expect(await verifySnapshotIdentities(store, files)).toBe(false);
    expect(await readlink(join(store, "alias"))).toBe("z-tool");
  });
});

test("rejects copied regular-file stores even when symlink literals are preserved", async () => {
  await withTemporaryRoot("codex-ab-snapshot-copy-", async root => {
    const store = await createStore(root);
    const copy = join(root, "copy");
    const files = await recordToolStore(store);
    await cp(store, copy, { recursive: true, verbatimSymlinks: true });

    expect(await verifySnapshotIdentities(store, files)).toBe(true);
    expect(await verifySnapshotIdentities(copy, files)).toBe(false);
    expect(await readlink(join(copy, "alias"))).toBe("nested/a-tool");
  });
});

test("rejects unsupported tool-store entries", async () => {
  await withTemporaryRoot("codex-ab-snapshot-entry-", async root => {
    const store = join(root, "store");
    await mkdir(store);
    const pipe = join(store, "unsupported");
    const result = Bun.spawnSync(["mkfifo", pipe]);
    expect(result.exitCode).toBe(0);
    await expect(recordToolStore(store)).rejects.toThrow("unsupported tool-store entry");
  });
});
