import { expect, test } from "bun:test";
import { exec } from "./process";
import { runOwnedContainer } from "./container";

const live = process.env.CODEX_AB_LIVE_DOCKER === "1";
const liveTest = live ? test : test.skip;
const docker = process.env.CODEX_AB_DOCKER_BIN ?? "docker";
const image = process.env.CODEX_AB_LIVE_IMAGE ?? "codex-ab:0.1.0";
const unique = (suffix: string) => `codex-ab-live-${process.pid}-${suffix}`;

async function isAbsent(name: string): Promise<boolean> {
  const result = await exec([docker, "container", "inspect", name]);
  return result.exitCode !== 0 && /no such (object|container)/i.test(result.stderr);
}

async function waitUntilRunning(name: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = await exec([docker, "container", "inspect", "--format", "{{.State.Running}}", name]);
    if (state.exitCode === 0 && state.stdout.trim() === "true") return;
    await Bun.sleep(50);
  }
  throw new Error(`fixture container did not reach running state: ${name}`);
}

liveTest("live Docker ordinary command returns and disappears", async () => {
  const name = unique("success");
  const result = await runOwnedContainer({ docker, name, createArgs: [image, "sh", "-lc", "printf harmless"] });
  expect(result.stdout).toBe("harmless");
  expect(await isAbsent(name)).toBe(true);
});

liveTest("live Docker preserves a nonzero container command exit", async () => {
  const name = unique("exit7");
  expect((await runOwnedContainer({ docker, name, createArgs: [image, "sh", "-lc", "exit 7"] })).exitCode).toBe(7);
  expect(await isAbsent(name)).toBe(true);
});

liveTest("live Docker cancellation stops and removes running sleep", async () => {
  const name = unique("cancel"); const controller = new AbortController();
  const result = runOwnedContainer({ docker, name, signal: controller.signal, createArgs: [image, "sh", "-lc", "trap '' TERM; while :; do sleep 1; done"] });
  // Observe early creation failure while polling, then await owned cleanup on
  // both the success path and a running-state timeout.
  void result.catch(() => {});
  try {
    await waitUntilRunning(name); controller.abort();
    expect((await result).canceled).toBe(true);
  } finally { controller.abort(); await result.catch(() => {}); }
  expect(await isAbsent(name)).toBe(true);
});

liveTest("live Docker timeout stops and removes running sleep", async () => {
  const name = unique("timeout");
  expect((await runOwnedContainer({ docker, name, timeoutMs: 250, createArgs: [image, "sleep", "30"] })).timedOut).toBe(true);
  expect(await isAbsent(name)).toBe(true);
});

liveTest("live Docker pre-aborted launch creates no container", async () => {
  const name = unique("preabort"); const controller = new AbortController(); controller.abort();
  await expect(runOwnedContainer({ docker, name, signal: controller.signal, createArgs: [image, "sh", "-lc", "echo model-command"] })).rejects.toThrow("canceled before creation");
  expect(await isAbsent(name)).toBe(true);
});
