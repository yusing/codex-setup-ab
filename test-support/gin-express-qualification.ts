import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadTaskPack, snapshotUpstreamReference } from "../task-pack";
import { ensureDependencyImage } from "../dependencies";
import { checked } from "../process";
import { writeState } from "../state";
import type { CriteriaContract, SemanticCheck } from "../semantic";
import type { RunState } from "../types";

// Preserve fixture-local settings without inheriting operator hooks or filters.
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = "/dev/null";

export type GinExpressPack = "gin-context-copy" | "express-transfer-encoding";

/** Authored observations exercise the pinned implementation, not its test runner's success text. */
export function ginExpressQualificationChecks(id: GinExpressPack, contract: CriteriaContract): SemanticCheck[] {
  const existing = contract.existing_test_verification!.cases[0]!;
  if (existing.kind !== "command") throw new Error("Expected a frozen command observer");
  const changed = structuredClone(existing);
  if (id === "gin-context-copy") {
    changed.id = "copy-isolation-observations";
    changed.stdin = JSON.stringify({ scope: "isolation" });
    changed.expected = JSON.stringify({ errors: ["first", "second"], accepted: ["application/json", "text/html"],
      original_error: "first", original_accepted: "application/json", nil_errors: true, nil_accepted: true,
      empty_errors_len: 0, empty_accepted_len: 0 });
  } else {
    changed.id = "transfer-encoding-observations";
    const inputs: object[] = [];
    const expected: object[] = [];
    for (const coding of ["chunked", "compress", "deflate", "gzip", "custom-coding"]) {
      for (const body of ["", "hello"]) {
        const caseId = `${coding}-${body ? "body" : "empty"}`;
        inputs.push({ id: caseId, headers: { "Transfer-Encoding": coding }, body, fields: ["length", "transfer"] });
        expected.push({ id: caseId, length: null, transfer: coding });
      }
    }
    for (const status of [204, 205, 304]) {
      const caseId = `status-${status}`;
      inputs.push({ id: caseId, status, body: "foo", headers: { "Transfer-Encoding": "gzip" }, fields: ["length", "transfer", "body"] });
      expected.push({ id: caseId, length: status === 205 ? "0" : null, transfer: null, body: "" });
    }
    changed.stdin = JSON.stringify(inputs);
    changed.expected = JSON.stringify(expected);
  }
  return contract.criteria.map((criterion, index) => ({ criterion: criterion.id, files: [], command: existing.command,
    rationale: index === 0 ? "Observe the requested change through the real implementation and independent JSON assertions."
      : "Observe the frozen retained-behavior scope; original upstream tests remain a separate diagnostic.",
    verification: { schema: "codex-ab.verification.v1", cases: [index === 0 ? changed : existing] } }));
}

/** Fixture Git writes affect only root. Existing source repositories are read-only. */
export async function prepareGinExpressQualificationRun(id: GinExpressPack, source: string, root: string, image: string): Promise<RunState> {
  const pack = await loadTaskPack(join(import.meta.dir, "../tasks", id, "manifest.json"));
  const pin = pack.manifest.source;
  await checked(["git", "clone", "--bare", "--no-hardlinks", source, join(root, "seed.git")]);
  const candidate = join(root, "evaluator/stock");
  await mkdir(join(root, "evaluator"), { recursive: true });
  await checked(["git", "clone", "--no-hardlinks", join(root, "seed.git"), candidate]);
  await checked(["git", "-C", candidate, "checkout", "--detach", pin.base_commit]);
  const reference = await snapshotUpstreamReference(root, source, pin);
  for (const directory of ["control", "artifacts"]) await mkdir(join(root, directory), { recursive: true });
  await writeFile(join(root, "control/task.md"), pack.snapshot.files[pack.manifest.prompt]!.content);
  const state = {
    schema_version: 1, id: `${id}-qualification-${process.pid}`, status: "complete", created_at: new Date().toISOString(),
    profile: "task", source: { path: source, base_commit: pin.base_commit,
      base_tree: (await checked(["git", "-C", source, "rev-parse", `${pin.base_commit}^{tree}`])).stdout.trim(),
      source_timestamp: 0, forbidden_commit: pin.forbidden_commit },
    task: { path: "control/task.md", sha256: pack.contract.task_sha256 },
    criteria: { path: "evaluator/criteria.json", sha256: "model-free-fixture", contract: pack.contract },
    upstream_reference: reference, image, image_id: image,
    execution: { model: "model-free-fixture", reasoning_effort: "high", service_tier: "default" },
    snapshot_manifest: "unused-model-free-fixture", current_snapshot: { captured_at: new Date().toISOString(), manifest_sha256: "unused" },
    runtime_tools: { bun: "unused", bun_sha256: "unused", codex_source: "unused", codex_sha256: "unused", codex_version: "no-model-execution" },
    timeout_seconds: 120, resource_limits: { cpus: "4", memory: "4g" },
    operator: { uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000 },
    arms: { stock: { repository: "evaluator/stock", home_template: "unused" } }, results: {},
  } as unknown as RunState;
  await ensureDependencyImage("docker", root, state, new AbortController().signal);
  await writeState(root, state);
  return state;
}
