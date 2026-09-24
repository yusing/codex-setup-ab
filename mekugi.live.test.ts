import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runOwnedContainer } from "./container";
import { validateMekugiExports } from "./mekugi";
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
      createArgs: ["--network", "none", "-v", `${root}/exports:/exports`,
        "-v", `${process.env.CODEX_AB_MEKUGI_BIN ?? "/home/ubuntu/go/bin/mekugi"}:/usr/local/bin/mekugi:ro`,
        process.env.CODEX_AB_LIVE_IMAGE ?? "codex-ab:delivery",
        "mekugi", "--mode=mekugi", "--model-protocol=native",
        "--capture-output=/exports/capture.jsonl", "--metrics-output=/exports/metrics.json", "codex", "--version"],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("codex-cli");
    const metrics = JSON.parse(await readFile(join(root, "exports/metrics.json"), "utf8"));
    expect(metrics.schema).toBe("mekugi.capture.metrics.v6");
    expect(metrics.requests.logical).toBe(0);
    const state = { mekugi_flags: ["--mode=mekugi"], mekugi_exports: {
      metrics: "exports/metrics.json", capture: "exports/capture.jsonl",
      validator: { path: "analyze_capture.py", sha256: await sha256(join(root, "analyze_capture.py")) },
      reader: { path: "benchmark_jsonl.py", sha256: await sha256(join(root, "benchmark_jsonl.py")) },
    } } as RunState;
    expect(await validateMekugiExports(root, state)).toMatchObject({ status: "unavailable", reason: expect.stringContaining("capture is empty") });
    for (const [index, flags] of [["--timeout=not-a-duration"], ["--mode=passthrough", "--model-protocol=ctp2"]].entries()) {
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
