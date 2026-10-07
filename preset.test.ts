import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ensureLaunchImage, launchConfiguration } from "./launch";
import { main } from "./cli";

type ImageState = "matching" | "stale-codex" | "stale-host" | "wrong-operator" | "wrong-operator-missing-host" | "missing" | "inspect-error" | "identity-error" | "hash-error";

async function imageProbe(state: ImageState) {
  const root = await mkdtemp(join(tmpdir(), "codex-ab-preset-"));
  try {
    await Promise.all(["bin", "selected"].map(path => mkdir(join(root, path), { recursive: true })));
    const codex = "#!/bin/sh\necho selected-codex\n";
    const host = "#!/bin/sh\necho selected-host\n";
    await writeFile(join(root, "selected/codex"), codex, { mode: 0o755 });
    await writeFile(join(root, "selected/codex-code-mode-host"), host, { mode: 0o755 });
    await symlink(join(root, "selected/codex"), join(root, "bin/codex"));
    await writeFile(join(root, "bin/docker"), `#!/bin/sh
set -eu
PRESET_LOG="$0.log"
PRESET_STATE=${state}
PRESET_CODEX_HASH=${createHash("sha256").update(codex).digest("hex")}
PRESET_HOST_HASH=${createHash("sha256").update(host).digest("hex")}
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
        case "$PRESET_STATE" in hash-error|wrong-operator-missing-host) echo 'hash probe failed' >&2; exit 1 ;; esac
        codex_hash=$PRESET_CODEX_HASH
        host_hash=$PRESET_HOST_HASH
        [ "$PRESET_STATE" != stale-codex ] || codex_hash=stale
        [ "$PRESET_STATE" != stale-host ] || host_hash=stale
        printf '%s  %s\\n%s  %s\\n' "$codex_hash" /usr/local/bin/codex "$host_hash" /usr/local/bin/codex-code-mode-host ;;
      *)
        [ "$PRESET_STATE" != identity-error ] || { echo 'identity probe failed' >&2; exit 1; }
        case "$PRESET_STATE" in wrong-operator*) echo 0:0 ;; *) echo 1000:1000 ;; esac ;;
    esac ;;
  build) : ;;
  *) exit 99 ;;
esac
`, { mode: 0o755 });

    const codexHash = createHash("sha256").update(codex).digest("hex");
    const hostHash = createHash("sha256").update(host).digest("hex");
    let error = "";
    try {
      await ensureLaunchImage({ image: "fixture:latest", codexBinary: join(root, "bin/codex"), docker: join(root, "bin/docker") }, () => {});
    } catch (caught) { error = String(caught); }
    return { error, calls: await readFile(join(root, "bin/docker.log"), "utf8").catch(() => ""), codexHash, hostHash, root };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("agent launch preserves the former task, model, launcher, reasoning and compaction flags", () => {
  const skill = launchConfiguration({ preset: "stock-mekugi", task: "skills-mgr-agent-cli", model: "gpt-6.1-sol", "reasoning-effort": "low", "journal-compaction": "slice" });
  expect(skill.prepare.taskPackPath).toEndWith("tasks/skills-mgr-agent-cli/manifest.json");
  expect(skill.prepare.mekugiSource).toBeDefined();
  expect(skill.prepare.model).toBe("gpt-6.1-sol");
  expect(skill.prepare.reasoningEffort).toBe("low");
  expect(skill.prepare.timeoutSeconds).toBe(7200);
  expect(skill.prepare.mekugiFlags).toEqual(["--mode=mekugi", "--journal-compaction=slice"]);
  const same = launchConfiguration({ preset: "current-vs-current-mekugi" });
  expect(same.prepare.comparison).toBe("same-setup");
  const grok = launchConfiguration({ preset: "codex-mekugi-grok", "journal-compaction": "off" });
  expect(grok.prepare.model).toBe("grok:grok-4.7");
  expect(grok.prepare.reasoningEffort).toBe("high");
  expect(grok.prepare.mekugiFlags).toEqual(["--mode=mekugi", "--grok", "--journal-compaction=off"]);
  const session = launchConfiguration({ task: "session-retention" });
  expect(session.prepare.baseCommit).toBe("302ee2d6691b406f30fcbea38459c6ddc16f6935");
  expect(session.prepare.reasoningEffort).toBe("xhigh");
  expect(session.prepare.mekugiSource).toBeUndefined();
});

test("feature comparisons, repeat preparation, and custom task contracts use the retained owners", () => {
  const feature = launchConfiguration({ preset: "journal-compaction", "auto-compact-limit": "100000", count: "3", order: "alternating", "prepare-only": true });
  expect(feature.prepare.autoCompactLimit).toBe(100000);
  expect(feature.count).toBe(3);
  expect(feature.order).toBe("alternating");
  expect(feature.prepareOnly).toBe(true);
  const custom = launchConfiguration({ task: "custom", source: "/source path", base: "base", forbidden: "solution", "task-file": "/prompt.md", criteria: "/criteria.json" });
  expect(custom.prepare.source).toBe("/source path");
  expect(custom.prepare.taskPath).toBe("/prompt.md");
});

test("Booking Ledger uses its standalone seed, controls and documented runtime defaults", () => {
  const options = launchConfiguration({ task: "booking-ledger", "prepare-only": true });
  expect(options.prepare.source).toBe("");
  expect(options.prepare.comparison).toBe("stock-mekugi");
  expect(options.prepare.mekugiFlags).toEqual(["--mode=mekugi", "--journal-compaction=auto"]);
  expect(options.prepare.taskPath).toEndWith("tasks/booking-ledger/task.md");
  expect(options.prepare.criteriaPath).toEndWith("tasks/booking-ledger/criteria.json");
  expect(options.prepare.baseCommit).toBe("benchmark-base");
  expect(options.prepare.forbiddenCommit).toBe("benchmark-excluded");
  expect(options.prepare.reasoningEffort).toBe("xhigh");
  expect(options.prepare.timeoutSeconds).toBe(3300);
  const overridden = launchConfiguration({ task: "booking-ledger", source: "/existing-seed", preset: "stock-current", "reasoning-effort": "high", timeout: "1000" });
  expect(overridden.prepare.source).toBe("/existing-seed");
  expect(overridden.prepare.comparison).toBe("stock-current");
  expect(overridden.prepare.reasoningEffort).toBe("high");
  expect(overridden.prepare.timeoutSeconds).toBe(1000);
});

test("incompatible comparisons and malformed parameters reject before external work", () => {
  for (const [options, error] of [
    [{ preset: "same-setup", task: "session-retention" }, "require a task outside Mekugi"],
    [{ task: "native-tool-frontends" }, "supported task"],
    [{ "journal-compaction": "auto" }, "requires a Mekugi"],
    [{ "journal-compaction": "invalid", preset: "stock-mekugi" }, "auto, slice, or off"],
    [{ preset: "journal-compaction" }, "token limit"],
    [{ count: "0" }, "positive integer"],
    [{ task: "custom", source: "/tmp/source" }, "custom task needs"],
    [{ "mekugi-build": "/build", "mekugi-bin": "/bin" }, "owns its source"],
  ] as const) expect(() => launchConfiguration(options)).toThrow(error);
});

test("the agent CLI accepts equals syntax and requires explicit paid consent", async () => {
  expect(main(["launch", "--preset=stock-mekugi", "--journal-compaction=slice", "--model=gpt-6.1-sol", "--reasoning-effort=high"])).rejects.toThrow("confirm-paid-inference");
  expect(main(["launch", "--prepare-only", "--mentor-handoff"])).rejects.toThrow("unknown option");
  expect(main(["launch", "--prepare-only=true"])).rejects.toThrow("does not accept a value");
});

test("the human convenience launcher starts the workbench instead of a paid preset", async () => {
  const result = Bun.spawn(["bash", join(import.meta.dir, "scripts/run.sh"), "--preset", "stock-mekugi"], { stdout: "pipe", stderr: "pipe" });
  expect(await result.exited).toBe(1);
  expect(await new Response(result.stderr).text()).toContain("unknown option for serve");
});

test("image verification reuses matching binaries and rebuilds stale identity or binary pairs", async () => {
  const matching = await imageProbe("matching");
  expect(matching.error).toBe("");
  expect(matching.calls).toContain("sha256sum /usr/local/bin/codex /usr/local/bin/codex-code-mode-host");
  expect(matching.calls).not.toContain("\nbuild ");
  for (const state of ["stale-codex", "stale-host", "wrong-operator", "missing"] as const) {
    const result = await imageProbe(state);
    expect(result.error).toBe("");
    expect(result.calls).toContain("build --build-context codex_binary=" + result.root + "/selected");
    expect(result.calls).toContain("--build-arg CODEX_SHA256=" + result.codexHash);
    expect(result.calls).toContain("--build-arg CODEX_CODE_MODE_HOST_SHA256=" + result.hostHash);
    expect(result.calls).toContain("--build-arg BENCH_UID=1000 --build-arg BENCH_GID=1000");
  }
});

test("image probe failures stop without a build", async () => {
  for (const state of ["inspect-error", "identity-error", "hash-error"] as const) {
    const result = await imageProbe(state);
    expect(result.error).toContain("Cannot");
    expect(result.calls).not.toContain("\nbuild ");
  }
});

test("wrong operator identity rebuilds an image even when its companion binary is absent", async () => {
  const result = await imageProbe("wrong-operator-missing-host");
  expect(result.error).toBe("");
  expect(result.calls).toContain("build --build-context");
  expect(result.calls).not.toContain("sha256sum /usr/local/bin/codex");
});
