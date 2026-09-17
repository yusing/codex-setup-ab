import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { judgeRun, mappedWinner, validateJudgePass } from "./judge";
import { buildReport, invalidateRun } from "./report";
import { readState, writeState } from "./state";
import type { ArmName, ArmResult, CommandEvidence, JudgeReport, RunState } from "./types";
import type { PricingSnapshot } from "./usage";

let root: string;

async function file(path: string, contents: string, mode?: number): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, contents, mode === undefined ? undefined : { mode });
}

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "codex-ab-judge-test-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function command(name: string, exitCode = 0): CommandEvidence {
  return { command: name, started_at: "2026-09-09T00:00:00.000Z", elapsed_ms: 250, exit_code: exitCode, stdout: `${name} in evaluator/stock at ${root}\n`, stderr: "" };
}

function armResult(arm: ArmName, passed: boolean): ArmResult {
  const assessed = { criterion: "behavior", status: passed ? "pass" as const : "fail" as const,
    basis: "executed" as const, reasoning: "Executed behavioral check", execution: command("node --test", passed ? 0 : 1) };
  const existing = { ...assessed, criterion: "__existing_tests" };
  return {
    arm, anonymous_id: arm === "stock" ? "candidate-1" : "candidate-2", container: `container-${arm}`,
    started_at: "2026-09-09T00:00:00.000Z", finished_at: "2026-09-09T00:00:01.000Z", agent_elapsed_ms: arm === "stock" ? 1000 : 1250,
    exit_code: 0, timed_out: false, canceled: false, patch_path: `artifacts/${arm}/changes.patch`, stdout_path: `artifacts/${arm}/codex.jsonl`, stderr_path: `artifacts/${arm}/codex.stderr`,
    changed_files: [`${arm}.ts`],
    grade: { preparation: command("prepare"), router_suite: command("router", passed ? 0 : 1), elapsed_ms: 750, passed,
      semantic: { "pass-1": [assessed], "pass-1-existing": [existing], "pass-2": [assessed], "pass-2-existing": [existing] } },
  };
}

const pricing: PricingSnapshot = {
  fetched_at: "2026-09-09T00:00:00.000Z", source: "fallback", catalog_url: "fixture://pricing",
  assumptions: ["fixture list prices"], warnings: [],
  models: Object.fromEntries(["gpt-6-astra", "gpt-5.6-sol"].map(model => [model, {
    model_id: model, source: `fixture:${model}`, prompt: 0.000001, completion: 0.000002,
    input_cache_read: 0.0000001, input_cache_write: 0.00000125, overrides: [],
  }])),
};

async function usageSession(codexHome: string, id: string, model: string, base = 10): Promise<void> {
  const usage = { input_tokens: base, cached_input_tokens: 2, cache_write_input_tokens: 1, output_tokens: 4, reasoning_output_tokens: 2, total_tokens: base + 4 };
  const events = [
    { type: "session_meta", payload: { id } },
    { type: "turn_context", payload: { model } },
    { type: "token_usage_record", payload: { thread_id: id, response_id: `response-${id}`, usage } },
    { type: "event_msg", payload: { type: "item_completed", item: { type: "CommandExecution", id: `command-${id}`, duration: { secs: 1, nanos: 0 } } } },
  ];
  await file(join(codexHome, "sessions", `${id}.jsonl`), `${events.map(event => JSON.stringify(event)).join("\n")}\n`);
}

async function fixtureRun(stockPassed = true, currentPassed = true): Promise<{ run: string; auth: string }> {
  const run = join(root, "run");
  await file(join(run, "control/task.md"), "Implement the requested behavior.\n");
  await file(join(run, "artifacts/stock/changes.patch"), "stock patch evidence\n");
  await file(join(run, "artifacts/current/changes.patch"), "current patch evidence\n");
  await file(join(run, "snapshots/stock/home/ubuntu/.codex/config.toml"), 'model = "gpt-6-astra"\n');
  await usageSession(join(run, "arms/stock/home/ubuntu/.codex"), "stock-agent", "gpt-6-astra", 20);
  await usageSession(join(run, "arms/current/home/ubuntu/.codex"), "current-agent", "gpt-6-astra", 30);
  const state: RunState = {
    schema_version: 1, id: "fixture-run", created_at: "2026-09-09T00:00:00.000Z", status: "complete",
    source: { path: "/source", base_commit: "base", base_tree: "tree", source_timestamp: 1, forbidden_commit: "future" },
    task: { path: "control/task.md", sha256: "task" },
    criteria: { path: "evaluator/criteria.json", sha256: "criteria",
      contract: { schema: "codex-ab.criteria.v1", task_sha256: "task",
        criteria: [{ id: "behavior", description: "Required behavior" }],
        preparation: "true", existing_tests: "true", qualification: "not-run" } },
    image: "codex-ab:test", image_id: "sha256:immutable-test-image",
    execution: { model: "gpt-6-astra", reasoning_effort: "medium", service_tier: "priority" },
    operator: { uid: 1000, gid: 1000 },
    resource_limits: { cpus: "2", memory: "4g" }, timeout_seconds: 5, snapshot_manifest: "snapshots/manifest.json",
    runtime_tools: { bun: "runtime/bun", bun_sha256: "bun", codex_source: "/codex", codex_version: "codex-cli 0.153.4", codex_sha256: "codex" },
    arms: { stock: { repository: "arms/stock/repo", home_template: "snapshots/stock/home/ubuntu" }, current: { repository: "arms/current/repo", home_template: "snapshots/current/home/ubuntu" } },
    arm_attempts: {
      stock: { codex_home: "arms/stock/home/ubuntu/.codex", container: "container-stock", started_at: "2026-09-09T00:00:00.000Z", finished_at: "2026-09-09T00:00:01.000Z", status: "stopped" },
      current: { codex_home: "arms/current/home/ubuntu/.codex", container: "container-current", started_at: "2026-09-09T00:00:00.000Z", finished_at: "2026-09-09T00:00:01.000Z", status: "stopped" },
    },
    pricing, results: { stock: armResult("stock", stockPassed), current: armResult("current", currentPassed) },
  };
  await writeState(run, state);
  const auth = join(root, "auth.json");
  await file(auth, "{}\n", 0o600);
  await chmod(auth, 0o600);
  return { run, auth };
}

function verdict(winner: "candidate-1" | "candidate-2" | "tie" | "none", rationale: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scores: {
      "candidate-1": { correctness: 5, completeness: 4, maintainability: 4, test_quality: 4 },
      "candidate-2": { correctness: 3, completeness: 3, maintainability: 3, test_quality: 3 },
    }, evidence: ["specific fixture observation"], issues: [], winner, rationale, ...extra,
  };
}

async function fixtureJudge(run: string, first: "candidate-1" | "candidate-2", second: "candidate-1" | "candidate-2"): Promise<JudgeReport> {
  const state = await readState(run);
  const orders: [ArmName, ArmName][] = [["stock", "current"], ["current", "stock"]];
  const passes = orders.map((order, index) => validateJudgePass(verdict(index === 0 ? first : second, "fixture assessment"), (index + 1) as 1 | 2, order, {
    "candidate-1": state.results![order[0]]!.grade!.passed,
    "candidate-2": state.results![order[1]]!.grade!.passed,
  }));
  const winners = passes.map(mappedWinner);
  const usageHomes = ["evaluator/judge/pass-1/.codex", "evaluator/judge/pass-2/.codex"];
  for (const [index, home] of usageHomes.entries()) await usageSession(join(run, home), `judge-${index}`, "gpt-5.6-sol");
  const report: JudgeReport = {
    status: "complete", started_at: "2026-09-09T00:00:02.000Z", finished_at: "2026-09-09T00:00:03.000Z",
    model: "gpt-5.6-sol", reasoning_effort: "high", service_tier: "priority", passes,
    agreement: winners[0] === winners[1], winner: winners[0] === winners[1] ? winners[0]! : "none",
    disagreement: winners[0] === winners[1] ? undefined : "stock versus current",
    usage_homes: usageHomes,
  };
  state.judge = report;
  await writeState(run, state);
  return report;
}

test("judge requires task-derived criteria instead of legacy source-only grading", async () => {
  const { run, auth } = await fixtureRun();
  const state = await readState(run);
  delete state.criteria;
  await writeState(run, state);
  await expect(judgeRun(run, auth)).rejects.toThrow("judge requires task-derived criteria");
  expect((await readState(run)).judge).toBeUndefined();
});

test("judge validation rejects schema errors and ineligible winners", () => {
  const order: [ArmName, ArmName] = ["stock", "current"];
  expect(() => validateJudgePass(verdict("candidate-1", "invalid", { surprise: true }), 1, order,
    { "candidate-1": true, "candidate-2": true })).toThrow("must contain exactly");
  expect(() => validateJudgePass(verdict("candidate-1", "ineligible"), 1, order,
    { "candidate-1": false, "candidate-2": false })).toThrow("required benchmark gates");
});

describe("report completion and winner eligibility", () => {
  test("allows the passing candidate to win when the other fully measured candidate fails", async () => {
    const { run, auth } = await fixtureRun(true, false);
    await fixtureJudge(run, "candidate-1", "candidate-2");
    const paths = await buildReport(run);
    const report = await Bun.file(paths.jsonPath).json();
    expect(report.gates_complete).toBe(true);
    expect(report.measurement_complete).toBe(true);
    expect(report.winner).toBe("stock");
    const markdown = await readFile(paths.markdownPath, "utf8");
    expect(markdown).toContain("priority service tier");
    for (const heading of ["input | cached input | cache write input | output | reasoning output | total | command seconds | estimated list-price API USD", "## Current minus stock", "## Pricing provenance", "### Judge usage by attempted pass", "not a subscription charge or invoice", "service tier is not modeled"]) expect(markdown).toContain(heading);

    const state = await readState(run);
    delete state.results?.current?.grade;
    await writeState(run, state);
    const incomplete = await buildReport(run);
    const incompleteReport = await Bun.file(incomplete.jsonPath).json();
    expect(incompleteReport.gates_complete).toBe(false);
    expect(incompleteReport.winner).toBe("none");
  });

  test("treats skipped grader placeholders as unexecuted while retaining an executed preparation failure", async () => {
    const { run } = await fixtureRun();
    const state = await readState(run);
    const skipped = { command: "not run", started_at: "2026-09-09T00:00:02.000Z", elapsed_ms: 0, exit_code: -1, stdout: "", stderr: "grading preparation failed" };
    state.results!.current!.grade = { preparation: command("prepare", 9), router_suite: skipped, elapsed_ms: 250, passed: false };
    state.judge = {
      status: "complete", started_at: "2026-09-09T00:00:02.000Z", finished_at: "2026-09-09T00:00:03.000Z",
      model: "gpt-5.6-sol", reasoning_effort: "medium", passes: [], agreement: true, winner: "stock", usage_homes: [],
    };
    await writeState(run, state);
    const paths = await buildReport(run);
    const report = await Bun.file(paths.jsonPath).json();
    expect(report.gates_complete).toBe(false);
    expect(report.measurement_complete).toBe(false);
    expect(report.winner).toBe("none");
    expect(report.judge.result.reasoning_effort).toBe("medium");
    expect(report.judge.result.service_tier).toBeUndefined();
  });

  test("meters an attempted arm even when no result was collected", async () => {
    const { run } = await fixtureRun();
    const state = await readState(run);
    state.status = "partial";
    delete state.results!.current;
    await writeState(run, state);
    const paths = await buildReport(run);
    const report = await Bun.file(paths.jsonPath).json();
    expect(report.arms.current.result).toBeNull();
    expect(report.arms.current.attempt.status).toBe("stopped");
    expect(report.arms.current.usage.totals.total_tokens).toBe(34);
  expect(report.winner).toBe("none");
});


  test("retains reversed-pass disagreement without forcing an overall winner", async () => {
    const { run, auth } = await fixtureRun();
    const judge = await fixtureJudge(run, "candidate-1", "candidate-1");
    expect(judge.agreement).toBe(false);
    expect(judge.winner).toBe("none");
    expect(judge.disagreement).toContain("stock versus current");
    const paths = await buildReport(run);
    const report = await Bun.file(paths.jsonPath).json();
    expect(report.measurement_complete).toBe(true);
    expect(report.winner).toBe("none");
    expect(report.judge.result.disagreement).toContain("stock versus current");
  });

  test("marks infrastructure-invalid runs prominently without discarding measured evidence", async () => {
    const { run, auth } = await fixtureRun();
    await fixtureJudge(run, "candidate-1", "candidate-2");
    const validPaths = await buildReport(run);
    const validReport = await Bun.file(validPaths.jsonPath).json();
    expect(validReport.validity).toBe("valid");
    expect(validReport.winner).toBe("stock");

    const reasons = ["missing code-mode host prevented tool execution", "runner prewarm mutated shared_core.wasm"];
    await invalidateRun(run, reasons);
    const invalidState = await readState(run);
    expect(invalidState.invalidity_reasons).toEqual(reasons);
    await expect(judgeRun(run, auth)).rejects.toThrow("infrastructure-invalid run");

    const invalidPaths = await buildReport(run);
    const invalidReport = await Bun.file(invalidPaths.jsonPath).json();
    expect(invalidReport.validity).toBe("invalid");
    expect(invalidReport.invalidity_reasons).toEqual(reasons);
    expect(invalidReport.checks_executed).toBe(true);
    expect(invalidReport.gates_complete).toBe(false);
    expect(invalidReport.measurement_complete).toBe(false);
    expect(invalidReport.winner).toBe("none");
    expect(invalidReport.arms.stock.usage.totals).toEqual(validReport.arms.stock.usage.totals);
    expect(invalidReport.judge.usage.totals).toEqual(validReport.judge.usage.totals);
    const markdown = await readFile(invalidPaths.markdownPath, "utf8");
    expect(markdown).toContain("**Infrastructure validity: INVALID**");
    expect(markdown).toContain(reasons[0]);
    expect(markdown).toContain(reasons[1]);
    expect(markdown).toContain("Measurements are retained, but gates, completion, and winner are suppressed.");
  });
});

test("stock singleton reports executed checks and complete root plus child usage without a winner", async () => {
  const { run } = await fixtureRun();
  const state = await readState(run);
  state.selected_arms = ["stock"];
  delete state.results!.current;
  delete state.arm_attempts!.current;
  await usageSession(join(run, "arms/stock/home/ubuntu/.codex"), "stock-child", "gpt-6-astra", 40);
  await writeState(run, state);
  const paths = await buildReport(run);
  const report = JSON.parse(await readFile(paths.jsonPath, "utf8"));
  expect(report.checks_executed).toBe(true);
  expect(report.arm_usage_complete).toBe(true);
  expect(report.arms.stock.usage.agents).toHaveLength(2);
  expect(report.arms.stock.usage.totals.input_tokens).toBe(60);
  expect(report.measurement_complete).toBe(false);
  expect(report.winner).toBe("none");
});

test("report exports one self-contained Markdown without modifying historical state or reports", async () => {
  const { run } = await fixtureRun();
  await file(join(run, "control/task.md"), "Implement the requested behavior.\nKeep it local.\n");
  await file(join(run, "reports/report.md"), "original report");
  const stateBefore = await readFile(join(run, "run.json"), "utf8");
  const directory = join(root, "export");
  const result = Bun.spawn([process.execPath, resolve(import.meta.dir, "cli.ts"), "report", "--run-dir", run, "--output-dir", directory], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(result.stdout).text();
  expect(await result.exited).toBe(0);
  expect(stdout).toBe(`${join(directory, "report.md")}\n`);
  const markdown = await readFile(join(directory, "report.md"), "utf8");
  for (const text of ["## Why the observed workflow added work", "## Task and setup", "> Implement the requested behavior.", "## Check details", "## Programmatic performance breakdown", "## Judge"]) expect(markdown).toContain(text);
  expect(markdown).toContain("> Implement the requested behavior.\n> Keep it local.");
  expect(markdown).not.toMatch(/\]\([^)]*(?:ANALYSIS|PERFORMANCE|SOURCE-REVIEW|COMPARISON)\.md\)/);
  expect(await readFile(join(run, "run.json"), "utf8")).toBe(stateBefore);
  expect(await readFile(join(run, "reports/report.md"), "utf8")).toBe("original report");
  expect((await Bun.file(join(directory, "report.json")).json()).workflow_mechanisms).toBeDefined();
  await expect(buildReport(run, { outputDirectory: join(run, "export") })).rejects.toThrow("outside the source run");
});

test("supplied source assessments are rescored and rendered inline without replacing the official judge", async () => {
  const { run } = await fixtureRun();
  const input = join(root, "assessments.json");
  const passes = [
    { presentation: ["stock", "current"], response: verdict("candidate-1", "first assessment evidence") },
    { presentation: ["current", "stock"], response: verdict("candidate-1", "second assessment evidence") },
  ];
  await file(input, JSON.stringify({ passes }));
  const before = await readFile(join(run, "run.json"), "utf8");
  const paths = await buildReport(run, { outputDirectory: join(root, "export"), sourceAssessmentsFile: input });
  const report = await Bun.file(paths.jsonPath).json();
  expect(report.supplied_source_assessments.agreement).toBe(false);
  expect(report.supplied_source_assessments.passes[0].scores["candidate-1"].weighted_total).toBe(90);
  expect(report.judge).toBeNull();
  expect(report.winner).toBe("none");
  const markdown = await readFile(paths.markdownPath, "utf8");
  expect(markdown).toContain("no consistent source-quality winner is established");
  expect(markdown).toContain("first assessment evidence");
  expect(markdown).toContain("second assessment evidence");
  expect(await readFile(join(run, "run.json"), "utf8")).toBe(before);
  passes[1]!.presentation = ["stock", "current"];
  await file(input, JSON.stringify({ passes }));
  await expect(buildReport(run, { outputDirectory: join(root, "bad-export"), sourceAssessmentsFile: input })).rejects.toThrow("reverse presentation");
});

test("report export preserves the source through directory aliases and linked output files", async () => {
  const { run } = await fixtureRun();
  await file(join(run, "reports/report.md"), "original markdown");
  await file(join(run, "reports/report.json"), "original json");
  const alias = join(root, "report-alias");
  await symlink(join(run, "reports"), alias);
  await expect(buildReport(run, { outputDirectory: alias })).rejects.toThrow("outside the source run");
  const parentAlias = join(root, "run-alias");
  await symlink(run, parentAlias);
  await expect(buildReport(run, { outputDirectory: join(parentAlias, "new-report") })).rejects.toThrow("outside the source run");
  const output = join(root, "safe-export");
  await mkdir(output);
  await symlink(join(run, "reports/report.md"), join(output, "report.md"));
  await link(join(run, "reports/report.json"), join(output, "report.json"));
  await buildReport(run, { outputDirectory: output });
  expect(await readFile(join(run, "reports/report.md"), "utf8")).toBe("original markdown");
  expect(await readFile(join(run, "reports/report.json"), "utf8")).toBe("original json");
  expect(await readFile(join(output, "report.md"), "utf8")).toContain("## Task and setup");
});

test("rejected semantic response remains available without another model request", async () => {
  const { run } = await fixtureRun(false, false);
  const state = await readState(run);
  state.judge = {
    status: "failed", started_at: "2026-09-09T00:00:02.000Z", model: "gpt-5.6-sol",
    reasoning_effort: "high", passes: [], winner: "none", usage_homes: [], failed_pass: 2,
    error: "incomplete per-criterion assessment",
    attempts: [{ pass: 2, stage: "assessment", attempt: 1, status: "complete", started_at: "2026-09-09T00:00:02.000Z",
      stdout_path: "evaluator/judge/pass-2-assessment.jsonl", stderr_path: "evaluator/judge/stderr", usage_home: "evaluator/judge/home" }],
  };
  await file(join(run, "evaluator/judge/pass-2-assessment.jsonl"), JSON.stringify({ type: "item.completed",
    item: { type: "agent_message", text: JSON.stringify(verdict("candidate-1", "source observations remain useful")) } }));
  await writeState(run, state);
  const { jsonPath } = await buildReport(run);
  const report = JSON.parse(await readFile(jsonPath, "utf8"));
  expect(report.winner).toBe("none");
  expect(report.rejected_source_assessment.pass).toBe(2);
  expect(report.rejected_source_assessment.response.rationale).toBe("source observations remain useful");
  expect(report.judge_complete).toBe(false);
});

test("a later covered semantic pass cannot hide earlier unassessed criteria", async () => {
  const { run } = await fixtureRun();
  const state = await readState(run);
  state.criteria = { path: "evaluator/criteria.json", sha256: "criteria",
    contract: { schema: "codex-ab.criteria.v1", task_sha256: state.task.sha256,
      criteria: [{ id: "behavior", description: "Required behavior" }], preparation: "true", existing_tests: "true", qualification: "not-run" } };
  for (const arm of ["stock", "current"] as const) {
    const passed = { criterion: "behavior", status: "pass" as const, basis: "executed" as const, reasoning: "Executed" };
    state.results![arm]!.grade!.semantic = {
      "pass-1": [{ ...passed, status: "unassessed" }], "pass-1-existing": [passed],
      "pass-2": [passed], "pass-2-existing": [passed],
    };
  }
  await writeState(run, state);
  const result = await buildReport(run);
  const report = JSON.parse(await readFile(result.jsonPath, "utf8"));
  expect(report.checks_executed).toBe(false);
  const markdown = await readFile(result.markdownPath, "utf8");
  expect(markdown).toContain("| stock | unassessed |");
  expect(markdown).toContain("| current | unassessed |");
  expect(report.measurement_complete).toBe(false);
  expect(report.winner).toBe("none");
});

test("conclusive source-only interface failures do not hide completed assessment", async () => {
  const { run } = await fixtureRun(false, true);
  const state = await readState(run);
  state.criteria = { path: "evaluator/criteria.json", sha256: "criteria",
    contract: { schema: "codex-ab.criteria.v1", task_sha256: state.task.sha256,
      criteria: [{ id: "behavior", description: "Required behavior", required_interface: "export add" }],
      preparation: "true", existing_tests: "true", qualification: "not-run" } };
  for (const arm of ["stock", "current"] as const) {
    const executed = { criterion: "behavior", status: "pass" as const, basis: "executed" as const, reasoning: "Executed" };
    const assessed = arm === "stock" ? { ...executed, status: "fail" as const, basis: "source-only" as const, reasoning: "Required export absent" } : executed;
    state.results![arm]!.grade!.semantic = {
      "pass-1": [assessed], "pass-1-existing": [executed],
      "pass-2": [assessed], "pass-2-existing": [executed],
    };
  }
  await writeState(run, state);
  const result = await buildReport(run);
  const report = JSON.parse(await readFile(result.jsonPath, "utf8"));
  expect(report.checks_executed).toBe(true);
});

test("semantic criteria and existing checks complete grading without synthetic command evidence", async () => {
  const { run } = await fixtureRun();
  const state = await readState(run);
  state.criteria = { path: "evaluator/criteria.json", sha256: "criteria",
    contract: { schema: "codex-ab.criteria.v1", task_sha256: state.task.sha256,
      criteria: [{ id: "behavior", description: "Required behavior" }],
      preparation: "true", existing_tests: "true", qualification: "not-run" } };
  for (const arm of ["stock", "current"] as const) {
    const executed = { criterion: "behavior", status: "pass" as const, basis: "executed" as const,
      reasoning: "Adaptive behavioral assertion passed", execution: command("node --test") };
    state.results![arm]!.grade!.semantic = {
      "pass-1": [executed], "pass-1-existing": [{ ...executed, criterion: "__existing_tests" }],
      "pass-2": [executed], "pass-2-existing": [{ ...executed, criterion: "__existing_tests" }],
    };
  }
  await writeState(run, state);
  await fixtureJudge(run, "candidate-1", "candidate-2");
  const paths = await buildReport(run);
  const report = JSON.parse(await readFile(paths.jsonPath, "utf8"));
  expect(report.checks_executed).toBe(true);
  expect(report.measurement_complete).toBe(true);
  expect(report.winner).toBe("stock");
  expect(report.arms.stock.result.grade.semantic["pass-1"][0].execution.command).toBe("node --test");
  expect(Object.keys(report.arms.stock.result.grade).sort()).toEqual(["elapsed_ms", "passed", "preparation", "router_suite", "semantic"]);
});

test("historical records without semantic criteria remain descriptive despite stored stale judges", async () => {
  const { run } = await fixtureRun();
  await fixtureJudge(run, "candidate-1", "candidate-2");
  const statePath = join(run, "run.json");
  const historical = JSON.parse(await readFile(statePath, "utf8"));
  delete historical.criteria;
  for (const arm of ["stock", "current"]) delete historical.results[arm].grade.semantic;
  historical.regrade = { status: "complete", judge_stale: true };
  await writeFile(statePath, JSON.stringify(historical));
  const before = await readFile(statePath, "utf8");
  const paths = await buildReport(run);
  const report = JSON.parse(await readFile(paths.jsonPath, "utf8"));
  expect(report.checks_executed).toBe(false);
  expect(report.gates_complete).toBe(false);
  expect(report.measurement_complete).toBe(false);
  expect(report.winner).toBe("none");
  expect(report.judge.result.winner).toBe("stock");
  expect(report.arms.stock.usage.totals.total_tokens).toBe(24);
  expect(await readFile(paths.markdownPath, "utf8")).toContain("Historical measurements are descriptive only");
  expect(await readFile(statePath, "utf8")).toBe(before);
});
