import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
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

async function subscribe(id?: string) {
  const abort = new AbortController();
  const response = await fetch(origin + "/api/events" + (id ? "?entry=" + id : ""), { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]) });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  return {
    close: () => abort.abort(),
    async next(event: string, accept: (data: ReturnType<typeof JSON.parse>) => boolean = () => true) {
      while (true) {
        const end = pending.indexOf("\n\n");
        if (end >= 0) {
          const frame = pending.slice(0, end); pending = pending.slice(end + 2);
          if (!frame.startsWith("event: " + event + "\n")) continue;
          const data = JSON.parse(frame.slice(frame.indexOf("data: ") + 6));
          if (accept(data)) return data;
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("SSE ended before " + event);
        pending += decoder.decode(value, { stream: true });
      }
    },
  };
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
  await file(join(trials, "trials.json"), JSON.stringify({ schema: "codex-ab.trials.v1", controls: { comparison: "same-setup" }, trials: [{ run_dir: "runs/1" }] }));
  await file(join(trials, "runs/1/run.json"), JSON.stringify({ schema_version: 1, status: "partial", error: "agent timed out" }));
  const trialEntry = await attach(trials);
  const trialDetail = await (await fetch(`${origin}/api/entries/${trialEntry.id}`)).json();
  expect(trialDetail.arm_labels).toEqual({ stock: "Codex (current-home setup)", current: "Codex + Mekugi (current-home setup)" });
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

test("workbench serves its interface font locally", async () => {
  const response = await fetch(origin + "/fonts/ibm-plex-sans-latin.woff2");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("font/woff2");
  expect(Buffer.from(await response.arrayBuffer())).toEqual(await readFile(join(import.meta.dir, "web/fonts/ibm-plex-sans-latin.woff2")));
  expect(await (await fetch(origin + "/fonts/OFL.txt")).text()).toContain("SIL OPEN FONT LICENSE");
});

test("pair measurement headers use actual arms before reporting and retain recorded report labels", async () => {
  const directory = await pair();
  const state = { schema_version: 1, comparison: "same-setup", execution: { current_launcher: "mekugi" } };
  await file(join(directory, "run.json"), JSON.stringify(state));
  const entry = await attach(directory);
  const source = (await (await fetch(origin + "/app.js")).text()).replace(/\ninit\(\);\s*$/, "");
  const render = (input: unknown): string => runInNewContext(source + "\nresultContent(input)", { input });
  const stream = await subscribe(entry.id);
  try {
    const partial = await stream.next("snapshot");
    expect(render(partial)).toContain('class="a">Codex (current-home setup)</th>');
    expect(render(partial)).toContain('class="b">Codex + Mekugi (current-home setup)</th>');
    await file(join(directory, "run.json"), JSON.stringify({ ...state, comparison: "duplicate-output" }));
    const updated = await stream.next("snapshot", data => data.state.comparison === "duplicate-output");
    expect(render(updated)).toContain('class="a">Codex + Mekugi (duplicate output off)</th>');
    expect(render(updated)).toContain('class="b">Codex + Mekugi (duplicate output on)</th>');
    await file(join(directory, "reports/report.json"), JSON.stringify({ winner: "current" }));
    const unlabeled = await (await fetch(`${origin}/api/entries/${entry.id}`)).json();
    expect(render(unlabeled)).toContain('class="b">Codex + Mekugi (duplicate output on)</th>');
    await file(join(directory, "reports/report.json"), JSON.stringify({ arm_labels: { stock: "Recorded <A>", current: "Recorded B" } }));
    const labeled = await (await fetch(`${origin}/api/entries/${entry.id}`)).json();
    expect(render(labeled)).toContain('class="a">Recorded &lt;A&gt;</th>');
    expect(render(labeled)).toContain('class="b">Recorded B</th>');
  } finally { stream.close(); }
});

test("source assessments replace numbered identities using each pass's presentation order", async () => {
  const directory = await pair();
  const report = {
    arm_labels: { stock: "Direct Codex", current: "Codex + Mekugi" }, winner: "current",
    criteria: { contract: { criteria: [{ id: "checks", description: "Behavioral checks" }] } },
    arms: { stock: { result: { grade: { semantic: {
      "pass-1": [{ criterion: "checks", status: "pass", basis: "executed", reasoning: "Candidate-1 met the criterion", check: { result: "Candidate-1 check succeeded" } }],
      "pass-2": [{ criterion: "checks", status: "pass", basis: "executed", reasoning: "Candidate-2 met the criterion", execution: { result: "Candidate-2 check succeeded" } }],
    } } } } },
    judge: { result: { passes: [
      { pass: 1, presentation: ["stock", "current"], winner: "candidate-2", rationale: "Candidate-1 inspected <main>", scores: { "candidate-1": { correctness: 3 }, "candidate-2": { correctness: 4 } } },
      { pass: 2, presentation: ["current", "stock"], winner: "candidate-1", evidence: ["Candidate-2 added checks"], issues: [{ candidate: "candidate-2", detail: "constructor" }] },
      { pass: 3, winner: "candidate-1" },
    ] } },
  };
  await file(join(directory, "reports/report.json"), JSON.stringify(report));
  const entry = await attach(directory);
  const input = await (await fetch(`${origin}/api/entries/${entry.id}`)).json();
  const source = (await (await fetch(origin + "/app.js")).text()).replace(/\ninit\(\);\s*$/, "");
  const rendered = runInNewContext(source + "\nresultContent(input)", { input });
  expect(rendered).toContain("Pass 1: Codex + Mekugi");
  expect(rendered).toContain("Pass 2: Codex + Mekugi");
  expect(rendered).toContain("Pass 3: Unmapped setup");
  expect(rendered).toContain("Direct Codex inspected &lt;main&gt;");
  expect(rendered).toContain("Direct Codex added checks");
  expect(rendered).toContain("Direct Codex met the criterion");
  expect(rendered).toContain("Direct Codex check succeeded");
  expect(rendered).not.toContain("Codex + Mekugi met the criterion");
  expect(rendered).toContain("Recorded outcome: Codex + Mekugi");
  expect(rendered).not.toMatch(/candidate[-_ ]([12])|>A[: ]|>B[: ]/i);
  expect(input.report).toEqual(report);
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
    expect((await fetch(origin + "/api/events", { headers })).status).toBe(403);
  }
  expect((await (await fetch(origin + "/api/entries")).json()).entries).toEqual([]);
});

test("SSE pushes attachment, external evidence changes, and current state on reconnect", async () => {
  const list = await subscribe();
  expect((await list.next("entries")).entries).toEqual([]);
  const directory = await pair();
  const entry = await attach(directory);
  expect((await list.next("entries")).entries[0].id).toBe(entry.id);
  list.close();
  const stream = await subscribe(entry.id);
  expect((await stream.next("snapshot")).state.status).toBe("complete");
  await file(join(directory, "run.json"), JSON.stringify({ schema_version: 1, status: "partial" }));
  expect((await stream.next("snapshot", data => data.state.status === "partial")).state.status).toBe("partial");
  await file(join(directory, "run.json"), "{");
  expect((await stream.next("snapshot-error")).error).toBeString();
  await file(join(directory, "run.json"), JSON.stringify({ schema_version: 1, status: "partial" }));
  expect((await stream.next("snapshot")).state.status).toBe("partial");
  await file(join(directory, "artifacts/current/codex.jsonl"), '{"type":"item.completed","item":{"text":"Pushed output"}}\n');
  expect((await stream.next("snapshot", data => data.live.current?.includes("Pushed output"))).live.current).toContain("Pushed output");
  await rename(join(directory, "artifacts/current"), join(directory, "artifacts/old-current"));
  await file(join(directory, "artifacts/current/codex.jsonl"), "Replacement output\n");
  await stream.next("snapshot", data => data.live.current?.includes("Replacement output"));
  await file(join(directory, "artifacts/current/codex.jsonl"), "Later replacement output\n");
  expect((await stream.next("snapshot", data => data.live.current?.includes("Later replacement output"))).live.current).toContain("Later replacement output");
  await file(join(directory, "reports/report.json"), JSON.stringify({ winner_reason: "Pushed report" }));
  const reported = await stream.next("snapshot", data => data.report?.winner_reason === "Pushed report");
  expect(reported.artifacts.map((item: { path: string }) => item.path)).toContain("reports/report.json");
  await rename(directory, directory + "-old");
  await pair();
  await stream.next("snapshot", data => data.state.status === "complete");
  await file(join(directory, "run.json"), JSON.stringify({ schema_version: 1, status: "replacement" }));
  expect((await stream.next("snapshot", data => data.state.status === "replacement")).state.status).toBe("replacement");
  stream.close();
  const reconnected = await subscribe(entry.id);
  expect((await reconnected.next("snapshot")).state.status).toBe("replacement");
  reconnected.close();
  expect((await fetch(origin + "/api/events?entry=missing")).status).toBe(404);
});

test("SSE discovers suite reports written after their empty directory appears", async () => {
  const directory = join(root, "suite");
  await file(join(directory, "suite.json"), JSON.stringify({ schema: "codex-ab.suite-run.v1", sets: [] }));
  const entry = await attach(directory);
  const stream = await subscribe(entry.id);
  await stream.next("snapshot");
  await mkdir(join(directory, "report-latest"));
  await Bun.sleep(150);
  await file(join(directory, "report-latest/report.json"), JSON.stringify({ rows: [{ task: "pushed" }] }));
  expect((await stream.next("snapshot", data => data.report?.rows?.[0]?.task === "pushed")).report.rows[0].task).toBe("pushed");
  stream.close();
});

test("SSE updates selected trial children as their evidence changes", async () => {
  const directory = join(root, "trials");
  await file(join(directory, "trials.json"), JSON.stringify({ schema: "codex-ab.trials.v1", trials: [{ run_dir: "runs/1" }] }));
  const entry = await attach(directory);
  const stream = await subscribe(entry.id);
  expect((await stream.next("snapshot")).children).toEqual([]);
  await mkdir(join(directory, "runs/1"), { recursive: true });
  await Bun.sleep(150); // Preparation can create the directory before its marker.
  await file(join(directory, "runs/1/run.json"), JSON.stringify({ schema_version: 1, status: "running" }));
  const child = (await stream.next("snapshot", data => data.children.length === 1)).children[0];
  expect(child.status).toBe("running");
  await file(join(directory, "runs/1/run.json"), JSON.stringify({ schema_version: 1, status: "complete" }));
  expect((await stream.next("snapshot", data => data.children[0]?.status === "complete")).children[0].id).toBe(child.id);
  stream.close();
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

test("Booking Ledger checks and launch use its synthetic seed without paid inference", async () => {
  const codex = join(root, "codex");
  for (const path of [codex, join(root, "codex-code-mode-host")]) {
    await file(path, "#!/bin/sh\nexit 0\n");
    await chmod(path, 0o755);
  }
  const options = { task: "booking-ledger", "prepare-only": true, "current-home": root, "codex-bin": codex, "docker-bin": "/bin/false", "mekugi-source": root, "mekugi-bin": codex };
  const catalog = (await (await fetch(origin + "/api/config")).json()).tasks;
  expect(catalog.find((task: { id: string }) => task.id === "booking-ledger")).toBeDefined();
  const checked = await post("/api/check", { command: "launch", options });
  expect(checked.status).toBe(200);
  expect((await checked.json()).warnings.join(" ")).toContain("seed checkout");
  expect((await (await fetch(origin + "/api/entries")).json()).entries).toEqual([]);
  const started = await post("/api/start", { command: "launch", options });
  expect(started.status).toBe(202);
  const entry = await started.json();
  let detail;
  const deadline = Date.now() + 5000;
  do {
    detail = await (await fetch(`${origin}/api/entries/${entry.id}`)).json();
    if (detail.entry.job.status !== "running") break;
    await Bun.sleep(20);
  } while (Date.now() < deadline);
  const source = detail.entry.job.log.match(/Synthetic source retained at (\/tmp\/codex-ab-booking-ledger\.[A-Za-z0-9]+)/)?.[1];
  try {
    expect(source).toBeDefined();
    expect(detail.entry.job.status).toBe("failed");
    expect(detail.entry.job.log).toContain("Cannot inspect Docker image");
    expect((await post("/api/check", { command: "launch", options: { ...options, source } })).status).toBe(200);
  } finally {
    if (source) await rm(source, { recursive: true, force: true });
  }
});

test("a model-free CLI operation completes, persists its result, and releases the active slot", async () => {
  const directory = await pair();
  const entry = await attach(directory);
  for (const reason of ["Operator withdrew this result", "Corrected exclusion rationale"]) {
    const stream = await subscribe(entry.id);
    await stream.next("snapshot");
    const response = await post("/api/start", { command: "invalidate", entryId: entry.id, options: { reason } });
    expect(response.status).toBe(202);
    expect((await response.json()).job.status).toBe("running");
    const detail = await stream.next("snapshot", data => data.entry.job?.status === "complete" && data.state.invalidity_reasons?.[0] === reason);
    stream.close();
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
  const stream = await subscribe(entry.id);
  let detail = await stream.next("snapshot", data => data.entry.job.log.includes("[build] freezing"));
  expect(detail.entry.job.log).toContain("[build] freezing");
  expect(detail.entry.job.status).toBe("running");
  expect((await post(`/api/entries/${entry.id}/stop`, {})).status).toBe(200);
  detail = await stream.next("snapshot", data => data.entry.job.status === "canceled");
  stream.close();
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
