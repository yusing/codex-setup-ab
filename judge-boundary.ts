import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { runOwnedContainer } from "./container";
import reader from "./judge-reader.mjs" with { type: "text" };
import type { RunState } from "./types";

/** Feature semantics reviewed against openai/codex rust-v0.154.0. */
export const JUDGE_DISABLED_FEATURES = ["shell_tool", "unified_exec", "code_mode", "multi_agent", "multi_agent_v2", "apps", "plugins", "hooks", "view_image"] as const;
export function sourceJudgeConfig(base: string): string {
  return base.replace('sandbox_mode = "danger-full-access"', 'sandbox_mode = "read-only"').replace('\n[projects.', '\nweb_search = "disabled"\n[projects.')
    + '\n[features]\n' + JUDGE_DISABLED_FEATURES.map(key => `${key} = false`).join("\n")
    + '\n\n[mcp_servers.source_reader]\ncommand = "node"\nargs = ["/reader/reader.mjs"]\nrequired = true\nenabled_tools = ["list_files", "read_file", "write_check_plan"]\n';
}
export async function prepareJudgeReader(root: string): Promise<string> {
  const path = join(root, "reader.mjs"); await writeFile(path, reader, { mode: 0o444 }); return path;
}
export function assertJudgeFeatures(output: string): void {
  for (const key of JUDGE_DISABLED_FEATURES) {
    if (!new RegExp(`^${key}\\s+.*\\sfalse\\s*$`, "m").test(output)) throw new Error(`source judge runtime did not prove ${key}=false; inference is blocked`);
  }
}
/** No credentials, candidate code, or model calls in capability qualification. */
export async function qualifyJudgeRuntime(docker: string, state: RunState, home: string, image: string, name: string, signal?: AbortSignal): Promise<void> {
  if (!/^codex-cli 0\.154\.0(?:\s|$)/.test(state.runtime_tools.codex_version)) throw new Error("source-reader judge boundary is qualified only for codex-cli 0.154.0; qualify new tool-registration semantics before inference");
  const result = await runOwnedContainer({ docker, name, signal, timeoutMs: 30_000,
    createArgs: ["--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "-v", `${join(home, ".codex/config.toml")}:/home/ubuntu/.codex/config.toml:ro`, image, "codex", "features", "list"] });
  if (result.exitCode !== 0 || result.timedOut || result.canceled) throw new Error(`source judge capability qualification failed: ${result.stderr}`);
  assertJudgeFeatures(result.stdout);
}
