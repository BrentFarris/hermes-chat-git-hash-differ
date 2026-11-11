# v0.1.0 validation

Validated on Windows on 2026-11-10 against installed Hermes **0.23.1**, source commit `3b421578588243f920886e6fe79a6faa87ea026e`. Test homes, session databases, repositories, browser profiles, and Desktop user-data directories were isolated from the normal Hermes installation.

| Check | Result |
|---|---|
| TypeScript strict typecheck | Pass |
| ESM frontend build, React/SDK external | Pass |
| Python detection / Git / service suite | 13 passed |
| Frontend/controller/keyboard suite | 9 passed |
| Real Hermes SessionDB history checks | Pass |
| Hermes plugin validation | All 16 checks passed; no warnings |
| Hermes plugin doctor | Passed import, discovery, manifest parsing and registration; 5 observer hooks, no model tools |
| Actual Webapp, installed Edge | Passed real 20-commit review journey |
| Actual packaged Hermes Desktop | Passed with a separate test home and remote gateway connection |

Python tests cover abbreviated/full duplicate references, URLs, terminal results and structured tool data, false candidates, SHA-1/SHA-256, ambiguity/missing objects, worktree identity, root/ordinary/merge comparisons, renames, deletions, Unicode/literal paths, binary files, submodule pointers, shallow parents, bounded output, disabled external diff helpers, repository ambiguity, profile/chat isolation, parent-specific reviews, asynchronous scans, and scan reuse/forced retry.

Real Hermes history fixtures verify raw terminal results, compression ancestor traversal, in-place compaction, rewinds removing obsolete references, explicit branch isolation, and delegated-session isolation. Frontend tests cover late responses, route lifetimes, gateway/profile storage separation, explicit review writes and failures, retained file/scroll navigation, keyboard movement across directory headers, automatic-opening/dismissal, and expanded-tab binding.

The live Webapp journey resolves 20 commits from the fixture repository, filters/selects a commit, reads its object diff, saves a review mark, expands the same selection, switches diff layouts/commits, expands context, disables automatic opening, opens another client without an automatic pane, and observes shared review changes. Desktop reads the Webapp's saved review through its remote gateway route and expands the same commit. Screenshots of the Webapp panel and expanded view were visually inspected.

The remote connection was a separate backend on localhost using the actual network transport and owner routing. An external SSH/remote machine was not available for deployment-specific validation. No hosted Git API was used. Browser automation initially needed fixture-selector and asynchronous-checkbox timing corrections; the final two live journeys passed. Screenshot capture of a hidden native Electron window was unreliable, so Desktop validation uses its actual rendered controls; Webapp screenshots provide visual checks.

The existing MIT license was checked byte-for-byte and preserved. Production installation, Git commits, and catalog publication are not part of this delivery.
