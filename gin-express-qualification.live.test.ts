import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checked } from "./process";
import { sha256 } from "./state";
import { executeSemanticCheck, prepareEvaluatorCache } from "./semantic";
import { qualifySemanticCheck } from "./semantic-qualification";
import { ginExpressQualificationChecks, prepareGinExpressQualificationRun } from "./test-support/gin-express-qualification";

for (const [id, source] of [
  ["gin-context-copy", process.env.CODEX_AB_GIN_SOURCE],
  ["express-transfer-encoding", process.env.CODEX_AB_EXPRESS_SOURCE],
] as const) {
  const live = process.env.CODEX_AB_LIVE_DOCKER === "1" && source ? test : test.skip;
  live(`${id}: actual frozen observations and all source controls qualify offline without inference`, async () => {
    const root = await mkdtemp(join(tmpdir(), `codex-ab-${id}-qualification-`));
    try {
      const image = (await checked(["docker", "image", "inspect", "--format", "{{.Id}}",
        process.env.CODEX_AB_VERIFIER_IMAGE ?? "codex-ab:0.1.0"])).stdout.trim();
      const state = await prepareGinExpressQualificationRun(id, source!, root, image);
      await prepareEvaluatorCache(root, state, "docker");
      const candidate = join(root, "evaluator/stock");
      await checked(["git", "-C", candidate, "apply", "--binary", join(root, "evaluator/upstream/changes.patch")]);
      const contract = state.criteria!.contract;
      // Reference-only adapters retain baseline dependencies where ancestry upgrades are out of scope.
      const reference = contract.evaluator_controls!.cases.find(control => control.role === "reference")!;
      for (const [index, patch] of (reference.patches ?? []).entries()) {
        expect(await sha256(join(candidate, patch.path))).toBe(patch.before_sha256);
        const path = join(root, `reference-adapter-${index}.patch`);
        await writeFile(path, patch.diff);
        await checked(["git", "-C", candidate, "apply", path]);
        expect(await sha256(join(candidate, patch.path))).toBe(patch.after_sha256);
      }
      // A candidate may legitimately own the former observer name and test symbol.
      const sentinels = id === "gin-context-copy" ? [
        ["zz_frozen_context_observer_test.go", `package gin
import "testing"
const frozenCandidateFileSentinel = "candidate-owned-file"
func TestFrozenContextObservation(t *testing.T) { t.Fatal("candidate-owned test must not be selected by the observer") }
`],
        ["zz_frozen_context_observer_dependency_test.go", "package gin\nvar _ = frozenCandidateFileSentinel\n"],
      ] as const : [];
      for (const [path, content] of sentinels) await writeFile(join(candidate, path), content);
      const checks = ginExpressQualificationChecks(id, contract);
      for (const check of checks) {
        const actual = await executeSemanticCheck({ runDir: root, state, candidate, output: join(root, check.criterion, "candidate"),
          name: `codex-ab-${id}-${crypto.randomUUID()}`, check, docker: "docker" });
        expect(actual.status, JSON.stringify(actual.execution)).toBe("pass");
        // Passing supervisor fingerprints also establish that its copied workspace was preserved.
        for (const [path, content] of sentinels) expect(await readFile(join(candidate, path), "utf8")).toBe(content);
        const qualification = await qualifySemanticCheck({ runDir: root, state, check, controls: contract.evaluator_controls,
          output: join(root, check.criterion, "qualification"), docker: "docker", evaluatorModel: "model-free-authored-checks" });
        expect(qualification.status, JSON.stringify(qualification.results.filter(row => !row.matched).map(row => ({ control: row.control,
          expected: row.expected, actual: row.evidence.status, execution: row.evidence.execution })))).toBe("qualified");
        expect(qualification.results.map(row => [row.role, row.expected, row.evidence.status])).toEqual([
          ["reference", "pass", "pass"], ["baseline", check === checks[0] ? "fail" : "pass", check === checks[0] ? "fail" : "pass"],
          ["negative", "fail", "fail"], ["alternative", "pass", "pass"],
        ]);
        for (const result of qualification.results) {
          expect(result.evidence.execution!.verifier!.completed).toBe(1);
        }
      }
      const diagnostic = await executeSemanticCheck({ runDir: root, state, candidate, output: join(root, "original-tests"),
        name: `codex-ab-${id}-original-${crypto.randomUUID()}`, docker: "docker", check: { criterion: "original-test-command",
          files: [], command: ["sh", "-lc", contract.existing_tests], rationale: "Original upstream tests are non-gating diagnostics, not independent completion assertions." } });
      expect(diagnostic.execution!.exit_code, diagnostic.execution!.stderr).toBe(0);
      expect(diagnostic.status).toBe("unassessed");
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 900_000);
}
