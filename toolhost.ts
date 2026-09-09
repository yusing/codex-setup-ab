/** Node script used inside the image to exercise the code-mode host protocol without model/API access. */
export const TOOLHOST_SMOKE_SCRIPT = String.raw`
const { spawn } = require("node:child_process");
const host = spawn(process.env.CODEX_CODE_MODE_HOST || "/usr/local/bin/codex-code-mode-host", ["--listen", "stdio"], { stdio: ["pipe", "pipe", "pipe"] });
const hostExit = new Promise(resolve => host.once("exit", (code, signal) => resolve({ code, signal })));
let buffered = Buffer.alloc(0);
const frames = [];
const waiters = [];
let diagnostics = "";
host.stderr.on("data", chunk => diagnostics += chunk.toString());
host.stdout.on("data", chunk => {
  buffered = Buffer.concat([buffered, chunk]);
  while (buffered.length >= 4) {
    const length = buffered.readUInt32LE(0);
    if (buffered.length < length + 4) break;
    const value = JSON.parse(buffered.subarray(4, length + 4).toString("utf8"));
    buffered = buffered.subarray(length + 4);
    const waiter = waiters.shift();
    if (waiter) waiter(value); else frames.push(value);
  }
});
function send(value) {
  const body = Buffer.from(JSON.stringify(value));
  const frame = Buffer.allocUnsafe(body.length + 4);
  frame.writeUInt32LE(body.length, 0); body.copy(frame, 4); host.stdin.write(frame);
}
function next() {
  if (frames.length) return Promise.resolve(frames.shift());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("tool host response timed out: " + diagnostics)), 5000);
    waiters.push(value => { clearTimeout(timer); resolve(value); });
  });
}
function requireValue(condition, message, value) {
  if (!condition) throw new Error(message + ": " + JSON.stringify(value));
}
(async () => {
  send({ type: "connection/hello", supportedVersions: [1], requiredCapabilities: [], optionalCapabilities: [] });
  let value = await next();
  requireValue(value.type === "connection/ready", "expected connection/ready", value);
  send({ type: "operation/request", id: 1, request: { method: "session/open", sessionId: "preflight" } });
  value = await next();
  requireValue(value.type === "operation/response" && value.id === 1 && value.result?.status === "ok" && value.result?.value?.type === "session/ready", "expected session/ready", value);
  send({ type: "operation/request", id: 2, request: { method: "session/execute", sessionId: "preflight", request: { tool_call_id: "probe", enabled_tools: [], source: 'text("CODEX_AB_TOOL_HOST_OK")', yield_time_ms: 1000, max_output_tokens: 1000 } } });
  let started = false; let initial = false;
  while (!started || !initial) {
    value = await next();
    if (value.type === "operation/response" && value.id === 2) {
      requireValue(value.result?.status === "ok" && value.result?.value?.type === "execution/started", "expected execution/started", value);
      started = true;
    } else if (value.type === "execute/initialResponse" && value.id === 2) {
      requireValue(value.result?.status === "ok" && JSON.stringify(value.result.value).includes("CODEX_AB_TOOL_HOST_OK"), "expected marker in execute response", value);
      initial = true;
    }
  }
  send({ type: "operation/request", id: 3, request: { method: "session/shutdown", sessionId: "preflight" } });
  do { value = await next(); } while (!(value.type === "operation/response" && value.id === 3));
  requireValue(value.type === "operation/response" && value.id === 3 && value.result?.status === "ok" && value.result?.value?.type === "session/closed", "expected session/closed", value);
  host.stdin.end();
  const exit = await hostExit;
  requireValue(exit.code === 0, "tool host exited unsuccessfully", { exit, diagnostics });
  process.stdout.write("CODEX_AB_TOOL_HOST_OK\n");
})().catch(error => { host.kill("SIGKILL"); process.stderr.write(String(error.stack || error) + "\n"); process.exitCode = 1; });
`;
