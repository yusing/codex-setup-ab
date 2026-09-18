import { cp, copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { exec, checked } from "./process";
import type { RunState } from "./types";

// Outside HOME and /workspace: private bind mounts must not hide image caches.
export const DEPENDENCY_ENV = [
  "GOCACHE=/opt/codex-ab-deps/go-build",
  "GOMODCACHE=/go/pkg/mod",
  "BUN_INSTALL_CACHE_DIR=/opt/codex-ab-deps/bun",
];

export function dependencyKey(state: RunState, baseImage: string): string {
  return createHash("sha256").update(JSON.stringify({
    version: 1, baseImage, tree: state.source.base_tree, commit: state.source.base_commit,
    submodules: state.submodules?.map(({ path, sha }) => ({ path, sha })),
    preparation: state.criteria?.contract.preparation, bun: state.runtime_tools.bun_sha256,
    uid: state.operator.uid, gid: state.operator.gid,
  })).digest("hex");
}

export async function ensureDependencyImage(docker: string, runDir: string, state: RunState, signal: AbortSignal): Promise<void> {
  if (!state.criteria || !state.image_id) throw new Error("dependency image requires verified base image and preparation contract");
  const base = state.dependency_image?.base_image ?? state.image_id;
  if (base !== state.image_id) throw new Error("dependency base image changed");
  const key = dependencyKey(state, base);
  if (state.dependency_image && state.dependency_image.key !== key) throw new Error("dependency image inputs changed");
  const tag = `codex-ab-deps:${key}`;
  const buildBase = `codex-ab-base:${base.replace("sha256:", "")}`;
  const recipe = [
    `FROM ${buildBase} AS dependencies`, "USER root",
    "RUN mkdir -p /opt/codex-ab-deps/go-build /opt/codex-ab-deps/bun /go/pkg/mod",
    `RUN chown -R ${state.operator.uid}:${state.operator.gid} /opt/codex-ab-deps /go/pkg/mod`,
    `COPY --chown=${state.operator.uid}:${state.operator.gid} baseline /workspace`,
    "COPY --chmod=755 bun /usr/local/bin/bun", "COPY prepare.sh /prepare.sh",
    `USER ${state.operator.uid}:${state.operator.gid}`, "WORKDIR /workspace",
    `ENV ${DEPENDENCY_ENV.join(" ")}`, "RUN sh /prepare.sh",
    `FROM ${buildBase}`, "COPY --from=dependencies /opt/codex-ab-deps /opt/codex-ab-deps",
    "COPY --from=dependencies /go/pkg/mod /go/pkg/mod", `ENV ${DEPENDENCY_ENV.join(" ")}`, "",
  ].join("\n");

  await writeFile(join(runDir, "artifacts/dependencies.Dockerfile"), recipe);
  await writeFile(join(runDir, "artifacts/dependencies.prepare.sh"), `set -eu\n${state.criteria.contract.preparation}\ngit diff --exit-code HEAD --\n`);
  const reference = state.dependency_image?.image_id ?? tag;
  const inspect = () => exec([docker, "image", "inspect", "--format", "{{.Id}}", reference], { signal });
  let image = await inspect();
  if (image.exitCode !== 0) {
    if (state.dependency_image || !/no such (image|object)/i.test(image.stderr)) {
      throw new Error(`cannot inspect dependency image ${reference}: ${image.stderr.trim()}`);
    }
    process.stderr.write(`[run] building shared dependency image ${tag}; build logs: ${join(runDir, "artifacts/dependencies.stderr")}\n`);
    await checked([docker, "tag", base, buildBase], { signal });
    const context = await mkdtemp(join(tmpdir(), "codex-ab-deps-"));
    try {
      await cp(resolve(runDir, state.arms.stock.repository), join(context, "baseline"), { recursive: true, verbatimSymlinks: true });
      await cp(resolve(runDir, state.runtime_tools.bun), join(context, "bun"));
      await copyFile(join(runDir, "artifacts/dependencies.prepare.sh"), join(context, "prepare.sh"));
      await copyFile(join(runDir, "artifacts/dependencies.Dockerfile"), join(context, "Dockerfile"));
      const built = await exec([docker, "build", "--tag", tag, context], {
        signal, timeoutMs: 20 * 60 * 1000,
        stdoutFile: join(runDir, "artifacts/dependencies.stdout"), stderrFile: join(runDir, "artifacts/dependencies.stderr"),
      });
      if (built.exitCode !== 0 || built.canceled || built.timedOut) throw new Error("dependency image build failed; see artifacts/dependencies.stderr");
    } finally {
      await rm(context, { recursive: true, force: true });
    }
    image = await inspect();
  }
  const id = image.stdout.trim();
  if (image.exitCode !== 0 || !/^sha256:[0-9a-f]{64}$/.test(id) || signal.aborted) throw new Error("dependency image was not resolved safely");
  if (state.dependency_image && state.dependency_image.image_id !== id) throw new Error("dependency image changed");
  state.dependency_image = { key, base_image: base, image_id: id };
  process.stderr.write(`[run] using shared dependency image ${id}\n`);
}

export function dependencyImage(state: RunState): string {
  return state.dependency_image?.image_id ?? state.image_id ?? state.image;
}

/** Record only ignored, generated dependency directories before agent execution. */
export async function generatedDependencyDirectories(repository: string): Promise<string[]> {
  const result = await checked(["git", "-C", repository, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]);
  return result.stdout.split("\0").filter(path => path === "node_modules/" || path.endsWith("/node_modules/"));
}
