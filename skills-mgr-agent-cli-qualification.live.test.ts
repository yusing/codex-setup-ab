import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checked } from "./process";
import { executeSemanticCheck, type SemanticCheck } from "./semantic";
import { qualifySemanticCheck } from "./semantic-qualification";
import { prepareTaskQualificationRun } from "./test-support/task-qualification";

const live = process.env.CODEX_AB_QUALIFY_SKILLS_MGR_AGENT_CLI === "1" ? test : test.skip;
const packPath = join(import.meta.dir, "tasks/skills-mgr-agent-cli/manifest.json");
const expectations: Record<string, unknown> = await Bun.file(join(import.meta.dir, "testdata/skills-mgr-agent-cli-observations.json")).json();

async function fixture(root: string) {
  const source = process.env.CODEX_AB_SKILLS_MGR_SOURCE;
  const image = process.env.CODEX_AB_QUALIFICATION_IMAGE;
  if (!source || !image) throw new Error("Set CODEX_AB_SKILLS_MGR_SOURCE and an offline dependency/compiler-cache image in CODEX_AB_QUALIFICATION_IMAGE");
  return prepareTaskQualificationRun(packPath, source, root, image);
}

live("agent CLI frozen existing observations pass baseline and reference", async () => {
  const root = await mkdtemp(join(tmpdir(), "skills-agent-existing-"));
  try {
    const state = await fixture(root);
    const contract = state.criteria!.contract;
    expect(Object.keys(expectations).sort()).toEqual(contract.criteria.map(item => item.id).sort());
    await mkdir(join(root, "baseline"));
    await checked(["tar", "-xf", join(root, "baseline.tar"), "-C", join(root, "baseline")]);
    for (const snapshot of ["baseline", "reference"] as const) {
      const check: SemanticCheck = { criterion: "__existing_tests", files: [], command: ["go", "test", ".", "-count=1"],
        rationale: "Retained local serving, ranges, reference reading, listing, disabled selection, and nonexecution.",
        verification: contract.existing_test_verification };
      const evidence = await executeSemanticCheck({ runDir: root, state,
        candidate: snapshot === "reference" ? join(root, "evaluator/stock") : join(root, "baseline"),
        output: join(root, "existing", snapshot), name: `agent-existing-${process.pid}-${snapshot}`, check, docker: "docker" });
      if (evidence.status !== "pass") process.stderr.write(JSON.stringify({ verifier: evidence.execution?.verifier, stderr: evidence.execution?.stderr }) + "\n");
      expect(evidence.status).toBe("pass");
      expect(evidence.execution?.verifier?.completed).toBe(1);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 180_000);


live("agent CLI observer isolation rejects a candidate stdlib-shadow forgery", async () => {
  const root = await mkdtemp(join(tmpdir(), "skills-agent-shadow-"));
  try {
    const state = await fixture(root);
    const candidate = join(root, "evaluator/stock");
    const verification = state.criteria!.contract.existing_test_verification!;
    const probe = verification.cases[0]!;
    if (probe.kind !== "command") throw new Error("Expected the public CLI observer");
    // A candidate module prints the expected result before the observer can build
    // or invoke any Go interface. Removing the entrypoint makes actual execution
    // impossible, so only import hijacking can manufacture a passing observation.
    await writeFile(join(candidate, "json.py"), `import os\nos.write(1, ${JSON.stringify(probe.expected + "\n")}.encode())\nos._exit(0)\n`);
    await rm(join(candidate, "main.go"));
    for (const isolated of [false, true]) {
      const adapted = structuredClone(verification);
      const command = adapted.cases[0]!;
      if (command.kind !== "command") throw new Error("Expected command case");
      if (!isolated) command.command = command.command.filter(part => part !== "-I");
      const check: SemanticCheck = { criterion: "__existing_tests", files: [], command: ["go", "test", ".", "-count=1"],
        rationale: "The corrected observer must not import candidate-owned stdlib shadows.", verification: adapted };
      const evidence = await executeSemanticCheck({ runDir: root, state, candidate, check, docker: "docker",
        output: join(root, isolated ? "isolated" : "old-wiring"), name: `agent-shadow-${process.pid}-${isolated}` });
      expect(evidence.status).toBe(isolated ? "fail" : "pass");
      expect(evidence.execution?.verifier?.status).toBe(isolated ? "candidate_error" : "passed");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 180_000);

for (const [criterion, expected] of Object.entries(expectations)) {
  live(`agent CLI criterion controls: ${criterion}`, async () => {
    const root = await mkdtemp(join(tmpdir(), `skills-agent-${criterion}-`));
    try {
      const state = await fixture(root);
      const refresh = criterion === "refresh-backoff";
      const observer = await Bun.file(join(import.meta.dir, "testdata", refresh ? "skills-mgr-agent-cli-refresh-observer.py" : "skills-mgr-agent-cli-observer.py")).text();
      const command = ["python3", "-I", "-c", observer];
      const check: SemanticCheck = { criterion,
        files: refresh ? [{ path: "frozen_agent_observer_test.go", source: await Bun.file(join(import.meta.dir, "testdata/skills-mgr-agent-cli-refresh-observer.go.txt")).text() }] : [],
        command, rationale: "Record actual consumer output and retained state; the supervisor owns the expected structured observation.",
        verification: { schema: "codex-ab.verification.v1", cases: [{ id: `${criterion}-observations`, kind: "command",
          command, args: refresh ? [] : [criterion], expected_exit: 0, format: "json", expected: JSON.stringify(expected) }] } };
      const qualification = await qualifySemanticCheck({ runDir: root, state, check, controls: state.criteria!.contract.evaluator_controls,
        output: join(root, "qualification"), docker: "docker", evaluatorModel: "model-free-frozen-observer" });
      for (const result of qualification.results) {
        const expectedStatus = result.expected === "pass" ? "passed" : "assertion_failure";
        process.stderr.write(`[agent-cli] ${criterion}/${result.control}: ${result.evidence.status}, expected ${result.expected}\n`);
        if (!result.matched || result.evidence.execution?.verifier?.status !== expectedStatus) process.stderr.write(JSON.stringify({ verifier: result.evidence.execution?.verifier, stderr: result.evidence.execution?.stderr }) + "\n");
        expect(result.matched).toBe(true);
        expect(result.evidence.execution?.verifier?.status).toBe(expectedStatus);
      }
      expect(qualification.status).toBe("qualified");
      expect(qualification.results.length).toBe(criterion === "remote-edit-rejection" ? 5 : 4);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 300_000);
}
