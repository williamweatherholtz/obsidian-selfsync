# Backlog — deferred product requirements

> Tracked future work surfaced during use. Each item names its target milestone (the process that will handle it) and the desired behavior, so nothing is lost. Convert to formal engine `Issue` items when the `keel` tooling is in the loop. Newest first.

## B3 — Intelligent reconciliation of pre-existing / untracked content on connect
**Raised:** 2026-07-03 (from live use of M1). **Target:** M3 (conflict/reconciliation).
**Problem:** When a vault with pre-existing content connects, the plugin doesn't handle that content intelligently. M1's initial reconcile is a blunt pull-then-push: a *local-only* file uploads, but a file present on **both sides with different content is clobbered by the server's copy**, and untracked content can appear "ignored." No merge, no conflict-copy, no "keep both."
**Desired behavior (never silently ignore or lose content):**
- Local-only file → **upload** it.
- Server-only file → **download** it.
- Same path, identical content → no-op.
- Same path, **divergent** content → **do not clobber**: for Markdown, three-way merge (M3 engine); for anything unmergeable/binary, write a **conflict copy** (`name (conflict <device> <ts>).ext`) and keep both. Surface the conflict to the user.
- On first connect of an existing vault, treat it as a reconcile of two populated sides, not a one-way overwrite.
**Note:** verify the local-only-upload path with a dedicated headless E2E scenario when M3 starts (distinguish a real bug from the divergent-content case).

## B2 — Vault selection / creation UI + multiple vaults per account
**Raised:** 2026-07-03. **Target:** M4 (multi-tenant) + onboarding UI.
**Problem:** The plugin hardwires a single server-side vault; there's no way to pick which server vault an Obsidian vault syncs to, or to create a new one.
**Desired behavior:** one account → many vaults; in the plugin, choose an existing server vault to sync the current Obsidian vault to, or create a new server vault; server enforces per-account vault isolation. Layout `/<data-root>/<user>/<vault>/…` (already in the design).

## B1 — Login / account creation UI (real onboarding)
**Raised:** 2026-07-03. **Target:** M4 (multi-tenant) + onboarding UI.
**Problem:** The server has a single fixed `admin/admin` from config; there's no way to create users, and login is just URL/username/password fields + a Connect button — not a clear onboarding flow.
**Desired behavior:** server accounts with registration/creation (an admin/registration endpoint or CLI), and a plugin onboarding UI that logs in and (where allowed) creates an account. Clear connection state (the status-bar indicator + sync log added in M1 are the start).

---
*(These are the reason the milestone order is: M2 perf → **M3 reconciliation/conflict** → **M4 accounts/multi-vault + onboarding UI**. The full config-UX overhaul remains the deferred goal #1 at the end.)*
