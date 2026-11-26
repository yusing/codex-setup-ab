import { appendFileSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import net, { isIP } from "node:net";
import { dirname, join } from "node:path";
import { startOwnedSidecar, type OwnedSidecar } from "./container";
import type { Comparison, NetworkPolicy, NetworkPolicyMode } from "./types";

export const DEFAULT_CODEX_PROVIDER_HOSTS = [
  "chatgpt.com",
  "api.openai.com",
  "auth.openai.com",
] as const;

export const DEFAULT_GROK_PROVIDER_HOSTS = [
  "cli-chat-proxy.grok.com",
  "api.x.ai",
] as const;

export const DEFAULT_ALLOWED_CONNECT_PORTS = [443] as const;
export const DEFAULT_ALLOWED_HTTP_PORTS = [80, 443] as const;
export const EGRESS_PROXY_ALIAS = "egress-proxy";
export const EGRESS_PROXY_PORT = 3128;

const DNS_HOSTNAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const NUMERIC_LABEL_PATTERN = /^(?:\d+|0x[0-9a-f]+)$/i;

export interface EgressAllowlistConfig {
  allowedHosts: readonly string[];
  allowedConnectPorts?: readonly number[];
  allowedHttpPorts?: readonly number[];
}

export interface EgressTarget {
  host: string;
  port: number;
  method: string;
}

export type EgressDecision =
  | { allowed: true; host: string; port: number }
  | { allowed: false; host: string; port: number; reason: string };

export interface EgressDeniedRecord {
  timestamp: string;
  method: string;
  host: string;
  port: number;
  reason: string;
}

export interface EgressProxyServerOptions extends EgressAllowlistConfig {
  deniedLogPath?: string;
  connectTimeoutMs?: number;
}

export interface EgressProxySidecarOptions {
  docker: string;
  name: string;
  image: string;
  providerNetwork: string;
  candidateInternalNetwork: string;
  allowedHosts: readonly string[];
  allowedConnectPorts?: readonly number[];
  allowedHttpPorts?: readonly number[];
  auditDir: string;
  proxyAlias?: string;
  proxyPort?: number;
  signal?: AbortSignal;
}

export interface EgressProxySidecar extends OwnedSidecar {
  proxyUrl: string;
  envArgs: string[];
}

export function defaultAllowedHosts(comparison?: Comparison): string[] {
  return comparison === "codex-mekugi-grok"
    ? [...DEFAULT_CODEX_PROVIDER_HOSTS, ...DEFAULT_GROK_PROVIDER_HOSTS]
    : [...DEFAULT_CODEX_PROVIDER_HOSTS];
}

function stripSingleTrailingDot(host: string): string {
  return host.endsWith(".") && !host.endsWith("..") ? host.slice(0, -1) : host;
}

function unwrapHost(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1);
  }
  return stripSingleTrailingDot(trimmed);
}

/** Detect canonical IPv4/IPv6 literals as well as non-canonical numeric IPv4 forms (decimal, octal, hex, shorthand). */
export function isRawIpLiteral(host: string): boolean {
  const normalized = unwrapHost(host);
  if (!normalized) return false;
  if (isIP(normalized) !== 0) return true;
  if (normalized.includes(":")) return true;
  const labels = normalized.split(".");
  if (labels.length >= 1 && labels.length <= 4 && labels.every(label => NUMERIC_LABEL_PATTERN.test(label))) {
    return true;
  }
  return false;
}

export function normalizeAllowlistHost(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || /[\s/?#@*]/.test(trimmed)) {
    throw new Error(`invalid egress allowlist host: ${JSON.stringify(raw)}`);
  }
  const unwrapped = unwrapHost(trimmed);
  if (!unwrapped) throw new Error(`invalid egress allowlist host: ${JSON.stringify(raw)}`);
  if (isIP(unwrapped) !== 0) return unwrapped;
  if (unwrapped.includes(":")) {
    throw new Error(`invalid egress allowlist host (include hostname only, without port): ${JSON.stringify(raw)}`);
  }
  if (isRawIpLiteral(unwrapped)) {
    throw new Error(`invalid egress allowlist IP literal (use canonical IPv4 or IPv6): ${JSON.stringify(raw)}`);
  }
  if (!DNS_HOSTNAME_PATTERN.test(unwrapped)) {
    throw new Error(`invalid egress allowlist host: ${JSON.stringify(raw)}`);
  }
  return unwrapped;
}

export function parseEgressAllowlist(raw: string): string[] {
  const parts = raw.split(",");
  if (parts.length === 0 || parts.some(part => !part.trim())) {
    throw new Error("--egress-allowlist must be a non-empty comma-separated list of hostnames");
  }
  const normalized = parts.map(normalizeAllowlistHost);
  return [...new Set(normalized)];
}

export function parseNetworkPolicyMode(raw: string): NetworkPolicyMode {
  if (raw === "closed-book" || raw === "online-unrestricted") return raw;
  throw new Error(`--network-policy must be closed-book or online-unrestricted (got ${JSON.stringify(raw)})`);
}

export function buildNetworkPolicy(options: {
  mode?: NetworkPolicyMode;
  comparison?: Comparison;
  extraAllowedHosts?: readonly string[];
}): NetworkPolicy {
  const mode = options.mode ?? "closed-book";
  if (mode === "online-unrestricted") {
    if (options.extraAllowedHosts?.length) {
      throw new Error("--egress-allowlist cannot be used with --network-policy online-unrestricted");
    }
    return {
      schema: "codex-ab.network-policy.v1",
      candidate: "online-unrestricted",
      closed_book: false,
      arm_connectivity: "separate-docker-networks",
      evaluator: "offline",
      judge: "provider-network-source-reader",
    };
  }
  const allowedHosts = [...new Set([
    ...defaultAllowedHosts(options.comparison),
    ...(options.extraAllowedHosts ?? []).map(normalizeAllowlistHost),
  ])];
  return {
    schema: "codex-ab.network-policy.v1",
    candidate: "provider-allowlist-proxy",
    closed_book: true,
    allowed_hosts: allowedHosts,
    arm_connectivity: "separate-docker-networks",
    evaluator: "offline",
    judge: "provider-network-source-reader",
  };
}

export function parseConnectAuthority(authority: string): { host: string; port: number } | null {
  if (!authority || /[\s/?#@]/.test(authority)) return null;
  let host: string;
  let portText: string;
  if (authority.startsWith("[")) {
    const closing = authority.indexOf("]");
    if (closing < 2 || authority[closing + 1] !== ":") return null;
    host = authority.slice(1, closing);
    portText = authority.slice(closing + 2);
  } else {
    const colon = authority.lastIndexOf(":");
    if (colon <= 0 || authority.indexOf(":") !== colon) return null;
    host = authority.slice(0, colon);
    portText = authority.slice(colon + 1);
  }
  if (!/^[1-9]\d{0,4}$/.test(portText)) return null;
  const port = Number(portText);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

export function evaluateEgressTarget(target: EgressTarget, config: EgressAllowlistConfig): EgressDecision {
  const method = target.method.toUpperCase();
  const host = unwrapHost(target.host);
  const port = target.port;
  if (!host || /[\s/?#@*]/.test(host)) {
    return { allowed: false, host, port, reason: "invalid-host" };
  }
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    return { allowed: false, host, port, reason: "invalid-port" };
  }
  const allowedPorts = method === "CONNECT"
    ? (config.allowedConnectPorts ?? DEFAULT_ALLOWED_CONNECT_PORTS)
    : (config.allowedHttpPorts ?? DEFAULT_ALLOWED_HTTP_PORTS);
  if (!allowedPorts.includes(port)) {
    return { allowed: false, host, port, reason: "port-not-allowlisted" };
  }
  const allowedSet = new Set(config.allowedHosts.map(item => unwrapHost(item)));
  if (isRawIpLiteral(host)) {
    if (allowedSet.has(host)) return { allowed: true, host, port };
    return { allowed: false, host, port, reason: "raw-ip-not-allowlisted" };
  }
  if (!DNS_HOSTNAME_PATTERN.test(host)) {
    return { allowed: false, host, port, reason: "invalid-host" };
  }
  if (!allowedSet.has(host)) {
    return { allowed: false, host, port, reason: "host-not-allowlisted" };
  }
  return { allowed: true, host, port };
}

function recordDenied(deniedLogPath: string | undefined, record: EgressDeniedRecord): void {
  if (!deniedLogPath) return;
  mkdirSync(dirname(deniedLogPath), { recursive: true });
  appendFileSync(deniedLogPath, `${JSON.stringify(record)}\n`, "utf8");
}

/** Build an HTTP/HTTPS CONNECT allowlisting proxy server for in-process testing or direct hosting. */
export function createEgressProxyServer(options: EgressProxyServerOptions): http.Server {
  const connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
  const server = http.createServer((req, res) => {
    const method = (req.method ?? "GET").toUpperCase();
    const rawUrl = req.url ?? "";
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain", Connection: "close" });
      res.end("Bad proxy request\n");
      return;
    }
    if (parsed.protocol !== "http:" || parsed.username || parsed.password) {
      recordDenied(options.deniedLogPath, {
        timestamp: new Date().toISOString(),
        method,
        host: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : 80,
        reason: parsed.protocol !== "http:" ? "unsupported-scheme" : "userinfo-not-allowed",
      });
      res.writeHead(403, { "Content-Type": "text/plain", Connection: "close" });
      res.end("Egress denied\n");
      return;
    }
    const port = parsed.port ? Number(parsed.port) : 80;
    const decision = evaluateEgressTarget({ host: parsed.hostname, port, method }, options);
    if (!decision.allowed) {
      recordDenied(options.deniedLogPath, {
        timestamp: new Date().toISOString(),
        method,
        host: decision.host,
        port: decision.port,
        reason: decision.reason,
      });
      res.writeHead(403, { "Content-Type": "text/plain", Connection: "close" });
      res.end(`Egress denied: ${decision.reason}\n`);
      return;
    }
    const headers: http.OutgoingHttpHeaders = { ...req.headers };
    delete headers["proxy-connection"];
    delete headers["proxy-authorization"];
    headers.host = parsed.host;
    const upstream = http.request({
      host: decision.host,
      port: decision.port,
      method,
      path: `${parsed.pathname}${parsed.search}`,
      headers,
      timeout: connectTimeoutMs,
    }, upstreamRes => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    });
    upstream.on("timeout", () => upstream.destroy(new Error("upstream timeout")));
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain", Connection: "close" });
      res.end("Bad Gateway\n");
    });
    req.pipe(upstream);
  });

  server.on("connect", (req, clientSocket, head) => {
    const parsed = parseConnectAuthority(req.url ?? "");
    if (!parsed) {
      clientSocket.end("HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nInvalid CONNECT authority\n");
      return;
    }
    const decision = evaluateEgressTarget({ host: parsed.host, port: parsed.port, method: "CONNECT" }, options);
    if (!decision.allowed) {
      recordDenied(options.deniedLogPath, {
        timestamp: new Date().toISOString(),
        method: "CONNECT",
        host: decision.host,
        port: decision.port,
        reason: decision.reason,
      });
      clientSocket.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nEgress denied: ${decision.reason}\n`);
      return;
    }
    const upstream = net.connect({ host: decision.host, port: decision.port });
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) upstream.destroy(new Error("connect timeout"));
    }, connectTimeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      if (!clientSocket.destroyed) clientSocket.destroy();
      if (!upstream.destroyed) upstream.destroy();
    };
    upstream.once("connect", () => {
      settled = true;
      clearTimeout(timer);
      if (clientSocket.destroyed) {
        upstream.destroy();
        return;
      }
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => {
      clearTimeout(timer);
      if (!settled && !clientSocket.destroyed) {
        clientSocket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nBad Gateway\n");
      } else {
        cleanup();
      }
    });
    clientSocket.on("error", cleanup);
    clientSocket.on("close", () => {
      clearTimeout(timer);
      if (!upstream.destroyed) upstream.destroy();
    });
  });

  return server;
}

export function egressProxyEnv(proxyAlias = EGRESS_PROXY_ALIAS, proxyPort = EGRESS_PROXY_PORT): string[] {
  const proxyUrl = `http://${proxyAlias}:${proxyPort}`;
  return [
    "-e", `HTTP_PROXY=${proxyUrl}`,
    "-e", `HTTPS_PROXY=${proxyUrl}`,
    "-e", `http_proxy=${proxyUrl}`,
    "-e", `https_proxy=${proxyUrl}`,
    "-e", "NO_PROXY=localhost,127.0.0.1,::1",
    "-e", "no_proxy=localhost,127.0.0.1,::1",
  ];
}

/** Self-contained proxy runtime script executed inside the locked-down sidecar container via bun -e. */
export const EGRESS_PROXY_SCRIPT = `
const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");

const config = JSON.parse(process.argv[1] || "{}");
const port = Number(config.port || 3128);
const allowedConnectPorts = Array.isArray(config.allowedConnectPorts) ? config.allowedConnectPorts : [443];
const allowedHttpPorts = Array.isArray(config.allowedHttpPorts) ? config.allowedHttpPorts : [80, 443];
const deniedLogPath = typeof config.deniedLogPath === "string" ? config.deniedLogPath : "";
const readyFile = typeof config.readyFile === "string" ? config.readyFile : "";
const connectTimeoutMs = Number(config.connectTimeoutMs || 15000);
const dnsPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const numericLabel = /^(?:\\d+|0x[0-9a-f]+)$/i;

function unwrapHost(raw) {
  const trimmed = String(raw || "").trim().toLowerCase();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed.slice(1, -1);
  return trimmed.endsWith(".") && !trimmed.endsWith("..") ? trimmed.slice(0, -1) : trimmed;
}

function isRawIpLiteral(host) {
  const normalized = unwrapHost(host);
  if (!normalized) return false;
  if (net.isIP(normalized) !== 0) return true;
  if (normalized.includes(":")) return true;
  const labels = normalized.split(".");
  return labels.length >= 1 && labels.length <= 4 && labels.every(l => numericLabel.test(l));
}

const allowedSet = new Set((config.allowedHosts || []).map(unwrapHost));

function evaluate(hostRaw, targetPort, method) {
  const host = unwrapHost(hostRaw);
  if (!host || /[\\s/?#@*]/.test(host)) return { allowed: false, host, port: targetPort, reason: "invalid-host" };
  if (!Number.isSafeInteger(targetPort) || targetPort < 1 || targetPort > 65535) return { allowed: false, host, port: targetPort, reason: "invalid-port" };
  const ports = method === "CONNECT" ? allowedConnectPorts : allowedHttpPorts;
  if (!ports.includes(targetPort)) return { allowed: false, host, port: targetPort, reason: "port-not-allowlisted" };
  if (isRawIpLiteral(host)) {
    return allowedSet.has(host) ? { allowed: true, host, port: targetPort } : { allowed: false, host, port: targetPort, reason: "raw-ip-not-allowlisted" };
  }
  if (!dnsPattern.test(host)) return { allowed: false, host, port: targetPort, reason: "invalid-host" };
  if (!allowedSet.has(host)) return { allowed: false, host, port: targetPort, reason: "host-not-allowlisted" };
  return { allowed: true, host, port: targetPort };
}

function parseConnectAuthority(authority) {
  if (!authority || /[\\s/?#@]/.test(authority)) return null;
  let host, portText;
  if (authority.startsWith("[")) {
    const closing = authority.indexOf("]");
    if (closing < 2 || authority[closing + 1] !== ":") return null;
    host = authority.slice(1, closing);
    portText = authority.slice(closing + 2);
  } else {
    const colon = authority.lastIndexOf(":");
    if (colon <= 0 || authority.indexOf(":") !== colon) return null;
    host = authority.slice(0, colon);
    portText = authority.slice(colon + 1);
  }
  if (!/^[1-9]\\d{0,4}$/.test(portText)) return null;
  const targetPort = Number(portText);
  if (!Number.isSafeInteger(targetPort) || targetPort < 1 || targetPort > 65535) return null;
  return { host, port: targetPort };
}

function logDenied(method, host, targetPort, reason) {
  if (!deniedLogPath) return;
  try {
    fs.mkdirSync(path.dirname(deniedLogPath), { recursive: true });
    fs.appendFileSync(deniedLogPath, JSON.stringify({
      timestamp: new Date().toISOString(), method, host, port: targetPort, reason,
    }) + "\\n", "utf8");
  } catch {}
}

const server = http.createServer((req, res) => {
  const method = (req.method || "GET").toUpperCase();
  let parsed;
  try { parsed = new URL(req.url || ""); }
  catch {
    res.writeHead(400, { "Content-Type": "text/plain", Connection: "close" });
    res.end("Bad proxy request\\n");
    return;
  }
  if (parsed.protocol !== "http:" || parsed.username || parsed.password) {
    logDenied(method, parsed.hostname, parsed.port ? Number(parsed.port) : 80, parsed.protocol !== "http:" ? "unsupported-scheme" : "userinfo-not-allowed");
    res.writeHead(403, { "Content-Type": "text/plain", Connection: "close" });
    res.end("Egress denied\\n");
    return;
  }
  const targetPort = parsed.port ? Number(parsed.port) : 80;
  const decision = evaluate(parsed.hostname, targetPort, method);
  if (!decision.allowed) {
    logDenied(method, decision.host, decision.port, decision.reason);
    res.writeHead(403, { "Content-Type": "text/plain", Connection: "close" });
    res.end("Egress denied: " + decision.reason + "\\n");
    return;
  }
  const headers = { ...req.headers };
  delete headers["proxy-connection"];
  delete headers["proxy-authorization"];
  headers.host = parsed.host;
  const upstream = http.request({
    host: decision.host,
    port: decision.port,
    method,
    path: parsed.pathname + parsed.search,
    headers,
    timeout: connectTimeoutMs,
  }, upstreamRes => {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });
  upstream.on("timeout", () => upstream.destroy(new Error("upstream timeout")));
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain", Connection: "close" });
    res.end("Bad Gateway\\n");
  });
  req.pipe(upstream);
});

server.on("connect", (req, clientSocket, head) => {
  const parsed = parseConnectAuthority(req.url || "");
  if (!parsed) {
    clientSocket.end("HTTP/1.1 400 Bad Request\\r\\nContent-Type: text/plain\\r\\nConnection: close\\r\\n\\r\\nInvalid CONNECT authority\\n");
    return;
  }
  const decision = evaluate(parsed.host, parsed.port, "CONNECT");
  if (!decision.allowed) {
    logDenied("CONNECT", decision.host, decision.port, decision.reason);
    clientSocket.end("HTTP/1.1 403 Forbidden\\r\\nContent-Type: text/plain\\r\\nConnection: close\\r\\n\\r\\nEgress denied: " + decision.reason + "\\n");
    return;
  }
  const upstream = net.connect({ host: decision.host, port: decision.port });
  let settled = false;
  const timer = setTimeout(() => { if (!settled) upstream.destroy(new Error("connect timeout")); }, connectTimeoutMs);
  const cleanup = () => {
    clearTimeout(timer);
    if (!clientSocket.destroyed) clientSocket.destroy();
    if (!upstream.destroyed) upstream.destroy();
  };
  upstream.once("connect", () => {
    settled = true;
    clearTimeout(timer);
    if (clientSocket.destroyed) { upstream.destroy(); return; }
    clientSocket.write("HTTP/1.1 200 Connection Established\\r\\n\\r\\n");
    if (head.length > 0) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.on("error", () => {
    clearTimeout(timer);
    if (!settled && !clientSocket.destroyed) {
      clientSocket.end("HTTP/1.1 502 Bad Gateway\\r\\nContent-Type: text/plain\\r\\nConnection: close\\r\\n\\r\\nBad Gateway\\n");
    } else {
      cleanup();
    }
  });
  clientSocket.on("error", cleanup);
  clientSocket.on("close", () => { clearTimeout(timer); if (!upstream.destroyed) upstream.destroy(); });
});

server.listen(port, () => {
  if (readyFile) {
    fs.mkdirSync(path.dirname(readyFile), { recursive: true });
    fs.writeFileSync(readyFile, "ready\\n", "utf8");
  }
});

const shutdown = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
`.trim();

/** Launch a locked-down sidecar proxy bridging providerNetwork (external) and candidateInternalNetwork (--internal). */
export async function startEgressProxySidecar(options: EgressProxySidecarOptions): Promise<EgressProxySidecar> {
  const proxyAlias = options.proxyAlias ?? EGRESS_PROXY_ALIAS;
  const proxyPort = options.proxyPort ?? EGRESS_PROXY_PORT;
  const readyDir = await mkdtemp(join("/var/tmp", "codex-ab-egress-ready-"));
  const hostReadyFile = join(readyDir, "ready");
  const containerConfig = {
    port: proxyPort,
    allowedHosts: options.allowedHosts,
    allowedConnectPorts: options.allowedConnectPorts ?? [...DEFAULT_ALLOWED_CONNECT_PORTS],
    allowedHttpPorts: options.allowedHttpPorts ?? [...DEFAULT_ALLOWED_HTTP_PORTS],
    deniedLogPath: "/proxy-audit/egress-denied.jsonl",
    readyFile: "/proxy-ready/ready",
  };
  try {
    const sidecar = await startOwnedSidecar({
      docker: options.docker,
      name: options.name,
      signal: options.signal,
      readyFile: hostReadyFile,
      extraNetworks: [{ network: options.candidateInternalNetwork, aliases: [proxyAlias] }],
      createArgs: [
        "--network", options.providerNetwork,
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--pids-limit", "64",
        "--memory", "128m",
        "-v", `${options.auditDir}:/proxy-audit`,
        "-v", `${readyDir}:/proxy-ready`,
        options.image,
        "bun", "-e", EGRESS_PROXY_SCRIPT, JSON.stringify(containerConfig),
      ],
    });
    return {
      ...sidecar,
      proxyUrl: `http://${proxyAlias}:${proxyPort}`,
      envArgs: egressProxyEnv(proxyAlias, proxyPort),
      async stop(): Promise<void> {
        try { await sidecar.stop(); }
        finally { await rm(readyDir, { recursive: true, force: true }); }
      },
    };
  } catch (error) {
    await rm(readyDir, { recursive: true, force: true });
    throw error;
  }
}
