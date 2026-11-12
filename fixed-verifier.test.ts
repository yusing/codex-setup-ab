import { afterEach, expect, spyOn, test } from "bun:test";
import { readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as containers from "./container";
import { executeFixedVerifier, fixedTreeIdentity, readFixedReward, validateFixedVerifierConfig } from "./fixed-verifier";

import { createFixedFixture } from "./test-support/fixed-verifier";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixedFixture() {
  const fixture = await createFixedFixture();
  roots.push(fixture.root);
  return fixture;
}

test("fixed config rejects mutable identities, unknown controls, and unsafe mounts", async () => {
  const { config } = await fixedFixture();
  expect(validateFixedVerifierConfig(config)).toEqual(config);
  for (const changed of [
    { ...config, image: "fixture:latest" }, { ...config, dataset: { ...config.dataset, revision: "main" } },
    { ...config, network: "host" }, { ...config, candidate_mount: "/", workdir: "/" },
    { ...config, candidate_mount: "/tests/candidate", workdir: "/tests/candidate" },
    { ...config, timeout_seconds: 0 }, { ...config, reward_key: "" },
    { ...config, arbitrary_docker_flags: ["--privileged"] },
    { ...config, verifier: { ...config.verifier, path: "../tests" } },
    { ...config, verifier: { ...config.verifier, command: ["true"] } },
  ]) expect(() => validateFixedVerifierConfig(changed)).toThrow();
});

test("fixed reward parsing retains JSON precedence, explicit keys and finite normalized scores", async () => {
  const { root } = await fixedFixture();
  await writeFile(join(root, "reward.txt"), "1\n");
  expect((await readFixedReward(root, "reward")).reward).toBe(1);
  await writeFile(join(root, "reward.json"), '{"reward":0,"other":1}');
  expect(await readFixedReward(root, "reward")).toMatchObject({ source: "reward.json", reward: 0, rewards: { reward: 0, other: 1 } });
  expect((await readFixedReward(root, "other")).reward).toBe(1);
  for (const json of ["", "{}", "null", "1", '{"reward":"1"}', '{"reward":true}', '{"reward":1e309}', '{"reward":-1}', '{"reward":2}', "not json"]) {
    await writeFile(join(root, "reward.json"), json);
    await expect(readFixedReward(root, "reward")).rejects.toThrow();
  }
  await rm(join(root, "reward.json"));
  for (const text of ["", "NaN", "Infinity", "1e309", "0x1", "1\n0"]) {
    await writeFile(join(root, "reward.txt"), text);
    await expect(readFixedReward(root, "reward")).rejects.toThrow();
  }
  await rm(join(root, "reward.txt"));
  await symlink("candidate/result.txt", join(root, "reward.json"));
  await expect(readFixedReward(root, "reward")).rejects.toThrow("regular file");
});

test("fixed verifier pins all task/verifier bytes and the reconstructed candidate before Docker", async () => {
  for (const target of ["task", "verifier", "candidate"]) {
    const fixture = await fixedFixture();
    const path = target === "task" ? join(fixture.taskDirectory, "instruction.md")
      : target === "verifier" ? join(fixture.taskDirectory, "tests/test.sh") : join(fixture.candidate, "result.txt");
    await writeFile(path, "changed\n");
    const mock = spyOn(containers, "runOwnedContainer").mockImplementation(async () => { throw new Error("must not start Docker"); });
    try {
      await expect(executeFixedVerifier(fixture)).rejects.toThrow(target === "candidate" ? "independent capture manifest" : "pinned identity");
      expect(mock).not.toHaveBeenCalled();
    } finally { mock.mockRestore(); }
  }
  const fixture = await fixedFixture();
  await symlink(fixture.candidate, join(fixture.taskDirectory, "tests/external"));
  await expect(fixedTreeIdentity(join(fixture.taskDirectory, "tests"))).rejects.toThrow("external symlink");
});

test.each([
  { name: "pass", exitCode: 0, reward: "1", expected: "pass", validity: "valid", status: "completed" },
  { name: "fail", exitCode: 0, reward: "0", expected: "fail", validity: "valid", status: "completed" },
  { name: "assertion-exit", exitCode: 1, reward: "0", expected: "fail", validity: "valid", status: "nonzero" },
  { name: "partial", exitCode: 0, reward: "0.5", expected: "fail", validity: "valid", status: "completed" },
  { name: "early-zero", exitCode: 0, reward: null, expected: "unassessed", validity: "invalid", status: "completed" },
  { name: "broken", exitCode: 2, reward: null, expected: "unassessed", validity: "unavailable", status: "nonzero" },
  { name: "timeout", exitCode: -1, reward: "1", expected: "unassessed", validity: "unavailable", status: "timeout" },
  { name: "canceled", exitCode: -1, reward: "1", expected: "unassessed", validity: "unavailable", status: "canceled" },
])("fixed execution keeps score, validity and %s execution distinct", async example => {
  const fixture = await fixedFixture();
  const originalScript = await readFile(join(fixture.taskDirectory, "tests/test.sh"), "utf8");
  const mock = spyOn(containers, "runOwnedContainer").mockImplementation(async options => {
    expect(options.createArgs).toContain("none");
    expect(options.createArgs).toContain(`type=bind,src=${fixture.candidate},dst=/app,readonly`);
    expect(options.createArgs).toContain(`type=bind,src=${join(fixture.taskDirectory, "tests")},dst=/tests,readonly`);
    expect(options.createArgs.filter(argument => argument.startsWith("type=bind,")).filter(argument => !argument.endsWith(",readonly")))
      .toEqual([`type=bind,src=${join(fixture.output, "rewards")},dst=/logs/verifier`]);
    expect(options.createArgs.slice(-4)).toEqual(["--entrypoint", "/bin/bash", fixture.config.image, "/tests/test.sh"]);
    if (example.reward !== null) await writeFile(join(fixture.output, "rewards/reward.txt"), example.reward);
    await writeFile(options.stdoutFile!, "original verifier stdout\n");
    await writeFile(options.stderrFile!, "original verifier stderr\n");
    return { exitCode: example.exitCode, timedOut: example.name === "timeout", canceled: example.name === "canceled",
      stdout: "", stderr: "", elapsedMs: 12, cleanupVerified: true };
  });
  try {
    const result = await executeFixedVerifier(fixture);
    expect(result).toMatchObject({ behavioral_result: example.expected, evaluation_validity: example.validity,
      execution_status: example.status, methodology_comparable: false, trust_boundary: "upstream-fixed-verifier", cleanup_verified: true });
    expect(JSON.parse(await readFile(join(fixture.output, "result.json"), "utf8"))).toEqual(result);
    expect(await readFile(join(fixture.output, "stdout.log"), "utf8")).toBe("original verifier stdout\n");
    expect(await readFile(join(fixture.taskDirectory, "tests/test.sh"), "utf8")).toBe(originalScript);
    await expect(executeFixedVerifier(fixture)).rejects.toThrow();
    expect(mock).toHaveBeenCalledTimes(1);
  } finally { mock.mockRestore(); }
});

test("fixed verifier cleanup failure cannot publish a reward as successful", async () => {
  const fixture = await fixedFixture();
  const mock = spyOn(containers, "runOwnedContainer").mockImplementation(async () => {
    await writeFile(join(fixture.output, "rewards/reward.txt"), "1");
    throw new containers.OwnedContainerError("container cleanup could not verify absence", {
      exitCode: 0, timedOut: false, canceled: false, elapsedMs: 12, stdout: "", stderr: "",
    });
  });
  try {
    expect(await executeFixedVerifier(fixture)).toMatchObject({ execution_status: "infrastructure-error",
      evaluation_validity: "unavailable", behavioral_result: "unassessed", cleanup_verified: false });
    expect(await readFile(join(fixture.output, "rewards/reward.txt"), "utf8")).toBe("1");
  } finally { mock.mockRestore(); }
});
