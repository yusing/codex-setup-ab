import { exec, type ExecResult } from "./process";
import { errorMessage } from "./util";

export interface OwnedContainerOptions {
  docker: string;
  name: string;
  /** Docker create arguments beginning with flags and ending with image + command. */
  createArgs: string[];
  stdin?: string;
  stdoutFile?: string;
  stderrFile?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Retain private writable-layer changes before removal, including failed/canceled commands. */
  snapshotImage?: string;
  /** Restore the image's runtime identity after a root-only metadata preparation. */
  snapshotUser?: string;
  onSnapshot?: (imageId: string) => void | Promise<void>;
}

export interface OwnedContainerResult extends ExecResult {
  cleanupVerified: true;
  snapshotImageId?: string;
}

export class OwnedContainerError extends Error {
  snapshotImageId?: string;
  constructor(message: string, readonly result?: ExecResult) { super(message); this.name = "OwnedContainerError"; }
}

async function inspect(docker: string, name: string, format = "{{.Id}}"): Promise<{ present: boolean; value?: string }> {
  const result = await exec([docker, "container", "inspect", "--format", format, name]);
  if (result.exitCode === 0) return { present: true, value: result.stdout.trim() };
  if (/no such (object|container)/i.test(result.stderr)) return { present: false };
  throw new OwnedContainerError(`cannot verify container ${name}: ${result.stderr.trim() || `inspect exited ${result.exitCode}`}`);
}

async function absent(docker: string, name: string): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!(await inspect(docker, name)).present) return true;
    await Bun.sleep(50);
  }
  return false;
}

async function removeAndVerify(docker: string, name: string, owner: string, containerId?: string): Promise<void> {
  const target = containerId ?? name;
  const state = await inspect(docker, target, '{{ index .Config.Labels "codex-ab.owner" }}');
  if (!state.present) return;
  if (state.value !== owner) throw new OwnedContainerError(`refusing to remove unowned container name collision: ${name}`);
  const removed = await exec([docker, "rm", "--force", target]);
  const isAbsent = await absent(docker, target);
  if (removed.exitCode !== 0 && !isAbsent) {
    throw new OwnedContainerError(`container cleanup failed for ${name}: ${removed.stderr.trim() || `rm exited ${removed.exitCode}`}`);
  }
  if (!isAbsent) throw new OwnedContainerError(`container cleanup could not verify ${name} is absent`);
}

export interface OwnedNetwork {
  name: string;
  remove(): Promise<void>;
}

export interface OwnedNetworkOptions {
  /** Pass --internal to docker network create so containers on this network have no direct external routing. */
  internal?: boolean;
}

export interface OwnedSidecarOptions {
  docker: string;
  name: string;
  /** Docker create arguments beginning with flags and ending with image + command. */
  createArgs: string[];
  /** Additional networks to connect before starting the sidecar container. */
  extraNetworks?: Array<{ network: string; aliases?: string[] }>;
  /** Optional host path created by the sidecar once ready to accept traffic. */
  readyFile?: string;
  readyTimeoutMs?: number;
  signal?: AbortSignal;
}

export interface OwnedSidecar {
  name: string;
  containerId: string;
  stop(): Promise<void>;
}

async function inspectNetwork(docker: string, name: string): Promise<{ present: boolean; owner?: string }> {
  const result = await exec([docker, "network", "inspect", "--format", '{{ index .Labels "codex-ab.owner" }}', name]);
  if (result.exitCode === 0) return { present: true, owner: result.stdout.trim() };
  if (/(?:no such network|network .* not found)/i.test(result.stderr)) return { present: false };
  throw new OwnedContainerError(`cannot verify Docker network ${name}: ${result.stderr.trim() || `inspect exited ${result.exitCode}`}`);
}

async function removeNetwork(docker: string, name: string, owner: string): Promise<void> {
  const state = await inspectNetwork(docker, name);
  if (!state.present) return;
  if (state.owner !== owner) throw new OwnedContainerError(`refusing to remove unowned Docker network collision: ${name}`);
  const removed = await exec([docker, "network", "rm", name]);
  const remaining = await inspectNetwork(docker, name);
  if (removed.exitCode !== 0 && remaining.present) {
    throw new OwnedContainerError(`Docker network cleanup failed for ${name}: ${removed.stderr.trim() || `network rm exited ${removed.exitCode}`}`);
  }
  if (remaining.present) throw new OwnedContainerError(`Docker network cleanup could not verify ${name} is absent`);
}

/** Create an IPv6-capable, run-owned provider network and return an idempotent cleanup handle. */
export async function createOwnedNetwork(docker: string, name: string, signal?: AbortSignal, options?: OwnedNetworkOptions): Promise<OwnedNetwork> {
  const owner = crypto.randomUUID();
  if (signal?.aborted) throw new OwnedContainerError(`Docker network ${name} canceled before creation`);
  if ((await inspectNetwork(docker, name)).present) throw new OwnedContainerError(`Docker network name already exists and is not owned by this attempt: ${name}`);
  const created = await exec([
    docker, "network", "create", "--ipv6",
    ...(options?.internal ? ["--internal"] : []),
    "--label", `codex-ab.owner=${owner}`, name,
  ], { signal });
  if (created.exitCode !== 0 || created.canceled || signal?.aborted) {
    const raced = await inspectNetwork(docker, name);
    if (raced.present && raced.owner === owner) await removeNetwork(docker, name, owner);
    else if (raced.present) throw new OwnedContainerError(`refusing to remove unowned Docker network after create failure: ${name}`);
    throw new OwnedContainerError(`Docker network ${name} was not safely created: ${created.stderr.trim()}`, created);
  }
  let removed = false;
  return {
    name,
    async remove(): Promise<void> {
      if (removed) return;
      await removeNetwork(docker, name, owner);
      removed = true;
    },
  };
}

export async function withOwnedNetwork<T>(docker: string, name: string, signal: AbortSignal | undefined, action: (network: string) => Promise<T>, options?: OwnedNetworkOptions): Promise<T> {
  const network = await createOwnedNetwork(docker, name, signal, options);
  try {
    return await action(network.name);
  } finally {
    await network.remove();
  }
}

/** Start a detached run-owned sidecar container, connect any extra networks before start, and return an idempotent stop handle. */
export async function startOwnedSidecar(options: OwnedSidecarOptions): Promise<OwnedSidecar> {
  const { docker, name, signal } = options;
  const owner = crypto.randomUUID();
  let containerId: string | undefined;
  let created = false;
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (containerId) {
      await exec([docker, "stop", "--time", "2", containerId], { timeoutMs: 10_000 });
    }
    await removeAndVerify(docker, name, owner, containerId);
  };
  if (signal?.aborted) {
    if (!(await absent(docker, name))) throw new OwnedContainerError(`container name collision before canceled creation: ${name}`);
    throw new OwnedContainerError(`container ${name} canceled before creation`);
  }
  if (!(await absent(docker, name))) throw new OwnedContainerError(`container name already exists and is not owned by this attempt: ${name}`);
  try {
    const create = await exec([docker, "create", "--rm", "--name", name, "--label", `codex-ab.owner=${owner}`, ...options.createArgs], { signal });
    if (create.exitCode !== 0 || create.canceled || signal?.aborted) {
      await removeAndVerify(docker, name, owner);
      throw new OwnedContainerError(`sidecar container ${name} was not safely created: ${create.stderr.trim()}`, create);
    }
    created = true;
    containerId = create.stdout.trim();
    if (!containerId) throw new OwnedContainerError(`docker create returned no container ID for ${name}`, create);
    for (const attachment of options.extraNetworks ?? []) {
      const connect = await exec([
        docker, "network", "connect",
        ...(attachment.aliases?.flatMap(alias => ["--alias", alias]) ?? []),
        attachment.network, containerId,
      ], { signal });
      if (connect.exitCode !== 0 || connect.canceled || signal?.aborted) {
        throw new OwnedContainerError(`cannot connect sidecar ${name} to network ${attachment.network}: ${connect.stderr.trim()}`, connect);
      }
    }
    const started = await exec([docker, "start", containerId], { signal });
    if (started.exitCode !== 0 || started.canceled || signal?.aborted) {
      throw new OwnedContainerError(`sidecar container ${name} failed to start: ${started.stderr.trim()}`, started);
    }
    if (options.readyFile) {
      const deadline = Date.now() + (options.readyTimeoutMs ?? 15_000);
      while (!(await Bun.file(options.readyFile).exists())) {
        if (signal?.aborted) throw new OwnedContainerError(`sidecar container ${name} canceled before ready`);
        const running = await inspect(docker, containerId, "{{.State.Running}}");
        if (!running.present || running.value === "false") {
          const logs = await exec([docker, "logs", containerId], { timeoutMs: 5_000 });
          throw new OwnedContainerError(`sidecar container ${name} exited before ready: ${[logs.stdout.trim(), logs.stderr.trim()].filter(Boolean).join("; ") || "no output"}`);
        }
        if (Date.now() >= deadline) {
          throw new OwnedContainerError(`sidecar container ${name} did not become ready within ${options.readyTimeoutMs ?? 15_000}ms`);
        }
        await Bun.sleep(50);
      }
    }
    return { name, containerId, stop };
  } catch (error) {
    try {
      if (created) await stop();
      else {
        const raced = await inspect(docker, name, '{{ index .Config.Labels "codex-ab.owner" }}');
        if (raced.present && raced.value === owner) await removeAndVerify(docker, name, owner);
        else if (raced.present) throw new OwnedContainerError(`refusing to remove unowned container after create failure: ${name}`);
      }
    } catch (cleanupError) {
      throw new OwnedContainerError(`${errorMessage(error)}; ${errorMessage(cleanupError)}`);
    }
    if (error instanceof OwnedContainerError) throw error;
    throw new OwnedContainerError(`sidecar container ${name} failed: ${errorMessage(error)}`);
  }
}

/** Own one named container from creation through verified absence. */
export async function runOwnedContainer(options: OwnedContainerOptions): Promise<OwnedContainerResult> {
  const { docker, name, signal } = options;
  const owner = crypto.randomUUID();
  let created = false;
  let containerId: string | undefined;
  let result: ExecResult | undefined;
  let snapshotImageId: string | undefined;
  let finishing: Promise<void> | undefined;
  let started = false;
  const finish = (): Promise<void> => finishing ??= (async () => {
    if (options.snapshotImage && containerId && started) {
      const ownership = await inspect(docker, containerId, '{{ index .Config.Labels "codex-ab.owner" }}');
      if (!ownership.present || ownership.value !== owner) throw new OwnedContainerError(`cannot snapshot owned container ${name}`);
      const stopped = await exec([docker, "stop", "--time", "1", containerId], { timeoutMs: 30_000 });
      if (stopped.exitCode !== 0) throw new OwnedContainerError(`cannot stop ${name}; container retained for evidence`);
      const image = await exec([docker, "commit", ...(options.snapshotUser ? ["--change", `USER ${options.snapshotUser}`] : []), containerId, options.snapshotImage], { timeoutMs: 120_000 });
      if (image.exitCode !== 0 || !/^sha256:[a-f0-9]{64}$/.test(image.stdout.trim())) {
        throw new OwnedContainerError(`cannot snapshot ${name}: ${image.stderr.trim() || image.stdout.trim() || `exit ${image.exitCode}`}; stopped container retained for evidence`);
      }
      snapshotImageId = image.stdout.trim();
      await options.onSnapshot?.(snapshotImageId);
    }
    await removeAndVerify(docker, name, owner, containerId);
  })();
  if (signal?.aborted) {
    if (!(await absent(docker, name))) throw new OwnedContainerError(`container name collision before canceled creation: ${name}`);
    throw new OwnedContainerError(`container ${name} canceled before creation`);
  }
  if (!(await absent(docker, name))) throw new OwnedContainerError(`container name already exists and is not owned by this attempt: ${name}`);
  try {
    const create = await exec([docker, "create", ...(options.snapshotImage ? [] : ["--rm"]), "--name", name, "--label", `codex-ab.owner=${owner}`, ...options.createArgs], { signal });
    if (create.exitCode !== 0 || create.canceled || signal?.aborted) {
      await removeAndVerify(docker, name, owner);
      throw new OwnedContainerError(`container ${name} was not safely created: ${create.stderr.trim()}`, create);
    }
    created = true;
    containerId = create.stdout.trim();
    if (!containerId) throw new OwnedContainerError(`docker create returned no container ID for ${name}`, create);
    // This is the paid-launch boundary for model containers.
    if (signal?.aborted) {
      await removeAndVerify(docker, name, owner, containerId);
      throw new OwnedContainerError(`container ${name} canceled before start`, create);
    }
    let abortCleanup: Promise<{ error?: unknown }> | undefined;
    const cleanupOnAbort = () => {
      abortCleanup ??= finish().then(
        () => ({}),
        error => ({ error }),
      );
    };
    signal?.addEventListener("abort", cleanupOnAbort, { once: true });
    started = true;
    result = await exec([docker, "start", "--attach", ...(options.stdin === undefined ? [] : ["--interactive"]), containerId], {
      stdin: options.stdin,
      stdoutFile: options.stdoutFile,
      stderrFile: options.stderrFile,
      timeoutMs: options.timeoutMs,
      signal,
    });
    signal?.removeEventListener("abort", cleanupOnAbort);
    if (abortCleanup) {
      const outcome = await abortCleanup;
      if (outcome.error) throw outcome.error;
    }
    await finish();
    return { ...result, cleanupVerified: true, snapshotImageId };
  } catch (error) {
    try {
      if (created) await finish();
      else {
        const raced = await inspect(docker, name, '{{ index .Config.Labels "codex-ab.owner" }}');
        if (raced.present && raced.value === owner) await removeAndVerify(docker, name, owner);
        else if (raced.present) throw new OwnedContainerError(`refusing to remove unowned container after create failure: ${name}`);
      }
    } catch (cleanupError) {
      const failure = new OwnedContainerError(`${errorMessage(error)}; ${errorMessage(cleanupError)}`, result);
      failure.snapshotImageId = snapshotImageId;
      throw failure;
    }
    if (error instanceof OwnedContainerError) { error.snapshotImageId = snapshotImageId; throw error; }
    const failure = new OwnedContainerError(`container ${name} failed: ${errorMessage(error)}`, result);
    failure.snapshotImageId = snapshotImageId;
    throw failure;
  }
}
