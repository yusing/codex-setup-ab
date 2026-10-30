import * as fs from "node:fs";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { serveWorkbench } from "./web-server";
import { explainResources } from "./assessment-explanation";
import { loadTaskPack } from "./task-pack";
import { launchConfiguration } from "./launch";

test("HEAD draft imports a custom composition and preserves shared controls without starting a job", async () => {
  const directory = join(root, "historical");
  const pack = await loadTaskPack("tasks/skills-mgr-agent-cli/manifest.json");
  const keys = ["stock", "current", "arm-3"];
  const state = { schema_version: 1, status: "complete", finishing: { status: "complete" },
    comparison: "custom", source: { path: root }, task: { sha256: pack.contract.task_sha256 },
    task_pack: { id: pack.manifest.id, path: "evaluator/task-pack.json" },
    execution: { model: "gpt-6.1-sol", reasoning_effort: "ultra" },
    resource_limits: { cpus: "4", memory: "4g" }, timeout_seconds: 7200, image: "test-image",
    runtime_tools: { codex_source: "/recorded/codex", bun: "/recorded/bun" },
    selected_arms: keys, arms: Object.fromEntries(keys.map(key => [key, { launcher: "mekugi" }])),
    results: Object.fromEntries(keys.map(key => [key, { exit_code: 0 }])) };
  const original = JSON.stringify(state);
  await file(join(directory, "run.json"), original);
  await file(join(directory, "evaluator/task-pack.json"), JSON.stringify(pack.snapshot));
  await file(join(directory, "reports/bundle/report.json"), '{"validity":"valid"}');
  const response = await post("/api/comparison-draft", { directory });
  expect(response.status).toBe(200);
  const { options } = await response.json();
  const config = launchConfiguration(options);
  expect(config.prepare.arms).toHaveLength(4);
  expect(config.prepare.arms?.at(-1)).toEqual({ launcher: "mekugi", setup_commit: "HEAD" });
  expect(config.importArms?.map(item => item.arm)).toEqual(keys);
  expect(config.prepare).toMatchObject({ cpus: "4", timeoutSeconds: 7200, model: "gpt-6.1-sol", reasoningEffort: "ultra" });
  expect(options["confirm-paid-inference"]).toBeUndefined();
  expect(await readFile(join(directory, "run.json"), "utf8")).toBe(original);
  expect((await (await fetch(origin + "/api/entries")).json()).active).toBeUndefined();
  // The draft stays editable: another fresh setup remains a valid custom composition.
  options.arms = JSON.stringify([...config.prepare.arms!, { launcher: "codex", setup_commit: "HEAD" }]);
  expect(launchConfiguration(options).prepare.arms).toHaveLength(5);
  await file(join(directory, "reports/bundle/report.json"), '{"validity":"invalid"}');
  expect((await post("/api/comparison-draft", { directory })).status).toBe(400);
  expect(await readFile(join(directory, "run.json"), "utf8")).toBe(original);
});

let root: string;
let workbench: ReturnType<typeof serveWorkbench>;
let origin: string;
let token: string;

test("preparation has progress rather than fabricated pair measurements", async () => {
  const source = (await (await fetch(origin + "/app.js")).text()).replace(/\ninit\(\);\s*$/, "");
  for (const status of ["running", "failed", "canceled"]) {
    const input = { entry: { kind: "pair", job: { status } }, artifacts: [], children: [], live: {} };
    const html = runInNewContext(source + "\nresultContent(input)", { input });
    expect(html).toContain(status === "running" ? "Preparing comparison" : "No results collected");
    expect(html).not.toContain("<table>");
    expect(html).not.toContain("Setup unavailable");
    expect(Object.keys(runInNewContext(source + "\nsetupLabels(input)", { input }))).toHaveLength(0);
  }
  const input = { entry: { kind: "pair" }, state: { results: {} },
    arm_labels: { stock: "Original", current: "Previous", "arm-3": "Fresh HEAD" } };
  const html = runInNewContext(source + "\nresultContent(input)", { input });
  expect(html).toContain("Partial results");
  expect(html).toContain("Fresh HEAD");
  expect(html).toContain("<table>");
  const failed = { ...input, entry: { kind: "pair", job: { status: "failed" } },
    state: { status: "prepared", results: {}, finishing: { status: "failed" } }, report: { validity: "invalid" } };
  const failureHtml = runInNewContext(source + "\nresultContent(input)", { input: failed });
  expect(failureHtml).toContain("No results collected");
  expect(failureHtml).not.toContain("<table>");
});

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

test("custom retained evidence exposes every arm log, label, and reversed candidate mapping", async () => {
  const directory = await pair();
  const keys = ["stock", "current", "arm-3"];
  await file(join(directory, "run.json"), JSON.stringify({ schema_version: 1, status: "complete", comparison: "custom", execution: {},
    arms: Object.fromEntries(keys.map(arm => [arm, { launcher: "codex" }])),
    setup_revisions: Object.fromEntries(keys.map((arm, index) => [arm, { commit: String(index).repeat(40) }])) }));
  await file(join(directory, "artifacts/arm-3/codex.jsonl"), '{"type":"thread.started","thread_id":"third-thread"}\n');
  await file(join(directory, "reports/report.json"), JSON.stringify({ winner: "arm-3", arms: Object.fromEntries(keys.map(arm => [arm, {}])),
    judge: { result: { passes: [{ pass: 1, presentation: keys, winner: "candidate-3", scores: {}, rationale: "candidate-3 preserves the required behavior." }] } } }));
  const entry = await attach(directory);
  const input = await (await fetch(`${origin}/api/entries/${entry.id}`)).json();
  expect(input.live["arm-3"]).toContain("third-thread");
  expect(input.artifacts.some((item: { path: string }) => item.path === "artifacts/arm-3/codex.jsonl")).toBe(true);
  const source = (await (await fetch(origin + "/app.js")).text()).replace(/\ninit\(\);\s*$/, "");
  const html = runInNewContext(source + "\nresultContent(input)", { input });
  expect(html).toContain("Overall winner: Codex (setup 222222222222)");
  expect(html).toContain("Codex (setup 222222222222) preserves the required behavior.");
  expect(html).not.toContain("candidate-3 preserves");
});

async function subscribe(id?: string) {
  const abort = new AbortController();
  const response = await fetch(origin + "/api/events" + (id ? "?entry=" + id : ""), { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]) });
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

test.each([false, true])("evidence references preserve the absolute path when clipboard denied is %s", async denied => {
  const source = (await (await fetch(origin + "/app.js")).text()).replace(/\ninit\(\);\s*$/, "");
  const reference = "Booking Ledger\nEvidence directory: /tmp/evidence with spaces\nWorkbench entry: entry-id";
  let copied = "", focused = false, selected = false;
  const field = { value: reference, hidden: true, focus: () => { focused = true; }, select: () => { selected = true; } };
  const status = { hidden: true, textContent: "", classList: { toggle() {} } };
  await runInNewContext(source + "\ncopyReference()", {
    document: { getElementById: (id: string) => id === "run-reference" ? field : status },
    navigator: { clipboard: { writeText: async (text: string) => { if (denied) throw new Error("Clipboard denied"); copied = text; } } },
  });
  expect(copied).toBe(denied ? "" : reference);
  expect(field.hidden).toBe(!denied);
  expect(focused && selected).toBe(denied);
  expect(status.hidden).toBe(false);
  expect(status.textContent).toContain(denied ? "Copy the selected reference" : "Evidence reference copied");
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

test.each([
  { name: "pending judge", status: undefined, exitCode: -1, passed: false, label: "Not graded" },
  { name: "unassessed criteria", status: "unassessed", exitCode: 0, passed: false, label: "Not graded" },
  { name: "missing semantic pass", status: "pass", missingPass: true, exitCode: 0, passed: false, label: "Not graded" },
  { name: "missing criterion coverage", status: "pass", missingCriterion: true, exitCode: 0, passed: false, label: "Not graded" },
  { name: "executed failure with another pass unassessed", status: "fail", exitCode: -1, passed: false, label: "Failed" },
  { name: "source-only failure with another pass unassessed", status: "fail", basis: "source-only", exitCode: -1, passed: false, label: "Failed" },
  { name: "completed preparation failure", status: "pass", exitCode: 0, preparationExit: 1, passed: false, label: "Failed" },
  { name: "completed passing grade", status: "pass", exitCode: 0, passed: true, label: "Passed" },
  { name: "evaluator error", status: "fail", exitCode: 0, passed: false, evaluatorError: "Infrastructure failed", label: "Not graded" },
])("behavioral grade displays $label for $name before and after reporting", async scenario => {
  const directory = await pair();
  const command = (exitCode: number) => ({ command: "check", exit_code: exitCode });
  const assessed = { criterion: "behavior", status: "pass", basis: "executed", reasoning: "Executed check" };
  const criteria = { contract: { criteria: [{ id: "behavior", description: "Required behavior" },
    ...(scenario.missingCriterion ? [{ id: "other", description: "Other required behavior" }] : [])] } };
  const result = { grade: {
    preparation: command(scenario.preparationExit ?? 0), router_suite: command(scenario.exitCode),
    passed: scenario.passed, evaluator_error: scenario.evaluatorError,
    semantic: scenario.status === undefined ? undefined : {
      "pass-1": [{ ...assessed, status: scenario.status === "pass" ? "pass" : "unassessed" }],
      "pass-1-existing": [assessed],
      ...(scenario.missingPass ? {} : {
        "pass-2": [{ ...assessed, status: scenario.status, basis: scenario.basis ?? "executed" }],
        "pass-2-existing": [assessed],
      }),
    },
  } };
  await file(join(directory, "run.json"), JSON.stringify({ schema_version: 1, status: "complete", criteria, results: { stock: result },
    judge: { status: scenario.exitCode === -1 ? "failed" : "complete" } }));
  const entry = await attach(directory);
  const source = (await (await fetch(origin + "/app.js")).text()).replace(/\ninit\(\);\s*$/, "");
  const tone = scenario.label === "Not graded" ? "unassessed" : scenario.passed ? "pass" : "fail";
  const chip = `<span class="status-chip ${tone}">${scenario.label}</span>`;
  const render = async () => {
    const input = await (await fetch(`${origin}/api/entries/${entry.id}`)).json();
    return { input, html: runInNewContext(source + "\nresultContent(input)", { input }) };
  };
  expect((await render()).html).toContain('<tr><th>Behavioral grade</th><td class="metric a">' + chip + "</td>");
  await file(join(directory, "reports/report.json"), JSON.stringify({ criteria, arms: { stock: { result } } }));
  const reported = await render();
  expect(reported.html).toContain('<tr><th>Behavioral grade</th><td class="metric a">' + chip + "</td>");
  expect(reported.html).toContain('<article class="verdict-card a"><h4>' + reported.input.arm_labels.stock + "</h4>" + chip);
});

test("source assessments replace numbered identities using each pass's presentation order", async () => {
  const directory = await pair();
  const report = {
    arm_labels: { stock: "Direct Codex", current: "Codex + Mekugi" }, winner: "current",
    current_minus_stock_percent: { agent_elapsed_ms: 8.33, estimated_api_usd: -12.5, total_tokens: null },
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
  expect(rendered).toContain("Pass 1 winner: Codex + Mekugi");
  expect(rendered).toContain("Pass 2 winner: Codex + Mekugi");
  expect(rendered).toContain("Pass 3 winner: Unmapped setup");
  expect(rendered).toContain("pass 3 chose Unmapped setup");
  expect(rendered).toContain('<td class="metric a">3</td><td class="metric ">Unknown</td><td class="metric ">Unknown</td><td class="metric b lead">4</td>');
  expect(rendered).toContain("Direct Codex inspected &lt;main&gt;");
  expect(rendered).toContain("Direct Codex added checks");
  expect(rendered).toContain("Direct Codex met the criterion");
  expect(rendered).toContain("Direct Codex check succeeded");
  expect(rendered).not.toContain("Codex + Mekugi met the criterion");
  expect(rendered).toContain("Overall winner: Codex + Mekugi");
  expect(rendered).not.toMatch(/candidate[-_ ]([12])|>A[: ]|>B[: ]/i);
  const overview = rendered.split('<details class="tree">')[0];
  expect(overview).not.toMatch(/<details(?! class="(?:criterion-reasoning|assessment-details)")/);
  expect(overview).toContain('<summary>Full evidence and issues</summary>');
  expect(overview).toContain('<span class="status-chip pass">P1 · pass</span>');
  expect(overview).toContain("Direct Codex inspected &lt;main&gt;");
  expect(overview).toContain("Direct Codex added checks");
  expect(overview).toContain("constructor");
  expect(overview).toContain("Direct Codex met the criterion");
  expect(overview).toContain("+8.33%");
  expect(overview).toContain("-12.5%");
  expect(overview).toContain("Not available");
  expect(overview).toContain("Change compares Codex + Mekugi with Direct Codex");
  expect(rendered).toContain("<summary>Technical report</summary>");
  expect(rendered).not.toMatch(/<summary>(Criterion evidence and grading|Source assessments and judge reasoning|Time, token and cost differences|Usage details and pricing provenance|Diagnostics and workflow evidence)/);
  expect(input.report).toEqual(report);
});

test("resource explanations render recorded accounting and preserve unknown workflow causes", async () => {
  const directory = await pair();
  await file(join(directory, "reports/report.json"), JSON.stringify({
    arms: { stock: {}, current: {} },
    resource_explanation: explainResources([{ arm: "stock", label: "<Direct>" }, { arm: "current", label: "Router" }]),
    judge: { result: { passes: [{ pass: 1, presentation: ["stock", "current"], winner: "none", rationale: "A concrete implementation cause" }] } },
  }));
  const entry = await attach(directory);
  const input = await (await fetch(`${origin}/api/entries/${entry.id}`)).json();
  const source = (await (await fetch(origin + "/app.js")).text()).replace(/\ninit\(\);\s*$/, "");
  const rendered = runInNewContext(source + "\nresultContent(input)", { input });
  expect(rendered).toContain("Why token and request usage differs");
  expect(rendered).toContain("Router versus &lt;Direct&gt;: resource differences are unknown");
  expect(rendered).toContain("recorded workflow does not establish why extra requests occurred");
  expect(rendered).not.toContain("<Direct>");
  input.state.invalidity_reasons = ["Evaluator evidence invalidated"];
  const invalidated = runInNewContext(source + "\nresultContent(input)", { input });
  expect(invalidated).not.toContain("Source assessment: why quality differs");
  expect(invalidated).toContain("Why token and request usage differs");
});

test("setup output renders Markdown and activity without exposing event payloads", async () => {
  const directory = await pair();
  const events = [
    { type: "thread.started", thread_id: "hidden-thread" },
    { type: "item.started", item: { id: "tool", type: "command_execution", command: "mjournal hidden-transport", status: "in_progress" } },
    { type: "item.completed", item: { id: "tool", type: "command_execution", command: "mjournal hidden-transport", aggregated_output: '{"items":["/3"]}', exit_code: 0 } },
    { type: "item.updated", item: { id: "answer", type: "agent_message", text: "Partial answer" } },
    { type: "item.completed", item: { id: "answer", type: "agent_message", text: '# Result\n\n**All 26 tests passed.**\n\n- Concurrent writers\n- Rollback checks\n\n```sh\npython3 -m unittest discover -s tests -v\n```\n\n[Documentation](https://example.org/docs)\n\n| Check | Result |\n| --- | --- |\n| CLI | Passed |' } },
    { type: "item.completed", item: { type: "command_execution", exit_code: 2 } },
    { method: "item/completed", params: { threadId: "hidden-headless-thread", item: {
      id: "headless-answer", type: "agentMessage", text: "## Headless result\n\n**App-server output.**\n\n<script>alert(1)</script>",
    } } },
    { type: "turn.failed", error: { message: "Process <failed>" } },
    { type: "unknown", private_payload: "hidden-payload" },
  ];
  const raw = events.map(event => JSON.stringify(event)).join("\n") + "\n";
  await file(join(directory, "artifacts/current/codex.jsonl"), raw);
  const entry = await attach(directory);
  const snapshot = await (await fetch(`${origin}/api/entries/${entry.id}`)).json();
  const rendered = snapshot.live_html.current;
  expect(rendered).toContain("<h1>Result</h1>");
  expect(rendered).toContain("<strong>All 26 tests passed.</strong>");
  expect(rendered).toContain("<li>Concurrent writers</li>");
  expect(rendered).toContain("<pre><code>python3 -m unittest discover -s tests -v\n</code></pre>");
  expect(rendered).toContain('href="https://example.org/docs"');
  expect(rendered).toContain("<th>Check</th>");
  expect(rendered).toContain("Command completed (exit 0)");
  expect(rendered).toContain("Command failed (exit 2)");
  expect(rendered).toContain("<h2>Headless result</h2>");
  expect(rendered).toContain("<strong>App-server output.</strong>");
  expect(rendered).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(rendered).toContain("Process &lt;failed&gt;");
  expect(rendered).not.toMatch(/hidden-|aggregated_output|item.completed|Partial answer|in progress|<script>/);
  expect(snapshot.live.current).toBe(raw);
  expect(await (await fetch(`${origin}/api/entries/${entry.id}/artifacts?path=artifacts/current/codex.jsonl`)).text()).toBe(raw);
});

test("headless setup output retains activity progress, outcomes, and escaped provider errors", async () => {
  const directory = await pair();
  const event = (method: string, item: object) => ({ method, params: { threadId: "hidden-thread", turnId: "hidden-turn", item } });
  const events = [
    event("item/started", { id: "cmd", type: "commandExecution", status: "inProgress", command: "hidden-command" }),
    event("item/started", { id: "tool", type: "mcpToolCall", status: "inProgress", arguments: { value: "hidden-arguments" } }),
    event("item/completed", { id: "files", type: "fileChange", changes: [{ path: "hidden-path" }] }),
    event("item/completed", { id: "search", type: "webSearch", query: "hidden-query" }),
    { method: "error", params: { error: { message: "provider <failed>", data: "hidden-error-data" } } },
  ];
  const path = join(directory, "artifacts/current/codex.jsonl");
  await file(path, events.map(event => JSON.stringify(event)).join("\n") + "\n");
  const entry = await attach(directory);
  const snapshot = async () => (await (await fetch(`${origin}/api/entries/${entry.id}`)).json()).live_html.current as string;
  const started = await snapshot();
  expect(started).toContain("Command in progress");
  expect(started).toContain("Tool call in progress");
  expect(started).toContain("File changes completed");
  expect(started).toContain("Web search completed");
  expect(started).toContain("provider &lt;failed&gt;");
  expect(started).not.toMatch(/hidden-|<failed>|commandExecution|mcpToolCall/);
  events.push(event("item/completed", { id: "cmd", type: "commandExecution", status: "failed", exitCode: 2, aggregatedOutput: "hidden-output" }),
    event("item/completed", { id: "tool", type: "mcpToolCall", status: "failed" }));
  await file(path, events.map(event => JSON.stringify(event)).join("\n") + "\n");
  const completed = await snapshot();
  expect(completed).toContain("Command failed (exit 2)");
  expect(completed).toContain("Tool call failed");
  expect(completed).not.toMatch(/in progress|hidden-/);
});

test("Markdown output escapes active content and handles bounded and partial event records", async () => {
  const directory = await pair();
  const message = (text: string) => JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } });
  const path = join(directory, "artifacts/stock/codex.jsonl");
  const unsafe = '<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>\n\n[bad](javascript:alert%281%29) [encoded](jav&#x61;script:alert%281%29) ![Image label](https://example.org/tracker)\n\n`<inline>`\n\n```html\n<img onerror="bad">\n```';
  const malformedTypes = [{ type: { toString: null } }, { type: "item.completed", item: { type: { toString: null } } }];
  await file(path, message("old-prefix".repeat(2000)) + "\n" + malformedTypes.map(event => JSON.stringify(event)).join("\n") + "\n" + message(unsafe) + '\n{"type":"item.completed","item":');
  const entry = await attach(directory);
  const stream = await subscribe(entry.id);
  try {
    const rendered = (await stream.next("snapshot")).live_html.stock;
    expect(rendered).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(rendered).toContain("<code>&lt;inline&gt;</code>");
    expect(rendered).toContain('<pre><code>&lt;img onerror=&quot;bad&quot;&gt;\n</code></pre>');
    expect(rendered).toContain("Image label");
    expect(rendered).not.toMatch(/<script|<img|href="javascript|old-prefix|item.completed|tracker/);
    await file(path, message("## Live update\n\nReadable **Markdown**.") + "\n");
    expect((await stream.next("snapshot", data => data.live_html.stock.includes("Live update"))).live_html.stock).toContain("<strong>Markdown</strong>");
  } finally { stream.close(); }
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
}, 15000);

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

test("web Mekugi settings serialize unchecked and checked toggles and omit disabled controls", async () => {
  const source = (await (await fetch(origin + "/app.js")).text()).replace(/\ninit\(\);\s*$/, "");
  const toggles = [
    { name: "mekugi-shell-guard", type: "checkbox", checked: false, disabled: false },
    { name: "mekugi-deduplicate-output", type: "checkbox", checked: true, disabled: true },
    { name: "mekugi-child-reply-summary", type: "checkbox", checked: true, disabled: false },
  ];
  const elements = { "launch-form": { querySelectorAll: () => toggles }, "prepare-only": { checked: false }, "paid-consent": { checked: true },
    "imported-arms": { children: [] },
    ...Object.fromEntries(toggles.map(input => ["f-" + input.name, input])),
    "f-mekugi-ansi-faint": { value: "off" }, "f-mekugi-timeout": { value: "30s" }, "f-mekugi-stream-idle-timeout": { value: "" },
  };
  const body = runInNewContext(source + '\nlaunchRequest()', {
    document: { getElementById: (id: keyof typeof elements) => elements[id] },
    FormData: class { *[Symbol.iterator]() { yield ["mekugi-timeout", "30s"]; yield ["mekugi-ansi-faint", "off"]; } },
  });
  expect(body).toEqual({ command: "launch", options: {
    "mekugi-flags": '["--shell-guard=false","--child-reply-summary=true","--ansi-faint=off","--timeout=30s"]', "confirm-paid-inference": true,
  } });
});

test("a pinned-repository task check announces the clone without starting work", async () => {
  const codex = join(root, "codex");
  for (const path of [codex, join(root, "codex-code-mode-host")]) {
    await file(path, "#!/bin/sh\nexit 0\n");
    await chmod(path, 0o755);
  }
  const source = join(root, "missing sqlite-utils checkout");
  const options = { task: "sqlite-utils-history", source, "prepare-only": true, "current-home": root, "codex-bin": codex, "docker-bin": "/bin/false", "mekugi-source": root, "mekugi-bin": codex };
  const catalog = (await (await fetch(origin + "/api/config")).json()).tasks;
  expect(catalog.find((task: { id: string }) => task.id === "sqlite-utils-history")).toMatchObject({ repository: "https://github.com/simonw/sqlite-utils.git", preset: "stock-mekugi", compactLimit: 200000 });
  const checked = await post("/api/check", { command: "launch", options });
  expect(checked.status).toBe(200);
  expect((await checked.json()).warnings).toContain(`The sqlite-utils multi-commit upgrade checkout will be cloned to ${source} from https://github.com/simonw/sqlite-utils.git`);
  expect((await (await fetch(origin + "/api/entries")).json()).entries).toEqual([]);
  expect((await post("/api/check", { command: "launch", options: { ...options, task: "session-retention" } })).status).toBe(400);
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

test.each([false, true])("web parallel work serializes checked=%s", async checked => {
  const source = (await (await fetch(origin + "/app.js")).text()).replace(/\ninit\(\);\s*$/, "");
  const body = runInNewContext(source + '\nformOptions({ querySelectorAll: () => [{ name: "parallel-work", checked, disabled: false }] })', {
    checked, FormData: class { *[Symbol.iterator]() {} },
  });
  expect(body).toEqual(checked ? { "parallel-work": true } : {});
});

test.each(["EMFILE", "ENFILE", "ENOSPC"])("SSE keeps evidence live when watchers fail with %s", async code => {
  const directory = await pair();
  const entry = await attach(directory);
  const watcher = spyOn(fs, "watch").mockImplementation(() => { throw Object.assign(new Error("watch unavailable"), { code }); });
  const stream = await subscribe(entry.id);
  try {
    expect((await stream.next("snapshot")).state.status).toBe("complete");
    await file(join(directory, "run.json"), JSON.stringify({ schema_version: 1, status: "partial" }));
    expect((await stream.next("snapshot", data => data.state.status === "partial")).state.status).toBe("partial");
    expect(watcher).toHaveBeenCalledTimes(1);
  } finally {
    stream.close();
    await workbench.shutdown();
    watcher.mockRestore();
  }
});


test("setup commit identities label retained pair and trial evidence", async () => {
  const identity = { comparison: "setup-commits", execution: { current_launcher: "mekugi" },
    setup_revisions: { stock: { commit: "a".repeat(40) }, current: { commit: "b".repeat(40) } } };
  for (const kind of ["pair", "trials"]) {
    const directory = join(root, kind);
    await file(join(directory, kind === "pair" ? "run.json" : "trials.json"), JSON.stringify(kind === "pair"
      ? { schema_version: 1, ...identity } : { schema: "codex-ab.trials.v1", controls: identity, trials: [] }));
    const entry = await attach(directory);
    const detail = await (await fetch(`${origin}/api/entries/${entry.id}`)).json();
    expect(detail.arm_labels).toEqual({ stock: "Codex + Mekugi (setup aaaaaaaaaaaa)", current: "Codex + Mekugi (setup bbbbbbbbbbbb)" });
  }
});
