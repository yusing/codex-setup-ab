import { afterAll, beforeEach } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, symlink, readlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { prepare as prepareInputs } from "../prepare";
import { checked } from "../process";
import { readState, writeState, sha256 } from "../state";
import candidateCollector from "../candidate-script.txt" with { type: "text" };
import { JUDGE_DISABLED_FEATURES } from "../judge-boundary";
import { fixturePricing } from "./pricing";

/** Each file owns its repositories, fake Docker, and cleanup. */
export async function runnerFixture() {
  let root: string;
  let source: string;
  let home: string;
  let task: string;
  let fixtureCriteria: string;
  let mekugiSource: string;
  let base: string;
  let future: string;
  let codexHash!: string;
  let codeModeHostHash!: string;
  const originalPath = process.env.PATH;
  let brewPrefix: string;
  const fixtureVerification = { schema: "codex-ab.verification.v1" as const, cases: [
    { id: "fixture", kind: "command" as const, command: ["printf", "fixture"], stdin: "", expected_exit: 0, format: "text" as const, expected: "fixture" },
  ] };
  const fixtureRepair = { defect: "fixture adapter was deliberately broken", retained_inputs: ["fixture input"], retained_assertions: ["fixture output"],
    retained_edge_cases: ["same frozen cases"], retained_failure_conditions: ["wrong fixture output"] };
  // These model-free controls exercise orchestration, not the task's real behavior.
  const fixtureControls = { schema: "codex-ab.evaluator-controls.v1" as const, cases: ["reference", "baseline", "negative", "alternative"].map(role => ({
    id: role, role, base: "baseline", files: [], expected: { fixture: ["baseline", "negative"].includes(role) ? "fail" : "pass" },
  })) };

  async function file(path: string, content = "fixture\n", mode?: number): Promise<void> {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content, mode === undefined ? undefined : { mode });
  }

  async function fixtureHome(): Promise<string> {
    const h = join(root, "fixture-home");
    await file(join(h, ".bash_profile"), 'export PATH="/fixture-python/bin:$PATH"\n');
    for (const name of ["config.toml", "overridden_base_instructions.md", "AGENTS.md", "LARGE-TASK.md", "SMALL-TASK.md", "IMPLEMENTATION.md", "hooks.json", "herdr-agent-state.sh"]) {
      await file(join(h, ".codex", name), name === "config.toml" ? '"model" = "gpt-6-astra"\n"model_reasoning_effort" = "medium"\n"service_tier" = "default"\n["projects"."/old"]\ntrust_level = "trusted"\n' : name === "hooks.json" ? "{}\n" : "fixture\n");
    }
    await file(join(h, "AGENTS.md"));
    await symlink("AGENTS.md", join(h, "linked-guidance"));
    await file(join(h, "new-guidance/committed.md"), "automatically cloned guidance\n");
    await file(join(h, ".codex/hooks/bin/session_start_context"), "#!/bin/sh\n", 0o755);
    for (const role of ["review-correctness", "review-simplify", "web-reviewer"]) {
      await file(join(h, ".codex/agents", `${role}.toml`), `name = "${role}"\ndeveloper_instructions = "original"\n`);
    }
    await file(join(h, ".codex/agents/worker.toml"));
    await file(join(h, ".codex/.tmp/bundled-marketplaces/openai-bundled/.materialization-key"));
    await file(join(h, ".agents/skills/example/SKILL.md"));
    await file(join(h, ".skills-mgr/skills/example/SKILL.md"));
    await file(join(h, ".skills-mgr/.skills-mgr.json"), JSON.stringify({ schema_revision: 3, skills: { "use-modern-go": { enabled: "lang go", remote: { name: "use-modern-go" } } } }));
    await file(join(h, ".cache/skills-mgr/remote-skills/entries/modern.json"), JSON.stringify({ name: "use-modern-go", content: "content/current-modern" }));
    await file(join(h, ".cache/skills-mgr/remote-skills/content/current-modern/scripts/VERSION"), "v0.1.1\n");
    await file(join(h, ".cache/skills-mgr/remote-skills/content/current-modern/SKILL.md"), "full remote body\n");
    await file(join(h, ".local/share/mise/migrations/runtime-symlink-dirs-v2"), "ok\n");
    await file(join(h, ".config/mise/config.toml"), '[tools]\n"fixture-runner" = "1"\n');
    await file(join(h, ".config/mise/mise.lock"), "# fixture lock\n");
    await file(join(h, ".cache/go-modern-guidelines/v0.1.1/go-modern-guidelines"), "#!/bin/sh\necho guideline\n", 0o755);
    await file(join(h, ".local/share/mise/installs/go-github-com-yusing-skills-mgr/0.0.0-20260908072306-37a730da5ab5/bin/skills-mgr"), "fixture\n", 0o755);
    await file(join(h, ".local/share/mise/installs/aqua-rtk-ai-rtk/0.48.0/rtk"), "fixture\n", 0o755);
    await file(join(h, ".local/share/mise/installs/fixture-runner/1/bin/project-runner"), "#!/bin/sh\nexit 0\n", 0o755);
    await symlink("./1", join(h, ".local/share/mise/installs/fixture-runner/latest"));
    await symlink("project-runner", join(h, ".local/share/mise/installs/fixture-runner/1/bin/alias"));
    await file(join(h, ".local/bin/mise"), `#!/bin/sh
case "$*" in
  *'ls --current --missing --no-header'*) exit 0 ;;
  *'ls --current --json'*) printf '%s\\n' '{"fixture-runner":[{"version":"1","install_path":"/home/ubuntu/.local/share/mise/installs/fixture-runner/1","installed":true,"active":true}]}' ;;
  'exec -- '*) exit 2 ;;
esac
`, 0o755);
    await file(join(h, ".local/share/mise/installs/bun/1.4.2/bin/bun"), "#!/bin/sh\nprintf '1.4.2\\n'\n", 0o755);
    const codex = join(h, ".local/bin/codex");
    await file(join(h, "go/bin/mekugi-exec"), "#!/bin/sh\nexit 0\n", 0o755);
    await file(join(h, "go/bin/mekugi"), "#!/bin/sh\nexec \"$@\"\n", 0o755);
    await file(codex, "#!/bin/sh\necho codex-cli 0.154.0\n", 0o755);
    codexHash = (await checked(["sha256sum", codex])).stdout.split(/\s+/)[0]!;
    const codeModeHost = join(h, ".local/bin/codex-code-mode-host");
    await file(codeModeHost, "#!/bin/sh\nexit 0\n", 0o755);
    codeModeHostHash = (await checked(["sha256sum", codeModeHost])).stdout.split(/\s+/)[0]!;
    await file(join(h, ".codex/auth.json"), "must-not-copy\n", 0o600);
    await file(join(h, ".codex/history.jsonl"), "must-not-copy\n");
    await file(join(h, ".codex/mekugi.config.toml"), "must-not-copy\n");
    await file(join(h, ".gitignore"), ".codex/auth.json\n.codex/history.jsonl\n.codex/mekugi.config.toml\n.cache/\n.local/\n.agents/\n.codex/.tmp/\n.codex/hooks/bin/\n");
    await checked(["git", "init", h]);
    await checked(["git", "-C", h, "config", "user.email", "fixture@example.invalid"]);
    await checked(["git", "-C", h, "config", "user.name", "Fixture"]);
    await checked(["git", "-C", h, "add", "."]);
    await checked(["git", "-C", h, "commit", "-m", "configuration"]);
    return h;
  }

  root = await mkdtemp(join(tmpdir(), "codex-ab-test-"));
  brewPrefix = join(root, "linuxbrew");
  await file(join(brewPrefix, "bin/brew"), `#!/bin/sh\nprintf '%s\\n' '${brewPrefix}'\n`, 0o755);
  process.env.PATH = `${brewPrefix}/bin:${originalPath}`;
  source = join(root, "source");
  await mkdir(join(source, "internal/router"), { recursive: true });
  await checked(["git", "init", source]);
  await checked(["git", "-C", source, "config", "user.email", "fixture@example.invalid"]);
  await checked(["git", "-C", source, "config", "user.name", "Fixture"]);
  await file(join(source, "go.mod"), "module fixture\n\ngo 1.26\n");
  await file(join(source, "internal/router/router.go"), "package router\n");
  await checked(["git", "-C", source, "add", "."]);
  await checked(["git", "-C", source, "commit", "-m", "base"]);
  base = (await checked(["git", "-C", source, "rev-parse", "HEAD"])).stdout.trim();
  await file(join(source, "future.txt"), "oracle that arms must not see\n");
  await checked(["git", "-C", source, "add", "."]);
  await checked(["git", "-C", source, "commit", "-m", "future"]);
  future = (await checked(["git", "-C", source, "rev-parse", "HEAD"])).stdout.trim();
  task = join(root, "task.md"); fixtureCriteria = join(root, "fixture-criteria.json");
  mekugiSource = join(root, "mekugi-source");
  await mkdir(mekugiSource, { recursive: true });

  await file(task, "Make the fixture better.\n");
  await file(fixtureCriteria, JSON.stringify({ schema: "codex-ab.criteria.v1", task_sha256: await sha256(task),
    criteria: [{ id: "fixture", description: "Make the fixture better." }],
    preparation: "true", existing_tests: "true", existing_test_verification: fixtureVerification, evaluator_controls: fixtureControls, qualification: "not-run" }));
  home = await fixtureHome();

  // Each file retains its prepared runs until teardown; allow time to unlink them.
  afterAll(async function removeRunnerFixtures() {
    process.env.PATH = originalPath;
    await rm(root, { recursive: true, force: true });
  }, 30_000);
  beforeEach(() => { process.env.PATH = `${brewPrefix}/bin:${originalPath}`; });

  async function prepare(options: Parameters<typeof prepareInputs>[0]): Promise<string> {
    const run = await prepareInputs(options);
    const state = await readState(run);
    state.pricing = fixturePricing();
    await writeState(run, state);
    return run;
  }

  async function prepared(timeoutSeconds = 30, currentLauncher: "codex" | "mekugi" = "codex", currentHome = home): Promise<string> {
    return prepare({ source, baseCommit: base, forbiddenCommit: future, taskPath: task, criteriaPath: fixtureCriteria,
      outputParent: root, currentHome, image: "fixture-image", cpus: "2", memory: "4g", timeoutSeconds,
      codexBinary: join(currentHome, ".local/bin/codex"), currentLauncher,
      mekugiBinary: currentLauncher === "mekugi" ? join(currentHome, "go/bin/mekugi") : undefined });
  }


  function mekugiComparisonOptions() {
    return { source, baseCommit: base, forbiddenCommit: future, taskPath: task,
      criteriaPath: fixtureCriteria, outputParent: root, currentHome: home, image: "fixture-image",
      cpus: "2", memory: "4g", timeoutSeconds: 30, comparison: "stock-mekugi" as const,
      autoCompactLimit: 4096, mekugiSource: mekugiSource };
  }


  async function brokenFirstCandidate2Check(fakePath: string, name: string): Promise<string> {
    const docker = join(root, name);
    await file(docker, `#!/bin/sh
last=; for argument in "$@"; do last="$argument"; done
'${fakePath}' "$@" || exit
case "$1:$last" in start:*-semantic-?-round-1-candidate-2-fixture)
  output=$(cat '${fakePath}.state/'$last.verifier-results)
  python3 - "$output/result.json" <<'PYFIX'
import json,pathlib,sys
p=pathlib.Path(sys.argv[1]); r=json.loads(p.read_text()); r.update(status='evaluator_wiring',completed=0,cases=[],detail='Wrong fixture adapter'); p.write_text(json.dumps(r))
PYFIX
  exit 0 ;;
esac
`, 0o755);
    return docker;
  }


  async function fakeOwnedDocker(sleepSeconds: number, failWarm = false, missingHost = false, candidatePatch = "", wrongProtectedBinary = false, networkFailure = false,
    invalidAssessment?: { pass: 1 | 2; omit: "criteria" | "quality_aspects" }, failHarnessPass?: 1 | 2, candidateCount = 2): Promise<{ path: string; log: string; stateDir: string }> {
    const path = join(root, `fake-owned-docker-${crypto.randomUUID()}.sh`);
    const log = `${path}.log`;
    const stateDir = `${path}.state`;
    await file(`${path}.patch`, candidatePatch);
    await file(`${path}.collector.txt`, candidateCollector);
    await file(`${path}.capture.ts`, `
const [capture, repository, seed] = process.argv.slice(2);
const patch = ${JSON.stringify(`${path}.patch`)};
if (await Bun.file(patch).size) {
  const applied = Bun.spawn(["git", "-C", repository, "apply", "--binary", patch], {stdout:"inherit",stderr:"inherit"});
  if (await applied.exited) process.exit(1);
}
const spec = {mode:"capture",baseline:false,clean:false,base:${JSON.stringify(base)},tree:${JSON.stringify((await checked(["git", "-C", source, "rev-parse", `${base}^{tree}`])).stdout.trim())},forbidden:"f".repeat(40),icons:false,submodules:[],workspace:repository,seed,destination:capture};
const child = Bun.spawn([process.execPath,"-e",await Bun.file(${JSON.stringify(`${path}.collector.txt`)}).text(),JSON.stringify(spec)],{stdout:"inherit",stderr:"inherit"});
process.exit(await child.exited);
`);
    const candidates = Array.from({ length: candidateCount }, (_, index) => `candidate-${index + 1}`);
    const judgeAssessment = (omit?: "criteria" | "quality_aspects") => JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({
      scores: Object.fromEntries(candidates.map(id => [id, { correctness: 5, simplicity: 5, completeness: 5, performance: 5, maintainability: 5, approach: 5, test_quality: 5 }])),
      ...(omit === "quality_aspects" ? {} : { quality_aspects: Object.fromEntries(candidates.map(id => [id, Object.fromEntries(["simplicity", "performance", "approach"].map(key => [key,
        { status: "satisfactory", basis: "source", reasoning: `${id.replace("candidate", "Candidate")} / ${id.replace("-", " ")} / ${id.replace("-", "_")} uses a focused implementation for ${key}.` }]))])) }),
      evidence: ["fixture semantic assessment"], issues: [], winner: "tie", rationale: "Both fixtures meet the criterion.",
      ...(omit === "criteria" ? {} : { criteria: Object.fromEntries(candidates.map(id => [id, [{ criterion: "fixture", status: "pass", basis: "executed", reasoning: "Executed fixture assertion." }]])) }),
    }) } });
    const validAssessment = judgeAssessment();
    const invalidResponse = judgeAssessment(invalidAssessment?.omit);
    const harnessPlan = JSON.stringify(Object.fromEntries(candidates.map(id => [id,
      [{ criterion: "fixture", files: [{ path: "extra.cjs", source: "if (1 !== 1) process.exit(1)" }], command: ["node", "extra.cjs"], rationale: "Fixture behavior checked.", verification: fixtureVerification, repair: fixtureRepair }]])));
    await file(path, `#!/bin/sh
set -u
mkdir -p '${stateDir}'
printf '%s %s\\n' "$(date +%s%N)" "$*" >> '${log}'
operation="$1"; shift
case "$operation" in
  network)
    action="$1"; shift
    case "$action" in
      create)
        name=; owner=; previous=
        for argument in "$@"; do
          [ "$previous" = --label ] && owner="\${argument#codex-ab.owner=}"
          name="$argument"; previous="$argument"
        done
        printf '%s' "$owner" >'${stateDir}/network-'$name
        echo "network-$name"
        ;;
      inspect)
        name=; for argument in "$@"; do name="$argument"; done
        if [ ! -f '${stateDir}/network-'$name ]; then echo "Error: No such network: $name" >&2; exit 1; fi
        cat '${stateDir}/network-'$name
        ;;
      rm)
        name="$1"
        rm -f '${stateDir}/network-'$name
        echo "$name"
        ;;
    esac
    ;;
  create)
    name=; setup=; previous=
    for argument in "$@"; do
      if [ "$previous" = --name ]; then name="$argument"; fi
      case "$argument" in
        *:/capture) printf '%s' "\${argument%:/capture}" >'${stateDir}/'$name.capture ;;
        *:/workspace:ro) printf '%s' "\${argument%:/workspace:ro}" >'${stateDir}/'$name.repository ;;
        *:/seed.git:ro) printf '%s' "\${argument%:/seed.git:ro}" >'${stateDir}/'$name.seed ;;
        *:/home/ubuntu) setup="\${argument%:/home/ubuntu}" ;;
        *:/runtime-state/codex) setup="\${argument%:/runtime-state/codex}"; setup="\${setup%/.codex}" ;;
        *:/harness) printf '%s' "\${argument%:/harness}" >'${stateDir}/'$name.harness ;;
        *:/harness.json:ro) printf '%s' "\${argument%:/harness.json:ro}" >'${stateDir}/'$name.semantic-harness ;;
        *:/verifier-results:rw) printf '%s' "\${argument%:/verifier-results:rw}" >'${stateDir}/'$name.verifier-results ;;
        *:/candidate:ro) printf '%s' "\${argument%:/candidate:ro}" >'${stateDir}/'$name.semantic-candidate ;;
      esac
      previous="$argument"
    done
    test -n "$name" || exit 2
    case "$name" in
      *-judge-*|*-stock|*-current|*-arm-[0-9]*)
        mkdir -p "$setup/.codex/cache/remote_plugin_catalog" "$setup/.codex/plugins/cache"
        printf '%s\\n' '{}' > "$setup/.codex/cache/remote_plugin_catalog/download.json"
        printf '%s\\n' 'plugin source' > "$setup/.codex/plugins/cache/tool.js"
        ;;
    esac
    case "$name" in
      *-judge-*) cp "$setup/.codex/config.toml" '${stateDir}/'$name.config.toml ;;
      *-preflight-setup|*-preflight-grok|*-preflight-mekugi*|*-preflight-environment-*)
        test -w "$setup/.local/bin" || exit 2
        printf 'PREFLIGHT_HOME %s\\n' "$setup" >> '${log}'
        if test -f "$setup/.local/bin/check_project"; then
          test "$(cat "$setup/.local/bin/check_project")" = "$(printf '#!/bin/sh\\necho setup-utility\\n')" || exit 2
          printf '# private preflight write\\n' >> "$setup/.local/bin/check_project"
        fi
        ;;
    esac
    printf '%s\\n' "$*" >'${stateDir}/'$name
    echo "$name"
    ;;
  start)
    name=; for argument in "$@"; do name="$argument"; done
    test -f '${stateDir}/'$name || exit 3
    status=0
    case "$name" in
      *-isolation-codex) printf '%s\\n' 'codex-cli 0.154.0' ;;
      *-isolation-probe) printf '%s\\n' CODEX_AB_PROTECTED_RUNTIME_OK ;;
      *-preflight-image) printf '%s\\n' '${JSON.stringify([
        { exitCode: 0, stdout: "codex_path=/usr/local/bin/codex\ncodex-cli 0.154.0\n", stderr: "" },
        { exitCode: 0, stdout: "1000:1000\n", stderr: "" },
        { exitCode: missingHost ? 1 : 0, stdout: `${codexHash}  /usr/local/bin/codex\n${missingHost ? "" : `${codeModeHostHash}  /usr/local/bin/codex-code-mode-host\n${wrongProtectedBinary ? "bad" : codexHash}  /usr/local/libexec/codex-real\n`}`, stderr: "" },
        { exitCode: 0, stdout: "CODEX_AB_TOOL_HOST_OK\n", stderr: "" },
      ])}' ;;
      *-preflight-network-*) ${networkFailure ? "echo 'curl: (7) Network unreachable' >&2; status=7" : "printf '%s' '403'"} ;;
      *-preflight-environment-*) : ;;
      *-preflight-grok) printf '%s\\n' 'grok 1.0.30' ;;
      *-warm) ${failWarm ? "echo prewarm-failed >&2; status=9" : ":"} ;;
      *-capture)
        capture=$(cat '${stateDir}/'$name.capture)
        bun '${path}.capture.ts' "$capture" "$(cat '${stateDir}/'$name.repository)" "$(cat '${stateDir}/'$name.seed)" || status=1
        rm -f '${stateDir}/'$name.capture
        ;;
      *-reader-probe-*) printf '%s\\n' '${JUDGE_DISABLED_FEATURES.map(key => `${key} stable false`).join("\n")}' ;;
      *-judge-*-harness-*)
        cat >'${stateDir}/'$name.prompt
        sleep 0.1
        harness=$(cat '${stateDir}/'$name.harness)
        printf '%s\\n' '${harnessPlan}' > "$harness/checks.json"
        mkfifo "$harness/draft.pipe"
        printf '%s\\n' '${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ plan_file: "checks.json" }) } })}'
        ${failHarnessPass ? `case "$name" in *-judge-${failHarnessPass}-harness-*) status=9 ;; esac` : ":"}
        ;;
      *-semantic-*|*-qualification-*)
        python3 - "$(cat '${stateDir}/'$name.semantic-harness)" "$(cat '${stateDir}/'$name.verifier-results)" "$(cat '${stateDir}/'$name.semantic-candidate)" <<'PY'
import json,pathlib,sys
h=json.load(open(sys.argv[1])); cases=h.get('verification',{}).get('cases',[])
failed=any(('/qualification/'+role+'/candidate') in sys.argv[3] for role in ['baseline','negative'])
record=dict(schema='codex-ab.verifier-result.v1',check_sha256=h['check_sha256'],status=('assertion_failure' if failed else 'passed') if cases else 'incomplete',
  expected=len(cases),completed=len(cases),detail='Model-free fake supervisor fixture',
  cases=[dict(id=item['id'],status='fail' if failed else 'pass',exit_code=1 if failed else 0,stdout='',stderr='') for item in cases])
(pathlib.Path(sys.argv[2])/'result.json').write_text(json.dumps(record))
PY
        ;;
      *-judge-*-assessment-*)
        cat >'${stateDir}/'$name.prompt
        ${invalidAssessment ? `case "$name" in
            *-judge-${invalidAssessment.pass}-assessment-*) printf '%s\\n' '${invalidResponse}' ;;
            *) sleep 0.2; printf '%s\\n' '${validAssessment}' ;;
          esac` : `printf '%s\\n' '${validAssessment}'`}
        ;;
      *-judge-1|*-judge-2)
        cat >/dev/null
        printf '%s\\n' '${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ scores: { "candidate-1": { correctness: 5, completeness: 5, maintainability: 5, test_quality: 5 }, "candidate-2": { correctness: 5, completeness: 5, maintainability: 5, test_quality: 5 } }, evidence: ["fixture source assessment"], issues: [], winner: "tie", rationale: "Both fixtures satisfy the task." }) } })}'
        ;;
      *-stock|*-current|*-arm-[0-9]*)
        trap 'exit 143' TERM INT
        sleep ${sleepSeconds}
        printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}'
        ;;
    esac
    printf '%s FINISH %s\\n' "$(date +%s%N)" "$name" >> '${log}'
    case "$(cat '${stateDir}/'$name)" in *--rm*) rm -f '${stateDir}/'$name ;; esac
    exit "$status"
    ;;
  stop) echo stopped ;;
  commit) printf 'sha256:%s\\n' "$(printf '%s' "$1" | sha256sum | cut -d ' ' -f 1)" ;;
  container)
    test "$1" = inspect || exit 4
    target=; for argument in "$@"; do target="$argument"; done
    if [ ! -f '${stateDir}/'$target ]; then echo "Error: No such object: $target" >&2; exit 1; fi
    case " $* " in
      *'codex-ab.owner'*) sed -n 's/.*codex-ab.owner=\\([^ ]*\\).*/\\1/p' '${stateDir}/'$target ;;
      *) echo "$target" ;;
    esac
    ;;
  rm)
    name=; for argument in "$@"; do name="$argument"; done
    rm -f '${stateDir}/'$name
    ;;
  image)
    echo 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    ;;
esac
`, 0o755);
    return { path, log, stateDir };
  }


  async function retainedBytes(directory: string): Promise<Record<string, string>> {
    const entries: Record<string, string> = {};
    const visit = async (path: string) => {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const file = join(path, entry.name);
        if (entry.isDirectory()) await visit(file);
        else entries[relative(directory, file)] = entry.isSymbolicLink() ? `link:${await readlink(file)}` : entry.isFile() ? await sha256(file) : "special-file";
      }
    };
    await visit(directory);
    return entries;
  }


  return { root, source, home, task, fixtureCriteria, mekugiSource, base, future, codexHash, codeModeHostHash, originalPath, brewPrefix, fixtureVerification, fixtureRepair, fixtureControls, file, prepare, prepared, mekugiComparisonOptions, brokenFirstCandidate2Check, fakeOwnedDocker, retainedBytes };
}
