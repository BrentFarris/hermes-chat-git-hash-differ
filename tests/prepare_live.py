"""Create an isolated, offline review fixture. Requires an explicit empty home."""
import argparse
import json
import os
from pathlib import Path
import shutil
import sys

parser = argparse.ArgumentParser()
parser.add_argument('home', type=Path)
args = parser.parse_args()
home = args.home.resolve()
if (home / 'state.db').exists():
    raise SystemExit('Refusing to overwrite an existing session database.')
home.mkdir(parents=True, exist_ok=True)
os.environ['HERMES_HOME'] = str(home)
root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / 'tests'))
from test_backend import Repo
from hermes_state import SessionDB

repo = Repo(home / 'fixture-repository')
commits = []
for i in range(20):
    commits.append(repo.commit(f'export const version = {i};\n// Fixture change {i}\n', 'version.ts', f'Refine release step {i + 1:02}'))
db = SessionDB(home / 'state.db')
db.create_session('chat-git-review-fixture', 'cli', cwd=str(repo.path), model='fixture-model')
db.set_session_title('chat-git-review-fixture', 'Review twenty commits')
db.append_message('chat-git-review-fixture', 'user', 'Please review the commits from this coding session.')
for i, sha in enumerate(commits):
    db.append_message('chat-git-review-fixture', 'assistant', f'Completed release step {i + 1}: commit `{sha}`.')
db.close()

config = {
    '_config_version': 12,
    'model': {'default': 'fixture-model', 'provider': 'custom', 'base_url': 'http://127.0.0.1:9/v1'},
    'terminal': {'env': 'local', 'cwd': str(repo.path)},
    'plugins': {'enabled': ['hermes-chat-git-hash-differ']},
    'webapp': {'enabled': True, 'host': '127.0.0.1', 'port': 19120},
    'gateway': {'host': '127.0.0.1', 'port': 19119},
}
# JSON is valid YAML, and avoids adding a YAML dependency to the fixture generator.
(home / 'config.yaml').write_text(json.dumps(config, indent=2), encoding='utf-8')
plugin_home = home / 'plugins' / 'hermes-chat-git-hash-differ'
shutil.copytree(root, plugin_home, ignore=shutil.ignore_patterns('node_modules', '__pycache__', '.test-build', '.git', 'test-results'))
desktop_home = home / 'desktop-plugins' / 'hermes-chat-git-hash-differ'
desktop_home.mkdir(parents=True)
shutil.copy2(root / 'desktop' / 'plugin.js', desktop_home / 'plugin.js')
(home / 'fixture.json').write_text(json.dumps({'session': 'chat-git-review-fixture', 'commits': commits}), encoding='utf-8')
print(f'Prepared {home} with 20 commits. No model calls are needed.')
