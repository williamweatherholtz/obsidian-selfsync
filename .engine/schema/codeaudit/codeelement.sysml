// =====================================================================
// EngineCodeAudit — the programmatic architecture-audit element type (D0029).
// OPTIONAL MODULE (like EngineSafety): import only for projects auditing their
// own deliverable source. Generic software-architecture vocabulary (CodeElement,
// RiskClass, DesignPattern, StpaRole) — NOT any deliverable's domain vocabulary —
// so it is reusable engine infrastructure, and it keeps schema/core frozen.
//
// LENS (design spec 2026-07-18, reframed after critique): the PRIMARY assessment is
// invariant-safety (make-illegal-states-unrepresentable / parse-don't-validate) +
// coupling/dependency-direction; DESIGN PATTERNS are a DESCRIPTIVE tag (never a
// compliance gate); STPA fields are captured INPUTS for a later STPA process (no
// analysis here). criticality, coupling metrics (Ca/Ce/instability/distance-from-
// main-sequence) and drift are COMPUTED VIEWS (keel arch ...), never authored.
// codeHash is the SAME audit_hash.py value D0028 stamps in-code (`// @audit-hash`).
// =====================================================================
package EngineCodeAudit {
    doc /* Programmatic architecture-audit element type (D0029): an authored CodeElement registry (identity + codeHash + risk-class + invariant-safety + descriptive design-pattern tag + captured STPA inputs + restructure recommendation). Criticality, coupling metrics and drift are computed views. Optional module; keeps schema/core frozen. */

    private import ScalarValues::*;
    private import EngineElement::*;

    // ---- vocabulary (closed enums) ----------------------------------
    enum def CodeElementKind { function; method; class; struct; enumeration; trait; module; typeAlias; }
    // The risk an element ACCEPTS — the base tier of criticality (bumped by Need-trace; keel computes).
    enum def RiskClass { dataLoss; security; durability; concurrency; correctness; availability; cosmetic; }
    // The PRIMARY lens: how the element enforces its invariants (compile-time > boundary-parse > runtime > trust).
    enum def InvariantSafety { typeEnforced; parsed; runtimeGuarded; unguarded; }
    // STPA INPUT (captured, not analyzed): channel = a pruned pure function (decide/chunker/merge3), NOT a controller.
    enum def StpaRole { controller; controlledProcess; sensor; actuator; channel; none; }
    enum def RestructureAction { keepAsIs; combine; split; decouple; }
    // DESCRIPTIVE design-pattern catalog — an optional TAG (absent = no named pattern, a valid non-finding).
    // Three tiers: high-correctness/type-driven (target for High-criticality), concurrency, GoF subset.
    enum def DesignPattern {
        parseDontValidate; makeIllegalStatesUnrepresentable; typestate; newtype; raiiGuard; functionalCoreImperativeShell; portsAndAdapters;
        serializedActor; boundedPool; singleWriter;
        state; strategy; observer; command; factory; adapter; facade; templateMethod; decorator;
        // D0032 (crit R+1): two shapes the mislabel-retags needed and no existing member honestly fit —
        // a content-addressed immutable store (safe by hashing+immutability, NOT single-writer) and an
        // error-isolation loop over a bounded pool (the bound is delegated; the element IS the isolation).
        contentAddressedImmutable; errorIsolationLoop;
        none;
    }

    // ---- the tracked code element -----------------------------------
    part def CodeElement :> Element {
        attribute file : String;                            // repo-relative path
        attribute name : String;                            // fn / class / enum name
        attribute kind : CodeElementKind;
        attribute codeHash : String;                        // audit_hash.py sha256:... — unifies with the D0028 // @audit-hash marker
        attribute auditRound : String[0..1];                // e.g. "r1" / "r2"
        attribute auditedAt : Timestamp[0..1];
        attribute riskClass : RiskClass;                    // authored judgment (the risk it accepts)
        attribute riskRationale : String[0..1];             // why that class
        attribute invariantSafety : InvariantSafety[0..1];  // PRIMARY lens (authored assessment)
        attribute invariantNotes : String[0..1];            // which invariant, how enforced / where to tighten
        attribute pattern : DesignPattern[0..1];            // OPTIONAL descriptive tag (absent = no named pattern)
        attribute stpaRole : StpaRole[0..1];                // captured STPA input (analysis deferred)
        attribute actions : String[0..1];                   // control actions this element can issue (STPA input) — comma-separated list
        attribute restructure : RestructureAction[0..1];    // recommendation; default keepAsIs
        attribute restructureRationale : String[0..1];      // REQUIRED when restructure != keepAsIs (cite lowered coupling or a closed defect class)
    }

    // ---- edges (authored) -------------------------------------------
    // #Controls: this element issues a control action to the target CodeElement (STPA input, direction = down).
    metadata def Controls;
    // #Feedback: this element returns status/feedback to the target CodeElement (STPA input, direction = up).
    metadata def Feedback;
    // #Restructure: the combine/split/decouple target when restructure != keepAsIs.
    metadata def Restructure;
    // Need-trace (criticality input) and the coupling graph reuse EngineRelationships::DependsOn:
    //   #DependsOn from <codeElement> to <Need/SystemRequirement>   -- the Need-trace (bumps criticality)
    //   #DependsOn from <codeElement> to <codeElement>              -- the coupling edge (keel derives Ca/Ce/I/D)
}
