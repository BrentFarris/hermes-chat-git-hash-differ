"""Namespaced RPC service; heavy scans run outside the gateway and agent loops."""

from concurrent.futures import ThreadPoolExecutor
from contextvars import copy_context
from pathlib import Path
import copy
import json
import logging
import re
import threading
import time

from .detection import scan_messages
from .git_reader import GitError, GitReader, identity
from .storage import SessionReader, Store

PLUGIN = "hermes-chat-git-hash-differ"
log = logging.getLogger(PLUGIN)


class DifferService:
    def __init__(self, ctx, home=None, reader_factory=SessionReader, git=None):
        self.ctx, self.explicit_home, self.reader_factory = ctx, home, reader_factory
        self.git = git or GitReader()
        self.lock = threading.RLock()
        self.executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="chat-git")
        self.jobs, self.stores = {}, {}
        self.stopped = False
        self.methods = {
            "session.get": self.session_get, "session.refresh": self.session_refresh,
            "repositories.add": self.repositories_add, "repositories.remove": self.repositories_remove,
            "commit.files": self.commit_files, "file.diff": self.file_diff, "review.set": self.review_set,
            "settings.get": self.settings_get, "settings.set": self.settings_set,
        }

    def home(self):
        if self.explicit_home:
            return Path(self.explicit_home)
        from hermes_constants import get_hermes_home
        return get_hermes_home()

    def store(self, home):
        key = str(home)
        with self.lock:
            if key not in self.stores:
                self.stores[key] = Store(Path(home) / "plugin-data" / PLUGIN)
            return self.stores[key]

    def scope(self, params, session_id):
        if not isinstance(params, dict) or not isinstance(session_id, str) or not session_id or len(session_id) > 512:
            raise ValueError("An authorized session_id is required.")
        home = self.home()
        reader = self.reader_factory(home)
        info = reader.info(session_id)
        return home, reader, info, self.store(home)

    def changed(self, session_id=None, task_id=None, **kwargs):
        if self.stopped:
            return
        # Dirty the owning profile's cached scans; never do filesystem/Git work in a hook.
        home = str(self.home())
        with self.lock:
            for (scope, _), job in self.jobs.items():
                if scope == home:
                    job["dirty"] = True
        sid = session_id or task_id
        if sid:
            self.ctx.emit_to_session(sid, "changed", {})

    def settings_get(self, params=None, **kwargs):
        return {"auto_open": self.store(self.home()).get("settings", "auto_open", True)}

    def settings_set(self, params, **kwargs):
        if type(params.get("auto_open")) is not bool:
            raise ValueError("auto_open must be a boolean.")
        self.store(self.home()).set("settings", "auto_open", params["auto_open"])
        return self.settings_get()

    def session_refresh(self, params, *, session_id, **kwargs):
        return self.session_get(params, session_id=session_id, force=True)

    def session_get(self, params, *, session_id, force=False, **kwargs):
        home, reader, info, store = self.scope(params, session_id)
        key = (str(home), info["id"])
        with self.lock:
            job = self.jobs.setdefault(key, {"snapshot": {"session": info, "commits": [], "unresolved": [],
                                                       "repositories": [], "errors": []},
                                             "running": False, "dirty": True, "checked": 0, "epoch": 0})
            if force:
                job["dirty"] = True
                job["force"] = True
            if not job["running"] and (job["dirty"] or time.monotonic() - job["checked"] >= 5) and not self.stopped:
                job["running"], job["dirty"] = True, False
                job["epoch"] += 1
                epoch = job["epoch"]
                # copy_context keeps the profile and secret scope bound in the worker.
                context = copy_context()
                self.executor.submit(context.run, self._scan, key, epoch, reader, info, store, session_id, job.pop("force", False))
            result = copy.deepcopy(job["snapshot"])
            result["scanning"] = job["running"]
        for commit in result["commits"]:
            commit["reviewed_count"] = len(store.reviews(info["id"], commit["repo_id"], commit["sha"], commit["parent"]))
        result["auto_open"] = store.get("settings", "auto_open", True)
        return result

    def _repositories(self, info, store):
        saved = store.get("repos", info["id"], [])
        excluded = store.get("excluded", info["id"], [])
        paths = [info.get("git_root") or info.get("cwd"), *saved]
        repos, errors = {}, []
        for path in dict.fromkeys(p for p in paths if p):
            try:
                repo = self.git.repository(path)
                if repo["id"] not in excluded:
                    repos[repo["id"]] = repo
            except GitError as exc:
                errors.append({"code": exc.code, "message": f"{path}: {exc}"})
        return list(repos.values()), errors

    def _scan(self, key, epoch, reader, info, store, request_sid, force=False):
        snapshot = {"session": info, "commits": [], "unresolved": [], "repositories": [], "errors": []}
        try:
            refs = scan_messages(reader.messages(request_sid))
            repos, errors = self._repositories(info, store)
            snapshot.update(repositories=repos, errors=errors)
            choices = store.get("choices", info["id"], {})
            fingerprint = identity(json.dumps([refs, repos, errors, choices], sort_keys=True))
            # Reconcile the full read-only transcript (including rewinds), but avoid
            # re-resolving identical references on every event/poll. Explicit Retry
            # always checks Git, and a 30-second expiry catches newly available objects.
            with self.lock:
                job = self.jobs.get(key, {})
                unchanged = job.get("fingerprint") == fingerprint and time.monotonic() - job.get("resolved", 0) < 30
                if unchanged and not force:
                    snapshot = copy.deepcopy(job["snapshot"])
                    snapshot["session"] = info
                    return
                job.update(fingerprint=fingerprint, resolved=time.monotonic())
            grouped = {}
            for ref in refs:
                grouped.setdefault((ref["hash"], ref["hint"]), []).append(ref)
            commits = {}
            for (candidate, hint), occurrences in grouped.items():
                if self.stopped:
                    return
                matches, ambiguity = [], False
                preferred = choices.get(candidate)
                targets = [repo for repo in repos if repo["id"] == preferred] if preferred else repos
                if hint and not preferred:
                    hinted = [repo for repo in targets if hint in repo["hints"]]
                    if hinted:
                        targets = hinted
                for repo in targets:
                    try:
                        sha = self.git.resolve(repo, candidate)
                        matches.append((repo, sha))
                    except GitError as exc:
                        ambiguity |= exc.code == "ambiguous"
                        if exc.code not in {"ambiguous", "missing_object"}:
                            snapshot["errors"].append({"code": exc.code, "message": str(exc)})
                if len(matches) != 1 or ambiguity:
                    snapshot["unresolved"].append({"hash": candidate, "hint": hint,
                        "reason": "ambiguous" if ambiguity or len(matches) > 1 else "missing",
                        "repositories": [repo["id"] for repo, _ in matches], "occurrences": len(occurrences)})
                    continue
                repo, sha = matches[0]
                commit_key = (repo["id"], sha)
                if commit_key not in commits:
                    meta = self.git.metadata(repo, sha)
                    parent = meta["parents"][0] if meta["parents"] else ""
                    count, problem = None, None
                    try:
                        count = len(self.git.files(repo, sha, parent)["files"])
                    except GitError as exc:
                        problem = {"code": exc.code, "message": str(exc)}
                    commits[commit_key] = {**meta, "id": f"{repo['id']}:{sha}", "repo_id": repo["id"],
                        "repo_name": repo["name"], "parent": parent, "file_count": count, "problem": problem,
                        "first_position": occurrences[0]["position"], "occurrences": 0}
                commit = commits[commit_key]
                commit["first_position"] = min(commit["first_position"], occurrences[0]["position"])
                commit["occurrences"] += len(occurrences)
            snapshot["commits"] = sorted(commits.values(), key=lambda c: (-c["first_position"], c["id"]))
        except Exception as exc:
            log.debug("Session scan failed", exc_info=True)
            snapshot["errors"].append({"code": "scan_failed", "message": str(exc)[:600]})
        finally:
            with self.lock:
                job = self.jobs.get(key)
                if job and job["epoch"] == epoch:
                    job.update(snapshot=snapshot, running=False, checked=time.monotonic())
            if not self.stopped:
                self.ctx.emit_to_session(request_sid, "changed", {})

    def repositories_add(self, params, *, session_id, **kwargs):
        home, reader, info, store = self.scope(params, session_id)
        path = params.get("path")
        if not isinstance(path, str) or not path.strip() or len(path) > 4096:
            raise ValueError("Enter a repository directory on the Hermes host.")
        repo = self.git.repository(path)
        candidate = params.get("hash")
        if candidate is not None:
            self.git.resolve(repo, candidate)
        with self.lock:
            store.set("repos", info["id"], list(dict.fromkeys([*store.get("repos", info["id"], []), repo["path"]])))
            store.set("excluded", info["id"], [r for r in store.get("excluded", info["id"], []) if r != repo["id"]])
            if candidate is not None:
                choices = store.get("choices", info["id"], {})
                choices[candidate] = repo["id"]
                store.set("choices", info["id"], choices)
        return self.session_refresh({}, session_id=session_id)

    def repositories_remove(self, params, *, session_id, **kwargs):
        home, reader, info, store = self.scope(params, session_id)
        repo_id = params.get("repo_id")
        repos, _ = self._repositories(info, store)
        repo = next((r for r in repos if r["id"] == repo_id), None)
        if not repo:
            raise ValueError("Repository is not associated with this chat.")
        with self.lock:
            store.set("repos", info["id"], [p for p in store.get("repos", info["id"], []) if p != repo["path"]])
            store.set("excluded", info["id"], [*store.get("excluded", info["id"], []), repo_id])
            store.set("choices", info["id"], {h: r for h, r in store.get("choices", info["id"], {}).items() if r != repo_id})
        return self.session_refresh({}, session_id=session_id)

    def _commit(self, params, session_id):
        home, reader, info, store = self.scope(params, session_id)
        with self.lock:
            snapshot = self.jobs.get((str(home), info["id"]), {}).get("snapshot", {})
            commit = next((c for c in snapshot.get("commits", []) if c["id"] == params.get("commit_id")), None)
        if not commit:
            raise ValueError("Select a detected commit from this chat after its scan finishes.")
        repos, _ = self._repositories(info, store)
        repo = next((r for r in repos if r["id"] == commit["repo_id"]), None)
        if not repo:
            raise ValueError("Repository is no longer associated with this chat.")
        return info, store, repo, commit

    def commit_files(self, params, *, session_id, **kwargs):
        info, store, repo, commit = self._commit(params, session_id)
        result = copy.deepcopy(self.git.files(repo, commit["sha"], params.get("parent")))
        reviewed = store.reviews(info["id"], repo["id"], commit["sha"], result["parent"])
        for file in result["files"]:
            file["reviewed"] = file["id"] in reviewed
        return result

    def file_diff(self, params, *, session_id, **kwargs):
        info, store, repo, commit = self._commit(params, session_id)
        context = params.get("context", 3)
        if type(context) is not int or not 0 <= context <= 1000:
            raise ValueError("Context must be between 0 and 1000 lines.")
        try:
            return self.git.diff(repo, commit["sha"], params.get("parent"), params.get("file_id"), context)
        except GitError as exc:
            return {"kind": exc.code, "message": str(exc), "hunks": []}

    def review_set(self, params, *, session_id, **kwargs):
        if type(params.get("reviewed")) is not bool:
            raise ValueError("reviewed must be a boolean.")
        info, store, repo, commit = self._commit(params, session_id)
        listing = self.git.files(repo, commit["sha"], params.get("parent"))
        if params.get("file_id") not in {f["id"] for f in listing["files"]}:
            raise ValueError("File is not part of this comparison.")
        store.review(info["id"], repo["id"], commit["sha"], listing["parent"], params["file_id"], params["reviewed"])
        self.ctx.emit_to_session(session_id, "changed", {})
        return self.commit_files(params, session_id=session_id)

    def close(self):
        self.stopped = True
        self.executor.shutdown(wait=False, cancel_futures=True)
