import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateMekugiExports, validateMekugiFlags } from "./mekugi";
import { exec } from "./process";
import { sha256 } from "./state";
import { MEKUGI_EXPORT_SCRIPTS } from "./support/mekugi";
import type { RunState } from "./types";

for (const flag of [
  "--mode=mekugi", "--mode=passthrough",
  "--journal-compaction=auto", "--journal-compaction=slice", "--journal-compaction=off",
  "--post-compact-recovery=true", "--post-compact-recovery=false",
  "--timeout=30s", "--stream-idle-timeout=2m",
  "--debug", "--debug=true", "--grok", "--grok=true", "--grok=false",
  "--ansi-faint=auto", "--ansi-faint=on", "--ansi-faint=off",
]) {
  test(`Mekugi accepts ${flag}`, () => {
    expect(validateMekugiFlags([flag])).toEqual([flag]);
  });
}

test("Mekugi accepts distinct current flags together and an empty flag list", () => {
  const flags = ["--mode=mekugi", "--journal-compaction=slice", "--post-compact-recovery=false",
    "--timeout=30s", "--stream-idle-timeout=2m", "--debug", "--grok=false", "--ansi-faint=off"];
  expect(validateMekugiFlags(flags)).toEqual(flags);
  expect(validateMekugiFlags([])).toEqual([]);
});

for (const flag of [
  "--mentor-handoff", "--mentor-handoff=true", "--main-mentor-handoff=false", "--explore-filter=true",
  "--capture-output=/tmp/capture.jsonl", "--grok-auth-file=/tmp/auth.json",
  "--mode=invalid", "--journal-compaction=true", "--post-compact-recovery=auto",
  "--post-compact-recovery", "--debug=false", "--grok=invalid", "--ansi-faint=true", "--ansi-faint",
  "--timeout", "--stream-idle-timeout", "--unknown=true", "--debug=true\n", "--debug=true\0",
]) {
  test(`Mekugi rejects unsupported or invalid ${JSON.stringify(flag)}`, () => {
    expect(() => validateMekugiFlags([flag])).toThrow();
  });
}

for (const flags of [
  ["--mode=mekugi", "--mode=passthrough"],
  ["--journal-compaction=auto", "--journal-compaction=off"],
  ["--post-compact-recovery=true", "--post-compact-recovery=false"],
  ["--timeout=30s", "--timeout=60s"],
  ["--stream-idle-timeout=2m", "--stream-idle-timeout=3m"],
  ["--debug", "--debug=true"], ["--grok", "--grok=false"],
  ["--ansi-faint=on", "--ansi-faint=off"],
  ["--mode=passthrough", "--journal-compaction=auto"],
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
      await writeFile(reader, "");
      await writeFile(join(root, "metrics.json"), JSON.stringify({ exchanges: [] }));
      await writeFile(join(root, "capture.jsonl"), "");
      const state = {
        mekugi_flags: ["--mode=mekugi"],
        mekugi_exports_by_arm: { current: {
          validator: { path: "analyze_capture.py", sha256: await sha256(validator) },
          reader: { path: "benchmark_jsonl.py", sha256: await sha256(reader) },
          metrics: "metrics.json", capture: "capture.jsonl",
        } },
      } as RunState;
      expect((await validateMekugiExports(root, state, "current")).status).toBe("valid");
      await writeFile(modified === "validator" ? validator : reader, "# changed identity\n");
      expect(await validateMekugiExports(root, state, "current")).toEqual({
        status: "unavailable", reason: "Mekugi validator identity changed.",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
