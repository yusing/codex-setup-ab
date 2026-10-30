#!/usr/bin/env python3
"""Freeze Mekugi source inputs, including uncommitted files."""
from pathlib import Path
import os
import sys
import tarfile
import tempfile

source, archive = map(Path, sys.argv[1:])
# The comparison runner owns exclusions; Mekugi no longer has a benchmark Docker context.
exclusions = ['.git', 'benchmarks/repos', 'benchmarks/results', 'bin', '.worktrees', '.claude/worktrees', '.backpass']
regular_files = set()


def include(info):
    name = info.name.removeprefix('./')
    if any(part in ('.git', 'node_modules') for part in Path(name).parts) or any(name == item or name.startswith(item + '/') for item in exclusions):
        return None
    if info.isdir() and name != '.':
        git_file = source / name / '.git'
        if git_file.is_file():
            with git_file.open('rb') as git:
                marker = os.fsdecode(git.read()).strip()
            if marker.startswith('gitdir: '):
                git_dir = (git_file.parent / marker.removeprefix('gitdir: ')).resolve()
                backlink = git_dir / 'gitdir'
                # Submodules also use gitdir files. Linked worktrees additionally
                # share a common Git directory and point back to this checkout.
                if (git_dir / 'commondir').is_file() and backlink.is_file():
                    if (git_dir / os.fsdecode(backlink.read_bytes()).strip()).resolve() == git_file.resolve():
                        return None
    if not (info.isfile() or info.isdir() or info.issym()):
        raise ValueError(f'unsupported build input: {name}')
    # Reproduce only the extraction symlink graph. Regular source payloads and
    # unrelated directories never need to be materialized to run the data filter.
    checked = tarfile.data_filter(info, validation)
    if checked.isfile():
        regular_files.add(Path(validation) / checked.name)
    if checked.issym():
        link = Path(validation) / checked.name
        # realpath must also reject targets that traverse an earlier regular
        # member. Supply only those file-type markers, never their payloads.
        for parent in Path(os.path.realpath(link.parent / checked.linkname)).parents:
            if parent in regular_files:
                parent.parent.mkdir(parents=True, exist_ok=True)
                parent.touch()
                tarfile.data_filter(info, validation)
        link.parent.mkdir(parents=True, exist_ok=True)
        link.symlink_to(checked.linkname)
    return info


with tempfile.TemporaryDirectory(prefix='codex-ab-build-links-') as validation:
    with tarfile.open(archive, 'w', dereference=False) as output:
        output.add(source, arcname='.', filter=include)
