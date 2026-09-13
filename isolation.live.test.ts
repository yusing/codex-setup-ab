import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { protectedPreflight } from "./isolation";
import { readState } from "./state";

const run = process.env.CODEX_AB_LIVE_RUN;
const liveTest = process.env.CODEX_AB_LIVE_DOCKER === "1" && run ? test : test.skip;
liveTest("real Mekugi boundary denies executor writes/egress and permits private builds and Code Mode", async () => {
  const state = await readState(run!);
  expect(state.status).toBe("prepared");
  expect(state.protected_runtime).toBeDefined();
  await protectedPreflight("docker", run!, state, new AbortController().signal);
  const result = JSON.parse(await readFile(join(run!, "artifacts/preflight-isolation.json"), "utf8"));
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("CODEX_AB_PROTECTED_RUNTIME_OK");
  expect(result.stdout).toContain("CODEX_AB_TOOL_HOST_OK");
  expect(result.codex.exitCode).toBe(0);
}, 240000);
