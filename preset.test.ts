import { expect, test } from "bun:test";

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensureLaunchImage, launchConfiguration, taskCatalog } from "./launch";
import { main } from "./cli";

test("launch maps historical arms to slots while leaving fresh candidates", () => {
  const imports = [{ target_arm: "stock", run_dir: "/previous run", arm: "current" }];
  expect(launchConfiguration({ "import-arms": JSON.stringify(imports) }).importArms).toEqual(imports);
  for (const invalid of [[], [imports[0], imports[0]], [{ ...imports[0], target_arm: "arm-3" }],
    [{ ...imports[0], bundle_sha256: "bad" }], [{ target_arm: "stock" }]]) {
    expect(() => launchConfiguration({ "import-arms": JSON.stringify(invalid) })).toThrow();
  }
  expect(() => launchConfiguration({ "import-arms": JSON.stringify(imports), count: "2" })).toThrow("count 1");
  expect(() => launchConfiguration({ "import-arms": JSON.stringify([...imports, { ...imports[0], target_arm: "current" }]) })).toThrow("fresh arm");
});

test("custom launch composes ordered launcher revisions and rejects incomplete inputs", () => {
  const arms = [{ launcher: "codex", setup_commit: "stock" }, { launcher: "mekugi", setup_commit: "HEAD~1" }, { launcher: "mekugi", setup_commit: "HEAD" }];
  const configuration = launchConfiguration({ preset: "custom", arms: JSON.stringify(arms) });
  expect(configuration.prepare.arms).toEqual(arms.map(arm => ({ ...arm, launcher: arm.launcher === "stock" ? "codex" : arm.launcher })));
  expect(configuration.prepare.currentLauncher).toBe("mekugi");
  const worktree = launchConfiguration({ preset: "custom", arms: JSON.stringify([{ launcher: "codex", setup_commit: "stock" }, { launcher: "mekugi", setup_commit: "worktree" }]), "current-home": "/config", "runtime-home": "/runtime" });
  expect(worktree.prepare).toMatchObject({ currentHome: "/config", runtimeHome: "/runtime" });
  expect(worktree.prepare.arms?.[1]?.setup_commit).toBe("worktree");
  expect(() => launchConfiguration({ preset: "custom", arms: "[]" })).toThrow("at least two");
  expect(() => launchConfiguration({ preset: "custom", arms: JSON.stringify(arms), "review-treatment": "/overlay" })).toThrow();
  expect(() => launchConfiguration({ preset: "stock-current", arms: JSON.stringify(arms) })).toThrow("requires");
});

type ImageState = "ready" | "missing-bun" | "old-git" | "missing-git-https" | "daemon-error"
  | "missing-companion" | "wrong-operator" | "missing" | "inspect-error" | "identity-error";

const fixtureImageId = `sha256:${"a".repeat(64)}`;
const rebuiltImageId = `sha256:${"b".repeat(64)}`;
const codexHash = "c".repeat(64);
const companionHash = "d".repeat(64);

async function imageProbe(state: ImageState, tag = "fixture:latest") {
  const root = await mkdtemp(join(tmpdir(), "codex-ab-preset-"));
  try {
    const docker = join(root, "docker");
    await writeFile(docker, `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$0.log"
case "$1" in
  image)
    if [ -f "$0.built" ]; then echo '${rebuiltImageId}'; exit 0; fi
    case '${state}' in
      missing) echo 'No such image' >&2; exit 1 ;;
      inspect-error) echo 'daemon unavailable' >&2; exit 1 ;;
    esac
    echo '${fixtureImageId}' ;;
  run)
    if [ ! -f "$0.built" ]; then
      case '${state}' in
        wrong-operator) echo 0:0; exit 9 ;;
        missing-bun) exit 10 ;; old-git) exit 11 ;; missing-git-https) exit 12 ;;
        missing-companion) exit 13 ;; identity-error) exit 1 ;;
        daemon-error) echo 'daemon unavailable' >&2; exit 125 ;;
      esac
    fi
    printf '%s\\n' 'codex-cli 0.171.0' '${codexHash}  /usr/local/bin/codex' \
      '${companionHash}  /usr/local/bin/codex-code-mode-host' '12345' ;;
  build) touch "$0.built" ;;
  *) exit 99 ;;
esac
`, { mode: 0o755 });
    let image: Awaited<ReturnType<typeof ensureLaunchImage>> | undefined;
    let error = "";
    try {
      image = await ensureLaunchImage({ image: tag, docker }, () => {});
    } catch (caught) { error = String(caught); }
    return { image, error, calls: await readFile(`${docker}.log`, "utf8") };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("Terra launch preserves model and reasoning selection", () => {
  for (const effort of ["none", "high", "max"]) {
    const config = launchConfiguration({ preset: "stock-mekugi", model: "gpt-6.1-terra", "reasoning-effort": effort });
    expect(config.prepare.model).toBe("gpt-6.1-terra");
    expect(config.prepare.reasoningEffort).toBe(effort);
  }
});

test("agent launch selects current task, model, launcher, reasoning and Mekugi flags", () => {
  const skill = launchConfiguration({ preset: "stock-mekugi", task: "skills-mgr-agent-cli", model: "gpt-6.1-sol", "reasoning-effort": "low", "mekugi-flags": '["--deduplicate-output=false"]' });
  expect(skill.prepare.taskPackPath).toEndWith("tasks/skills-mgr-agent-cli/manifest.json");
  expect(skill.prepare.mekugiSource).toBe(
    process.env.CODEX_AB_MEKUGI_SOURCE ?? join(homedir(), "projects/mekugi"),
  );
  expect(skill.prepare.model).toBe("gpt-6.1-sol");
  expect(skill.prepare.reasoningEffort).toBe("low");
  expect(skill.prepare.timeoutSeconds).toBe(7200);
  expect(skill.prepare.mekugiFlags).toEqual(["--deduplicate-output=false"]);
  const same = launchConfiguration({ preset: "current-vs-current-mekugi" });
  expect(same.prepare.comparison).toBe("same-setup");
  const grok = launchConfiguration({ preset: "codex-mekugi-grok" });
  expect(grok.prepare.model).toBe("grok:grok-4.7");
  expect(grok.prepare.reasoningEffort).toBe("high");
  expect(grok.prepare.mekugiFlags).toEqual([]);
  const monorepo = launchConfiguration({ task: "mekugi-source-tools" });
  const mekugiSource = process.env.CODEX_AB_MEKUGI_SOURCE ?? join(homedir(), "projects/mekugi");
  expect(monorepo.prepare.source).toBe(resolve(mekugiSource));
  expect(launchConfiguration({ task: "mekugi-source-tools", source: "/pinned/mekugi" })
    .prepare.source).toBe("/pinned/mekugi");
  expect(monorepo.prepare.taskPackPath).toEndWith("tasks/mekugi-source-tools/manifest.json");
  expect(monorepo.prepare.profile).toBe("task");
  expect(monorepo.prepare.criteriaPath).toBeUndefined();
  expect(monorepo.prepare.reasoningEffort).toBe("xhigh");
  expect(monorepo.prepare.mekugiSource).toBeUndefined();
});

test("feature comparisons, repeat preparation, and custom task contracts use the retained owners", () => {
  const feature = launchConfiguration({ preset: "duplicate-output", count: "3", order: "alternating", "prepare-only": true });
  expect(feature.prepare.comparison).toBe("duplicate-output");
  expect(feature.count).toBe(3);
  expect(feature.order).toBe("alternating");
  expect(feature.prepareOnly).toBe(true);
  const custom = launchConfiguration({ task: "custom", source: "/source path", base: "base", forbidden: "solution", "task-file": "/prompt.md", criteria: "/criteria.json" });
  expect(custom.prepare.source).toBe("/source path");
  expect(custom.prepare.taskPath).toBe("/prompt.md");
});

test("sqlite-utils upgrade uses its pinned pack, cloned source and documented runtime defaults", () => {
  const options = launchConfiguration({ task: "sqlite-utils-history", "prepare-only": true });
  expect(options.prepare.source).toEndWith("codex-ab-sqlite-utils-source");
  expect(options.prepare.comparison).toBe("stock-mekugi");
  expect(options.prepare.mekugiFlags).toEqual([]);
  expect(options.prepare.taskPackPath).toEndWith("tasks/sqlite-utils-history/manifest.json");
  expect(options.prepare.criteriaPath).toBeUndefined();
  expect(options.prepare.reasoningEffort).toBe("xhigh");
  expect(options.prepare.timeoutSeconds).toBe(3300);
  expect(options.prepare.autoCompactLimit).toBe(200000);
  expect(launchConfiguration({ task: "sqlite-utils-history", "auto-compact-limit": "60000", "prepare-only": true }).prepare.autoCompactLimit).toBe(60000);
  const overridden = launchConfiguration({ task: "sqlite-utils-history", source: "/existing-checkout", preset: "stock-current", "reasoning-effort": "high", timeout: "1000" });
  expect(overridden.prepare.source).toBe("/existing-checkout");
  expect(overridden.prepare.comparison).toBe("stock-current");
  expect(overridden.prepare.reasoningEffort).toBe("high");
  expect(overridden.prepare.timeoutSeconds).toBe(1000);
  expect(overridden.prepare.autoCompactLimit).toBeUndefined();
  expect(() => launchConfiguration({ task: "sqlite-utils-history", preset: "stock-current", "auto-compact-limit": "200000" })).toThrow("applies only to stock-mekugi");
  expect(() => launchConfiguration({ task: "sqlite-utils-history", source: " " })).toThrow("Source checkout is required");
});

test("incompatible comparisons and malformed parameters reject before external work", () => {
  for (const [options, error] of [
    [{ preset: "same-setup", task: "mekugi-source-tools" }, "require a task outside Mekugi"],
    [{ task: "mekugi-source-tools", "current-launcher": "mekugi" }, "require a task outside Mekugi"],
    [{ task: "mekugi-source-tools", base: "override" }, "task pack owns"],
    [{ task: "session-retention" }, "supported task"],
    [{ task: "native-tool-frontends" }, "supported task"],
    [{ "journal-compaction": "auto" }, "no longer supported"],
    [{ "journal-compaction": "invalid", preset: "stock-mekugi" }, "no longer supported"],
    [{ preset: "journal-compaction" }, "supported comparison"],
    [{ count: "0" }, "positive integer"],
    [{ task: "custom", source: "/tmp/source" }, "custom task needs"],
    [{ "mekugi-build": "/build", "mekugi-bin": "/bin" }, "owns its source"],
  ] as const) expect(() => launchConfiguration(options)).toThrow(error);
});

test("the agent CLI accepts equals syntax and requires explicit paid consent", async () => {
  expect(main(["launch", "--preset=stock-mekugi", "--model=gpt-6.1-sol", "--reasoning-effort=high"])).rejects.toThrow("confirm-paid-inference");
  expect(main(["launch", "--prepare-only", "--mentor-handoff"])).rejects.toThrow("unknown option");
  expect(main(["launch", "--prepare-only=true"])).rejects.toThrow("does not accept a value");
});

test("the human convenience launcher starts the workbench instead of a paid preset", async () => {
  const result = Bun.spawn(["bash", join(import.meta.dir, "scripts/run.sh"), "--preset", "stock-mekugi"], { stdout: "pipe", stderr: "pipe" });
  expect(await result.exited).toBe(1);
  expect(await new Response(result.stderr).text()).toContain("unknown option for serve");
});

test("launch reuses a capable image and rebuilds missing or incomplete images without a host Codex", async () => {
  const ready = await imageProbe("ready");
  expect(ready.image).toMatchObject({ imageId: fixtureImageId, tools: {
    codex_version: "codex-cli 0.171.0", codex_sha256: codexHash,
    codex_code_mode_host_sha256: companionHash, codex_code_mode_host_size: 12345,
  } });
  expect(ready.calls.split("\n").filter(line => line.startsWith("run ")))
    .toEqual([`run --rm --network none ${fixtureImageId} sh -ec `]);
  expect(ready.calls).not.toContain("\nbuild ");
  for (const state of ["wrong-operator", "missing", "missing-companion", "missing-bun", "old-git", "missing-git-https"] as const) {
    const result = await imageProbe(state);
    expect(result.image?.imageId).toBe(rebuiltImageId);
    expect(result.calls).toContain(`run --rm --network none ${rebuiltImageId}`);
    expect(result.calls.split("\n").find(line => line.startsWith("build ")))
      .toBe("build -t fixture:latest .");
  }
});

test("image probe infrastructure failures stop without a build", async () => {
  for (const state of ["inspect-error", "identity-error", "daemon-error"] as const) {
    const result = await imageProbe(state);
    expect(result.error).toContain("Cannot");
    expect(result.calls).not.toContain("\nbuild ");
  }
});

test("launch selects the default image for the built-in task's toolchain", async () => {
  for (const task of ["nvm-download-no-eval", "flask-ipv6-server-name",
    "express-transfer-encoding", "sqlite-utils-history"]) {
    expect(launchConfiguration({ task, image: "" }).prepare.image).toBe("codex-ab:lean");
  }
  expect(launchConfiguration({ task: "mekugi-source-tools", image: "" }).prepare.image)
    .toBe("codex-ab:rust");
  expect(launchConfiguration({ task: "custom", "task-pack": "/own-pack", source: "/own-source",
    image: "" }).prepare.image).toBe("codex-ab:0.1.0");
  expect(launchConfiguration({ "task-pack": "/own-pack", image: "" }).prepare.image)
    .toBe("codex-ab:0.1.0");
  expect(launchConfiguration({ "current-launcher": "mekugi", "protect-mekugi": true,
    image: "" }).prepare.image).toBe("codex-ab:0.1.0");
  expect(launchConfiguration({ image: "custom-runtime:pinned" }).prepare.image)
    .toBe("custom-runtime:pinned");
  const missing = await imageProbe("missing", "codex-ab:lean");
  expect(missing.image?.imageId).toBe(rebuiltImageId);
  expect(missing.calls).toContain("build --target lean -t codex-ab:lean .");
});

test.each(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"])("launch accepts %s reasoning", effort => {
  expect(launchConfiguration({ "reasoning-effort": effort }).prepare.reasoningEffort).toBe(effort);
});

test("parallel work is opt-in and independent of trial scheduling", () => {
  expect(launchConfiguration({}).prepare.parallelWork).toBe(false);
  const launch = launchConfiguration({ "parallel-work": true, order: "alternating" });
  expect(launch.prepare.parallelWork).toBe(true);
  expect(launch.order).toBe("alternating");
});


test("setup-commit launch requires both revisions and shares the selected launcher", () => {
  const options = { preset: "setup-commits", "setup-a-commit": "HEAD~1", "setup-b-commit": "HEAD" };
  expect(launchConfiguration(options).prepare).toMatchObject({ comparison: "setup-commits", setupACommit: "HEAD~1", setupBCommit: "HEAD", currentLauncher: "codex" });
  expect(launchConfiguration({ ...options, "current-launcher": "mekugi" }).prepare.currentLauncher).toBe("mekugi");
  expect(() => launchConfiguration({ preset: "setup-commits" })).toThrow("both setup commits");
  expect(() => launchConfiguration({ ...options, preset: "stock-current" })).toThrow("only for setup-commits");
  expect(() => launchConfiguration({ ...options, "review-treatment": "/overlay" })).toThrow("overlays");
});

test("default source checkouts use persistent temporary storage and output overrides survive", () => {
  for (const task of taskCatalog().filter(task => task.repository)) {
    const override = task.id === "nvm-download-no-eval" ? process.env.CODEX_AB_SOURCE_DIR : process.env.CODEX_AB_SQLITE_UTILS_SOURCE;
    expect(task.source).toBe(override ?? (task.id === "nvm-download-no-eval" ? "/var/tmp/codex-ab-nvm-source" : "/var/tmp/codex-ab-sqlite-utils-source"));
  }
  expect(launchConfiguration({ "output-parent": "/chosen/output" }).prepare.outputParent).toBe("/chosen/output");
});
