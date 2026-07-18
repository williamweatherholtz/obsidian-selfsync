// ProjectActors — this project's actor registry (INSTANCE data).
// The declared part name is the id that createdBy/judgedBy reference (enforced by `keel guard actors`).
package ProjectActors {
    private import EngineElement::*;

    part wweatherholtz : Person { :>> name = "William Weatherholtz"; :>> email = "0612@asirobots.com"; }
    part ai : Actor { :>> name = "AI assistant"; :>> kind = ActorKind::ai; }
    // The specific AI coding agent for this project's sessions (Claude Opus). Distinct from the generic
    // `ai` actor so attribution is precise; `keel reverify` stamps its gate re-verifications as this actor.
    part claudeOpus : Actor { :>> name = "Claude Opus (AI coding agent)"; :>> kind = ActorKind::ai; }
}
