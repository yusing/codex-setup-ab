import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { armRuntime } from "./arm-settings";
import { launchConfiguration } from "./launch";
import { applySkillSelection, setupSkills } from "./setup-skills";
import type { RunState } from "./types";

test("arm overrides are validated without changing legacy defaults or sibling settings", () => {
  const input = { preset: "same-setup", "arm-settings": JSON.stringify({ stock: { model: "gpt-6.1-terra", cpus: "4" }, current: { mekugi_flags: ["--timeout=30s"] } }) };
  const config = launchConfiguration(input);
  const state = { execution: { model: config.prepare.model, reasoning_effort: config.prepare.reasoningEffort, service_tier: "default" },
    resource_limits: { cpus: "2", memory: "4g" }, timeout_seconds: 1800, arm_settings: config.prepare.armSettings } as RunState;
  expect(armRuntime(state, "stock").execution.model).toBe("gpt-6.1-terra");
  expect(armRuntime(state, "stock").resource_limits.cpus).toBe("4");
  expect(armRuntime(state, "current").execution.model).toBe(state.execution.model);
  expect(state.resource_limits.cpus).toBe("2");
  expect(launchConfiguration({}).prepare.armSettings).toBeUndefined();
  for (const settings of [[], { unknown: {} }, { stock: { model: ["gpt-6-astra"] } }, { stock: { timeout_seconds: 0 } },
    { stock: { skills: { skill: "false" } } }, { stock: { mekugi_flags: ["--debug"] } }, { current: { mekugi_flags: ["--capture-output=/tmp/out"] } }]) {
    expect(() => launchConfiguration({ ...input, "arm-settings": JSON.stringify(settings) })).toThrow();
  }
  expect(() => launchConfiguration({ preset: "duplicate-output", "arm-settings": JSON.stringify({ stock: { mekugi_flags: ["--deduplicate-output=true"] } }) })).toThrow("owns its treatment");
});

test("skill choices adapt only the selected arm home and retain remote metadata and conditional defaults", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arm-skills-test-"));
  try {
    const source = join(directory, "setup"), first = join(directory, "first"), second = join(directory, "second");
    const relative = ".skills-mgr/.skills-mgr.json";
    const registry = JSON.stringify({ schema_revision: 3, skills: { conditional: { enabled: "lang go" }, remote: { enabled: true, remote: { name: "remote" } } } });
    await mkdir(join(source, ".skills-mgr"), { recursive: true });
    await writeFile(join(source, relative), registry);
    await cp(source, first, { recursive: true }); await cp(source, second, { recursive: true });
    await applySkillSelection(first, { remote: false });
    expect(JSON.parse(await readFile(join(first, relative), "utf8")).skills).toEqual({ conditional: { enabled: "lang go" }, remote: { enabled: false, remote: { name: "remote" } } });
    expect(await readFile(join(source, relative), "utf8")).toBe(registry);
    expect(await readFile(join(second, relative), "utf8")).toBe(registry);
    await expect(applySkillSelection(second, { missing: true })).rejects.toThrow("unavailable");
    expect(await readFile(join(second, relative), "utf8")).toBe(registry);
    await applySkillSelection(second, { conditional: true });
    expect((await setupSkills(second)).find(skill => skill.name === "conditional")).toEqual({ name: "conditional", enabled: true, conditional: false });
    const linked = join(directory, "linked"); await mkdir(linked);
    await symlink(join(source, ".skills-mgr"), join(linked, ".skills-mgr"));
    await expect(applySkillSelection(linked, { remote: false })).rejects.toThrow("escapes");
    expect(await readFile(join(source, relative), "utf8")).toBe(registry);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
