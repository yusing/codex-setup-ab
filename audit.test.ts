import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./cli";
import { withRunLock } from "./state";
import { preflightRun, runPair } from "./runner";
import { judgeRun } from "./judge";
import { buildReport, invalidateRun } from "./report";

test("mistyped or command-inapplicable paid-run options fail before execution", async () => {
  await expect(main(["run", "--arms", "stock", "--confirm-paid-inference"])).rejects.toThrow("unknown option");
  await expect(main(["judge", "--arm", "stock", "--confirm-paid-inference"])).rejects.toThrow("unknown option");
  await expect(main(["run", "--arm", "stock", "--arm", "current", "--confirm-paid-inference"])).rejects.toThrow("duplicate option");
});

test("one run operation excludes every competing state writer and releases after failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-ab-lock-test-"));
  try {
    await expect(withRunLock(directory, async () => {
      for (const operation of [
        () => preflightRun(directory),
        () => runPair({ runDir: directory, authFile: "/unused" }),
        () => judgeRun(directory, "/unused"),
        () => buildReport(directory),
        () => invalidateRun(directory, ["fixture"]),
      ]) await expect(operation()).rejects.toThrow("locked by another operation");
      throw new Error("fixture failure");
    })).rejects.toThrow("fixture failure");
    expect(await withRunLock(directory, async () => "released")).toBe("released");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("obsolete hidden-test options and regrade command are rejected", async () => {
  await expect(main(["prepare", "--acceptance", "obsolete.go"])).rejects.toThrow("unknown option");
  await expect(main(["regrade", "--run-dir", "/unused"])).rejects.toThrow("unknown command");
});

test("removed mentor options and comparisons fail before preparation", async () => {
  await expect(main(["prepare", "--mentor-setup", "stock"])).rejects.toThrow("unknown option");
  await expect(main(["prepare", "--comparison", "mentor-handoff"])).rejects.toThrow("unknown comparison");
  await expect(main(["prepare-suite", "--comparison", "mentor-matrix"])).rejects.toThrow("suite comparison must be stock-current");
});

test("retired saved comparisons cannot be relabeled by report or export", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-ab-retired-report-"));
  const run = join(root, "run");
  try {
    await mkdir(join(run, "reports"), { recursive: true });
    const existingReport = join(run, "reports/report.md");
    await writeFile(existingReport, "Historical mentor report\n");
    for (const comparison of ["mentor-handoff", "unknown-comparison"]) {
      const saved = JSON.stringify({ schema_version: 1, comparison });
      await writeFile(join(run, "run.json"), saved);
      for (const options of [{}, { outputDirectory: join(root, "export") }]) {
        await expect(buildReport(run, options)).rejects.toThrow(`unsupported run comparison: ${comparison}`);
      }
      expect(await readFile(join(run, "run.json"), "utf8")).toBe(saved);
      expect(await readFile(existingReport, "utf8")).toBe("Historical mentor report\n");
      expect(await Bun.file(join(root, "export/report.md")).exists()).toBe(false);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
