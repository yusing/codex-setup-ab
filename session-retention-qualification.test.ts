import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { checked } from "./process";
import { validateVerification } from "./semantic-protocol";
import { loadTaskPack } from "./task-pack";

import { sessionRetentionObservations as observations, sessionRetentionQualificationChecks } from "./test-support/session-retention-qualification";
import { prepareTaskQualificationRun } from "./test-support/task-qualification";
import { executeSemanticCheck } from "./semantic";
import { qualifySemanticCheck } from "./semantic-qualification";

const packPath = join(import.meta.dir, "tasks/session-retention/manifest.json");

test("session-retention freezes behavioral observations and precise source controls for every criterion", async () => {
  const pack = await loadTaskPack(packPath);
  const verification = validateVerification(pack.contract.existing_test_verification);
  const preserved = verification.cases[0]!;
  expect(preserved.kind).toBe("command");
  expect(JSON.parse(preserved.expected)).toMatchObject({ foreign_rejected: true, initial: "waiting",
    message_kind: "message", message_source: "a", message_text: "progress", after_consumption: "waiting",
    restored_root: "paused", restored_child: "paused", generation: 1 });
  if (preserved.kind !== "command") throw new Error("expected command observation");
  expect(preserved.args).toEqual(["existing"]);
  expect(preserved.command.slice(0, 3)).toEqual(["python3", "-I", "-c"]);
  expect(preserved.command.at(-1)).toContain('"-overlay"');
  const controls = pack.contract.evaluator_controls!;
  expect(controls.cases.find(control => control.role === "baseline")!.expected).toEqual(
    Object.fromEntries(pack.contract.criteria.map(criterion => [criterion.id, "fail"])),
  );
  for (const criterion of pack.contract.criteria) {
    expect(observations[criterion.id]).toBeDefined();
    const applicable = controls.cases.filter(control => control.expected[criterion.id]);
    expect(applicable.map(control => control.role).sort()).toEqual(["alternative", "baseline", "negative", "reference"]);
    expect(applicable.find(control => control.role === "negative")!.patches).toHaveLength(1);
    expect(applicable.find(control => control.role === "alternative")!.patches).toHaveLength(1);
  }
});

test("candidate-root json.py cannot replace the observer's standard-library decoder", async () => {
  const pack = await loadTaskPack(packPath);
  const preserved = pack.contract.existing_test_verification!.cases[0]!;
  if (preserved.kind !== "command") throw new Error("expected command observation");
  const root = await mkdtemp(join(tmpdir(), "codex-ab-session-shadowing-"));
  try {
    await mkdir(join(root, "bin"));
    await writeFile(join(root, "json.py"), `import os\nprint(${JSON.stringify(preserved.expected)}, flush=True)\nos._exit(0)\n`);
    // This test isolates wrapper wiring. Real pinned Go service behavior is exercised separately below.
    const row = JSON.stringify({ Output: 'FROZEN_OBSERVATION {"origin":"declared-go-command"}\n' });
    const go = join(root, "bin/go");
    await writeFile(go, `#!/bin/sh\nprintf '%s\\n' '${row}'\n`);
    await chmod(go, 0o755);
    const result = await checked([...preserved.command, ...preserved.args!], {
      cwd: root, env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}` },
    });
    expect(JSON.parse(result.stdout)).toEqual({ origin: "declared-go-command" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

const source = process.env.CODEX_AB_SESSION_SOURCE;
const runtimeTest = source ? test : test.skip;

runtimeTest("pinned session-retention source executes retained observations and all frozen control expectations without model inference", async () => {
  const pack = await loadTaskPack(packPath);
  const root = await mkdtemp(join(tmpdir(), "codex-ab-session-qualification-"));
  const hash = (source: string) => createHash("sha256").update(source).digest("hex");
  const preserved = pack.contract.existing_test_verification!.cases[0]!;
  if (preserved.kind !== "command") throw new Error("expected command observation");
  const baseline = join(root, "baseline");
  const reference = join(root, "reference");
  try {
    // Archive exact objects; never check out or mutate the supplied source repository.
    for (const [tree, commit] of [[baseline, pack.manifest.source.base_commit], [reference, pack.manifest.source.reference_commit!]]) {
      await mkdir(tree);
      const archive = join(root, `${tree === baseline ? "baseline" : "reference"}.tar`);
      await checked(["git", "-C", source!, "archive", "--output", archive, commit]);
      await checked(["tar", "-xf", archive, "-C", tree]);
      const result = await checked([...preserved.command, ...preserved.args!], { cwd: tree });
      expect(JSON.parse(result.stdout)).toEqual(JSON.parse(preserved.expected));
    }
    for (const control of pack.contract.evaluator_controls!.cases) {
      const tree = control.base === "baseline" ? baseline : reference;
      const originals: Array<{ path: string; source: string }> = [];
      try {
        for (const [index, patch] of (control.patches ?? []).entries()) {
          const path = join(tree, patch.path);
          const original = await readFile(path, "utf8");
          expect(hash(original)).toBe(patch.before_sha256);
          originals.push({ path, source: original });
          const patchPath = join(root, `${control.id}-${index}.patch`);
          await writeFile(patchPath, patch.diff);
          await checked(["git", "apply", "--no-index", patchPath], { cwd: tree });
          expect(hash(await readFile(path, "utf8"))).toBe(patch.after_sha256);
        }
        for (const [criterion, expected] of Object.entries(control.expected)) {
          const process = Bun.spawn([...preserved.command, criterion], { cwd: tree, stdout: "pipe", stderr: "pipe" });
          const [stdout, stderr, exit] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
          let observed: unknown;
          try { observed = JSON.parse(stdout); } catch { /* A reached candidate error also rejects an incorrect implementation. */ }
          // Compare values structurally, not test-runner success markers or counts.
          if (expected === "pass") {
            expect(stderr).toBe("");
            expect(exit).toBe(0);
            expect(observed).toEqual(observations[criterion]);
          } else {
            if (exit === 0 && isDeepStrictEqual(observed, observations[criterion])) {
              throw new Error(`${control.id}/${criterion} unexpectedly retained the correct domain observation`);
            }
            if (exit !== 0) {
              expect(stderr).toContain('"Action":"fail"');
              expect(stderr).not.toContain("build failed");
            }
          }
        }
      } finally {
        for (const original of originals) await writeFile(original.path, original.source);
      }
    }
    const sentinel = join(reference, "modules/threadcontrol/control/zz_frozen_observation_test.go");
    const sentinelSource = 'package control\nfunc init() { panic("candidate-owned sentinel remains compiled") }\n';
    await writeFile(sentinel, sentinelSource);
    const collision = Bun.spawn([...preserved.command, ...preserved.args!], { cwd: reference,
      stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(collision.stdout).text(),
      new Response(collision.stderr).text(), collision.exited]);
    expect(exit).not.toBe(0);
    expect(stderr).toContain("candidate-owned sentinel remains compiled");
    expect(stdout).toBe("");
    expect(await readFile(sentinel, "utf8")).toBe(sentinelSource);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 180_000);

const liveTest = source && process.env.CODEX_AB_LIVE_DOCKER === "1" ? test : test.skip;
liveTest("session-retention observations and controls use the ordinary offline supervisor with exact pinned source", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-ab-session-supervisor-"));
  try {
    const image = (await checked(["docker", "image", "inspect", "--format", "{{.Id}}",
      process.env.CODEX_AB_SESSION_IMAGE ?? process.env.CODEX_AB_VERIFIER_IMAGE ?? "codex-ab:model-free"])).stdout.trim();
    const state = await prepareTaskQualificationRun(packPath, source!, root, image);
    // Use ordinary launcher defaults, not the generic helper's smaller 2 GiB fixture limit.
    state.resource_limits = { cpus: "2", memory: "4g" };
    const contract = state.criteria!.contract;
    const check = { criterion: "__existing_tests__", files: [], command: ["true"], rationale: "Preserved service state",
      verification: contract.existing_test_verification };
    const existing = await executeSemanticCheck({ runDir: root, state, check, candidate: join(root, "evaluator/stock"),
      output: join(root, "existing"), name: `session-existing-${crypto.randomUUID()}`, docker: "docker" });
    expect(existing.status).toBe("pass");
    expect(existing.execution?.verifier?.cases.map(row => JSON.parse(row.stdout))).toEqual([
      JSON.parse(contract.existing_test_verification!.cases[0]!.expected),
    ]);
    const selected = process.env.CODEX_AB_SESSION_CRITERIA?.split(",");
    const allChecks = sessionRetentionQualificationChecks(contract);
    if (selected?.some(id => !allChecks.some(check => check.criterion === id))) throw new Error("Unknown session qualification criterion");
    const checks = allChecks.filter(check => !selected || selected.includes(check.criterion));
    for (let index = 0; index < checks.length; index += 2) {
      const outcomes = await Promise.allSettled(checks.slice(index, index + 2).map(async authored => {
      const qualification = await qualifySemanticCheck({ runDir: root, state, check: authored,
        controls: contract.evaluator_controls, output: join(root, authored.criterion),
        docker: "docker", evaluatorModel: "model-free-authored-service-observations" });
      if (qualification.status !== "qualified") {
        throw new Error(JSON.stringify(qualification.results.map(row => ({ control: row.control,
          expected: row.expected, status: row.evidence.status, verifier: row.evidence.execution?.verifier,
          stderr: row.evidence.execution?.stderr.slice(-3000), stdout: row.evidence.execution?.stdout.slice(-1000) })), null, 2));
      }
      expect(qualification.results.every(row => row.matched)).toBe(true);
      for (const result of qualification.results) {
        // A preparation/OOM failure is not a reached negative observation.
        expect(result.evidence.execution?.verifier).toMatchObject({ completed: 1, expected: 1 });
        expect(result.evidence.execution?.verifier?.cases[0]?.stderr).not.toContain("build failed");
      }
      for (const result of qualification.results.filter(row => row.expected === "pass")) {
        expect(result.evidence.execution?.verifier?.cases.map(row => JSON.parse(row.stdout))).toEqual([
          observations[authored.criterion],
        ]);
      }
      }));
      for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 1_800_000);
