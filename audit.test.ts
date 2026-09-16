import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
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
