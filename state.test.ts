import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sha256 } from "./state";

test("hash cache detects same-size edits, replaced inodes and changed symlink targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-ab-hash-test-"));
  try {
    const path = join(root, "file");
    await writeFile(path, "before");
    const first = await sha256(path);
    expect(await sha256(path)).toBe(first);
    await writeFile(path, "after!");
    await utimes(path, new Date(0), new Date(0));
    const second = await sha256(path);
    expect(second).not.toBe(first);
    const replacement = join(root, "replacement");
    await writeFile(replacement, "third!");
    await rename(replacement, path);
    expect(await sha256(path)).not.toBe(second);
    const alias = join(root, "alias");
    await symlink(path, alias);
    expect(await sha256(alias)).toBe(await sha256(path));
    await writeFile(path, "fourth");
    expect(await sha256(alias)).toBe(await sha256(path));
    await chmod(path, 0o755);
    const expected = new Bun.CryptoHasher("sha256").update(await readFile(path)).digest("hex");
    expect(await sha256(path)).toBe(expected);
  } finally { await rm(root, { recursive: true, force: true }); }
});

