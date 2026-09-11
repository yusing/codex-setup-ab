import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { meterRollouts, USAGE_KEYS, type PricingSnapshot } from "./usage";

import { readState, sha256, withRunLock } from "./state";

const METRICS = [...USAGE_KEYS, "estimated_api_usd", "command_seconds"] as const;

interface Exclusion {
  id: string;
  reason: string;
}

interface RemeterSpec {
  arm: "stock" | "current";
  rationale: string;
  responses: Exclusion[];
  commands: Exclusion[];
}

function parseSpec(text: string): RemeterSpec {
  const value = JSON.parse(text);
  if (!value || !["stock", "current"].includes(value.arm) || typeof value.rationale !== "string" || !value.rationale.trim()) {
    throw new Error("exclusions require arm and rationale");
  }
  for (const key of ["responses", "commands"]) {
    const rows = value[key];
    if (!Array.isArray(rows) || rows.some(row => !row || typeof row.id !== "string" || !row.id.trim() || typeof row.reason !== "string" || !row.reason.trim()) ||
        new Set(rows.map(row => row.id)).size !== rows.length) {
      throw new Error(`invalid or duplicate ${key} exclusions`);
    }
  }
  if (!value.responses.length) throw new Error("at least one response exclusion is required");
  return value;
}

/** Write a separate accounting adjustment, never rewrite observed run evidence. */
export async function remeterRun(runDirectory: string, specification: string): Promise<string> {
  const runDir = resolve(runDirectory);
  return withRunLock(runDir, async () => {
    const spec = parseSpec(await readFile(specification, "utf8"));
    const state = await readState(runDir);
    const home = state.arm_attempts?.[spec.arm]?.codex_home;
    if (!home || !state.pricing || state.status !== "complete") throw new Error("remeter requires a completed run with recorded pricing and sessions");
    const pricing = state.pricing as PricingSnapshot;
    const original = await meterRollouts(join(runDir, home), pricing);
    const adjusted = await meterRollouts(join(runDir, home), pricing, {
      response_ids: spec.responses.map(row => row.id),
      command_ids: spec.commands.map(row => row.id),
    });
    if (!original.complete || !adjusted.complete) throw new Error("cannot adjust incomplete metering");
    const removed = Object.fromEntries(METRICS.map(key => [
      key, original.totals[key] === null || adjusted.totals[key] === null ? null : original.totals[key]! - adjusted.totals[key]!,
    ]));
    const result = {
      generated_at: new Date().toISOString(), run_id: state.id,
      run_state_sha256: await sha256(join(runDir, "run.json")),
      specification: spec, pricing: state.pricing, original, adjusted, removed,
      observed_agent_seconds: state.results?.[spec.arm]?.agent_elapsed_ms !== undefined ? state.results[spec.arm]!.agent_elapsed_ms / 1000 : null,
      adjusted_agent_seconds: null,
      limitations: [
        "Post-hoc accounting adjustment, not a new execution or an estimate of actual charges.",
        "Only explicitly selected requests and command records are excluded. Mixed-purpose and encrypted review exchanges are retained.",
        "Later requests retain their original context and cache usage; no counterfactual context savings are inferred.",
        "Observed wall time is unchanged. Overlapping reviewer work and inference prevent exact wall-time subtraction.",
      ],
    };
    await mkdir(join(runDir, "reports"), { recursive: true });
    const destination = await mkdtemp(join(runDir, "reports/remeter-"));
    await writeFile(join(destination, "report.json"), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    const rows = METRICS.map(key =>
      `| ${key} | ${original.totals[key]} | ${removed[key]} | ${adjusted.totals[key]} |`).join("\n");
    await writeFile(join(destination, "report.md"), `# Adjusted ${spec.arm} accounting\n\n${spec.rationale}\n\n| Metric | Original | Removed | Adjusted |\n| --- | ---: | ---: | ---: |\n${rows}\n\n## Excluded requests\n\n${spec.responses.map(row => `- ${row.id}: ${row.reason}`).join("\n")}\n\n## Excluded commands\n\n${spec.commands.map(row => `- ${row.id}: ${row.reason}`).join("\n")}\n\n## Limits\n\n${result.limitations.map(line => `- ${line}`).join("\n")}\n`, { mode: 0o600 });
    return join(destination, "report.md");
  });
}
