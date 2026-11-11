# Architecture and RPC

`plugin.yaml` loads `__init__.py`, which registers a `DifferService`. Observer hooks only invalidate state and emit an event. `SessionReader` uses Hermes's public, read-only `SessionDB` API; it does not issue SQL against Hermes tables. The independent `Store` owns its SQLite schema. `GitReader` performs bounded object reads. `desktop/plugin.js` is an ESM bundle built from the TypeScript/React sources and CSS.

The frontend captures the focused session's **connection ID, profile, runtime session ID, and durable session ID**. Routes come from `host.profileRoutes()` and every call uses `host.requestProfile()`. A capability preflight checks `runtime.describe`. Hermes authorizes `session_id` before invoking the Python handler in the owning profile context. Background scans copy that context. Results from previous controller lifetimes or selections are discarded.

The expanded tab retains its controller when chat focus changes. Controllers are shared by the compact/expanded views, and old inactive controllers are evicted. Workspace panes use `host.openWorkspace()` so closing a surface does not dispose the plugin's status control or observers.

The `composer.underside` contribution renders a responsive strip from that same controller snapshot, without additional polling or backend methods. Hermes 0.23.1's generic render slots do not pass a per-composer session; the strip explicitly follows the focused chat. Its native SDK popover windows long result lists. Explicit clicks capture the controller and recheck the current owner/profile/durable-chat tuple before navigating. Old chips disappear before asynchronous route resolution, and keyed pickers unmount on chat changes. Matching open workspace panes are re-fronted through `host.revealPane()`; closing review leaves composer/status/palette contributions registered.

## RPC methods

Prefix every method below with `plugin.hermes-chat-git-hash-differ.` and include `session_id` for session-bound calls. Repository IDs, commit IDs, and file IDs are opaque values returned by the service, not paths accepted from the frontend.

| Method | Additional parameters | Result |
|---|---|---|
| `session.get` | none | snapshot: `session`, `commits`, `unresolved`, `repositories`, `errors`, `scanning`, `auto_open` |
| `session.refresh` | none | same snapshot; requests an asynchronous forced scan |
| `repositories.add` | `path`, optional `hash` | validates/adds a host repository, optionally selects it for a reference, then refreshes |
| `repositories.remove` | `repo_id` | removes/excludes that association, then refreshes |
| `commit.files` | `commit_id`, optional `parent` | commit metadata, resolved comparison parent, paths/status/statistics/review flags |
| `file.diff` | `commit_id`, `file_id`, optional `parent`, `context` (0–1000, default 3) | `kind`, `hunks`, optional `message`; rows contain `kind`, `text`, `old`, `new` |
| `review.set` | `commit_id`, `file_id`, optional `parent`, boolean `reviewed` | updated file listing with review flags |
| `settings.get` | none | `{auto_open: boolean}` |
| `settings.set` | boolean `auto_open` | updated settings |

Omitted/null comparison parents select the first parent; `""` denotes the empty tree and is accepted only for root commits. Arbitrary comparison commits are rejected. File operations require membership in both the detected chat index and its current repository associations.

Errors distinguish `missing_object`, `ambiguous`, `repository_unavailable`, `git_missing`, `missing_parent`, `invalid_parent`, `file_missing`, `timeout`, and `too_large`. `file.diff` returns a typed non-text/limited result instead of a partial patch. Other handler failures use Hermes's normal plugin RPC error envelope.

## Persistence and reconciliation

Backend database: `<profile home>/plugin-data/hermes-chat-git-hash-differ/review.sqlite3` (schema version 1). Review keys are `(conversation root, repository identity, full commit hash, comparison parent, file ID)`. Repository associations/explicit choices/exclusions are keyed by conversation root. Auto-opening preference is per profile. Gateways remain isolated because each request is routed to its owner and storage lives on that host.

Client-local plugin storage keys include connection/profile/durable chat identity. They retain whether a pane has already opened, last reviewed commit and comparison parent, last selected files, per-file context and scroll offsets, and the preferred expanded diff layout. `discovery:<identity>` stores current known and newly discovered commit IDs: the first completed snapshot is a baseline, subsequent additions are new until selected, and removed references are pruned. `lastReview:<identity>` is usable only while its commit remains in the current snapshot. `showCommitChips` is a client-wide presentation preference. Reviewed state is never inferred from any of these preferences.

Every rescan reconciles the canonical read-only transcript, so deleted/rewound references disappear rather than accumulating indefinitely. The order uses the first surviving message position, newest first; repeated mentions don't change it. A snapshot fingerprint avoids repeated resolution for unchanged references; explicit retry bypasses it. Only successfully resolved canonical repository/hash pairs become commit cards.
