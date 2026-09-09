import { exec, type ExecResult } from "./process";

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
}

export interface OwnedContainerResult extends ExecResult {
  cleanupVerified: true;
}

export class OwnedContainerError extends Error {
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
  if (removed.exitCode !== 0) throw new OwnedContainerError(`container cleanup failed for ${name}: ${removed.stderr.trim() || `rm exited ${removed.exitCode}`}`);
  if (!(await absent(docker, target))) throw new OwnedContainerError(`container cleanup could not verify ${name} is absent`);
}

/** Own one named container from creation through verified absence. */
export async function runOwnedContainer(options: OwnedContainerOptions): Promise<OwnedContainerResult> {
  const { docker, name, signal } = options;
  const owner = crypto.randomUUID();
  let created = false;
  let containerId: string | undefined;
  let result: ExecResult | undefined;
  if (signal?.aborted) {
    if (!(await absent(docker, name))) throw new OwnedContainerError(`container name collision before canceled creation: ${name}`);
    throw new OwnedContainerError(`container ${name} canceled before creation`);
  }
  if (!(await absent(docker, name))) throw new OwnedContainerError(`container name already exists and is not owned by this attempt: ${name}`);
  try {
    const create = await exec([docker, "create", "--rm", "--name", name, "--label", `codex-ab.owner=${owner}`, ...options.createArgs], { signal });
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
      abortCleanup ??= removeAndVerify(docker, name, owner, containerId).then(
        () => ({}),
        error => ({ error }),
      );
    };
    signal?.addEventListener("abort", cleanupOnAbort, { once: true });
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
    await removeAndVerify(docker, name, owner, containerId);
    return { ...result, cleanupVerified: true };
  } catch (error) {
    try {
      if (created) await removeAndVerify(docker, name, owner, containerId);
      else {
        const raced = await inspect(docker, name, '{{ index .Config.Labels "codex-ab.owner" }}');
        if (raced.present && raced.value === owner) await removeAndVerify(docker, name, owner);
        else if (raced.present) throw new OwnedContainerError(`refusing to remove unowned container after create failure: ${name}`);
      }
    } catch (cleanupError) {
      throw new OwnedContainerError(`${error instanceof Error ? error.message : String(error)}; ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`, result);
    }
    if (error instanceof OwnedContainerError) throw error;
    throw new OwnedContainerError(`container ${name} failed: ${error instanceof Error ? error.message : String(error)}`, result);
  }
}
