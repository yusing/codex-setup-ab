import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadTaskPack, snapshotUpstreamReference } from "../task-pack";
import { checked } from "../process";
import { writeState } from "../state";
import type { CriteriaContract, SemanticCheck } from "../semantic";
import type { RunState } from "../types";

/** Model-free authored checks use the actual Flask.run observer, with expectations outside its process. */
export function flaskQualificationChecks(contract: CriteriaContract): SemanticCheck[] {
  const existing = contract.existing_test_verification?.cases.find(item => item.id === "existing-flask-observations");
  if (!existing || existing.kind !== "command") throw new Error("Flask pack has no frozen behavior observer");
  const addresses = [
    [{ id: "ipv6-default", server_name: "[::1]" }, "::1", 5000],
    [{ id: "ipv6-port", server_name: "[::1]:8080" }, "::1", 8080],
    [{ id: "ipv6-long", server_name: "[2001:db8::abcd]" }, "2001:db8::abcd", 5000],
    [{ id: "ipv6-configured-zero", server_name: "[2001:db8::abcd]:0" }, "2001:db8::abcd", 0],
    [{ id: "ipv6-host-override", server_name: "[::1]:8080", host: "0.0.0.0" }, "0.0.0.0", 8080],
    [{ id: "ipv6-explicit-zero", server_name: "[::1]:8080", port: 0 }, "::1", 0],
    [{ id: "ipv6-port-override", server_name: "[::1]", port: 9000 }, "::1", 9000],
  ] as const;
  const ipv6 = { ...existing, id: "ipv6-flask-observations",
    stdin: JSON.stringify(addresses.map(([input]) => input)), expected: JSON.stringify(addresses.map(([input, host, port]) => ({
      id: input.id, host, port, debug: false, options: { use_reloader: false, use_debugger: false, threaded: true },
      same_application: true, cleaned_up: true,
    }))) };
  return [
    { criterion: "ipv6-server-name", files: [], command: existing.command,
      rationale: "Observe real Flask.run preserving bracketed IPv6 with defaults, configured ports, and explicit overrides including zero.",
      verification: { schema: "codex-ab.verification.v1", cases: [ipv6] } },
    { criterion: "existing-address-selection", files: [], command: existing.command,
      rationale: "Observe real Flask.run retaining DNS/IPv4 defaults, overrides, debug/options, and cleanup on return and exception.",
      verification: { schema: "codex-ab.verification.v1", cases: [existing] } },
  ];
}

/** The reference candidate and all controls come from pinned upstream source, without an implementation agent. */
export async function prepareFlaskQualificationRun(source: string, root: string, image: string): Promise<RunState> {
  const pack = await loadTaskPack(join(import.meta.dir, "../tasks/flask-ipv6-server-name/manifest.json"));
  const pin = pack.manifest.source;
  // Hydrate pinned baseline blobs before cloning a possibly partial source repository.
  await checked(["git", "-C", source, "archive", "--format=tar", "-o", join(root, "baseline.tar"), pin.base_commit]);
  await checked(["git", "clone", "--bare", "--no-hardlinks", source, join(root, "seed.git")]);
  const reference = await snapshotUpstreamReference(root, source, pin);
  const candidate = join(root, "evaluator/stock");
  await mkdir(candidate, { recursive: true });
  // This fixture uses per-arm cache mounts instead of a dependency_image.
  // Create their bind sources as the host operator before Docker can create
  // root-owned parent directories that would prevent fixture cleanup.
  for (const cache of ["grader-go-pkg-cache", "grader-bun-cache"]) {
    await mkdir(join(root, "arms/stock", cache), { recursive: true });
  }
  await checked(["tar", "-xf", join(root, "baseline.tar"), "-C", candidate]);
  await checked(["git", "-C", candidate, "apply", "--binary", join(root, "evaluator/upstream/changes.patch")]);
  await mkdir(join(root, "control"), { recursive: true });
  await writeFile(join(root, "control/task.md"), pack.snapshot.files[pack.manifest.prompt]!.content);
  const state = {
    schema_version: 1, id: `flask-qualification-${process.pid}`, status: "complete", created_at: new Date().toISOString(),
    profile: "task", source: { path: source, base_commit: pin.base_commit,
      base_tree: (await checked(["git", "-C", source, "rev-parse", `${pin.base_commit}^{tree}`])).stdout.trim(),
      source_timestamp: 0, forbidden_commit: pin.forbidden_commit },
    task: { path: "control/task.md", sha256: pack.contract.task_sha256 },
    criteria: { path: "evaluator/criteria.json", sha256: "model-free-fixture", contract: pack.contract },
    upstream_reference: reference, image, image_id: image,
    execution: { model: "gpt-6.1-sol", reasoning_effort: "high", service_tier: "default" },
    snapshot_manifest: "unused-model-free-fixture", current_snapshot: { captured_at: new Date().toISOString(), manifest_sha256: "unused" },
    runtime_tools: { bun: "unused", bun_sha256: "unused", codex_source: "unused", codex_sha256: "unused", codex_version: "no-model-execution" },
    timeout_seconds: 60, resource_limits: { cpus: "2", memory: "1g" },
    operator: { uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000 },
    arms: { stock: { repository: "evaluator/stock", home_template: "unused" } },
    results: { stock: { arm: "stock", anonymous_id: "candidate-1", container: "no-implementation-container",
      started_at: new Date().toISOString(), finished_at: new Date().toISOString(), agent_elapsed_ms: 0,
      exit_code: 0, timed_out: false, canceled: false, patch_path: "evaluator/upstream/changes.patch", stdout_path: "unused", stderr_path: "unused",
      changed_files: ["src/flask/app.py", "tests/test_basic.py"], head_after_agent: pin.reference_commit!, grade: { passed: false, elapsed_ms: 0,
      preparation: { command: "fixture: pinned source and dependencies", started_at: new Date().toISOString(), elapsed_ms: 0, exit_code: 0, stdout: "", stderr: "" },
      router_suite: { command: "not run", started_at: new Date().toISOString(), elapsed_ms: 0, exit_code: -1, stdout: "", stderr: "" } } } },
  } as RunState;
  await writeState(root, state);
  return state;
}
