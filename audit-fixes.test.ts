import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { armLabels } from "./arm-labels";
import { launchConfiguration } from "./launch";
import { applySkillSelection } from "./setup-skills";

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map(dir => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

describe("audit regression checks", () => {
  test("armLabels disambiguates all colliding imported arms", () => {
    const labels = armLabels({
      comparison: "custom",
      execution: { model: "gpt-6-astra", reasoning_effort: "medium", service_tier: "default", current_launcher: "codex" },
      arms: {
        stock: { repository: "", home_template: "", launcher: "codex" },
        current: { repository: "", home_template: "", launcher: "codex" },
        "arm-3": { repository: "", home_template: "", launcher: "codex" },
      },
      imported_arms: {
        stock: {
          source_run_id: "run-1",
          source_arm: "stock",
          label: "Codex (minimal setup)",
          bundle_sha256: "a".repeat(64),
          directory: "evaluator/imported-arms/stock",
          files: [],
        },
        current: {
          source_run_id: "run-2",
          source_arm: "stock",
          label: "Codex (minimal setup)",
          bundle_sha256: "b".repeat(64),
          directory: "evaluator/imported-arms/current",
          files: [],
        },
      },
    });
    expect(labels.stock).toBe("Codex (minimal setup) · run run-1");
    expect(labels.current).toBe("Codex (minimal setup) · run run-2");
  });

  test("applySkillSelection blocks file-level symlink escape before reading target", async () => {
    const root = await tempDir("codex-ab-skill-symlink-");
    const home = join(root, "home");
    const outside = join(root, "outside.json");
    await mkdir(join(home, ".skills-mgr"), { recursive: true });
    await writeFile(outside, JSON.stringify({ skills: { alpha: { enabled: true } } }));
    await symlink(outside, join(home, ".skills-mgr/.skills-mgr.json"));
    await expect(applySkillSelection(home, { alpha: false })).rejects.toThrow("escapes the arm home");
  });

  test("launchConfiguration preserves mekugi-flags when --mekugi-build implies mekugi launcher", () => {
    const config = launchConfiguration({
      comparison: "stock-current",
      "mekugi-build": "/tmp/fake-mekugi-build",
      "mekugi-flags": JSON.stringify(["--shell-guard=false"]),
    });
    expect(config.prepare.currentLauncher).toBe("mekugi");
    expect(config.prepare.mekugiFlags).toEqual(["--shell-guard=false"]);
  });
});
