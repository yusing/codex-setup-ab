#!/usr/bin/env python3
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest

HELPER = Path(__file__).with_name('build_inputs.py')


class BuildInputsTest(unittest.TestCase):
    def test_frozen_dirty_inputs_and_exclusions(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'source'
            for name in ('.git', 'benchmarks/repos', 'benchmarks/results', 'bin',
                         '.worktrees/task', '.claude/worktrees/task', '.backpass', 'plugins/node_modules'):
                (source / name).mkdir(parents=True, exist_ok=True)
                (source / name / 'private').write_text('not a build input')
            for name in ('.worktrees/task', '.claude/worktrees/task'):
                (source / name / '.git').write_text('gitdir: /unused/worktree/metadata')
            implementation = source / 'implementation.go'
            implementation.write_text('uncommitted implementation')
            embedded = source / 'internal/toolplugin/shared_core.wasm'
            embedded.parent.mkdir(parents=True)
            embedded.write_bytes(b'compiled embedded asset')
            first = root / 'first.tar'
            (source / 'asset-link').symlink_to('internal/toolplugin/shared_core.wasm')
            subprocess.run([sys.executable, HELPER, source, first], check=True)
            implementation.write_text('different uncommitted implementation')
            second = root / 'second.tar'
            subprocess.run([sys.executable, HELPER, source, second], check=True)
            self.assertNotEqual(hashlib.sha256(first.read_bytes()).digest(),
                                hashlib.sha256(second.read_bytes()).digest())
            self.assertFalse((root / 'first').exists())
            with tarfile.open(first) as archive:
                archive.extractall(root / 'consumed', filter='data')
            self.assertEqual((root / 'consumed/implementation.go').read_text(),
                             'uncommitted implementation')
            self.assertEqual((root / 'consumed/asset-link').read_bytes(),
                             embedded.read_bytes())
            with tarfile.open(first) as archive:
                self.assertFalse(any('private' in name for name in archive.getnames()))
                self.assertFalse(any(name.endswith('/.git') for name in archive.getnames()))

    def test_real_submodule_inputs_survive_while_linked_worktrees_are_excluded(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            environment = {**os.environ, 'GIT_CONFIG_NOSYSTEM': '1',
                           'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_COUNT': '0'}

            def git(directory, *arguments):
                subprocess.run(['git', '-C', str(directory), '-c', 'user.name=Fixture',
                                '-c', 'user.email=fixture@example.invalid', *arguments],
                               env=environment, check=True, capture_output=True)

            source = root / 'source'
            assets = root / 'assets'
            for directory in (source, assets):
                directory.mkdir()
                git(directory, 'init')
                (directory / 'input').write_bytes(b'committed asset')
                git(directory, 'add', '.')
                git(directory, 'commit', '-m', 'fixture')
            git(source, '-c', 'protocol.file.allow=always', 'submodule', 'add', str(assets), 'assets')
            (source / 'assets/input').write_bytes(b'dirty embedded asset')
            git(source, 'worktree', 'add', '--detach', str(source / 'other/linked'))
            git(source, 'worktree', 'add', '--detach', str(source / 'other/relative'))
            relative_marker = source / 'other/relative/.git'
            git_dir = Path(relative_marker.read_text().removeprefix('gitdir: ').strip())
            relative_marker.write_text(f'gitdir: {os.path.relpath(git_dir, relative_marker.parent)}\n')
            (git_dir / 'gitdir').write_text(os.path.relpath(relative_marker, git_dir) + '\n')
            archive_path = root / 'source.tar'
            subprocess.run([sys.executable, HELPER, source, archive_path], check=True)
            with tarfile.open(archive_path) as archive:
                names = archive.getnames()
                self.assertEqual(archive.extractfile('./assets/input').read(), b'dirty embedded asset')
                self.assertFalse(any('/other/linked' in name for name in names))
                self.assertFalse(any('/other/relative' in name for name in names))
                self.assertFalse(any('.git' in Path(name).parts for name in names))
                archive.extractall(root / 'consumed', filter='data')
            self.assertEqual((root / 'consumed/assets/input').read_bytes(), b'dirty embedded asset')

    def test_unsafe_inputs_are_rejected_without_extraction(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'source'
            source.mkdir()
            for target in ('../outside', str(root / 'outside')):
                with self.subTest(target=target):
                    link = source / 'link'
                    link.symlink_to(target)
                    result = subprocess.run([sys.executable, HELPER, source, root / 'source.tar'],
                                            capture_output=True)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(b'Error', result.stderr)
                    link.unlink()
            os.mkfifo(source / 'pipe')
            result = subprocess.run([sys.executable, HELPER, source, root / 'source.tar'], capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(b'unsupported build input', result.stderr)

    def test_symlink_graph_matches_extraction_validation(self):
        for links, regular in (({'b': 'a/child'}, 'a'),
                               ({'b': 'a', 'c': 'b/child'}, 'a'),
                               ({'a': 'z/child'}, 'z'),
                               ({'a': 'b', 'b': 'a', 'c': 'a'}, 'z')):
            with self.subTest(links=links), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                source = root / 'source'
                source.mkdir()
                (source / regular).write_text('regular file')
                for name, target in links.items():
                    (source / name).symlink_to(target)
                reference = root / 'reference.tar'
                with tarfile.open(reference, 'w', dereference=False) as archive:
                    archive.add(source, arcname='.')
                rejected = False
                try:
                    with tarfile.open(reference) as archive:
                        archive.extractall(root / 'reference', filter='data')
                except (OSError, tarfile.FilterError):
                    rejected = True
                result = subprocess.run([sys.executable, HELPER, source, root / 'source.tar'], capture_output=True)
                self.assertEqual(result.returncode != 0, rejected, result.stderr.decode())


if __name__ == '__main__':
    unittest.main()
