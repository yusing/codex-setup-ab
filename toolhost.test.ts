import { expect, test } from "bun:test";
import { exec } from "./process";
import { TOOLHOST_SMOKE_SCRIPT } from "./toolhost";
const liveTest = process.env.CODEX_AB_LIVE_TOOLHOST === "1" ? test : test.skip;
liveTest("image Code Mode companion completes framed execution offline", async () => {
  const docker = process.env.CODEX_AB_DOCKER_BIN ?? "docker";
  const image = process.env.CODEX_AB_LIVE_IMAGE ?? "codex-ab:0.1.0";
  const result = await exec([docker, "run", "--rm", "--network", "none", image,
    "node", "-e", TOOLHOST_SMOKE_SCRIPT], { timeoutMs: 15_000 });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toBe("CODEX_AB_TOOL_HOST_OK");
});
