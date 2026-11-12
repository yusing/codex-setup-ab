import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checked } from "./process";
import { executeSemanticCheck } from "./semantic";
import type { RunState } from "./types";

// Qualification of fixed reference assertions, not a hidden candidate oracle.
// Adaptive judges must still inspect each candidate's actual public interfaces.
const live = process.env.CODEX_AB_QUALIFY_SKILLS_MGR === "1" ? test : test.skip;
live("skills-mgr reference acceptance rejects independently seeded regressions", async () => {
  const source = process.env.CODEX_AB_SKILLS_MGR_SOURCE;
  const image = process.env.CODEX_AB_QUALIFICATION_IMAGE;
  if (!source || !image) throw new Error("Set CODEX_AB_SKILLS_MGR_SOURCE and an offline dependency image in CODEX_AB_QUALIFICATION_IMAGE");
  const manifest = await Bun.file(join(import.meta.dir, "tasks/skills-mgr-agent-cli/manifest.json")).json();
  const root = await mkdtemp(join(tmpdir(), "skills-mgr-qualification-"));
  try {
    const archive = join(root, "reference.tar");
    await checked(["git", "-C", source, "archive", "--format=tar", `--output=${archive}`, manifest.source.reference_commit]);
    const cases = [
      { name: "reference", expected: "pass", file: "", from: "", to: "", assertion: "" },
      { name: "accept-name", expected: "fail", file: "agent_mutation.go",
        from: "metadata.Name != skill.Name || metadata.DisableModelInvocation != oldMetadata.DisableModelInvocation",
        to: "metadata.DisableModelInvocation != oldMetadata.DisableModelInvocation", assertion: "ACCEPTANCE_REJECTION: name" },
      { name: "accept-invocation", expected: "fail", file: "agent_mutation.go",
        from: "metadata.Name != skill.Name || metadata.DisableModelInvocation != oldMetadata.DisableModelInvocation",
        to: "metadata.Name != skill.Name || (false && metadata.DisableModelInvocation != oldMetadata.DisableModelInvocation)", assertion: "ACCEPTANCE_REJECTION: invocation" },
      { name: "reparse-body", expected: "fail", file: "agent_inspect.go",
        from: "if isSkillManifest(relative) && skill.DisableModelInvocation {",
        to: "if isSkillManifest(relative) {", assertion: "horizontal rule check" },
      { name: "omit-alias-references", expected: "fail", file: "agent_inspect.go",
        from: "if err != nil || !isSkillManifest(relative) {",
        to: 'if err != nil || relative != "" {', assertion: "alias reference expansion" },
      { name: "omit-rollback", expected: "fail", file: "agent_mutation.go",
        from: "return errors.Join(err, writeSkillManifest(skill.Path, original, info.Mode().Perm()))",
        to: "return err", assertion: "ACCEPTANCE_ROLLBACK: manifest changed" },
    ];
    const state = { id: `qualification-${process.pid}`, image, timeout_seconds: 120,
      resource_limits: { cpus: "4", memory: "4g" } } as RunState;
    for (const item of cases) {
      const candidate = join(root, item.name);
      await mkdir(candidate);
      await checked(["tar", "-xf", archive, "-C", candidate]);
      if (item.file) {
        const path = join(candidate, item.file);
        const before = await readFile(path, "utf8");
        expect(before.split(item.from)).toHaveLength(2);
        await writeFile(path, before.replace(item.from, item.to));
      }
      const evidence = await executeSemanticCheck({ runDir: root, state, candidate,
        output: join(root, "evidence", item.name), name: `codex-ab-qualification-${process.pid}-${item.name}`, docker: "docker",
        check: { criterion: "reference-sensitivity", rationale: "Reference passes; each independently seeded regression reaches its intended assertion.",
          files: [{ path: "acceptance_qualification_test.go", source: await Bun.file(join(import.meta.dir, "testdata/skills-mgr-acceptance.go.txt")).text() }],
          command: ["go", "test", ".", "-count=1", ...(item.name === "reference" ? [] :
            ["-run", "^TestAcceptance|^TestAgentCheckServedRootBodyHealth$|^TestAgentCheckManifestAliases$"])] } });
      process.stderr.write(`[qualification] ${item.name}: ${evidence.status}\n`);
      if (evidence.status !== item.expected) process.stderr.write(`${evidence.execution?.stdout}\n${evidence.execution?.stderr}\n`);
      expect(evidence.status).toBe(item.expected);
      if (item.assertion) expect(`${evidence.execution?.stdout}\n${evidence.execution?.stderr}`).toContain(item.assertion);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 900_000);

// Qualifies the commit-backed packs whose baseline suites survive their references
// unchanged: the reference passes, base fails a reference regression at its intended
// assertion, and retained baseline tests separate edited expectations from refactors.
live("skills-mgr uninstall and acquisition packs qualify their references and retained baseline tests", async () => {
  const source = process.env.CODEX_AB_SKILLS_MGR_SOURCE;
  const image = process.env.CODEX_AB_QUALIFICATION_IMAGE;
  if (!source || !image) throw new Error("Set CODEX_AB_SKILLS_MGR_SOURCE and an offline dependency image in CODEX_AB_QUALIFICATION_IMAGE");
  const root = await mkdtemp(join(tmpdir(), "skills-mgr-pack-qualification-"));
  const state = { id: `pack-qualification-${process.pid}`, image, timeout_seconds: 300, resource_limits: { cpus: "4", memory: "4g" } } as RunState;
  const extract = async (commit: string, directory: string) => {
    const archive = join(root, `${commit}.tar`);
    await checked(["git", "-C", source, "archive", "--format=tar", `--output=${archive}`, commit]);
    await mkdir(directory, { recursive: true });
    await checked(["tar", "-xf", archive, "-C", directory]);
  };
  const edit = async (directory: string, file: string, from: string, to: string) => {
    const path = join(directory, file), before = await readFile(path, "utf8");
    expect(before.split(from).length).toBeGreaterThan(1);
    await writeFile(path, before.replaceAll(from, to));
  };
  const run = async (name: string, candidate: string, command: string[], retained?: { patterns: string[]; baseline: string }) => {
    const evidence = await executeSemanticCheck({ runDir: root, state, candidate, retained, output: join(root, "evidence", name),
      name: `codex-ab-pack-qualification-${process.pid}-${name}`, docker: "docker",
      check: { criterion: retained ? "__retained_tests" : "qualification", files: [], command, rationale: "Pack qualification." } });
    const output = `${evidence.execution?.stdout}\n${evidence.execution?.stderr}`;
    process.stderr.write(`[qualification] ${name}: ${evidence.status}\n${evidence.status === "pass" ? "" : `${output.slice(-3000)}\n`}`);
    return { status: evidence.status, output };
  };
  try {
    for (const name of ["skills-mgr-remote-uninstall", "skills-mgr-get-short-circuit"]) {
      const manifest = await Bun.file(join(import.meta.dir, "tasks", name, "manifest.json")).json();
      const { base_commit: base, reference_commit: reference } = manifest.source;
      const { patterns, command } = manifest.criteria.retained_tests;
      const baseline = join(root, name, "baseline"), solved = join(root, name, "reference");
      await extract(base, baseline);
      await extract(reference, solved);
      expect((await run(`${name}-reference`, solved, ["sh", "-lc", manifest.criteria.existing_tests])).status).toBe("pass");
      expect((await run(`${name}-reference-retained`, solved, ["sh", "-lc", command], { patterns, baseline })).status).toBe("pass");

      // Base must fail an upstream regression test at its intended assertion.
      const sensitivity = join(root, name, "base-with-reference-test");
      await extract(base, sensitivity);
      const [file, test, assertion] = name === "skills-mgr-remote-uninstall"
        ? ["repository_cli_test.go", "^TestRunInstallRepository$", "--- FAIL: TestRunInstallRepository/"]
        : ["acquisition_evidence_test.go", "^TestAcquisitionShortCircuitsSingleEvidenceQuery$", "--- FAIL: TestAcquisitionShortCircuitsSingleEvidenceQuery/"];
      await writeFile(join(sensitivity, file), await readFile(join(solved, file)));
      const base_result = await run(`${name}-base-sensitivity`, sensitivity, ["go", "test", ".", "-count=1", "-run", test]);
      expect(base_result.status).toBe("fail");
      expect(base_result.output).not.toContain("[build failed]");
      expect(base_result.output).toContain(assertion);

      // An edited expectation that accepts a regression passes the candidate's own
      // suite but fails the retained baseline tests.
      const regressed = join(root, name, "edited-expectation");
      await extract(reference, regressed);
      await edit(regressed, "main.go", `{"run", "run `, `{"run", "exec `);
      await edit(regressed, "skills_test.go", `"skills-mgr run"`, `"skills-mgr exec"`);
      expect((await run(`${name}-edited-existing`, regressed, ["go", "test", ".", "-count=1", "-run", "^TestHelpCommand$"])).status).toBe("pass");
      const caught = await run(`${name}-edited-retained`, regressed, ["sh", "-lc", command], { patterns, baseline });
      expect(caught.status).toBe("fail");
      expect(caught.output).toContain("skills-mgr run");

      // Renaming an internal helper breaks baseline compilation without a behavioral verdict.
      const renamed = join(root, name, "internal-rename");
      await extract(reference, renamed);
      await checked(["sh", "-c", 'grep -rl --include="*.go" "saveLock(" . | xargs sed -i "s/\\bsaveLock(/persistLock(/g"'], { cwd: renamed });
      expect((await run(`${name}-renamed-existing`, renamed, ["go", "vet", "."])).status).toBe("pass");
      expect((await run(`${name}-renamed-retained`, renamed, ["sh", "-lc", command], { patterns, baseline })).status).toBe("unassessed");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 1_800_000);
