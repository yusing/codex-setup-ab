import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeSemanticCheck } from "./semantic";
import { qualifySemanticCheck } from "./semantic-qualification";
import { prepareTaskQualificationRun } from "./test-support/task-qualification";
import { remoteUninstallQualificationChecks } from "./test-support/remote-uninstall-qualification";

const enabled = process.env.CODEX_AB_LIVE_DOCKER === "1" && !!process.env.CODEX_AB_SKILLS_MGR_SOURCE;
test.skipIf(!enabled)("remote-uninstall pinned source observations and all controls execute without inference", async () => {
  const root = await mkdtemp(join(tmpdir(), "remote-uninstall-qualification-"));
  try {
    const state = await prepareTaskQualificationRun(join(import.meta.dir, "tasks/skills-mgr-remote-uninstall/manifest.json"),
      process.env.CODEX_AB_SKILLS_MGR_SOURCE!, root, process.env.CODEX_AB_LIVE_IMAGE ?? "codex-ab:0.1.0");
    const contract = state.criteria!.contract;
    const existing = await executeSemanticCheck({ runDir: root, state, candidate: join(root, "evaluator/stock"),
      output: join(root, "existing"), name: `codex-ab-uninstall-existing-${crypto.randomUUID()}`, docker: "docker",
      check: { criterion: "__existing_tests", files: [], command: ["true"], rationale: "Frozen actual selection and serving observations.",
        verification: contract.existing_test_verification } });
    expect(existing.status, JSON.stringify({ reasoning: existing.reasoning, execution: existing.execution })).toBe("pass");
    for (const check of remoteUninstallQualificationChecks(contract)) {
      const result = await qualifySemanticCheck({ runDir: root, state, output: join(root, check.criterion), check,
        controls: contract.evaluator_controls, docker: "docker", evaluatorModel: "model-free-fixture" });
      expect(result.status, JSON.stringify(result.results.map(item => ({ control: item.control, expected: item.expected,
        status: item.evidence.status, reasoning: item.evidence.reasoning, execution: item.evidence.execution })))).toBe("qualified");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 1_200_000);
