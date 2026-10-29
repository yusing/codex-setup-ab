import type { ArmConfiguration } from "./types";

/** Parse the operator-owned composition before preparation has external effects. */
export function parseArmConfigurations(value: unknown): ArmConfiguration[] {
  if (!Array.isArray(value) || value.length < 2) throw new Error("Custom composition requires at least two arms");
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)
      || Object.keys(item).some(key => !["launcher", "setup_commit"].includes(key))
      || !["stock", "codex", "mekugi"].includes(item.launcher)
      || typeof item.setup_commit !== "string" || !item.setup_commit.trim()) {
      throw new Error(`Arm ${index + 1} requires launcher (stock, codex, or mekugi) and setup_commit`);
    }
    return { launcher: item.launcher === "stock" ? "codex" : item.launcher, setup_commit: item.setup_commit.trim() };
  });
}

export function compositionKeys(count: number): string[] {
  return Array.from({ length: count }, (_, index) => index === 0 ? "stock" : index === 1 ? "current" : `arm-${index + 1}`);
}
