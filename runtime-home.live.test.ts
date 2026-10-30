import { expect, spyOn, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareRuntimeHome } from "./runtime-home";
import { runOwnedContainer } from "./container";
import { miseToolMounts } from "./isolation";
import { readState } from "./state";
import * as processes from "./process";

const reference = process.env.CODEX_AB_LIVE_REFERENCE_RUN;
const liveTest = process.env.CODEX_AB_LIVE_DOCKER === "1" && reference ? test : test.skip;
const docker = process.env.CODEX_AB_DOCKER_BIN ?? "docker";

liveTest("runtime home preserves operator-writable mise state under the production debug tmpfs", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-runtime-home-live-"));
  try {
    const state = await readState(reference!);
    const arm = Object.keys(state.arms).at(-1)!;
    const template = join(reference!, state.arms[arm]!.home_template);
    expect(await access(join(template, ".local/state")).then(() => true, () => false)).toBe(false);
    const document = JSON.parse(await readFile(join(reference!, state.setup_revisions?.[arm]?.manifest ?? state.snapshot_manifest), "utf8"));
    const current = JSON.parse(await readFile(join(reference!, state.snapshot_manifest), "utf8"));
    const pluginImage = state.runtime_plugin_image!.image_id;
    const auth = join(root, "empty-auth.json");
    await writeFile(auth, "{}\n", { mode: 0o600 });

    // Reuse retained plugin inputs without credentials or plugin-refresh networking.
    const execute = processes.exec;
    const cachedPlugin = spyOn(processes, "exec").mockImplementation((args, options) => {
      const cached = args[0] === docker && args[1] === "image" && args[2] === "inspect"
        && args.at(-1)?.startsWith("codex-ab-home-plugins:");
      return execute(cached ? [...args.slice(0, -1), pluginImage] : args, options);
    });
    let image: Awaited<ReturnType<typeof prepareRuntimeHome>>;
    try {
      image = await prepareRuntimeHome({ runDir: root, state, template, auth, docker,
        identity: { files: document.files, repository: document.configuration_repository, template: state.arms[arm]!.home_template },
        sourceHome: current.source_home });
    } finally { cachedPlugin.mockRestore(); }
    expect(image.key).not.toBe(state.runtime_homes?.[arm]?.key);

    const user = `${state.operator.uid}:${state.operator.gid}`;
    const debug = ["--tmpfs", `/home/ubuntu/.local/state/mekugi/debug:size=4g,mode=0700,uid=${state.operator.uid},gid=${state.operator.gid}`];
    const result = await runOwnedContainer({ docker, name: `task-runtime-state-${process.pid}`, timeoutMs: 30_000,
      createArgs: ["--network", "none", "--user", user, ...debug, image.image_id, "python3", "-c",
        "import os,pathlib\n" +
        `assert os.getuid() == ${state.operator.uid}\n` +
        "for name in ['incomplete-installs','trusted-configs']:\n" +
        " p=pathlib.Path('/home/ubuntu/.local/state/mise')/name\n p.mkdir(parents=True)\n" +
        " (p/'probe').write_text('writable')\n assert (p/'probe').read_text() == 'writable'\n print(str(p)+': writable')"] });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("incomplete-installs: writable");
    expect(result.stdout).toContain("trusted-configs: writable");

    await mkdir(join(root, "exports"));
    const qualification = await runOwnedContainer({ docker, name: `task-runtime-launcher-${process.pid}`, timeoutMs: 30_000,
      createArgs: ["--network", "none", "--user", user, "--workdir", "/workspace", ...debug,
        "-v", `${join(reference!, state.arms[arm]!.repository)}:/workspace:ro`,
        "-v", `${join(root, "exports")}:/mekugi-exports`, ...await miseToolMounts(reference!, state), image.image_id,
        "sh", "-c", 'mise --version && exec "$@"', "runtime-home-qualification", "mise", "exec", "--", "sh", "-c",
        'export PATH="/opt/task-deps/python/bin:/usr/local/bin:$PATH"; exec "$@"', "pinned-launcher",
        "/usr/local/bin/mekugi", ...(state.mekugi_flags ?? []), "--capture-output=/mekugi-exports/capture.jsonl", "--debug", "codex", "--version"] });
    expect(qualification.exitCode, qualification.stderr).toBe(0);
    expect(qualification.stdout).toContain(state.runtime_tools.codex_version);
    console.info(`[runtime-home-live] ${image.image_id}\n${result.stdout}${qualification.stdout}`);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 300_000);
