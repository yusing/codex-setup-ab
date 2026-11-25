import { expect, test } from "bun:test";
import { realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { exec } from "./process";
import { TOOLHOST_SMOKE_SCRIPT } from "./toolhost";

const liveTest = process.env.CODEX_AB_LIVE_TOOLHOST === "1" ? test : test.skip;
const mekugi = process.env.CODEX_AB_MEKUGI_BIN;
const nativeTest = mekugi ? liveTest : test.skip;

async function probeToolHost(args: string[] = []) {
  const docker = process.env.CODEX_AB_DOCKER_BIN ?? "docker";
  const image = process.env.CODEX_AB_LIVE_IMAGE ?? "codex-ab:0.1.0";
  const result = await exec([
    docker, "run", "--rm", "--network", "none", ...args, image,
    "node", "-e", TOOLHOST_SMOKE_SCRIPT,
  ], { timeoutMs: 15_000 });
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe("CODEX_AB_TOOL_HOST_OK");
}

liveTest("image Code Mode companion completes execution offline", async () => {
  await probeToolHost();
});

nativeTest("installed Mekugi Code Mode host runs offline", async () => {
  const host = join(dirname(await realpath(mekugi!)), "codex-code-mode-host");
  await probeToolHost(["-v", `${host}:/tmp/mekugi-code-mode-host:ro`,
    "-e", "CODEX_CODE_MODE_HOST=/tmp/mekugi-code-mode-host"]);
});
