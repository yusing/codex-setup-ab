import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildNetworkPolicy,
  createEgressProxyServer,
  defaultAllowedHosts,
  EGRESS_PROXY_SCRIPT,
  egressProxyEnv,
  evaluateEgressTarget,
  isRawIpLiteral,
  normalizeAllowlistHost,
  parseConnectAuthority,
  parseEgressAllowlist,
  parseNetworkPolicyMode,
} from "./egress-proxy";

let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "codex-ab-egress-proxy-test-"));
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") reject(new Error("expected TCP address"));
      else resolve(addr.port);
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

function rawConnect(proxyPort: number, authority: string, payload?: string): Promise<{ statusLine: string; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, "127.0.0.1", () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
    let buffer = "";
    let established = false;
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      buffer += chunk;
      if (!established && buffer.includes("\r\n\r\n")) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        const statusLine = buffer.slice(0, buffer.indexOf("\r\n"));
        if (statusLine.includes("200") && payload) {
          established = true;
          buffer = buffer.slice(headerEnd + 4);
          socket.write(payload);
        }
      }
    });
    socket.on("end", () => {
      if (established) {
        resolve({ statusLine: "HTTP/1.1 200 Connection Established", body: buffer });
      } else {
        const idx = buffer.indexOf("\r\n");
        const headerEnd = buffer.indexOf("\r\n\r\n");
        resolve({
          statusLine: idx >= 0 ? buffer.slice(0, idx) : buffer,
          body: headerEnd >= 0 ? buffer.slice(headerEnd + 4) : "",
        });
      }
    });
    socket.on("error", reject);
  });
}

function rawHttpProxyRequest(proxyPort: number, targetUrl: string, hostHeader?: string): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port: proxyPort,
      method: "GET",
      path: targetUrl,
      headers: hostHeader ? { Host: hostHeader } : undefined,
    }, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("allowlist matcher enforces exact hosts, case-insensitivity, port rules, and rejects spoofing and raw IPs", () => {
  const config = { allowedHosts: defaultAllowedHosts() };

  expect(evaluateEgressTarget({ host: "chatgpt.com", port: 443, method: "CONNECT" }, config)).toEqual({
    allowed: true, host: "chatgpt.com", port: 443,
  });
  expect(evaluateEgressTarget({ host: "API.OPENAI.COM", port: 443, method: "CONNECT" }, config)).toEqual({
    allowed: true, host: "api.openai.com", port: 443,
  });
  expect(evaluateEgressTarget({ host: "auth.openai.com.", port: 443, method: "CONNECT" }, config)).toEqual({
    allowed: true, host: "auth.openai.com", port: 443,
  });

  // Subdomain and suffix spoofing must be denied
  for (const spoofed of ["evilchatgpt.com", "chatgpt.com.evil.com", "sub.chatgpt.com", "github.com", "pypi.org", "registry.npmjs.org"]) {
    const decision = evaluateEgressTarget({ host: spoofed, port: 443, method: "CONNECT" }, config);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe("host-not-allowlisted");
  }

  // Non-allowlisted port must be denied
  const badPort = evaluateEgressTarget({ host: "chatgpt.com", port: 8443, method: "CONNECT" }, config);
  expect(badPort).toEqual({ allowed: false, host: "chatgpt.com", port: 8443, reason: "port-not-allowlisted" });

  // Raw IPv4, IPv6, and non-canonical numeric IP literals must be denied unless explicitly allowlisted
  for (const ip of ["127.0.0.1", "1.1.1.1", "::1", "[2001:db8::1]", "2130706433", "0177.0.0.1", "0x7f.0.0.1", "127.1"]) {
    expect(isRawIpLiteral(ip)).toBe(true);
    const decision = evaluateEgressTarget({ host: ip, port: 443, method: "CONNECT" }, config);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe("raw-ip-not-allowlisted");
  }

  // Explicitly allowlisted IP literal is permitted
  const explicitIp = evaluateEgressTarget(
    { host: "127.0.0.1", port: 443, method: "CONNECT" },
    { allowedHosts: ["127.0.0.1"] },
  );
  expect(explicitIp).toEqual({ allowed: true, host: "127.0.0.1", port: 443 });
});

test("policy builders and parsers handle Codex, Grok, custom allowlists, and invalid inputs", () => {
  expect(buildNetworkPolicy({ comparison: "stock-current" })).toEqual({
    schema: "codex-ab.network-policy.v1",
    candidate: "provider-allowlist-proxy",
    closed_book: true,
    allowed_hosts: ["chatgpt.com", "api.openai.com", "auth.openai.com"],
    arm_connectivity: "separate-docker-networks",
    evaluator: "offline",
    judge: "provider-network-source-reader",
  });

  const grokPolicy = buildNetworkPolicy({ comparison: "codex-mekugi-grok", extraAllowedHosts: ["Custom.Example.COM"] });
  expect(grokPolicy.closed_book).toBe(true);
  if (grokPolicy.closed_book) {
    expect(grokPolicy.allowed_hosts).toEqual([
      "chatgpt.com", "api.openai.com", "auth.openai.com",
      "cli-chat-proxy.grok.com", "api.x.ai", "custom.example.com",
    ]);
  }

  expect(buildNetworkPolicy({ mode: "online-unrestricted" })).toEqual({
    schema: "codex-ab.network-policy.v1",
    candidate: "online-unrestricted",
    closed_book: false,
    arm_connectivity: "separate-docker-networks",
    evaluator: "offline",
    judge: "provider-network-source-reader",
  });

  expect(() => buildNetworkPolicy({ mode: "online-unrestricted", extraAllowedHosts: ["example.com"] })).toThrow("--egress-allowlist");
  expect(parseNetworkPolicyMode("closed-book")).toBe("closed-book");
  expect(parseNetworkPolicyMode("online-unrestricted")).toBe("online-unrestricted");
  expect(() => parseNetworkPolicyMode("offline")).toThrow("--network-policy");
  expect(parseEgressAllowlist("Example.com, api.example.com, example.com.")).toEqual(["example.com", "api.example.com"]);
  expect(() => normalizeAllowlistHost("https://chatgpt.com")).toThrow();
  expect(() => normalizeAllowlistHost("*.openai.com")).toThrow();
  expect(() => normalizeAllowlistHost("chatgpt.com:443")).toThrow();
  expect(parseConnectAuthority("chatgpt.com:443")).toEqual({ host: "chatgpt.com", port: 443 });
  expect(parseConnectAuthority("[::1]:443")).toEqual({ host: "::1", port: 443 });
  expect(parseConnectAuthority("chatgpt.com@evil.com:443")).toBeNull();
  expect(parseConnectAuthority("chatgpt.com")).toBeNull();
  expect(egressProxyEnv()).toContain("HTTPS_PROXY=http://egress-proxy:3128");
  expect(egressProxyEnv()).toContain("NO_PROXY=localhost,127.0.0.1,::1");
});

test("live loopback proxy tunnels allowlisted CONNECT/HTTP targets and denies non-allowlisted hosts with JSONL audit log", async () => {
  const targetServer = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain", Connection: "close" });
    res.end(`target-ok:${req.url}`);
  });
  const targetPort = await listen(targetServer);
  const deniedLogPath = join(tempDir, "in-process-denied.jsonl");
  const proxyServer = createEgressProxyServer({
    allowedHosts: ["localhost"],
    allowedConnectPorts: [targetPort],
    allowedHttpPorts: [targetPort],
    deniedLogPath,
  });
  const proxyPort = await listen(proxyServer);

  try {
    // Allowlisted CONNECT succeeds and tunnels HTTP traffic
    const tunneled = await rawConnect(
      proxyPort,
      `localhost:${targetPort}`,
      `GET /via-connect HTTP/1.1\r\nHost: localhost:${targetPort}\r\nConnection: close\r\n\r\n`,
    );
    expect(tunneled.statusLine).toContain("200");
    expect(tunneled.body).toContain("target-ok:/via-connect");

    // Allowlisted plain HTTP proxy request succeeds
    const httpOk = await rawHttpProxyRequest(proxyPort, `http://localhost:${targetPort}/via-http`);
    expect(httpOk.statusCode).toBe(200);
    expect(httpOk.body).toBe("target-ok:/via-http");

    // Non-allowlisted CONNECT is rejected with 403 Forbidden
    const deniedConnect = await rawConnect(proxyPort, `github.com:${targetPort}`);
    expect(deniedConnect.statusLine).toContain("403 Forbidden");

    // Raw IP literal CONNECT is rejected with 403 Forbidden when not explicitly allowlisted
    const deniedIp = await rawConnect(proxyPort, `127.0.0.1:${targetPort}`);
    expect(deniedIp.statusLine).toContain("403 Forbidden");

    // Plain HTTP request with spoofed Host header targeting non-allowlisted URI is rejected
    const deniedHttp = await rawHttpProxyRequest(proxyPort, `http://pypi.org:${targetPort}/simple/`, "localhost");
    expect(deniedHttp.statusCode).toBe(403);

    const lines = (await readFile(deniedLogPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ method: "CONNECT", host: "github.com", port: targetPort, reason: "host-not-allowlisted" });
    expect(lines[1]).toMatchObject({ method: "CONNECT", host: "127.0.0.1", port: targetPort, reason: "raw-ip-not-allowlisted" });
    expect(lines[2]).toMatchObject({ method: "GET", host: "pypi.org", port: targetPort, reason: "host-not-allowlisted" });
  } finally {
    await close(proxyServer);
    await close(targetServer);
  }
});

test("container proxy script runs under bun -e, signals readiness, tunnels allowed targets, and logs denials", async () => {
  const targetServer = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain", Connection: "close" });
    res.end("script-target-ok");
  });
  const targetPort = await listen(targetServer);
  // Pick an ephemeral free port for the child proxy
  const probeServer = http.createServer();
  const proxyPort = await listen(probeServer);
  await close(probeServer);

  const readyFile = join(tempDir, "script-ready");
  const deniedLogPath = join(tempDir, "script-denied.jsonl");
  const child = Bun.spawn([
    process.execPath, "-e", EGRESS_PROXY_SCRIPT,
    JSON.stringify({
      port: proxyPort,
      allowedHosts: ["localhost"],
      allowedConnectPorts: [targetPort],
      allowedHttpPorts: [targetPort],
      deniedLogPath,
      readyFile,
    }),
  ], { stdout: "pipe", stderr: "pipe" });

  try {
    const deadline = Date.now() + 5_000;
    while (!(await Bun.file(readyFile).exists())) {
      if (Date.now() > deadline) throw new Error("proxy script did not become ready");
      await Bun.sleep(25);
    }
    const ok = await rawConnect(
      proxyPort,
      `localhost:${targetPort}`,
      `GET /ping HTTP/1.1\r\nHost: localhost:${targetPort}\r\nConnection: close\r\n\r\n`,
    );
    expect(ok.statusLine).toContain("200");
    expect(ok.body).toContain("script-target-ok");

    const denied = await rawConnect(proxyPort, `registry.npmjs.org:${targetPort}`);
    expect(denied.statusLine).toContain("403 Forbidden");

    const records = (await readFile(deniedLogPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      method: "CONNECT",
      host: "registry.npmjs.org",
      port: targetPort,
      reason: "host-not-allowlisted",
    });
  } finally {
    child.kill("SIGTERM");
    await child.exited;
    await close(targetServer);
  }
});
