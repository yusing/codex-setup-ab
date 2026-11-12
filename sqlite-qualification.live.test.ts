import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeSemanticCheck } from "./semantic";
import { qualifySemanticCheck } from "./semantic-qualification";
import { checked } from "./process";
import { prepareTaskQualificationRun } from "./test-support/task-qualification";
import { sqliteQualificationChecks } from "./test-support/sqlite-qualification";

const source = process.env.CODEX_AB_SQLITE_UTILS_SOURCE;
const selectedCriteria = process.env.CODEX_AB_SQLITE_CRITERIA?.split(",");
const liveTest = process.env.CODEX_AB_LIVE_DOCKER === "1" && source ? test : test.skip;

liveTest("pinned sqlite-utils API, CLI and document observations qualify against targeted source controls offline", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-ab-sqlite-qualification-"));
  try {
    const image = (await checked(["docker", "image", "inspect", "--format", "{{.Id}}",
      process.env.CODEX_AB_VERIFIER_IMAGE ?? "codex-ab:sqlite-pack-qualification"])).stdout.trim();
    const state = await prepareTaskQualificationRun(join(import.meta.dir, "tasks/sqlite-utils-history/manifest.json"), source!, root, image);
    const contract = state.criteria!.contract;
    const reference = join(root, "evaluator/stock");
    const baseline = join(root, "baseline");
    await checked(["mkdir", baseline]);
    await checked(["tar", "-xf", join(root, "baseline.tar"), "-C", baseline]);
    const existing = { criterion: "existing-behavior", files: [], command: ["true"],
      rationale: "CRUD, atomic rollback, foreign-key transform protection, JSON/CSV/TSV input and CLI rows remain supported.",
      verification: contract.existing_test_verification };
    for (const [name, tree] of selectedCriteria ? [] : [["baseline", baseline], ["reference", reference]]) {
      const row = await executeSemanticCheck({ runDir: root, state, candidate: tree!, output: join(root, name!, "existing"),
        name: `sqlite-existing-${name}-${crypto.randomUUID()}`, check: existing, docker: "docker" });
      expect(row.execution?.verifier?.detail).toBe("Supervisor completed each required assertion.");
      expect(row.status).toBe("pass");
      expect(row.execution?.verifier).toMatchObject({ status: "passed", completed: 1, expected: 1 });
      expect(JSON.parse(row.execution!.verifier!.cases[0]!.stdout)).toEqual(JSON.parse(existing.verification!.cases[0]!.expected));
    }
    const checks = sqliteQualificationChecks(contract);
    if (selectedCriteria?.some(id => !checks.some(check => check.criterion === id))) throw new Error("Unknown sqlite-utils criterion filter");
    for (const check of checks.filter(check => !selectedCriteria || selectedCriteria.includes(check.criterion))) {
      const qualification = await qualifySemanticCheck({ runDir: root, output: join(root, "qualification", check.criterion),
        state, check, controls: contract.evaluator_controls, docker: "docker", evaluatorModel: "model-free-authored-checks" });
      const neighboringAlternatives = check.criterion === "comments-and-indexes" ? 3 : check.criterion === "tests-types-docs" ? 1 : 0;
      expect(qualification.results.map(row => [row.role, row.expected, row.evidence.status])).toEqual([
        ["reference", "pass", "pass"], ["baseline", "fail", "fail"], ["negative", "fail", "fail"], ["alternative", "pass", "pass"],
        ...Array.from({ length: neighboringAlternatives }, () => ["alternative", "pass", "pass"]),
      ]);
      expect(qualification.status).toBe("qualified");
      for (const row of qualification.results) {
        expect(row.evidence.execution?.verifier?.completed).toBe(1);
        expect(row.evidence.execution?.verifier?.status).not.toMatch(/wiring|setup|timeout|incomplete/);
        if (row.expected === "pass") expect(JSON.parse(row.evidence.execution!.verifier!.cases[0]!.stdout)).toEqual(JSON.parse(check.verification!.cases[0]!.expected));
      }
      const retained = JSON.parse(await readFile(join(root, "qualification", check.criterion, "qualification.json"), "utf8"));
      expect(retained.runtime_image).toBe(image);
      expect(retained.reference_commit).toBe("e4935e064407bc995f77795c025c33cef52d742e");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 480_000);
