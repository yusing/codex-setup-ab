import { copyFile, cp, mkdir, readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { verifyBundleManifest } from "./bundle";
import { readState, sha256 } from "./state";
import { meterRollouts, type PricingSnapshot, USAGE_KEYS } from "./usage";
import type { ArmResult, RunState } from "./types";

function digest(value: unknown): string { return new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex"); }

/** Inputs that must match before a published stock result can be reused. */
export function controlIdentity(state: RunState): unknown {
  return {
    profile: state.profile, source: { base_commit: state.source.base_commit, base_tree: state.source.base_tree,
      forbidden_commit: state.source.forbidden_commit },
    task_sha256: state.task.sha256, task_pack_sha256: state.task_pack?.sha256 ?? null,
    criteria_sha256: state.criteria?.sha256 ?? null, comparison: state.comparison ?? "stock-current",
    execution: state.execution, image_id: state.image_id, dependency_image_id: state.dependency_image?.image_id ?? null,
    codex_sha256: state.runtime_tools.codex_sha256,
    codex_code_mode_host_sha256: state.runtime_tools.codex_code_mode_host_sha256,
    resource_limits: state.resource_limits, timeout_seconds: state.timeout_seconds,
    stock_home_template: state.arms.stock.home_template,
    stock_setup_sha256: state.arms.stock.home_template === "snapshots/current/home/ubuntu"
      ? state.current_snapshot.manifest_sha256 : null,
    mekugi_flags: state.mekugi_flags ?? [], protected_runtime: state.protected_runtime ?? null,
  };
}

interface RolloutFile { path: string; sha256: string }
async function files(directory: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await files(path));
    else if (entry.isFile()) output.push(path);
    else throw new Error("control rollout contains a non-regular file");
  }
  return output.sort();
}
async function verifyRollouts(directory: string, expected: RolloutFile[]): Promise<void> {
  if (!Array.isArray(expected) || expected.length === 0) throw new Error("control bundle has no rollout identity");
  const actual = await files(directory);
  if (actual.length !== expected.length) throw new Error("control rollout file list changed");
  for (const [index, file] of expected.entries()) {
    if (typeof file.path !== "string" || !file.path || file.path.startsWith("/") || file.path.split("/").some(part => !part || part === "." || part === "..")
      || relative(directory, actual[index]!) !== file.path || await sha256(actual[index]!) !== file.sha256) {
      throw new Error("control rollout bytes differ from the published bundle");
    }
  }
}

export async function importControl(runDir: string, state: RunState, sourceDirectory: string, expectedBundleSha256: string): Promise<ArmResult> {
  if (state.comparison === "mentor-handoff" || state.comparison === "codex-mekugi-grok") {
    throw new Error("control reuse currently supports direct-Codex stock controls only");
  }
  if (!/^[0-9a-f]{64}$/.test(expectedBundleSha256)) throw new Error("control bundle SHA-256 must be 64 lowercase hex characters");
  const sourceRun = resolve(sourceDirectory);
  if (sourceRun === resolve(runDir)) throw new Error("control source and treatment run must differ");
  const bundle = join(sourceRun, "reports/bundle");
  await verifyBundleManifest(bundle, expectedBundleSha256);
  if (await sha256(join(sourceRun, "run.json")) !== await sha256(join(bundle, "run.json"))) throw new Error("control state differs from the published bundle");
  const source = await readState(sourceRun);
  if (source.status !== "complete" || source.finishing?.status !== "complete" || source.invalidity_reasons?.length
    || JSON.stringify(source.selected_arms) !== JSON.stringify(["stock"]) || source.imported_control
    || !source.results?.stock || source.results.stock.exit_code !== 0 || source.results.stock.collection_error
    || source.results.stock.lifecycle_error || source.results.stock.grade?.preparation.exit_code !== 0) {
    throw new Error("published control is not a complete, valid stock-only attempt");
  }
  if (digest(controlIdentity(source)) !== digest(controlIdentity(state))) throw new Error("published control does not match task, setup, model, tool, or resource controls");
  const provenance = join(runDir, "evaluator/imported-control");
  await mkdir(provenance, { recursive: true, mode: 0o700 });
  await copyFile(join(bundle, "MANIFEST.sha256"), join(provenance, "MANIFEST.sha256"));
  await copyFile(join(bundle, "report.json"), join(provenance, "report.json"));
  const published = JSON.parse(await readFile(join(bundle, "report.json"), "utf8")) as { validity?: string; arms?: { stock?: { usage?: { complete?: boolean; totals?: Record<string, number> } } } };
  if (published.validity !== "valid" || published.arms?.stock?.usage?.complete !== true) throw new Error("published control has incomplete usage or invalid infrastructure");
  const rolloutManifest = JSON.parse(await readFile(join(bundle, "rollout-files.json"), "utf8")) as { stock?: RolloutFile[] };
  const originalSessions = join(sourceRun, "arms/stock/home/ubuntu/.codex/sessions");
  await verifyRollouts(originalSessions, rolloutManifest.stock ?? []);
  const output = join(runDir, "artifacts/stock");
  await mkdir(output, { recursive: true, mode: 0o700 });
  const patch = join(output, "changes.patch");
  await copyFile(join(bundle, "stock-changes.patch"), patch);
  const stdout = join(output, "codex.jsonl");
  const stderr = join(output, "codex.stderr");
  if (source.results.stock.stdout_path !== "artifacts/stock/codex.jsonl" || source.results.stock.stderr_path !== "artifacts/stock/codex.stderr"
    || source.results.stock.patch_path !== "artifacts/stock/changes.patch") throw new Error("control artifact paths changed");
  await copyFile(join(sourceRun, source.results.stock.stdout_path), stdout);
  await copyFile(join(sourceRun, source.results.stock.stderr_path), stderr);
  const home = join(runDir, "arms/stock/home/ubuntu/.codex");
  await mkdir(home, { recursive: true, mode: 0o700 });
  const sessions = join(home, "sessions");
  await cp(originalSessions, sessions, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
  await verifyRollouts(sessions, rolloutManifest.stock ?? []);
  const metered = await meterRollouts(home, source.pricing as PricingSnapshot);
  if (!metered.complete || USAGE_KEYS.some(key => metered.totals[key] !== published.arms?.stock?.usage?.totals?.[key])) {
    throw new Error("copied control usage differs from its published measurement");
  }
  state.pricing = source.pricing;
  state.imported_control = { source_run_id: source.id, bundle_sha256: expectedBundleSha256,
    controls_sha256: digest(controlIdentity(source)), stdout_sha256: await sha256(stdout), stderr_sha256: await sha256(stderr) };
  const original = source.results.stock;
  return { ...original, grade: undefined, patch_path: "artifacts/stock/changes.patch",
    stdout_path: "artifacts/stock/codex.jsonl", stderr_path: "artifacts/stock/codex.stderr" };
}
