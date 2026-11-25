const FRAMED_SMOKE_SCRIPT = String.raw`
const { spawn } = require("node:child_process");
const host = spawn(program, ["--listen", "stdio"], { stdio: ["pipe", "pipe", "pipe"] });
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

// The current host serves HTTP/2 over its stdio pipes. Encode only the fields
// used by OpenSession, Execute and CloseSession (codex.code_mode.v1).
const GRPC_SMOKE_SCRIPT = String.raw`
const { spawn } = require("node:child_process");
const { connect } = require("node:http2");
const { Duplex } = require("node:stream");
const { once } = require("node:events");
const host = spawn(program, ["--listen", "grpc+stdio://"], {
  stdio: ["pipe", "pipe", "inherit"],
});
const hostExit = once(host, "close");
const client = connect("http://localhost", {
  createConnection: () => Duplex.from({ readable: host.stdout, writable: host.stdin }),
});
const timer = setTimeout(() => fail(Error("tool host gRPC smoke timed out")), 5000);
function fail(error) {
  clearTimeout(timer);
  process.exitCode = 1;
  process.stderr.write(String(error.stack || error) + "\n");
  client.destroy();
  host.kill("SIGKILL");
}
client.on("error", fail);

function textField(number, text) {
  const bytes = Buffer.from(text);
  if (bytes.length >= 128) throw Error("oversized tool host probe field");
  return Buffer.concat([Buffer.from([number * 8 + 2, bytes.length]), bytes]);
}
function bytesFields(message, field) {
  let offset = 0;
  function varint() {
    let value = 0;
    let scale = 1;
    while (offset < message.length) {
      const byte = message[offset++];
      value += (byte & 127) * scale;
      if (byte < 128) return value;
      scale *= 128;
    }
    throw Error("truncated tool host protobuf varint");
  }
  const matches = [];
  while (offset < message.length) {
    const tag = varint();
    if (tag % 8 === 0) { varint(); continue; }
    if (tag % 8 !== 2) throw Error("unexpected tool host protobuf wire type");
    const size = varint();
    const end = offset + size;
    if (end > message.length) throw Error("truncated tool host protobuf field");
    if (tag === field * 8 + 2) matches.push(message.subarray(offset, end));
    offset = end;
  }
  return matches;
}
function call(method, ...fields) {
  const request = client.request({
    ":method": "POST",
    ":path": "/codex.code_mode.v1.CodeModeHost/" + method,
    "content-type": "application/grpc", te: "trailers",
  });
  const body = Buffer.concat(fields);
  const header = Buffer.alloc(5);
  header.writeUInt32BE(body.length, 1);
  request.end(Buffer.concat([header, body]));
  return request;
}
async function* messages(request) {
  let status;
  const readStatus = headers => { status = headers["grpc-status"]; };
  request.on("response", readStatus).on("trailers", readStatus);
  let pending = Buffer.alloc(0);
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 5 && pending.length >= 5 + pending.readUInt32BE(1)) {
      if (pending[0] !== 0) throw Error("unexpected compressed tool host gRPC response");
      const end = 5 + pending.readUInt32BE(1);
      yield pending.subarray(5, end);
      pending = pending.subarray(end);
    }
  }
  if (status !== "0" || pending.length) throw Error("invalid tool host gRPC response, status: " + status);
}

(async () => {
  // Keep the streaming session lease open until the explicit CloseSession.
  const session = call("OpenSession");
  const events = messages(session);
  const { value: opened } = await events.next();
  const sessionOpened = opened && bytesFields(opened, 1)[0];
  const sessionId = sessionOpened && bytesFields(sessionOpened, 1)[0]?.toString();
  if (!sessionId) throw Error("expected tool host SessionOpened");

  const id = textField(1, sessionId);
  const marker = "CODEX_AB_TOOL_HOST_OK";
  const execution = call("Execute", id, textField(2, "smoke"), textField(3, "probe"),
    textField(4, 'text("' + marker + '")'));
  let started = false;
  let completed = false;
  for await (const event of messages(execution)) {
    if (bytesFields(event, 1).length) started = true;
    for (const outcome of bytesFields(event, 2)) {
      const [completion] = bytesFields(outcome, 5);
      completed = Boolean(completion && !bytesFields(completion, 1).length &&
        bytesFields(outcome, 2).some(item => {
          const [text] = bytesFields(item, 1);
          return text && bytesFields(text, 1)[0]?.toString() === marker;
        }));
    }
  }
  if (!started || !completed) {
    throw Error("expected tool host execution to complete with marker");
  }
  for await (const _ of messages(call("CloseSession", id))) {}
  for await (const _ of events) {} // Drain the lease through its final status.
  client.close();
  const [exit] = await hostExit;
  if (exit !== 0) throw Error("tool host exited unsuccessfully: " + exit);
  clearTimeout(timer);
  process.stdout.write(marker + "\n");
})().catch(fail);
`;

/** Exercise the host's default stdio protocol without model or API access. */
export const TOOLHOST_SMOKE_SCRIPT = String.raw`
const { execFileSync } = require("node:child_process");
const program = process.env.CODEX_CODE_MODE_HOST || "/usr/local/bin/codex-code-mode-host";
const help = execFileSync(program, ["--help"], {
  encoding: "utf8", timeout: 5000, killSignal: "SIGKILL",
});
if (help.includes("[default: grpc+stdio://]")) {
${GRPC_SMOKE_SCRIPT}
} else {
${FRAMED_SMOKE_SCRIPT}
}
`;
