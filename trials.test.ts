import { expect, test } from "bun:test";
import { aggregatePairs, reportTrials, summarize, trialControls, type TrialSet } from "./trials";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { writeBundleManifest } from "./bundle";
import { sha256, writeState } from "./state";
import type { RunState } from "./types";

test("paired aggregates preserve negatives, omit missing metrics, and never zero-fill", () => {
  const report = (a: number | null, b: number | null) => ({
    arms: {
      stock: { usage: { totals: { total_tokens: a, estimated_api_usd: a } }, result: { agent_elapsed_ms: 0 } },
      current: { usage: { totals: { total_tokens: b, estimated_api_usd: b } }, result: { agent_elapsed_ms: 1000 } },
    },
  }) as unknown as Parameters<typeof aggregatePairs>[0][number];
  const result = aggregatePairs([report(100, 50), report(100, 150), report(0, 20), report(null, 30), report(100, null)]);
  expect(result.total_tokens!.difference.n).toBe(3);
  expect(result.total_tokens!.difference.mean).toBeCloseTo(20 / 3);
  expect(result.total_tokens!.difference.min).toBe(-50);
  expect(result.total_tokens!.percent.n).toBe(2);
  expect(result.total_tokens!.percent.mean).toBe(0);
  expect(result.grader_seconds!.difference.n).toBe(0);
  expect(result.grader_seconds!.difference.mean).toBeNull();
  expect(aggregatePairs([]).estimated_api_usd!.difference.mean).toBeNull();
  expect(summarize([1]).sample_sd).toBeNull();
  expect(summarize([1, 3])).toMatchObject({ n: 2, mean: 2, median: 2, min: 1, max: 3 });
  expect(summarize([1, 3]).sample_sd).toBeCloseTo(Math.sqrt(2));
});

test("complete metered pair reports enter the retained aggregate while partial pairs remain explicit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-ab-trials-"));
  try {
    const hash = (value: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex");
    const baseline = {
      schema_version: 1, status: "complete", image_id: `sha256:${"a".repeat(64)}`,
      finishing: { status: "complete" }, comparison: "same-setup",
      execution: { model: "gpt-6-astra", reasoning_effort: "medium", service_tier: "default" },
      protected_runtime: { boundary: "direct-egress-vs-router-only", scripts: [] },
    } as RunState;
    const controls = trialControls(baseline);
    const controlsSha = hash(controls);
    const set: TrialSet = {
      schema: "codex-ab.trials.v1", id: basename(directory), created_at: new Date().toISOString(),
      status: "partial", schedule: "concurrent", controls, controls_sha256: controlsSha,
      plan_sha256: hash({ controls: controlsSha, count: 3, schedule: "concurrent" }),
      trials: [],
    };
    for (let index = 1; index <= 3; index++) {
      const runId = `${set.id}-${index}`;
      const state: RunState = { ...baseline, id: runId, arm_order: "concurrent",
        trial: { set_id: set.id, index, controls_sha256: controlsSha, plan_sha256: set.plan_sha256 } };
      const evidence = join(directory, "evidence", String(index));
      await mkdir(evidence, { recursive: true });
      await writeState(evidence, state);
      const report = {
        run_id: runId, setup: { arm_order: state.arm_order, trial: state.trial },
        measurement_complete: index !== 3, winner: index === 1 ? "current" : "tie",
        arms: Object.fromEntries(["stock", "current"].map(arm => [arm, {
          usage: { complete: true, totals: { total_tokens: arm === "stock" ? 100 : index === 1 ? 50 : 150,
            estimated_api_usd: index === 2 ? null : arm === "stock" ? 1 : 2 } },
          result: { agent_elapsed_ms: arm === "stock" ? 1000 : 2000, grade: { elapsed_ms: 100 } },
        }])),
        judge: { usage: { complete: true, totals: { estimated_api_usd: 0.5 } } },
      };
      await writeFile(join(evidence, "report.json"), JSON.stringify(report));
      await writeFile(join(evidence, "report.md"), `Pair ${index} complete setup, source judgments and pricing fixture.`);
      await writeFile(join(evidence, "stock-changes.patch"), "fixture evidence");
      await writeBundleManifest(evidence);
      set.trials.push({ index, run_dir: `runs/${index}`, run_id: runId, order: "concurrent",
        status: index === 3 ? "failed" : "complete",
        report_sha256: await sha256(join(evidence, "report.json")),
        markdown_sha256: await sha256(join(evidence, "report.md")),
        bundle_sha256: await sha256(join(evidence, "MANIFEST.sha256")) });
    }
    await writeFile(join(directory, "trials.json"), JSON.stringify(set));
    const path = await reportTrials(directory);
    const result = JSON.parse(await readFile(join(path, "..", "report.json"), "utf8"));
    expect(result.planned_pairs).toBe(3);
    expect(result.eligible_pairs).toBe(2);
    expect(result.current_minus_stock.total_tokens.difference).toMatchObject({ n: 2, mean: 0, min: -50, max: 50 });
    expect(result.current_minus_stock.estimated_api_usd.difference).toMatchObject({ n: 1, mean: 1 });
    expect(result.winners).toEqual({ stock: 0, current: 1, tie: 1, none: 0 });
    expect(result.judge_estimated_api_usd).toMatchObject({ n: 3, total: 1.5 });
    const markdown = await readFile(path, "utf8");
    expect(markdown).toContain("Pair 1 complete setup, source judgments and pricing fixture.");
    expect(markdown).toContain("incomplete or invalid paired measurement");
    expect(markdown).toContain("A is direct Codex");
    expect(await readFile(join(path, "..", "MANIFEST.sha256"), "utf8")).toContain("trials/1/MANIFEST.sha256");
    await rm(join(directory, "evidence/1/stock-changes.patch"));
    const missing = await reportTrials(directory);
    const missingResult = JSON.parse(await readFile(join(missing, "..", "report.json"), "utf8"));
    expect(missingResult.eligible_pairs).toBe(1);
    expect(missingResult.pairs[0].reason).toContain("retained bundle evidence changed");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
