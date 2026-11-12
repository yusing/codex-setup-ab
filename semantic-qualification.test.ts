import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { qualifySemanticCheck, validateEvaluatorControls, type EvaluatorControls } from "./semantic-qualification";
import * as semantic from "./semantic";
import { checked } from "./process";
import type { RunState } from "./types";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const source = (value: number) => `VALUE = ${value}\n`;
const patch = (value: number) => ({ path: "impl.py", before_sha256: hash(source(1)), after_sha256: hash(source(value)),
  diff: `diff --git a/impl.py b/impl.py\n--- a/impl.py\n+++ b/impl.py\n@@ -1 +1 @@\n-VALUE = 1\n+VALUE = ${value}\n` });

test("precise frozen controls materialize the pinned source and reject mismatched preimages and postimages", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-ab-control-patches-"));
  const seen: string[] = [];
  const execute = spyOn(semantic, "executeSemanticCheck").mockImplementation(async options => {
    const text = await readFile(join(options.candidate, "impl.py"), "utf8");
    seen.push(text);
    return { criterion: "fixture", status: [source(2), source(3)].includes(text) ? "pass" : "fail", basis: "executed", reasoning: "Materialization-only unit fixture." };
  });
  try {
    const repository = join(root, "source"); await mkdir(repository);
    await checked(["git", "-C", repository, "init", "--initial-branch=work"]);
    await checked(["git", "-C", repository, "config", "user.name", "Fixture"]);
    await checked(["git", "-C", repository, "config", "user.email", "fixture@example.invalid"]);
    await writeFile(join(repository, "impl.py"), source(1));
    await checked(["git", "-C", repository, "add", "."]);
    await checked(["git", "-C", repository, "commit", "-m", "baseline"]);
    const commit = (await checked(["git", "-C", repository, "rev-parse", "HEAD"])).stdout.trim();
    await checked(["git", "clone", "--bare", repository, join(root, "seed.git")]);
    const controls: EvaluatorControls = { schema: "codex-ab.evaluator-controls.v1", cases: [
      { id: "reference", role: "reference", base: "baseline", files: [], patches: [patch(2)], expected: { fixture: "pass" } },
      { id: "baseline", role: "baseline", base: "baseline", files: [], expected: { fixture: "fail" } },
      { id: "negative", role: "negative", base: "baseline", files: [], patches: [patch(0)], expected: { fixture: "fail" } },
      { id: "alternative", role: "alternative", base: "baseline", files: [], patches: [patch(3)], expected: { fixture: "pass" } },
    ] };
    const state = { source: { base_commit: commit }, task: { sha256: hash("task") }, image: "fixture",
      criteria: { contract: { criteria: [{ id: "fixture" }] } } } as RunState;
    const options = { runDir: root, state, check: { criterion: "fixture", files: [], command: ["true"], rationale: "Materialization fixture." },
      docker: "unused", evaluatorModel: "unused", controls, output: join(root, "qualification") };
    expect((await qualifySemanticCheck(options)).status).toBe("qualified");
    expect(seen).toEqual([source(2), source(1), source(0), source(3)]);
    for (const field of ["before_sha256", "after_sha256"] as const) {
      seen.length = 0;
      const broken = structuredClone(controls); broken.cases[0]!.patches![0]![field] = "f".repeat(64);
      await expect(qualifySemanticCheck({ ...options, controls: broken, output: join(root, field) })).rejects.toThrow(field === "before_sha256" ? "preimage" : "postimage");
      expect(seen).toHaveLength(0);
    }
  } finally { execute.mockRestore(); await rm(root, { recursive: true, force: true }); }
});

test("control patches reject path escapes, additional files, mode changes, malformed hashes and overwrite aliases", () => {
  const fixture = () => ({ schema: "codex-ab.evaluator-controls.v1", cases: [
    { id: "negative", role: "negative", base: "baseline", files: [], patches: [patch(0)], expected: { fixture: "fail" } },
  ] }) as EvaluatorControls;
  expect(validateEvaluatorControls(fixture(), ["fixture"]).cases).toHaveLength(1);
  for (const damage of ["escape", "second-file", "mode", "hash", "duplicate", "file-overwrite"] as const) {
    const controls = fixture(), p = controls.cases[0]!.patches![0]!;
    if (damage === "escape") p.path = "../outside";
    if (damage === "second-file") p.diff += "diff --git a/other b/other\n--- a/other\n+++ b/other\n@@ -1 +1 @@\n-old\n+new\n";
    if (damage === "mode") p.diff += "new mode 120000\n";
    if (damage === "hash") p.after_sha256 = "unknown";
    if (damage === "duplicate") controls.cases[0]!.patches!.push(structuredClone(p));
    if (damage === "file-overwrite") controls.cases[0]!.files.push({ path: "impl.py", source: "overwritten" });
    expect(() => validateEvaluatorControls(controls, ["fixture"])).toThrow();
  }
});
