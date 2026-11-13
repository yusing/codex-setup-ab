import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertJudgeFeatures, JUDGE_DISABLED_FEATURES, qualifyJudgeRuntime, sourceJudgeConfig } from "./judge-boundary";
import { minimalCodexConfig } from "./prepare";

test("runtime qualification checks capabilities without a CLI version allowlist", async () => {
  const root = await mkdtemp(join(tmpdir(), "judge-runtime-"));
  try {
    const docker = join(root, "docker"), features = join(root, "features"), log = join(root, "calls");
    await writeFile(features, JUDGE_DISABLED_FEATURES.map(key => `${key} stable false`).join("\n"));
    await writeFile(docker, `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
case "$1" in
  container) echo 'No such container' >&2; exit 1 ;;
  create) echo fixture ;;
  start) cat '${features}' ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 });
    await qualifyJudgeRuntime(docker, root, "selected-image", "capability-probe");
    const calls = await Bun.file(log).text();
    expect(calls).toContain("selected-image codex features list");
    expect(calls).not.toContain("--version");
    await writeFile(features, "shell_tool stable true\n");
    await expect(qualifyJudgeRuntime(docker, root, "selected-image", "unsafe-probe")).rejects.toThrow("shell_tool=false");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("judge registration disables executable tools and keeps broker paths outside source configuration", () => {
  const config = Bun.TOML.parse(sourceJudgeConfig(minimalCodexConfig("gpt-6.1-sol", "high"))) as any;
  expect(config.sandbox_mode).toBe("read-only"); expect(config.web_search).toBe("disabled");
  expect(config.features.code_mode_host).toBe(true);
  for (const key of JUDGE_DISABLED_FEATURES) expect(config.features[key]).toBe(false);
  expect(config.mcp_servers.source_reader.required).toBe(true);
  expect(config.mcp_servers.source_reader.default_tools_approval_mode).toBe("approve");
  expect(() => assertJudgeFeatures(JUDGE_DISABLED_FEATURES.map(key => `${key} stable false`).join("\n"))).not.toThrow();
  expect(() => assertJudgeFeatures("shell_tool stable true")).toThrow("inference is blocked");
});
test("shell_tool is the execution master gate even when unified_exec selects the one-shot fallback", () => {
  const disabled = JUDGE_DISABLED_FEATURES.map(key => `${key} stable false`).join("\n");
  expect(() => assertJudgeFeatures(`${disabled}\nunified_exec stable true\n`)).not.toThrow();
  expect(() => assertJudgeFeatures(disabled.replace("shell_tool stable false", "shell_tool stable true") + "\nunified_exec stable false\n"))
    .toThrow("shell_tool=false");
  for (const key of JUDGE_DISABLED_FEATURES) {
    expect(() => assertJudgeFeatures(disabled.replace(`${key} stable false`, `${key} stable true`))).toThrow(`${key}=false`);
    expect(() => assertJudgeFeatures(disabled.replace(`${key} stable false`, ""))).toThrow(`${key}=false`);
  }
});
test("ambiguous or multiline feature evidence cannot qualify the source judge", () => {
  const disabled = JUDGE_DISABLED_FEATURES.map(key => `${key} stable false`).join("\n");
  expect(() => assertJudgeFeatures(disabled + "\nshell_tool stable true")).toThrow("shell_tool=false");
  expect(() => assertJudgeFeatures(disabled.replace("shell_tool stable false", "shell_tool\nother_feature stable false"))).toThrow("shell_tool=false");
});
test("real source reader blocks traversal, credential paths, symlinks, execution and arbitrary writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "judge-reader-"));
  try {
    const sources = join(root, "sources"), plan = join(root, "plans/checks.json"); await mkdir(sources);
    await writeFile(join(sources, "code.py"), 'raise Exception("never execute source")\n');
    await writeFile(join(root, "auth.json"), "secret fixture");
    await symlink(join(root, "auth.json"), join(sources, "link"));
    const requests = [
      {method:"tools/list"},
      {method:"tools/call",params:{name:"read_file",arguments:{path:"/candidates/code.py"}}},
      {method:"tools/call",params:{name:"read_file",arguments:{path:"/candidates/link"}}},
      {method:"tools/call",params:{name:"read_file",arguments:{path:"/candidates/../auth.json"}}},
      {method:"tools/call",params:{name:"read_file",arguments:{path:"/home/ubuntu/.codex/auth.json"}}},
      {method:"tools/call",params:{name:"exec_command",arguments:{command:"cat /home/ubuntu/.codex/auth.json"}}},
      {method:"tools/call",params:{name:"write_check_plan",arguments:{json:'{"candidate-1":[]}',path:"/candidates/code.py"}}},
    ];
    const child = Bun.spawn(["node", resolve("judge-reader.mjs"), JSON.stringify({"/candidates":sources}), plan], {stdin:"pipe",stdout:"pipe",stderr:"pipe"});
    child.stdin.write(requests.map((request,index)=>JSON.stringify({jsonrpc:"2.0",id:index+1,...request})).join("\n")+"\n"); child.stdin.end();
    const output = await new Response(child.stdout).text(); expect(await child.exited).toBe(0);
    const responses = output.trim().split("\n").map(line=>JSON.parse(line));
    expect(responses[0].result.tools.map((tool:any)=>tool.name)).toEqual(["list_files","read_file","write_check_plan"]);
    expect(responses[1].result.content[0].text).toContain("never execute source");
    for(const index of [2,3,4,5]) expect(responses[index].result.isError).toBe(true);
    expect(output).not.toContain("secret fixture");
    expect(await Bun.file(plan).json()).toEqual({"candidate-1":[]});
    expect(await Bun.file(join(sources,"code.py")).text()).toContain("never execute source");
  } finally { await rm(root,{recursive:true,force:true}); }
});
