# Hermes Chat Git Hash Differ

Version **0.1.0** · MIT · Hermes **0.23.1+**

Find commits mentioned in a Hermes chat and review **commit → file → diff** beside the conversation, or in an expanded workspace tab. Works in Hermes Desktop and Webapp with repositories on the chat's backend host.

## Review

- **Commits · N** stays in the status bar. The first validated commit automatically opens the resizable **Session commits** pane once per chat and client. Closing it keeps detection running.
- Search commits by subject, hash, or repository. Newest first appearance comes first; repeated short/full mentions increase the count without moving or duplicating a commit.
- Select a commit to see its directory-grouped file list. Search filenames, filter unreviewed files, and mark files **Reviewed** explicitly. Reading a diff never marks it reviewed.
- Use the searchable commit picker and previous/next buttons without returning to the overview. Selected files and scroll positions are remembered per commit and parent on that client.
- **Expand** closes the side pane and opens one reusable **Commit review** workspace tab. It stays attached to its original chat when you switch chats. Close that tab and use **Commits · N** to return to the side pane.
- Compact panes use unified diffs; expanded tabs offer unified and side-by-side layouts. Side-by-side needs at least 900 px of diff width. **More context** increases surrounding lines up to 1,000.
- Ordinary commits compare with their parent; root commits compare with the empty tree. Merge commits start at the first parent and offer a parent selector. Review progress is separate for each parent.

**Automatically open the commit panel** defaults to on, under the plugin's settings page (also available from the pane's **Settings** button). This preference belongs to the backend profile. Opening/dismissal and navigation belong to the individual client. Later discoveries never replace your selected commit or reopen a dismissed pane.

## Requirements

- Hermes 0.23.1 or later exposing `plugin-rpc-v1`, session owner/profile routing, settings pages, and workspace panes. Both halves of the plugin must be enabled.
- Git installed on the **backend** host and available on its PATH; Python is supplied by Hermes. No additional Python packages, model tools, credentials, or hosted Git API are used.
- Read access to the chat's stored history and host repositories, plus write access to that profile's plugin-data directory.
- Node 20.19+ (tested with Node 24) and npm are needed only to develop/rebuild the frontend. The package already contains `desktop/plugin.js`. React and `@hermes/plugin-sdk` are supplied by Hermes and remain external.

Hermes emits useful setup errors for unsupported runtimes and disabled backend methods. For a remote chat, repository paths refer to the remote machine, not your Desktop computer.

## Install a local build

Production installation is a separate action; development and validation do not install into your normal Hermes home.

1. Copy `plugin.yaml`, the five root Python modules, `LICENSE`, and the `desktop` directory into `<profile HERMES_HOME>/plugins/hermes-chat-git-hash-differ/`. Keep these files together. Copying README is recommended.
2. In that same backend profile, run:

   ```text
   hermes plugins enable hermes-chat-git-hash-differ
   ```

3. Restart that backend to load the Python handlers. In Desktop/Webapp **Settings → Plugins**, rescan and enable **Chat Git Hash Differ**. Hermes discovers the frontend from the unified package's `desktop/plugin.js`.
4. Open a saved chat. If its recorded working directory does not identify the repository, choose **Add repository** and enter a directory on that chat's Hermes host.

For a Desktop connected to a remote Hermes host, install the backend package in the remote profile as above. Also copy `desktop/plugin.js` to the Desktop machine's `<Hermes app home>/desktop-plugins/hermes-chat-git-hash-differ/plugin.js`, then rescan/enable it there. The Webapp reads the frontend from its serving host. Frontend installation on your local Desktop does not install the backend remotely.

Do not keep competing versions of this plugin in both desktop-plugins and a local unified package. Hermes's supported plugin installer can be used once the repository has a committed Git source; a local source install clones committed content, so it does not include uncommitted development files.

## Update / remove

Replace the package files together, restart the owning backend, and rescan/reload the frontend. Keep `<profile HERMES_HOME>/plugin-data/hermes-chat-git-hash-differ/review.sqlite3` to preserve settings, repository associations, and review progress. Back it up with the profile when Hermes is stopped.

Disable the frontend in Settings → Plugins and run `hermes plugins disable hermes-chat-git-hash-differ` in each backend profile to stop it. Removing the package does not require removing its saved review database. This plugin never edits a repository or the Hermes transcript.

## Repository resolution and limits

The recorded Git root/working directory is checked automatically. Additional repository associations are chat-specific. Worktrees share a canonical repository identity; separate clones remain separate repositories. URLs supply remote-name hints only. When multiple repositories match, **Unresolved references → Choose repository** binds that reference to your choice. **Retry** checks again after you make objects available outside the plugin.

Detection scans stored user, assistant, and tool messages, including tool arguments, code blocks, URLs, compacted messages, and verified compression ancestors. Branches, rewinds, and unrelated/delegated sessions remain isolated. Standalone 7–64 character hexadecimal candidates and explicitly identified 4–6 character commit abbreviations are validated against Git. A hexadecimal word that is not a commit is never shown as a validated commit.

Changes come from Git objects, independently of dirty working files. Git uses argument arrays, literal pathspecs, disabled external diff/text conversion, no lazy fetch, an 8-second per-command timeout, and a 2 MiB per-command output cap. Binary changes, submodule pointers, unavailable parents in shallow clones, inaccessible repositories, and oversized results have explicit states. A limited result is never displayed as a complete patch. Non-UTF-8 text is displayed with replacement characters; path bytes are retained for Git access.

Visible chats poll every five seconds as a fallback to session events. Scans run in two background workers. Unchanged reference sets reuse resolution for up to 30 seconds; manual Refresh/Retry forces Git checks. Immutable metadata, file lists, and patches are cached; file patches load on demand. Commit, file, and diff rows are windowed. Progress is shared through the owning backend profile; updates from another client appear on the next refresh/poll.

V1 does not fetch repositories, compare ranges, apply patches, stage, checkout, commit, or publish. A remote-transport test on localhost is included; deployment-specific SSH, network latency, and authentication should also be checked against your actual remote host.

## Develop and validate

```powershell
npm ci
npm run typecheck
npm test
npm run build
python -B -m unittest discover -s tests -v
```

Python tests use temporary Git repositories, including SHA-256 and shallow clones. Use a Git version with SHA-256 repository support. `tests/check_hermes.py` additionally checks real SessionDB history plus Hermes's validator and doctor. Run it with Hermes's Python, `HERMES_SOURCE` pointing at its source, and **an isolated `HERMES_HOME`**. Set `HERMES_DISABLE_LAZY_INSTALLS=1` to use the existing runtime without triggering dependency provisioning. The script refuses to run without an explicit home.

For end-to-end tests, run `tests/prepare_live.py <new-empty-test-home>` with Hermes's Python/source available, then start a separate `python -m gateway.run` with that `HERMES_HOME`, `HERMES_DISABLE_LAZY_INSTALLS=1`, and `HERMES_WEBAPP_DIST` pointing at the installed `apps/desktop/dist-webapp`. The fixture uses port 19120, creates 20 real commits and one chat, and makes no model calls. It refuses to overwrite an existing session database.

```powershell
$env:HERMES_TEST_HOME = 'C:\path\to\isolated-test-home'
$env:HERMES_TEST_URL = 'http://127.0.0.1:19120'
$env:HERMES_TEST_DESKTOP = 'C:\path\to\Hermes.exe'
npm run test:browser
```

The browser test uses installed Edge; set `HERMES_TEST_BROWSER=chromium` to use Playwright Chromium. The Desktop test launches a separate hidden instance, with its own home and user-data directory, and connects to the fixture using the remote gateway route. Test output can contain fixture credentials; it is excluded from version control and release packages.

See [docs/architecture.md](docs/architecture.md) for the RPC/data model and [docs/validation.md](docs/validation.md) for release validation results.

SDK references: [Desktop plugin SDK](https://hermes-agent.nousresearch.com/docs/developer-guide/desktop-plugin-sdk) and [plugin RPC and session events](https://hermes-agent.nousresearch.com/docs/developer-guide/plugins#talk-to-your-own-frontend-plugin-rpc-methods-and-session-events).
