// =====================================================================
// D0003 — realign this project's .engine snapshot with the keel binary by importing the
// declarative-controls schema + ruleset the snapshot was missing, restoring the pre-commit
// gate. The keel binary (built from ../sysmlv2-ai-toolkit, at the D0105-D0107 declarative-
// controls era) loads six guard rules from a declared EngineRuleSet this snapshot (imported at
// the D0104 era) never received, so `keel guard` aborted on every commit. Accepted 2026-07-04
// by wweatherholtz (directed: "resolve the keel mismatch first ... the repo is at ../sysml-ai-toolkit").
// =====================================================================
package ProjectDecision0003 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;
    private import EngineRelationships::*;

    #ProspectiveChange part d0003 : Decision {
        :>> id = "d57534bf-e4eb-4d3b-b57c-ee22ffefc1bd";
        :>> title = "D0003: realign the engine snapshot with the keel binary (import declarative-controls schema + rules)";
        :>> createdAt = "2026-07-04";
        :>> createdBy = "wweatherholtz";
        :>> status = DecisionStatus::accepted;
        :>> context = "The keel binary on PATH is built from ../sysmlv2-ai-toolkit, which has since migrated its guard controls to a DECLARATIVE form (the D0105-D0107 declarative-controls migration: an EngineRules schema + an EngineRuleSet of declared Rule elements). This project's .engine was imported at the earlier D0104 era and never received that migration — it had no .engine/rules/ and no .engine/schema/core/rules.sysml. As a result `keel guard` aborted on EVERY commit with six 'declared rule not found' errors (acceptanceEventRule, charterRule, issuesTriagedRule, capabilityRootednessRule, decisionRationaleRule, confirmationAuthenticityRule) — those guards resolve their rule from the declared EngineRuleSet the snapshot lacked. The honesty gate was non-functional; commits since 0.5.0 used --no-verify as a flagged workaround. `keel validate` and the non-migrated guards were unaffected.";
        :>> decision = "Import the two missing canonical engine files verbatim from the toolkit — .engine/schema/core/rules.sysml (the EngineRules declarative-control schema) and .engine/rules/rules.sysml (the EngineRuleSet declaring the guard rules) — plus the read-only reference decisions 0105-0107 that justify them (rules.sysml carries #JustifiedBy edges to d0106/d0107). The `diff -rq` of .engine/schema against the toolkit was EXACTLY these files; no other engine or project file was changed. This realigns the snapshot forward to the binary's version rather than pinning an older binary. The declarative rules run via `keel check` alongside the existing Rust guards (additive; nothing retired).";
        :>> rationale = "ALTERNATIVES: (i) rebuild/pin an older keel matching the D0104 snapshot — REJECTED: freezes this project on a stale engine and diverges from the maintained toolkit that ships keel. (ii) keep committing with --no-verify indefinitely — REJECTED: it leaves the honesty gate dead, which CLAUDE.md forbids absent explicit cause. (iii) CHOSEN — import the two canonical files (+ their justifying reference decisions) to bring the snapshot to the binary's version: minimal (the schema delta was exactly these files), forward-aligned with the toolkit, and it RESTORES the gate. VERIFIED: keel validate clean; keel guard ALL PASS (15 guards, incl. the six previously-broken rules, decisions D0001-D0003 satisfying decision-rationale + confirmation-authenticity). CRITERIA: restore the gate x minimal delta x forward-aligned x honest provenance (the justifying decisions are present).";
        :>> consequences = "The pre-commit `keel guard` gate is functional again — future commits no longer need --no-verify (this Decision's own commit runs with the hook ENABLED to prove it). schema/core gains rules.sysml (the declarative-control schema — a frozen-schema addition made under the human's explicit directive, §2.5); a new .engine/rules/ holds the declared EngineRuleSet; reference decisions 0105-0107 are added read-only. The declarative controls are evaluated by `keel check` (file-scoped) and back the migrated guards. STILL out of sync: the kernel deep-validators (.engine/tools/validate/*.py) remain absent from this snapshot, so `keel` stays the sole available validator; a fuller engine sync (tools/, reference decisions 0108+) is deferred as unneeded for the gate.";
    }

    verification d0003Accept : Test {
        :>> id = "5d4ad5f8-c839-4f52-95ae-ab343c8fc60a";
        :>> method = VerificationMethod::confirmation;
        :>> procedureText = "wweatherholtz directed and accepted the realignment on 2026-07-04 via 'resolve the keel mismatch first ... I think the repo is at ../sysml-ai-toolkit' — authorizing the import of the toolkit's declarative-controls schema + ruleset (and justifying reference decisions) to restore the pre-commit gate.";
    }
    part d0003AcceptR1 : TestResult {
        :>> id = "8282a2cd-cdc0-4d3f-90bd-ae7827d7f4da";
        :>> outcome = VerdictKind::pass;
        :>> judgedAgainst = "3450df7";
        :>> judgedAt = "2026-07-04";
        :>> judgedBy = "wweatherholtz";
    }
}
