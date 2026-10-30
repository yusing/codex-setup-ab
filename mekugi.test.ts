import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MEKUGI_METRICS_WRAPPER, validateMekugiExports, validateMekugiFlags } from "./mekugi";
import { exec } from "./process";
import { sha256 } from "./state";
import { MEKUGI_EXPORT_SCRIPTS } from "./support/mekugi";
import type { RunState } from "./types";
import { applyMekugiProviderUsage, meterRollouts, type PricingSnapshot } from "./usage";
import { performanceComparison, performanceMarkdown } from "./diagnostics";
import { explainMechanisms } from "./mechanisms";

for (const flag of [
  "--timeout=30s", "--stream-idle-timeout=2m", "--debug", "--debug=true",
  "--ansi-faint=auto", "--ansi-faint=on", "--ansi-faint=off",
  ...["shell-guard", "deduplicate-output", "child-reply-summary"].flatMap(name =>
    [`--${name}`, `--${name}=true`, `--${name}=false`]),
]) {
  test(`Mekugi accepts ${flag}`, () => {
    expect(validateMekugiFlags([flag])).toEqual([flag]);
  });
}

test("Mekugi accepts distinct current flags together and an empty flag list", () => {
  const flags = ["--shell-guard=false", "--deduplicate-output=false", "--child-reply-summary=true",
    "--timeout=30s", "--stream-idle-timeout=2m", "--debug", "--ansi-faint=off"];
  expect(validateMekugiFlags(flags)).toEqual(flags);
  expect(validateMekugiFlags([])).toEqual([]);
});

for (const flag of [
  "--mentor-handoff", "--mentor-handoff=true", "--main-mentor-handoff=false", "--explore-filter=true",
  "--mode=mekugi", "--mode=passthrough", "--journal-compaction=auto", "--journal-compaction=slice",
  "--journal-compaction=off", "--post-compact-recovery=true", "--post-compact-recovery=false",
  "--duplicate-output=true", "--grok", "--grok=true", "--grok=false",
  "--capture-output=/tmp/capture.jsonl", "--grok-auth-file=/tmp/auth.json",
  "--shell-guard=auto", "--deduplicate-output=on", "--child-reply-summary=off",
  "--debug=false", "--ansi-faint=true", "--ansi-faint", "--timeout", "--stream-idle-timeout",
  "--unknown=true", "--debug=true\n", "--debug=true\0",
]) {
  test(`Mekugi rejects unsupported or invalid ${JSON.stringify(flag)}`, () => {
    expect(() => validateMekugiFlags([flag])).toThrow();
  });
}

for (const flags of [
  ["--shell-guard", "--shell-guard=false"],
  ["--deduplicate-output=true", "--deduplicate-output=false"],
  ["--child-reply-summary", "--child-reply-summary=true"],
  ["--timeout=30s", "--timeout=60s"],
  ["--stream-idle-timeout=2m", "--stream-idle-timeout=3m"],
  ["--debug", "--debug=true"], ["--ansi-faint=on", "--ansi-faint=off"],
]) {
  test(`Mekugi rejects conflicting flags ${flags.join(" ")}`, () => {
    expect(() => validateMekugiFlags(flags)).toThrow();
  });
}

test("Mekugi rejects inputs other than string arrays", () => {
  for (const value of [null, "--debug", {}, [true], ["--debug", 1]]) {
    expect(() => validateMekugiFlags(value)).toThrow("Mekugi flags must be a string array");
  }
});

test("capture analyzer retains v6 and reconciles sanitized v7 evidence offline", async () => {
  const result = await exec(["python3", "support/mekugi/capture_v7_test.py"]);
  expect(result.exitCode, result.stderr).toBe(0);
});

test("wrapper exports the root and child without conflating sequence 1, and preserves stdin and exit status", async () => {
  const root = await mkdtemp(join(tmpdir(), "mekugi-family-wrapper-"));
  try {
    await mkdir(join(root, "private"));
    const prepared = await exec(["python3", "-c", `
import json, sys
from pathlib import Path
sys.dont_write_bytecode = True
sys.path.insert(0, 'support/mekugi')
from capture_v7_test import fixture
root = Path(sys.argv[1])
for name, path in [('root', root / 'capture.jsonl'), ('child', root / 'capture.jsonl.runtimes/child/capture.jsonl')]:
    metrics, records = fixture()
    metrics['exchanges'][0]['thread_id'] = name
    for record in records: record['thread_id'] = name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(''.join(json.dumps(record) + '\\n' for record in records))
    debug = root / ('state/mekugi/debug/mekugi-debug-' + name)
    debug.mkdir(parents=True)
    (debug / 'capture.jsonl').symlink_to(path)
    (debug / 'metrics.json').write_text(json.dumps(metrics))
`, root]);
    expect(prepared.exitCode, prepared.stderr).toBe(0);
    const wrapper = MEKUGI_METRICS_WRAPPER.replaceAll("/mekugi-exports", root);
    const environment = { MEKUGI_DEBUG_TMPDIR: join(root, "private"), XDG_STATE_HOME: join(root, "state") };
    const result = await exec(["sh", "-c", wrapper, "fixture", "sh", "-c", 'IFS= read -r task; printf "%s" "$task"'],
      { env: environment, stdin: "benchmark task\n" });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe("benchmark task");
    const metrics = JSON.parse(await readFile(join(root, "metrics.json"), "utf8"));
    expect(metrics.schema).toBe("mekugi.capture.family.v1");
    expect(metrics.runtimes.map((runtime: { metrics: { exchanges: Array<{ sequence: number }> } }) => runtime.metrics.exchanges[0]!.sequence)).toEqual([1, 1]);
    for (const name of ["analyze_capture.py", "benchmark_jsonl.py"] as const) await writeFile(join(root, name), MEKUGI_EXPORT_SCRIPTS[name]);
    const state = { mekugi_exports: { metrics: "metrics.json", capture: "capture.jsonl",
      validator: { path: "analyze_capture.py", sha256: await sha256(join(root, "analyze_capture.py")) },
      reader: { path: "benchmark_jsonl.py", sha256: await sha256(join(root, "benchmark_jsonl.py")) },
    } } as RunState;
    expect(await validateMekugiExports(root, state)).toMatchObject({ status: "valid", metrics });
    const pricing: PricingSnapshot = { source: "fallback", fetched_at: "2026-01-01", catalog_url: "fixture", assumptions: [], warnings: [],
      models: { "gpt-6-luna": { model_id: "gpt-6-luna", source: "fixture", prompt: 1, completion: 1, input_cache_read: 0, input_cache_write: 0, overrides: [] } } };
    for (const [home, thread, input, output] of [["hosted", "root", 100, 10], ["hosted", "child", 100, 10], ["direct", "root", 10, 1]] as const) {
      await mkdir(join(root, home, "sessions"), { recursive: true });
      await writeFile(join(root, home, "sessions", `${thread}.jsonl`), [
        { type: "session_meta", payload: { id: thread, source: "exec" } },
        { type: "turn_context", payload: { model: "gpt-6-luna" } },
        { type: "token_usage_record", payload: { response_id: thread, usage: {
          input_tokens: input, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output,
        } } },
      ].map(event => JSON.stringify(event)).join("\n") + "\n");
    }
    const hosted = await meterRollouts(join(root, "hosted"), pricing);
    const direct = await meterRollouts(join(root, "direct"), pricing);
    expect(applyMekugiProviderUsage(hosted, metrics, pricing)).toBeNull();
    expect(hosted.complete).toBe(true);
    expect(hosted.totals.total_tokens).toBe(220);
    const arms = [{ arm: "stock", usage: direct }, { arm: "current", usage: hosted }];
    const delta = performanceComparison(arms)!.current_minus_stock;
    expect(delta.total_tokens).toBe(209);
    expect(delta.estimated_api_usd).toBe(169);
    expect(delta.by_role).toEqual({ root: { total_tokens: null, estimated_api_usd: null }, children: { total_tokens: null, estimated_api_usd: null } });
    expect(performanceMarkdown(arms)).toContain("current / unknown role");
    expect(performanceMarkdown(arms)).not.toContain("current / root");
    const mechanisms = explainMechanisms(arms);
    expect(mechanisms.findings.some(finding => finding.mechanism === "Extra workflow turns repeatedly process accumulated context")).toBe(false);
    expect(mechanisms.unknowns.some(unknown => unknown.includes("logical root/child lineage is unavailable"))).toBe(true);
    const childPath = join(root, "hosted/sessions/child.jsonl");
    const childEvents = (await readFile(childPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    childEvents[0].payload.source = { subagent: { thread_spawn: { parent_thread_id: "root" } } };
    childEvents[0].payload.agent_role = "review-correctness";
    await writeFile(childPath, childEvents.map(event => JSON.stringify(event)).join("\n") + "\n");
    const linked = await meterRollouts(join(root, "hosted"), pricing);
    expect(applyMekugiProviderUsage(linked, metrics, pricing)).toBeNull();
    const knownArms = [{ arm: "stock", usage: direct }, { arm: "current", usage: linked }];
    const byRole = performanceComparison(knownArms)!.current_minus_stock.by_role;
    expect([byRole.root.total_tokens, byRole.children.total_tokens]).toEqual([99, 110]);
    expect(performanceMarkdown(knownArms)).toContain("current / review-correctness");
    await writeFile(join(root, "metrics.json"), JSON.stringify(metrics.runtimes[0].metrics));
    expect(await validateMekugiExports(root, state)).toMatchObject({ status: "unavailable", reason: expect.stringContaining("runtime captures require a family snapshot") });
    await writeFile(join(root, "metrics.json"), JSON.stringify(metrics));
    const failed = await exec(["sh", "-c", wrapper, "fixture", "sh", "-c", "exit 7"], { env: environment });
    expect(failed.exitCode).toBe(7);
    await rm(join(root, "state/mekugi/debug/mekugi-debug-child/metrics.json"));
    const unavailable = await exec(["sh", "-c", wrapper, "fixture", "sh", "-c", "exit 9"], { env: environment });
    expect(unavailable.exitCode).toBe(9);
    expect(unavailable.stderr).toContain("missing its metrics");
    expect(await Bun.file(join(root, "metrics.json")).exists()).toBe(false);
    expect((await validateMekugiExports(root, state)).status).toBe("unavailable");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("wrapper forwards termination and waits for the final runtime snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "mekugi-wrapper-signal-"));
  try {
    const debug = join(root, "state/mekugi/debug/mekugi-debug-root");
    await mkdir(debug, { recursive: true });
    await mkdir(join(root, "private"));
    await writeFile(join(root, "capture.jsonl"), "");
    await symlink(join(root, "capture.jsonl"), join(debug, "capture.jsonl"));
    const child = 'trap \'printf "{}" > "$XDG_STATE_HOME/mekugi/debug/mekugi-debug-root/metrics.json"; exit 143\' TERM; '
      + 'printf READY; while :; do sleep 0.05; done';
    const process = Bun.spawn(["sh", "-c", MEKUGI_METRICS_WRAPPER.replaceAll("/mekugi-exports", root), "fixture", "sh", "-c", child], {
      env: { ...globalThis.process.env, XDG_STATE_HOME: join(root, "state"), MEKUGI_DEBUG_TMPDIR: join(root, "private") },
      stdout: "pipe", stderr: "pipe",
    });
    const output = process.stdout.getReader();
    expect(new TextDecoder().decode((await output.read()).value)).toBe("READY");
    process.kill("SIGTERM");
    expect(await process.exited).toBe(143);
    expect(await readFile(join(root, "metrics.json"), "utf8")).toBe("{}");
    output.releaseLock();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("bundled analyzer reconciles only configured measured threads and provider usage", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-ab-mekugi-reconciliation-"));
  try {
    for (const name of ["analyze_capture.py", "benchmark_jsonl.py"] as const) {
      await writeFile(join(root, name), MEKUGI_EXPORT_SCRIPTS[name]);
    }
    await writeFile(join(root, "results.jsonl"), JSON.stringify({
      arm: "mekugi", model: "gpt-6-luna", agent: {
        thread_id: "measured", usage: {
          input_tokens: 100, cached_input_tokens: 20, output_tokens: 30, reasoning_output_tokens: 10,
        },
      },
    }) + "\n");
    const program = `
import copy, json
from pathlib import Path
from analyze_capture import validate_results

results = Path('results.jsonl')
metrics = {'exchanges': [{
    'sequence': 1, 'thread_id': 'measured',
    'provider_attempts': [{'model': 'gpt-6-luna'}],
    'usage': {'input_tokens': 100, 'cached_input_tokens': 20, 'output_tokens': 30, 'reasoning_tokens': 10},
}]}
outcomes = {'same_model': validate_results(metrics, results, 'mekugi')}
for case in ['wrong_model', 'unknown_child', 'usage_mismatch']:
    changed = copy.deepcopy(metrics)
    if case == 'wrong_model':
        changed['exchanges'][0]['provider_attempts'].append({'model': 'gpt-6-astra'})
    elif case == 'unknown_child':
        child = copy.deepcopy(changed['exchanges'][0])
        child.update(sequence=2, thread_id='unknown-child')
        changed['exchanges'].append(child)
    else:
        changed['exchanges'][0]['usage']['input_tokens'] += 1
    try:
        validate_results(changed, results, 'mekugi')
    except ValueError as error:
        outcomes[case] = str(error)
    else:
        raise AssertionError(f'{case} was accepted')
prewarm = copy.deepcopy(metrics)
prewarm['exchanges'].insert(0, dict(copy.deepcopy(metrics['exchanges'][0]), sequence=0))
outcomes['prewarm_excluded'] = validate_results(prewarm, results, 'mekugi', {0})
try:
    validate_results(prewarm, results, 'mekugi')
except ValueError as error:
    outcomes['prewarm_included'] = str(error)
else:
    raise AssertionError('unexcluded prewarm usage was accepted')
print(json.dumps(outcomes))
`;
    const result = await exec(["python3", "-c", program], { cwd: root });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      same_model: 1,
      wrong_model: "provider model gpt-6-astra violates the configured schedule",
      unknown_child: "capture contains an unproved thread unknown-child",
      usage_mismatch: "captured provider usage differs from result usage for measured",
      prewarm_excluded: 1,
      prewarm_included: "captured provider usage differs from result usage for measured",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const modified of ["validator", "reader"] as const) {
  test(`Mekugi export validation rejects changed ${modified} identity`, async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-ab-mekugi-identity-"));
    try {
      const validator = join(root, "analyze_capture.py");
      const reader = join(root, "benchmark_jsonl.py");
      await writeFile(validator, "import json\ndef load_json(path): return json.loads(path.read_text())\ndef validate_snapshot(*args): pass\ndef validate_raw_capture(*args): pass\n");
      await writeFile(reader, MEKUGI_EXPORT_SCRIPTS["benchmark_jsonl.py"]);
      await writeFile(join(root, "metrics.json"), JSON.stringify({ exchanges: [] }));
      await writeFile(join(root, "capture.jsonl"), "");
      const state = {
        mekugi_flags: [],
        mekugi_exports_by_arm: { current: {
          validator: { path: "analyze_capture.py", sha256: await sha256(validator) },
          reader: { path: "benchmark_jsonl.py", sha256: await sha256(reader) },
          metrics: "metrics.json", capture: "capture.jsonl",
        } },
      } as RunState;
      expect((await validateMekugiExports(root, state, "current")).status).toBe("valid");
      const children = join(root, "capture.jsonl.runtimes");
      await mkdir(join(children, "unmatched"), { recursive: true });
      expect(await validateMekugiExports(root, state, "current")).toMatchObject({
        status: "unavailable", reason: expect.stringContaining("runtime captures require a family snapshot"),
      });
      await rm(children, { recursive: true });
      await writeFile(modified === "validator" ? validator : reader, "# changed identity\n");
      expect(await validateMekugiExports(root, state, "current")).toEqual({
        status: "unavailable", reason: "Mekugi validator identity changed.",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
