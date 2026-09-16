import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { loadTaskPack } from "./task-pack";
import { executeSemanticCheck } from "./semantic";
import { runOwnedContainer } from "./container";
import { checked } from "./process";
import type { RunState } from "./types";

const sourceRoot = process.env.CODEX_AB_TASK_SOURCES;
const liveTest = process.env.CODEX_AB_LIVE_DOCKER === "1" && sourceRoot ? test : test.skip;

liveTest("portable task bases prepare and run existing checks without inference", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "codex-ab-pack-live-"));
  try {
    await symlink(process.execPath, join(runDir, "bun"));
    const moduleCache = join(runDir, "arms/stock/grader-go-pkg-cache");
    await mkdir(moduleCache, { recursive: true });
    await mkdir(join(runDir, "arms/stock/grader-bun-cache"), { recursive: true });
    for (const [id, sourceName] of [["nvm-download-no-eval", "nvm"], ["gin-context-copy", "gin"]]) {
      const pack = await loadTaskPack(join(import.meta.dir, "tasks", id!, "manifest.json"));
      const candidate = resolve(sourceRoot!, sourceName!);
      expect((await checked(["git", "-C", candidate, "rev-parse", "HEAD"])).stdout.trim()).toBe(pack.manifest.source.base_commit);
      expect((await checked(["git", "-C", candidate, "status", "--porcelain"])).stdout.trim()).toBe("");
      const state = { id: `pack-live-${process.pid}`, image: process.env.CODEX_AB_LIVE_IMAGE ?? "codex-ab:delivery",
        profile: "task", timeout_seconds: 240, resource_limits: { cpus: "2", memory: "4g" },
        runtime_tools: { bun: "bun" }, criteria: { contract: pack.contract } } as RunState;
      const warm = await runOwnedContainer({
        docker: "docker", name: `codex-ab-pack-warm-${process.pid}-${sourceName}`, timeoutMs: 240000,
        createArgs: ["--cpus", "2", "--memory", "4g", "-v", `${candidate}:/candidate:ro`,
          "-v", `${moduleCache}:/home/ubuntu/go/pkg`, state.image, "sh", "-lc",
          `cp -a /candidate /tmp/source && cd /tmp/source && ${pack.contract.preparation}`],
      });
      expect(warm.exitCode).toBe(0);
      const existing = await executeSemanticCheck({ runDir, state, candidate, arm: "stock", docker: "docker",
        name: `codex-ab-pack-existing-${process.pid}-${sourceName}`, output: join(runDir, id!, "existing"),
        check: { criterion: "existing", files: [], rationale: "Existing baseline tests", command: ["sh", "-lc", pack.contract.existing_tests] } });
      expect(existing.status).toBe("pass");
    }
  } finally {
    // Go's module cache deliberately uses read-only directories.
    await checked(["chmod", "-R", "u+w", join(runDir, "arms")]);
    await rm(runDir, { recursive: true, force: true });
  }
}, 600000);
