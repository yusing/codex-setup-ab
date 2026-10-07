import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveWorkbench } from "./web-server";

let root: string;
let workbench: ReturnType<typeof serveWorkbench>;
let origin: string;
let token: string;

async function file(path: string, contents: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, contents);
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(origin + path, {
    method: "POST", headers: { "Content-Type": "application/json", "x-codex-ab-token": token },
    body: JSON.stringify(body),
  });
}

async function attach(directory: string): Promise<{ id: string; directory: string; kind: string }> {
  const response = await post("/api/attach", { directory });
  expect(response.status).toBe(200);
  return response.json();
}

async function pair(): Promise<string> {
  const directory = join(root, "pair");
  await file(join(directory, "run.json"), JSON.stringify({
    schema_version: 1, id: "recorded-pair", status: "complete", comparison: "stock-current",
    results: { stock: { exit_code: 0, agent_elapsed_ms: 1234 }, current: { exit_code: 0, agent_elapsed_ms: 987 } },
  }));
  return directory;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "codex-ab-workbench-test-"));
  workbench = serveWorkbench(0);
  origin = `http://127.0.0.1:${workbench.server.port}`;
  token = (await (await fetch(origin + "/api/config")).json()).token;
});

afterEach(async () => {
  await workbench.shutdown();
  await rm(root, { recursive: true, force: true });
});

test("attached evidence retains report data, arm logs, hierarchy, and stable entry identity", async () => {
  const directory = await pair();
  const report = {
    validity: "valid", winner: "current",
    arms: {
      stock: { usage: { totals: { input_tokens: 100, estimated_api_usd: 0.01 } } },
      current: { usage: { totals: { input_tokens: 80, estimated_api_usd: 0.008 } } },
    },
    judge: { result: { reasoning: "Current passes the behavioral checks", winner: "current" } },
  };
  await file(join(directory, "reports/report.json"), JSON.stringify(report));
  await file(join(directory, "artifacts/stock/codex.jsonl"), '{"type":"thread.started","thread_id":"stock-thread"}\n');
  await file(join(directory, "artifacts/current/codex.jsonl"), '{"type":"item.completed","item":{"text":"Implemented behavior"}}\n');
  const entry = await attach(directory);
  expect(await attach(join(directory, "."))).toEqual(entry);
  const detail = await (await fetch(`${origin}/api/entries/${entry.id}`)).json();
  expect(detail.entry.directory).toBe(directory);
  expect(detail.state.results.current.agent_elapsed_ms).toBe(987);
  expect(detail.report).toEqual(report);
  expect(detail.live.stock).toContain("stock-thread");
  expect(detail.live.current).toContain("Implemented behavior");
  expect(detail.artifacts.map((artifact: { path: string }) => artifact.path)).toContain("reports/report.json");

  const trials = join(root, "trials");
  await file(join(trials, "trials.json"), JSON.stringify({ schema: "codex-ab.trials.v1", trials: [{ run_dir: "runs/1" }] }));
  await file(join(trials, "runs/1/run.json"), JSON.stringify({ schema_version: 1, status: "partial", error: "agent timed out" }));
  const trialEntry = await attach(trials);
  const trialDetail = await (await fetch(`${origin}/api/entries/${trialEntry.id}`)).json();
  expect(trialDetail.children).toHaveLength(1);
  expect(trialDetail.children[0]).toMatchObject({ kind: "pair", status: "partial", error: "agent timed out" });
  const child = await (await fetch(`${origin}/api/entries/${trialDetail.children[0].id}`)).json();
  expect(child.state.status).toBe("partial");

  for (const [kind, marker, schema] of [
    ["suite", "suite.json", "codex-ab.suite-run.v1"], ["build", "build.json", "codex-ab.mekugi-build.v1"],
  ]) {
    const selected = join(root, kind!);
    await file(join(selected, marker!), JSON.stringify({ schema }));
    expect((await attach(selected)).kind).toBe(kind!);
  }
  expect((await (await fetch(origin + "/api/entries")).json()).entries).toHaveLength(5);
});

test("artifact access exposes evidence while rejecting private files, traversal, and symlinks", async () => {
  const directory = await pair();
  await file(join(directory, "reports/report.md"), "# Recorded outcome\n");
  await file(join(directory, "arms/current/home/ubuntu/.codex/auth.json"), "private credential");
  await file(join(directory, "artifacts/current/auth.json"), "private credential");
  await file(join(directory, "reports/auth.json"), "private credential");
  await file(join(directory, "reports/home/token.json"), "private credential");
  await file(join(root, "outside.txt"), "outside evidence boundary");
  await symlink(join(root, "outside.txt"), join(directory, "reports/escape.txt"));
  await symlink(join(directory, "reports/report.md"), join(directory, "reports/alias.md"));
  const entry = await attach(directory);
  const artifactUrl = `${origin}/api/entries/${entry.id}/artifacts?path=`;
  const response = await fetch(artifactUrl + encodeURIComponent("reports/report.md"));
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("# Recorded outcome\n");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("content-disposition")).toBe("attachment");
  for (const path of [
    "arms/current/home/ubuntu/.codex/auth.json", "artifacts/current/auth.json", "reports/auth.json",
    "reports/home/token.json", "../outside.txt", "reports/escape.txt", "reports/alias.md",
  ]) {
    expect((await fetch(artifactUrl + encodeURIComponent(path))).status).toBe(403);
  }
  const detail = await (await fetch(`${origin}/api/entries/${entry.id}`)).json();
  expect(detail.artifacts.map((artifact: { path: string }) => artifact.path)).toEqual(["reports/report.md", "run.json"]);
});

test("mutations require the local origin and the current workbench token", async () => {
  const directory = await pair();
  expect((await fetch(origin + "/api/attach", { method: "POST", body: JSON.stringify({ directory }) })).status).toBe(403);
  const foreignHeaders: Record<string, string>[] = [
    { origin: "https://untrusted.example" }, { host: "untrusted.example" }, { "sec-fetch-site": "cross-site" },
  ];
  for (const headers of foreignHeaders) {
    expect((await fetch(origin + "/api/config", { headers })).status).toBe(403);
  }
  expect((await (await fetch(origin + "/api/entries")).json()).entries).toEqual([]);
});

test("explicit and wildcard hosts permit same-origin access while retaining request protections", async () => {
  const directory = await pair();
  for (const [host, address] of [["127.0.0.2", "127.0.0.2"], ["0.0.0.0", "127.0.0.1"], ["::1", "[::1]"]]) {
    await workbench.shutdown();
    workbench = serveWorkbench(0, host);
    origin = `http://${address}:${workbench.server.port}`;
    expect((await fetch(origin)).status).toBe(200);
    token = (await (await fetch(origin + "/api/config")).json()).token;
    const body = JSON.stringify({ directory });
    expect((await fetch(origin + "/api/attach", {
      method: "POST", headers: { origin, "Content-Type": "application/json", "x-codex-ab-token": token }, body,
    })).status).toBe(200);
    for (const headers of [{ origin: "https://untrusted.example" }, { host: "untrusted.example" }, { "sec-fetch-site": "cross-site" }]) {
      expect((await fetch(origin + "/api/config", { headers })).status).toBe(403);
    }
    expect((await fetch(origin + "/api/attach", { method: "POST", body })).status).toBe(403);
  }
});

test("invalid launch inputs fail before creating a job, and paid consent is fresh per start", async () => {
  for (const options of [
    { "prepare-only": "true" }, { unexpected: "value" }, { task: "unknown", "prepare-only": true },
    { count: "0", "prepare-only": true }, { task: "custom", source: root, "prepare-only": true },
  ]) {
    const response = await post("/api/start", { command: "launch", options });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBeString();
  }
  const entry = await attach(await pair());
  const auth = join(root, "fixture-auth.json");
  await file(auth, "{}\n");
  const body = { command: "run", entryId: entry.id, options: { "auth-file": auth } };
  expect((await post("/api/check", { ...body, confirmPaid: true })).status).toBe(200);
  const rejected = await post("/api/start", body);
  expect(rejected.status).toBe(400);
  expect((await rejected.json()).error).toContain("Confirm paid inference");
  const entries = await (await fetch(origin + "/api/entries")).json();
  expect(entries.active).toBeUndefined();
  expect(entries.entries).toHaveLength(1);
  expect(entries.entries[0].job).toBeUndefined();
});

test("a model-free CLI operation completes, persists its result, and releases the active slot", async () => {
  const directory = await pair();
  const entry = await attach(directory);
  for (const reason of ["Operator withdrew this result", "Corrected exclusion rationale"]) {
    const response = await post("/api/start", { command: "invalidate", entryId: entry.id, options: { reason } });
    expect(response.status).toBe(202);
    expect((await response.json()).job.status).toBe("running");
    let detail = await (await fetch(`${origin}/api/entries/${entry.id}`)).json();
    const deadline = Date.now() + 5000;
    while (detail.entry.job.status === "running" && Date.now() < deadline) {
      await Bun.sleep(20);
      detail = await (await fetch(`${origin}/api/entries/${entry.id}`)).json();
    }
    expect(detail.entry.job.status).toBe("complete");
    expect(detail.entry.job.finishedAt).toBeString();
    expect(detail.entry.job.log).toContain(directory);
    expect(detail.state.invalidity_reasons).toEqual([reason]);
    expect(JSON.parse(await readFile(join(directory, "run.json"), "utf8")).invalidity_reasons).toEqual([reason]);
    const list = await (await fetch(origin + "/api/entries")).json();
    expect(list.active).toBeUndefined();
    expect(list.entries[0].job).toEqual({ status: "complete" });
  }
});

test("stopping a real CLI operation retains its phase log and releases the active slot", async () => {
  const source = join(root, "source");
  const docker = join(root, "fixture-docker");
  await file(join(source, "README.md"), "Tiny captured source fixture\n");
  await file(docker, "#!/bin/sh\nexec sleep 30\n");
  await chmod(docker, 0o700);
  const started = await post("/api/start", {
    command: "build-mekugi", options: { source, image: "fixture-image", "docker-bin": docker, "output-parent": root },
  });
  expect(started.status).toBe(202);
  const entry = await started.json();
  const url = `${origin}/api/entries/${entry.id}`;
  let detail = await (await fetch(url)).json();
  const phaseDeadline = Date.now() + 3000;
  while (!detail.entry.job.log.includes("[build] freezing") && Date.now() < phaseDeadline) {
    await Bun.sleep(20);
    detail = await (await fetch(url)).json();
  }
  expect(detail.entry.job.log).toContain("[build] freezing");
  expect(detail.entry.job.status).toBe("running");
  expect((await post(`/api/entries/${entry.id}/stop`, {})).status).toBe(200);
  const stopDeadline = Date.now() + 3000;
  do {
    detail = await (await fetch(url)).json();
    if (detail.entry.job.status !== "stopping") break;
    await Bun.sleep(20);
  } while (Date.now() < stopDeadline);
  expect(detail.entry.job.status).toBe("canceled");
  expect(detail.entry.job.log).toContain("[build] freezing");
  expect(Date.parse(detail.entry.job.finishedAt)).toBeGreaterThanOrEqual(Date.parse(detail.entry.job.startedAt));
  expect((await (await fetch(origin + "/api/entries")).json()).active).toBeUndefined();
}, 10000);

test("failed real CLI builds expose their compiler logs and remain attachable", async () => {
  const source = join(root, "source");
  const docker = join(root, "fixture-docker");
  await file(join(source, "README.md"), "Tiny captured source\n");
  await file(docker, `#!/bin/sh
case "$1" in
image) echo sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ;;
container) echo 'No such container' >&2; exit 1 ;;
create) echo fixture-container ;;
start) echo 'Compiler progress'; echo 'Compilation failed' >&2; exit 1 ;;
*) exit 99 ;;
esac
`);
  await chmod(docker, 0o700);
  const response = await post("/api/start", { command: "build-mekugi", options: { source, image: "fixture-image", "docker-bin": docker, "output-parent": root } });
  expect(response.status).toBe(202);
  const entry = await response.json();
  let detail = await (await fetch(`${origin}/api/entries/${entry.id}`)).json();
  const deadline = Date.now() + 5000;
  while (detail.entry.job.status === "running" && Date.now() < deadline) {
    await Bun.sleep(20);
    detail = await (await fetch(`${origin}/api/entries/${entry.id}`)).json();
  }
  expect(detail.entry.job.status).toBe("failed");
  expect(detail.state.status).toBe("failed");
  expect(detail.live.build).toContain("Compiler progress");
  expect(detail.live["build stderr"]).toContain("Compilation failed");
  expect(detail.artifacts.map((artifact: { path: string }) => artifact.path)).toEqual(["build-result.json", "build.stderr", "build.stdout"]);
  expect((await attach(detail.entry.directory)).id).toBe(entry.id);
  const output = await fetch(`${origin}/api/entries/${entry.id}/artifacts?path=build.stderr`);
  expect(await output.text()).toContain("Compilation failed");
});
