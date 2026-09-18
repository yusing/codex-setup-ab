import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dependencyKey, ensureDependencyImage } from "./dependencies";
import { protectedArgs } from "./isolation";
import type { RunState } from "./types";

function fixture(): RunState {
  return { image_id: `sha256:${"a".repeat(64)}`, source: { base_commit: "base", base_tree: "tree" },
    submodules: [{ path: "sub", sha: "commit", source: "/first/source" }],
    operator: { uid: 1000, gid: 1000 }, runtime_tools: { bun_sha256: "bun" },
    criteria: { contract: { preparation: "true" } } } as RunState;
}

test("dependency key pins build inputs, not per-run paths or source locations", () => {
  const state = fixture();
  const key = dependencyKey(state, state.image_id!);
  const relocated = structuredClone(state);
  relocated.id = "another-run";
  relocated.submodules![0]!.source = "/another/source";
  expect(dependencyKey(relocated, state.image_id!)).toBe(key);
  for (const change of [
    (s: RunState) => { s.source.base_commit = "new"; },
    (s: RunState) => { s.source.base_tree = "new"; },
    (s: RunState) => { s.submodules![0]!.sha = "new"; },
    (s: RunState) => { s.runtime_tools.bun_sha256 = "new"; },
    (s: RunState) => { s.criteria!.contract.preparation = "false"; },
    (s: RunState) => { s.operator.uid = 1234; },
  ]) {
    const changed = structuredClone(state); change(changed);
    expect(dependencyKey(changed, state.image_id!)).not.toBe(key);
  }
  expect(dependencyKey(state, `sha256:${"b".repeat(64)}`)).not.toBe(key);
});

test("pinned images reject changed inputs before Docker runs", async () => {
  const state = fixture();
  state.dependency_image = { key: dependencyKey(state, state.image_id!), base_image: state.image_id!, image_id: `sha256:${"b".repeat(64)}` };
  state.criteria!.contract.preparation = "false";
  await expect(ensureDependencyImage("/must-not-run", "/unused", state, new AbortController().signal)).rejects.toThrow("inputs changed");
});

test("image inspection failures never start a build or set a pin", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-ab-deps-test-"));
  try {
    await mkdir(join(root, "artifacts"));
    const docker = join(root, "docker");
    await writeFile(docker, '#!/bin/sh\n[ "$1 $2" = "image inspect" ] || exit 99\necho "daemon unavailable" >&2\nexit 1\n', { mode: 0o755 });
    const state = fixture();
    await expect(ensureDependencyImage(docker, root, state, new AbortController().signal)).rejects.toThrow("daemon unavailable");
    expect(state.dependency_image).toBeUndefined();
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("protected cache writes use existing ephemeral tmpfs, not retained home", () => {
  const state = fixture();
  state.protected_runtime = { boundary: "direct-egress-vs-router-only", scripts: [] };
  const args = protectedArgs("/run", state, "/runtime");
  expect(args).toContain("GOCACHE=/tmp/go-build");
  expect(args).toContain("/tmp:exec,size=4g,mode=1777");
  expect(args).not.toContain("GOCACHE=/home/ubuntu/.cache/go-build");
});
