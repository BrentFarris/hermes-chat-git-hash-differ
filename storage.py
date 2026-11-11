"""Plugin-owned state. The canonical Hermes transcript is never written."""

from contextlib import contextmanager
from pathlib import Path
import json
import sqlite3


class Store:
    def __init__(self, directory):
        self.path = Path(directory) / "review.sqlite3"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.execute("CREATE TABLE IF NOT EXISTS state (kind TEXT, key TEXT, value TEXT, PRIMARY KEY(kind,key))")
            db.execute("CREATE TABLE IF NOT EXISTS reviewed (session TEXT, repo TEXT, sha TEXT, parent TEXT, file TEXT, PRIMARY KEY(session,repo,sha,parent,file))")
            db.execute("PRAGMA user_version = 1")

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=5)
        try:
            with db:
                yield db
        finally:
            db.close()

    def get(self, kind, key, default=None):
        with self.connect() as db:
            row = db.execute("SELECT value FROM state WHERE kind=? AND key=?", (kind, key)).fetchone()
        return json.loads(row[0]) if row else default

    def set(self, kind, key, value):
        with self.connect() as db:
            db.execute("INSERT INTO state VALUES (?,?,?) ON CONFLICT(kind,key) DO UPDATE SET value=excluded.value",
                       (kind, key, json.dumps(value)))

    def reviews(self, session, repo, sha, parent):
        with self.connect() as db:
            return {row[0] for row in db.execute("SELECT file FROM reviewed WHERE session=? AND repo=? AND sha=? AND parent=?",
                                               (session, repo, sha, parent))}

    def review(self, session, repo, sha, parent, file, reviewed):
        with self.connect() as db:
            params = (session, repo, sha, parent, file)
            if reviewed:
                db.execute("INSERT OR IGNORE INTO reviewed VALUES (?,?,?,?,?)", params)
            else:
                db.execute("DELETE FROM reviewed WHERE session=? AND repo=? AND sha=? AND parent=? AND file=?", params)


class SessionReader:
    def __init__(self, home):
        self.home = Path(home)

    def open(self):
        from hermes_state import SessionDB
        return SessionDB(self.home / "state.db", read_only=True)

    def info(self, sid):
        db = self.open()
        try:
            lineage = db.get_compression_lineage(sid)
            if not lineage:
                raise ValueError("This chat's stored transcript is not available yet. Retry after its first message.")
            tip = db.get_compression_tip(sid)
            row = db.get_session(tip)
            if not row:
                raise ValueError("The chat no longer exists.")
            return {"id": lineage[0], "tip": tip, "cwd": row.get("cwd") or "",
                    "git_root": row.get("git_repo_root") or "", "title": row.get("title") or "Chat"}
        finally:
            db.close()

    def messages(self, sid):
        db = self.open()
        try:
            tip = db.get_compression_tip(sid)
            # Hermes owns display-generation deduplication and fork/rewind boundaries.
            yield from db.get_messages(tip, include_compacted=True, include_ancestors=True)
        finally:
            db.close()
