import type { ArmName, RunState } from "./types";

export function armLabels(state: Pick<RunState, "comparison" | "execution" | "mentor">): Record<ArmName, string> {
  if (state.mentor) {
    const setup = state.mentor.setup === "stock" ? "minimal setup" : "current-home setup";
    return { stock: `Codex + Mekugi (${setup}, mentor off)`, current: `Codex + Mekugi (${setup}, mentor on)` };
  }
  if (state.comparison === "codex-mekugi-grok") {
    return { stock: "Codex + Mekugi (Grok)", current: "Grok CLI" };
  }
  const stockSetup = state.comparison === "same-setup" ? "current-home setup" : "minimal setup";
  const currentSetup = state.comparison === "stock-mekugi" ? "minimal setup" : "current-home setup";
  const mekugi = state.comparison === "same-setup" || state.comparison === "stock-mekugi" || state.execution.current_launcher === "mekugi";
  return { stock: `Codex (${stockSetup})`, current: `Codex${mekugi ? " + Mekugi" : ""} (${currentSetup})` };
}
