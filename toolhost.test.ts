import { expect, test } from "bun:test";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { exec } from "./process";
import { TOOLHOST_SMOKE_SCRIPT } from "./toolhost";
const liveTest = process.env.CODEX_AB_LIVE_TOOLHOST === "1" ? test : test.skip;
liveTest("real local code-mode host completes framed execution without model access", async () => {
  const codex = await realpath(process.env.CODEX_AB_TOOLHOST_CODEX_BIN ?? join(homedir(), ".local/bin/codex"));
  const result = await exec(["node", "-e", TOOLHOST_SMOKE_SCRIPT], {
    env: { CODEX_CODE_MODE_HOST: join(dirname(codex), "codex-code-mode-host") },
    timeoutMs: 15_000,
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toBe("CODEX_AB_TOOL_HOST_OK");
});
