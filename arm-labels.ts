import type { ArmName, RunState } from "./types";

export const presentationLabel = (index: number): string => index === 0 ? "A" : index === 1 ? "B" : `Setup ${index + 1}`;

export function armLabels(state: Pick<RunState, "comparison" | "execution" | "setup_revisions"> & Partial<Pick<RunState, "arms" | "imported_arms">>): Record<ArmName, string> {
  if (state.imported_arms) {
    const labels = { ...armLabels({ ...state, imported_arms: undefined }),
      ...Object.fromEntries(Object.entries(state.imported_arms).map(([arm, source]) => [arm, source.label])) };
    // An imported arm can share its setup label with a fresh arm; name its source run to tell them apart.
    for (const [arm, source] of Object.entries(state.imported_arms)) {
      if (Object.entries(labels).some(([other, label]) => other !== arm && label === source.label)) {
        labels[arm as ArmName] = `${source.label} · run ${source.source_run_id}`;
      }
    }
    return labels;
  }
  if (state.comparison === "custom") return Object.fromEntries(Object.entries(state.arms ?? {}).map(([arm, setup]) =>
    [arm, `${setup.launcher === "mekugi" ? "Codex + Mekugi" : "Codex"} (${state.setup_revisions?.[arm]?.commit === "stock" ? "stock setup" : "setup " + (state.setup_revisions?.[arm]?.commit.slice(0, 12) ?? "unavailable") + (state.setup_revisions?.[arm]?.worktree ? " + tracked worktree" : "")})`]));
  if (state.comparison === "setup-commits") {
    const launcher = state.execution.current_launcher === "mekugi" ? "Codex + Mekugi" : "Codex";
    return { stock: `${launcher} (setup ${state.setup_revisions?.stock.commit.slice(0, 12) ?? "A"})`, current: `${launcher} (setup ${state.setup_revisions?.current.commit.slice(0, 12) ?? "B"})` };
  }
  if (state.comparison === "duplicate-output") return { stock: "Codex + Mekugi (duplicate output off)", current: "Codex + Mekugi (duplicate output on)" };
  if (state.comparison === "journal-compaction") return { stock: "Codex + Mekugi (journal compaction off)", current: "Codex + Mekugi (journal compaction on: auto)" };
  if (state.comparison === "codex-mekugi-grok") {
    return { stock: "Codex + Mekugi (Grok)", current: "Grok CLI" };
  }
  const stockSetup = state.comparison === "same-setup" ? "current-home setup" : "minimal setup";
  const currentSetup = state.comparison === "stock-mekugi" ? "minimal setup" : "current-home setup";
  const mekugi = state.comparison === "same-setup" || state.comparison === "stock-mekugi" || state.execution.current_launcher === "mekugi";
  return { stock: `Codex (${stockSetup})`, current: `Codex${mekugi ? " + Mekugi" : ""} (${currentSetup})` };
}
