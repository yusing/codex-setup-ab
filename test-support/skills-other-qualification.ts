import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CriteriaContract, SemanticCheck } from "../semantic";
import type { SemanticProbe } from "../semantic-protocol";

const script = (name: string): string => readFileSync(join(import.meta.dir, name), "utf8");

function check(criterion: string, command: string[], args: string[], expected: unknown, rationale: string): SemanticCheck {
  const observation: SemanticProbe = { id: `${criterion}-observations`, kind: "command", command, args,
    expected_exit: 0, format: "json", expected: JSON.stringify(expected) };
  return { criterion, files: [], command, rationale,
    verification: { schema: "codex-ab.verification.v1", cases: [observation] } };
}

/** Real get/run/list observations, with independent expected values in the supervisor. */
export function skillsGetQualificationChecks(contract: CriteriaContract): SemanticCheck[] {
  const existing = contract.existing_test_verification?.cases[0];
  if (existing?.kind !== "command") throw new Error("missing frozen skills acquisition observer");
  const expressions = ["lang rust && true", 'query=lang; "$query" rust', "UNUSED=1 lang rust", "lang rust >/dev/null",
    'lang rust >"$(lang rust; printf /dev/null)"', "lang r*", "tooling shadow*", "has_dependency example"];
  return [
    check("single-query-fast-path", existing.command, ["fast"], { queries:
      ["lang rust", "lang ts", "tooling shadowtree", "tooling k8s"].map(expression => ({
        expression, body: "body\n", get: "ok", run: "ok", script: "checked",
      })) }, "Root evidence serves get and run without touching an unrelated invalid ignore entry, as in pinned upstream acquisition_evidence_test.go."),
    check("expression-semantics", existing.command, ["semantics"], { expressions: expressions.map((expression, index) => ({
      expression, clean: "ok", body: "body\n", poisoned: index === 4 ? "disabled" : "traversal",
    })) }, "Clean expressions retain baseline body bytes and enabled decisions; unrelated traversal failure still reaches compound, dynamic, assignment, redirection, wildcard and dependency evaluations. Command-substitution redirection retains baseline disabled classification."),
    check("shared-consumers", existing.command, ["shared"], { ignored: "disabled", added: "body\n", added_status: "ok", removed: "disabled",
      canceled_get: true, canceled_run: true, list_status: "ok", rust_listed: true, python_listed: true, poisoned_list: "traversal",
    }, "Observe ignored/nested evidence, addition/removal between calls, canceled get/run, and complete shared list evaluation of two languages."),
    check("no-persistent-cache", existing.command, ["cache"], { body: "body\n", get_status: "ok", repeat: "body\n", repeat_status: "ok", unchanged: true, removed: "disabled" },
      "Snapshot all project and isolated manager files before/after repeated acquisition, then remove evidence. This detects task-local durable cache writes, not a universal absence of writes elsewhere."),
    check("tests", ["python3", "-I", "-c", script("skills-get-tests-observer.py")], [], {
      suite_passed: true, fast_mutation_detected: true, glob_mutation_detected: true,
    }, "Run the actual Go suite, then require named failing Go test events against full-walk and wildcard-shortcircuit source mutations. Compilation failures and empty passing selections do not establish sensitivity."),
  ];
}

/** Authored controls use ZIP, but neither the task nor adaptive judging requires that format or CLI spelling. */
export function skillsBundleQualificationChecks(): SemanticCheck[] {
  const command = ["python3", "-I", "-c", script("skills-bundle-observer.py")];
  const files = {
    "SKILL.md": Buffer.from("---\nname: example\ndescription: Example.\n---\nbody\n").toString("hex"),
    "references/guide.md": Buffer.from("reference\n").toString("hex"),
    "scripts/check.sh": Buffer.from("#!/bin/sh\nprintf checked\n").toString("hex"),
  };
  return [
    check("commands", command, ["commands"], { created: true, verified: true, extracted: true, files },
      "Create, verify and extract an actual local skill tree, independently compare every file byte."),
    check("reproducibility", command, ["reproducibility"], { created: true, identical_bytes: true },
      "Equivalent trees with different paths, mtimes and creation order must produce identical archive bytes."),
    check("executables", command, ["executables"], { extracted: true, executable: true, output: "checked" },
      "Extract a script, inspect its executable bits and execute it through the OS."),
    check("unsafe-and-corrupt", command, ["unsafe-and-corrupt"], { valid_verified: true,
      cases: ["../escape", "/absolute", "safe/../../escape", "..\\escape", "symlink", "garbage", "truncated"].map(name => ({
        case: name, verify_rejected: true, extract_rejected: true,
      })), escaped_file_absent: true },
      "Require valid verification and reject traversal/absolute/link members, garbage and truncation through both verify and extract without escaping output (no claim about partial destination cleanup)."),
    check("no-overwrite", command, ["no-overwrite"], { valid_created: true, archive_preserved: true,
      destination_preserved: true }, "A valid create coexists with exact preservation of preexisting archive and destination sentinel bytes/modes; harmless additions and skip-with-success collision handling are allowed."),
    check("tests", ["python3", "-I", "-c", script("skills-bundle-tests-observer.py")], [], {
      suite_passed: true, corrupted_roundtrip_detected: true, unsafe_acceptance_detected: true,
    }, "The actual Go suite must detect corrupted round-trip contents and acceptance of unsafe archives, using named failing test events rather than an exit-zero or test count."),
  ];
}
