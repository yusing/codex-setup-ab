import { join } from "node:path";
import type { CriteriaContract, SemanticCheck } from "../semantic";
import type { SemanticProbe } from "../semantic-protocol";
import type { RunState } from "../types";
import { prepareTaskQualificationRun } from "./task-qualification";

/** Observe real installer functions. Fake executables record argv, not verdicts. */
export function nvmQualificationChecks(contract: CriteriaContract): SemanticCheck[] {
  const observer = contract.existing_test_verification?.cases.find(item => item.id === "existing-nvm-source-observations");
  if (!observer || observer.kind !== "command") throw new Error("NVM pack has no frozen installer observer");
  const wiring = observer;
  type Download = { id: string; args: string[]; route?: string; exit?: number };
  function batch(id: string, operation: string, inputs: Download[], expected: string[][]): SemanticProbe {
    return { ...wiring, id,
      stdin: JSON.stringify({ operation, cases: inputs }), expected: JSON.stringify(inputs.map((input, index) => ({
        id: input.id, exit: input.exit ?? 0, argv: expected[index], proof: false, stdout: "", stderr: false,
      }))) };
  }
  const url = "https://example.test/nvm.sh";
  const literal = batch("literal-wget-arguments", "download", [
    { id: "substitution-url", args: ["http://example.test/$(touch observer-proof)/x", "-o", "-"] },
    { id: "spaced-output", args: ["-s", url, "-o", "dir with space/nvm.sh"] },
    { id: "ampersand-url", args: ["-s", "http://example.test/nvm.sh?a=1&b=2", "-o", "-"] },
    { id: "quoted-metacharacters", args: ["http://example.test/';`touch observer-proof`;?a=1&b=2", "-o", 'dir "quoted"/$(touch observer-proof).sh'] },
  ], [
    ["http://example.test/$(touch observer-proof)/x", "-O", "-"],
    ["-q", url, "-O", "dir with space/nvm.sh"],
    ["-q", "http://example.test/nvm.sh?a=1&b=2", "-O", "-"],
    ["http://example.test/';`touch observer-proof`;?a=1&b=2", "-O", 'dir "quoted"/$(touch observer-proof).sh'],
  ]);
  const translations = batch("wget-option-translations", "download", [
    { id: "all-flags", args: ["--progress-bar", "--compressed", "--fail", "-L", "-I", "-s", "-sS", "-C", "-", url, "-o", "target"] },
    { id: "numeric-resume", args: ["-C", "128", "--progress-bar", url, "-o", "target"] },
    { id: "option-like-resume-value", args: ["-C", "--compressed", "-s", url, "-o", "target"] },
    { id: "repeated-options", args: ["-s", "-s", "-I", "-I", url] },
  ], [
    ["--progress=bar", "--server-response", "-q", "-nv", "-c", url, "-O", "target"],
    ["-c", "--progress=bar", url, "-O", "target"],
    ["-c", "-q", url, "-O", "target"],
    ["-q", "-q", "--server-response", "--server-response", url],
  ]);
  const curl = batch("unchanged-curl-route", "download", [
    { id: "curl-literal-and-flags", route: "curl", args: ["-L", "-C", "128", "--progress-bar", "-sS", "http://example.test/$(touch observer-proof)?a=1&b=2", "-o", "dir with space/nvm.sh"] },
    { id: "curl-exit-status", route: "curl", args: [url, "-o", "-"], exit: 23 },
  ], [
    ["--fail", "--compressed", "-q", "-L", "-C", "128", "--progress-bar", "-sS", "http://example.test/$(touch observer-proof)?a=1&b=2", "-o", "dir with space/nvm.sh"],
    ["--fail", "--compressed", "-q", url, "-o", "-"],
  ]);
  const posix = batch("posix-function-runtime", "posix", [
    { id: "posix-basic-wget", args: ["-s", url, "-o", "target"] },
  ], [["-q", url, "-O", "target"]]);
  const syntax: SemanticProbe = { id: "installer-sh-syntax", kind: "command", command: ["/bin/sh", "-n", "install.sh"], args: [],
    expected_exit: 0, format: "text", expected: "" };
  const entry: SemanticProbe = { id: "bash-entry-requirement", kind: "command", command: ["python3", "-I", "-c",
    'import json, os, subprocess\nenv = dict(os.environ)\nfor key in ("BASH_VERSION", "ZSH_VERSION", "BASH_ENV", "ENV"):\n    env.pop(key, None)\nenv["NVM_ENV"] = "testing"\nresult = subprocess.run(["/bin/sh", "install.sh"], env=env, capture_output=True, text=True)\nprint(json.dumps(dict(exit=result.returncode, stdout=result.stdout, stderr=result.stderr)))\n'],
    args: [], expected_exit: 0, format: "json", expected: JSON.stringify({ exit: 1, stdout: "",
      stderr: 'Error: the install instructions explicitly say to pipe the install script to `bash`; please follow them\n' }) };
  return [
    { criterion: "literal-arguments", files: [], command: observer.command,
      rationale: "Record exact wget argv for literal substitutions, spaces, quotes, semicolons, backticks and ampersands, and observe that no substitution proof was created.",
      verification: { schema: "codex-ab.verification.v1", cases: [literal] } },
    { criterion: "wget-translations", files: [], command: observer.command,
      rationale: "Observe ordered wget argv for every required flag, repeated flags and consumption of dash, numeric and option-like resume values.",
      verification: { schema: "codex-ab.verification.v1", cases: [translations] } },
    { criterion: "curl-posix", files: [], command: observer.command,
      rationale: "Observe unchanged curl argv and status propagation, sh syntax, the Bash entry guard and execution of the sourced download function under /bin/sh. This is not whole-installer POSIX runtime coverage.",
      verification: { schema: "codex-ab.verification.v1", cases: [curl, posix, syntax, entry] } },
  ];
}

/** Build an ordinary qualification fixture from exact upstream commits, without model inference. */
export async function prepareNvmQualificationRun(source: string, root: string, image: string): Promise<RunState> {
  const state = await prepareTaskQualificationRun(join(import.meta.dir, "../tasks/nvm-download-no-eval/manifest.json"), source, root, image);
  state.results = { stock: { arm: "stock", anonymous_id: "candidate-1", container: "no-implementation-container",
      started_at: new Date().toISOString(), finished_at: new Date().toISOString(), agent_elapsed_ms: 0,
      exit_code: 0, timed_out: false, canceled: false, patch_path: "evaluator/upstream/changes.patch", stdout_path: "unused", stderr_path: "unused",
      changed_files: ["install.sh", "test/install_script/nvm_download_no_eval_injection"], head_after_agent: state.upstream_reference!.end_commit, grade: { passed: false, elapsed_ms: 0,
      preparation: { command: "fixture: pinned upstream source", started_at: new Date().toISOString(), elapsed_ms: 0, exit_code: 0, stdout: "", stderr: "" },
      router_suite: { command: "not run", started_at: new Date().toISOString(), elapsed_ms: 0, exit_code: -1, stdout: "", stderr: "" } } } };
  return state;
}
