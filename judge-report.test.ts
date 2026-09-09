import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { judgeRun } from "./judge";
import { buildReport, invalidateRun } from "./report";
import { readState, writeState } from "./state";
import type { ArmName, ArmResult, CommandEvidence, RunState } from "./types";
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
  return {
    arm, anonymous_id: arm === "stock" ? "candidate-1" : "candidate-2", container: `container-${arm}`,
    started_at: "2026-09-09T00:00:00.000Z", finished_at: "2026-09-09T00:00:01.000Z", agent_elapsed_ms: arm === "stock" ? 1000 : 1250,
    exit_code: 0, timed_out: false, canceled: false, patch_path: `artifacts/${arm}/changes.patch`, stdout_path: `artifacts/${arm}/codex.jsonl`, stderr_path: `artifacts/${arm}/codex.stderr`,
    changed_files: [`${arm}.ts`],
    grade: { preparation: command("prepare"), acceptance: command("acceptance", passed ? 0 : 1), router_suite: command("router", 0), elapsed_ms: 750, passed },
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
    task: { path: "control/task.md", sha256: "task" }, acceptance: { path: "evaluator/acceptance.go", sha256: "acceptance" },
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

async function fakeDocker(responses: Record<number, Record<string, unknown>>, failures: number[] = [], cancelPass?: number, cancelCreatePass?: number): Promise<{ path: string; log: string }> {
  const directory = join(root, `fake-${Math.random().toString(16).slice(2)}`);
  await mkdir(directory, { recursive: true });
  const log = join(directory, "calls.jsonl");
  await file(join(directory, "config.json"), JSON.stringify({ responses, failures, cancelPass, cancelCreatePass }));
  const path = join(directory, "docker.ts");
  await file(path, `#!/usr/bin/env bun
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
const dir = import.meta.dir;
const args = process.argv.slice(2);
await appendFile(join(dir, "calls.jsonl"), JSON.stringify(args) + "\\n");
const config = JSON.parse(await readFile(join(dir, "config.json"), "utf8"));
if (args[0] === "container" && args[1] === "inspect") {
  const name = args.at(-1);
  const statePath = join(dir, "container-" + name + ".json");
  if (await Bun.file(statePath).exists()) {
    const state = JSON.parse(await readFile(statePath, "utf8"));
    process.stdout.write(args.includes("--format") && args[args.indexOf("--format") + 1].includes("codex-ab.owner") ? state.owner + "\\n" : "fixture-id\\n");
    process.exit(0);
  }
  process.stderr.write("Error: No such container: " + name + "\\n");
  process.exit(1);
}
if (args[0] === "rm") {
  await rm(join(dir, "container-" + args.at(-1) + ".json"), { force: true });
  process.exit(0);
}
if (args[0] === "create") {
  const countPath = join(dir, "count");
  let count = 0;
  try { count = Number(await readFile(countPath, "utf8")); } catch {}
  count += 1;
  await writeFile(countPath, String(count));
  const name = args[args.indexOf("--name") + 1];
  const mounts = args.flatMap((arg, index) => args[index - 1] === "-v" ? [arg] : []);
  await writeFile(join(dir, "mounts-" + count + ".json"), JSON.stringify(mounts));
  const homeMount = mounts.find(value => value.endsWith(":/home/ubuntu"));
  if (!homeMount) process.exit(90);
  const owner = args[args.indexOf("--label") + 1].split("=").slice(1).join("=");
  await writeFile(join(dir, "container-" + name + ".json"), JSON.stringify({ count, home: homeMount.slice(0, -":/home/ubuntu".length), owner }));
  if (config.cancelCreatePass === count) { process.kill(process.ppid, "SIGTERM"); await Bun.sleep(200); process.exit(7); }
  process.stdout.write(name + "\\n");
  process.exit(0);
}
if (args[0] !== "start") process.exit(91);
const record = JSON.parse(await readFile(join(dir, "container-" + args.at(-1) + ".json"), "utf8"));
const count = record.count;
const home = record.home;
const input = await Bun.stdin.text();
await writeFile(join(dir, "prompt-" + count + ".txt"), input);
const usage = { input_tokens: 12, cached_input_tokens: 2, cache_write_input_tokens: 1, output_tokens: 4, reasoning_output_tokens: 2, total_tokens: 16 };
const events = [
  { type: "session_meta", payload: { id: "judge-" + count } },
  { type: "turn_context", payload: { model: "gpt-5.6-sol" } },
  { type: "token_usage_record", payload: { thread_id: "judge-" + count, response_id: "judge-response-" + count, usage } },
];
await mkdir(join(home, ".codex/sessions"), { recursive: true });
await writeFile(join(home, ".codex/sessions/judge.jsonl"), events.map(event => JSON.stringify(event)).join("\\n") + "\\n");
if (config.cancelPass === count) { process.kill(process.ppid, "SIGTERM"); await Bun.sleep(200); process.exit(7); }
if (config.failures.includes(count)) process.exit(7);
const response = config.responses[String(count)];
process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(response) } }) + "\\n");
`, 0o755);
  await chmod(path, 0o755);
  return { path, log };
}

describe("judge isolation and immutable progress", () => {
  test("uses a strict read-only schema, isolated homes, and exact reversed mapping", async () => {
    const { run, auth } = await fixtureRun();
    const fake = await fakeDocker({ 1: verdict("candidate-1", "verdict-one-secret"), 2: verdict("candidate-2", "second pass") });
    const report = await judgeRun(run, auth, fake.path);
    expect(report.status).toBe("complete");
    expect(report.model).toBe("gpt-5.6-sol");
    expect(report.reasoning_effort).toBe("high");
    expect(report.service_tier).toBe("priority");
    expect(report.winner).toBe("stock");
    expect(report.passes.map(pass => pass.presentation)).toEqual([["stock", "current"], ["current", "stock"]]);
    expect(await readFile(join(fake.path, "../prompt-2.txt"), "utf8")).not.toContain("verdict-one-secret");
    const mounts1 = JSON.parse(await readFile(join(fake.path, "../mounts-1.json"), "utf8")) as string[];
    const mounts2 = JSON.parse(await readFile(join(fake.path, "../mounts-2.json"), "utf8")) as string[];
    expect(mounts1.some(mount => mount.endsWith(":/output") || mount.endsWith(":/output:ro"))).toBe(false);
    expect(mounts2.some(mount => mount.endsWith(":/output") || mount.endsWith(":/output:ro"))).toBe(false);
    expect(mounts1.find(mount => mount.endsWith(":/home/ubuntu"))).not.toBe(mounts2.find(mount => mount.endsWith(":/home/ubuntu")));
    expect(mounts2.some(mount => mount.endsWith(":/tmp/judge-output-schema.json:ro"))).toBe(true);
    const calls = (await readFile(fake.log, "utf8")).trim().split("\n").map(line => JSON.parse(line) as string[][][number]);
    const firstCreate = calls.find(call => call[0] === "create")!;
    expect(firstCreate).toContain("--output-schema");
    expect(firstCreate).toContain("sha256:immutable-test-image");
    expect(firstCreate).toContain('model_reasoning_effort="high"');
    expect(firstCreate).toContain('service_tier="fast"');
  });

  for (const failedPass of [1, 2]) {
    test(`persists pass ${failedPass} failure, meters its paid attempt, and refuses rerun`, async () => {
      const { run, auth } = await fixtureRun();
      const fake = await fakeDocker({ 1: verdict("candidate-1", "first") }, [failedPass]);
      await expect(judgeRun(run, auth, fake.path)).rejects.toThrow(`pass ${failedPass} failed`);
      const state = await readState(run);
      expect(state.judge?.status).toBe("failed");
      expect(state.judge?.usage_homes).toHaveLength(failedPass);
      expect(state.judge?.passes).toHaveLength(failedPass - 1);
      await expect(judgeRun(run, auth, fake.path)).rejects.toThrow("cannot be resumed or retried");
      const paths = await buildReport(run);
      const json = await Bun.file(paths.jsonPath).json();
      expect(json.judge.attempts).toHaveLength(failedPass);
      expect(json.judge.usage.totals.total_tokens).toBe(16 * failedPass);
      expect(json.winner).toBe("none");
      expect(await readFile(paths.markdownPath, "utf8")).toContain(`Status: **failed**`);
    });
  }

  test("records cancellation and removes only the active session-created judge container", async () => {
    const { run, auth } = await fixtureRun();
    const fake = await fakeDocker({}, [], 1);
    const driver = join(root, "cancel-driver.ts");
    await file(driver, `import { judgeRun } from ${JSON.stringify(resolve(import.meta.dir, "judge.ts"))};\ntry { await judgeRun(process.argv[2], process.argv[3], process.argv[4]); } catch (error) { process.stderr.write(String(error)); }\n`);
    const child = Bun.spawn([process.execPath, driver, run, auth, fake.path], { stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(0);
    const state = await readState(run);
    expect(state.judge?.status).toBe("canceled");
    expect(state.judge?.usage_homes).toHaveLength(1);
    const calls = (await readFile(fake.log, "utf8")).trim().split("\n").map(line => JSON.parse(line) as string[]);
    expect(calls).toContainEqual(["rm", "--force", "codex-ab-fixture-run-judge-1"]);
    expect(calls.filter(call => call[0] === "rm")).toHaveLength(1);
    expect(calls.some(call => call[0] === "container" && call[1] === "inspect" && call.at(-1) === "codex-ab-fixture-run-judge-1")).toBe(true);
  });

  test("does not start paid inference when cancellation lands at the create/start boundary", async () => {
    const { run, auth } = await fixtureRun();
    const fake = await fakeDocker({}, [], undefined, 1);
    const driver = join(root, "pre-launch-cancel-driver.ts");
    await file(driver, `import { judgeRun } from ${JSON.stringify(resolve(import.meta.dir, "judge.ts"))};\ntry { await judgeRun(process.argv[2], process.argv[3], process.argv[4]); } catch (error) { process.stderr.write(String(error)); }\n`);
    const child = Bun.spawn([process.execPath, driver, run, auth, fake.path], { stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(0);
    const state = await readState(run);
    expect(state.judge?.status).toBe("canceled");
    const calls = (await readFile(fake.log, "utf8")).trim().split("\n").map(line => JSON.parse(line) as string[]);
    expect(calls.filter(call => call[0] === "start")).toHaveLength(0);
    expect(calls).toContainEqual(["rm", "--force", "codex-ab-fixture-run-judge-1"]);
  });

  test("rejects schema-invalid output without coercion", async () => {
    const { run, auth } = await fixtureRun();
    const fake = await fakeDocker({ 1: verdict("candidate-1", "invalid", { surprise: true }) });
    await expect(judgeRun(run, auth, fake.path)).rejects.toThrow("must contain exactly");
    const state = await readState(run);
    expect(state.judge?.status).toBe("failed");
    expect(state.judge?.passes).toHaveLength(0);
  });
});

describe("report completion and winner eligibility", () => {
  test("allows the passing candidate to win when the other fully measured candidate fails", async () => {
    const { run, auth } = await fixtureRun(true, false);
    const fake = await fakeDocker({ 1: verdict("candidate-1", "stock passes"), 2: verdict("candidate-2", "stock remains best") });
    await judgeRun(run, auth, fake.path);
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
    state.results!.current!.grade = { preparation: command("prepare", 9), acceptance: skipped, router_suite: skipped, elapsed_ms: 250, passed: false };
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
    const fake = await fakeDocker({ 1: verdict("candidate-1", "first presentation"), 2: verdict("candidate-1", "reversed presentation") });
    const judge = await judgeRun(run, auth, fake.path);
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
    const fake = await fakeDocker({ 1: verdict("candidate-1", "stock wins"), 2: verdict("candidate-2", "stock wins reversed") });
    await judgeRun(run, auth, fake.path);
    const validPaths = await buildReport(run);
    const validReport = await Bun.file(validPaths.jsonPath).json();
    expect(validReport.validity).toBe("valid");
    expect(validReport.winner).toBe("stock");

    const reasons = ["missing code-mode host prevented tool execution", "runner prewarm mutated shared_core.wasm"];
    await invalidateRun(run, reasons);
    const invalidState = await readState(run);
    expect(invalidState.invalidity_reasons).toEqual(reasons);
    await expect(judgeRun(run, auth, fake.path)).rejects.toThrow("infrastructure-invalid run");

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
