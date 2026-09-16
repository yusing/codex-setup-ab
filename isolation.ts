import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TOOLHOST_SMOKE_SCRIPT } from "./toolhost";
import { runOwnedContainer } from "./container";
import type { RunState } from "./types";

export const ISOLATION_SCRIPTS = ["isolated-codex.sh", "agent-mounts.sh", "agent-check.py"] as const;

export function protectedArgs(runDir: string, state: RunState, runtime: string): string[] {
  if (!state.protected_runtime) return [];
  const destinations = ["/usr/local/bin/codex", "/usr/local/libexec/mekugi-agent-mounts", "/usr/local/libexec/mekugi-agent-check.py"];
  return ["--user", "0:0", "--read-only", "--cap-add", "NET_ADMIN", "--cap-add", "SYS_ADMIN",
    "--security-opt", "no-new-privileges", "--security-opt", "apparmor=unconfined",
    "--tmpfs", "/tmp:exec,size=4g,mode=1777",
    "-e", "PATH=/home/ubuntu/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/local/go/bin:/usr/sbin:/sbin",
    "-e", "MEKUGI_RUNTIME_DIR=/mekugi-runtime", "-e", "XDG_STATE_HOME=/mekugi-runtime/state",
    "-e", "BENCH_ARTIFACT_DIR=/mekugi-exports", "-e", "GOCACHE=/home/ubuntu/.cache/go-build",
    "-e", "GOPROXY=off", "-e", "GOSUMDB=off",
    "-v", `${runtime}:/mekugi-runtime`,
    ...state.protected_runtime.scripts.flatMap((file, index) => ["-v", `${join(runDir, file.path)}:${destinations[index]}:ro`])];
}

/** Only run-owned writable trees are handed to the capability-free root executor. */
export async function executorOwnership(docker: string, state: RunState, name: string, paths: string[], restore: boolean): Promise<void> {
  const result = await runOwnedContainer({ docker, name, timeoutMs: 120000,
    createArgs: ["--network", "none", "--user", "0:0",
      ...paths.flatMap((path, index) => ["-v", `${path}:/owned/${index}`]),
      state.image_id ?? state.image, "chown", "-hR", `${restore ? state.operator.uid : 0}:${state.operator.gid}`,
      ...paths.map((_, index) => `/owned/${index}`)] });
  if (result.exitCode !== 0) throw new Error(`protected executor ownership ${restore ? "restore" : "setup"} failed: ${result.stderr}`);
}

export async function protectedPreflight(docker: string, runDir: string, state: RunState, signal: AbortSignal): Promise<void> {
  const directory = await mkdtemp(join(runDir, "artifacts/isolation-"));
  const workspace = join(directory, "workspace"), home = join(directory, "home"), runtime = join(directory, "runtime"), exports = join(directory, "exports");
  await cp(join(runDir, state.arms.current.home_template), home, { recursive: true, verbatimSymlinks: true });
  await cp(join(runDir, state.arms.current.repository), workspace, { recursive: true, verbatimSymlinks: true });
  for (const path of [join(home, ".codex"), runtime, exports, join(directory, "modules")]) await mkdir(path, { recursive: true });
  await writeFile(join(home, ".codex/auth.json"), "{}\n", { mode: 0o600 });
  await writeFile(join(directory, "probe.go"), "package main\nfunc main() {}\n");
  // This replaces only the final CLI in the smoke container. The real router, owner
  // launcher, mount protection and executor qualification all execute first.
  await writeFile(join(directory, "toolhost.js"), TOOLHOST_SMOKE_SCRIPT);
  const probe = join(directory, "probe.py");
  await writeFile(probe, `#!/usr/bin/env python3
import os, pathlib, subprocess, urllib.request
for directory in [os.environ['MEKUGI_RUNTIME_DIR'], os.environ['BENCH_ARTIFACT_DIR']]:
    try:
        pathlib.Path(directory, 'executor-tamper').write_text('bad')
    except OSError:
        pass
    else:
        raise SystemExit('executor wrote protected state')
with urllib.request.urlopen(os.environ['MEKUGI_BASE_URL'].removesuffix('/v1') + '/api/metrics') as response:
    assert response.status == 200
subprocess.run(['go', 'build', '-o', '/tmp/probe', '/probe.go'], cwd='/tmp', check=True)
subprocess.run(['/tmp/probe'], check=True)
subprocess.run(['node', '/probe-toolhost.js'], check=True)
print('CODEX_AB_PROTECTED_RUNTIME_OK')
`, { mode: 0o755 });
  const paths = [workspace, home, runtime, exports];
  try {
    await executorOwnership(docker, state, `${state.id}-isolation-own`, paths, false);
    const common = [...protectedArgs(runDir, state, runtime), "--cpus", state.resource_limits.cpus, "--memory", state.resource_limits.memory,
        "-v", `${workspace}:/workspace`, "-v", `${home}:/home/ubuntu`,
        "-v", `${exports}:/mekugi-exports`, "-v", `${join(directory, "modules")}:/go/pkg/mod:ro`,
        "-v", `${join(runDir, state.runtime_tools.current_setup_installs)}:/home/ubuntu/.local/share/mise/installs:ro`];
    const command = [state.image_id ?? state.image, "mise", "exec", "--", "mekugi", ...(state.mekugi_flags ?? []),
      "--capture-output=/mekugi-exports/capture.jsonl", "--metrics-output=/mekugi-exports/metrics.json", "codex", "--version"];
    const result = await runOwnedContainer({ docker, name: `${state.id}-isolation-probe`, signal, timeoutMs: 180000,
      createArgs: [...common, "-v", `${join(directory, "toolhost.js")}:/probe-toolhost.js:ro`, "-v", `${join(directory, "probe.go")}:/probe.go:ro`,
        "-v", `${probe}:/usr/local/libexec/codex-real:ro`, ...command] });
    await writeFile(join(runDir, "artifacts/preflight-isolation.json"), JSON.stringify(result, null, 2));
    if (result.exitCode !== 0 || !result.stdout.includes("CODEX_AB_PROTECTED_RUNTIME_OK")) throw new Error(`protected runtime preflight failed: ${result.stderr}`);
    const codex = await runOwnedContainer({ docker, name: `${state.id}-isolation-codex`, signal, timeoutMs: 30000,
      createArgs: [...common, ...command] });
    await writeFile(join(runDir, "artifacts/preflight-isolation.json"), JSON.stringify({ ...result, codex }, null, 2));
    if (codex.exitCode !== 0 || !codex.stdout.includes(state.runtime_tools?.codex_version ?? "codex-cli")) {
      throw new Error(`protected Codex startup failed: ${codex.stderr}`);
    }
  } finally {
    await executorOwnership(docker, state, `${state.id}-isolation-restore`, paths, true);
    await rm(directory, { recursive: true, force: true });
  }
}
