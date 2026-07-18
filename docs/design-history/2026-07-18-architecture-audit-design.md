# Design spec — `architecture-audit`: a reusable, keel-backed code-architecture audit

Status: **proposed** (2026-07-18). Feeds Change Request **D0029**. Author: brainstormed with wweatherholtz.
Scope of this spec: the reusable FRAMEWORK (schema + metrics + catalog + process + keel views). Per-element
execution across the whole codebase is the follow-on ("focus on each element").

---

## 1. Purpose & the lens (reframed after critique)

Give the engine a **generic, reusable** capability to audit a deliverable's source architecture: catalogue
every authored code element, rank it by the risk it accepts (against Needs), record a structural + correctness
assessment, capture STPA control-structure inputs for a later analysis, and detect when an audited element has
since drifted — all as **authored facts + computed views** (never a code parser inside keel).

**The premise was stress-tested and the lens deliberately reframed.** "Design-pattern compliance, ranked by
criticality" is a *weak primary lens*: patterns are a means not an end (grading compliance invites cargo-culting);
this codebase's real defects (CRLF merge, false-absence delete, config-list disable, missing dir-fsync,
coalesce-stale size gate) were **invariant / edge-case / data-flow** bugs that a pattern audit would miss; and
architecture quality lives mostly in the **relationships** (coupling, dependency direction) not per-element
structure. Refactoring *toward* patterns (combine-to-match) is itself an anti-pattern.

**Adopted lens (primary → supporting):**
1. **Invariant-safety (primary, type-driven):** does the element *make illegal states unrepresentable* and
   *parse-don't-validate* its inputs — pushing invariants to compile time rather than runtime trust? This is
   where Rust/TS correctness lives and where our real bug classes were.
2. **Coupling / cohesion / dependency-direction (primary, structural):** computed from the authored dependency
   edges — afferent/efferent coupling, instability, distance-from-main-sequence, acyclicity.
3. **Design patterns (supporting, DESCRIPTIVE):** a rich vocabulary used *heavily* to describe and reason about
   structure in the audits — but an **optional tag**, never a compliance %. "No named pattern" is a fine,
   non-finding answer. High-correctness patterns are noted as *targets* for High-criticality elements only.
4. **STPA inputs (captured, not analyzed):** the raw control-structure inputs (role, actions, feedback) a later
   STPA process will consume; **no UCA/hazard/adequacy analysis in this process.**

**Combine/split is cautious by default:** restructure an element only when it *demonstrably lowers coupling or
closes a defect class* — never merely to match a pattern.

## 2. Where it lives (frozen-core-safe, two-models-safe)

- **New schema module** `.engine/schema/architecture.sysml` — imports `schema/core`, kept separate so core
  stays frozen. It is **generic** software-architecture vocabulary (CodeElement, riskClass, DesignPattern,
  stpaRole), not SelfSync-domain vocabulary, so it is legitimate reusable *engine* infrastructure (like Test /
  Issue / Decision). Adding it is a CHANGE → recorded as **D0029** with human sign-off.
- **Instances** authored in `.tracking/architecture/elements.sysml` (this project's data).
- Downstream projects get the schema via the engine; each authors its own element registry.

## 3. The `CodeElement` type

**Authored** (irreducible facts + recorded judgments):
| field | type | notes |
|---|---|---|
| `id` | UUID | immutable identity |
| `file` | string | repo-relative path |
| `name` | string | fn / class / enum / method name |
| `kind` | enum | Function, Method, Class, Struct, Enum, Trait, Module, TypeAlias |
| `codeHash` | string | the `audit_hash.py` `sha256:…` of the current implementation — the SAME hash D0028 stamps in-code (`// @audit-hash`), so the registry and the in-code markers unify |
| `auditRound` | int | which round last assessed it |
| `auditedAt` | ISO-8601 date | |
| `riskClass` | enum | the risk the element ACCEPTS: DataLoss, Security, Durability, Concurrency, Correctness, Availability, Cosmetic |
| `riskRationale` | string | why that risk class (judgment basis) |
| `invariantSafety` | enum | TypeEnforced (illegal states unrepresentable), Parsed (parse-don't-validate at the boundary), RuntimeGuarded (checked at runtime only), Unguarded (trust) |
| `invariantNotes` | string | which invariant, how enforced / where it could be tightened |
| `pattern` | string? | OPTIONAL descriptive tag from the DesignPattern catalog; blank = "no named pattern" (not a finding) |
| `stpaRole` | enum | Controller, Actuator, Sensor, ControlledProcess, None — a captured INPUT for later STPA |
| `actions` | string[] | control actions this element can issue (STPA input) |
| `restructure` | enum | KeepAsIs, Combine, Split, Decouple — a recommendation, default KeepAsIs |
| `restructureRationale` | string | required when ≠ KeepAsIs; must cite lowered coupling or a closed defect class |

**Typed edges (authored):**
- `#DerivedFrom` → Need / SystemRequirement — the Need-trace (criticality input + traceability).
- `#Verify` → Test — the element's covering tests.
- `#DependsOn` → CodeElement — call/data dependency (the coupling graph's edges).
- `#Controls` → CodeElement — a control action A exerts on B (STPA input).
- `#Feedback` → CodeElement — the return/status signal B gives A (STPA input).
- `#Restructure` → CodeElement — the combine/split/decouple target when `restructure` ≠ KeepAsIs.

**Computed (VIEWS — never authored, per invariant 2):**
- `criticality` — see §4.
- `afferentCoupling (Ca)` = count of elements that `#DependsOn` this one; `efferentCoupling (Ce)` = count this
  one `#DependsOn`; `instability I = Ce/(Ca+Ce)`; `distanceFromMainSequence` and acyclicity from the graph.
- `drift` — `codeHash` vs the live in-code `@audit-hash` (reuses `audit_hash.py`).

## 4. Criticality (computed, objective, Need-tied)

`riskClass` → base tier: **DataLoss/Security = High; Durability/Concurrency = Med-High; Correctness/Availability
= Med; Cosmetic = Low.** Bumped **one tier** when ≥1 *high-severity* Need `#DerivedFrom`-traces to the element
(blast radius). `riskClass` is an authored judgment (with `riskRationale`); the Need-trace and final ranking are
computed by keel. No numeric weights (honors D0088 anti-Goodhart). `keel arch criticality` renders the ranked
worklist = the audit frontier (High → Low).

## 5. Design-pattern catalog (`DesignPattern`, declared + downstream-overridable)

A curated ~20-entry catalog (a `.md` reference + a `DesignPattern` enum), tiered. **Descriptive only.**
- **High-correctness / type-driven (target tier for High-criticality):** ParseDontValidate,
  MakeIllegalStatesUnrepresentable, Typestate, Newtype, RaiiGuard, FunctionalCoreImperativeShell, PortsAndAdapters.
- **Concurrency:** SerializedActor (run-to-completion queue), BoundedPool, SingleWriter.
- **GoF subset that recurs here:** State, Strategy, Observer, Command, Factory, Adapter, Facade,
  TemplateMethod, Decorator.
- Plus `None` (idiomatic, no named pattern — a valid answer).

## 6. keel command surface (computed views; keel never parses source)

Declared viewpoints + a `keel arch` group (Rust in the `sysmlv2-ai-toolkit` repo — **follow-on build**):
- `keel arch elements [--kind K] [--file F]` — list the registry.
- `keel arch criticality` — the risk-class × Need-trace ranked worklist (the frontier).
- `keel arch coupling` — Ca / Ce / instability / distance-from-main-sequence + any dependency cycles.
- `keel arch drift` — `CodeElement.codeHash` vs live `@audit-hash` → the re-audit frontier (unifies with D0028).
- `keel arch stpa-inputs [--render]` — the captured control structure (roles, actions, `#Controls`/`#Feedback`)
  as the hand-off artifact for the later STPA process (renders the graph; performs NO analysis).
- `keel arch coverage` — non-blocking completeness nudge: a lightweight top-level-def enumeration flags
  authored elements not yet in the registry. Never a hard gate.

## 7. The process + skill (the 8 steps, reframed)

`.engine/processes/architecture-audit.sysml` + deploying skill `architecture-audit`:
1. **Enumerate** authored code elements file-by-file → author `CodeElement` facts (id, file, name, kind, codeHash).
2. (part of 1)
3. **Assign `riskClass` + `#DerivedFrom` Need edges** → keel computes criticality ranking.
4. Reference the declared **DesignPattern catalog** (§5) — no per-element pattern *gate*.
5. **Per element, High → Low:** confirm identity + codeHash; assess **invariant-safety** (primary) +
   **coupling** (via `#DependsOn` edges, keel derives Ca/Ce/I/D); add the optional descriptive `pattern` tag;
   capture **STPA inputs** (`stpaRole`, `actions`, `#Controls`/`#Feedback`); set `restructure` (default KeepAsIs).
6. **Decide restructurings** — only where the objective test holds (see §8); record `restructureRationale`.
7. **Combine/decouple code** as decided (implementation pass).
8. **Per-element correctness/pattern improvements** (the invariant-tightening pass).
keel provides the views + drift; the skill drives the authoring.

## 8. Restructure / exception criteria (objective; caution is the default)

Default is **KeepAsIs**. A `Combine`/`Split`/`Decouple` is justified only when it satisfies the objective test:
it **lowers coupling** (net cross-element edges removed > added, via the `#DependsOn` graph) **or closes a defect
class** (names the invariant/bug it prevents). An element is **exempt from any change** when: (a) criticality =
Low and invariant-safety ∈ {TypeEnforced, Parsed}; or (b) the restructure would *raise* coupling; or (c) it would
protect no invariant the element actually has (cargo-cult test). Each decision records which criterion applied.

## 9. Drift & the D0028 tie-in

`CodeElement.codeHash` is exactly the `audit_hash.py` value already stamped in-code by D0028. `keel arch drift`
recomputes the live hash per element and flags mismatches → the element re-enters the criticality frontier.
This makes the registry self-maintaining: change a function, its registry row goes stale until re-audited.

## 10. Scope

- **This session (framework, recorded):** the schema module + `DesignPattern` catalog + criticality definition
  + the process + skill + Decision D0029 + doc-sync; **seed** `.tracking/architecture/elements.sysml` with the
  ~40 elements already audited in rounds 1–2 (they carry `@audit-hash`es) to prove the model end-to-end.
- **Follow-on (planned, later sessions):** the keel `arch` Rust commands in `sysmlv2-ai-toolkit`; then the full
  file-by-file per-element audit; then (separately) the STPA analysis process consuming the captured inputs.

## 11. Risks / open points

- The registry can go stale vs. the code — mitigated by `arch drift` + `arch coverage`, but neither is a hard
  gate (by design; honest non-blocking burndown per D0098).
- Coupling metrics are only as good as the authored `#DependsOn` edges — the recording pass must be disciplined
  about capturing real dependencies (a future keel-assisted seed could help; deferred).
- `riskClass` and `invariantSafety` are judgments — recorded with rationale so they're reviewable, not oracles.

## 12. Implementation plan (follow-on, post-framework)

The framework (schema + catalog + criticality def + process + skill + Decision D0029 + a 6-element proof seed)
is built this session. The remainder, in order:

**Phase 1 — keel `arch` views (Rust, in `sysmlv2-ai-toolkit`):** teach keel to read `EngineCodeAudit` instances
and compute: `arch elements`, `arch criticality` (risk-tier × Need-trace bump), `arch coupling` (Ca/Ce/
instability/distance + cycles from the `#DependsOn` graph), `arch drift` (reuse `audit_hash.py`: each
`CodeElement.codeHash` vs the live in-code `@audit-hash`), `arch stpa-inputs [--render]` (the control-structure
hand-off), `arch coverage` (heuristic top-level-def enumeration → un-catalogued elements, non-blocking). Register
each as a declared viewpoint. Ship with a coverage-floored test per command.

**Phase 2 — full per-element registry:** run the `architecture-audit` process file-by-file over `client/src`
+ `server/src`, authoring a `CodeElement` for every separable element (the ~40 already-audited ones extend the
seed; the rest are new). `arch criticality` orders the work High → Low.

**Phase 3 — restructure + invariant-tightening passes:** steps 6–8 — apply only the restructurings that pass the
objective test, then tighten `runtimeGuarded`/`unguarded` High-criticality elements toward `typeEnforced`/`parsed`.

**Phase 4 — the STPA analysis process (separate):** a new process consumes the captured `stpaRole`/`actions`/
`#Controls`/`#Feedback` inputs (+ the existing `.tracking/safety/control-structure.sysml`) to build the control
diagram + UCAs for the debugging work — out of scope here, enabled by the inputs this capability records.

Until Phase 1 ships, the views are computed by hand / `audit_hash.py verify` (drift) — the model is usable now,
just not yet ergonomic.
