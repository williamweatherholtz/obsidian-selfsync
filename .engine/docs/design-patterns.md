# Design-pattern catalog (architecture-audit, D0029)

A **declared, downstream-overridable** vocabulary for the `CodeElement.pattern` tag (enum `DesignPattern` in
`.engine/schema/codeaudit/codeelement.sysml`). **Descriptive, not a compliance gate** — an element with **no
named pattern** is a valid, non-finding answer. High-correctness patterns are a *target* only for
High-criticality elements. The catalog is curated for a Rust + TypeScript, functional-leaning, control-heavy
system; GoF is included only where it recurs here. Downstream projects edit this list to their own stack.

## Tier 1 — high-correctness / type-driven (the priority tier)
These push invariants to **compile time / the parse boundary** — the lens that actually prevents this
codebase's defect classes. Target these for High-criticality elements.

| pattern | what it buys | exemplar here |
|---|---|---|
| `parseDontValidate` | validate once at the boundary into a type that *proves* the invariant thereafter | `validateChanges`/`validateFileMeta`; `safe_rel_path` |
| `makeIllegalStatesUnrepresentable` | the type system forbids the bad state; no runtime check needed | `decide()`'s `Presence`/`Action` domain |
| `typestate` | encode a state machine in types so illegal transitions don't compile | (target for the engine/connection state) |
| `newtype` | a distinct type for a distinct concept (no mixing up two `String`s) | (target where same-typed args transpose) |
| `raiiGuard` | acquire-in-ctor / release-on-Drop; can't forget cleanup | `ConnGuard`; the per-key open lock |
| `functionalCoreImperativeShell` | a pure, total decision core; effects at the edges | `decide()` (pure) + `reconcileOne` (shell) |
| `portsAndAdapters` | depend on an interface (port); swap the adapter | `VaultIo` / `SyncApi` ports |

## Tier 2 — concurrency
| pattern | what it buys | exemplar here |
|---|---|---|
| `serializedActor` | run-to-completion queue; one processor; no interleaving races | `SyncEngine.pump` |
| `boundedPool` | cap in-flight work; no unbounded fan-out | `mapPool`; `commit_slots` |
| `singleWriter` | one writer path; readers concurrent | `Vault` write lock; SQLite tx |

## Tier 3 — GoF subset (only the ones that recur here)
`state`, `strategy`, `observer`, `command`, `factory`, `adapter`, `facade`, `templateMethod`, `decorator`.
Use the tag when it genuinely describes the structure; do **not** reshape code to earn a GoF label.

## `none`
The element follows no named pattern and shouldn't be forced into one. **This is a normal, correct answer** —
most idiomatic Rust/TS functions are `none`. Recording `none` is not a finding.

## How the tag is used
- **Recording pass:** name the structure when a pattern genuinely applies; leave blank/`none` otherwise.
- **Improvement pass:** for a High-criticality element whose `invariantSafety` is `runtimeGuarded`/`unguarded`,
  a Tier-1 pattern is the *target* — but only adopt it when it closes a real defect class (never for the label).
- Patterns are a **shared vocabulary for reasoning**, not a score. Coupling + invariant-safety are the metrics.
