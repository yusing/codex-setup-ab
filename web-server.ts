import { constants, watch, type FSWatcher } from "node:fs";
import { access, lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { networkInterfaces } from "node:os";
import { BOOLEAN_FLAGS, COMMAND_OPTIONS, type CliOptions } from "./cli-options";
import { COMPARISONS, launchConfiguration, launchDefaults, taskCatalog } from "./launch";
import { exec } from "./process";
import { loadTaskPack } from "./task-pack";
import { armLabels } from "./arm-labels";
import { renderSetupOutput } from "./web-output";
import type { RunState } from "./types";
import html from "./web/index.html" with { type: "text" };
import css from "./web/style.css" with { type: "text" };
import javascript from "./web/app.js" with { type: "text" };
import interfaceFont from "./web/fonts/ibm-plex-sans-latin.woff2" with { type: "file" };
import fontLicense from "./web/fonts/OFL.txt" with { type: "text" };

type JsonObject = Record<string, unknown>;
type Kind = "pair" | "trials" | "suite" | "build";
type JobStatus = "running" | "stopping" | "complete" | "failed" | "canceled";
interface Entry {
  id: string;
  title: string;
  kind: Kind;
  directory?: string;
  job?: { command: string; status: JobStatus; startedAt: string; finishedAt?: string; error?: string; log: string };
}
interface RequestBody { command: string; options: CliOptions; entryId?: string }
interface Artifact { path: string; bytes: number }
const PAID = new Set(["run", "judge", "finish", "run-trials", "run-suite"]);
const ACTIONS: Record<Kind, string[]> = {
  pair: ["preflight", "run", "prepare-trials", "judge", "finish", "report", "remeter", "invalidate"],
  trials: ["run-trials", "report-trials"], suite: ["run-suite", "report-suite"], build: [],
};
const MARKERS: [Kind, string, string | number][] = [
  ["pair", "run.json", 1], ["trials", "trials.json", "codex-ab.trials.v1"],
  ["suite", "suite.json", "codex-ab.suite-run.v1"], ["build", "build.json", "codex-ab.mekugi-build.v1"],
];
const json = (value: unknown, status = 200) => Response.json(value, { status });
const object = (value: unknown): JsonObject => value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

async function safeFile(root: string, path: string): Promise<string> {
  const target = await realpath(join(root, path));
  const local = relative(root, target);
  if (!local || local.startsWith("..") || resolve(root, local) !== target || !await stat(target).then(info => info.isFile())) throw new Error("Artifact is outside the selected evidence directory");
  return target;
}
async function readJson(root: string, path: string): Promise<JsonObject | undefined> {
  try { return object(await Bun.file(await safeFile(root, path)).json()); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
async function marker(directory: string): Promise<{ kind: Kind; state: JsonObject }> {
  for (const [kind, file, schema] of MARKERS) {
    const state = await readJson(directory, file);
    if (state && (state.schema ?? state.schema_version) === schema) return { kind, state: kind === "build" ? { ...state, status: "complete" } : state };
  }
  try {
    await safeFile(directory, "build_inputs.py");
    const result = await readJson(directory, "build-result.json");
    return { kind: "build", state: { status: result?.canceled ? "canceled" : result && (result.exitCode !== 0 || result.timedOut) ? "failed" : "incomplete", result } };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  throw new Error("Choose a benchmark run, trial-set, suite, or captured-build directory");
}
async function tail(root: string, path: string): Promise<string> {
  try {
    const file = await open(await safeFile(root, path), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const size = (await file.stat()).size;
      const buffer = Buffer.alloc(Math.min(size, 16001));
      const start = Math.max(0, size - buffer.length);
      await file.read(buffer, 0, buffer.length, start);
      const text = buffer.toString("utf8");
      return start && path.endsWith(".jsonl") ? text.slice(text.indexOf("\n") + 1) : text;
    } finally { await file.close(); }
  } catch { return ""; }
}
async function artifactList(root: string, kind: Kind): Promise<Artifact[]> {
  const paths = kind === "pair" ? ["run.json", "reports", "artifacts/stock", "artifacts/current"]
    : kind === "trials" ? ["trials.json", "reports"] : kind === "suite" ? ["suite.json"] : ["build.json", "build-result.json", "build.stdout", "build.stderr"];
  if (kind === "suite") {
    for (const file of await readdir(root)) if (/^report-[A-Za-z0-9]+$/.test(file)) paths.push(file);
  }
  const found: Artifact[] = [];
  async function visit(path: string, depth: number): Promise<void> {
    if (found.length >= 500 || depth > 7 || path.split("/").some(part => /^(?:homes?|arms|templates|\.codex|\.grok|auth\.json)$/.test(part))) return;
    const file = join(root, path);
    let info;
    try { info = await lstat(file); } catch { return; }
    if (info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      for (const child of await readdir(file)) await visit(path + "/" + child, depth + 1);
    } else if (info.isFile() && (/(?:\.jsonl?|\.md|\.patch|\.txt|\.log|\.csv|\.sha256|\.stderr|\.stdout)$/.test(path) || path.endsWith("MANIFEST.sha256"))) {
      if (path.startsWith("artifacts/") && !/(?:codex\.jsonl|codex\.stderr|changes\.patch|result\.json)$/.test(path)) return;
      await safeFile(root, path);
      found.push({ path, bytes: info.size });
    }
  }
  for (const path of paths) await visit(path, 0);
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

export function serveWorkbench(port = 4849, hostname = "127.0.0.1") {
  const token = randomUUID();
  const entries = new Map<string, Entry>();
  let active: { entry: Entry; child?: ReturnType<typeof Bun.spawn>; canceled: boolean; finished?: Promise<void> } | undefined;
  const cli = import.meta.path.includes("$bunfs") ? [process.execPath] : [process.execPath, join(import.meta.dir, "cli.ts")];
  const defaults = launchDefaults();
  const subscribers = new Set<() => void>();
  const streams = new Set<() => void>();
  const notify = () => { for (const update of subscribers) update(); };
  const entryList = () => ({ entries: [...entries.values()].map(entry => ({ id: entry.id, title: entry.title, kind: entry.kind, directory: entry.directory, job: entry.job ? { status: entry.job.status } : undefined })), active: active?.entry.id });

  async function attach(directory: string, entry?: Entry): Promise<Entry> {
    const root = await realpath(resolve(directory));
    const existing = [...entries.values()].find(item => item.directory === root);
    if (existing && !entry) return existing;
    const { kind } = await marker(root);
    const result = entry ?? { id: randomUUID(), title: root.split("/").at(-1)!, kind };
    result.directory = root; result.kind = kind;
    entries.set(result.id, result);
    notify();
    return result;
  }
  function bodyOptions(value: unknown, command: string): CliOptions {
    const input = object(value);
    const allowed = COMMAND_OPTIONS[command];
    if (!allowed) throw new Error("Unsupported workbench command");
    const options: CliOptions = {};
    for (const [key, value] of Object.entries(input)) {
      if (!allowed.includes(key)) throw new Error("Unknown option for " + command + ": " + key);
      if (BOOLEAN_FLAGS.has(key) ? typeof value !== "boolean" : typeof value !== "string" || !value.trim()) throw new Error("Invalid value for " + key);
      if (value !== false) options[key] = value as string | boolean;
    }
    return options;
  }
  async function validate(body: JsonObject, consent: boolean): Promise<{ request: RequestBody; warnings: string[] }> {
    const command = String(body.command ?? "");
    if (command === "serve" || !Object.hasOwn(COMMAND_OPTIONS, command)) throw new Error("Choose a supported operation");
    const options = bodyOptions(body.options, command);
    const entry = typeof body.entryId === "string" ? entries.get(body.entryId) : undefined;
    if (entry) {
      if (!entry.directory || !ACTIONS[entry.kind].includes(command)) throw new Error("This operation does not apply to the selected evidence");
      const target = entry.kind === "pair" ? "run-dir" : entry.kind === "trials" ? "trial-set" : "suite-run";
      options[target] = entry.directory;
    } else if (!["launch", "prepare-suite", "build-mekugi"].includes(command)) {
      throw new Error("Attach the existing evidence directory first");
    }
    const warnings: string[] = [];
    const required = async (path: string, label: string, directory = false, executable = false) => {
      try {
        const actual = executable ? Bun.which(path) ?? path : path;
        const info = await stat(actual);
        if (directory ? !info.isDirectory() : !info.isFile()) throw new Error();
        await access(actual, executable ? constants.X_OK : constants.R_OK);
      } catch { throw new Error(label + " is unavailable: " + path); }
    };
    const paid = PAID.has(command) || command === "launch" && options["prepare-only"] !== true || command === "prepare-suite" && body.runAfterPrepare === true;
    if (consent && paid && options["confirm-paid-inference"] !== true && body.confirmPaid !== true) throw new Error("Confirm paid inference for this operation before starting");
    if (command === "launch") {
      const config = launchConfiguration(options);
      const sourceExists = await stat(config.prepare.source).then(info => info.isDirectory()).catch(() => false);
      const task = taskCatalog().find(item => item.id === (options.task ?? launchDefaults().task));
      if (!sourceExists && task?.repository) warnings.push(`The ${task.title} checkout will be cloned to ${config.prepare.source} from ${task.repository}`);
      else await required(config.prepare.source, "Source checkout", true);
      await required(config.prepare.currentHome, "Current setup home", true);
      await required(config.prepare.codexBinary!, "Codex executable", false, true);
      await required(join(dirname(await realpath(config.prepare.codexBinary!)), "codex-code-mode-host"), "Code-mode host", false, true);
      await required(config.docker, "Docker executable", false, true);
      await required(config.prepare.taskPackPath ?? config.prepare.taskPath, "Task contract");
      const pack = config.prepare.taskPackPath ? await loadTaskPack(config.prepare.taskPackPath) : undefined;
      if (config.prepare.criteriaPath) await required(config.prepare.criteriaPath, "Criteria file");
      if (config.prepare.outputParent) await required(config.prepare.outputParent, "Output parent", true);
      if (config.prepare.mekugiBuild) await required(config.prepare.mekugiBuild, "Captured build", true);
      else if (config.prepare.mekugiSource) {
        await required(config.prepare.mekugiSource, "Mekugi source", true);
        await required(config.prepare.mekugiBinary!, "Mekugi executable", false, true);
      }
      if (config.prepare.grokBinary) await required(config.prepare.grokBinary, "Grok executable", false, true);
      if (!config.prepareOnly) {
        await required(config.auth, "Codex authentication file");
        if (config.prepare.comparison === "codex-mekugi-grok") await required(config.grokAuth, "Grok authentication file");
      }
      if (sourceExists) {
        const probe = await exec(["git", "-C", config.prepare.source, "rev-parse", "--git-dir"], { timeoutMs: 5000 });
        if (probe.exitCode !== 0) throw new Error("Source must be a Git checkout");
        for (const commit of [pack?.manifest.source.base_commit ?? config.prepare.baseCommit, pack?.manifest.source.forbidden_commit ?? config.prepare.forbiddenCommit]) {
          const revision = await exec(["git", "-C", config.prepare.source, "cat-file", "-e", commit + "^{commit}"], { timeoutMs: 5000 });
          if (revision.exitCode !== 0) throw new Error("Source checkout is missing pinned commit " + commit);
        }
      }
      warnings.push("Preparation verifies pinned commits and local inputs. Missing or stale container images are rebuilt before inference.");
    } else {
      const requiredKeys: Record<string, string[]> = {
        "prepare-suite": ["suite", "sources-file", "count"], "build-mekugi": ["source", "image"],
        "prepare-trials": ["count"], remeter: ["exclusions"], invalidate: ["reason"],
      };
      for (const key of requiredKeys[command] ?? []) if (!options[key]) throw new Error(key + " is required");
      if (options.count && (!/^\d+$/.test(String(options.count)) || !Number.isSafeInteger(Number(options.count)) || Number(options.count) < 2)) throw new Error("Repeat count must be an integer of at least two");
      if (options.order && !["concurrent", "alternating"].includes(String(options.order))) throw new Error("Choose concurrent or alternating order");
      if (command === "prepare-suite" && options.comparison && options.comparison !== "stock-current") throw new Error("Suites support minimal versus current setup");
      for (const key of ["suite", "sources-file", "exclusions", "source-assessments"]) if (options[key]) await required(String(options[key]), key);
      if (command === "build-mekugi") await required(String(options.source), "Mekugi source", true);
      if (paid) await required(String(options["auth-file"] ?? body.authFile ?? defaults["auth-file"]), "Codex authentication file");
    }
    return { request: { command, options, entryId: entry?.id }, warnings };
  }
  function log(entry: Entry, value: string) {
    if (entry.job && value) {
      entry.job.log = (entry.job.log + value).slice(-64000);
      notify();
    }
  }
  async function childCommand(entry: Entry, command: string, options: CliOptions): Promise<void> {
    if (!active || active.canceled) throw new Error("Operation canceled before launch");
    const argv = [command];
    for (const [key, value] of Object.entries(options)) {
      if (value === true) argv.push("--" + key);
      else if (typeof value === "string") argv.push("--" + key, value);
    }
    const child = Bun.spawn([...cli, ...argv], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    active.child = child;
    async function consume(stream: ReadableStream<Uint8Array>, stdout: boolean) {
      const decoder = new TextDecoder();
      let pending = "";
      for await (const bytes of stream) {
        const text = decoder.decode(bytes, { stream: true });
        log(entry, text);
        pending += text;
        const lines = pending.split("\n"); pending = lines.pop()!.slice(-8192);
        for (const line of lines) {
          try {
            if (stdout && line.startsWith("/")) await attach(line.trim(), entry);
            if (!stdout && line.startsWith("[build-directory] ")) await attach(JSON.parse(line.slice("[build-directory] ".length)), entry);
          } catch { /* other phase messages and report paths are not evidence directories */ }
        }
      }
      log(entry, decoder.decode());
    }
    await Promise.all([consume(child.stdout, true), consume(child.stderr, false)]);
    const code = await child.exited;
    if (code !== 0) throw new Error(command + " exited " + code + "; see the phase log");
  }
  async function start(body: JsonObject): Promise<Entry> {
    if (active) throw new Error("An operation is active. Stop it or wait for completion");
    const { request } = await validate(body, true);
    if (active) throw new Error("An operation is active. Stop it or wait for completion");
    const original = request.entryId ? entries.get(request.entryId)! : undefined;
    const entry = original ?? { id: randomUUID(), title: request.command === "launch" ? String(request.options.task ?? defaults.task) : request.command, kind: request.command === "prepare-suite" ? "suite" : request.command === "build-mekugi" ? "build" : "pair" };
    entry.job = { command: request.command, status: "running", startedAt: new Date().toISOString(), log: "" };
    entries.set(entry.id, entry);
    active = { entry, canceled: false };
    notify();
    const owned = active;
    owned.finished = (async () => {
      try {
        await childCommand(entry, request.command, request.options);
        if (request.command === "prepare-suite" && body.runAfterPrepare === true) {
          if (!entry.directory) throw new Error("Prepared suite directory was not reported");
          await childCommand(entry, "run-suite", {
            "suite-run": entry.directory, "confirm-paid-inference": true,
            "auth-file": String(body.authFile ?? defaults["auth-file"]),
            "docker-bin": String(request.options["docker-bin"] ?? defaults["docker-bin"]),
          });
        }
        entry.job!.status = owned.canceled ? "canceled" : "complete";
      } catch (error) {
        entry.job!.status = owned.canceled ? "canceled" : "failed";
        entry.job!.error = message(error);
      } finally {
        entry.job!.finishedAt = new Date().toISOString();
        if (active === owned) active = undefined;
        notify();
      }
    })();
    return entry;
  }
  async function snapshot(entry: Entry) {
    if (!entry.directory) return { entry, artifacts: [], children: [], live: {} };
    const { state } = await marker(entry.directory);
    const artifacts = await artifactList(entry.directory, entry.kind);
    const reports = artifacts.filter(file => entry.kind === "trials" ? /^reports\/aggregate-[A-Za-z0-9]+\/report\.json$/.test(file.path) : /^report-[A-Za-z0-9]+\/report\.json$/.test(file.path));
    let report: JsonObject | undefined;
    if (entry.kind === "pair") report = await readJson(entry.directory, "reports/report.json");
    else {
      const candidates = await Promise.all(reports.map(async file => ({ path: file.path, time: (await stat(join(entry.directory!, file.path))).mtimeMs })));
      candidates.sort((a, b) => b.time - a.time);
      if (candidates[0]) report = await readJson(entry.directory, candidates[0].path);
    }
    const children: { id: string; title: string; kind: Kind; directory: string; status: unknown; error?: unknown }[] = [];
    const paths = entry.kind === "trials" && Array.isArray(state.trials) ? state.trials.map(value => object(value).run_dir)
      : entry.kind === "suite" && Array.isArray(state.sets) ? state.sets.map(value => object(value).trial_set) : [];
    for (const path of paths) {
      if (typeof path !== "string" || !(entry.kind === "trials" ? /^runs\/\d+$/.test(path) : /^(?:codex-ab-trials|task-runs)-[A-Za-z0-9]+$/.test(path))) continue;
      try {
        const root = await realpath(join(entry.directory, path));
        if (relative(entry.directory, root).startsWith("..")) continue;
        const child = await attach(root);
        const { state: childState } = await marker(root);
        children.push({ id: child.id, title: child.title, kind: child.kind, directory: root, status: childState.status, error: childState.error });
      } catch { /* preparation can expose a child before its marker exists */ }
    }
    const live: Record<string, string> = {};
    if (entry.kind === "pair") for (const arm of ["stock", "current"]) live[arm] = await tail(entry.directory, "artifacts/" + arm + "/codex.jsonl");
    if (entry.kind === "build") {
      live.build = await tail(entry.directory, "build.stdout");
      live["build stderr"] = await tail(entry.directory, "build.stderr");
    }
    const labelState = entry.kind === "trials" ? object(state.controls) : state;
    const labels = entry.kind === "pair" || entry.kind === "trials" ? armLabels({
      comparison: labelState.comparison as RunState["comparison"],
      execution: object(labelState.execution) as RunState["execution"],
    }) : undefined;
    const live_html = entry.kind === "pair" ? Object.fromEntries(Object.entries(live).map(([arm, text]) => [arm, renderSetupOutput(text)])) : {};
    return { entry, state, report, arm_labels: labels, artifacts, children, live, live_html };
  }
  function events(req: Request, entry?: Entry): Response {
    const encoder = new TextEncoder();
    const watchers = new Map<string, { watcher: FSWatcher; identity: string }>();
    const previous = new Map<string, string>();
    let closed = false, running = false, dirty = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let controller: ReadableStreamDefaultController<Uint8Array>;
    function close() {
      if (closed) return;
      closed = true;
      clearTimeout(timer); clearInterval(heartbeat);
      for (const { watcher } of watchers.values()) watcher.close();
      subscribers.delete(schedule); streams.delete(close);
      req.signal.removeEventListener("abort", close);
      try { controller.close(); } catch { /* The response may already be canceled. */ }
    }
    function send(event: string, value: unknown) {
      const data = JSON.stringify(value);
      if (closed || previous.get(event) === data) return;
      if (controller.desiredSize !== null && controller.desiredSize <= 0) { close(); return; }
      previous.set(event, data);
      controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
    }
    async function observe(data: Awaited<ReturnType<typeof snapshot>>) {
      if (closed || !entry?.directory) return;
      const root = entry.directory;
      // Watch evidence only, not the private homes and source trees in a run.
      const paths = new Map<string, boolean>([[root, false]]);
      paths.set(dirname(root), false);
      if (entry.kind === "pair") {
        for (const path of ["artifacts", "artifacts/stock", "artifacts/current"]) paths.set(join(root, path), false);
      }
      if (entry.kind === "trials") paths.set(join(root, "runs"), false);
      if (entry.kind === "pair" || entry.kind === "trials") paths.set(join(root, "reports"), true);
      if (entry.kind === "suite") for (const name of await readdir(root)) {
        if (/^report-[A-Za-z0-9]+$/.test(name)) paths.set(join(root, name), true);
      }
      for (const child of data.children) paths.set(child.directory, false);
      const state = object("state" in data ? data.state : undefined);
      const pending = entry.kind === "trials" && Array.isArray(state.trials) ? state.trials.map(value => object(value).run_dir)
        : entry.kind === "suite" && Array.isArray(state.sets) ? state.sets.map(value => object(value).trial_set) : [];
      for (const path of pending) {
        if (typeof path !== "string" || !(entry.kind === "trials" ? /^runs\/\d+$/.test(path) : /^(?:codex-ab-trials|task-runs)-[A-Za-z0-9]+$/.test(path))) continue;
        const directory = join(root, path);
        const info = await lstat(directory).catch(() => undefined);
        if (info?.isDirectory()) paths.set(directory, false);
      }
      if (closed) return;
      for (const [path, { watcher }] of watchers) if (!paths.has(path)) { watcher.close(); watchers.delete(path); }
      for (const [path, recursive] of paths) {
        const info = await lstat(path).catch(error => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
        if (closed) return;
        const identity = info?.isDirectory() ? `${info.dev}:${info.ino}` : undefined;
        const existing = watchers.get(path);
        if (identity && existing?.identity === identity) continue;
        existing?.watcher.close(); watchers.delete(path);
        if (!identity) continue;
        try {
          const watcher = watch(path, { recursive }, (_event, filename) => {
            if (path !== dirname(root) || !filename || String(filename) === basename(root)) schedule();
          });
          watcher.on("error", () => { watcher.close(); watchers.delete(path); schedule(); });
          watchers.set(path, { watcher, identity });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
    async function update() {
      if (closed || running) return;
      running = true; dirty = false;
      try {
        if (entry) {
          // Install the root watcher before reading so changes during a read cause another update.
          if (!entry.directory || !watchers.has(entry.directory)) await observe({ entry, artifacts: [], children: [], live: {} });
          try {
            const data = await snapshot(entry);
            await observe(data);
            if (previous.delete("snapshot-error")) previous.delete("snapshot");
            send("entries", entryList());
            send("snapshot", data);
          } catch (error) { send("snapshot-error", { error: message(error) }); }
        }
        send("entries", entryList());
      } catch (error) { send("snapshot-error", { error: message(error) }); }
      finally {
        running = false;
        if (dirty) schedule();
      }
    }
    function schedule() {
      dirty = true;
      if (!closed && !running && !timer) timer = setTimeout(() => { timer = undefined; void update(); }, 50);
    }
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
        subscribers.add(schedule); streams.add(close);
        req.signal.addEventListener("abort", close, { once: true });
        if (req.signal.aborted) { close(); return; }
        controller.enqueue(encoder.encode("retry: 1500\n\n"));
        heartbeat = setInterval(() => {
          if (controller.desiredSize !== null && controller.desiredSize <= 0) { close(); return; }
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        }, 15000);
        void update();
      },
      cancel: close,
    }, { highWaterMark: 16 });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" } });
  }
  const server = Bun.serve({
    hostname, port, maxRequestBodySize: 128000,
    async fetch(req, server) {
      const url = new URL(req.url);
      const addresses = hostname === "0.0.0.0" || hostname === "::"
        ? Object.values(networkInterfaces()).flatMap(items => (items ?? []).map(item => item.address)) : [];
      const allowedHosts = ["localhost", "127.0.0.1", hostname, ...addresses].map(host =>
        new URL(`http://${host.includes(":") ? `[${host}]` : host}:${server.port}`).host);
      if (!req.headers.get("host") || !allowedHosts.includes(url.host) || req.headers.get("origin") && req.headers.get("origin") !== url.origin || req.headers.get("sec-fetch-site") === "cross-site") return json({ error: "Use the workbench origin" }, 403);
      try {
        if (req.method === "GET" && url.pathname === "/") return new Response(html as unknown as string, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
        if (req.method === "GET" && url.pathname === "/style.css") return new Response(css, { headers: { "Content-Type": "text/css", "Cache-Control": "no-cache" } });
        if (req.method === "GET" && url.pathname === "/app.js") return new Response(javascript, { headers: { "Content-Type": "text/javascript", "Cache-Control": "no-cache" } });
        if (req.method === "GET" && url.pathname === "/fonts/ibm-plex-sans-latin.woff2") return new Response(Bun.file(interfaceFont), { headers: { "Content-Type": "font/woff2" } });
        if (req.method === "GET" && url.pathname === "/fonts/OFL.txt") return new Response(fontLicense, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
        if (req.method === "GET" && url.pathname === "/api/config") return json({ token, defaults, comparisons: COMPARISONS, tasks: taskCatalog(), commands: COMMAND_OPTIONS, actions: ACTIONS, paidCommands: [...PAID] });
        if (req.method === "GET" && url.pathname === "/api/entries") return json(entryList());
        if (req.method === "GET" && url.pathname === "/api/events") {
          const id = url.searchParams.get("entry");
          const selected = id ? entries.get(id) : undefined;
          if (id && !selected) return json({ error: "Attach the evidence directory again if the server was restarted" }, 404);
          server.timeout(req, 0);
          return events(req, selected);
        }
        const match = url.pathname.match(/^\/api\/entries\/([a-f0-9-]+)(?:\/(artifacts|stop))?$/);
        const entry = match ? entries.get(match[1]!) : undefined;
        if (req.method === "GET" && entry && !match?.[2]) return json(await snapshot(entry));
        if (req.method === "GET" && entry?.directory && match?.[2] === "artifacts") {
          const path = url.searchParams.get("path") ?? "";
          if (!(await artifactList(entry.directory, entry.kind)).some(file => file.path === path)) return json({ error: "Artifact is not exposed by the workbench" }, 403);
          const file = Bun.file(await safeFile(entry.directory, path));
          return new Response(file, { headers: { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff", "Content-Disposition": "attachment" } });
        }
        if (req.method === "POST") {
          if (req.headers.get("x-codex-ab-token") !== token) return json({ error: "Reload the workbench before starting an operation" }, 403);
          const body = object(await req.json());
          if (url.pathname === "/api/attach") {
            if (typeof body.directory !== "string" || !body.directory.trim()) throw new Error("Enter an evidence directory");
            return json(await attach(body.directory));
          }
          if (url.pathname === "/api/check") return json(await validate(body, false));
          if (url.pathname === "/api/start") return json(await start(body), 202);
          if (entry && match?.[2] === "stop") {
            if (active?.entry.id !== entry.id) throw new Error("This entry has no active operation");
            active.canceled = true; entry.job!.status = "stopping";
            log(entry, "\nStop requested. Waiting for the CLI to stop containers and retain evidence.\n");
            active.child?.kill("SIGTERM");
            return json(entry);
          }
        }
        return json({ error: "Not found" }, 404);
      } catch (error) { return json({ error: message(error) }, 400); }
    },
  });
  process.stderr.write(`Workbench: ${server.url.origin}\n`);
  return {
    server,
    async shutdown(): Promise<void> {
      if (active) {
        active.canceled = true;
        active.entry.job!.status = "stopping";
        active.child?.kill("SIGTERM");
        await active.finished;
      }
      for (const close of streams) close();
      server.stop(true);
    },
  };
}
