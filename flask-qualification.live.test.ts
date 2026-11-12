import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareSemanticAssessment, validateCriterionAssessments } from "./semantic-assessment";
import { verifiedCriterionEvidence } from "./behavioral-evidence";
import { checked } from "./process";
import { flaskQualificationChecks, prepareFlaskQualificationRun } from "./test-support/flask-qualification";

const source = process.env.CODEX_AB_FLASK_SOURCE;
const liveTest = process.env.CODEX_AB_LIVE_DOCKER === "1" && source ? test : test.skip;

liveTest("actual Flask task qualifies reference, baseline, negative source mutation, and independent parser through the offline semantic runner", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-ab-flask-qualification-"));
  try {
    const image = (await checked(["docker", "image", "inspect", "--format", "{{.Id}}", process.env.CODEX_AB_VERIFIER_IMAGE ?? "codex-ab:model-free"])).stdout.trim();
    const state = await prepareFlaskQualificationRun(source!, root, image);
    for (const cache of ["grader-go-pkg-cache", "grader-bun-cache"]) {
      const directory = await stat(join(root, "arms/stock", cache));
      expect(directory.isDirectory()).toBe(true);
      expect(directory.uid).toBe(process.getuid!());
    }
    const checks = flaskQualificationChecks(state.criteria!.contract);
    const stages: string[] = [];
    const evidence = await prepareSemanticAssessment({ runDir: root, state, contract: state.criteria!.contract,
      pass: 1, order: ["stock"], docker: "docker", evaluatorModel: "model-free-authored-checks",
      ask: async stage => { stages.push(stage); return { "candidate-1": checks }; } });
    expect(stages).toEqual(["harness-1"]);
    expect(evidence.existing_tests["candidate-1"].status).toBe("pass");
    expect(evidence.existing_tests["candidate-1"].execution!.verifier).toMatchObject({ status: "passed", completed: 1, expected: 1 });
    expect(evidence.existing_test_commands!["candidate-1"]!.execution!.exit_code).toBe(0);
    expect(evidence.existing_test_commands!["candidate-1"]!.status).toBe("unassessed");
    expect(evidence.existing_test_commands!["candidate-1"]!.execution!.stdout).toContain("10 passed");
    for (const row of evidence.candidates["candidate-1"]!) {
      expect(row.status).toBe("pass");
      expect(row.qualification?.status).toBe("qualified");
      expect(row.qualification?.results.map(control => [control.control, control.expected, control.evidence.status])).toEqual([
        ["upstream-reference", "pass", "pass"],
        ["pinned-baseline", row.criterion === "ipv6-server-name" ? "fail" : "pass", row.criterion === "ipv6-server-name" ? "fail" : "pass"],
        ["ipv6-and-zero-regression", "fail", "fail"],
        ["independent-bracket-parser", "pass", "pass"],
      ]);
      expect(verifiedCriterionEvidence(row, state)).toMatchObject({ behavior: "pass", evaluation_validity: "valid" });
      for (const control of row.qualification!.results) expect(control.evidence.execution?.verifier?.completed).toBe(1);
    }
    const assessed = validateCriterionAssessments({ "candidate-1": evidence.candidates["candidate-1"].map(row => ({
      criterion: row.criterion, status: "pass", basis: "executed", reasoning: "Real Flask observations matched independent supervisor expectations and frozen control outcomes.",
    })) }, state.criteria!.contract, evidence, state);
    expect(assessed["candidate-1"].map(row => row.status)).toEqual(["pass", "pass"]);
    const record = JSON.parse(await readFile(join(root, "evaluator/semantic/pass-1/round-1/candidate-1/ipv6-server-name/qualification/qualification.json"), "utf8"));
    expect(record.status).toBe("qualified");
    expect(record.runtime_image).toBe(image);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 240_000);
