"""Run with Hermes's Python and an isolated HERMES_HOME; never touches live state."""
import json
import os
from pathlib import Path
import sys
import tempfile
import shutil

source = os.environ.get("HERMES_SOURCE")
if source:
    sys.path.insert(0, source)
root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "tests"))
from test_backend import SessionReader
from hermes_state import SessionDB
from hermes_cli.plugin_validate import validate_plugin_dir
from hermes_cli.plugin_dev import doctor_plugin

if not os.environ.get("HERMES_HOME"):
    raise SystemExit("Set HERMES_HOME to a temporary test directory first.")

with tempfile.TemporaryDirectory(prefix="chat-git-session-") as directory:
    home = Path(directory)
    db = SessionDB(home / "state.db")
    try:
        db.create_session("root", "cli", cwd=str(home))
        db.append_message("root", "user", "commit deadbeef")
        db.append_message("root", "tool", "commit aabbccdd", tool_name="terminal")
        db.create_session("other", "cli")
        db.append_message("other", "assistant", "commit 12345678")
        db.end_session("root", "compression")
        db.create_session("child", "cli", parent_session_id="root", cwd=str(home))
        db.append_message("child", "assistant", "commit abcdef12")
        reader = SessionReader(home)
        assert reader.info("child")["id"] == "root"
        rows = list(reader.messages("child"))
        text = " ".join(str(row.get("content")) for row in rows)
        assert "deadbeef" in text and "aabbccdd" in text and "abcdef12" in text and "12345678" not in text, text
        db.create_session("branch", "cli", parent_session_id="root", model_config={"_branched_from": "root"})
        db.append_message("branch", "assistant", "commit facefeed")
        assert reader.info("branch")["id"] == "branch"
        assert len(list(reader.messages("branch"))) == 1
        db.create_session("in-place", "cli")
        db.append_message("in-place", "user", "commit 1111aaaa")
        db.append_message("in-place", "tool", "terminal-only commit 2222bbbb", tool_name="terminal")
        db.archive_and_compact("in-place", [{"role": "assistant", "content": "Earlier work summarized."}])
        compacted = list(reader.messages("in-place"))
        assert any("2222bbbb" in str(row.get("content")) for row in compacted)
        db.append_message("in-place", "user", "remove this commit 3333cccc")
        db.append_message("in-place", "assistant", "and commit 4444dddd")
        target = next(row["id"] for row in db.get_messages("in-place") if "3333cccc" in str(row.get("content")))
        db.rewind_to_message("in-place", target)
        rewound = " ".join(str(row.get("content")) for row in reader.messages("in-place"))
        assert "2222bbbb" in rewound and "3333cccc" not in rewound and "4444dddd" not in rewound
        db.create_session("delegated", "cli", parent_session_id="branch")
        db.append_message("delegated", "assistant", "commit 5555eeee")
        assert reader.info("delegated")["id"] == "delegated"
        assert "5555eeee" not in str(list(reader.messages("branch")))
        print("REAL_SESSION_READS: passed (tool bodies, compression lineage, in-place compaction, rewinds, branch/delegate isolation)")
    finally:
        db.close()

with tempfile.TemporaryDirectory(prefix="chat-git-package-") as directory:
    package = Path(directory) / "hermes-chat-git-hash-differ"
    package.mkdir()
    for source_file in [*root.glob("*.py"), root / "plugin.yaml", root / "LICENSE"]:
        shutil.copy2(source_file, package)
    shutil.copytree(root / "desktop", package / "desktop")
    report = validate_plugin_dir(package)
    print("VALIDATE:", json.dumps(report.to_dict()))
    doctor = doctor_plugin(str(package))
    print("DOCTOR:", doctor.format_text())
    if not report.ok or not doctor.ok:
        raise SystemExit(1)
