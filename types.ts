import type { CriterionEvidence } from "./semantic";

export type BenchmarkProfile = "mekugi" | "godoxy-icons" | "skills-mgr-bundle" | "task";
export type CodexLauncher = "codex" | "mekugi" | "grok";
export type Comparison = "custom" | "stock-current" | "setup-commits" | "same-setup" | "stock-mekugi" | "codex-mekugi-grok" | "journal-compaction" | "duplicate-output";
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];
export type BenchmarkModel = "gpt-6-astra" | "gpt-6.1-sol" | "grok:grok-4.7";

export type ArmOrder = "concurrent" | "stock-first" | "current-first";

export type ArmName = string;
export type CandidateId = `candidate-${number}`;
export interface ArmConfiguration { launcher: "codex" | "mekugi"; setup_commit: string }
export interface ArmImport { target_arm: ArmName; run_dir: string; arm: ArmName; bundle_sha256?: string }
export interface EvaluationPlan { mode: "reuse" | "fresh"; baselines?: Record<ArmName, ArmName> }
export const armNames = (state: Pick<RunState, "arms">): ArmName[] => Object.keys(state.arms);
export const candidateIds = (count: number): CandidateId[] => Array.from({ length: count }, (_, index) => `candidate-${index + 1}` as const);

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
  anonymous_id: CandidateId;
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
  home_image_id?: string;
  grade?: {
    preparation: CommandEvidence;
    evaluator_error?: string;
    supplemental_infrastructure_error?: string;
    semantic?: Record<string, CriterionEvidence[]>;
    supplemental_repeat?: CommandEvidence;
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
  task_pack?: { id: string; path: string; sha256: string };
  upstream_reference?: { base_commit: string; end_commit: string; files: Array<{ path: string; sha256: string }> };
  criteria?: { path: string; sha256: string; contract: import("./semantic").CriteriaContract };
  image: string;
  image_id?: string;
  dependency_image?: { key: string; base_image: string; image_id: string };
  evaluator_cache_image?: { key: string; image_id: string };
  home_storage?: "docker-cow";
  runtime_plugin_image?: { key: string; image_id: string };
  runtime_homes?: Record<string, { key: string; image_id: string }>;
  comparison?: Comparison;
  auto_compact_limit?: number;
  arm_order?: ArmOrder;
  trial?: { set_id: string; index: number; controls_sha256: string; plan_sha256: string };
  protected_runtime?: { boundary: "direct-egress-vs-router-only"; scripts: Array<{ path: string; sha256: string }> };
  mekugi_build?: { identity: import("./provenance").MekugiBuild; files: Array<{ path: string; sha256: string }> };
  mekugi_exports?: { capture: string; metrics: string; validator: { path: string; sha256: string }; reader: { path: string; sha256: string } };
  mekugi_exports_by_arm?: Partial<Record<ArmName, { capture: string; metrics: string; validator: { path: string; sha256: string }; reader: { path: string; sha256: string } }>>;
  mekugi_flags?: string[];
  imported_control?: { source_run_id: string; bundle_sha256: string; controls_sha256: string; stdout_sha256: string; stderr_sha256: string };
  planned_imports?: ArmImport[];
  evaluation?: EvaluationPlan;
  imported_arms?: Record<ArmName, {
    source_run_id: string; source_arm: ArmName; bundle_sha256: string; label: string;
    directory: string; evidence_arm: ArmName; files: Array<{ path: string; sha256: string }>;
  }>;
  execution: { model: BenchmarkModel | "gpt-6-sol"; reasoning_effort: ReasoningEffort; service_tier: string; current_launcher?: CodexLauncher };
  resource_limits: { cpus: string; memory: string };
  timeout_seconds: number;
  arm_configurations?: ArmConfiguration[];
  setup_revisions?: Record<ArmName, { commit: string; tree: string; manifest: string; manifest_sha256: string }>;
  snapshot_manifest: string;
  current_snapshot: { captured_at: string; manifest_sha256: string };
  runtime_tools: {
    bun: string;
    bun_sha256: string;
    codex_source: string;
    codex_version: string;
    codex_sha256: string;
    codex_code_mode_host_source: string;
    /** Absolute host tool-store mount source, or a run-relative empty store for isolated comparisons. */
    current_setup_installs: string;
    current_setup_files: string;
    current_setup_files_sha256: string;
    current_setup_mise_sha256?: string;
    current_setup_mise_source?: string;
    /** Bind shared executables read-only unless pinned in the image. */
    shared_binaries?: boolean;
    preflight_cache?: { go_build: string; go_pkg: string; bun?: string; source_run: string };
    codex_code_mode_host_sha256: string;
    mekugi_source?: string;
    mekugi_exec_source?: string;
    mekugi_exec_sha256?: string;
    mekugi_sha256?: string;
    mekugi_in_image?: boolean;
    grok_source?: string;
    grok_sha256?: string;
    grok_version?: string;
    codex_code_mode_host_size: number;
  };
  operator: { uid: number; gid: number };
  /** Infrastructure problems that invalidate interpretation without discarding captured evidence. */
  invalidity_reasons?: string[];
  /** Arms intentionally selected for this attempt; absent on a prepared run. */
  selected_arms?: ArmName[];
  arms: Record<ArmName, { repository: string; home_template: string; launcher?: "codex" | "mekugi" }>;
  pricing?: unknown;
  /** New judge rate kept separate so historical trial pricing controls stay immutable. */
  judge_pricing?: { captured_at: string; rate: import("./usage").ModelPricing };
  results?: Partial<Record<ArmName, ArmResult>>;
  arm_attempts?: Partial<Record<ArmName, {
    codex_home: string;
    grok_home?: string;
    container: string;
    started_at: string;
    finished_at?: string;
    status: "started" | "stopped" | "failed";
    error?: string;
    home_image_id?: string;
  }>>;
  finishing_history?: NonNullable<RunState["finishing"]>[];
  finishing?: {
    status: "running" | "complete" | "failed";
    started_at: string;
    finished_at?: string;
    error?: string;
    bundle_path: string;
  };
  judge?: JudgeReport;
}

export interface JudgePass {
  pass: 1 | 2;
  presentation: ArmName[];
  scores: Record<CandidateId, { correctness: number; completeness: number; maintainability: number; test_quality: number; weighted_total: number }>;
  evidence: string[];
  issues: Array<{ candidate: CandidateId; severity: "critical" | "major" | "minor"; detail: string }>;
  winner: CandidateId | "tie" | "none";
  criteria?: Record<CandidateId, CriterionEvidence[]>;
  rationale: string;
  reused?: Record<CandidateId, { source_run_id: string; source_arm: ArmName; pass: 1 | 2 }>;
}

export interface JudgeAttempt {
  home_image_id?: string;
  service_tier?: "default" | "priority" | "fast";
  stage?: string;
  pass: 1 | 2;
  attempt: number;
  status: "running" | "complete" | "failed" | "canceled";
  started_at: string;
  finished_at?: string;
  stdout_path: string;
  stderr_path: string;
  usage_home: string;
  error?: string;
  retry_delay_ms?: number;
}

export interface JudgeReport {
  status: "incomplete" | "complete" | "failed" | "canceled";
  started_at: string;
  finished_at?: string;
  /** Older completed reports retain their original judge model. */
  model: "gpt-6.1-sol" | "gpt-6-sol" | "gpt-5.6-sol";
  /** Medium is retained for completed reports created before high became the judge default. */
  reasoning_effort: "medium" | "high";
  /** Optional because completed medium/default reports predate persisted judge-tier metadata. */
  service_tier?: "default" | "priority" | "fast";
  passes: JudgePass[];
  agreement?: boolean;
  winner: ArmName | "tie" | "none";
  disagreement?: string;
  failed_pass?: 1 | 2;
  error?: string;
  attempts?: JudgeAttempt[];
  usage_homes: string[];
  recovery?: { started_at: string; previous_error: string; reused_passes: number[] };
}
