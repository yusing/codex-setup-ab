import buildInputs from "./mekugi/build_inputs.py" with { type: "text" };
import benchmarkJsonl from "./mekugi/benchmark_jsonl.py" with { type: "text" };
import analyzeCapture from "./mekugi/analyze_capture.py" with { type: "text" };
import isolatedCodex from "./mekugi/isolated-codex.sh" with { type: "text" };
import agentMounts from "./mekugi/agent-mounts.sh" with { type: "text" };
import agentCheck from "./mekugi/agent-check.py" with { type: "text" };

export const MEKUGI_BUILD_INPUTS = buildInputs;
export const MEKUGI_EXPORT_SCRIPTS = { "benchmark_jsonl.py": benchmarkJsonl, "analyze_capture.py": analyzeCapture } as const;
export const MEKUGI_ISOLATION_SCRIPTS = { "isolated-codex.sh": isolatedCodex, "agent-mounts.sh": agentMounts, "agent-check.py": agentCheck } as const;
