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
  case "$spec" in *'sleep-command'*) trap 'exit 143' TERM INT; sleep 2;; *'fail-command'*) case "$spec" in *--rm*) rm -f "$state/$name";; esac; exit 7;; *'auto-remove-race'*) exit 0;; *) echo harmless;; esac
  case "$spec" in *--rm*) rm -f "$state/$name";; esac;;
 stop) echo stopped;;
 commit)
  target="$1"
  case "$target" in *snapshot-fails*) echo snapshot-failed >&2; exit 7;; esac
  echo sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc;;
 container)
  target=; for argument in "$@"; do target="$argument"; done
  case "$target" in *daemon-inspect*) echo 'daemon permission denied' >&2; exit 2;; esac
  if [ ! -f "$state/$target" ]; then echo "Error: No such container: $target" >&2; exit 1; fi
  case " $* " in *'codex-ab.owner'*) sed -n 's/.*codex-ab.owner=\\([^ ]*\\).*/\\1/p' "$state/$target";; *) echo "$target";; esac;;
 rm)
  name=; for argument in "$@"; do name="$argument"; done
  case "$name" in *cleanup-fails*) :;; *auto-remove-race*) rm -f "$state/$name"; echo "Error: No such container: $name" >&2; exit 1;; *) rm -f "$state/$name";; esac;;
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

test("cleanup accepts Docker auto-removal after ownership inspection", async () => {
  const result = await runOwnedContainer({ docker, name: "auto-remove-race", createArgs: ["fixture", "auto-remove-race"] });
  expect(result.exitCode).toBe(0);
  expect(result.cleanupVerified).toBe(true);
  expect(await readFile(log, "utf8")).toContain("rm --force auto-remove-race");
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


test.each(["ordinary", "failure", "timeout"])("snapshot retains %s execution before removal", async kind => {
  const name = `snapshot-${kind}`;
  const result = await runOwnedContainer({ docker, name, snapshotImage: `retained:${kind}`,
    timeoutMs: kind === "timeout" ? 50 : undefined,
    createArgs: ["fixture", kind === "timeout" ? "sleep-command" : kind === "failure" ? "fail-command" : "harmless"] });
  expect(result.snapshotImageId).toBe(`sha256:${"c".repeat(64)}`);
  expect(result.cleanupVerified).toBe(true);
  const calls = await readFile(log, "utf8");
  expect(calls).toContain(`create --name ${name}`);
  expect(calls.indexOf(`commit ${name}`)).toBeLessThan(calls.indexOf(`rm --force ${name}`));
});

test("cancellation snapshots the stopped writable layer before removal", async () => {
  const controller = new AbortController();
  const pending = runOwnedContainer({ docker, name: "snapshot-abort", snapshotImage: "retained:abort", signal: controller.signal,
    createArgs: ["fixture", "sleep-command"] });
  await Bun.sleep(50); controller.abort();
  const result = await pending;
  expect(result.canceled).toBe(true);
  expect(result.snapshotImageId).toBe(`sha256:${"c".repeat(64)}`);
});

test("failed snapshots retain the stopped container instead of discarding evidence", async () => {
  await expect(runOwnedContainer({ docker, name: "evidence-snapshot-fails", snapshotImage: "retained:failure",
    createArgs: ["fixture", "harmless"] })).rejects.toThrow("stopped container retained for evidence");
  expect(await Bun.file(join(root, "state/evidence-snapshot-fails")).exists()).toBe(true);
  expect(await readFile(log, "utf8")).not.toContain("rm --force evidence-snapshot-fails");
});

test("snapshot identity is delivered before cleanup and survives cleanup failure", async () => {
  let retained: string | undefined;
  const failure = await runOwnedContainer({ docker, name: "snapshot-cleanup-fails", snapshotImage: "retained:cleanup",
    onSnapshot: image => { retained = image; }, createArgs: ["fixture", "harmless"] }).catch(error => error);
  expect(retained).toBe(`sha256:${"c".repeat(64)}`);
  expect(failure).toBeInstanceOf(OwnedContainerError);
  expect(failure.snapshotImageId).toBe(retained);
  expect(await Bun.file(join(root, "state/snapshot-cleanup-fails")).exists()).toBe(true);
});

test("metadata preparation snapshots restore the non-root runtime image identity", async () => {
  await runOwnedContainer({ docker, name: "snapshot-user", snapshotImage: "retained:user", snapshotUser: "1000:1000",
    createArgs: ["--user", "0:0", "fixture", "harmless"] });
  expect(await readFile(log, "utf8")).toContain("commit --change USER 1000:1000 snapshot-user retained:user");
});
