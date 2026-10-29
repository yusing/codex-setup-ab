import { expect, test } from "bun:test";
import { mkdtemp, cp, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadTaskPack } from "./task-pack";

test("portable fixes pin evaluator references and allow relevant regression tests", async () => {
  for (const id of ["gin-context-copy", "flask-ipv6-server-name", "express-transfer-encoding", "nvm-download-no-eval"]) {
    const pack = await loadTaskPack(join(import.meta.dir, "tasks", id, "manifest.json"));
    expect(pack.manifest.id).toBe(id);
    expect(pack.manifest.source.base_commit).toHaveLength(40);
    expect(pack.contract.task_sha256).toHaveLength(64);
    expect(pack.manifest.source.reference_commit).toHaveLength(40);
    expect(pack.contract.allowed_paths).toBeUndefined();
    expect(pack.contract.evaluator_guidance).toContain("/reference");
    expect(Object.values(pack.snapshot.files).every(file => file.sha256.length === 64 && file.content.length > 0)).toBe(true);
    expect(Object.keys(pack.snapshot.files).sort()).toEqual(["manifest.json", "task.md"]);
  }
});

test("Mekugi coordination checkpoints pin a modern modular-workspace reference", async () => {
  const pack = await loadTaskPack(join(import.meta.dir, "tasks/session-retention/manifest.json"));
  expect(pack.manifest.id).toBe("session-retention");
  expect(pack.manifest.source).toEqual({
    repository: "https://github.com/yusing/mekugi.git",
    base_commit: "0368c3b3abf4da904caec63948646b2a579c0695",
    forbidden_commit: "495540d62e2e442f00455dc2c054de2d1f809505",
    reference_commit: "97ea72b7ea54c4d70a78554908f911061df16bc1",
  });
  expect(pack.contract.allowed_paths).toBeUndefined();
  expect(pack.contract.existing_tests).toContain("make test");
  expect(pack.contract.preparation).not.toContain("go generate");
  expect(pack.contract.evaluator_guidance).toContain("/reference");
  expect(pack.contract.qualification).toBe("not-run");
  expect(Object.keys(pack.snapshot.files).sort()).toEqual(["manifest.json", "task.md"]);
});

test("pack fingerprints change with task contents and reject escaping assets", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-ab-pack-"));
  try {
    const directory = join(root, "pack");
    await cp(join(import.meta.dir, "tasks/nvm-download-no-eval"), directory, { recursive: true });
    const manifestPath = join(directory, "manifest.json");
    const before = await loadTaskPack(manifestPath);
    await writeFile(join(directory, "task.md"), "Updated task\n");
    const after = await loadTaskPack(manifestPath);
    expect(before.snapshot.files["task.md"]!.sha256).not.toBe(after.snapshot.files["task.md"]!.sha256);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.prompt = "../outside";
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(loadTaskPack(manifestPath)).rejects.toThrow("unsafe");
    await writeFile(join(root, "outside"), "external");
    await symlink(join(root, "outside"), join(directory, "external"));
    manifest.prompt = "external";
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(loadTaskPack(manifestPath)).rejects.toThrow("escapes");
    manifest.prompt = "task.md";
    manifest.source.reference_commit = manifest.source.base_commit;
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(loadTaskPack(manifestPath)).rejects.toThrow("reference endpoint");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skills manager workflow pins its pre-install base and evaluator-only reference", async () => {
  const pack = await loadTaskPack(join(import.meta.dir, "tasks/skills-mgr-agent-cli/manifest.json"));
  expect(pack.manifest.id).toBe("skills-mgr-agent-cli");
  expect(pack.manifest.source).toEqual({
    repository: "https://github.com/yusing/skills-mgr.git",
    base_commit: "9ae7009faa837921ef6ed28e7b78f02a8e2f964e",
    forbidden_commit: "49b3594ad30bcfc0a869758fe79ef0dfa9b92087",
    reference_commit: "4d73a988979b7b9c8f0135b5bc9b9c6976aab7c0",
  });
  expect(pack.contract.qualification).toBe("not-run");
  expect(pack.contract.allowed_paths).toBeUndefined();
  expect(Object.keys(pack.snapshot.files).sort()).toEqual(["manifest.json", "task.md"]);
  expect(pack.contract.criteria.map(criterion => criterion.id)).toEqual([
    "repository-install", "remote-recovery", "diagnostics", "content-checks",
    "layered-selection", "safe-edits", "refresh-backoff", "compatibility-tests-docs",
  ]);
});

test("checked-in standalone criteria bind their task prompts", async () => {
  const { createHash } = await import("node:crypto");
  const { validateCriteria } = await import("./semantic");
  for (const directory of ["tasks/skills-mgr-bundle"]) {
    const task = await readFile(join(import.meta.dir, directory, "task.md"));
    const criteria = JSON.parse(await readFile(join(import.meta.dir, directory, "criteria.json"), "utf8"));
    expect(validateCriteria(criteria, createHash("sha256").update(task).digest("hex")).criteria.length).toBeGreaterThan(0);
  }
});

test("sqlite-utils upgrade pins the pre-upgrade base and excludes its first solution commit", async () => {
  const pack = await loadTaskPack(join(import.meta.dir, "tasks/sqlite-utils-history/manifest.json"));
  expect(pack.manifest.source).toEqual({
    repository: "https://github.com/simonw/sqlite-utils.git",
    base_commit: "6a456830ca33eb5edaa634a9b0febe5d71bea2be",
    forbidden_commit: "f726ea4a65c3ce9eaff67057908ee8f2fe7f81e0",
    reference_commit: "e4935e064407bc995f77795c025c33cef52d742e",
  });
  expect(pack.contract.qualification).toBe("not-run");
  expect(pack.contract.allowed_paths).toBeUndefined();
  expect(pack.contract.existing_tests).toBe("PYTHONPATH=. PYTHONDONTWRITEBYTECODE=1 /opt/task-deps/python/bin/python -m pytest -p no:cacheprovider -q");
  expect(pack.contract.criteria.map(criterion => criterion.id)).toEqual([
    "views-and-transactions", "checks-and-parser", "check-transforms", "comments-and-indexes",
    "autoincrement-and-unique", "any-types-and-cli", "numeric-transforms", "input-query-identifiers",
    "tests-types-docs", "integrated-upgrade",
  ]);
});
