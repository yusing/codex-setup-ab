import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checked } from "../process";
import { loadTaskPack, snapshotUpstreamReference } from "../task-pack";
import { writeState } from "../state";
import type { RunState } from "../types";

// Standalone live invocations need the same Git isolation as the ordinary runner.
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = "/dev/null";

/** Model-free fixture using the exact source pins and normal offline executor. */
export async function prepareTaskQualificationRun(packPath: string, source: string, root: string, image: string): Promise<RunState> {
  const pack = await loadTaskPack(packPath);
  const pin = pack.manifest.source;
  await checked(["git", "-C", source, "archive", "--format=tar", "-o", join(root, "baseline.tar"), pin.base_commit]);
  await checked(["git", "clone", "--bare", "--no-hardlinks", source, join(root, "seed.git")]);
  const reference = await snapshotUpstreamReference(root, source, pin);
  const candidate = join(root, "evaluator/stock");
  await mkdir(candidate, { recursive: true });
  await checked(["tar", "-xf", join(root, "baseline.tar"), "-C", candidate]);
  if (reference) await checked(["git", "-C", candidate, "apply", "--binary", join(root, "evaluator/upstream/changes.patch")]);
  for (const cache of ["grader-go-pkg-cache", "grader-bun-cache"]) await mkdir(join(root, "arms/stock", cache), { recursive: true });
  await mkdir(join(root, "control"), { recursive: true });
  await writeFile(join(root, "control/task.md"), pack.snapshot.files[pack.manifest.prompt]!.content);
  const state = {
    schema_version: 1, id: `task-qualification-${process.pid}`, status: "complete", profile: "task",
    source: { path: source, base_commit: pin.base_commit,
      base_tree: (await checked(["git", "-C", source, "rev-parse", `${pin.base_commit}^{tree}`])).stdout.trim(),
      source_timestamp: 0, forbidden_commit: pin.forbidden_commit },
    task: { path: "control/task.md", sha256: pack.contract.task_sha256 },
    criteria: { path: "evaluator/criteria.json", sha256: "model-free-fixture", contract: pack.contract },
    upstream_reference: reference, image, image_id: image,
    execution: { model: "model-free-fixture", reasoning_effort: "high", service_tier: "default" },
    timeout_seconds: 180, resource_limits: { cpus: "2", memory: "2g" },
    operator: { uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000 },
    arms: { stock: { repository: "evaluator/stock", home_template: "unused" } },
  } as RunState;
  await writeState(root, state);
  return state;
}
