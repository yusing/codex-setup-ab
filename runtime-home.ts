import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { dependencyImage } from "./dependencies";
import { checked, exec } from "./process";
import { runOwnedContainer, withOwnedNetwork } from "./container";
import { sha256 } from "./state";
import type { RunState } from "./types";

type Image = { key: string; image_id: string };
const digest = (input: unknown) => createHash("sha256").update(JSON.stringify(input)).digest("hex");
const pluginPreparations = new WeakMap<RunState, { key: string; image: Promise<string> }>();
const homePreparations = new WeakMap<RunState, Map<string, Promise<Image>>>();

// Reconcile account-visible plugin bundles through Codex's own app-server API.
// No thread or turn is created, so no model request can be made.
const PLUGIN_INITIALIZATION = `
import json, subprocess, sys
server = subprocess.Popen(['codex', '-c', 'log_dir="/runtime-state/codex/log"', 'app-server'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
def request(number, method, params):
    server.stdin.write(json.dumps(dict(id=number, method=method, params=params)) + '\\n')
    server.stdin.flush()
    for line in server.stdout:
        response = json.loads(line)
        if response.get('id') == number:
            if 'error' in response:
                raise RuntimeError(str(response['error']))
            return response.get('result', {})
    raise RuntimeError('plugin initialization server stopped')
try:
    request(1, 'initialize', {'clientInfo': {'name': 'runtime-home', 'version': '1'}})
    server.stdin.write('{"method":"initialized"}\\n')
    server.stdin.flush()
    result = request(2, 'plugin/reconcile', {'reason': 'runtime-cache-preparation'})
    if result.get('failedRemotePluginIds'):
        raise RuntimeError('runtime plugin prefetch incomplete')
    subprocess.run(['codex', 'plugin', 'list', '--available', '--json'], stdout=subprocess.DEVNULL, check=True)
finally:
    server.terminate()
    try:
        server.wait(timeout=5)
    except subprocess.TimeoutExpired:
        server.kill()
        server.wait()
`;

async function imageId(docker: string, reference: string, signal?: AbortSignal): Promise<string | undefined> {
  const result = await exec([docker, "image", "inspect", "--format", "{{.Id}}", reference], { signal });
  if (result.canceled || signal?.aborted) throw new Error("runtime home preparation canceled");
  if (result.exitCode !== 0 && /no such (image|object)/i.test(result.stderr)) return;
  const id = result.stdout.trim();
  if (result.exitCode !== 0 || !/^sha256:[a-f0-9]{64}$/.test(id)) throw new Error(`runtime home image unavailable: ${reference}`);
  return id;
}

/** Keep live evidence on the host while the rest of HOME uses Docker's private COW layer. */
export async function runtimeHomeMounts(home: string): Promise<string[]> {
  const codex = join(home, ".codex");
  const paths = ["sessions", "archived_sessions", "log"];
  for (const path of paths) await mkdir(join(codex, path), { recursive: true, mode: 0o700 });
  return ["-e", "CODEX_SQLITE_HOME=/runtime-state/codex", "-v", `${codex}:/runtime-state/codex`,
    ...paths.flatMap(path => ["-v", `${join(codex, path)}:/home/ubuntu/.codex/${path}`]),
    "-v", `${join(codex, "auth.json")}:/home/ubuntu/.codex/auth.json`];
}

/** Fetch account-visible plugin inputs without invoking a model, once per shared image/auth identity. */
async function pluginSeed(runDir: string, state: RunState, auth: string, docker: string, base: string, signal?: AbortSignal): Promise<string> {
  const key = digest({ version: 5, base, auth: await sha256(auth), operator: state.operator });
  if (state.runtime_plugin_image?.key === key) return state.runtime_plugin_image.image_id;
  const pending = pluginPreparations.get(state);
  if (pending?.key === key) return pending.image;
  const image = (async () => {
    const tag = `codex-ab-home-plugins:${key}`;
    const existing = await imageId(docker, tag, signal);
    if (existing) { state.runtime_plugin_image = { key, image_id: existing }; return existing; }
    const output = join(runDir, "artifacts/runtime-home/plugins", key);
    const evidence = join(output, "state");
    await mkdir(join(evidence, "log"), { recursive: true, mode: 0o700 });
    process.stderr.write("[run] preparing shared Codex plugin inputs without model inference\n");
    const result = await withOwnedNetwork(docker, `codex-ab-${state.id}-home-plugins`, signal, network => runOwnedContainer({
      docker, name: `codex-ab-${state.id}-home-plugins`, signal, timeoutMs: 120_000,
      snapshotImage: `codex-ab-home-changes:${crypto.randomUUID()}`,
      onSnapshot: image_id => { state.runtime_plugin_image = { key, image_id }; },
      stdoutFile: join(output, "stdout"), stderrFile: join(output, "stderr"),
      createArgs: ["--network", network, "--cpus", state.resource_limits.cpus, "--memory", state.resource_limits.memory,
        "-e", "CODEX_SQLITE_HOME=/runtime-state/codex", "-v", `${evidence}:/runtime-state/codex`,
        "-v", `${auth}:/run/task-auth.json:ro`, base, "sh", "-c",
        'mkdir -p "$CODEX_HOME"; ln -s /run/task-auth.json "$CODEX_HOME/auth.json"; trap \'rm -f "$CODEX_HOME/auth.json"\' EXIT; python3 -c "$1"', "runtime-home", PLUGIN_INITIALIZATION],
    }));
    if (result.snapshotImageId) state.runtime_plugin_image = { key, image_id: result.snapshotImageId };
    if (result.canceled || signal?.aborted) throw new Error("runtime home preparation canceled");
    if (result.exitCode !== 0) process.stderr.write("[run] plugin prefetch incomplete; normal launcher startup retains its own refresh behavior\n");
    if (!result.snapshotImageId) throw new Error("runtime plugin image was not retained");
    if (result.exitCode === 0) await checked([docker, "tag", result.snapshotImageId, tag]);
    return result.snapshotImageId;
  })();
  pluginPreparations.set(state, { key, image });
  try { return await image; }
  finally { if (pluginPreparations.get(state)?.image === image) pluginPreparations.delete(state); }

}

export async function prepareRuntimeHome(options: {
  runDir: string; state: RunState; template: string; auth: string; docker: string;
  identity: unknown; sourceHome?: string; signal?: AbortSignal;
  baseImage?: string;
}): Promise<Image> {
  const { runDir, state, docker, signal } = options;
  const base = await pluginSeed(runDir, state, options.auth, docker, options.baseImage ?? dependencyImage(state), signal);
  const key = digest({ version: 2, base, setup: options.identity, sourceHome: options.sourceHome, operator: state.operator });
  const pending = homePreparations.get(state) ?? new Map<string, Promise<Image>>();
  homePreparations.set(state, pending);
  const existingPreparation = pending.get(key);
  if (existingPreparation) return existingPreparation;
  const image = (async () => {
    const tag = `codex-ab-home:${key}`;
    const existing = await imageId(docker, tag, signal);
    if (existing) return { key, image_id: existing };
    const context = await mkdtemp(join(tmpdir(), "task-home-image-"));
    try {
      const buildBase = `codex-ab-home-base:${base.slice("sha256:".length)}`;
      await checked([docker, "tag", base, buildBase], { signal });
      await cp(options.template, join(context, "home"), { recursive: true, verbatimSymlinks: true,
        filter: source => resolve(source) !== resolve(options.template, ".codex/auth.json") });
      const configPath = join(context, "home/.codex/config.toml");
      if (await Bun.file(configPath).exists()) {
        const settings = { ...Bun.TOML.parse(await readFile(configPath, "utf8")),
          sqlite_home: "/runtime-state/codex", log_dir: "/runtime-state/codex/log" };
        const config = Bun.TOML.stringify(settings);
        if (config === undefined) throw new Error("cannot serialize runtime evidence paths");
        await writeFile(configPath, config, { mode: 0o600 });
      }
      const alias = options.sourceHome && options.sourceHome !== "/home/ubuntu" ? options.sourceHome : undefined;
      const recipe = [`FROM ${buildBase}`, "USER root",
        "RUN rm -f /home/ubuntu/.codex/auth.json",
        `COPY --chown=${state.operator.uid}:${state.operator.gid} home /home/ubuntu`,
        ...(alias ? [`RUN ${JSON.stringify(["python3", "-c",
          "import pathlib,sys,tempfile,shutil\np=pathlib.Path(sys.argv[1])\np.parent.mkdir(parents=True,exist_ok=True)\n" +
          "if p.exists() or p.is_symlink():\n backup=pathlib.Path(tempfile.mkdtemp(prefix='task-home-base-'))\n" +
          " if p.is_dir() and not p.is_symlink():\n  for child in p.iterdir(): shutil.move(str(child),str(backup/child.name))\n  p.rmdir()\n" +
          " else: p.rename(backup/'original')\np.symlink_to('/home/ubuntu',target_is_directory=True)", alias])}`] : []),
        `USER ${state.operator.uid}:${state.operator.gid}`, ""].join("\n");
      await writeFile(join(context, "Dockerfile"), recipe);
      const output = join(runDir, "artifacts/runtime-home", key);
      await mkdir(output, { recursive: true });
      await writeFile(join(output, "Dockerfile"), recipe);
      process.stderr.write("[run] building immutable runtime home; mutable home changes stay in private Docker layers\n");
      const result = await exec([docker, "build", "--network=none", "--tag", tag, context], { signal, timeoutMs: 300_000,
        stdoutFile: join(output, "build.stdout"), stderrFile: join(output, "build.stderr") });
      if (result.exitCode !== 0 || result.canceled || signal?.aborted) throw new Error("runtime home image build failed; see artifacts/runtime-home");
      const id = await imageId(docker, tag, signal);
      if (!id) throw new Error("runtime home image was not resolved safely");
      return { key, image_id: id };
    } finally { await rm(context, { recursive: true, force: true }); }
  })();
  pending.set(key, image);
  try { return await image; }
  catch (error) { pending.delete(key); throw error; }

}
