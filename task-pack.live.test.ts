import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { loadTaskPack } from "./task-pack";
import { executeSemanticCheck } from "./semantic";
import { ensureDependencyImage } from "./dependencies";
import { checked } from "./process";
import type { RunState } from "./types";

const sourceRoot = process.env.CODEX_AB_TASK_SOURCES;
const liveTest = process.env.CODEX_AB_LIVE_DOCKER === "1" && sourceRoot ? test : test.skip;

liveTest("portable task bases prepare and run frozen existing observations without inference", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "codex-ab-pack-live-"));
  try {
    await mkdir(join(runDir, "artifacts"));
    const image = process.env.CODEX_AB_LIVE_IMAGE ?? "codex-ab:delivery";
    const imageId = (await checked(["docker", "image", "inspect", "--format", "{{.Id}}", image])).stdout.trim();
    for (const [id, sourceName] of [["nvm-download-no-eval", "nvm"], ["gin-context-copy", "gin"]]) {
      const pack = await loadTaskPack(join(import.meta.dir, "tasks", id!, "manifest.json"));
      const candidate = resolve(sourceRoot!, sourceName!);
      expect((await checked(["git", "-C", candidate, "rev-parse", "HEAD"])).stdout.trim()).toBe(pack.manifest.source.base_commit);
      expect((await checked(["git", "-C", candidate, "status", "--porcelain"])).stdout.trim()).toBe("");
      const state = { id: `pack-live-${process.pid}-${sourceName}`, image, image_id: imageId,
        profile: "task", timeout_seconds: 240, resource_limits: { cpus: "2", memory: "4g" },
        source: { ...pack.manifest.source, base_tree: (await checked(["git", "-C", candidate, "rev-parse", "HEAD^{tree}"])).stdout.trim() },
        operator: { uid: 1000, gid: 1000 }, arms: { stock: { repository: candidate } },
        runtime_tools: { bun: "bun" }, criteria: { contract: pack.contract } } as unknown as RunState;
      await ensureDependencyImage("docker", runDir, state, new AbortController().signal);
      const existing = await executeSemanticCheck({ runDir, state, candidate, arm: "stock", docker: "docker",
        name: `codex-ab-pack-existing-${process.pid}-${sourceName}`, output: join(runDir, id!, "existing"),
        check: { criterion: "existing", files: [], rationale: "Frozen retained baseline behavior, not test-runner completion", command: ["sh", "-lc", pack.contract.existing_tests],
          verification: pack.contract.existing_test_verification } });
      expect(existing.status, JSON.stringify(existing.execution)).toBe("pass");
    }
  } catch (error) {
    console.error(`Portable-task failure artifacts retained at ${runDir}`);
    throw error;
  }
  await rm(runDir, { recursive: true, force: true });
}, 600000);
