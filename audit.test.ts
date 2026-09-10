import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./cli";
import { withRunLock } from "./state";
import { preflightRun, runPair } from "./runner";
import { judgeRun } from "./judge";
import { buildReport, invalidateRun } from "./report";
import { acceptanceExecutionError, acceptanceTestNames } from "./grading";

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

test("acceptance requires each trusted test to execute and pass, not just package success", () => {
  const expected = ["TestABAcceptanceOne", "TestABAcceptanceTwo"];
  const events = (names: string[], action = "pass") => names.flatMap(Test => [{ Action: "run", Test }, { Action: action, Test }]).map(value => JSON.stringify(value)).join("\n");
  expect(acceptanceExecutionError(events(expected), expected)).toBeUndefined();
  expect(acceptanceExecutionError('{"Action":"pass","Package":"fixture"}', expected)).toContain("did not execute");
  expect(acceptanceExecutionError(events(expected, "skip"), expected)).toContain("did not execute");
  expect(acceptanceExecutionError(events(expected.slice(0, 1)), expected)).toContain("TestABAcceptanceTwo");
  expect(acceptanceExecutionError(events(expected), [])).toContain("declares no");
});

test("acceptance names ignore Go comments and literals and retain Unicode identifiers", () => {
  const evaluator = [
    "package fixture",
    'import "testing"',
    "/* example:\nfunc TestABAcceptanceComment(t *testing.T) {}\n*/",
    "// func TestABAcceptanceLineComment(t *testing.T) {}",
    'const example = `func TestABAcceptanceRawString(t *testing.T) {}`',
    'const quoted = "func TestABAcceptanceString(t *testing.T) {}"',
    "func /* comment */ TestABAcceptance雪(t *testing.T) {}",
    "func TestABAcceptanceActual(t *testing.T) {}",
  ].join("\n");
  expect(acceptanceTestNames(evaluator)).toEqual(["TestABAcceptance雪", "TestABAcceptanceActual"]);
});
