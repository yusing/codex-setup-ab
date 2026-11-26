import { describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { armRuntime, parseArmSettings } from "./arm-settings";
import { launchConfiguration } from "./launch";
import { buildReport } from "./report";
import {
  normalizeErrorSignature,
  normalizeRunawayGuardConfig,
  RunawayGuardMonitor,
  startRunawayGuard,
} from "./runaway-guard";
import { containerArgs } from "./runner";
import { DEFAULT_PIDS_LIMIT, type RunState } from "./types";

describe("pids_limit configuration and containerArgs", () => {
  test("containerArgs defaults to 512 for legacy states without pids_limit and honors explicit overrides", () => {
    const legacy = { resource_limits: { cpus: "2", memory: "4g" } } as RunState;
    expect(containerArgs(legacy)).toEqual(["--cpus", "2", "--memory", "4g", "--pids-limit", String(DEFAULT_PIDS_LIMIT)]);

    const custom = { resource_limits: { cpus: "4", memory: "8g", pids_limit: 256 } } as RunState;
    expect(containerArgs(custom)).toEqual(["--cpus", "4", "--memory", "8g", "--pids-limit", "256"]);
  });

  test("armRuntime preserves run-level pids_limit and supports per-arm override", () => {
    const base = {
      execution: { model: "gpt-6.2-sol", reasoning_effort: "medium", service_tier: "default" },
      resource_limits: { cpus: "2", memory: "4g", pids_limit: 256 },
      timeout_seconds: 1800,
      arm_settings: parseArmSettings({ stock: { cpus: "4" }, current: { pids_limit: 128 } }, ["stock", "current"]),
    } as unknown as RunState;

    expect(armRuntime(base, "stock").resource_limits).toEqual({ cpus: "4", memory: "4g", pids_limit: 256 });
    expect(armRuntime(base, "current").resource_limits).toEqual({ cpus: "2", memory: "4g", pids_limit: 128 });
    expect(() => parseArmSettings({ stock: { pids_limit: 15 } }, ["stock"])).toThrow(/Invalid PID limit/);
    expect(() => parseArmSettings({ stock: { pids_limit: 16.5 } }, ["stock"])).toThrow(/Invalid PID limit/);
  });

  test("launchConfiguration validates --pids-limit and runaway guard CLI options", () => {
    const ok = launchConfiguration({
      preset: "stock-current",
      task: "gin-context-copy",
      "pids-limit": "256",
      "max-turns": "12",
      "max-total-tokens": "500000",
      "stuck-loop-limit": "4",
      "current-home": "/tmp",
    });
    expect(ok.prepare.pidsLimit).toBe(256);
    expect(ok.prepare.runawayGuard).toEqual({ max_turns: 12, max_total_tokens: 500000, repeated_error_limit: 4 });

    expect(() => launchConfiguration({ preset: "stock-current", task: "gin-context-copy", "pids-limit": "8", "current-home": "/tmp" })).toThrow(/--pids-limit/);
    expect(() => launchConfiguration({ preset: "stock-current", task: "gin-context-copy", "pids-limit": "abc", "current-home": "/tmp" })).toThrow(/--pids-limit/);
    expect(() => launchConfiguration({ preset: "stock-current", task: "gin-context-copy", "max-turns": "0", "current-home": "/tmp" })).toThrow(/--max-turns/);
    expect(() => launchConfiguration({ preset: "stock-current", task: "gin-context-copy", "max-total-tokens": "-5", "current-home": "/tmp" })).toThrow(/--max-total-tokens/);
    expect(() => launchConfiguration({ preset: "stock-current", task: "gin-context-copy", "stuck-loop-limit": "-1", "current-home": "/tmp" })).toThrow(/--stuck-loop-limit/);

    const disabledLoop = launchConfiguration({
      preset: "stock-current",
      task: "gin-context-copy",
      "stuck-loop-limit": "0",
      "current-home": "/tmp",
    });
    expect(disabledLoop.prepare.runawayGuard).toBeUndefined();
  });
});

describe("RunawayGuardMonitor", () => {
  test("triggers on max_turns exceeded and allows completing exactly max_turns", () => {
    const monitor = new RunawayGuardMonitor({ max_turns: 2 });
    expect(monitor.consumeLine(JSON.stringify({ type: "turn.started" }))).toBeUndefined();
    expect(monitor.consumeLine(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 50 } }))).toBeUndefined();
    expect(monitor.consumeLine(JSON.stringify({ type: "turn.started" }))).toBeUndefined();
    expect(monitor.consumeLine(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 50 } }))).toBeUndefined();
    expect(monitor.triggered).toBeUndefined();

    const trigger = monitor.consumeLine(JSON.stringify({ type: "turn.started" }));
    expect(trigger).toMatchObject({ triggered: true, reason: "max_turns", observed: 3, limit: 2 });
  });

  test("triggers on max_total_tokens from per-turn usage and cumulative token_count without double-counting", () => {
    const perTurn = new RunawayGuardMonitor({ max_total_tokens: 1000 });
    expect(perTurn.consumeLine(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 400, output_tokens: 200 } }))).toBeUndefined();
    expect(perTurn.observedTokens).toBe(600);
    const trigger = perTurn.consumeLine(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 350, output_tokens: 100 } }));
    expect(trigger).toMatchObject({ triggered: true, reason: "max_total_tokens", observed: 1050, limit: 1000 });

    const cumulative = new RunawayGuardMonitor({ max_total_tokens: 500 });
    expect(cumulative.consumeLine(JSON.stringify({
      type: "event_msg",
      payload: { type: "token_count", info: { total_token_usage: { input_tokens: 200, output_tokens: 100, total_tokens: 300 } } },
    }))).toBeUndefined();
    expect(cumulative.consumeLine(JSON.stringify({
      type: "event_msg",
      payload: { type: "token_count", info: { total_token_usage: { input_tokens: 250, output_tokens: 150, total_tokens: 400 } } },
    }))).toBeUndefined();
    expect(cumulative.observedTokens).toBe(400);
    const cumTrigger = cumulative.consumeLine(JSON.stringify({
      type: "event_msg",
      payload: { type: "token_count", info: { total_token_usage: { input_tokens: 400, output_tokens: 150, total_tokens: 550 } } },
    }));
    expect(cumTrigger).toMatchObject({ triggered: true, reason: "max_total_tokens", observed: 550, limit: 500 });
  });

  test("detects consecutive identical errors and resets streak on success or different error", () => {
    const monitor = new RunawayGuardMonitor({ repeated_error_limit: 3 });
    expect(monitor.consumeLine(JSON.stringify({ type: "error", message: "2026-11-27T01:00:00Z Failed at 0xdeadbeef: permission denied" }))).toBeUndefined();
    expect(monitor.consumeLine(JSON.stringify({ type: "error", message: "2026-11-27T01:00:05Z Failed at 0x1234abcd:   permission denied" }))).toBeUndefined();
    expect(monitor.observedConsecutiveErrors).toBe(2);

    expect(monitor.consumeLine(JSON.stringify({
      type: "item.completed",
      item: { type: "command_execution", command: "go test ./...", exit_code: 0, status: "completed" },
    }))).toBeUndefined();
    expect(monitor.observedConsecutiveErrors).toBe(0);

    const failingCmd = JSON.stringify({
      type: "item.completed",
      item: { type: "command_execution", command: "npm test", exit_code: 1, status: "failed", aggregated_output: "Error: module not found" },
    });
    expect(monitor.consumeLine(failingCmd)).toBeUndefined();
    expect(monitor.consumeLine(failingCmd)).toBeUndefined();
    const trigger = monitor.consumeLine(failingCmd);
    expect(trigger).toMatchObject({ triggered: true, reason: "repeated_error_loop", observed: 3, limit: 3 });
  });

  test("normalizes timestamps, hex addresses, and whitespace consistently", () => {
    const a = normalizeErrorSignature("2026-11-27T01:02:03.456Z   Crash at 0x7fff1234\n  line two");
    const b = normalizeErrorSignature("2026-11-27 09:08:07 Crash at 0x0000cafe\r\nline   two");
    expect(a).toBe(b);
  });

  test("normalizeRunawayGuardConfig drops disabled limits and rejects invalid ones", () => {
    expect(normalizeRunawayGuardConfig({ repeated_error_limit: 0 })).toBeUndefined();
    expect(normalizeRunawayGuardConfig({ max_turns: 5, repeated_error_limit: 0 })).toEqual({ max_turns: 5 });
    expect(() => normalizeRunawayGuardConfig({ max_turns: 0 })).toThrow(/--max-turns/);
    expect(() => normalizeRunawayGuardConfig({ max_total_tokens: -1 })).toThrow(/--max-total-tokens/);
    expect(() => normalizeRunawayGuardConfig({ repeated_error_limit: -1 })).toThrow(/--stuck-loop-limit/);
  });

  test("does not trigger on a normal multi-turn stream within limits", () => {
    const monitor = new RunawayGuardMonitor({ max_turns: 5, max_total_tokens: 10_000, repeated_error_limit: 3 });
    const events = [
      { type: "turn.started" },
      { type: "item.completed", item: { type: "command_execution", command: "bun test", exit_code: 1, aggregated_output: "1 failing" } },
      { type: "turn.completed", usage: { input_tokens: 500, output_tokens: 200 } },
      { type: "turn.started" },
      { type: "item.completed", item: { type: "command_execution", command: "bun test", exit_code: 0, status: "completed" } },
      { type: "turn.completed", usage: { input_tokens: 600, output_tokens: 250 } },
    ];
    for (const event of events) {
      expect(monitor.consumeLine(JSON.stringify(event))).toBeUndefined();
    }
    expect(monitor.triggered).toBeUndefined();
    expect(monitor.observedTurns).toBe(2);
    expect(monitor.observedTokens).toBe(1550);
  });
});

describe("startRunawayGuard file-tailing watchdog", () => {
  test("tails incrementally appended JSONL including partial lines and aborts controller", async () => {
    const dir = await mkdtemp(join(tmpdir(), "runaway-guard-test-"));
    try {
      const stdoutPath = join(dir, "codex.jsonl");
      const controller = new AbortController();
      const guard = startRunawayGuard({
        stdoutPath,
        config: { max_turns: 2 },
        controller,
        pollIntervalMs: 30,
      });

      const line1 = JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } });
      await writeFile(stdoutPath, line1.slice(0, 20));
      await Bun.sleep(60);
      expect(controller.signal.aborted).toBe(false);

      await appendFile(stdoutPath, line1.slice(20) + "\n" + JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }) + "\n");
      await Bun.sleep(80);
      expect(controller.signal.aborted).toBe(false);

      await appendFile(stdoutPath, JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }) + "\n");
      const deadline = Date.now() + 2000;
      while (!controller.signal.aborted && Date.now() < deadline) {
        await Bun.sleep(25);
      }
      const triggered = await guard.stop();
      expect(controller.signal.aborted).toBe(true);
      expect(triggered).toMatchObject({ triggered: true, reason: "max_turns", observed: 3, limit: 2 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("report classification for runaway_guard", () => {
  test("classifies runaway guard termination as scored budget_timeout rather than administrative_cancellation", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "runaway-report-test-"));
    try {
      await mkdir(join(runDir, "control"), { recursive: true });
      await mkdir(join(runDir, "artifacts/stock"), { recursive: true });
      await mkdir(join(runDir, "artifacts/current"), { recursive: true });
      await mkdir(join(runDir, "arms/stock/home/ubuntu/.codex/sessions"), { recursive: true });
      await mkdir(join(runDir, "arms/current/home/ubuntu/.codex/sessions"), { recursive: true });
      await writeFile(join(runDir, "control/task.md"), "Fix the bug.\n");
      await writeFile(join(runDir, "artifacts/stock/codex.jsonl"), "");
      await writeFile(join(runDir, "artifacts/current/codex.jsonl"), "");

      const state: RunState = {
        schema_version: 1,
        id: "task-run-runawaytest",
        created_at: "2026-11-27T00:00:00.000Z",
        status: "partial",
        source: { path: "/tmp/src", base_commit: "a".repeat(40), base_tree: "b".repeat(40), source_timestamp: 1700000000, forbidden_commit: "c".repeat(40) },
        task: { path: "control/task.md", sha256: "d".repeat(64) },
        image: "codex-ab:0.1.0",
        execution: { model: "gpt-6.2-sol", reasoning_effort: "medium", service_tier: "default", current_launcher: "codex" },
        resource_limits: { cpus: "2", memory: "4g", pids_limit: 512 },
        timeout_seconds: 1800,
        runaway_guard: { max_turns: 20, repeated_error_limit: 3 },
        snapshot_manifest: "snapshots/manifest.json",
        current_snapshot: { captured_at: "2026-11-27T00:00:00.000Z", manifest_sha256: "e".repeat(64) },
        runtime_tools: {
          bun: "/usr/bin/bun", bun_sha256: "1".repeat(64),
          codex_source: "/usr/local/bin/codex", codex_version: "codex-cli 0.172.0", codex_sha256: "2".repeat(64),
          codex_code_mode_host_source: "/usr/local/bin/codex-code-mode-host",
          codex_code_mode_host_sha256: "3".repeat(64), codex_code_mode_host_size: 100,
          current_setup_installs: "/tmp/installs", current_setup_files: "snapshots/files.json", current_setup_files_sha256: "4".repeat(64),
        },
        operator: { uid: 1000, gid: 1000 },
        selected_arms: ["stock", "current"],
        arms: {
          stock: { repository: "arms/stock/repo", home_template: "snapshots/stock/home/ubuntu" },
          current: { repository: "arms/current/repo", home_template: "snapshots/current/home/ubuntu" },
        },
        results: {
          stock: {
            arm: "stock",
            anonymous_id: "candidate-1",
            container: "codex-ab-test-stock",
            started_at: "2026-11-27T00:00:00.000Z",
            finished_at: "2026-11-27T00:01:00.000Z",
            agent_elapsed_ms: 60_000,
            exit_code: 137,
            timed_out: true,
            canceled: false,
            runaway_guard: {
              triggered: true,
              reason: "repeated_error_loop",
              detail: "Repeated identical error 3 consecutive times (limit 3): cmd:npm test|exit:1|failed",
              observed: 3,
              limit: 3,
            },
            patch_path: "artifacts/stock/changes.patch",
            stdout_path: "artifacts/stock/codex.jsonl",
            stderr_path: "artifacts/stock/codex.stderr",
            changed_files: [],
            head_after_agent: "a".repeat(40),
          },
          current: {
            arm: "current",
            anonymous_id: "candidate-2",
            container: "codex-ab-test-current",
            started_at: "2026-11-27T00:00:00.000Z",
            finished_at: "2026-11-27T00:01:00.000Z",
            agent_elapsed_ms: 60_000,
            exit_code: 137,
            timed_out: false,
            canceled: true,
            patch_path: "artifacts/current/changes.patch",
            stdout_path: "artifacts/current/codex.jsonl",
            stderr_path: "artifacts/current/codex.stderr",
            changed_files: [],
            head_after_agent: "a".repeat(40),
          },
        },
      };
      await writeFile(join(runDir, "run.json"), JSON.stringify(state, null, 2));

      const { jsonPath, markdownPath } = await buildReport(runDir);
      const report = JSON.parse(await readFile(jsonPath, "utf8"));
      const markdown = await readFile(markdownPath, "utf8");

      expect(report.evidence_dimensions.stock.execution).toBe("budget_timeout");
      expect(report.evidence_dimensions.stock.runaway_guard).toMatchObject({ triggered: true, reason: "repeated_error_loop" });
      expect(report.evidence_dimensions.current.execution).toBe("administrative_cancellation");

      const stockCohort = report.reliability.cohorts.find((c: { arm: string }) => c.arm === "stock");
      const currentCohort = report.reliability.cohorts.find((c: { arm: string }) => c.arm === "current");
      expect(stockCohort.summary.scored).toBe(1);
      expect(stockCohort.summary.outcomes.budget_timeout).toBe(1);
      expect(stockCohort.summary.outcomes.administrative_cancellation).toBe(0);
      expect(currentCohort.summary.scored).toBe(0);
      expect(currentCohort.summary.outcomes.administrative_cancellation).toBe(1);

      expect(report.setup.resource_limits.pids_limit).toBe(512);
      expect(report.setup.runaway_guard).toEqual({ max_turns: 20, repeated_error_limit: 3 });
      expect(markdown).toContain("2 CPUs, 4g memory, 512 PIDs.");
      expect(markdown).toContain("Runaway guard:");
      expect(markdown).toContain("runaway guard triggered (repeated_error_loop:");
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });
});

describe("Dockerfile pinned Codex installation", () => {
  test("pins CODEX_RELEASE and verifies installer SHA-256 and installed version", async () => {
    const dockerfile = await readFile(join(import.meta.dir, "Dockerfile"), "utf8");
    expect(dockerfile).not.toContain("https://chatgpt.com/codex/install.sh");
    expect(dockerfile).toContain("ARG CODEX_RELEASE=0.172.0");
    expect(dockerfile).toContain("ARG CODEX_INSTALL_SCRIPT_SHA256=b698d8eb50c0fbe0214ea57b5bf2af439054108404c6d2b872989db02f4bd574");
    expect(dockerfile).toContain("https://github.com/openai/codex/releases/download/rust-v${CODEX_RELEASE}/install.sh");
    expect(dockerfile).toContain('echo "${CODEX_INSTALL_SCRIPT_SHA256}  /tmp/codex-install.sh" | sha256sum --check --strict');
    expect(dockerfile).toContain('CODEX_RELEASE="${CODEX_RELEASE}" CODEX_HOME=/opt/codex CODEX_INSTALL_DIR=/usr/local/bin CODEX_NON_INTERACTIVE=1');
    expect(dockerfile).toContain('/usr/local/bin/codex --version | grep -Fq "${CODEX_RELEASE}"');
  });
});
