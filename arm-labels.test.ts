import { expect, test } from "bun:test";
import { armLabels } from "./arm-labels";
import type { RunState } from "./types";
const execution: RunState["execution"] = { model: "gpt-6-astra", reasoning_effort: "medium", service_tier: "default" };
test("arm names follow setup and launcher rather than storage position", () => {
  expect(armLabels({ execution })).toEqual({ stock: "Codex (minimal setup)", current: "Codex (current-home setup)" });
  expect(armLabels({ execution: { ...execution, current_launcher: "mekugi" } }).current).toBe("Codex + Mekugi (current-home setup)");
  expect(armLabels({ execution, comparison: "same-setup" })).toEqual({ stock: "Codex (current-home setup)", current: "Codex + Mekugi (current-home setup)" });
  expect(armLabels({ execution, comparison: "stock-mekugi" })).toEqual({ stock: "Codex (minimal setup)", current: "Codex + Mekugi (minimal setup)" });
  expect(armLabels({ execution, comparison: "duplicate-output" })).toEqual({ stock: "Codex + Mekugi (duplicate output off)", current: "Codex + Mekugi (duplicate output on)" });
  expect(armLabels({ execution, comparison: "codex-mekugi-grok" })).toEqual({ stock: "Codex + Mekugi (Grok)", current: "Grok CLI" });
});

test("an imported arm sharing a fresh arm's label names its source run", () => {
  const source = { source_run_id: "task-run-base", source_arm: "current" as const, bundle_sha256: "", directory: "", evidence_arm: "current" as const, files: [] };
  expect(armLabels({ execution, comparison: "stock-mekugi", imported_arms: { stock: { ...source, label: "Codex + Mekugi (minimal setup)" } } as RunState["imported_arms"] }))
    .toEqual({ stock: "Codex + Mekugi (minimal setup) · run task-run-base", current: "Codex + Mekugi (minimal setup)" });
  expect(armLabels({ execution, comparison: "stock-mekugi", imported_arms: { stock: { ...source, label: "Codex (minimal setup)" } } as RunState["imported_arms"] }))
    .toEqual({ stock: "Codex (minimal setup)", current: "Codex + Mekugi (minimal setup)" });
});
