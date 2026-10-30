import { cp, mkdir, mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { verifyBundleManifest } from "./bundle";
import { verifyPreparedInputs } from "./prepare";
import { armExecutionSucceeded, readState, sha256, writeState } from "./state";
import { armNames, type RunState } from "./types";

/** Copy preparation controls only. Executed homes and evaluator output stay in the source. */
export async function prepareReevaluation(sourceDirectory: string, outputParent = tmpdir()): Promise<string> {
  const sourceDir = await realpath(resolve(sourceDirectory));
  const outputRoot = await realpath(resolve(outputParent));
  const relativeOutput = relative(sourceDir, outputRoot);
  if (!relativeOutput || relativeOutput !== ".." && !relativeOutput.startsWith(`..${sep}`) && !isAbsolute(relativeOutput)) {
    throw new Error("Reevaluation output parent must be outside source run to preserve its evidence");
  }
  process.stderr.write(`[reevaluate] validating sealed source ${sourceDir}\n`);
  const source = await readState(sourceDir);
  const arms = armNames(source);
  const bundle = join(sourceDir, "reports/bundle");
  const bundleHash = await sha256(join(bundle, "MANIFEST.sha256"));
  await verifyBundleManifest(bundle, bundleHash);
  if (await sha256(join(sourceDir, "run.json")) !== await sha256(join(bundle, "run.json"))) throw new Error("Reevaluation source differs from its sealed publication");
  const published = JSON.parse(await readFile(join(bundle, "report.json"), "utf8")) as { validity?: string };
  if (source.status !== "complete" || source.finishing?.status !== "complete" || source.invalidity_reasons?.length
    || !source.criteria || arms.length < 2 || source.selected_arms?.length !== arms.length
    || !arms.every(arm => source.selected_arms!.includes(arm) && armExecutionSucceeded(source.results?.[arm]))
    || published.validity !== "valid") throw new Error("Reevaluation requires a complete, infrastructure-valid sealed comparison containing all configured arms");
  const directory = await mkdtemp(join(outputRoot, "task-reevaluation-"));
  process.stderr.write(`[reevaluate] copying immutable preparation inputs into ${directory}\n`);
  const fresh: RunState = { ...source, id: basename(directory), created_at: new Date().toISOString(), status: "prepared", evaluation: { mode: "fresh" },
    planned_imports: arms.map(arm => ({ target_arm: arm, arm, run_dir: sourceDir, bundle_sha256: bundleHash })) };
  delete fresh.results;
  delete fresh.arm_attempts;
  delete fresh.selected_arms;
  delete fresh.imported_arms;
  delete fresh.imported_control;
  delete fresh.finishing;
  delete fresh.finishing_history;
  delete fresh.judge;
  delete fresh.judge_pricing;
  delete fresh.error;
  delete fresh.trial;
  await writeState(directory, fresh);
  try {
    const paths = new Set(["seed.git", "control", source.snapshot_manifest, source.runtime_tools.current_setup_files,
      // Verification checks the canonical current snapshot even for isolated launcher setups.
      "snapshots/current/home/ubuntu", "snapshots/stock/home/ubuntu", ...arms.map(arm => source.arms[arm].home_template),
      ...(source.criteria ? [source.criteria.path] : []), ...(source.task_pack ? [source.task_pack.path] : []),
      ...(source.upstream_reference?.files.map(file => file.path) ?? []),
      ...Object.values(source.setup_revisions ?? {}).map(revision => revision.manifest),
      ...(source.mekugi_build?.files.map(file => file.path) ?? []),
      ...(source.protected_runtime?.scripts.map(file => file.path) ?? [])]);
    for (const exports of [source.mekugi_exports, ...Object.values(source.mekugi_exports_by_arm ?? {})]) {
      if (exports) { paths.add(exports.validator.path); paths.add(exports.reader.path); }
    }
    for (const path of [source.runtime_tools.mekugi_source, source.runtime_tools.mekugi_exec_source,
      source.runtime_tools.grok_source, source.runtime_tools.current_setup_mise_source]) {
      if (path && !isAbsolute(path)) paths.add(path);
    }
    for (const path of paths) {
      if (isAbsolute(path) || path.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Reevaluation input must be run-relative");
      const target = join(directory, path);
      await mkdir(dirname(target), { recursive: true });
      await cp(join(sourceDir, path), target, { recursive: true, verbatimSymlinks: true, force: false, errorOnExist: true });
    }
    for (const path of ["artifacts", "reports"]) await mkdir(join(directory, path), { recursive: true });
    await verifyPreparedInputs(directory, fresh, "judging");
  } catch (error) {
    fresh.status = "partial";
    fresh.error = String(error);
    await writeState(directory, fresh);
    throw new Error(`reevaluation preparation failed; retained ${directory}: ${String(error)}`);
  }
  return directory;
}
