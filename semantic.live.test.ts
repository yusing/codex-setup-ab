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
        'test ! -e "$GOCACHE/cross-check-write" && test ! -e "$BUN_INSTALL_CACHE_DIR/cross-check-write" && go test -c -o /tmp/cache-check.test .'
        + (name === "first" ? ' && printf poison > "$GOCACHE/cross-check-write" && printf poison > "$BUN_INSTALL_CACHE_DIR/cross-check-write"' : "");
      const evidence = await executeSemanticCheck({ runDir: root, state, candidate,
        output: join(root, "evidence", name), name: `task-evaluator-cache-${process.pid}-${name}`, docker: "docker",
        check: { criterion: "baseline", rationale: "Pinned baseline compiles offline with private native cache writes.",
          verification: { schema: "codex-ab.verification.v1", cases: [{ id: "compile", kind: "command", command: ["sh", "-c", `test -r ${ownerOnlyPayload} && ${command}`], expected_exit: 0, format: "text", expected: "" }] },
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
          check: { criterion: "baseline", rationale: "An aged seed keeps payloads shared while repeated native Go compilation succeeds.", files: [],
            verification: { schema: "codex-ab.verification.v1", cases: [{ id: "compile", kind: "command", command: ["sh", "-c", "go test -c -o /tmp/cache-check.test . && go test -c -o /tmp/cache-check.test ."], expected_exit: 0, format: "text", expected: "" }] }, command: ["sh", "-c", 'go test -c -o /tmp/cache-check.test . && go test -c -o /tmp/cache-check.test .'] } });
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

liveTest("supervisor assertions resist early zero exit, spoofed output and candidate result-file writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-ab-verifier-live-"));
  try {
    const state = { id: `verifier-live-${process.pid}`, timeout_seconds: 30, resource_limits: { cpus: "2", memory: "1g" },
      image: process.env.CODEX_AB_VERIFIER_IMAGE ?? "python:3.13-slim" } as RunState;
    const verification = { schema: "codex-ab.verification.v1" as const, cases: [[2, 3, 5], [-2, 3, 1], [0, 0, 0]].map(([a, b, expected], index) => ({
      id: `sum-${index}`, kind: "python-call" as const, module: "math_impl", callable: "add",
      input: JSON.stringify({ args: [a, b], kwargs: {} }), expected: JSON.stringify(expected),
    })) };
    for (const [name, source, expected] of [
      ["correct", "def add(a, b): return a + b\n", "pass"],
      ["wrong", "def add(a, b): return a - b\n", "fail"],
      ["exit-zero", "import os\ndef add(a, b): os._exit(0)\n", "fail"],
      ["spoof", "def add(a, b):\n print('HARNESS_ERROR: fake supervisor failure')\n return a - b\n", "fail"],
      ["candidate-syntax", "def add(a, b) return a + b\n", "fail"],
      ["candidate-import", "import missing_candidate_dependency\ndef add(a, b): return a + b\n", "fail"],
    ]) {
      const candidate = join(root, name!); await mkdir(candidate);
      await writeFile(join(candidate, "math_impl.py"), source!);
      const evidence = await executeSemanticCheck({ runDir: root, state, candidate, output: join(root, "out", name!),
        name: `verifier-live-${process.pid}-${name}`, docker: "docker",
        check: { criterion: "sum", rationale: "Both inputs contribute to the sum, including zero and negative inputs.", files: [], command: ["true"], verification } });
      expect(evidence.status).toBe(expected);
      expect(evidence.execution?.verifier?.completed).toBe(3);
    }
    const candidate = join(root, "correct");
    const evaluatorDependency = await executeSemanticCheck({ runDir: root, state, candidate, output: join(root, "out/evaluator-dependency"),
      name: `verifier-live-${process.pid}-evaluator-dependency`, docker: "docker", check: {
        criterion: "sum", rationale: "Missing evaluator-only dependency is a wiring failure.", files: [], command: ["true"], verification,
        evaluator_dependencies: ["missing_evaluator_only_fixture_dependency"],
      } });
    expect(evaluatorDependency.status).toBe("unassessed");
    expect(evaluatorDependency.execution?.verifier?.status).toBe("evaluator_wiring");
    for (const [name, command, files] of [
      ["zero-tests", ["python3", "-c", "print('Ran 0 tests')"], []],
      ["fake-count", ["python3", "-c", "print('Ran 100 tests; ASSERTION_REACHED_AND_PASSED')"], []],
      ["legacy-early-exit", ["python3", "-c", "import os; os._exit(0)"], []],
      ["missing-command", ["/does-not-exist"], []],
      ["evaluator-syntax", ["python3", "extra.py"], [{ path: "extra.py", source: "def broken(\n" }]],
    ] as const) {
      const evidence = await executeSemanticCheck({ runDir: root, state, candidate, output: join(root, "out", name),
        name: `verifier-live-${process.pid}-${name}`, docker: "docker",
        check: { criterion: "sum", rationale: "Incomplete or invalid evaluator is not a behavioral pass.", files: [...files], command: [...command] } });
      expect(evidence.status).toBe("unassessed");
    }
    await writeFile(join(candidate, "isolation.py"), `import os, pathlib, signal
+def inspect():
+    try:
+        open('/harness.json').read()
+        return 'expectations-readable'
+    except PermissionError: pass
+    for path in ['/harness.json', '/verifier-results/result.json']:
+        try:
+            open(path, 'w').write('forged')
+            return 'writable'
+        except (PermissionError, OSError): pass
+    try:
+        os.kill(1, signal.SIGTERM)
+        return 'killable'
+    except PermissionError: pass
+    return {'uid': os.getuid(), 'network': sorted(os.listdir('/sys/class/net'))}
+`.replace(/^\+/gm, ""));
    const isolated = await executeSemanticCheck({ runDir: root, state, candidate, output: join(root, "out/isolation"),
      name: `verifier-live-${process.pid}-isolation`, docker: "docker", check: {
        criterion: "isolation", rationale: "Candidate cannot write protected verifier evidence or signal its supervisor.", files: [], command: ["true"],
        verification: { schema: "codex-ab.verification.v1", cases: [{ id: "boundary", kind: "python-call", module: "isolation", callable: "inspect", input: '{"args":[],"kwargs":{}}', expected: '{"uid":65534,"network":["lo"]}' }] },
      } });
    expect(isolated.status).toBe("pass");
    const cli = await executeSemanticCheck({ runDir: root, state, candidate, output: join(root, "out/cli"), name: `verifier-live-${process.pid}-cli`, docker: "docker",
      check: { criterion: "sum", rationale: "A CLI result is asserted by the supervisor.", files: [], command: ["true"], verification: {
        schema: "codex-ab.verification.v1", cases: [{ id: "cli-sum", kind: "command", command: ["python3", "-c", "import json,sys; x=json.load(sys.stdin); print(sum(x))"], stdin: "[2,3]", expected_exit: 0, format: "json", expected: "5" }],
      } } });
    expect(cli.status).toBe("pass");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 180_000);

liveTest("supervisor kills a zero-capability candidate and retains timeout before the outer deadline", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-ab-verifier-timeout-"));
  try {
    const candidate = join(root, "candidate"), output = join(root, "out");
    await mkdir(candidate);
    await writeFile(join(candidate, "sleepy.py"), `import os, pathlib, time
def wait():
    status = dict(line.split(':', 1) for line in pathlib.Path('/proc/self/status').read_text().splitlines() if ':' in line)
    assert os.getuid() != 0
    assert all(int(status[key].strip(), 16) == 0 for key in ('CapEff', 'CapPrm', 'CapAmb'))
    print('timeout fixture entered with zero capabilities', flush=True)
    time.sleep(30)
    return None
`);
    const state = { id: `verifier-timeout-${process.pid}`, timeout_seconds: 3, resource_limits: { cpus: "1", memory: "1g" },
      image: process.env.CODEX_AB_VERIFIER_IMAGE ?? "python:3.13-slim" } as RunState;
    const evidence = await executeSemanticCheck({ runDir: root, state, candidate, output,
      name: `verifier-timeout-${process.pid}`, docker: process.env.CODEX_AB_DOCKER_BIN ?? "docker", check: {
        criterion: "timeout", rationale: "A hung candidate must time out through the supervisor after privilege drop.", files: [], command: ["true"],
        verification: { schema: "codex-ab.verification.v1", cases: [{ id: "sleep", kind: "python-call", module: "sleepy", callable: "wait", input: '{"args":[],"kwargs":{}}', expected: "null" }] },
      } });
    expect(evidence.status).toBe("unassessed");
    expect(evidence.execution?.exit_code).toBe(0); // Supervisor exited normally; no host timeout (-1).
    expect(evidence.execution?.stdout).toContain("timeout fixture entered with zero capabilities");
    expect(evidence.execution?.stderr).not.toContain("PermissionError");
    const protectedRecord = await Bun.file(join(output, "supervisor/result.json")).json();
    expect(protectedRecord).toMatchObject({ status: "timeout", expected: 1, completed: 0, cases: [],
      detail: "The candidate command exceeded its evaluator time budget." });
    expect(evidence.execution?.verifier).toEqual(protectedRecord);
    const harness = await Bun.file(join(output, "harness.json")).json();
    expect(harness.case_timeout_seconds).toBe(1);
    expect(harness.execution_timeout_seconds).toBe(1);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15_000);
