import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("chat_git", ROOT / "__init__.py", submodule_search_locations=[str(ROOT)])
plugin = importlib.util.module_from_spec(spec)
sys.modules["chat_git"] = plugin
spec.loader.exec_module(plugin)
from chat_git.backend import DifferService
from chat_git.detection import references, scan_messages
from chat_git.git_reader import GitReader, GitError
from chat_git.storage import SessionReader, Store


class Repo:
    def __init__(self, path, sha256=False):
        self.path = Path(path)
        self.path.mkdir()
        self.git("init", "--initial-branch=main", *(["--object-format=sha256"] if sha256 else []))
        self.git("config", "user.name", "Fixture")
        self.git("config", "user.email", "fixture@example.invalid")

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.path), *args], stderr=subprocess.PIPE).decode().strip()

    def commit(self, text="one\n", name="file.txt", subject="Fixture change"):
        (self.path / name).write_text(text, encoding="utf-8")
        self.git("add", "--", name)
        self.git("commit", "-m", subject)
        return self.git("rev-parse", "HEAD")


class Context:
    def __init__(self): self.events = []
    def emit_to_session(self, sid, event, payload): self.events.append((sid, event))


class DetectionTests(unittest.TestCase):
    def test_references_and_boundaries(self):
        text = 'a1b2c3d deadbeef commit: abcd sha `12345` https://github.com/org/repo/commit/cafe 0xabcdef00 prefixabcdef0 #abc123'
        found = references(text)
        self.assertEqual([r["hash"] for r in found], ['a1b2c3d', 'deadbeef', 'abcd', '12345', 'cafe'])
        self.assertEqual(found[-1]["hint"], 'github.com/org/repo')
        self.assertEqual(references('a' * 65), [])

    def test_scans_tool_arguments_and_results_not_reasoning(self):
        rows = [{"role": "assistant", "content": [{"type": "text", "text": "commit deadbeef"}],
                 "tool_calls": json.dumps([{"function": {"arguments": '{"command":"git show aabbccd"}'}}]),
                 "reasoning": "012345678"}, {"role": "tool", "content": "[main abcd] created"},
                {"role": "system", "content": "111111111"}]
        self.assertEqual([r["hash"] for r in scan_messages(rows)], ['deadbeef', 'aabbccd', 'abcd'])
        self.assertEqual([r['hash'] for r in scan_messages([{'role': 'tool', 'content': {'data': 'commit cafebabe'}}])], ['cafebabe'])


class GitTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Repo(Path(self.temp.name) / "repo")
        self.reader = GitReader()
        self.root = self.repo.commit()
        self.r = self.reader.repository(self.repo.path)

    def test_root_parent_and_working_tree_independence(self):
        files = self.reader.files(self.r, self.root)
        self.assertEqual(files["parent"], "")
        self.assertEqual(files["files"][0]["added"], 1)
        second = self.repo.commit("two\n")
        (self.repo.path / 'file.txt').write_text('uncommitted!')
        self.repo.git('config', 'diff.external', 'this-helper-must-never-run')
        self.repo.git('config', 'diff.outputIndicatorNew', '>')
        listing = self.reader.files(self.r, second)
        diff = self.reader.diff(self.r, second, None, listing['files'][0]['id'])
        self.assertEqual([l['text'] for l in diff['hunks'][0]['lines']], ['one', 'two'])
        self.assertEqual(self.reader.resolve(self.r, second[:7]), second)
        self.repo.git('branch', second[:7], self.root)
        self.assertEqual(self.reader.resolve(self.r, second[:7]), second)

    def test_rename_delete_unicode_binary_and_literal_paths(self):
        self.repo.git('mv', 'file.txt', 'renamed \u03bb.txt')
        self.repo.git('commit', '-m', 'Rename')
        renamed = self.reader.files(self.r, self.repo.git('rev-parse', 'HEAD'))['files'][0]
        self.assertEqual((renamed['status'], renamed['old_path'], renamed['path']), ('R', 'file.txt', 'renamed \u03bb.txt'))
        (self.repo.path / 'binary.bin').write_bytes(b'\0\1\2')
        self.repo.git('add', '.')
        self.repo.git('commit', '-m', 'Binary')
        sha = self.repo.git('rev-parse', 'HEAD')
        file = self.reader.files(self.r, sha)['files'][0]
        self.assertEqual(self.reader.diff(self.r, sha, None, file['id'])['kind'], 'binary')
        sha = self.repo.commit('literal\n', '[abc].txt')
        f = self.reader.files(self.r, sha)['files'][0]
        self.assertEqual(self.reader.diff(self.r, sha, None, f['id'])['hunks'][0]['lines'][0]['text'], 'literal')
        self.repo.git('rm', '--', '[abc].txt')
        self.repo.git('commit', '-m', 'Delete')
        self.assertEqual(self.reader.files(self.r, self.repo.git('rev-parse', 'HEAD'))['files'][0]['status'], 'D')

    def test_merge_parents_and_invalid_parent(self):
        self.repo.git('checkout', '-b', 'feature')
        feature = self.repo.commit('feature', 'feature.txt')
        self.repo.git('checkout', 'main')
        main = self.repo.commit('main', 'main.txt')
        self.repo.git('merge', '--no-ff', 'feature', '-m', 'Merge')
        sha = self.repo.git('rev-parse', 'HEAD')
        self.assertEqual(self.reader.metadata(self.r, sha)['parents'], [main, feature])
        self.assertEqual(self.reader.files(self.r, sha)['files'][0]['path'], 'feature.txt')
        self.assertEqual(self.reader.files(self.r, sha, feature)['files'][0]['path'], 'main.txt')
        with self.assertRaises(GitError): self.reader.files(self.r, sha, self.root)

    def test_submodule_pointer_and_limit(self):
        self.repo.git('update-index', '--add', '--cacheinfo', f'160000,{self.root},sub')
        self.repo.git('commit', '-m', 'Submodule')
        sha = self.repo.git('rev-parse', 'HEAD')
        file = self.reader.files(self.r, sha)['files'][0]
        self.assertEqual(self.reader.diff(self.r, sha, None, file['id'])['kind'], 'submodule')
        large = self.repo.commit('x' * 5000, 'large.txt')
        small = GitReader(max_bytes=1024)
        listing = small.files(self.r, large)
        with self.assertRaises(GitError) as caught: small.diff(self.r, large, None, listing['files'][0]['id'])
        self.assertEqual(caught.exception.code, 'too_large')

    def test_sha256_worktree_and_missing(self):
        other = Repo(Path(self.temp.name) / 'sha256', sha256=True)
        sha = other.commit()
        self.assertEqual(len(sha), 64)
        r = self.reader.repository(other.path)
        self.assertEqual(self.reader.resolve(r, sha[:8]), sha)
        self.assertEqual(len(self.reader.files(r, sha)['files']), 1)
        worktree = Path(self.temp.name) / 'linked'
        self.repo.git('worktree', 'add', '-b', 'linked', str(worktree))
        self.assertEqual(self.reader.repository(worktree)['id'], self.r['id'])
        with self.assertRaises(GitError): self.reader.resolve(self.r, '1234567890')
        with self.assertRaises(GitError): self.reader.resolve(self.r, '--help')

    def test_shallow_parent_and_ambiguous(self):
        sha = self.repo.commit('second')
        shallow = Path(self.temp.name) / 'shallow'
        subprocess.check_output(['git', 'clone', '--depth=1', self.repo.path.as_uri(), str(shallow)], stderr=subprocess.PIPE)
        r = self.reader.repository(shallow)
        # %P is empty in a shallow view; the raw commit must still expose its actual parent.
        with self.assertRaises(GitError) as caught: self.reader.files(r, sha)
        self.assertEqual(caught.exception.code, 'missing_parent')
        class Ambiguous(GitReader):
            def run(self, repo, *args, **kw):
                return b'abcde000\nabcde111\n' if '--disambiguate=abcd' in args else b'commit\n'
        with self.assertRaises(GitError) as caught: Ambiguous().resolve(self.r, 'abcd')
        self.assertEqual(caught.exception.code, 'ambiguous')


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name) / 'home'
        self.repo = Repo(Path(self.temp.name) / 'repo')
        self.first = self.repo.commit()
        self.second = self.repo.commit('second\n')
        self.rows = [{"role": "assistant", "content": f"{self.first[:7]} then {self.second}"}, {"role": "tool", "content": self.first}]
        test = self
        class Reader:
            def __init__(self, home): pass
            def info(self, sid): return {"id": sid, "tip": sid, "title": 'Test chat', "cwd": str(test.repo.path)}
            def messages(self, sid): return test.rows if sid == 'chat' else []
        self.service = DifferService(Context(), self.home, Reader)
        self.addCleanup(self.service.close)

    def snapshot(self, sid='chat', force=False):
        method = self.service.session_refresh if force else self.service.session_get
        value = method({}, session_id=sid)
        deadline = time.monotonic() + 10
        while value['scanning'] and time.monotonic() < deadline:
            time.sleep(.03)
            value = self.service.session_get({}, session_id=sid)
        self.assertFalse(value['scanning'], 'scan did not finish')
        return value

    def test_dedupe_review_settings_and_transcript_replacement(self):
        snap = self.snapshot()
        self.assertEqual(len(snap['commits']), 2)
        first = next(c for c in snap['commits'] if c['sha'] == self.first)
        self.assertEqual(first['occurrences'], 2)
        commit = snap['commits'][0]
        params = {"commit_id": commit['id']}
        listing = self.service.commit_files(params, session_id='chat')
        params.update(file_id=listing['files'][0]['id'], reviewed=True)
        self.service.review_set(params, session_id='chat')
        self.assertTrue(self.service.commit_files(params, session_id='chat')['files'][0]['reviewed'])
        self.assertEqual(self.service.settings_get()['auto_open'], True)
        self.service.settings_set({'auto_open': False})
        self.assertEqual(self.service.settings_get()['auto_open'], False)
        self.assertEqual(Store(self.home / 'plugin-data' / 'hermes-chat-git-hash-differ').get('settings', 'auto_open'), False)
        self.rows[:] = [{"role": "user", "content": self.second}]
        self.assertEqual([c['sha'] for c in self.snapshot(force=True)['commits']], [self.second])
        self.assertEqual(self.snapshot('other')['commits'], [])
        with self.assertRaises(ValueError): self.service.commit_files(params, session_id='other')

    def test_repository_ambiguity_and_explicit_choice(self):
        copy_path = Path(self.temp.name) / 'clone'
        subprocess.check_output(['git', 'clone', str(self.repo.path), str(copy_path)], stderr=subprocess.PIPE)
        self.service.repositories_add({'path': str(copy_path)}, session_id='chat')
        snap = self.snapshot(force=True)
        self.assertEqual(snap['commits'], [])
        self.assertTrue(all(ref['reason'] == 'ambiguous' for ref in snap['unresolved']))
        self.service.repositories_add({'path': str(self.repo.path), 'hash': self.second}, session_id='chat')
        self.assertTrue(any(c['sha'] == self.second for c in self.snapshot(force=True)['commits']))

    def test_review_parent_scope_and_profile_storage(self):
        store = self.service.store(self.home)
        store.review('chat', 'repo', 'sha', 'p1', 'file', True)
        self.assertEqual(store.reviews('chat', 'repo', 'sha', 'p2'), set())
        self.assertEqual(Store(Path(self.temp.name) / 'other-profile').reviews('chat', 'repo', 'sha', 'p1'), set())

    def test_slow_scan_returns_immediately(self):
        start = time.monotonic()
        self.service.session_get({}, session_id='chat')
        self.assertLess(time.monotonic() - start, .5)
        self.snapshot()

    def test_unchanged_poll_reuses_resolution_but_retry_revalidates(self):
        self.snapshot()
        calls = []
        resolve = self.service.git.resolve
        def tracked(*args):
            calls.append(args)
            return resolve(*args)
        self.service.git.resolve = tracked
        self.service.changed(session_id='chat')
        self.snapshot()
        self.assertEqual(calls, [])
        self.snapshot(force=True)
        self.assertGreater(len(calls), 0)


if __name__ == '__main__': unittest.main()
