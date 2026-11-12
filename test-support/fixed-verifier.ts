import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { candidateFiles, type CandidateManifest } from "../candidate-evidence";
import { checked } from "../process";
import { fixedTreeIdentity, type ExecuteFixedVerifierOptions, type FixedVerifierConfig } from "../fixed-verifier";

const hash = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

export async function createFixedFixture(script = 'printf "1\\n" > /logs/verifier/reward.txt\n', value = 'correct'): Promise<ExecuteFixedVerifierOptions & { root: string }> {
  const root = await mkdtemp(join(tmpdir(), "codex-ab-fixed-verifier-"));
  const candidate = join(root, "candidate"), taskDirectory = join(root, "task");
  await mkdir(candidate); await mkdir(join(taskDirectory, "tests"), { recursive: true });
  const git = (args: string[]) => checked(["git", "-C", candidate, ...args]);
  await git(["init", "--initial-branch=work"]);
  await git(["config", "user.name", "Fixture"]); await git(["config", "user.email", "fixture@example.invalid"]);
  await writeFile(join(candidate, "result.txt"), "baseline\n");
  await git(["add", "."]); await git(["commit", "-m", "baseline"]);
  const baseline = (await git(["rev-parse", "HEAD"])).stdout.trim(), baseTree = (await git(["rev-parse", "HEAD^{tree}"])).stdout.trim();
  await writeFile(join(candidate, "result.txt"), `${value}\n`); await git(["add", "."]);
  const patch = (await git(["diff", "--cached", "--binary", "--full-index", baseline])).stdout;
  const patchPath = join(root, "changes.patch"); await writeFile(patchPath, patch);
  const manifest: CandidateManifest = { schema: "codex-ab.candidate-manifest.v1", base_commit: baseline, base_tree: baseTree,
    captured_tree: (await git(["write-tree"])).stdout.trim(), excluded_directories: [], files: await candidateFiles(candidate),
    changed_files: ["result.txt"], patch_sha256: hash(patch) };
  const candidateManifestPath = join(root, "candidate-manifest.json");
  await writeFile(candidateManifestPath, JSON.stringify(manifest));
  await writeFile(join(taskDirectory, "instruction.md"), "Model-free local fixture; not an FHE task.\n");
  await writeFile(join(taskDirectory, "tests/test.sh"), script, { mode: 0o755 });
  const config: FixedVerifierConfig = { schema: "codex-ab.fixed-verifier.v1",
    dataset: { name: "local-fixture", version: "1", revision: `sha256:${hash("fixture")}` },
    task: { id: "fixture", tree_sha256: (await fixedTreeIdentity(taskDirectory)).sha256 },
    verifier: { path: "tests", tree_sha256: (await fixedTreeIdentity(join(taskDirectory, "tests"))).sha256, command: ["/bin/bash", "/tests/test.sh"] },
    image: `sha256:${"b".repeat(64)}`, candidate_mount: "/app", workdir: "/app", user: "0:0", timeout_seconds: 20,
    resources: { cpus: "1", memory: "512m", pids_limit: 128 }, network: "none", reward_key: "reward" };
  return { root, config, taskDirectory, candidate, candidateManifestPath, patchPath,
    output: join(root, "output"), docker: "docker", name: `fixed-fixture-${crypto.randomUUID()}` };
}
