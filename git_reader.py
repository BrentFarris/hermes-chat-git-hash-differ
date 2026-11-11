"""Bounded, read-only Git object access. No shell, checkout, fetch, or textconv."""

from collections import OrderedDict
from hashlib import sha256
from pathlib import Path
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time


class GitError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def identity(value):
    return sha256(value.encode("utf-8", "surrogatepass")).hexdigest()[:24]


class GitReader:
    def __init__(self, executable=None, timeout=8, max_bytes=2 * 1024 * 1024, max_cache_bytes=32 * 1024 * 1024):
        self.executable = executable or shutil.which("git")
        self.timeout, self.max_bytes = timeout, max_bytes
        self.cache = OrderedDict()
        self.cache_bytes, self.max_cache_bytes = 0, max_cache_bytes
        self.lock = threading.RLock()

    def run(self, repo, *args, limit=None):
        if not self.executable:
            raise GitError("git_missing", "Install Git on the Hermes host and restart the plugin.")
        cap = limit or self.max_bytes
        env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
        env.update(GIT_OPTIONAL_LOCKS="0", GIT_TERMINAL_PROMPT="0", GIT_NO_LAZY_FETCH="1",
                   GIT_PAGER="cat", LC_ALL="C")
        command = [self.executable, "--no-pager", "--literal-pathspecs", "-c", "core.fsmonitor=false",
                   "-c", "core.hooksPath=", "-c", "diff.suppressBlankEmpty=false", "-C", str(repo), *args]
        # File-backed streams avoid pipe deadlocks and bound in-memory capture. Kill on size/time.
        with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
            try:
                process = subprocess.Popen(command, stdout=out, stderr=err, stdin=subprocess.DEVNULL,
                                           env=env, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            except OSError as exc:
                raise GitError("repository_unavailable", f"Cannot read repository: {exc}") from exc
            started = time.monotonic()
            failure = None
            while process.poll() is None:
                if os.fstat(out.fileno()).st_size > cap or os.fstat(err.fileno()).st_size > cap:
                    failure = GitError("too_large", "This Git result exceeds the display limit.")
                    break
                if time.monotonic() - started > self.timeout:
                    failure = GitError("timeout", "Git timed out. Retry or use a smaller repository.")
                    break
                time.sleep(0.01)
            if failure:
                process.kill()
            process.wait()
            if failure:
                raise failure
            if os.fstat(out.fileno()).st_size > cap or os.fstat(err.fileno()).st_size > cap:
                raise GitError("too_large", "This Git result exceeds the display limit.")
            out.seek(0)
            err.seek(0)
            data, error = out.read(), err.read().decode("utf-8", "replace")
            if process.returncode:
                code = "ambiguous" if "ambiguous" in error else "missing_object"
                raise GitError(code, error.strip()[:600] or "Git could not read this object.")
            return data

    def repository(self, path):
        path = str(Path(path).expanduser().resolve())
        if not Path(path).is_dir():
            raise GitError("repository_unavailable", "Repository directory is unavailable on this Hermes host.")
        try:
            common = self.run(path, "rev-parse", "--path-format=absolute", "--git-common-dir").decode().strip()
        except GitError as exc:
            if exc.code == "missing_object":
                raise GitError("repository_unavailable", f"Cannot open this Git repository: {exc}") from exc
            raise
        try:
            root = self.run(path, "rev-parse", "--show-toplevel").decode().strip()
        except GitError:
            root = path  # bare repositories still contain readable commit objects
        common = os.path.normcase(str(Path(common).resolve()))
        try:
            remotes = self.run(path, "remote", "-v").decode("utf-8", "replace")
        except GitError:
            remotes = ""
        hints = []
        for line in remotes.splitlines():
            parts = line.split()
            if len(parts) > 1:
                remote = re.sub(r"^[\w+.-]+://(?:[^/@]+@)?", "", parts[1])
                remote = re.sub(r"^[^/@]+@", "", remote).replace(":", "/", 1)
                hints.append(remote.removesuffix(".git").lower())
        return {"id": identity(common), "path": root, "name": Path(root).name, "hints": hints}

    def resolve(self, repo, candidate):
        if not isinstance(candidate, str) or not re.fullmatch(r"[0-9a-fA-F]{4,64}", candidate):
            raise GitError("invalid_reference", "Expected a hexadecimal commit hash.")
        # Disambiguate only commits, and never let an all-hex branch name shadow an object ID.
        ids = self.run(repo["path"], "rev-parse", f"--disambiguate={candidate.lower()}").decode().split()
        commits = []
        for oid in ids:
            if self.run(repo["path"], "cat-file", "-t", oid).strip() == b"commit":
                commits.append(oid)
        if len(commits) != 1:
            raise GitError("ambiguous" if commits else "missing_object",
                           "Hash matches several commits." if commits else "Commit is not available in this repository.")
        return commits[0]

    def cached(self, key, compute):
        with self.lock:
            if key in self.cache:
                self.cache.move_to_end(key)
                return self.cache[key][0]
        value = compute()
        pending, seen, size = [value], set(), 0
        while pending:
            item = pending.pop()
            if id(item) in seen:
                continue
            seen.add(id(item))
            size += sys.getsizeof(item)
            if isinstance(item, dict):
                pending.extend(item.keys())
                pending.extend(item.values())
            elif isinstance(item, (list, tuple)):
                pending.extend(item)
        if size > self.max_cache_bytes:
            return value
        with self.lock:
            previous = self.cache.pop(key, None)
            self.cache_bytes -= previous[1] if previous else 0
            self.cache[key] = (value, size)
            self.cache_bytes += size
            while len(self.cache) > 128 or self.cache_bytes > self.max_cache_bytes:
                self.cache_bytes -= self.cache.popitem(last=False)[1][1]
        return value

    def metadata(self, repo, sha):
        def read():
            raw = self.run(repo["path"], "show", "-s", "--no-show-signature", "--format=%H%x00%P%x00%s%x00%an%x00%aI", sha)
            fields = raw.decode("utf-8", "replace").strip().split("\0", 4)
            # Git's pretty-format parent list hides parents at a shallow boundary.
            headers = self.run(repo["path"], "cat-file", "commit", sha).split(b"\n\n", 1)[0]
            parents = [line[7:].decode("ascii") for line in headers.splitlines() if line.startswith(b"parent ")]
            return dict(zip(("sha", "parents", "subject", "author", "date"), fields)) | {"parents": parents}
        return self.cached((repo["id"], sha, "meta"), read)

    def comparison(self, repo, sha, parent):
        meta = self.metadata(repo, sha)
        if parent is None:
            parent = meta["parents"][0] if meta["parents"] else ""
        if parent not in meta["parents"] and (parent or meta["parents"]):
            raise GitError("invalid_parent", "Choose one of this commit's parents.")
        if parent:
            try:
                self.run(repo["path"], "cat-file", "-e", parent + "^{commit}")
            except GitError as exc:
                raise GitError("missing_parent", "The parent is unavailable, possibly because this is a shallow clone.") from exc
        return parent

    def diff_args(self, sha, parent):
        return ["diff", parent, sha] if parent else ["diff-tree", "--root", "--no-commit-id", "-r", sha]

    def files(self, repo, sha, parent=None):
        parent = self.comparison(repo, sha, parent)
        def read():
            flags = ["--no-ext-diff", "--no-textconv", "--no-color", "--find-renames", "-z"]
            base = self.diff_args(sha, parent)
            status = self.run(repo["path"], *base, *flags, "--name-status").split(b"\0")
            stats = self.run(repo["path"], *base, *flags, "--numstat").split(b"\0")
            numbers = {}
            i = 0
            while i < len(stats) and stats[i]:
                added, deleted, path = stats[i].split(b"\t", 2)
                i += 1
                if not path:
                    i += 1  # old path for a rename
                    path = stats[i]
                    i += 1
                numbers[path] = (None if added == b"-" else int(added), None if deleted == b"-" else int(deleted))
            files, i = [], 0
            while i < len(status) and status[i]:
                kind = status[i].decode()
                old, path = status[i + 1], status[i + 1]
                i += 2
                if kind[0] in "RC":
                    path = status[i]
                    i += 1
                adds, dels = numbers.get(path, (0, 0))
                # JSON can carry escaped surrogate code points; filesystem bytes round-trip with surrogateescape.
                decoded = path.decode("utf-8", "surrogateescape")
                files.append({"id": identity(kind + "\0" + old.decode("utf-8", "surrogateescape") + "\0" + decoded),
                              "path": decoded, "old_path": old.decode("utf-8", "surrogateescape"),
                              "status": kind[0], "added": adds, "deleted": dels, "binary": adds is None})
            return {"parent": parent, "files": sorted(files, key=lambda f: f["path"]), "commit": self.metadata(repo, sha)}
        return self.cached((repo["id"], sha, parent, "files"), read)

    def diff(self, repo, sha, parent, file_id, context=3):
        listing = self.files(repo, sha, parent)
        file = next((f for f in listing["files"] if f["id"] == file_id), None)
        if not file:
            raise GitError("file_missing", "This file does not belong to the selected comparison.")
        if file["binary"]:
            return {"kind": "binary", "message": "Binary file changed. A text diff is unavailable.", "hunks": []}
        def read():
            raw = self.run(repo["path"], *self.diff_args(sha, listing["parent"]), "--patch", "--find-renames",
                           "--no-ext-diff", "--no-textconv", "--no-color", "--submodule=short",
                           "--output-indicator-new=+", "--output-indicator-old=-", "--output-indicator-context= ", f"--unified={context}",
                           "--", file["old_path"], file["path"])
            text = raw.decode("utf-8", "replace")
            if re.search(r"^(?:old mode |new mode |new file mode |deleted file mode |index .* )160000", text, re.M):
                kind = "submodule"
            elif "Binary files " in text:
                return {"kind": "binary", "message": "Binary file changed.", "hunks": []}
            else:
                kind = "text"
            hunks, current, old, new = [], None, 0, 0
            for line in text.splitlines():
                match = re.match(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)", line)
                if match:
                    old, new = int(match[1]), int(match[3])
                    current = {"header": line, "lines": []}
                    hunks.append(current)
                elif current is not None and line[:1] in {" ", "+", "-", "\\"}:
                    tag = line[0]
                    current["lines"].append({"kind": {" ": "context", "+": "add", "-": "delete", "\\": "note"}[tag],
                                             "text": line[1:], "old": old if tag in " -" else None,
                                             "new": new if tag in " +" else None})
                    old += tag in " -"
                    new += tag in " +"
            return {"kind": kind, "hunks": hunks, "context": context,
                    "message": "Mode or path changed; no text changes." if not hunks else ""}
        return self.cached((repo["id"], sha, listing["parent"], file_id, context), read)
