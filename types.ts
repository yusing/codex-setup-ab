export type BenchmarkProfile = "hpatch" | "godoxy-icons";
export type CodexLauncher = "codex" | "hpatch";
export type ReasoningEffort = "medium" | "xhigh";

export type ArmName = "stock" | "current";

export interface CommandEvidence {
  validation_error?: string;
  command: string;
  started_at: string;
  elapsed_ms: number;
  exit_code: number;
  stdout: string;
  stderr: string;
}

export interface ArmResult {
  arm: ArmName;
  anonymous_id: "candidate-1" | "candidate-2";
  container: string;
  started_at: string;
  finished_at: string;
  agent_elapsed_ms: number;
  exit_code: number;
  timed_out: boolean;
  canceled: boolean;
  patch_path: string;
  stdout_path: string;
  stderr_path: string;
  changed_files: string[];
  head_after_agent: string;
  collection_error?: string;
  lifecycle_error?: string;
  grade?: {
    preparation: CommandEvidence;
    acceptance: CommandEvidence;
    router_suite: CommandEvidence;
    elapsed_ms: number;
    passed: boolean;
  };
}

export interface RunState {
  schema_version: 1;
  profile?: BenchmarkProfile;
  submodules?: Array<{ path: string; sha: string; source: string }>;
  id: string;
  created_at: string;
  status: "prepared" | "running" | "complete" | "partial";
  error?: string;
  source: { path: string; base_commit: string; base_tree: string; source_timestamp: number; forbidden_commit: string };
  task: { path: string; sha256: string };
  acceptance?: { path: string; sha256: string };
  image: string;
  image_id?: string;
  execution: { model: "gpt-6-astra"; reasoning_effort: ReasoningEffort; service_tier: string; current_launcher?: CodexLauncher };
  resource_limits: { cpus: string; memory: string };
  timeout_seconds: number;
  snapshot_manifest: string;
  current_snapshot: { captured_at: string; manifest_sha256: string };
  runtime_tools: {
    bun: string;
    bun_sha256: string;
    codex_source: string;
    codex_version: string;
    codex_sha256: string;
    codex_code_mode_host_source: string;
    current_setup_installs: string;
    current_setup_files: string;
    current_setup_files_sha256: string;
    current_setup_mise_sha256: string;
    codex_code_mode_host_sha256: string;
    hpatch_source?: string;
    hpatch_sha256?: string;
    codex_code_mode_host_size: number;
  };
  operator: { uid: number; gid: number };
  /** Infrastructure problems that invalidate interpretation without discarding captured evidence. */
  invalidity_reasons?: string[];
  /** Arms intentionally selected for this attempt; absent on a prepared run. */
  selected_arms?: ArmName[];
  arms: Record<ArmName, { repository: string; home_template: string }>;
  pricing?: unknown;
  results?: Partial<Record<ArmName, ArmResult>>;
  arm_attempts?: Partial<Record<ArmName, {
    codex_home: string;
    container: string;
    started_at: string;
    finished_at?: string;
    status: "started" | "stopped" | "failed";
    error?: string;
  }>>;
  judge?: JudgeReport;
}

export interface JudgePass {
  pass: 1 | 2;
  presentation: [ArmName, ArmName];
  scores: Record<"candidate-1" | "candidate-2", { correctness: number; completeness: number; maintainability: number; test_quality: number; weighted_total: number }>;
  evidence: string[];
  issues: Array<{ candidate: "candidate-1" | "candidate-2"; severity: "critical" | "major" | "minor"; detail: string }>;
  winner: "candidate-1" | "candidate-2" | "tie" | "none";
  rationale: string;
}

export interface JudgeReport {
  status: "incomplete" | "complete" | "failed" | "canceled";
  started_at: string;
  finished_at?: string;
  model: "gpt-5.6-sol";
  /** Medium is retained for completed reports created before high became the judge default. */
  reasoning_effort: "medium" | "high";
  /** Optional because completed medium/default reports predate persisted judge-tier metadata. */
  service_tier?: "default" | "priority";
  passes: JudgePass[];
  agreement?: boolean;
  winner: ArmName | "tie" | "none";
  disagreement?: string;
  error?: string;
  usage_homes: string[];
}
