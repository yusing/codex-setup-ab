import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import source from "./candidate-script.txt" with { type: "text" };
import legacySource from "./fixtures/candidate-legacy-1c2ee9f.txt" with { type: "text" };
import { checked, exec } from "./process";
import { readCandidateManifest, verifyCandidateReconstruction } from "./candidate-evidence";

let roots: string[] = [];
afterEach(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); roots = []; });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "candidate-evidence-")); roots.push(root);
  const repo = join(root, "candidate"), seed = join(root, "seed.git"), capture = join(root, "capture");
  await mkdir(repo); await mkdir(capture);
  await checked(["git", "init", repo]);
  await checked(["git", "-C", repo, "config", "user.name", "Fixture"]);
  await checked(["git", "-C", repo, "config", "user.email", "fixture@example.invalid"]);
  await writeFile(join(repo, "tracked.txt"), "baseline\n");
  await writeFile(join(repo, "deleted.txt"), "delete this\n");
  await checked(["git", "-C", repo, "add", "."]); await checked(["git", "-C", repo, "commit", "-m", "base"]);
  const base = (await checked(["git", "-C", repo, "rev-parse", "HEAD"])).stdout.trim();
  const tree = (await checked(["git", "-C", repo, "rev-parse", "HEAD^{tree}"])).stdout.trim();
  await checked(["git", "clone", "--bare", repo, seed]);
  const spec = { mode: "capture", baseline: false, clean: false, base, tree, forbidden: "f".repeat(40), icons: false, submodules: [], workspace: repo, seed, destination: capture };
  const collect = () => exec([process.execPath, "-e", source, JSON.stringify(spec)]);
  return { root, repo, seed, capture, spec, collect };
}
test("actual collector ignores malicious Git config and reconstructs all supported entries", async () => {
  const f = await fixture();
  const retained = join(f.root, "retained-output"); await writeFile(retained, "original evidence");
  const hook = join(f.repo, ".git/hostile");
  await writeFile(hook, `#!/bin/sh\nprintf altered > '${retained}'\nprintf invoked > '${f.repo}/hook-ran'\n`); await chmod(hook, 0o755);
  await checked(["git", "-C", f.repo, "config", "core.fsmonitor", hook]);
  await checked(["git", "-C", f.repo, "config", "diff.external", hook]);
  await checked(["git", "-C", f.repo, "config", "filter.evil.clean", hook]);
  await writeFile(join(f.repo, ".gitattributes"), "* filter=evil diff=evil working-tree-encoding=UTF-16\n");
  await writeFile(join(f.repo, "tracked.txt"), "candidate actual content\n");
  await rm(join(f.repo, "deleted.txt"));
  await writeFile(join(f.repo, "binary.bin"), Buffer.from([0, 255, 1, 0, 13]));
  await writeFile(join(f.repo, "executable"), "#!/bin/sh\nexit 0\n"); await chmod(join(f.repo, "executable"), 0o755);
  await symlink("tracked.txt", join(f.repo, "link"));
  await writeFile(join(f.repo, "雪\tline\nbreak.txt"), "unusual\n");
  const result = await f.collect(); expect(result.exitCode, result.stderr).toBe(0);
  expect(await readFile(retained, "utf8")).toBe("original evidence");
  expect(await Bun.file(join(f.repo, "hook-ran")).exists()).toBe(false);
  const patch = join(f.capture, "changes.patch"), manifest = await readCandidateManifest(join(f.capture, "candidate-manifest.json"), patch);
  const evaluator = join(f.root, "evaluator"); await checked(["git", "clone", f.seed, evaluator]);
  await checked(["git", "-C", evaluator, "apply", "--index", "--binary", patch]);
  await verifyCandidateReconstruction(evaluator, manifest);
  expect(manifest.changed_files).toContain("deleted.txt");
  expect(await readFile(join(evaluator, "tracked.txt"), "utf8")).toBe("candidate actual content\n");
  await writeFile(join(evaluator, "tracked.txt"), "invented output never in candidate\n");
  await expect(verifyCandidateReconstruction(evaluator, manifest)).rejects.toThrow("contents differ");
  manifest.changed_files = [];
  await writeFile(join(evaluator, "tracked.txt"), "candidate actual content\n");
  await expect(verifyCandidateReconstruction(evaluator, manifest)).rejects.toThrow("change list");
}, 30_000);
test("collector rejects pre-existing output and unsupported metadata links", async () => {
  const f = await fixture(); await writeFile(join(f.capture, "prior"), "protected");
  expect((await f.collect()).stderr).toContain("new and empty");
  await rm(join(f.capture, "prior")); await writeFile(join(f.repo, ".git/objects/info/alternates"), "/untrusted\n");
  expect((await f.collect()).stderr).toContain("linkage");
});
test("capture excludes only declared regenerable untracked dependency directories", async () => {
  const f = await fixture(); Object.assign(f.spec, { discardDependencies: ["node_modules/"] });
  await mkdir(join(f.repo, "node_modules")); await writeFile(join(f.repo, "node_modules/cache"), "regenerable");
  await writeFile(join(f.repo, ".gitignore"), "hidden.txt\nnode_modules/\n"); await writeFile(join(f.repo, "hidden.txt"), "actual candidate bytes");
  const result = await f.collect(); expect(result.exitCode, result.stderr).toBe(0);
  const manifest = await readCandidateManifest(join(f.capture, "candidate-manifest.json"), join(f.capture, "changes.patch"));
  expect(manifest.changed_files).toContain("hidden.txt");
  expect(manifest.files.some(file => file.path.startsWith("node_modules/"))).toBe(false);
  expect(await Bun.file(join(f.repo, "node_modules/cache")).exists()).toBe(true);
});

test("candidate replacement refs cannot hide a present forbidden commit", async () => {
  const f = await fixture();
  await checked(["git", "-C", f.repo, "commit", "--allow-empty", "-m", "forbidden"]);
  f.spec.forbidden = (await checked(["git", "-C", f.repo, "rev-parse", "HEAD"])).stdout.trim();
  const blob = (await checked(["git", "-C", f.repo, "hash-object", "-w", "--stdin"], { stdin: "harmless replacement blob" })).stdout.trim();
  await checked(["git", "-C", f.repo, "update-ref", `refs/replace/${f.spec.forbidden}`, blob]);
  expect((await checked(["git", "-C", f.repo, "cat-file", "-t", f.spec.forbidden])).stdout.trim()).toBe("blob");
  const result = await f.collect();
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("forbidden solution is present");
});

test("capture preserves literal non-UTF8 symlink target bytes", async () => {
  const f = await fixture();
  const target = Buffer.from([0x74, 0x61, 0x72, 0x67, 0x65, 0x74, 0xff]);
  await symlink(target, join(f.repo, "link"));
  const result = await f.collect();
  expect(result.exitCode, result.stderr).toBe(0);
  const patch = join(f.capture, "changes.patch"), manifest = await readCandidateManifest(join(f.capture, "candidate-manifest.json"), patch);
  const evaluator = join(f.root, "evaluator"); await checked(["git", "clone", f.seed, evaluator]);
  await checked(["git", "-C", evaluator, "apply", "--index", "--binary", patch]);
  await verifyCandidateReconstruction(evaluator, manifest);
  expect(await readlink(join(evaluator, "link"), { encoding: "buffer" })).toEqual(target);
});

test("capture and reconstruction preserve pinned submodules and reject their mutation", async () => {
  const f = await fixture();
  const subSource = join(f.root, "sub-source"), sub = join(f.repo, "lib");
  await checked(["git", "init", subSource]);
  await checked(["git", "-C", subSource, "config", "user.name", "Fixture"]);
  await checked(["git", "-C", subSource, "config", "user.email", "fixture@example.invalid"]);
  await writeFile(join(subSource, "source.txt"), "pinned library\n");
  await checked(["git", "-C", subSource, "add", "."]); await checked(["git", "-C", subSource, "commit", "-m", "submodule"]);
  const sha = (await checked(["git", "-C", subSource, "rev-parse", "HEAD"])).stdout.trim();
  await checked(["git", "clone", subSource, sub]); await checked(["git", "-C", sub, "remote", "remove", "origin"]);
  await writeFile(join(f.repo, ".gitmodules"), `[submodule "lib"]\npath = lib\nurl = fixture.invalid/lib\n`);
  await checked(["git", "-C", f.repo, "add", "."]); await checked(["git", "-C", f.repo, "commit", "-m", "baseline with submodule"]);
  f.spec.base = (await checked(["git", "-C", f.repo, "rev-parse", "HEAD"])).stdout.trim();
  f.spec.tree = (await checked(["git", "-C", f.repo, "rev-parse", "HEAD^{tree}"])).stdout.trim();
  Object.assign(f.spec, { submodules: [{ path: "lib", sha }] });
  await rm(f.seed, { recursive: true }); await checked(["git", "clone", "--bare", f.repo, f.seed]);
  const result = await f.collect(); expect(result.exitCode, result.stderr).toBe(0);
  const patch = join(f.capture, "changes.patch"), manifest = await readCandidateManifest(join(f.capture, "candidate-manifest.json"), patch);
  const evaluator = join(f.root, "evaluator"); await checked(["git", "clone", f.seed, evaluator]);
  await checked(["git", "clone", subSource, join(evaluator, "lib")]);
  await verifyCandidateReconstruction(evaluator, manifest);
  expect(manifest.files.some(file => file.path === "lib/source.txt")).toBe(true);
  await writeFile(join(sub, "source.txt"), "mutated library\n");
  expect((await f.collect()).stderr).toContain("submodule lib contents changed");
});

test("staged source under a declared dependency directory remains in the trusted artifact", async () => {
  const f = await fixture(); Object.assign(f.spec, { discardDependencies: ["node_modules/"] });
  await mkdir(join(f.repo, "node_modules"));
  await writeFile(join(f.repo, ".gitignore"), "node_modules/\n");
  await writeFile(join(f.repo, "node_modules/source.js"), "export const actual = 1;\n");
  await checked(["git", "-C", f.repo, "add", "-f", "node_modules/source.js"]);
  const result = await f.collect(); expect(result.exitCode, result.stderr).toBe(0);
  const manifest = await readCandidateManifest(join(f.capture, "candidate-manifest.json"), join(f.capture, "changes.patch"));
  expect(manifest.excluded_directories).toEqual([]);
  expect(manifest.changed_files).toContain("node_modules/source.js");
});

test("pinned old collector reproduction substitutes evidence; trusted entrypoint preserves actual bytes", async () => {
  const f = await fixture();
  // Only relocate the production collector's two mount paths to a disposable fixture.
  // This is an entrypoint reproduction, not a claim that a Docker boundary ran here.
  // Snapshot is the complete collector from 1c2ee9f907f85d1b2d5c4593d382d40d6d539278,
  // retained so this reproduction also works in shallow CI clones.
  const baselineSource = legacySource.replaceAll("/workspace", f.repo).replaceAll("/capture", f.capture);
  const retained = join(f.root, "retained-output"); await writeFile(retained, "original evidence");
  const fsmonitor = join(f.repo, ".git/fixture-fsmonitor"), external = join(f.repo, ".git/fixture-diff");
  await writeFile(fsmonitor, `#!/bin/sh\nprintf altered > '${retained}'\n`); await chmod(fsmonitor, 0o755);
  await writeFile(external, "#!/bin/sh\ncat <<'PATCH'\ndiff --git a/tracked.txt b/tracked.txt\n--- a/tracked.txt\n+++ b/tracked.txt\n@@ -1 +1 @@\n-baseline\n+invented output never in candidate\nPATCH\n"); await chmod(external, 0o755);
  await checked(["git", "-C", f.repo, "config", "core.fsmonitor", fsmonitor]);
  await checked(["git", "-C", f.repo, "config", "diff.external", external]);
  await writeFile(join(f.repo, "tracked.txt"), "candidate actual content\n");
  const old = await exec([process.execPath, "-e", baselineSource, JSON.stringify(f.spec)]);
  expect(old.exitCode, old.stderr).toBe(0);
  expect(await readFile(retained, "utf8")).toBe("altered");
  const oldPatch = await readFile(join(f.capture, "changes.patch"), "utf8");
  expect(oldPatch).toContain("invented output never in candidate");
  const oldEvaluator = join(f.root, "old-evaluator"); await checked(["git", "clone", f.seed, oldEvaluator]);
  await checked(["git", "-C", oldEvaluator, "apply", "--index", "--binary", join(f.capture, "changes.patch")]);
  expect(await readFile(join(oldEvaluator, "tracked.txt"), "utf8")).toBe("invented output never in candidate\n");
  await writeFile(retained, "original evidence");
  const destination = join(f.root, "trusted-capture"); await mkdir(destination); f.spec.destination = destination;
  const fixed = await f.collect(); expect(fixed.exitCode, fixed.stderr).toBe(0);
  expect(await readFile(retained, "utf8")).toBe("original evidence");
  expect(await readFile(join(f.capture, "changes.patch"), "utf8")).toBe(oldPatch);
  const evaluator = join(f.root, "new-evaluator"); await checked(["git", "clone", f.seed, evaluator]);
  const patch = join(destination, "changes.patch"), manifest = await readCandidateManifest(join(destination, "candidate-manifest.json"), patch);
  await checked(["git", "-C", evaluator, "apply", "--index", "--binary", patch]); await verifyCandidateReconstruction(evaluator, manifest);
  expect(await readFile(join(evaluator, "tracked.txt"), "utf8")).toBe("candidate actual content\n");
});
