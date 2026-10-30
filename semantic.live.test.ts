import { expect, spyOn, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeSemanticCheck, prepareEvaluatorCache } from "./semantic";
import { checked } from "./process";
import { readState } from "./state";
import type { RunState } from "./types";
import * as containers from "./container";

const liveTest = process.env.CODEX_AB_LIVE_DOCKER === "1" ? test : test.skip;
const reference = process.env.CODEX_AB_LIVE_REFERENCE_RUN;
const cacheTest = process.env.CODEX_AB_LIVE_DOCKER === "1" && reference ? test : test.skip;

cacheTest("real pinned baseline shares an image cache without per-run copies or cross-check writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-evaluator-cache-live-"));
  try {
    const state = await readState(reference!);
    state.id = `cache-live-${process.pid}`;
    state.timeout_seconds = 120;
    state.arms = { stock: { repository: "evaluator/stock", home_template: "unused" } };
    delete state.evaluator_cache_image;
    await cp(join(reference!, "seed.git"), join(root, "seed.git"), { recursive: true, verbatimSymlinks: true });
    const candidate = join(root, "evaluator/stock");
    await checked(["git", "clone", "--no-local", "--no-hardlinks", "--branch", "work", join(root, "seed.git"), candidate]);
    await prepareEvaluatorCache(root, state, "docker");
    const restricted = await containers.runOwnedContainer({ docker: "docker", name: `task-cache-owner-only-${process.pid}`,
      snapshotImage: `task-cache-owner-only:${crypto.randomUUID()}`, snapshotUser: "1000:1000", timeoutMs: 30_000,
      createArgs: ["--network", "none", "--user", "0:0", "--cap-drop", "ALL", "--cap-add", "FOWNER", "--cap-add", "CHOWN",
        state.evaluator_cache_image!.image_id, "python3", "-c",
        "import pathlib,os; p=next(pathlib.Path('/opt/task-deps/go-build').rglob('*-d')); os.chown(p,1000,1000); p.chmod(0o600); print(p)"] });
    expect(restricted.exitCode).toBe(0);
    const ownerOnlyPayload = restricted.stdout.trim();
    expect(ownerOnlyPayload).toMatch(/^\/opt\/task-deps\/go-build\/[a-f0-9]{2}\/[a-f0-9]{64}-d$/);
    state.dependency_image!.image_id = restricted.snapshotImageId!;
    delete state.evaluator_cache_image;
    await prepareEvaluatorCache(root, state, "docker");
    expect(state.evaluator_cache_image?.image_id).toMatch(/^sha256:[a-f0-9]{64}$/);
    const reused = structuredClone(state); delete reused.evaluator_cache_image;
    await prepareEvaluatorCache(root, reused, "docker");
    expect(reused.evaluator_cache_image).toEqual(state.evaluator_cache_image);
    for (const name of ["noop", "first", "second", "executable"]) {
      const command = name === "noop" ? 'test "$GOCACHE" = /opt/task-deps/go-build && test ! -e /tmp/go-build' :
        name === "executable" ? 'go run -x ./cache-reuse/main.go > /tmp/first.out 2>/tmp/first.trace && go run -x ./cache-reuse/main.go > /tmp/second.out 2>/tmp/second.trace && test "$(cat /tmp/second.out)" = reused && ! grep -E "/pkg/tool/[^ ]+/link " /tmp/second.trace && go clean -cache' :
        'test ! -e "$GOCACHE/cross-check-write" && test ! -e "$BUN_INSTALL_CACHE_DIR/cross-check-write" && go test -run "^$" .'
        + (name === "first" ? ' && printf poison > "$GOCACHE/cross-check-write" && printf poison > "$BUN_INSTALL_CACHE_DIR/cross-check-write"' : "");
      const evidence = await executeSemanticCheck({ runDir: root, state, candidate,
        output: join(root, "evidence", name), name: `task-evaluator-cache-${process.pid}-${name}`, docker: "docker",
        check: { criterion: "baseline", rationale: "Pinned baseline compiles offline with private native cache writes.",
          files: name === "executable" ? [{ path: "cache-reuse/main.go", source: 'package main\nimport "fmt"\nfunc main() { fmt.Println("reused") }\n' }] : [], command: ["sh", "-c", `test -r ${ownerOnlyPayload} && ${command}`] } });
      expect(evidence.status).toBe("pass");
    }
    const images: string[] = [];
    try {
      const aged = await containers.runOwnedContainer({ docker: "docker", name: `task-cache-aged-${process.pid}`,
        snapshotImage: `task-cache-test:${crypto.randomUUID()}`, snapshotUser: "1000:1000", timeoutMs: 60_000,
        onSnapshot: image => { images.push(image); },
        createArgs: ["--network", "none", "--user", "0:0", "--cap-drop", "ALL", "--cap-add", "FOWNER",
          "--cpus", state.resource_limits.cpus, "--memory", state.resource_limits.memory, state.evaluator_cache_image!.image_id,
          "sh", "-c", 'find "$GOCACHE" -type f -exec touch -d "6 days ago" {} +; chmod 666 "$GOCACHE/trim.txt"; date -d "6 days ago" +%s > "$GOCACHE/trim.txt"'] });
      expect(aged.exitCode).toBe(0);
      expect((await checked(["docker", "image", "inspect", "--format", "{{.Config.User}}", aged.snapshotImageId!])).stdout.trim()).toBe("1000:1000");
      const owned = containers.runOwnedContainer;
      let privateBytes = Infinity;
      const capture = spyOn(containers, "runOwnedContainer").mockImplementation(options => owned({ ...options,
        snapshotImage: `task-cache-test:${crypto.randomUUID()}`,
        onSnapshot: async image => {
          images.push(image);
          privateBytes = JSON.parse((await checked(["docker", "container", "inspect", "--size", options.name])).stdout)[0].SizeRw;
        } }));
      try {
        const evidence = await executeSemanticCheck({ runDir: root, state: { ...state, evaluator_cache_image: { ...state.evaluator_cache_image!, image_id: aged.snapshotImageId! } },
          candidate, output: join(root, "evidence", "aged"), name: `task-cache-aged-check-${process.pid}`, docker: "docker",
          check: { criterion: "baseline", rationale: "An aged seed keeps payloads shared while repeated native Go compilation succeeds.", files: [], command: ["sh", "-c", 'go test -run "^$" . && go test -run "^$" .'] } });
        expect(evidence.status).toBe("pass");
        expect(privateBytes).toBeLessThan(50_000_000);
      } finally { capture.mockRestore(); }
    } finally {
      for (const image of images.reverse()) await checked(["docker", "image", "rm", image]);
    }
    expect(await Bun.file(join(root, "evaluator/compiler-cache/go-build")).exists()).toBe(false);
    const kib = Number((await checked(["du", "-sk", root])).stdout.split(/\s+/)[0]);
    expect(kib).toBeLessThan(200_000);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 300_000);

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
          command: ["bun", "extra.cjs"] } });
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
