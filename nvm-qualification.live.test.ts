import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareSemanticAssessment } from "./semantic-assessment";
import { verifiedCriterionEvidence } from "./behavioral-evidence";
import { checked } from "./process";
import { executeSemanticCheck } from "./semantic";
import { nvmQualificationChecks, prepareNvmQualificationRun } from "./test-support/nvm-qualification";

const source = process.env.CODEX_AB_NVM_SOURCE;
const liveTest = process.env.CODEX_AB_LIVE_DOCKER === "1" && source ? test : test.skip;

liveTest("real NVM installer observations qualify all frozen controls through the offline semantic runner", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-ab-nvm-qualification-"));
  try {
    const image = (await checked(["docker", "image", "inspect", "--format", "{{.Id}}", process.env.CODEX_AB_VERIFIER_IMAGE ?? "codex-ab:0.1.0"])).stdout.trim();
    const state = await prepareNvmQualificationRun(source!, root, image);
    const contract = state.criteria!.contract;
    const checks = nvmQualificationChecks(contract);
    const stages: string[] = [];
    const evidence = await prepareSemanticAssessment({ runDir: root, state, contract, pass: 1, order: ["stock"], docker: "docker",
      evaluatorModel: "model-free-authored-checks", ask: async stage => { stages.push(stage); return { "candidate-1": checks }; } });
    expect(stages).toEqual(["harness-1"]);
    expect(evidence.existing_tests["candidate-1"].status).toBe("pass");
    const existing = evidence.existing_tests["candidate-1"].execution!.verifier!;
    expect(existing).toMatchObject({ status: "passed", completed: 1, expected: 1 });
    expect(JSON.parse(existing.cases[0]!.stdout)).toEqual(JSON.parse(contract.existing_test_verification!.cases[0]!.expected));
    expect(evidence.existing_test_commands!["candidate-1"]!.execution!.exit_code).toBe(0);
    expect(evidence.existing_test_commands!["candidate-1"]!.status).toBe("unassessed");
    for (const row of evidence.candidates["candidate-1"]!) {
      const check = checks.find(item => item.criterion === row.criterion)!;
      expect(row.status).toBe("pass");
      expect(row.qualification?.status).toBe("qualified");
      const baselineStatus = row.criterion === "curl-posix" ? "pass" : "fail";
      const negative = { "literal-arguments": "unsafe-reparse", "wget-translations": "resume-value-leak", "curl-posix": "changed-curl-options" }[row.criterion];
      expect(row.qualification!.results.map(control => [control.control, control.expected, control.evidence.status])).toEqual([
        ["upstream-reference", "pass", "pass"], ["pinned-baseline", baselineStatus, baselineStatus],
        [negative, "fail", "fail"], ["independent-positional-loop", "pass", "pass"],
      ]);
      expect(verifiedCriterionEvidence(row, state)).toMatchObject({ behavior: "pass", evaluation_validity: "valid" });
      const verifier = row.execution!.verifier!;
      expect(verifier.completed).toBe(check.verification!.cases.length);
      for (const [index, observation] of verifier.cases.entries()) {
        const probe = check.verification!.cases[index]!;
        expect(observation.exit_code).toBe(probe.kind === "command" ? probe.expected_exit : 0);
        if (probe.kind === "command" && probe.format === "json") expect(JSON.parse(observation.stdout)).toEqual(JSON.parse(probe.expected));
        else expect(observation.stdout).toBe(probe.expected);
      }
      for (const control of row.qualification!.results) expect(control.evidence.execution!.verifier!.completed).toBe(check.verification!.cases.length);
      const record = JSON.parse(await readFile(join(root, `evaluator/semantic/pass-1/round-1/candidate-1/${row.criterion}/qualification/qualification.json`), "utf8"));
      expect(record).toMatchObject({ status: "qualified", runtime_image: image, reference_commit: state.upstream_reference!.end_commit });
    }
    // The retained-behavior gate must also pass unchanged source, not just the solution.
    const baseline = join(root, "baseline");
    await mkdir(baseline);
    await checked(["tar", "-xf", join(root, "baseline.tar"), "-C", baseline]);
    const retained = await executeSemanticCheck({ runDir: root, state, candidate: baseline, output: join(root, "baseline-existing"),
      name: `codex-ab-nvm-existing-${crypto.randomUUID()}`, docker: "docker", check: {
        criterion: "__existing_tests", files: [], command: ["true"], rationale: "Observe preserved nvm_source behavior on the unchanged baseline.",
        verification: contract.existing_test_verification,
      } });
    expect(retained.status).toBe("pass");
    expect(JSON.parse(retained.execution!.verifier!.cases[0]!.stdout)).toEqual(JSON.parse(contract.existing_test_verification!.cases[0]!.expected));
  } finally { await rm(root, { recursive: true, force: true }); }
}, 240_000);
