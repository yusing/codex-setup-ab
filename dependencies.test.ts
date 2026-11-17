import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEPENDENCY_ENV, dependencyKey, ensureDependencyImage, discardDownloadedCatalog } from "./dependencies";
import { protectedArgs } from "./isolation";
import { sha256 } from "./state";
import type { RunState } from "./types";
import { MEKUGI_RUNTIME_DIRECTORY, MEKUGI_RUNTIME_FILES, snapshotMekugiRuntime } from "./mekugi-runtime";

function fixture(): RunState {
  return { image_id: `sha256:${"a".repeat(64)}`, source: { base_commit: "base", base_tree: "tree" },
    submodules: [{ path: "sub", sha: "commit", source: "/first/source" }],
    operator: { uid: 1000, gid: 1000 }, runtime_tools: { bun_sha256: "bun" },
    criteria: { contract: { preparation: "true" } } } as RunState;
}

test("catalog reclamation preserves evidence, plugins, setup-owned data and redirected paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-catalog-"));
  try {
    const home = join(root, "home"), template = join(root, "template");
    const catalog = ".codex/cache/remote_plugin_catalog";
    for (const path of [catalog + "/download.json", ".codex/sessions/session.jsonl", ".codex/logs_2.sqlite", ".codex/plugins/cache/plugin.js"]) {
      await mkdir(join(home, path, ".."), { recursive: true });
      await writeFile(join(home, path), "retain unless catalog");
    }
    await discardDownloadedCatalog(home, template);
    expect(await Bun.file(join(home, catalog, "download.json")).exists()).toBe(false);
    for (const path of [".codex/sessions/session.jsonl", ".codex/logs_2.sqlite", ".codex/plugins/cache/plugin.js"]) {
      expect(await Bun.file(join(home, path)).text()).toBe("retain unless catalog");
    }
    await mkdir(join(template, catalog), { recursive: true });
    await mkdir(join(home, catalog), { recursive: true });
    await writeFile(join(home, catalog, "owned.json"), "setup-owned");
    await discardDownloadedCatalog(home, template);
    expect(await Bun.file(join(home, catalog, "owned.json")).text()).toBe("setup-owned");
    await rm(join(home, ".codex/cache"), { recursive: true });
    await symlink(join(template, ".codex/cache"), join(home, ".codex/cache"));
    await writeFile(join(template, catalog, "outside.json"), "outside");
    await discardDownloadedCatalog(home);
    expect(await Bun.file(join(template, catalog, "outside.json")).text()).toBe("outside");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("dependency key pins build inputs, not per-run paths or source locations", () => {
  const state = fixture();
  state.runtime_tools.mekugi_in_image = true;
  state.runtime_tools.mekugi_sha256 = "a".repeat(64);
  const key = dependencyKey(state, state.image_id!);
  const relocated = structuredClone(state);
  relocated.id = "another-run";
  relocated.runtime_tools.bun_sha256 = "different-host-bun";
  relocated.submodules![0]!.source = "/another/source";
  expect(dependencyKey(relocated, state.image_id!)).toBe(key);
  for (const change of [
    (s: RunState) => { s.source.base_commit = "new"; },
    (s: RunState) => { s.source.base_tree = "new"; },
    (s: RunState) => { s.submodules![0]!.sha = "new"; },
    (s: RunState) => { s.runtime_tools.mekugi_sha256 = "b".repeat(64); },
    (s: RunState) => { s.runtime_tools.mekugi_exec_sha256 = "c".repeat(64); },
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

test("dependency images expose neutral cache paths to implementation agents", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-image-test-"));
  try {
    await mkdir(join(root, "artifacts"));
    const docker = join(root, "docker");
    const state = fixture();
    await writeFile(docker, `#!/bin/sh\n[ "$1 $2" = "image inspect" ] || exit 99\nprintf '%s\\n' '${state.image_id}'\n`, { mode: 0o755 });
    await ensureDependencyImage(docker, root, state, new AbortController().signal);
    const recipe = await readFile(join(root, "artifacts/dependencies.Dockerfile"), "utf8");
    expect(DEPENDENCY_ENV).toEqual([
      "GOCACHE=/opt/task-deps/go-build", "GOMODCACHE=/go/pkg/mod", "BUN_INSTALL_CACHE_DIR=/opt/task-deps/bun",
    ]);
    expect(recipe).toContain(`ENV ${DEPENDENCY_ENV.join(" ")}`);
    expect(recipe).toContain("COPY --from=dependencies /opt/task-deps /opt/task-deps");
    expect(recipe).toContain('ENV PATH="/opt/task-deps/python/bin:');
    expect(recipe).toContain("/etc/profile.d/task-tools.sh");
    expect(recipe).not.toContain("/opt/codex-ab-deps");
    expect(recipe.split(`FROM codex-ab-base:${state.image_id!.replace("sha256:", "")}`)[2]).toContain("rmdir /benchmark-agent-issue-reports; fi && mkdir -p /agent-issue-reports");
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("protected cache writes use existing ephemeral tmpfs, not retained home", () => {
  const state = fixture();
  state.protected_runtime = { boundary: "direct-egress-vs-router-only", scripts: [] };
  const args = protectedArgs("/run", state, "/runtime");
  expect(args).toContain("GOCACHE=/tmp/go-build");
  expect(args).toContain("/tmp:exec,size=4g,mode=1777");
  expect(args).not.toContain("GOCACHE=/home/ubuntu/.cache/go-build");
  expect(args).toContain("MEKUGI_EXPORT_DIR=/mekugi-exports");
  expect(args.join(" ")).not.toMatch(/BENCH|benchmark|codex-ab/);
});

test("image builds receive frozen Mekugi bytes and a hash-checked final image recipe", async () => {
  const root = await mkdtemp(join(tmpdir(), "pinned-mekugi-test-"));
  try {
    await mkdir(join(root, "artifacts"));
    await mkdir(join(root, "baseline"));
    await writeFile(join(root, "mekugi"), "frozen Mekugi");
    await writeFile(join(root, "mekugi-exec"), "frozen helper");
    const state = fixture();
    state.arms = { stock: { repository: "baseline" } } as RunState["arms"];
    Object.assign(state.runtime_tools, { bun: "bun", mekugi_source: "mekugi", mekugi_in_image: true, mekugi_sha256: await sha256(join(root, "mekugi")), mekugi_exec_source: "mekugi-exec", mekugi_exec_sha256: await sha256(join(root, "mekugi-exec")) });
    const docker = join(root, "docker");
    await writeFile(docker, `#!/bin/sh
case "$1 $2" in
  'image inspect') if [ ! -f '${root}/built' ]; then echo 'No such image' >&2; exit 1; fi; echo '${state.image_id}' ;;
  'tag '*) ;;
  'build --tag') test ! -e "$4/bun" && cmp '${root}/mekugi' "$4/mekugi" && cmp '${root}/mekugi-exec' "$4/mekugi-exec" && cp "$4/Dockerfile" '${root}/recipe' && touch '${root}/built' ;;
  *) exit 99 ;;
esac
`, { mode: 0o755 });
    await ensureDependencyImage(docker, root, state, new AbortController().signal);
    const recipe = await readFile(join(root, "recipe"), "utf8");
    expect(recipe).toContain("COPY --chmod=755 mekugi /usr/local/bin/mekugi");
    expect(recipe).toContain("COPY --chmod=755 mekugi-exec /usr/local/bin/mekugi-exec");
    expect(recipe).toContain(`${state.runtime_tools.mekugi_exec_sha256}  /usr/local/bin/mekugi-exec`);
    expect(recipe).toContain(`${state.runtime_tools.mekugi_sha256}  /usr/local/bin/mekugi`);
    expect(state.dependency_image?.key).toBe(dependencyKey(state, state.image_id!));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("dependency images package the complete host runtime without replacing the stock code-mode host", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-mekugi-image-"));
  try {
    const installed = join(root, "installed");
    for (const directory of [installed, join(root, "artifacts"), join(root, "baseline")]) await mkdir(directory);
    for (const name of MEKUGI_RUNTIME_FILES) {
      await writeFile(join(installed, name), `host ${name}`, { mode: name === "mekugi-models.json" ? 0o644 : 0o755 });
    }
    const runtime = await snapshotMekugiRuntime(root, join(installed, "mekugi"));
    const state = fixture();
    state.arms = { stock: { repository: "baseline" } } as RunState["arms"];
    Object.assign(state.runtime_tools, { mekugi_runtime: runtime, mekugi_in_image: true,
      mekugi_source: runtime[0]!.source, mekugi_sha256: runtime[0]!.sha256,
      mekugi_exec_source: runtime[1]!.source, mekugi_exec_sha256: runtime[1]!.sha256 });
    const key = dependencyKey(state, state.image_id!);
    for (const file of runtime) {
      const original = file.sha256;
      file.sha256 = "f".repeat(64);
      expect(dependencyKey(state, state.image_id!)).not.toBe(key);
      file.sha256 = original;
    }
    // The original installation need not survive preparation.
    await rm(installed, { recursive: true });
    const docker = join(root, "docker");
    await writeFile(docker, `#!/bin/sh
set -eu
case "$1 $2" in
  'image inspect') if [ ! -f '${root}/built' ]; then echo 'No such image' >&2; exit 1; fi; echo '${state.image_id}' ;;
  'tag '*) ;;
  'build --tag')
    ${runtime.map(file => `cmp '${join(root, file.source)}' "$4/${file.name}"`).join("\n    ")}
    cp "$4/Dockerfile" '${root}/recipe'
    touch '${root}/built' ;;
  *) exit 99 ;;
esac
`, { mode: 0o755 });
    await ensureDependencyImage(docker, root, state, new AbortController().signal);
    const recipe = await readFile(join(root, "recipe"), "utf8");
    for (const file of runtime) {
      expect(recipe).toContain(`COPY --chmod=${file.name === "mekugi-models.json" ? "644" : "755"} ${file.name} ${MEKUGI_RUNTIME_DIRECTORY}/${file.name}`);
      expect(recipe).toContain(`${file.sha256}  ${MEKUGI_RUNTIME_DIRECTORY}/${file.name}`);
    }
    expect(recipe).toContain(`ln -s ${MEKUGI_RUNTIME_DIRECTORY}/mekugi /usr/local/bin/mekugi`);
    expect(recipe).not.toContain(" /usr/local/bin/codex-code-mode-host");
    await writeFile(join(root, runtime[2]!.source), "tampered app server");
    await expect(ensureDependencyImage(docker, root, state, new AbortController().signal)).rejects.toThrow("snapshotted Mekugi runtime changed: mekugi-app-server");
  } finally { await rm(root, { recursive: true, force: true }); }
});
