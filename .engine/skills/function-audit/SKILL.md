---
name: function-audit
description: |
  Line-by-line SOURCE-CODE audit of the most critical programmatic functions
  (idiom / design patterns / concision — never terseness), leaving an in-code
  provenance trail: an `// @audit` finding comment on every audited function and
  an `// @audit-hash` code-hash stamp on every function actually fixed, so a later
  pass can detect drift and re-audit only what changed. Distinct from
  element-critique (which critiques tracked model ELEMENTS) and
  architectural-critique (the engine's architecture). Use when asked to "audit the
  top-N functions", "critique the next N functions", or "review these functions
  line by line".
metadata:
  version: 0.1.0
  domain: [audit, code-quality, idiom, design-patterns, concision, drift, provenance]
  writePolicy: direct
  engine: keel-ai-toolkit
---

# function-audit

Audit the most-critical **programmatic functions** (literal functions with args) line by line for
**idiomatic coding, design patterns, and concision (NOT terseness)** — and leave a durable in-code
trail so audits compound instead of repeating. (Encodes a standard, like test-authoring; no separate
process file.)

## Why the in-code markers

A pure prose critique evaporates. Two markers make the audit a first-class, drift-aware artifact —
the per-function analogue of the engine's file-level `suspect` (verifiedAtCommit) mechanism:

- **`// @audit`** — what was found, on every function we look at (so the next auditor sees it).
- **`// @audit-hash`** — the exact implementation we blessed, on every function we *fixed* (so the
  next auditor knows whether it still holds). Recorded by the reproducible hash of
  `.engine/tools/audit_hash.py`; if the code later changes, the hash won't match → re-audit.

## Procedure

1. **Scope.** Pick the target set — "top N" or "the next N not yet audited". A function is already
   audited iff it carries an `// @audit` marker; run `python .engine/tools/audit_hash.py verify` first
   to list any `@audit-hash` functions that have **DRIFTED** (changed since blessed) — those re-enter scope.
   Rank by criticality: data-safety / durability / security / concurrency / correctness first.
2. **Audit line by line.** For breadth, dispatch independent critics (one per cluster of functions),
   each auditing on the three axes; or audit directly for a small set. Note exemplary code too.
   The dense WHY-comments in this codebase are an ASSET — critique the CODE, not comment density.
3. **VERIFY before believing.** Never relay a critic's correctness/defect claim without checking it
   against the actual code (read the function + callers). Downgrade/upgrade severity to what you can prove.
4. **Mark every audited function.** Immediately above the signature:
   ```
   // @audit r<N> <YYYY-MM-DD> — <finding, or "clean: idiom/design/concision OK">
   ```
   (`r<N>` = the audit round. One line; keep the finding terse.)
5. **Fix what's worth fixing** (behavior-preserving refactors + real defects), each green against the
   test suite. For **every function whose code you changed**, add — directly below its `// @audit` line:
   ```
   // @audit-hash sha256:<16hex>   (code @ fix; drift check: .engine/tools/audit_hash.py)
   ```
   Compute the hash AFTER the edit is final:
   `python .engine/tools/audit_hash.py compute <file> <signature-line>` → paste the `sha256:...`.
   (A function audited-but-not-changed gets the `// @audit` comment only — no hash.)
6. **Record + gate.** A ≥Medium finding becomes a tracked `Issue` (D0077) resolved by a fix action;
   apply the repo's discipline (RECORD/EXECUTE, fail-first regression per D0026/D0047, commit green).
   Behavior-preserving cleanups ride a delivery action with a `method=test` DoD.
7. **Verify the trail.** `python .engine/tools/audit_hash.py verify` must end clean (0 drifted, 0 stale)
   before you consider the pass done — a stale marker means a hash points at no resolvable function.

## Marker rules
- Markers sit **above** the function signature; the hash covers signature → matching body-close, so the
  markers never affect their own hash. CRLF/trailing-whitespace are normalized (stable cross-platform).
- The hash is a DRIFT SIGNAL, not a security control — brace matching is naive-but-deterministic
  (unchanged code → same hash; a pathological case only ever triggers a harmless re-audit).
- Never hand-edit a hash. Recompute it with the tool.

## Not this skill
- Critiquing a tracked Need/SystemRequirement/Decision (model element) → **element-critique** (D0080).
- Auditing the engine's own architecture/processes → **architectural-critique** (D0046).
- Writing the fix's regression test → **test-authoring**.
