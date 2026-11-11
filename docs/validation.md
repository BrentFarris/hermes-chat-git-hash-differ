# v0.2.0 validation

Validated on Windows on 2026-11-10 against installed Hermes **0.23.1**, source commit `3b421578588243f920886e6fe79a6faa87ea026e`. Test homes, session databases, repositories, browser profiles, and Desktop user-data directories were isolated from the normal Hermes installation.

| Check | Result |
|---|---|
| TypeScript strict typecheck | Pass |
| ESM frontend build, React/SDK external | Pass |
| Python detection / Git / service suite | 13 passed in v0.1.0; backend unchanged in this update |
| Frontend/controller/keyboard suite | 14 passed |
| Real Hermes SessionDB history checks | Pass |
| Hermes plugin validation | All 16 checks passed; no warnings |
| Hermes plugin doctor | Passed import, discovery, manifest parsing and registration; 5 observer hooks, no model tools |
| Actual Webapp, installed Edge | Passed original 20-commit review and new composer/reopening journey |
| Actual packaged Hermes Desktop | Passed shared review, chip navigation, expanded-tab reuse and Resume review with a separate test home and remote gateway connection |

Python tests cover abbreviated/full duplicate references, URLs, terminal results and structured tool data, false candidates, SHA-1/SHA-256, ambiguity/missing objects, worktree identity, root/ordinary/merge comparisons, renames, deletions, Unicode/literal paths, binary files, submodule pointers, shallow parents, bounded output, disabled external diff helpers, repository ambiguity, profile/chat isolation, parent-specific reviews, asynchronous scans, and scan reuse/forced retry.

Real Hermes history fixtures verify raw terminal results, compression ancestor traversal, in-place compaction, rewinds removing obsolete references, explicit branch isolation, and delegated-session isolation. Frontend tests cover late responses, route lifetimes, gateway/profile storage separation, explicit review writes and failures, retained file/scroll navigation, keyboard movement across directory headers, automatic-opening/dismissal, and expanded-tab binding.

The original live Webapp journey resolves 20 commits from the fixture repository, filters/selects a commit, reads its object diff, saves a review mark, expands the same selection, switches diff layouts/commits, expands context, disables automatic opening, opens another client without an automatic pane, and observes shared review changes.

The new journey toggles the client-local strip preference, closes review with automatic opening off, reopens a commit from a chip, searches the native overflow picker and selects with Enter, reloads and resumes the same commit/context, navigates into an existing expanded tab, and returns through the native command palette using Ctrl+K, arrow keys and Enter. Desktop exercises chip navigation into its existing expanded tab, closes it, then resumes in the side panel over the remote route. Full-width and split-width Webapp strips and the searchable picker were visually inspected.

New controller/UI tests cover parent/file/context/scroll restoration after a reload, gateway/profile/chat isolation, stale actions during asynchronous chat switching, removed references invalidating Resume, quiet discovery markers and duplicate mentions, reviewed labels, full-hash/subject/repository search, keyboard selection, picker dismissal, client-local hiding, direct navigation out of settings, and reopening with auto-open disabled. Opening a commit does not mark any file reviewed.

The remote connection was a separate backend on localhost using the actual network transport and owner routing. An external SSH/remote machine was not available for deployment-specific validation. No hosted Git API was used. Live testing caught composer focus restoration dismissing a newly opened non-modal picker after closing review; the native modal popover now contains focus and passes that regression. The native palette was verified by keyboard; mouse hit testing of its rows was unreliable in the installed fixture. Screenshot capture of a hidden native Electron window was unreliable, so Desktop validation uses its actual rendered controls; Webapp screenshots provide visual checks.

The existing MIT license was checked byte-for-byte and preserved. This update uses only public SDK contributions, workspace APIs, and the existing RPC index; no Hermes or transcript-DOM changes are required. Production installation and catalog publication remain separate from this delivery.
