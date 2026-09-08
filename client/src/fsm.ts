// THE state-machine primitive (owner, 2026-09-08: "FSM module, used all across the project in places where states
// that can introduce hazards exist"). Every hazard-bearing state in the client — the sync engine phase, the link
// failure taxonomy, the WebSocket transport, each composed-vault mount, a conflict resolution — is a machine
// built here, and each machine is NAMED by the STPA process model it realizes (.tracking/safety/control-
// structure.sysml, `// STPA-FSM:` lines). The conformance test (fsm-conformance.test.ts) holds both directions:
// every machine defined here is registered against a controller's process model, and every registered module
// exists and is built on this primitive. That is what makes "a state that can introduce a hazard" a thing the
// safety analysis can SEE rather than a switch statement somewhere.
//
// Discipline (unchanged from connstate/mountfsm/transportstate, now enforced by shape):
//  - PURE: a transition is (state, event) -> state [+ effects as DATA]. No I/O, no clock, no Obsidian. The glue
//    executes effects; the machine never does.
//  - TOTAL and CONSERVATIVE: an event with no rule leaves the state unchanged (never throws, never invents a
//    state). `step` reports `changed` so a caller can tell a no-op from a self-transition.
//  - TERMINAL states are declared, not implied: from a terminal state only `reset`-style rules the machine
//    itself lists may leave.
//  - EXHAUSTIVELY TESTABLE: `tableCoverage` drives every (state kind, event kind) pair through the machine so a
//    test can assert the table is total and the terminal set is respected.

export interface MachineSpec<S, E, X = undefined> {
  /** The STPA process model / controller this machine realizes, e.g. "pmResolver" — matched by the conformance test. */
  name: string;
  /** Every state kind (the discriminant `kindOf` returns), for exhaustiveness. */
  states: readonly string[];
  /** Every event kind (`eventKindOf`), for exhaustiveness. */
  events: readonly string[];
  kindOf(s: S): string;
  eventKindOf(e: E): string;
  /** The rule table. Return the next state, or `{ state, effects }`, or `undefined` for "no rule: unchanged". */
  transition(s: S, e: E): S | { state: S; effects: X } | undefined;
  /** State kinds that only the listed `exits` (event kinds) may leave. */
  terminal?: { states: readonly string[]; exits: readonly string[] };
}

export interface Step<S, X> { state: S; effects: X | undefined; changed: boolean }

export interface Machine<S, E, X = undefined> {
  readonly spec: MachineSpec<S, E, X>;
  /** One transition with its effects (as data). Never throws on an unknown pair; `changed` is false for a no-rule event. */
  step(s: S, e: E): Step<S, X>;
  /** The next state only (effects dropped) — the common shape for a pure reducer. */
  next(s: S, e: E): S;
  isTerminal(s: S): boolean;
}

function isStepResult<S, X>(r: unknown): r is { state: S; effects: X } {
  return typeof r === "object" && r !== null && "state" in (r as object) && "effects" in (r as object);
}

export function defineMachine<S, E, X = undefined>(spec: MachineSpec<S, E, X>): Machine<S, E, X> {
  const terminal = new Set(spec.terminal?.states ?? []);
  const exits = new Set(spec.terminal?.exits ?? []);
  const step = (s: S, e: E): Step<S, X> => {
    const from = spec.kindOf(s);
    if (terminal.has(from) && !exits.has(spec.eventKindOf(e))) return { state: s, effects: undefined, changed: false };
    const r = spec.transition(s, e);
    if (r === undefined) return { state: s, effects: undefined, changed: false };
    if (isStepResult<S, X>(r)) return { state: r.state, effects: r.effects, changed: r.state !== s };
    return { state: r as S, effects: undefined, changed: (r as S) !== s };
  };
  return {
    spec,
    step,
    next: (s, e) => step(s, e).state,
    isTerminal: (s) => terminal.has(spec.kindOf(s)),
  };
}

/** For string-valued state/event machines (the common case): the kind IS the value. */
export const identity = <T extends string>(x: T): string => x;

/**
 * Test helper: drive every (state, event) pair once. Returns each pair's outcome so a test can assert the
 * table is TOTAL (nothing threw), which pairs are self-transitions, and that no terminal state was left by a
 * non-exit event. `samples` supplies one representative value per state kind / event kind.
 */
export function tableCoverage<S, E, X>(
  m: Machine<S, E, X>,
  samples: { states: readonly S[]; events: readonly E[] },
): { from: string; on: string; to: string; changed: boolean }[] {
  const out: { from: string; on: string; to: string; changed: boolean }[] = [];
  for (const s of samples.states) {
    for (const e of samples.events) {
      const r = m.step(s, e);
      out.push({ from: m.spec.kindOf(s), on: m.spec.eventKindOf(e), to: m.spec.kindOf(r.state), changed: r.changed });
    }
  }
  return out;
}
