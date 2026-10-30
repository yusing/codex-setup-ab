"""Copy only capture-linked runtime snapshots out of private debug storage."""
import json
from pathlib import Path
import shutil
import sys


def export_family(temporary: Path, state: Path, capture: Path) -> None:
    destination = capture.parent / "metrics.json"
    destination.unlink(missing_ok=True)
    children = capture.with_name(capture.name + ".runtimes")
    captures = [capture]
    if children.exists():
        if children.is_symlink() or not children.is_dir():
            raise ValueError("invalid Mekugi runtime capture directory")
        for runtime in sorted(children.iterdir()):
            child = runtime / "capture.jsonl"
            if runtime.is_symlink() or not runtime.is_dir() or child.is_symlink() or not child.is_file():
                raise ValueError("Mekugi runtime is missing its capture")
            captures.append(child)
    expected = set(captures)
    selected = {}
    candidates = set(temporary.glob("mekugi-debug-*/metrics.json"))
    candidates.update((state / "mekugi/debug").glob("mekugi-debug-*/metrics.json"))
    for metrics in sorted(candidates):
        link = metrics.parent / "capture.jsonl"
        if not link.is_symlink():
            continue
        target = link.resolve()
        if target not in expected:
            if target.parent.parent == children and target.name == "capture.jsonl":
                raise ValueError("Mekugi runtime is missing its capture")
            continue
        if target in selected:
            raise ValueError("Mekugi wrote ambiguous metrics for a runtime")
        if metrics.is_symlink() or not metrics.is_file():
            raise ValueError("Mekugi metrics are not a regular file")
        selected[target] = metrics
    if capture not in selected:
        raise ValueError("Mekugi did not write metrics for its root capture")
    if set(selected) != expected:
        raise ValueError("Mekugi runtime is missing its metrics")
    if len(captures) == 1:
        shutil.copyfile(selected[capture], destination)
        return
    family = {"schema": "mekugi.capture.family.v1", "runtimes": [
        {"capture": str(path.relative_to(capture.parent)),
         "metrics": json.loads(selected[path].read_text())} for path in captures
    ]}
    destination.write_text(json.dumps(family, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    try:
        export_family(*(Path(value) for value in sys.argv[1:]))
    except (OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
