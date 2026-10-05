import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

type ImageState = "matching" | "stale-codex" | "stale-host" | "wrong-operator" | "missing" | "inspect-error" | "identity-error" | "hash-error";

async function runPreset(state: ImageState, options: string[] = [], preset = "stock-current") {
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
    await writeFile(join(root, "bin/git"), `#!/bin/sh
printf 'git %s\\n' "$*" >> "$PRESET_LOG"
case "$*" in
  "-C $PRESET_ROOT/source rev-parse --git-dir"|"-C $PRESET_ROOT/skills source rev-parse --git-dir") echo .git ;;
  *) exit 99 ;;
esac
`, { mode: 0o755 });
    await writeFile(join(root, "dist/codex-ab"), '#!/bin/sh\nprintf "cli %s\\n" "$*" >> "$PRESET_LOG"\nprintf "%s/run\\n" "$PRESET_ROOT"\n', { mode: 0o755 });
    const codexHash = createHash("sha256").update(codex).digest("hex");
    const hostHash = createHash("sha256").update(host).digest("hex");
    const child = Bun.spawn(["bash", join(root, "scripts/run.sh"), "--preset", preset, ...options], {
      env: {
        ...process.env,
        PATH: `${join(root, "bin")}:${process.env.PATH}`,
        PRESET_ROOT: root,
        PRESET_LOG: join(root, "calls.log"),
        PRESET_STATE: state,
        PRESET_CODEX_HASH: codexHash,
        PRESET_HOST_HASH: hostHash,
        CODEX_AB_SOURCE_DIR: join(root, "source"),
        CODEX_AB_MEKUGI_SOURCE: join(root, "source"),
        CODEX_AB_SKILLS_MGR_SOURCE: join(root, "skills source"),
        CODEX_AB_IMAGE: "fixture:latest",
        CODEX_AB_DOCKER_BIN: join(root, "bin/docker"),
        CODEX_AB_CODEX_BIN: join(root, "bin/codex"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr, stdout] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
    return { exitCode, stderr, stdout, calls: await readFile(join(root, "calls.log"), "utf8").catch(() => ""), codexHash, hostHash, root };
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
  expect(result.calls).not.toContain("cli preflight ");
  expect(result.calls.match(/cli run /g)).toHaveLength(1);
  expect(result.stdout).toBe(`${result.root}/run\n`);
  expect(result.stderr).not.toContain("Prepared run:");
});

test("preset forwards explicit model and reasoning effort to prepare", async () => {
  const result = await runPreset("matching", ["--model", "gpt-6.1-sol", "--reasoning-effort=low"]);
  expect(result.exitCode).toBe(0);
  expect(result.calls).toContain("cli prepare --comparison stock-current");
  expect(result.calls).toContain("--model gpt-6.1-sol");
  expect(result.calls).toContain("--reasoning-effort low");
});

test("long-horizon preset uses the pinned skills manager pack separately from Mekugi runtime", async () => {
  const result = await runPreset("matching", ["--task", "skills-mgr-agent-cli", "--journal-compaction=auto"], "stock-mekugi");
  expect(result.exitCode).toBe(0);
  expect(result.calls).toContain(`git -C ${result.root}/skills source rev-parse --git-dir`);
  expect(result.calls).not.toContain("git clone");
  expect(result.calls).toContain("--task-pack ./tasks/skills-mgr-agent-cli/manifest.json");
  expect(result.calls).toContain(`--source ${result.root}/skills source`);
  expect(result.calls).toContain(`--mekugi-source ${result.root}/source`);
  expect(result.calls).toContain("--reasoning-effort xhigh --timeout 7200");
  expect(result.calls).toContain('--mekugi-flags ["--mode=mekugi","--journal-compaction=auto"]');
  expect(result.calls.match(/cli run /g)).toHaveLength(1);
});

test("long-horizon task retains reasoning overrides and Grok defaults", async () => {
  const overridden = await runPreset("matching", ["--task=skills-mgr-agent-cli", "--reasoning-effort=low"]);
  expect(overridden.exitCode).toBe(0);
  expect(overridden.calls).toContain("--reasoning-effort low --timeout 7200");
  const grok = await runPreset("matching", ["--task=skills-mgr-agent-cli"], "codex-mekugi-grok");
  expect(grok.exitCode).toBe(0);
  expect(grok.calls).toContain("--reasoning-effort high --timeout 7200");
});

for (const preset of ["stock-mekugi", "current-vs-current-mekugi", "codex-mekugi-grok"]) {
  test(`${preset} rejects a Mekugi task before any external operation`, async () => {
    const result = await runPreset("matching", ["--task=session-retention"], preset);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("require a task outside Mekugi");
    expect(result.calls).toBe("");
  });
}

test("session retention remains available for the direct Codex comparison", async () => {
  const result = await runPreset("matching", ["--task=session-retention"]);
  expect(result.exitCode).toBe(0);
  expect(result.calls).toContain("--comparison stock-current");
  expect(result.calls).toContain("--task ./tasks/session-retention/task.md");
  expect(result.calls).not.toContain("--mekugi-source");
});

test("the superseded Mekugi long-horizon task is unavailable", async () => {
  const result = await runPreset("matching", ["--task=native-tool-frontends"], "stock-mekugi");
  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("unknown task");
  expect(result.calls).toBe("");
});

for (const preset of ["stock-mekugi", "current-vs-current-mekugi", "codex-mekugi-grok"]) {
  test(`${preset} launches without removed Mekugi flags`, async () => {
    const result = await runPreset("matching", [], preset);
    expect(result.exitCode).toBe(0);
    expect(result.calls.match(/cli prepare /g)).toHaveLength(1);
    expect(result.calls.match(/cli run /g)).toHaveLength(1);
    expect(result.calls).not.toContain("--mentor-handoff");
    expect(result.calls).not.toContain("--main-mentor-handoff");
    expect(result.calls).not.toContain("--explore-filter");
    expect(result.calls).not.toContain("--journal-compaction");
    if (preset === "codex-mekugi-grok") {
      expect(result.calls).toContain('--mekugi-flags ["--mode=mekugi","--grok"]');
    }
  });
}

test("Grok preset uses high reasoning unless explicitly overridden", async () => {
  const defaultRun = await runPreset("matching", [], "codex-mekugi-grok");
  expect(defaultRun.calls).toContain("--reasoning-effort high");
  const override = await runPreset("matching", ["--reasoning-effort", "medium"], "codex-mekugi-grok");
  expect(override.calls).toContain("--reasoning-effort medium");
});

for (const [preset, mode, options] of [
  ["stock-mekugi", "auto", ["--journal-compaction", "auto"]],
  ["current-vs-current-mekugi", "slice", ["--journal-compaction=slice"]],
  ["codex-mekugi-grok", "off", ["--journal-compaction=off"]],
] as const) {
  test(`${preset} forwards journal compaction ${mode} as one Mekugi flag array`, async () => {
    const result = await runPreset("matching", [...options], preset);
    expect(result.exitCode).toBe(0);
    const flags = ["--mode=mekugi", ...(preset === "codex-mekugi-grok" ? ["--grok"] : []), `--journal-compaction=${mode}`];
    expect(result.calls).toContain(`--mekugi-flags ${JSON.stringify(flags)}`);
    expect(result.calls.match(/--mekugi-flags /g)).toHaveLength(1);
    expect(result.calls.match(/cli run /g)).toHaveLength(1);
  });
}

for (const [options, message] of [
  [["--journal-compaction"], "requires a value"],
  [["--journal-compaction="], "requires a nonempty value"],
  [["--journal-compaction", ""], "requires a nonempty value"],
  [["--journal-compaction=invalid"], "must be auto, slice, or off"],
  [["--journal-compaction=auto", "--journal-compaction", "off"], "may be supplied only once"],
  [["--journal-compaction", "off", "--journal-compaction=auto"], "may be supplied only once"],
] as const) {
  test(`preset rejects invalid compaction options ${JSON.stringify(options)} before launch`, async () => {
    const result = await runPreset("matching", [...options], "stock-mekugi");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(message);
    expect(result.calls).toBe("");
  });
}

test("direct Codex preset rejects Mekugi compaction before launch", async () => {
  const result = await runPreset("matching", ["--journal-compaction=auto"]);
  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("requires a Mekugi comparison");
  expect(result.calls).toBe("");
});

for (const preset of ["stock-current", "stock-mekugi", "current-vs-current-mekugi", "codex-mekugi-grok"]) {
  test(`${preset} rejects the removed mentor flag before launching`, async () => {
    const result = await runPreset("matching", ["--mentor-handoff"], preset);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("unknown argument: --mentor-handoff");
    expect(result.calls).toBe("");
  });
}

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
