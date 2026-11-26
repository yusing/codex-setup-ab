import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOwnedNetwork, runOwnedContainer, type OwnedNetwork } from "./container";
import { startEgressProxySidecar, type EgressProxySidecar } from "./egress-proxy";
import { exec } from "./process";
const liveTest = process.env.CODEX_AB_LIVE_DOCKER === "1" ? test : test.skip;
liveTest("separate arm networks deny peer DNS and direct IPv4 and IPv6 connections",async()=>{
  const docker=process.env.CODEX_AB_DOCKER_BIN ?? "docker", image=process.env.CODEX_AB_LIVE_IMAGE ?? "codex-ab:model-free";
  const id=crypto.randomUUID(), a=await createOwnedNetwork(docker,`codex-ab-network-a-${id}`);
  let b:OwnedNetwork|undefined;
  const stop=new AbortController(); let server:Promise<unknown>|undefined;
  try {
    b=await createOwnedNetwork(docker,`codex-ab-network-b-${id}`);
    const name=`codex-ab-peer-${id}`;
    server=runOwnedContainer({docker,name,signal:stop.signal,timeoutMs:25_000,createArgs:["--network",a.name,image,"python3","-m","http.server","8765","--bind","::"]});
    void server.catch(() => {});
    let ip="", ipv6="";
    for(let i=0;i<80;i++) {
      const inspected=await exec([docker,"container","inspect","--format","{{range .NetworkSettings.Networks}}{{.IPAddress}} {{.GlobalIPv6Address}}{{end}}",name]);
      if(inspected.exitCode===0) {
        const addresses=inspected.stdout.trim().split(/\s+/);
        ip=addresses[0] ?? ""; ipv6=addresses[1] ?? "";
        if(isIP(ip)===4 && isIP(ipv6)===6) break;
      }
      await Bun.sleep(50);
    }
    expect(isIP(ip)).toBe(4); expect(isIP(ipv6)).toBe(6);
    const reachable=await runOwnedContainer({docker,name:`codex-ab-peer-control-${id}`,timeoutMs:12000,createArgs:["--network",a.name,image,"python3","-c",
      "import socket,sys,time\nfor destination in sys.argv[1:]:\n for attempt in range(40):\n  try:\n   c=socket.create_connection((destination,8765),timeout=.1);c.close();print('reachable:'+destination);break\n  except OSError:\n   time.sleep(.1)\n else: sys.exit(3)",name,ip,ipv6]});
    expect(reachable.exitCode,reachable.stderr).toBe(0);
    expect(reachable.stdout.trim().split("\n")).toEqual([name,ip,ipv6].map(address=>`reachable:${address}`));
    const result=await runOwnedContainer({docker,name:`codex-ab-peer-probe-${id}`,timeoutMs:5000,createArgs:["--network",b.name,image,"python3","-c",
      "import socket,sys\ntry:\n socket.getaddrinfo(sys.argv[1],8765);sys.exit(1)\nexcept socket.gaierror: pass\nfor destination in sys.argv[2:]:\n try:\n  c=socket.create_connection((destination,8765),timeout=1);c.close();sys.exit(2)\n except OSError: pass\n print('isolated:'+destination)",name,ip,ipv6]});
    expect(result.exitCode,result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([ip,ipv6].map(address=>`isolated:${address}`));
    const running=await exec([docker,"container","inspect","--format","{{.State.Running}}",name]);
    expect(running.exitCode,running.stderr).toBe(0); expect(running.stdout.trim()).toBe("true");
  } finally {
    stop.abort();
    try { if(server) await server; }
    finally { await Promise.all([a.remove(),b?.remove()]); }
  }
  for (const network of [a,...(b ? [b] : [])]) {
    const absent=await exec([docker,"network","inspect",network.name]);
    expect(absent.exitCode).not.toBe(0);
    expect(absent.stderr.toLowerCase()).toMatch(/no such network|network .+ not found/);
  }
},30_000);

liveTest("closed-book internal network blocks direct egress while sidecar proxy allows allowlisted peer and denies others with 403", async () => {
  const docker = process.env.CODEX_AB_DOCKER_BIN ?? "docker";
  const image = process.env.CODEX_AB_LIVE_IMAGE ?? "codex-ab:model-free";
  const id = crypto.randomUUID();
  const auditDir = await mkdtemp(join(tmpdir(), "codex-ab-live-egress-"));
  const providerNetwork = await createOwnedNetwork(docker, `codex-ab-egress-provider-${id}`);
  let internalNetwork: OwnedNetwork | undefined;
  let proxy: EgressProxySidecar | undefined;
  const stopPeer = new AbortController();
  let peerServer: Promise<unknown> | undefined;
  try {
    internalNetwork = await createOwnedNetwork(docker, `codex-ab-egress-internal-${id}`, undefined, { internal: true });
    const peerName = `codex-ab-egress-peer-${id}`;
    peerServer = runOwnedContainer({
      docker,
      name: peerName,
      signal: stopPeer.signal,
      timeoutMs: 30_000,
      createArgs: ["--network", providerNetwork.name, image, "python3", "-m", "http.server", "8765", "--bind", "::"],
    });
    void peerServer.catch(() => {});

    let peerIp = "";
    for (let i = 0; i < 80; i++) {
      const inspected = await exec([docker, "container", "inspect", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", peerName]);
      if (inspected.exitCode === 0 && isIP(inspected.stdout.trim()) === 4) {
        peerIp = inspected.stdout.trim();
        break;
      }
      await Bun.sleep(50);
    }
    expect(isIP(peerIp)).toBe(4);

    proxy = await startEgressProxySidecar({
      docker,
      name: `codex-ab-egress-proxy-${id}`,
      image,
      providerNetwork: providerNetwork.name,
      candidateInternalNetwork: internalNetwork.name,
      allowedHosts: [peerName],
      allowedConnectPorts: [8765],
      allowedHttpPorts: [8765],
      auditDir,
    });

    const probe = await runOwnedContainer({
      docker,
      name: `codex-ab-egress-probe-${id}`,
      timeoutMs: 15_000,
      createArgs: [
        "--network", internalNetwork.name,
        ...proxy.envArgs,
        image, "python3", "-c",
        `import os, socket, sys, time, urllib.error, urllib.request
peer_name, peer_ip = sys.argv[1], sys.argv[2]
# 1. Direct connection to external peer on provider network must fail from --internal network
try:
    c = socket.create_connection((peer_ip, 8765), timeout=1)
    c.close()
    sys.exit(10)
except OSError:
    pass
# 2. Proxied request to allowlisted peer must succeed (retry briefly while python http.server binds)
for attempt in range(30):
    try:
        with urllib.request.urlopen(f"http://{peer_name}:8765/", timeout=3) as resp:
            assert resp.status == 200
            break
    except Exception:
        time.sleep(0.1)
else:
    sys.exit(11)
# 3. Proxied CONNECT to non-allowlisted host must return 403
proxy_host, proxy_port = os.environ["HTTPS_PROXY"].replace("http://", "").split(":")
s = socket.create_connection((proxy_host, int(proxy_port)), timeout=3)
s.sendall(b"CONNECT github.com:8765 HTTP/1.1\\r\\nHost: github.com:8765\\r\\n\\r\\n")
resp = s.recv(1024).decode("utf-8", "replace")
s.close()
assert "403 Forbidden" in resp, f"expected 403, got {resp!r}"
print("CLOSED_BOOK_PROXY_OK")
`,
        peerName, peerIp,
      ],
    });
    expect(probe.exitCode, probe.stderr).toBe(0);
    expect(probe.stdout.trim()).toBe("CLOSED_BOOK_PROXY_OK");

    const deniedRecords = (await readFile(join(auditDir, "egress-denied.jsonl"), "utf8"))
      .trim().split("\n").map(line => JSON.parse(line));
    expect(deniedRecords.some(record => record.host === "github.com" && record.reason === "host-not-allowlisted")).toBe(true);
  } finally {
    await proxy?.stop();
    stopPeer.abort();
    try { if (peerServer) await peerServer; }
    finally {
      await Promise.all([internalNetwork?.remove(), providerNetwork.remove()]);
      await rm(auditDir, { recursive: true, force: true });
    }
  }
}, 45_000);
