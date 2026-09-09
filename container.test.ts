import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OwnedContainerError, runOwnedContainer } from "./container";

let root: string;
let docker: string;
let log: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "owned-container-test-"));
  docker = join(root, "docker");
  log = join(root, "docker.log");
  await writeFile(docker, `#!/bin/sh
set -u
state='${root}/state'; mkdir -p "$state"
echo "$*" >>'${log}'
operation="$1"; shift
case "$operation" in
 create)
  name=; previous=
  for argument in "$@"; do [ "$previous" = --name ] && name="$argument"; previous="$argument"; done
  case " $* " in *' slow-create '*) sleep 2;; esac
  echo "$*" >"$state/$name"; echo "$name";;
 start)
  name=; for argument in "$@"; do name="$argument"; done
  spec="$(cat "$state/$name")"
  case "$spec" in *'sleep-command'*) trap 'exit 143' TERM INT; sleep 2;; *'fail-command'*) rm -f "$state/$name"; exit 7;; *) echo harmless;; esac
  rm -f "$state/$name";;
 container)
  target=; for argument in "$@"; do target="$argument"; done
  case "$target" in *daemon-inspect*) echo 'daemon permission denied' >&2; exit 2;; esac
  if [ ! -f "$state/$target" ]; then echo "Error: No such container: $target" >&2; exit 1; fi
  case " $* " in *'codex-ab.owner'*) sed -n 's/.*codex-ab.owner=\\([^ ]*\\).*/\\1/p' "$state/$target";; *) echo "$target";; esac;;
 rm)
  name=; for argument in "$@"; do name="$argument"; done
  case "$name" in *cleanup-fails*) :;; *) rm -f "$state/$name";; esac;;
esac
`, { mode: 0o755 });
  await chmod(docker, 0o755);
});

afterAll(async () => { await rm(root, { recursive: true, force: true }); });

test("ordinary and failing commands both end with verified absence", async () => {
  const success = await runOwnedContainer({ docker, name: "ordinary", createArgs: ["fixture", "harmless"] });
  expect(success.exitCode).toBe(0);
  expect(success.stdout).toContain("harmless");
  const failure = await runOwnedContainer({ docker, name: "failure", createArgs: ["fixture", "fail-command"] });
  expect(failure.exitCode).toBe(7);
  expect(failure.cleanupVerified).toBe(true);
});

test("pre-aborted signal never creates or starts a container", async () => {
  const controller = new AbortController(); controller.abort();
  expect(runOwnedContainer({ docker, name: "pre-aborted", signal: controller.signal, createArgs: ["fixture", "model-command"] })).rejects.toThrow("canceled before creation");
  const calls = await readFile(log, "utf8");
  expect(calls).not.toContain("create --rm --name pre-aborted");
  expect(calls).not.toContain("start --attach pre-aborted");
});

test("abort during creation cleans any create race and never starts", async () => {
  const controller = new AbortController();
  const running = runOwnedContainer({ docker, name: "create-race", signal: controller.signal, createArgs: ["fixture", "slow-create", "model-command"] });
  await Bun.sleep(50); controller.abort();
  expect(running).rejects.toThrow(OwnedContainerError);
  const calls = await readFile(log, "utf8");
  expect(calls).not.toContain("start --attach create-race");
  expect(await Bun.file(join(root, "state/create-race")).exists()).toBe(false);
});

test("timeout removes a running container and verifies absence", async () => {
  const result = await runOwnedContainer({ docker, name: "timeout", timeoutMs: 50, createArgs: ["fixture", "sleep-command"] });
  expect(result.timedOut).toBe(true);
  expect(result.cleanupVerified).toBe(true);
  expect(await Bun.file(join(root, "state/timeout")).exists()).toBe(false);
});

test("cleanup verification failure is terminal", async () => {
  expect(runOwnedContainer({ docker, name: "cleanup-fails", timeoutMs: 50, createArgs: ["fixture", "sleep-command"] })).rejects.toThrow("cleanup could not verify");
});

test("abort cleanup rejection is captured and returned through the lifecycle", async () => {
  const controller = new AbortController();
  const running = runOwnedContainer({ docker, name: "abort-cleanup-fails", signal: controller.signal, createArgs: ["fixture", "sleep-command"] });
  await Bun.sleep(50); controller.abort();
  expect(running).rejects.toThrow("cleanup could not verify");
});

test("daemon inspection errors are not mistaken for absence", async () => {
  expect(runOwnedContainer({ docker, name: "daemon-inspect", createArgs: ["fixture", "harmless"] })).rejects.toThrow("cannot verify");
});

test("a preexisting name collision is preserved", async () => {
  const collision = join(root, "state/collision");
  await mkdir(join(root, "state"), { recursive: true });
  await writeFile(collision, "--label codex-ab.owner=somebody-else fixture harmless\n");
  expect(runOwnedContainer({ docker, name: "collision", createArgs: ["fixture", "harmless"] })).rejects.toThrow("name already exists");
  expect(await Bun.file(collision).exists()).toBe(true);
});
