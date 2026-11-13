import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareJudgeReader, qualifyJudgeRuntime, sourceJudgeConfig } from "./judge-boundary";
import { minimalCodexConfig } from "./prepare";
import { runOwnedContainer } from "./container";
const liveTest = process.env.CODEX_AB_LIVE_DOCKER === "1" ? test : test.skip;
const image = process.env.CODEX_AB_LIVE_IMAGE ?? "codex-ab:model-free";
const docker = process.env.CODEX_AB_DOCKER_BIN ?? "docker";
const utilityNames = ["update_plan", "apply_patch", "request_user_input", "request_user_input_async", "send_message_to_user_async",
  "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource", "get_context_remaining", "new_context_window", "tool_search", "clock__curr_time"];
liveTest("source judge disables execution flags and its broker restricts source reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "judge-boundary-live-"));
  try {
    const home = join(root,"home"); await mkdir(join(home,".codex"),{recursive:true});
    await writeFile(join(home,".codex/config.toml"),sourceJudgeConfig(minimalCodexConfig("gpt-6.1-sol","high")));
    await qualifyJudgeRuntime(docker,home,image,`codex-ab-reader-features-${process.pid}`);
    const source = join(root,"source"); await mkdir(source);
    await writeFile(join(source,"malicious.py"),'open("/home/ubuntu/.codex/auth.json").read()\n');
    const reader = await prepareJudgeReader(root);
    const requests = [
      {jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"read_file",arguments:{path:"/candidates/malicious.py"}}},
      {jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"exec_command",arguments:{command:"python /candidates/malicious.py"}}},
      {jsonrpc:"2.0",id:3,method:"tools/call",params:{name:"read_file",arguments:{path:"/home/ubuntu/.codex/auth.json"}}},
    ];
    const result = await runOwnedContainer({docker,name:`codex-ab-reader-broker-${process.pid}`,stdin:requests.map(item=>JSON.stringify(item)).join("\n")+"\n",
      createArgs:["--network","none","--cap-drop","ALL","--security-opt","no-new-privileges","-i","-v",`${reader}:/reader.mjs:ro`,"-v",`${source}:/candidates:ro`,image,"node","/reader.mjs"]});
    expect(result.exitCode,result.stderr).toBe(0);
    const responses = result.stdout.trim().split("\n").map(line=>JSON.parse(line));
    expect(responses[0].result.content[0].text).toContain('auth.json');
    expect(responses[1].result.isError).toBe(true); expect(responses[2].result.isError).toBe(true);
  } finally {await rm(root,{recursive:true,force:true});}
},60_000);

// SSE fixtures follow openai/codex rust-v0.154.0 core/tests/common/responses.rs.
// A named loopback provider is required: this pinned CLI rejects overrides of
// reserved builtin provider IDs. The pinned model, judge config and broker stay
// intact, and every actually advertised tool is checked against the allowlist.
const mockProvider = String.raw`
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import * as zlib from 'node:zlib';
const requests = [], unexpected = [];
const boundarySource = [
  'const utilities = new Set(${JSON.stringify(utilityNames)});',
  'const broker = /^(?:mcp__source_reader(?:__|\\.)|source_reader\\.)(?:list_files|read_file|write_check_plan)$/;',
  'const names = ALL_TOOLS.map(tool => tool.name); text(JSON.stringify({tools:names}));',
  'const unexpected = names.filter(name => !utilities.has(name.replace(/^functions[_.]/,"")) && !broker.test(name));',
  'if (unexpected.length) throw Error("Unexpected executable surface: " + unexpected.join(","));',
  'if (typeof process !== "undefined" || typeof require !== "undefined" || typeof fetch !== "undefined" || typeof Bun !== "undefined" || typeof Deno !== "undefined") throw Error("Host I/O globals exposed");',
  'const reader = ALL_TOOLS.find(tool => broker.test(tool.name) && tool.name.endsWith("read_file"));',
  'const lister = ALL_TOOLS.find(tool => broker.test(tool.name) && tool.name.endsWith("list_files"));',
  'const writer = ALL_TOOLS.find(tool => broker.test(tool.name) && tool.name.endsWith("write_check_plan"));',
  'if (!reader || !lister || !writer) throw Error("Source reader unavailable");',
  'const listed = await tools[lister.name]({path:"/candidates/candidate-1"});',
  'if (listed.isError || !JSON.stringify(listed).includes("candidate.py")) throw Error("Broker listing failed");',
  'const observed = await tools[reader.name]({path:"/candidates/candidate-1/candidate.py"});',
  'if (observed.isError || !JSON.stringify(observed).includes("candidate must never execute")) throw Error("Broker read failed");',
  'text(await tools[writer.name]({json:JSON.stringify({boundary:"ready"})}));'
].join('\n');
const server = createServer(async (request, response) => {
  try {
    if (request.method !== 'POST' || new URL(request.url, 'http://localhost').pathname !== '/v1/responses') {
      unexpected.push(request.method + ' ' + request.url);
      response.writeHead(404); response.end('unexpected route'); return;
    }
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    let bytes = Buffer.concat(chunks);
    if (request.headers['content-encoding'] === 'gzip') bytes = zlib.gunzipSync(bytes);
    else if (request.headers['content-encoding'] === 'deflate') bytes = zlib.inflateSync(bytes);
    else if (request.headers['content-encoding'] === 'zstd') bytes = zlib.zstdDecompressSync(bytes);
    else if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') throw Error('unsupported encoding');
    requests.push({ body: JSON.parse(bytes.toString('utf8')), authorization: Boolean(request.headers.authorization) });
    const output = !requests.at(-1).body.tools && !JSON.stringify(requests.at(-1).body.input).includes('boundary-call')
      ? {id:'boundary-call',type:'custom_tool_call',call_id:'boundary-call',name:'exec',input:boundarySource}
      : {id:'boundary-message',type:'message',role:'assistant',content:[{type:'output_text',text:'boundary-ready'}]};
    const events = [
      {type:'response.created',response:{id:'boundary-response'}},
      {type:'response.output_item.done',item:output},
      {type:'response.completed',response:{id:'boundary-response',usage:{input_tokens:0,input_tokens_details:null,output_tokens:0,output_tokens_details:null,total_tokens:0}}}
    ];
    response.writeHead(200, {'content-type':'text/event-stream'});
    response.end(events.map(event => 'event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n').join(''));
  } catch (error) { unexpected.push(String(error)); response.writeHead(500); response.end('mock error'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const args = ['exec','--json','--color','never','--skip-git-repo-check','--model','gpt-6.1-sol',
  '-c','model_provider="fixture"',
  '-c','model_providers.fixture.name="Loopback boundary fixture"',
  '-c','model_providers.fixture.base_url="http://127.0.0.1:'+port+'/v1"',
  '-c','model_providers.fixture.wire_api="responses"',
  '-c','model_providers.fixture.requires_openai_auth=false',
  '-c','model_providers.fixture.supports_websockets=false',
  '-c','model_providers.fixture.request_max_retries=0',
  '-c','model_providers.fixture.stream_max_retries=0','-'];
const child = spawn('codex', args, {cwd:'/workspace',env:{PATH:process.env.PATH,HOME:'/home/ubuntu',CODEX_HOME:'/home/ubuntu/.codex',TMPDIR:process.env.TMPDIR ?? '/tmp',LANG:'C.UTF-8'},stdio:['pipe','pipe','pipe']});
let stdout = '', stderr = '';
child.stdout.on('data', chunk => {stdout += chunk;});
child.stderr.on('data', chunk => {stderr += chunk;});
child.stdin.end('Confirm the source inspection boundary.');
const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
const code = await new Promise((resolve,reject) => {child.once('error',reject);child.once('close',resolve);});
clearTimeout(timer); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
console.log(JSON.stringify({code,requests,unexpected,stdout:stdout.slice(-4096),stderr:stderr.slice(-4096)}));
`;

liveTest("selected CLI advertises only approved source and utility tools to a credential-free mock provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "judge-tool-inventory-"));
  try {
    const home = join(root, "home"), source = join(root, "source"), harness = join(root, "harness");
    await mkdir(join(home, ".codex"), { recursive: true });
    await mkdir(source); await mkdir(harness);
    await writeFile(join(home, ".codex/config.toml"), sourceJudgeConfig(minimalCodexConfig("gpt-6.1-sol", "high")));
    await qualifyJudgeRuntime(docker, home, image, `codex-ab-tool-inventory-features-${process.pid}`);
    await writeFile(join(source, "candidate.py"), 'raise RuntimeError("candidate must never execute in source judge")\n');
    const reader = await prepareJudgeReader(root), mock = join(root, "mock-provider.mjs");
    await writeFile(mock, mockProvider);
    const result = await runOwnedContainer({ docker, name: `codex-ab-tool-inventory-${process.pid}`, timeoutMs: 45_000,
      createArgs: ["--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "-v", `${home}:/home/ubuntu`, "-v", `${reader}:/reader/reader.mjs:ro`, "-v", `${mock}:/mock-provider.mjs:ro`,
        "-v", `${source}:/candidates/candidate-1:ro`, "-v", `${harness}:/harness`, image, "node", "/mock-provider.mjs"] });
    expect(result.exitCode, result.stderr).toBe(0);
    const captured = JSON.parse(result.stdout.trim());
    expect(captured.code, captured.stderr).toBe(0);
    expect(captured.unexpected).toEqual([]);
    expect(captured.requests.length).toBeGreaterThan(0);
    const leafTools = (tools: any[], namespace = ""): Array<{ name: string; type: string }> => tools.flatMap(tool =>
      tool.type === "namespace" ? leafTools(tool.tools, tool.name)
        : [{ name: `${namespace ? namespace + "." : ""}${tool.name ?? tool.function?.name ?? ""}`, type: tool.type }]);
    const utilities = new Set(utilityNames);
    const broker = /^(?:mcp__source_reader(?:__|\.)|source_reader\.)(?:list_files|read_file|write_check_plan)$/;
    for (const request of captured.requests) {
      expect(request.authorization).toBe(false);
      if (!request.body.tools) {
        const toolResults = captured.requests.flatMap((r:any) => r.body.input?.filter((item:any) => item.type === "custom_tool_call_output") ?? []);
        expect(await Bun.file(join(harness, "checks.json")).exists(), captured.stdout + captured.stderr + JSON.stringify(toolResults)).toBe(true);
        expect(await Bun.file(join(harness, "checks.json")).json(), captured.stdout + captured.stderr).toEqual({boundary:"ready"});
        continue;
      }
      const tools = leafTools(request.body.tools);
      expect(tools.length).toBeGreaterThan(0);
      const unexpectedTools = tools.filter(tool => {
        const name = tool.name.replace(/^functions\./, "");
        return !(utilities.has(name) || broker.test(name)) || !["function", "custom"].includes(tool.type);
      }).map(tool => `${tool.type}:${tool.name}`);
      expect(unexpectedTools, "unexpected advertised tools").toEqual([]);
      for (const name of ["list_files", "read_file", "write_check_plan"]) {
        expect(tools.some(tool => broker.test(tool.name.replace(/^functions\./, "")) && tool.name.endsWith(name))).toBe(true);
      }
    }
    expect(await Bun.file(join(home, ".codex/auth.json")).exists()).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 60_000);
