import { expect, test } from "bun:test";
import { isIP } from "node:net";
import { createOwnedNetwork, runOwnedContainer, type OwnedNetwork } from "./container";
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
    expect(absent.stderr.toLowerCase()).toContain("no such network");
  }
},30_000);
