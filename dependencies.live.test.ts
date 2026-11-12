import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checked } from "./process";
import { dependencyImage, ensureDependencyImage, generatedDependencyDirectories } from "./dependencies";
import { runOwnedContainer } from "./container";
import candidateSource from "./candidate-script.txt" with { type: "text" };
import type { RunState } from "./types";

const source = process.env.CODEX_AB_LIVE_DEPENDENCY_SOURCE;
const liveTest = process.env.CODEX_AB_LIVE_DOCKER === "1" && source ? test : test.skip;
liveTest("real workload reuses dependency image offline with isolated writes and excluded capture caches", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-ab-deps-live-"));
  const docker = process.env.CODEX_AB_DOCKER_BIN ?? "docker";
  const image = process.env.CODEX_AB_LIVE_IMAGE ?? "codex-ab:0.1.0";
  try {
    await mkdir(join(root, "artifacts"));
    await checked(["git", "clone", "--depth=1", "--no-local", source!, join(root, "repo")]);
    await checked(["git", "-C", join(root, "repo"), "remote", "remove", "origin"]);
    await checked(["git", "clone", "--bare", "--no-hardlinks", join(root, "repo"), join(root, "seed.git")]);
    const baseImage = (await checked([docker, "image", "inspect", "--format", "{{.Id}}", image])).stdout.trim();
    const state = {
      image_id: baseImage, operator: { uid: 1000, gid: 1000 },
      source: { base_commit: (await checked(["git", "-C", join(root, "repo"), "rev-parse", "HEAD"])).stdout.trim(),
        base_tree: (await checked(["git", "-C", join(root, "repo"), "rev-parse", "HEAD^{tree}"])).stdout.trim() },
      arms: { stock: { repository: "repo" } }, runtime_tools: { bun: process.execPath, bun_sha256: new Bun.CryptoHasher("sha256").update(await Bun.file(process.execPath).arrayBuffer()).digest("hex") },
      criteria: { contract: { preparation: "bun install --cwd plugins --frozen-lockfile && go mod download && go generate ./internal/router/toolplugin" } },
    } as RunState;
    await ensureDependencyImage(docker, root, state, new AbortController().signal);
    const first = state.dependency_image;
    await ensureDependencyImage(docker, root, state, new AbortController().signal);
    expect(state.dependency_image).toEqual(first);
    await cp(join(root, "repo"), join(root, "repo-b"), { recursive: true });
    await mkdir(join(root, "home-a"));
    await mkdir(join(root, "home-b"));
    const common = ["--network", "none", "-v", `${join(root, "repo")}:/baseline:ro`];
    const preparation = `cp -a /baseline /tmp/work && cd /tmp/work && ${state.criteria!.contract.preparation}`;
    const run = (suffix: string, args: string[], command: string) => runOwnedContainer({ docker, name: `codex-ab-deps-live-${process.pid}-${suffix}`, timeoutMs: 600_000,
      createArgs: [...common, ...args, dependencyImage(state), "sh", "-lc", command] });
    const a = await run("agent", ["-v", `${join(root, "repo")}:/workspace`, "-v", `${join(root, "home-a")}:/home/ubuntu`], `${state.criteria!.contract.preparation} && go test ./internal/router/toolplugin && printf changed > /opt/task-deps/bun/private-write`);
    expect(a.exitCode, a.stderr).toBe(0);
    const b = await run("sibling", ["-v", `${join(root, "repo-b")}:/workspace`, "-v", `${join(root, "home-b")}:/home/ubuntu`], `${state.criteria!.contract.preparation} && test ! -e /opt/task-deps/bun/private-write`);
    expect(b.exitCode, b.stderr).toBe(0);
    await mkdir(join(root, "captures"));
    for (const repo of ["repo", "repo-b"]) {
      const path = join(root, repo);
      const directories = await generatedDependencyDirectories(path);
      expect(directories).toContain("plugins/node_modules/");
      const capture = join(root, "captures", repo);
      await mkdir(capture);
      const captured = await runOwnedContainer({ docker, name: `codex-ab-deps-live-${process.pid}-capture-${repo}`,
        createArgs: ["--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "-v", `${path}:/workspace:ro`,
          "-v", `${join(root, "seed.git")}:/seed.git:ro`, "-v", `${capture}:/capture`,
          dependencyImage(state), "bun", "-e", candidateSource,
          JSON.stringify({ mode: "capture", baseline: false, clean: false, base: state.source.base_commit,
            tree: state.source.base_tree, forbidden: "0".repeat(40), icons: false, submodules: [], discardDependencies: directories })] });
      expect(captured.exitCode, captured.stderr).toBe(0);
      const manifest = await Bun.file(join(capture, "candidate-manifest.json")).json();
      expect(manifest.excluded_directories).toEqual(directories);
      expect(manifest.files.some((file: { path: string }) => directories.some(directory => file.path.startsWith(directory)))).toBe(false);
      expect(await generatedDependencyDirectories(path)).toEqual(directories);
    }
    const grader = await run("grader", ["--read-only", "--tmpfs", "/tmp:exec,size=4g,mode=1777", "-e", "GOCACHE=/tmp/go-build", "-e", "GOPROXY=off", "-e", "GOSUMDB=off"],
      `${preparation} && test ! -e /opt/task-deps/bun/private-write && go test ./internal/router/toolplugin`);
    expect(grader.exitCode, grader.stderr).toBe(0);
    const captureBytes = Number((await checked(["du", "-sb", join(root, "captures")])).stdout.split(/\s/)[0]);
    const workspaceBytes = (await checked(["du", "-sb", join(root, "repo"), join(root, "repo-b")])).stdout.split("\n").filter(Boolean)
      .reduce((total, line) => total + Number(line.split(/\s/)[0]), 0);
    await writeFile(join(root, "artifacts/measurement.json"), JSON.stringify({ capture_bytes: captureBytes, workspace_bytes: workspaceBytes, dependency_image: first }));
    console.log(`dependency fixture: ${captureBytes} capture-artifact bytes, ${workspaceBytes} retained workspace bytes; shared image ${first!.image_id}`);
  } catch (error) {
    const log = Bun.file(join(root, "artifacts/dependencies.stderr"));
    if (await log.exists()) console.error(await log.text());
    throw error;
  } finally { await rm(root, { recursive: true, force: true }); }
}, 1_500_000);
