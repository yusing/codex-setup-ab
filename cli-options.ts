export const COMMAND_OPTIONS: Record<string, string[]> = {
    serve: ["host", "port"],
    launch: ["preset", "task", "task-file", "prepare-only", "confirm-paid-inference", "count", "order", "journal-compaction", "source", "profile", "base", "forbidden", "criteria", "task-pack", "model", "reasoning-effort", "auto-compact-limit", "current-home", "review-treatment", "comparison", "mekugi-flags", "mekugi-source", "mekugi-build", "protect-mekugi", "current-launcher", "mekugi-bin", "grok-bin", "codex-bin", "bun-bin", "image", "timeout", "cpus", "memory", "docker-bin", "auth-file", "grok-auth-file", "output-parent"],
    "build-mekugi": ["source", "image", "output-parent", "docker-bin"],
    prepare: ["auto-compact-limit", "profile", "model", "reasoning-effort", "source", "base", "forbidden", "task", "criteria", "task-pack", "output-parent", "current-home", "review-treatment", "comparison", "mekugi-flags", "mekugi-source", "mekugi-build", "protect-mekugi", "current-launcher", "mekugi-bin", "grok-bin", "codex-bin", "bun-bin", "image", "timeout", "cpus", "memory"],
    "prepare-trials": ["run-dir", "count", "order", "output-parent", "docker-bin"],
    "prepare-suite": ["suite", "sources-file", "count", "comparison", "order", "output-parent", "current-home", "review-treatment", "mekugi-flags", "mekugi-source", "mekugi-build", "mekugi-bin", "codex-bin", "bun-bin", "image", "timeout", "cpus", "memory", "docker-bin"],
    "run-suite": ["suite-run", "auth-file", "docker-bin", "confirm-paid-inference"],
    "report-suite": ["suite-run"],
    "run-trials": ["trial-set", "auth-file", "grok-auth-file", "docker-bin", "confirm-paid-inference"],
    "report-trials": ["trial-set"],
    preflight: ["run-dir", "docker-bin"],
    run: ["run-dir", "auth-file", "grok-auth-file", "docker-bin", "arm", "control-run", "control-bundle-sha256", "confirm-paid-inference"],
    finish: ["run-dir", "auth-file", "docker-bin", "confirm-paid-inference", "recover-judge"],
    judge: ["run-dir", "auth-file", "docker-bin", "confirm-paid-inference"],
    remeter: ["run-dir", "exclusions"],
    report: ["run-dir", "output-dir", "source-assessments"],
    invalidate: ["run-dir", "reason"],
};

export type CliOptions = Record<string, string | boolean>;
export const BOOLEAN_FLAGS = new Set(["confirm-paid-inference", "protect-mekugi", "recover-judge", "prepare-only"]);
