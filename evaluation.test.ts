import { expect, test } from "bun:test";
import { evaluationPlan } from "./evaluation";
import { launchConfiguration } from "./launch";

const imports = [{ target_arm: "stock", run_dir: "/historical", arm: "current" },
  { target_arm: "current", run_dir: "/historical", arm: "arm-3" }];

test("historical evaluation defaults and per-fresh-arm baselines reach launch configuration", () => {
  expect(evaluationPlan(undefined, undefined, undefined, ["stock", "current"])).toEqual({ mode: "fresh" });
  expect(evaluationPlan(undefined, undefined, imports, ["stock", "current", "arm-3", "arm-4"]))
    .toEqual({ mode: "reuse", baselines: { "arm-3": "current", "arm-4": "current" } });
  const configured = launchConfiguration({ preset: "custom", task: "skills-mgr-agent-cli",
    arms: JSON.stringify(Array.from({ length: 4 }, () => ({ launcher: "mekugi", setup_commit: "HEAD" }))),
    "import-arms": JSON.stringify(imports), "evaluation-baselines": '{"arm-3":"stock","arm-4":"current"}' });
  expect(configured.evaluation).toEqual({ mode: "reuse", baselines: { "arm-3": "stock", "arm-4": "current" } });
  expect(evaluationPlan("fresh", undefined, imports, ["stock", "current", "arm-3"])).toEqual({ mode: "fresh" });
});

test("evaluation rejects unknown modes and mappings outside fresh-to-imported ownership", () => {
  expect(() => evaluationPlan("other", undefined, imports, ["stock", "current", "arm-3"])).toThrow("mode");
  expect(() => evaluationPlan("reuse", undefined, undefined, ["stock", "current"])).toThrow("requires historical");
  expect(() => evaluationPlan("fresh", {}, imports, ["stock", "current", "arm-3"])).toThrow("require reuse");
  for (const mapping of [[], null, { stock: "current" }, { "arm-3": "arm-3" }, { "arm-4": "stock" }, { "arm-3": 1 }]) {
    expect(() => evaluationPlan("reuse", mapping, imports, ["stock", "current", "arm-3"])).toThrow();
  }
});
