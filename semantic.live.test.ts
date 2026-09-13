import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeSemanticCheck } from "./semantic";
import type { RunState } from "./types";

const liveTest = process.env.CODEX_AB_LIVE_DOCKER === "1" ? test : test.skip;

liveTest("isolated checks accept equivalent names, find defects and reject broken or mutating harnesses", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-ab-semantic-"));
  try {
    const state = { id: `live-${process.pid}`, timeout_seconds: 30, resource_limits: { cpus: "2", memory: "1g" },
      image: process.env.CODEX_AB_LIVE_IMAGE ?? "codex-ab:delivery" } as RunState;
    for (const [name, symbol, expression, expected] of [
      ["first", "add", "a + b", "pass"], ["renamed", "combine", "a + b", "pass"],
      ["broken", "combine", "a - b", "fail"],
    ]) {
      const candidate = join(root, name!);
      await mkdir(candidate);
      await writeFile(join(candidate, "math.cjs"), `exports.${symbol} = (a, b) => ${expression};\n`);
      const evidence = await executeSemanticCheck({ runDir: root, state, candidate, output: join(root, "output", name!),
        name: `codex-ab-semantic-${process.pid}-${name}`, docker: "docker",
        check: { criterion: "sum", rationale: "Both inputs contribute to the sum.",
          files: [{ path: "extra.cjs", source: `const assert = require('node:assert/strict'); const math = require('./math.cjs'); assert.equal(math.${symbol}(2, 3), 5);` }],
          command: ["node", "extra.cjs"] } });
      expect(evidence.status).toBe(expected);
    }
    const candidate = join(root, "renamed");
    for (const [name, source] of [
      ["harness", "require('./invented-module.cjs')"],
      ["mutation", "require('fs').writeFileSync('math.cjs', 'exports.combine = () => 5')"],
      ["isolation", `const fs=require('fs'),assert=require('node:assert/strict');assert.equal(fs.existsSync('/home/ubuntu/.codex/auth.json'),false);assert.equal(fs.existsSync('/var/run/docker.sock'),false);assert.deepEqual(fs.readdirSync('/sys/class/net'),['lo']);`],
    ]) {
      const evidence = await executeSemanticCheck({ runDir: root, state, candidate, output: join(root, "output", name!),
        name: `codex-ab-semantic-${process.pid}-${name}`, docker: "docker",
        check: { criterion: "sum", rationale: "Harness contract.", files: [{ path: "extra.cjs", source: source! }], command: ["node", "extra.cjs"] } });
      expect(evidence.status).toBe(name === "isolation" ? "pass" : "unassessed");
    }
    expect(await readFile(join(candidate, "math.cjs"), "utf8")).toBe("exports.combine = (a, b) => a + b;\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 90000);
