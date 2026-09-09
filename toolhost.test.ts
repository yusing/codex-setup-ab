import { expect, test } from "bun:test";
import { exec } from "./process";
import { TOOLHOST_SMOKE_SCRIPT } from "./toolhost";

test("real local code-mode host completes framed execution without model access", async () => {
  const result = await exec(["node", "-e", TOOLHOST_SMOKE_SCRIPT], {
    env: { CODEX_CODE_MODE_HOST: "/home/ubuntu/.codex/packages/standalone/releases/0.153.4-aarch64-unknown-linux-musl/bin/codex-code-mode-host" },
    timeoutMs: 15_000,
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toBe("CODEX_AB_TOOL_HOST_OK");
});
