import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { runOwnedContainer } from "./container";
import reader from "./judge-reader.mjs" with { type: "text" };
import type { RunState } from "./types";

/**
 * rust-v0.154.0 tools/spec_plan.rs add_shell_tools returns before registering
 * either executor when ShellTool is false. UnifiedExec only selects persistent
 * versus one-shot execution; only managed requirements can keep it disabled.
 * Pinned source blob: 01054b1b504811a5fee21d6bc083c1f5117d52ea.
 */
export const JUDGE_DISABLED_FEATURES = ["shell_tool", "code_mode", "code_mode_host", "multi_agent", "multi_agent_v2", "apps", "plugins", "hooks", "view_image",
  "computer_use", "browser_use", "browser_use_external", "browser_use_full_cdp_access", "image_generation", "goals", "sleep_tool", "skill_search"] as const;
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
    const rows = output.split(/\r?\n/).filter(line => new RegExp(`^${key}(?:[ \\t]|$)`).test(line));
    if (rows.length !== 1 || !new RegExp(`^${key}[ \\t]+(?:stable|under development|experimental|deprecated|removed)[ \\t]+false[ \\t]*$`).test(rows[0]!))
      throw new Error(`source judge runtime did not prove ${key}=false; inference is blocked`);
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
