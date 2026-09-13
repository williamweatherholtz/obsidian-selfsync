---
name: architecture-audit
description: |
  Audit a deliverable's source ARCHITECTURE (D0029): catalogue authored code
  elements as a tracked CodeElement registry, rank by the risk each accepts
  (against Needs), assess invariant-safety + coupling (PRIMARY lens), tag design
  patterns descriptively (never a compliance gate), capture STPA control-structure
  INPUTS for a later STPA process (no analysis here), and detect drift via the
  D0028 // @audit-hash. Deploys .engine/processes/architecture-audit.sysml. Distinct
  from function-audit (line-by-line code quality of individual functions),
  element-critique (tracked MODEL elements), and architectural-critique (the ENGINE's
  own architecture). Use when asked to "audit the architecture", "catalogue the code
  elements", "rank by criticality", or to work the `keel arch` frontier.
metadata:
  version: 0.1.0
  domain: [audit, architecture, code-elements, criticality, coupling, invariant-safety, stpa-inputs, drift]
  writePolicy: direct
  engine: keel-ai-toolkit
---

# architecture-audit

Deploys `.engine/processes/architecture-audit.sysml`. Builds + maintains the authored **CodeElement
registry** (`.tracking/architecture/`) and drives the per-element audit. All authored facts + keel-computed
views — keel never parses source.

## The lens (do NOT re-litigate; decided in D0029 after critique)
- **PRIMARY — invariant-safety:** does the element make illegal states unrepresentable / parse-don't-validate
  its inputs (push invariants to compile time)? This is where correctness lives and where this codebase's real
  defects were. Record `invariantSafety` + `invariantNotes`.
- **PRIMARY — coupling / dependency-direction:** author the `#DependsOn` edges (element→element); keel derives
  Ca/Ce/instability/distance-from-main-sequence + cycles. Structure lives in the relationships.
- **SUPPORTING — design patterns:** an OPTIONAL descriptive `pattern` tag from the catalog
  (`.engine/docs/design-patterns.md`). Blank = "no named pattern" — a valid, non-finding answer. NEVER grade
  compliance. High-correctness patterns are a *target* only for High-criticality elements.
- **CAPTURED, not analyzed — STPA inputs:** `stpaRole` (controller/controlledProcess/sensor/actuator/channel/
  none — `channel` = a pruned pure function like decide/chunker/merge3), `actions`, `#Controls`/`#Feedback`
  edges. The later STPA process consumes these; do NO UCA/hazard analysis here.

## Steps (the process, condensed)
1. **Enumerate** (file-by-file): author a `CodeElement` per separable element (id, file, name, kind, codeHash
   via `python .engine/tools/audit_hash.py compute <file> <line>`).
2. **Risk + Need-trace:** author `riskClass` (+ rationale) and `#DependsOn`→Need/SR edges.
3. **Rank:** `keel arch criticality` → audit High→Low.
4. **Assess** each: invariantSafety + coupling edges + optional pattern tag + STPA inputs; leave the in-code
   `// @audit` + `// @audit-hash` marker (D0028) so `codeHash` stays honest.
5. **Decide restructurings** — default `keepAsIs`; `combine`/`split`/`decouple` ONLY when it demonstrably
   lowers coupling or closes a defect class (record `restructureRationale`; exemption criteria in the process).
6. **Combine/split/decouple** the accepted ones, behavior-preserving + green.
7. **Tighten invariants** (runtimeGuarded/unguarded → typeEnforced/parsed where feasible); ≥Medium defects → Issues.
8. **Drift:** `keel arch drift` keeps the registry honest against the in-code hashes.

## keel views (follow-on Rust build in sysmlv2-ai-toolkit; until then compute by hand / audit_hash.py)
`keel arch elements | criticality | coupling | drift | stpa-inputs | coverage`. `drift` reuses `audit_hash.py`.

## Rules
- criticality, Ca/Ce/instability/distance, drift are COMPUTED — never author them.
- `codeHash` IS the D0028 `@audit-hash` value — keep them equal; recompute (never hand-edit) on any change.
- Restructuring toward a pattern for its own sake is forbidden (the critique that reframed this — see D0029).

## Not this skill
- Line-by-line quality of one function → **function-audit** (D0028).
- Critiquing a tracked Need/Requirement/Decision → **element-critique** (D0080).
- The ENGINE's own architecture/processes → **architectural-critique** (D0046).
- STPA hazard/UCA analysis → the (later) STPA process; this skill only CAPTURES its inputs.
