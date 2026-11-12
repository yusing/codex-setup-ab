import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertJudgeFeatures, JUDGE_DISABLED_FEATURES, sourceJudgeConfig } from "./judge-boundary";
import { minimalCodexConfig } from "./prepare";

test("judge registration disables executable tools and keeps broker paths outside source configuration", () => {
  const config = Bun.TOML.parse(sourceJudgeConfig(minimalCodexConfig("gpt-6.1-sol", "high"))) as any;
  expect(config.sandbox_mode).toBe("read-only"); expect(config.web_search).toBe("disabled");
  for (const key of JUDGE_DISABLED_FEATURES) expect(config.features[key]).toBe(false);
  expect(config.mcp_servers.source_reader.required).toBe(true);
  expect(() => assertJudgeFeatures(JUDGE_DISABLED_FEATURES.map(key => `${key} stable false`).join("\n"))).not.toThrow();
  expect(() => assertJudgeFeatures("shell_tool stable true")).toThrow("inference is blocked");
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
