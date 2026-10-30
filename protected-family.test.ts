import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { exec } from "./process";

test("protected root and child listeners precede shared-group egress rejection", async () => {
  const root = await mkdtemp(join(tmpdir(), "mekugi-protected-family-"));
  try {
    const stub = join(root, "firewall");
    await writeFile(stub, `#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
path = Path(os.environ['FIREWALL_STATE'])
tables = json.loads(path.read_text()) if path.exists() else {}
rules = tables.setdefault(Path(sys.argv[0]).name, [])
args = sys.argv[1:]
assert args[:1] == ['-w'] and args[2] == 'OUTPUT', args
if args[1] == '-I':
    assert args[3] == '1', args
    rules.insert(0, args[4:])
else:
    assert args[1] == '-A', args
    rules.append(args[3:])
path.write_text(json.dumps(tables))
`);
    await chmod(stub, 0o755);
    for (const command of ["iptables", "ip6tables"]) await symlink(stub, join(root, command));
    await writeFile(join(root, "stat"), "#!/bin/sh\nprintf '1234\\n'\n");
    await writeFile(join(root, "unshare"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$UNSHARE_ARGS"\n');
    for (const command of ["stat", "unshare"]) await chmod(join(root, command), 0o755);
    const env = {
      PATH: `${root}:${process.env.PATH}`,
      FIREWALL_STATE: join(root, "rules.json"),
      UNSHARE_ARGS: join(root, "unshare.args"),
      MEKUGI_RUNTIME_DIR: join(root, "runtime"),
      MEKUGI_EXPORT_DIR: join(root, "exports"),
    };
    const assigned: { family: string; address: string; port: string }[] = [];
    for (const [family, address, port] of [
      ["iptables", "127.0.0.1", "31001"],
      ["iptables", "127.0.0.1", "31002"],
      ["ip6tables", "::1", "31003"],
      ["ip6tables", "::1", "31004"],
    ]) {
      const host = family === "ip6tables" ? `[${address}]` : address;
      const launched = await exec(["bash", resolve("support/mekugi/isolated-codex.sh"), "--model", "fixture"], {
        cwd: root,
        env: { ...env, MEKUGI_BASE_URL: `http://${host}:${port}/v1` },
      });
      expect(launched.exitCode, launched.stderr).toBe(0);
      expect((await readFile(env.UNSHARE_ARGS, "utf8")).split("\n")).toEqual([
        "--mount", "--pid", "--fork", "--mount-proc", "--kill-child=KILL",
        "/usr/local/libexec/mekugi-agent-mounts", "--model", "fixture", "",
      ]);
      assigned.push({ family, address, port });
      const tables: Record<string, string[][]> = JSON.parse(await readFile(env.FIREWALL_STATE, "utf8"));
      // Evaluate OUTPUT in first-match order, as the kernel does. A later ACCEPT
      // cannot rescue a child listener behind a previously installed REJECT.
      const verdict = (family: string, address: string, port: string, protocol = "tcp") => {
        for (const rule of tables[family] ?? []) {
          const value = (flag: string) => rule.includes(flag) ? rule[rule.indexOf(flag) + 1] : undefined;
          if (value("--gid-owner") !== "1234") continue;
          if (value("-p") && value("-p") !== protocol) continue;
          if (value("-d") && value("-d") !== address) continue;
          if (value("--dport") && value("--dport") !== port) continue;
          return value("-j");
        }
        return "ACCEPT"; // The container's default policy does not isolate executors.
      };
      for (const listener of assigned) {
        expect(verdict(listener.family, listener.address, listener.port)).toBe("ACCEPT");
      }
      for (const [family, address] of [["iptables", "1.1.1.1"], ["ip6tables", "2606:4700:4700::1111"]]) {
        expect(verdict(family, address, port)).toBe("REJECT");
        expect(verdict(family, address, "53", "udp")).toBe("REJECT");
      }
      expect(verdict("iptables", "127.0.0.1", "31999")).toBe("REJECT");
      expect(verdict("ip6tables", "::1", "31999")).toBe("REJECT");
    }
    const before = await readFile(env.FIREWALL_STATE, "utf8");
    const invalid = await exec(["bash", resolve("support/mekugi/isolated-codex.sh")], {
      cwd: root, env: { ...env, MEKUGI_BASE_URL: "http://1.1.1.1:31005/v1" },
    });
    expect(invalid.exitCode).not.toBe(0);
    expect(invalid.stderr).toContain("invalid private listener");
    expect(await readFile(env.FIREWALL_STATE, "utf8")).toBe(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
