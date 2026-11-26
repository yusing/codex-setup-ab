import { describe, expect, test } from "bun:test";
import { classifyCandidateFailure, sanitizeDiagnosticDetail } from "./candidate-failure";

describe("classifyCandidateFailure", () => {
  test("classifies OOM-killed containers as non-retryable infrastructure_failure", () => {
    const result = classifyCandidateFailure({
      exitCode: 137,
      oomKilled: true,
      stderr: "Killed",
      stdout: "",
    });
    expect(result).toEqual({
      execution: "infrastructure_failure",
      reason: "container_oom_killed",
      retryable: false,
      detail: "Container was OOM-killed (exit 137)",
    });
  });

  test.each([
    ["HTTP 429 in stderr", { exitCode: 1, stderr: "Error: HTTP 429 Too Many Requests", stdout: "" }],
    ["rate limit in stderr", { exitCode: 1, stderr: "Request rate_limit_exceeded, please retry later", stdout: "" }],
    ["capacity in stderr", { exitCode: 1, stderr: "Selected model is at capacity. Please try a different model.", stdout: "" }],
    ["capacity in JSONL error event", { exitCode: 1, stderr: "", stdout: JSON.stringify({ type: "error", message: "Selected model is at capacity" }) + "\n" }],
    ["HTTP 502 Bad Gateway", { exitCode: 1, stderr: "Upstream returned 502 Bad Gateway", stdout: "" }],
    ["HTTP 503 Service Unavailable", { exitCode: 1, stderr: "status 503 Service Unavailable", stdout: "" }],
    ["HTTP 504 Gateway Timeout", { exitCode: 1, stderr: "HTTP 504 Gateway Timeout", stdout: "" }],
    ["overloaded in JSONL turn.failed", { exitCode: 1, stderr: "", stdout: JSON.stringify({ type: "turn.failed", error: { type: "overloaded_error", message: "Server is overloaded" } }) + "\n" }],
    ["ECONNRESET", { exitCode: 1, stderr: "fetch failed: read ECONNRESET", stdout: "" }],
    ["ETIMEDOUT", { exitCode: 1, stderr: "connect ETIMEDOUT 1.2.3.4:443", stdout: "" }],
    ["EAI_AGAIN", { exitCode: 1, stderr: "getaddrinfo EAI_AGAIN api.openai.com", stdout: "" }],
    ["TLS handshake timeout", { exitCode: 1, stderr: "net/http: TLS handshake timeout", stdout: "" }],
    ["stream disconnected before completion", { exitCode: 1, stderr: "", stdout: JSON.stringify({ type: "error", message: "Reconnecting... 5/5 (stream disconnected before completion)" }) + "\n" }],
  ])("classifies transient provider/network error as retryable infrastructure_failure: %s", (_label, input) => {
    const result = classifyCandidateFailure(input);
    expect(result.execution).toBe("infrastructure_failure");
    expect(result.reason).toBe("provider_transient_error");
    expect(result.retryable).toBe(true);
    expect(result.detail.length).toBeGreaterThan(0);
  });

  test("does not classify recovered stream disconnect after completion as transient", () => {
    const stdout = [
      JSON.stringify({ type: "error", message: "stream disconnected before completion" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Finished." } }),
      JSON.stringify({ type: "turn.completed" }),
    ].join("\n") + "\n";
    const result = classifyCandidateFailure({ exitCode: 1, stderr: "", stdout });
    expect(result.execution).toBe("unknown");
    expect(result.reason).toBe("unknown_nonzero_exit");
    expect(result.retryable).toBe(false);
  });

  test.each([
    ["HTTP 401", { exitCode: 1, stderr: "HTTP 401 Unauthorized: invalid credentials", stdout: "" }],
    ["HTTP 403", { exitCode: 1, stderr: "Status code 403 Forbidden", stdout: "" }],
    ["invalid_api_key", { exitCode: 1, stderr: "", stdout: JSON.stringify({ type: "error", error: { code: "invalid_api_key", message: "Incorrect API key provided" } }) + "\n" }],
    ["insufficient_quota even with HTTP 429", { exitCode: 1, stderr: "HTTP 429: insufficient_quota - You exceeded your current quota", stdout: "" }],
    ["authentication failed", { exitCode: 1, stderr: "Provider authentication failed", stdout: "" }],
  ])("classifies auth/billing/quota error as non-retryable infrastructure_failure: %s", (_label, input) => {
    const result = classifyCandidateFailure(input);
    expect(result.execution).toBe("infrastructure_failure");
    expect(result.reason).toBe("provider_auth_or_quota");
    expect(result.retryable).toBe(false);
  });

  test.each([
    ["exit code 127", { exitCode: 127, stderr: "", stdout: "" }],
    ["exit code 126", { exitCode: 126, stderr: "", stdout: "" }],
    ["command not found", { exitCode: 1, stderr: "sh: 1: codex: command not found", stdout: "" }],
    ["cannot execute", { exitCode: 1, stderr: "/usr/local/bin/mekugi: cannot execute binary file", stdout: "" }],
    ["ENOENT", { exitCode: 1, stderr: "Error: spawn codex ENOENT", stdout: "" }],
    ["launcher no such file", { exitCode: 1, stderr: "exec: /usr/local/bin/mekugi: No such file or directory", stdout: "" }],
  ])("classifies runtime/CLI launch failure as non-retryable infrastructure_failure: %s", (_label, input) => {
    const result = classifyCandidateFailure(input);
    expect(result.execution).toBe("infrastructure_failure");
    expect(result.reason).toBe("runtime_cli_error");
    expect(result.retryable).toBe(false);
  });

  test.each([
    ["JSONL turn.failed model error", { exitCode: 1, stderr: "", stdout: JSON.stringify({ type: "turn.failed", error: { message: "Maximum number of turns reached" } }) + "\n" }],
    ["JSONL refusal error", { exitCode: 1, stderr: "", stdout: JSON.stringify({ type: "error", message: "Model refused request due to content_policy" }) + "\n" }],
    ["JSONL generic model error event", { exitCode: 1, stderr: "", stdout: JSON.stringify({ type: "response.failed", response: { error: { code: "context_length_exceeded", message: "Input exceeds maximum context length" } } }) + "\n" }],
    ["stderr max_steps", { exitCode: 1, stderr: "Agent stopped after reaching max_steps limit", stdout: "" }],
  ])("classifies model/agent-side error as non-retryable model_failure: %s", (_label, input) => {
    const result = classifyCandidateFailure(input);
    expect(result.execution).toBe("model_failure");
    expect(result.reason).toBe("model_error");
    expect(result.retryable).toBe(false);
  });

  test("ignores infra-looking text inside normal agent_message or command_execution JSONL items", () => {
    const stdout = [
      JSON.stringify({ type: "item.completed", item: { type: "command_execution", aggregated_output: "HTTP 429 Too Many Requests\ncommand not found" } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Handled invalid_api_key and ECONNRESET in tests." } }),
    ].join("\n") + "\n";
    const result = classifyCandidateFailure({ exitCode: 1, stderr: "", stdout });
    expect(result.execution).toBe("unknown");
    expect(result.reason).toBe("unknown_nonzero_exit");
    expect(result.retryable).toBe(false);
  });

  test("classifies ambiguous nonzero exit as unknown to preserve statistical honesty", () => {
    const result = classifyCandidateFailure({
      exitCode: 2,
      stderr: "unexpected failure during processing",
      stdout: "",
    });
    expect(result).toEqual({
      execution: "unknown",
      reason: "unknown_nonzero_exit",
      retryable: false,
      detail: "unexpected failure during processing",
    });
  });

  test("redacts secrets and truncates long diagnostic details safely", () => {
    const raw = ["HTTP 401 Unauthorized Authorization: Bearer ", "eyJhbGciOiJIUzI1NiJ9", ".", "placeholderpayload", " api_key=", "sk", "-proj-", "0000000000000000", " ", "x".repeat(400)].join("");
    const detail = sanitizeDiagnosticDetail(raw);
    expect(detail).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(detail).not.toContain(["sk", "proj", "0000000000000000"].join("-"));
    expect(detail).toContain("[REDACTED]");
    expect(detail.length).toBeLessThanOrEqual(240);
    expect(detail.endsWith("...")).toBe(true);
  });
});
