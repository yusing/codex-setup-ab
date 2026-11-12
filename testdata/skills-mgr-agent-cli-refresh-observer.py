import json, os, pathlib, subprocess, sys, tempfile
with tempfile.TemporaryDirectory(prefix="agent-refresh-") as root:
    path = pathlib.Path(root) / "result.json"
    subprocess.run(["go", "test", ".", "-run", "^TestFrozenAgentRefreshObservation$", "-count=1"], env=dict(os.environ, FROZEN_REFRESH_RESULT=str(path)), check=True, stdout=sys.stderr)
    print(json.dumps(json.loads(path.read_text()), sort_keys=True))
