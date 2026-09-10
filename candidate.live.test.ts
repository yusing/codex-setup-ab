import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import source from "./candidate-script.txt" with { type: "text" };
import { runOwnedContainer } from "./container";
import { checked } from "./process";
import { acceptanceExecutionError } from "./grading";

const liveTest = process.env.CODEX_AB_LIVE_DOCKER === "1" ? test : test.skip;
const docker = process.env.CODEX_AB_DOCKER_BIN ?? "docker";
const image = process.env.CODEX_AB_LIVE_IMAGE ?? "codex-ab:0.1.0";
let root: string;
let repo: string;
let capture: string;
let base: string;
let tree: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "codex-ab-candidate-test-"));
  repo = join(root, "repository"); capture = join(root, "capture");
  await mkdir(repo); await mkdir(capture);
  await checked(["git", "init", repo]);
  await checked(["git", "-C", repo, "config", "user.email", "fixture@example.invalid"]);
  await checked(["git", "-C", repo, "config", "user.name", "Fixture"]);
  await writeFile(join(repo, "go.mod"), "module fixture\n\ngo 1.26\n");
  await writeFile(join(repo, "fixture.go"), "package fixture\n");
  await checked(["git", "-C", repo, "add", "."]);
  await checked(["git", "-C", repo, "commit", "-m", "base"]);
  base = (await checked(["git", "-C", repo, "rev-parse", "HEAD"])).stdout.trim();
  tree = (await checked(["git", "-C", repo, "rev-parse", "HEAD^{tree}"])).stdout.trim();
});
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

async function inspect(mode: "verify" | "capture", baseline = false): Promise<Awaited<ReturnType<typeof runOwnedContainer>>> {
  return runOwnedContainer({ docker, name: `codex-ab-candidate-${crypto.randomUUID()}`, timeoutMs: 30_000,
    createArgs: ["--network", "none", "-e", "GIT_OPTIONAL_LOCKS=0", "-v", `${repo}:/workspace`, "-v", `${capture}:/capture`,
      "-v", `${process.execPath}:/usr/local/bin/bun:ro`, image, "bun", "-e", source,
      JSON.stringify({ mode, baseline, clean: baseline, base, tree, forbidden: "f".repeat(40), icons: false, submodules: [] })] });
}

liveTest("live capture preserves commits and exact unusual filenames without executing Git hooks on the host", async () => {
  await writeFile(join(repo, "committed.txt"), "committed change\n");
  await checked(["git", "-C", repo, "add", "."]);
  await checked(["git", "-C", repo, "commit", "-m", "candidate"]);
  const unusual = "雪\tline\nbreak.txt";
  await writeFile(join(repo, unusual), "untracked change\n");
  const victim = join(root, "host-victim");
  await writeFile(victim, "untouched");
  const hook = join(repo, ".git/fsmonitor");
  await writeFile(hook, `#!/bin/sh\nprintf compromised >'${victim}' 2>/dev/null || true\nprintf invoked >/workspace/hook-ran\nprintf '\\0'\n`);
  await chmod(hook, 0o755);
  await checked(["git", "-C", repo, "config", "core.fsmonitor", ".git/fsmonitor"]);
  const result = await inspect("capture");
  expect(result.stderr).not.toContain("SyntaxError");
  expect(result.exitCode).toBe(0);
  expect(await readFile(victim, "utf8")).toBe("untouched");
  expect(await readFile(join(repo, "hook-ran"), "utf8")).toBe("invoked");
  const metadata = await Bun.file(join(capture, "result.json")).json();
  expect(metadata.changed_files).toContain(unusual);
  expect(metadata.changed_files).toContain("committed.txt");
  const evaluator = join(root, "evaluator");
  await checked(["git", "init", evaluator]);
  await checked(["git", "-C", evaluator, "apply", "--binary", join(capture, "changes.patch")]);
  expect(await readFile(join(evaluator, unusual), "utf8")).toBe("untracked change\n");
}, 30_000);

liveTest("live baseline verification rejects a clean extra commit", async () => {
  await checked(["git", "-C", repo, "commit", "--allow-empty", "-m", "different baseline"]);
  const result = await inspect("verify", true);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("baseline identity changed");
}, 30_000);

liveTest("live capture never follows an output symlink into the host filesystem", async () => {
  const victim = join(root, "host-victim");
  await writeFile(victim, "untouched");
  await symlink(victim, join(capture, "changes.patch"));
  expect((await inspect("capture")).exitCode).not.toBe(0);
  expect(await readFile(victim, "utf8")).toBe("untouched");
}, 30_000);

liveTest("real Go TestMain early success is rejected as unexecuted acceptance", async () => {
  await writeFile(join(repo, "acceptance_test.go"), 'package fixture\nimport ("testing"; "os")\nfunc TestABAcceptanceFixture(t *testing.T) {}\nfunc TestMain(m *testing.M) { os.Exit(0) }\n');
  const result = await runOwnedContainer({ docker, name: `codex-ab-go-${crypto.randomUUID()}`, timeoutMs: 120_000,
    createArgs: ["--network", "none", "-v", `${repo}:/workspace`, image, "go", "test", "-json", "-count=1", "-run", "^TestABAcceptance", "."] });
  expect(result.exitCode).toBe(0);
  expect(acceptanceExecutionError(result.stdout, ["TestABAcceptanceFixture"])).toContain("did not execute");
}, 150_000);
