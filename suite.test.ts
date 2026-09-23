import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { reportSuite, prepareSuite } from "./suite";
import { loadTaskPack } from "./task-pack";
import { writeBundleManifest } from "./bundle";
import { sha256, writeState } from "./state";
import { reportTrials, trialControls, type TrialSet } from "./trials";
import type { ArmName, RunState } from "./types";

type PairFixture = {
  stockSeconds: number;
  currentSeconds: number;
  stockPassed?: boolean;
  currentPassed?: boolean;
  stockUsd?: number | null;
  currentUsd?: number | null;
};

test("the checked-in diverse suite maps each of its four task IDs to a matching pack", async () => {
  const manifest = JSON.parse(await readFile(join(import.meta.dir, "tasks/diverse-suite.json"), "utf8"));
  expect(manifest.schema).toBe("codex-ab.suite.v1");
  expect(manifest.tasks.map((task: { id: string }) => task.id).sort()).toEqual([
    "express-transfer-encoding", "flask-ipv6-server-name", "gin-context-copy", "nvm-download-no-eval",
  ]);
  for (const task of manifest.tasks as Array<{ id: string; pack: string }>) {
    const pack = await loadTaskPack(join(import.meta.dir, "tasks", task.pack));
    expect(pack.manifest.id).toBe(task.id);
  }
});

function baseline(task: string, setup: ArmName): RunState {
  return {
    schema_version: 1,
    id: "fixture",
    status: "complete",
    image_id: `sha256:${"a".repeat(64)}`,
    comparison: "mentor-handoff",
    task_pack: { id: task, path: "pack/manifest.json", sha256: "b".repeat(64) },
    mentor: { setup, child_model: "gpt-6-luna", child_effort: "medium", parent_prompt: { path: "parent.md", sha256: "c".repeat(64) },
      child_config: { path: "child.json", sha256: "d".repeat(64) } },
    execution: { model: "gpt-6-astra", reasoning_effort: "medium", service_tier: "default" },
    protected_runtime: { boundary: "direct-egress-vs-router-only", scripts: [] },
    finishing: { status: "complete" },
  } as unknown as RunState;
}

async function writeTrialSet(directory: string, task: string, setup: ArmName, fixtures: PairFixture[]): Promise<void> {
  await mkdir(directory, { recursive: true });
  const id = basename(directory);
  const controls = trialControls(baseline(task, setup));
  const controlsSha = new Bun.CryptoHasher("sha256").update(JSON.stringify(controls)).digest("hex");
  const planSha = new Bun.CryptoHasher("sha256").update(JSON.stringify({ controls: controlsSha, count: fixtures.length, schedule: "concurrent" })).digest("hex");
  const set: TrialSet = {
    schema: "codex-ab.trials.v1", id, created_at: new Date().toISOString(), status: "complete", schedule: "concurrent",
    controls, controls_sha256: controlsSha, plan_sha256: planSha, trials: [],
  };

  for (const [offset, fixture] of fixtures.entries()) {
    const index = offset + 1;
    const runId = `${id}-${index}`;
    const armOrder = "concurrent" as const;
    const trial = { set_id: id, index, controls_sha256: controlsSha, plan_sha256: planSha };
    const state: RunState = { ...baseline(task, setup), id: runId, arm_order: armOrder, trial };
    const evidence = join(directory, "evidence", String(index));
    await mkdir(evidence, { recursive: true });
    await writeState(evidence, state);
    const arm = (elapsed: number, passed: boolean | undefined, usd: number | null | undefined) => ({
      result: { agent_elapsed_ms: elapsed * 1000, grade: { passed: passed ?? true } },
      usage: { complete: true, totals: { estimated_api_usd: usd ?? null } },
    });
    const report = {
      run_id: runId,
      setup: { arm_order: armOrder, trial },
      measurement_complete: true,
      winner: "tie",
      arms: {
        stock: arm(fixture.stockSeconds, fixture.stockPassed, fixture.stockUsd),
        current: arm(fixture.currentSeconds, fixture.currentPassed, fixture.currentUsd),
      },
    };
    await writeFile(join(evidence, "report.json"), JSON.stringify(report));
    await writeFile(join(evidence, "report.md"), `Fixture evidence: ${task}, ${setup}, pair ${index}.\n`);
    await writeBundleManifest(evidence);
    set.trials.push({ index, run_dir: `runs/${index}`, run_id: runId, order: armOrder, status: "complete",
      report_sha256: await sha256(join(evidence, "report.json")),
      markdown_sha256: await sha256(join(evidence, "report.md")),
      bundle_sha256: await sha256(join(evidence, "MANIFEST.sha256")) });
  }
  await writeFile(join(directory, "trials.json"), `${JSON.stringify(set, null, 2)}\n`);
}

test("suite preparation rejects malformed manifests and source maps", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-ab-suite-invalid-"));
  try {
    const manifestPath = join(root, "suite.json");
    const sourcesPath = join(root, "sources.json");
    const options = { manifestPath, sourcesPath, comparison: "stock-current" as const, count: 2,
      schedule: "concurrent" as const, outputParent: root, common: {} as never };
    await writeFile(manifestPath, JSON.stringify({ schema: "codex-ab.suite.v1", tasks: [] }));
    await writeFile(sourcesPath, JSON.stringify({ first: "/source/one", second: "/source/two" }));
    await expect(prepareSuite(options)).rejects.toThrow("invalid suite manifest or sources map");

    await writeFile(manifestPath, JSON.stringify({ schema: "codex-ab.suite.v1", tasks: [
      { id: "first", pack: "first/manifest.json" }, { id: "second", pack: "second/manifest.json" },
    ] }));
    await writeFile(sourcesPath, JSON.stringify(["/source/one", "/source/two"]));
    await expect(prepareSuite(options)).rejects.toThrow("invalid suite manifest or sources map");

    await writeFile(sourcesPath, JSON.stringify({ first: "/source/one" }));
    await expect(prepareSuite(options)).rejects.toThrow("missing source checkout for suite task second");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("suite preparation rejects a task ID that differs from its pack identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-ab-suite-pack-id-"));
  try {
    await cp(join(import.meta.dir, "tasks/gin-context-copy"), join(root, "pack"), { recursive: true });
    const manifestPath = join(root, "suite.json");
    const sourcesPath = join(root, "sources.json");
    await writeFile(manifestPath, JSON.stringify({ schema: "codex-ab.suite.v1", tasks: [
      { id: "renamed-gin", pack: "pack/manifest.json" }, { id: "another-task", pack: "pack/manifest.json" },
    ] }));
    await writeFile(sourcesPath, JSON.stringify({ "renamed-gin": "/source/one", "another-task": "/source/two" }));
    await expect(prepareSuite({ manifestPath, sourcesPath, comparison: "stock-current", count: 2,
      schedule: "concurrent", outputParent: root, common: {} as never }))
      .rejects.toThrow(/suite task identity mismatch:/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("suite report filters to both-passing pairs, leaves missing costs unknown, and groups mentor setups", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-ab-suite-report-"));
  try {
    const sets = [
      { task: "alpha", setup: "stock" as const, deltas: [1, 99], missingCost: true },
      { task: "alpha", setup: "current" as const, deltas: [2, 2], missingCost: true },
      { task: "beta", setup: "stock" as const, deltas: [3, 3], missingCost: false },
      { task: "beta", setup: "current" as const, deltas: [4, 4], missingCost: false },
    ];
    const suiteSets = [];
    for (const [offset, item] of sets.entries()) {
      const trialSet = `codex-ab-trials-fixture${offset}`;
      const first: PairFixture = { stockSeconds: 10, currentSeconds: 10 + item.deltas[0]!, stockUsd: item.missingCost ? null : 2,
        currentUsd: item.missingCost ? null : 3 };
      const second: PairFixture = { stockSeconds: 10, currentSeconds: 10 + item.deltas[1]!, stockUsd: item.missingCost ? null : 2,
        currentUsd: item.missingCost ? null : 3 };
      if (item.task === "alpha" && item.setup === "stock") second.currentPassed = false;
      await writeTrialSet(join(directory, trialSet), item.task, item.setup, [first, second]);
      suiteSets.push({ task: item.task, setup: item.setup, trial_set: trialSet, status: "complete" as const });
    }
    const state = { schema: "codex-ab.suite-run.v1", id: basename(directory), created_at: new Date().toISOString(),
      status: "complete", comparison: "mentor-matrix", schedule: "concurrent", count: 2,
      manifest_sha256: "e".repeat(64), sources_sha256: "f".repeat(64), sets: suiteSets };
    const suitePath = join(directory, "suite.json");
    await writeFile(suitePath, `${JSON.stringify(state, null, 2)}\n`);

    const reportPath = await reportSuite(directory);
    const report = JSON.parse(await readFile(join(reportPath, "..", "report.json"), "utf8"));
    const alphaStock = report.rows.find((row: { task: string; setup: string }) => row.task === "alpha" && row.setup === "stock");
    expect(alphaStock).toMatchObject({ planned: 2, measured: 2, both_pass: 1 });
    expect(report.effects.find((row: { task: string; setup: string }) => row.task === "alpha" && row.setup === "stock"))
      .toMatchObject({ agent_seconds: 1, estimated_api_usd: null });
    expect(report.macro.agent_seconds.stock).toMatchObject({ n: 2, mean: 2 });
    expect(report.macro.agent_seconds.current).toMatchObject({ n: 2, mean: 3 });
    expect(report.macro.estimated_api_usd.stock).toMatchObject({ n: 1, mean: 1 });
    expect(report.macro.estimated_api_usd.current).toMatchObject({ n: 1, mean: 1 });
    const markdown = await readFile(reportPath, "utf8");
    expect(markdown).toContain("unknown");
    expect(markdown).toStartWith("# Cross-task benchmark suite\n\n");
    expect(markdown).toContain("| alpha | stock | 2 | 2 | 1 | 1.0000 | unknown |");

    const renamedTaskState = { ...state, sets: suiteSets.map((set, index) => index === 0 ? { ...set, task: "renamed-alpha" } : set) };
    await writeFile(suitePath, JSON.stringify(renamedTaskState));
    await expect(reportSuite(directory)).rejects.toThrow("suite task or setup identity changed");
    const wrongSetupState = { ...state, sets: suiteSets.map((set, index) => index === 0 ? { ...set, setup: "standard" } : set) };
    await writeFile(suitePath, JSON.stringify(wrongSetupState));
    await expect(reportSuite(directory)).rejects.toThrow("suite task or setup identity changed");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
