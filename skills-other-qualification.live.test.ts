import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { checked, exec } from "./process";
import { loadTaskPack } from "./task-pack";
import { executeSemanticCheck, validateCriteria, type CriteriaContract } from "./semantic";
import { qualifySemanticCheck } from "./semantic-qualification";
import { prepareTaskQualificationRun } from "./test-support/task-qualification";
import { skillsGetQualificationChecks, skillsBundleQualificationChecks } from "./test-support/skills-other-qualification";
import type { RunState } from "./types";

const source = process.env.CODEX_AB_SKILLS_MGR_SOURCE;
const live = process.env.CODEX_AB_LIVE_DOCKER === "1" && source ? test : test.skip;
const imageName = process.env.CODEX_AB_SKILLS_VERIFIER_IMAGE ?? "codex-ab:skills-mgr-migration-offline";

async function exercise(root: string, state: RunState, checks: ReturnType<typeof skillsBundleQualificationChecks>) {
  const candidate = join(root, state.arms.stock!.repository);
  await writeFile(join(candidate, "json.py"), 'raise RuntimeError("candidate-root json.py must not be imported by evaluator wiring")\n');
  const sentinelPath = join(candidate, "ab_frozen_observation_test.go");
  const sentinel = "package main\nconst candidateOwnedObservationSentinel = true\n";
  await writeFile(sentinelPath, sentinel);
  const contract = state.criteria!.contract;
  const existingCheck = { criterion: "__existing_tests", files: [], command: ["go", "test", ".", "-count=1"], rationale: "Frozen retained get/run/range/list and nested evidence observations, not suite completion.", verification: contract.existing_test_verification };
  const existing = await executeSemanticCheck({ runDir: root, state, candidate, output: join(root, "existing"), name: `ab-skills-existing-${crypto.randomUUID()}`,
    check: existingCheck, docker: "docker" });
  expect(existing.status).toBe("pass");
  expect(existing.execution?.verifier?.completed).toBe(1);
  // This existing candidate file must remain in the compiled package. A fixed-name
  // overlay or direct replacement would hide its type error and incorrectly pass.
  await writeFile(sentinelPath, 'package main\nconst candidateOwnedObservationSentinel int = "must remain compiled"\n');
  const collision = await executeSemanticCheck({ runDir: root, state, candidate, output: join(root, "owned-file-collision"), name: `ab-skills-collision-${crypto.randomUUID()}`,
    check: existingCheck, docker: "docker" });
  expect(collision.status).toBe("fail");
  expect(collision.execution?.verifier?.cases[0]?.stderr).toContain("ab_frozen_observation_test.go");
  await writeFile(sentinelPath, sentinel);
  for (const check of checks) {
    const evidence = await executeSemanticCheck({ runDir: root, state, candidate, output: join(root, check.criterion, "candidate"), name: `ab-skills-${crypto.randomUUID()}`, check, docker: "docker" });
    expect({ criterion: check.criterion, status: evidence.status, detail: evidence.execution?.verifier?.detail,
      observed: evidence.execution?.verifier?.cases.map(item => ({ stdout: item.stdout.slice(0, 2500), stderr: item.stderr.slice(0, 1500) })) }).toMatchObject({ criterion: check.criterion, status: "pass" });
    const qualification = await qualifySemanticCheck({ runDir: root, state, output: join(root, check.criterion, "qualification"),
      check, controls: contract.evaluator_controls, docker: "docker", evaluatorModel: "model-free-authored-checks" });
    expect({ criterion: check.criterion, status: qualification.status, controls: qualification.results.map(result => ({
      id: result.control, expected: result.expected, actual: result.evidence.status, detail: result.evidence.execution?.verifier?.detail,
      observed: result.evidence.execution?.verifier?.cases.map(item => ({ stdout: item.stdout.slice(0, 2500), stderr: item.stderr.slice(0, 1500) })),
    })) }).toMatchObject({ criterion: check.criterion, status: "qualified" });
    for (const result of qualification.results) {
      expect(result.matched).toBe(true);
      expect(result.evidence.execution?.verifier?.completed).toBe(1);
    }
    expect(qualification.results.map(result => result.role)).toEqual(["reference", "baseline", "negative", "alternative"]);
  }
}

test("frozen skills Python observers cannot accept forged observations from a candidate-root json.py", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-ab-skills-shadow-"));
  try {
    const get = await loadTaskPack(join(import.meta.dir, "tasks/skills-mgr-get-short-circuit/manifest.json"));
    const bundle: CriteriaContract = JSON.parse(await readFile(join(import.meta.dir, "tasks/skills-mgr-bundle/criteria.json"), "utf8"));
    const observations = [get.contract.existing_test_verification!.cases[0]!, bundle.existing_test_verification!.cases[0]!,
      ...skillsGetQualificationChecks(get.contract).flatMap(check => check.verification!.cases),
      ...skillsBundleQualificationChecks().flatMap(check => check.verification!.cases)];
    for (const observation of observations) {
      if (observation.kind !== "command") throw new Error("expected command observer");
      await writeFile(join(root, "json.py"), `import sys\nsys.stdout.write(${JSON.stringify(observation.expected + "\n")})\nsys.exit(0)\n`);
      const result = await exec([...observation.command, ...(observation.args ?? [])], { cwd: root, env: { PYTHONPATH: root } });
      expect({ case: observation.id, forged: result.exitCode === 0 && result.stdout.trim() === observation.expected }).toEqual({ case: observation.id, forged: false });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("both frozen existing observers preserve a candidate-owned fixed-name Go file", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-ab-skills-owned-file-"));
  try {
    const get = await loadTaskPack(join(import.meta.dir, "tasks/skills-mgr-get-short-circuit/manifest.json"));
    const bundle: CriteriaContract = JSON.parse(await readFile(join(import.meta.dir, "tasks/skills-mgr-bundle/criteria.json"), "utf8"));
    const sentinel = "package main\nconst candidateOwnedSentinel = true\n";
    const path = join(root, "ab_frozen_observation_test.go");
    for (const contract of [get.contract, bundle]) {
      await writeFile(path, sentinel);
      const observation = contract.existing_test_verification!.cases[0]!;
      if (observation.kind !== "command") throw new Error("expected command observer");
      await exec([...observation.command, ...(observation.args ?? [])], { cwd: root });
      expect(await readFile(path, "utf8")).toBe(sentinel);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

live("pinned fast-acquisition task observes real behavior and qualifies every frozen control", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-ab-skills-get-qualification-"));
  try {
    const image = (await checked(["docker", "image", "inspect", "--format", "{{.Id}}", imageName])).stdout.trim();
    const state = await prepareTaskQualificationRun(join(import.meta.dir, "tasks/skills-mgr-get-short-circuit/manifest.json"), source!, root, image);
    await exercise(root, state, skillsGetQualificationChecks(state.criteria!.contract));
  } finally { await rm(root, { recursive: true, force: true }); }
}, 900_000);

live("standalone bundle task qualifies explicitly authored local controls without inventing an upstream reference", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-ab-skills-bundle-qualification-"));
  try {
    const base = "f16d629d7acafaa57ddc94a9a295f5040eb2c8df";
    const task = await readFile(join(import.meta.dir, "tasks/skills-mgr-bundle/task.md"), "utf8");
    const criteria: unknown = JSON.parse(await readFile(join(import.meta.dir, "tasks/skills-mgr-bundle/criteria.json"), "utf8"));
    const contract: CriteriaContract = validateCriteria(criteria, createHash("sha256").update(task).digest("hex"));
    const image = (await checked(["docker", "image", "inspect", "--format", "{{.Id}}", imageName])).stdout.trim();
    const candidate = join(root, "candidate"); await mkdir(candidate);
    await checked(["git", "-C", source!, "archive", "--format=tar", "-o", join(root, "baseline.tar"), base]);
    await checked(["git", "clone", "--bare", "--no-hardlinks", source!, join(root, "seed.git")]);
    await checked(["tar", "-xf", join(root, "baseline.tar"), "-C", candidate]);
    const reference = contract.evaluator_controls!.cases.find(control => control.role === "reference")!;
    for (const file of reference.files) if (file.source !== null) await writeFile(join(candidate, file.path), file.source);
    const state = { schema_version: 1, id: `bundle-qualification-${process.pid}`, profile: "task", source: { path: source!, base_commit: base,
      forbidden_commit: "0".repeat(40), base_tree: (await checked(["git", "-C", source!, "rev-parse", `${base}^{tree}`])).stdout.trim(), source_timestamp: 0 },
      task: { path: "task.md", sha256: contract.task_sha256 }, criteria: { path: "criteria.json", sha256: "fixture", contract },
      image, image_id: image, timeout_seconds: 180, resource_limits: { cpus: "2", memory: "2g" },
      execution: { model: "model-free-fixture", reasoning_effort: "high" }, operator: { uid: process.getuid!(), gid: process.getgid!() },
      arms: { stock: { repository: "candidate", home_template: "unused" } },
    } as RunState;
    expect(state.upstream_reference).toBeUndefined();
    await exercise(root, state, skillsBundleQualificationChecks());
  } finally { await rm(root, { recursive: true, force: true }); }
}, 900_000);
