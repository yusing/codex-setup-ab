import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

type ImageState = "matching" | "stale-codex" | "stale-host" | "wrong-operator" | "missing" | "inspect-error" | "identity-error" | "hash-error";

async function runPreset(state: ImageState, options: string[] = []) {
  const root = await mkdtemp(join(tmpdir(), "codex-ab-preset-"));
  try {
    await Promise.all(["scripts", "dist", "bin", "selected", "source/.git"].map(path => mkdir(join(root, path), { recursive: true })));
    await cp(join(import.meta.dir, "scripts/run.sh"), join(root, "scripts/run.sh"));
    const codex = "#!/bin/sh\necho selected-codex\n";
    const host = "#!/bin/sh\necho selected-host\n";
    await writeFile(join(root, "selected/codex"), codex, { mode: 0o755 });
    await writeFile(join(root, "selected/codex-code-mode-host"), host, { mode: 0o755 });
    await symlink(join(root, "selected/codex"), join(root, "bin/codex"));
    await writeFile(join(root, "bin/docker"), `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$PRESET_LOG"
case "$1" in
  image)
    case "$PRESET_STATE" in
      missing) echo 'No such image' >&2; exit 1 ;;
      inspect-error) echo 'daemon unavailable' >&2; exit 1 ;;
    esac
    echo sha256:fixture ;;
  run)
    case " $* " in
      *' sha256sum '*)
        [ "$PRESET_STATE" != hash-error ] || { echo 'hash probe failed' >&2; exit 1; }
        codex_hash=$PRESET_CODEX_HASH
        host_hash=$PRESET_HOST_HASH
        [ "$PRESET_STATE" != stale-codex ] || codex_hash=stale
        [ "$PRESET_STATE" != stale-host ] || host_hash=stale
        printf '%s  %s\\n%s  %s\\n' "$codex_hash" /usr/local/bin/codex "$host_hash" /usr/local/bin/codex-code-mode-host ;;
      *)
        [ "$PRESET_STATE" != identity-error ] || { echo 'identity probe failed' >&2; exit 1; }
        if [ "$PRESET_STATE" = wrong-operator ]; then echo 0:0; else echo 1000:1000; fi ;;
    esac ;;
  build) : ;;
  *) exit 99 ;;
esac
`, { mode: 0o755 });
    await writeFile(join(root, "bin/bun"), '#!/bin/sh\nprintf "bun %s\\n" "$*" >> "$PRESET_LOG"\n', { mode: 0o755 });
    await writeFile(join(root, "dist/codex-ab"), '#!/bin/sh\nprintf "cli %s\\n" "$*" >> "$PRESET_LOG"\n[ "$1" != prepare ] || printf "%s/run\\n" "$PRESET_ROOT"\n', { mode: 0o755 });
    const codexHash = createHash("sha256").update(codex).digest("hex");
    const hostHash = createHash("sha256").update(host).digest("hex");
    const child = Bun.spawn(["bash", join(root, "scripts/run.sh"), "--preset", "stock-current", ...options], {
      env: {
        ...process.env,
        PATH: `${join(root, "bin")}:${process.env.PATH}`,
        PRESET_ROOT: root,
        PRESET_LOG: join(root, "calls.log"),
        PRESET_STATE: state,
        PRESET_CODEX_HASH: codexHash,
        PRESET_HOST_HASH: hostHash,
        CODEX_AB_SOURCE_DIR: join(root, "source"),
        CODEX_AB_IMAGE: "fixture:latest",
        CODEX_AB_DOCKER_BIN: join(root, "bin/docker"),
        CODEX_AB_CODEX_BIN: join(root, "bin/codex"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
    return { exitCode, stderr, calls: await readFile(join(root, "calls.log"), "utf8"), codexHash, hostHash, root };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("preset reuses an image only when operator and both selected binary hashes match", async () => {
  const result = await runPreset("matching");
  expect(result.exitCode).toBe(0);
  expect(result.calls).toContain("sha256sum /usr/local/bin/codex /usr/local/bin/codex-code-mode-host");
  expect(result.calls).not.toContain("\nbuild ");
  expect(result.calls).toContain(`--codex-bin ${result.root}/selected/codex`);
  expect(result.calls).not.toContain("--model ");
  expect(result.calls).toContain("--reasoning-effort medium");
  expect(result.calls).toContain("cli preflight ");
  expect(result.calls).toContain("cli run ");
});

test("preset forwards explicit model and reasoning effort to prepare", async () => {
  const result = await runPreset("matching", ["--model", "gpt-6-sol", "--reasoning-effort=high"]);
  expect(result.exitCode).toBe(0);
  expect(result.calls).toContain("cli prepare --comparison stock-current");
  expect(result.calls).toContain("--model gpt-6-sol");
  expect(result.calls).toContain("--reasoning-effort high");
});

for (const state of ["stale-codex", "stale-host", "wrong-operator", "missing"] as const) {
  test(`preset rebuilds ${state} image with the selected host binary pair`, async () => {
    const result = await runPreset(state);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Building image fixture:latest");
    expect(result.calls).toContain(`build --build-context codex_binary=${result.root}/selected`);
    expect(result.calls).toContain(`--build-arg CODEX_SHA256=${result.codexHash}`);
    expect(result.calls).toContain(`--build-arg CODEX_CODE_MODE_HOST_SHA256=${result.hostHash}`);
    expect(result.calls).toContain("--build-arg BENCH_UID=1000 --build-arg BENCH_GID=1000");
    expect(result.calls.indexOf("\nbuild ")).toBeLessThan(result.calls.indexOf("\ncli prepare "));
  });
}

for (const [state, message] of [
  ["inspect-error", "Cannot inspect Docker image"],
  ["identity-error", "cannot verify operator identity"],
  ["hash-error", "cannot verify Codex binaries"],
] as const) {
  test(`preset stops on ${state} instead of building or running`, async () => {
    const result = await runPreset(state);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(result.calls).not.toContain("\nbuild ");
    expect(result.calls).not.toContain("cli ");
  });
}
