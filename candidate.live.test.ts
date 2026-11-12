import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import source from "./candidate-script.txt" with { type: "text" };
import { runOwnedContainer } from "./container";
import { checked } from "./process";
import { readCandidateManifest, verifyCandidateReconstruction } from "./candidate-evidence";

const liveTest = process.env.CODEX_AB_LIVE_DOCKER === "1" ? test : test.skip;
const docker = process.env.CODEX_AB_DOCKER_BIN ?? "docker";
const image = process.env.CODEX_AB_LIVE_IMAGE ?? "codex-ab:0.1.0";
let root: string;
let repo: string;
let capture: string;
let base: string;
let tree: string;
let seed: string;

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
  seed = join(root, "seed.git");
  await checked(["git", "clone", "--bare", repo, seed]);
});
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

async function inspect(mode: "verify" | "capture", baseline = false, discardDependencies: string[] = []): Promise<Awaited<ReturnType<typeof runOwnedContainer>>> {
  return runOwnedContainer({ docker, name: `codex-ab-candidate-${crypto.randomUUID()}`, timeoutMs: 30_000,
    createArgs: ["--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "-e", "GIT_OPTIONAL_LOCKS=0", "-v", `${repo}:/workspace:ro`, "-v", `${seed}:/seed.git:ro`, "-v", `${capture}:/capture`,
      image, "bun", "-e", source,
      JSON.stringify({ mode, baseline, discardDependencies, clean: baseline, base, tree, forbidden: "f".repeat(40), icons: false, submodules: [] })] });
}

liveTest("live capture preserves exact candidate files without executing hooks or external diff anywhere", async () => {
  await writeFile(join(repo, "fixture.go"), "package fixture\n// candidate actual content\n");
  await writeFile(join(repo, "binary.bin"), Buffer.from([0, 255, 13, 0]));
  await writeFile(join(repo, "executable"), "#!/bin/sh\nexit 0\n"); await chmod(join(repo, "executable"), 0o755);
  await symlink("fixture.go", join(repo, "link"));
  await writeFile(join(repo, "committed.txt"), "committed change\n");
  await checked(["git", "-C", repo, "add", "."]);
  await checked(["git", "-C", repo, "commit", "-m", "candidate"]);
  const unusual = "雪\tline\nbreak.txt";
  await writeFile(join(repo, unusual), "untracked change\n");
  await writeFile(join(repo, ".gitignore"), "node_modules/\n");
  await mkdir(join(repo, "plugins/node_modules"), { recursive: true });
  await writeFile(join(repo, "plugins/node_modules/package"), "regenerable");
  const victim = join(root, "host-victim");
  await writeFile(victim, "untouched");
  const hook = join(repo, ".git/fsmonitor");
  await writeFile(hook, `#!/bin/sh\nprintf compromised >'${victim}' 2>/dev/null || true\nprintf invoked >/workspace/hook-ran\nprintf corrupted >/capture/../codex.jsonl\nprintf 'invented output never in candidate'\n`);
  await chmod(hook, 0o755);
  await checked(["git", "-C", repo, "config", "core.fsmonitor", ".git/fsmonitor"]);
  await checked(["git", "-C", repo, "config", "diff.external", ".git/fsmonitor"]);
  const result = await inspect("capture", false, ["plugins/node_modules/"]);
  expect(result.stderr).not.toContain("SyntaxError");
  expect(result.exitCode).toBe(0);
  expect(await readFile(victim, "utf8")).toBe("untouched");
  expect(await Bun.file(join(repo, "plugins/node_modules/package")).exists()).toBe(true);
  expect(await Bun.file(join(repo, "hook-ran")).exists()).toBe(false);
  const manifest = await readCandidateManifest(join(capture, "candidate-manifest.json"), join(capture, "changes.patch"));
  expect(manifest.changed_files).toContain(unusual);
  expect(manifest.changed_files).toContain("committed.txt");
  expect(manifest.excluded_directories).toEqual(["plugins/node_modules/"]);
  const evaluator = join(root, "evaluator");
  await checked(["git", "clone", seed, evaluator]);
  const patch = join(capture, "changes.patch");
  await checked(["git", "-C", evaluator, "apply", "--index", "--binary", patch]);
  await verifyCandidateReconstruction(evaluator, await readCandidateManifest(join(capture, "candidate-manifest.json"), patch));
  expect(await readFile(join(evaluator, unusual), "utf8")).toBe("untracked change\n");
  expect(await readFile(join(evaluator, "fixture.go"), "utf8")).toBe("package fixture\n// candidate actual content\n");
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


liveTest("live dependency exclusions preserve tracked packages and redirected directories", async () => {
  await writeFile(join(repo, ".gitignore"), "node_modules/\n");
  await mkdir(join(repo, "tracked/node_modules"), { recursive: true });
  await writeFile(join(repo, "tracked/node_modules/source"), "keep");
  await checked(["git", "-C", repo, "add", "-f", "tracked/node_modules/source"]);
  await mkdir(join(repo, "redirected"));
  await mkdir(join(repo, "outside/node_modules"), { recursive: true });
  await writeFile(join(repo, "outside/node_modules/package"), "keep");
  await symlink("../outside/node_modules", join(repo, "redirected/node_modules"));
  const result = await inspect("capture", false, ["tracked/node_modules/", "redirected/node_modules/", "../../node_modules/"]);
  expect(result.exitCode, result.stderr).toBe(0);
  const manifest = await readCandidateManifest(join(capture, "candidate-manifest.json"), join(capture, "changes.patch"));
  expect(manifest.files.some(file => file.path === "tracked/node_modules/source")).toBe(true);
  expect(await Bun.file(join(repo, "tracked/node_modules/source")).text()).toBe("keep");
  expect(await Bun.file(join(repo, "outside/node_modules/package")).text()).toBe("keep");
}, 30_000);
