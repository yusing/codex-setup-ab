"""Evaluator-only public CLI observer. Expectations live outside this process."""
import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET


def manifest(name="alpha", description="Alpha.", body="First.\nSecond.\n", policy=False):
    return f"---\nname: {name}\ndescription: {description}\n" + ("disable-model-invocation: true\n" if policy else "") + "---\n" + body


def write(path, text, mode=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    if mode is not None:
        path.chmod(mode)


with tempfile.TemporaryDirectory(prefix="skills-agent-observe-") as temporary:
    root = Path(temporary)
    binary = str(root / "skills-mgr")
    subprocess.run(["go", "build", "-buildvcs=false", "-o", binary, "."], check=True, stdout=sys.stderr)
    home, project = root / "home", root / "project"
    home.mkdir()
    project.mkdir()
    cache = home / "cache" / "skills-mgr"
    cache.mkdir(parents=True)
    # Hold the documented background-refresh coordination lock, not a fake CLI.
    refresh_lock = (cache / "refresh.lock").open("w")
    fcntl.flock(refresh_lock, fcntl.LOCK_EX)
    env = dict({k: v for k, v in os.environ.items() if not k.startswith("GIT_")}, HOME=str(home), XDG_CACHE_HOME=str(home / "cache"), CODEX_HOME=str(home / ".codex"), GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=str(root / "gitconfig"), GIT_TERMINAL_PROMPT="0")
    for key in ("CLAUDECODE", "GROK_CLI", "CODEX_THREAD_ID"):
        env.pop(key, None)
    manager = home / ".skills-mgr"
    skill = manager / "skills" / "alpha" / "SKILL.md"
    lock = project / ".skills-mgr.json"
    def selection(directory, skills):
        write(directory / ".skills-mgr.json", json.dumps({"schema_revision": 3, "skills": skills}))
    def call(*args, data=None, cwd=project):
        return subprocess.run([binary, *args], cwd=cwd, env=env, input=data, text=True, capture_output=True, timeout=15)
    def body(target="alpha"):
        p = call("get", target)
        return {"exit": p.returncode, "stdout": p.stdout}
    def inspect(name="alpha"):
        p = call("inspect", name)
        return p.returncode, json.loads(p.stdout) if p.stdout else {}
    def read(path):
        return path.read_text() if path.is_file() else None
    def local():
        write(skill, manifest(), 0o640)
        write(skill.parent / "references" / "guide.md", "Guide.\n")
        write(skill.parent / "scripts" / "marker.sh", "#!/bin/sh\nprintf executed > '" + str(root / "executed") + "'\n", 0o755)
        selection(project, {"alpha": {"enabled": True}})
    def remote():
        repository = root / "repository"
        repository.mkdir()
        def git(*args):
            subprocess.run(["git", "-C", str(repository), *args], env=env, check=True, stdout=sys.stderr, stderr=sys.stderr)
        git("init", "-q", "--initial-branch=main")
        git("config", "user.name", "Fixture")
        git("config", "user.email", "fixture@example.invalid")
        write(repository / "skills" / "alpha" / "SKILL.md", manifest(body="Remote body.\n"))
        write(repository / "skills" / "alpha" / "references" / "guide.md", "Guide.\n")
        write(repository / "skills" / "alpha" / "scripts" / "marker.sh", "#!/bin/sh\necho script\n", 0o755)
        git("add", ".")
        git("commit", "-qm", "Fixture")
        git("branch", "feature/skills")
        subprocess.run(["git", "config", "--file", str(root / "gitconfig"), "protocol.file.allow", "always"], check=True)
        subprocess.run(["git", "config", "--file", str(root / "gitconfig"), "url." + repository.as_uri() + ".insteadOf", "https://github.com/owner/repo.git"], check=True)
        p = call("install", "https://github.com/owner/repo.git/tree/feature%2Fskills/skills/alpha/")
        return p, repository
    def remote_state():
        files = sorted((cache / "remote-skills").glob("**/SKILL.md"))
        fetched = files[0] if files else None
        patches = sorted((manager / "skills" / ".remote-patches").glob("**/*"))
        return {"selection": read(lock), "fetched": read(fetched) if fetched else None, "patches": {str(p.relative_to(manager)): read(p) for p in patches if p.is_file()}, "served": body()}

    case = sys.argv[1]
    observed = {}
    if case == "existing":
        local()
        observed["body"] = body()
        observed["range"] = {"exit": (p := call("get", "alpha", "2:2")).returncode, "stdout": p.stdout}
        observed["resource"] = body("alpha/references/guide.md")
        p = call("list")
        tree = ET.fromstring(p.stdout)
        observed["list"] = {"exit": p.returncode, "alpha": "alpha" in p.stdout, "description": "Alpha." in p.stdout, "reference": "guide.md" in (tree.find("skill/references").text or "")}
        selection(project, {"alpha": {"enabled": False}})
        p = call("get", "alpha")
        observed["disabled"] = {"rejected": p.returncode != 0, "stdout": p.stdout}
        observed["script_executed"] = (root / "executed").exists()
    elif case == "repository-install":
        p, repository = remote()
        observed["install_exit"] = p.returncode
        observed["served"] = body()
        if p.returncode == 0:
            state = json.loads(lock.read_text())["skills"]["alpha"]
            observed["remote"] = {k: state["remote"][k] for k in ("provider", "name", "locator")}
            fetched = next((cache / "remote-skills").glob("**/SKILL.md"))
            observed["resources"] = [(fetched.parent / "references/guide.md").read_text(), bool((fetched.parent / "scripts/marker.sh").stat().st_mode & 0o111)]
            before = lock.read_bytes()
            invalid = call("install", "http://github.com/owner/repo")
            observed["invalid"] = {"rejected": invalid.returncode != 0, "selection_preserved": lock.read_bytes() == before}
    elif case == "remote-recovery":
        p, repository = remote()
        observed["install_exit"] = p.returncode
        if p.returncode == 0:
            edit = call("edit", "alpha", "--file", "-", data=manifest(description="Edited.", body="Patched body.\n"))
            before = remote_state()
            fetched = next((cache / "remote-skills").glob("**/SKILL.md"))
            shutil.rmtree(fetched.parent)
            missing_code, missing = inspect()
            observed["missing"] = any(c.get("content_missing") for c in missing.get("candidates", []))
            observed["sync_exit"] = call("sync").returncode
            observed["edit_exit"] = edit.returncode
            observed["served"] = body()
            observed["selection_preserved"] = before["selection"] == read(lock)
            # A failed second recovery must retain selection and prior patch.
            restored = sorted((cache / "remote-skills").glob("**/SKILL.md"))
            observed["failed_recovery"] = None
            if restored:
                shutil.rmtree(restored[0].parent)
                repository.rename(root / "unavailable-repository")
                failed = call("sync")
                after = remote_state()
                observed["failed_recovery"] = {"rejected": failed.returncode != 0, "selection_preserved": before["selection"] == after["selection"], "patch_preserved": before["patches"] == after["patches"]}
    elif case == "diagnostics":
        local()
        code, report = inspect()
        resolved = report.get("resolved") or {}
        observed["enabled"] = {"exit": code, "resolved": resolved.get("source"), "body_health": resolved.get("body_health"), "layer": resolved.get("selection", {}).get("layer"), "alternatives": len(report.get("candidates", [])), "served": body()}
        selection(project, {"alpha": {"enabled": False}})
        code, report = inspect()
        observed["disabled"] = {"exit": code, "resolved": report.get("resolved"), "enabled": [c.get("enabled") for c in report.get("candidates", [])]}
    elif case in ("content-checks", "content-resources"):
        local()
        observed = []
        for policy in (False, True):
            for alias in ("alpha", "alpha/SKILL.md", "alpha/./SKILL.md", "alpha/references/../SKILL.md"):
                write(skill, manifest(body="---\n# Instructions\nUse this.\n", policy=policy))
                write(skill.parent / "references/guide.md", "Guide.\n")
                good = call("check", alias)
                if case == "content-checks":
                    write(skill, manifest(body="", policy=policy))
                    bad = call("check", alias)
                    observed.append({"policy": policy, "alias": alias, "healthy": good.returncode, "empty_rejected": bad.returncode != 0})
                else:
                    write(skill.parent / "references/guide.md", "")
                    bad = call("check", alias, "alpha/missing.md", "alpha/scripts/marker.sh")
                    observed.append({"policy": policy, "alias": alias, "healthy": good.returncode, "empty_rejected": bad.returncode != 0, "reported_reference": "alpha/references/guide.md" in bad.stderr, "continued": "alpha/scripts/marker.sh" in bad.stdout, "reported_missing": "alpha/missing.md" in bad.stderr, "script_executed": (root / "executed").exists()})
    elif case == "layered-selection":
        local()
        # First global write, then project overrides, inheritance, and home routing.
        observed["global"] = call("set", "-g", "alpha", "true").returncode
        observed["conditional"] = call("set", "alpha", 'test -f evidence.txt').returncode
        observed["condition_false"] = call("get", "alpha").returncode != 0
        write(project / "evidence.txt", "exists")
        observed["condition_true"] = body()
        observed["disabled"] = call("set", "alpha", "false").returncode
        observed["inherit"] = call("set", "alpha", "inherit").returncode
        observed["served_inherited"] = body()
        observed["home"] = call("set", "alpha", "false", cwd=home).returncode
        observed["home_global_value"] = json.loads((manager / ".skills-mgr.json").read_text())["skills"]["alpha"]["enabled"] if (manager / ".skills-mgr.json").is_file() else None
        observed["home_project_lock"] = (home / ".skills-mgr.json").exists()
    elif case == "safe-edits":
        local()
        before = skill.read_bytes(), lock.read_bytes()
        stale = call("edit", "alpha", "--file", "-", "--expect-sha256", "0" * 64, data=manifest(body="Changed.\n"))
        empty = call("edit", "alpha", "--file", "-", data=manifest(body=""))
        observed["rejections"] = {"stale": stale.returncode != 0, "empty": empty.returncode != 0, "preserved": before == (skill.read_bytes(), lock.read_bytes())}
        # Ensure original placeholder exists, then obstruct destination deterministically.
        call("set", "alpha", "true")
        before = skill.read_bytes(), lock.read_bytes()
        write(project / ".agents/skills/beta", "obstruction")
        obstructed = call("edit", "alpha", "--file", "-", data=manifest(name="beta", body="Changed.\n"))
        observed["rollback"] = {"rejected": obstructed.returncode != 0, "preserved": before == (skill.read_bytes(), lock.read_bytes()), "obstruction": read(project / ".agents/skills/beta")}
        (project / ".agents/skills/beta").unlink()
        write(root / "replacement.md", manifest(name="beta", description="Renamed.", body="Changed.\n"))
        renamed = call("edit", "alpha", "--file", str(root / "replacement.md"))
        observed["rename"] = {"exit": renamed.returncode, "mode": oct(skill.stat().st_mode & 0o777), "served": body("beta"), "old_placeholder": (project / ".agents/skills/alpha/SKILL.md").exists(), "new_placeholder": (project / ".agents/skills/beta/SKILL.md").exists()}
    elif case in ("remote-edit-rejection", "remote-edit-success"):
        p, repository = remote()
        observed["install_exit"] = p.returncode
        if p.returncode == 0:
            original = remote_state()
            accepted = manifest(description="Accepted.", body="Accepted local body.\n")
            accepted_result = call("edit", "alpha", "--file", "-", data=accepted)
            before = remote_state()
            observed["accepted"] = {"exit": accepted_result.returncode, "served": before["served"], "fetched_preserved": original["fetched"] == before["fetched"], "patch_exists": bool(before["patches"])}
            if case == "remote-edit-rejection":
                observed["rejected"] = []
                for field, replacement, extra in (("name", accepted.replace("name: alpha", "name: renamed"), []), ("policy", accepted.replace("description: Accepted.", "description: Accepted.\ndisable-model-invocation: true"), []), ("empty", manifest(body=""), []), ("stale", accepted, ["--expect-sha256", "0" * 64])):
                    result = call("edit", "alpha", "--file", "-", *extra, data=replacement)
                    observed["rejected"].append({"field": field, "rejected": result.returncode != 0, "state_preserved": before == remote_state()})
            else:
                code, report = inspect()
                owner = report.get("resolved") or {}
                observed["inspection"] = {"exit": code, "source": owner.get("source"), "health": owner.get("body_health"), "patch": bool(owner.get("patch_path")), "policy": owner.get("disable_model_invocation")}
    elif case == "compatibility-tests-docs":
        installed, repository = remote()
        observed["workflow"] = {"install_exit": installed.returncode}
        if installed.returncode == 0:
            workflow = observed["workflow"]
            workflow["edit_exit"] = call("edit", "alpha", "--file", "-", data=manifest(description="Integrated.", body="Integrated patch.\n")).returncode
            workflow["check_exit"] = call("check", "alpha").returncode
            workflow["disable_exit"] = call("set", "alpha", "false").returncode
            workflow["disabled"] = call("get", "alpha").returncode != 0
            workflow["enable_exit"] = call("set", "alpha", "true").returncode
            workflow["sync_exit"] = call("sync").returncode
            workflow["served"] = body()
        local()
        p = call("help")
        observed["help"] = {"exit": p.returncode, "run": "skills-mgr run" in p.stdout, "sync": "skills-mgr sync" in p.stdout}
        observed["served"] = body()
        p = call("run", "alpha/scripts/marker.sh")
        observed["script"] = {"exit": p.returncode, "executed": (root / "executed").exists()}
    else:
        raise ValueError(case)
    print(json.dumps(observed, sort_keys=True))
