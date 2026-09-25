import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runOwnedContainer } from "./container";
import { exec } from "./process";
import { MEKUGI_METRICS_WRAPPER, validateMekugiExports } from "./mekugi";
import { sha256 } from "./state";
import { MEKUGI_EXPORT_SCRIPTS } from "./support/mekugi";
import type { RunState } from "./types";

const liveTest = process.env.CODEX_AB_LIVE_MEKUGI === "1" ? test : test.skip;

liveTest("real Mekugi exports start without inference and empty capture stays unassessed", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-ab-mekugi-export-"));
  try {
    for (const name of ["analyze_capture.py", "benchmark_jsonl.py"] as const) {
      await writeFile(join(root, name), MEKUGI_EXPORT_SCRIPTS[name]);
    }
    await mkdir(join(root, "exports"));
    const result = await runOwnedContainer({
      docker: "docker", name: `codex-ab-export-smoke-${process.pid}`, timeoutMs: 30000,
      createArgs: ["--network", "none", "-v", `${root}/exports:/mekugi-exports`,
        "-v", `${process.env.CODEX_AB_MEKUGI_BIN ?? "/home/ubuntu/go/bin/mekugi"}:/usr/local/bin/mekugi:ro`,
        process.env.CODEX_AB_LIVE_IMAGE ?? "codex-ab:delivery",
        "sh", "-c", MEKUGI_METRICS_WRAPPER, "mekugi-metrics", "mekugi", "--mode=mekugi",
        "--capture-output=/mekugi-exports/capture.jsonl", "--debug", "codex", "--version"],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("codex-cli");
    const metrics = JSON.parse(await readFile(join(root, "exports/metrics.json"), "utf8"));
    expect(metrics.schema).toBe("mekugi.capture.metrics.v6");
    expect(metrics.requests.logical).toBe(0);
    expect((await readdir(join(root, "exports"))).sort()).toEqual(["capture.jsonl", "metrics.json"]);
    await mkdir(join(root, "protected-exports"));
    const protectedResult = await runOwnedContainer({
      docker: "docker", name: `codex-ab-export-private-${process.pid}`, timeoutMs: 30000,
      createArgs: ["--network", "none", "--user", "0:0", "--tmpfs", "/mekugi-debug:mode=0700,size=64m", "-e", "MEKUGI_DEBUG_TMPDIR=/mekugi-debug",
        "-v", `${root}/protected-exports:/mekugi-exports`,
        "-v", `${process.env.CODEX_AB_MEKUGI_BIN ?? "/home/ubuntu/go/bin/mekugi"}:/usr/local/bin/mekugi:ro`,
        process.env.CODEX_AB_LIVE_IMAGE ?? "codex-ab:delivery",
        "sh", "-c", MEKUGI_METRICS_WRAPPER, "mekugi-metrics", "mekugi", "--mode=mekugi",
        "--capture-output=/mekugi-exports/capture.jsonl", "--debug", "codex", "--version"],
    });
    expect(protectedResult.exitCode, protectedResult.stderr).toBe(0);
    expect((await readdir(join(root, "protected-exports"))).sort()).toEqual(["capture.jsonl", "metrics.json"]);
    const state = { mekugi_flags: ["--mode=mekugi"], mekugi_exports: {
      metrics: "exports/metrics.json", capture: "exports/capture.jsonl",
      validator: { path: "analyze_capture.py", sha256: await sha256(join(root, "analyze_capture.py")) },
      reader: { path: "benchmark_jsonl.py", sha256: await sha256(join(root, "benchmark_jsonl.py")) },
    } } as RunState;
    expect(await validateMekugiExports(root, state)).toMatchObject({ status: "unavailable", reason: expect.stringContaining("capture is empty") });
    for (const [index, flags] of [["--timeout=not-a-duration"], ["--mode=passthrough", "--post-compact-recovery=true"]].entries()) {
      const invalid = await runOwnedContainer({
        docker: "docker", name: `codex-ab-export-invalid-${process.pid}-${index}`, timeoutMs: 30000,
        createArgs: ["--network", "none",
          "-v", `${process.env.CODEX_AB_MEKUGI_BIN ?? "/home/ubuntu/go/bin/mekugi"}:/usr/local/bin/mekugi:ro`,
          process.env.CODEX_AB_LIVE_IMAGE ?? "codex-ab:delivery", "mekugi", ...flags, "codex", "--version"],
      });
      expect(invalid.exitCode).not.toBe(0);
    }
    state.mekugi_flags = ["--mode=passthrough"];
    expect((await validateMekugiExports(root, state)).status).toBe("unavailable");
    await rm(join(root, "analyze_capture.py"));
    expect(await validateMekugiExports(root, state)).toMatchObject({ status: "unavailable", reason: expect.stringContaining("ENOENT") });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 45000);

liveTest("metrics wrapper forwards Docker termination and exports the final snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-ab-mekugi-signal-"));
  const name = `codex-ab-export-signal-${crypto.randomUUID()}`;
  try {
    const child = `trap 'mkdir -p "$TMPDIR/mekugi-debug-signal"; echo shutdown > "$TMPDIR/mekugi-debug-signal/metrics.json"; exit 143' TERM; echo READY; while :; do sleep 1; done`;
    const started = await exec(["docker", "run", "-d", "--name", name, "--network", "none", "-v", `${root}:/mekugi-exports`,
      process.env.CODEX_AB_LIVE_IMAGE ?? "codex-ab:delivery", "sh", "-c", MEKUGI_METRICS_WRAPPER, "mekugi-metrics", "sh", "-c", child]);
    expect(started.exitCode, started.stderr).toBe(0);
    let ready = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      if ((await exec(["docker", "logs", name])).stdout.includes("READY")) { ready = true; break; }
      await Bun.sleep(100);
    }
    expect(ready).toBe(true);
    const stopped = await exec(["docker", "stop", "--time", "5", name]);
    expect(stopped.exitCode, stopped.stderr).toBe(0);
    expect((await readFile(join(root, "metrics.json"), "utf8")).trim()).toBe("shutdown");
  } finally {
    await exec(["docker", "rm", "--force", name]);
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

liveTest("metrics wrapper preserves the task on Codex stdin", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-ab-mekugi-stdin-"));
  try {
    const child = 'IFS= read -r task; mkdir -p "$TMPDIR/mekugi-debug-stdin"; echo "{}" > "$TMPDIR/mekugi-debug-stdin/metrics.json"; printf "%s" "$task"';
    const result = await runOwnedContainer({
      docker: "docker", name: `codex-ab-export-stdin-${process.pid}`, timeoutMs: 30000, stdin: "benchmark task\n",
      createArgs: ["--network", "none", "-i", "-v", `${root}:/mekugi-exports`,
        process.env.CODEX_AB_LIVE_IMAGE ?? "codex-ab:delivery", "sh", "-c", MEKUGI_METRICS_WRAPPER,
        "mekugi-metrics", "sh", "-c", child],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe("benchmark task");
    expect(JSON.parse(await readFile(join(root, "metrics.json"), "utf8"))).toEqual({});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
