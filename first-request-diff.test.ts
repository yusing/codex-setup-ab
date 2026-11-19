import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "./process";

const cli = new URL("./cli.ts", import.meta.url).pathname;
const message = (role: string, text: string) => ({
  type: "response_item",
  payload: { type: "message", role, content: [{ type: "input_text", text }] },
});
const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join("\n");

async function writeRun(dir: string, version: string, twoArms = true) {
  const arms: Record<string, { repository: string }> = {};
  const arm_attempts: Record<string, { codex_home: string }> = {};
  for (const arm of twoArms ? ["stock", "current"] : ["current"]) {
    const id = `${version}-${arm}-thread`;
    const home = `${arm}/home/ubuntu/.codex`;
    const sessions = join(dir, home, "sessions");
    await mkdir(sessions, { recursive: true });
    arms[arm] = { repository: `${arm}/repo` };
    arm_attempts[arm] = { codex_home: home };
    const tool = arm === "stock" ? "Stock" : version;
    await writeFile(join(sessions, "rollout-main.jsonl"), jsonl([
      { type: "session_meta", payload: { id, base_instructions: "Policy." } },
      { type: "response_item", payload: { type: "additional_tools", tools: [
        { name: "functions", type: "namespace", tools: [
          { name: "exec", type: "custom", description: `${tool} tool.\nShared tip.` },
        ] },
      ] } },
      message("developer", "Policy."),
      message("developer", `${tool} guidance for ${id}.`),
      message("user", "Same task."),
      message("assistant", "Not part of the request."),
      // The remaining file is never parsed.
    ]) + "\nNOT JSON");
    await writeFile(join(sessions, "rollout-child.jsonl"), jsonl([
      { type: "session_meta", payload: { source: { subagent: "review" } } },
      message("user", "Ignore the child."),
    ]));
    if (arm !== "current") continue;
    const turn = { boundary: "provider", thread_id: id, request_kind: "turn",
      request_model: "test-model", request_sequence: 2, request: { bytes: 100 },
      usage: { input_tokens: version === "New" ? 11 : 12 },
      projected_fingerprint: { fields: { input: "hash", model: "hash" }, item_count: 4 } };
    await writeFile(join(dir, "capture.jsonl"), jsonl([
      { ...turn, request_kind: "prewarm", request_sequence: 1 },
      { ...turn, thread_id: "child" },
      turn,
      { ...turn, request_sequence: 3 },
    ]));
  }
  await writeFile(join(dir, "run.json"), JSON.stringify({
    schema_version: 1, comparison: "stock-mekugi", execution: { current_launcher: "mekugi" },
    arms, arm_attempts, mekugi_exports: { capture: "capture.jsonl" },
  }));
}

test("first-request diff compares stock or a previous run without later output", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-ab-first-request-test-"));
  try {
    const current = join(root, "new run");
    const previous = join(root, "old run");
    await writeRun(current, "New");
    await writeRun(previous, "Old", false);
    const args = [process.execPath, cli, "first-request-diff", "--run-dir", current];
    const env = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
    const paired = await exec(args, { env });
    const historical = await exec([...args, "--against-run", previous], { env });
    for (const result of [paired, historical]) {
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    }
    expect(paired.stdout.split("\n")).toMatchSnapshot("stock");
    expect(historical.stdout.split("\n")).toMatchSnapshot("previous Mekugi");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
