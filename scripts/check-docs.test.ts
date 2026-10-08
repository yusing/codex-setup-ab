import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { documentPathErrors } from "./check-docs";

test("documentation paths resolve links locally and command assets from the repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-ab-docs-test-"));
  try {
    await mkdir(join(root, "doc"));
    await mkdir(join(root, "tasks/example"), { recursive: true });
    await writeFile(join(root, "README.md"), "[Guide](doc/guide.md#usage)\n[External](https://example.com/missing)\n[Section](#usage)\n");
    await writeFile(join(root, "AGENTS.md"), "[Development](README.md#development)\n");
    await writeFile(join(root, "tasks/example/task.md"), "Task\n");
    await mkdir(join(root, "doc/tasks"));
    await writeFile(join(root, "doc/tasks/with spaces.md"), "Nested document\n");
    await writeFile(join(root, "doc/guide.md"), "[Task](../tasks/example/task.md)\n[Nested](<tasks/with spaces.md>)\n`tasks/example/task.md`\n`tasks/*/task.md`\n");
    expect(await documentPathErrors(root)).toEqual([]);
    await writeFile(join(root, "doc/guide.md"), "[Missing](missing.md)\n```sh\n--review-treatment treatments/removed\n```\n");
    expect(await documentPathErrors(root)).toEqual([
      `doc/guide.md: missing repository path ${join(root, "doc/missing.md")}`,
      `doc/guide.md: missing repository path ${join(root, "treatments/removed")}`,
    ]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
