#!/usr/bin/env python3
"""Freeze Mekugi source inputs, including uncommitted files."""
from pathlib import Path
import sys
import tarfile

source, archive, destination = map(Path, sys.argv[1:])
# The comparison runner owns exclusions; Mekugi no longer has a benchmark Docker context.
exclusions = ['.git', 'benchmarks/repos', 'benchmarks/results', 'bin', '.claude/worktrees', '.backpass']


def include(info):
    name = info.name.removeprefix('./')
    if 'node_modules' in Path(name).parts or any(name == item or name.startswith(item + '/') for item in exclusions):
        return None
    if not (info.isfile() or info.isdir() or info.issym()):
        raise ValueError(f'unsupported build input: {name}')
    return info


with tarfile.open(archive, 'w', dereference=False) as output:
    output.add(source, arcname='.', filter=include)
with tarfile.open(archive) as frozen:
    frozen.extractall(destination, filter='data')
