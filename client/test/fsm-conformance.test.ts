import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// The conformance guard for "FSM module, used all across the project in places where states that can introduce
// hazards exist" (owner, 2026-09-08; STPA process step 6). Two directions, both read from the MODEL:
//   1. Every machine registered on an STPA process model (`// STPA-FSM: <module>#<machine>` inside a ProcessModel
//      in .tracking/safety/control-structure.sysml) exists, is built on fsm.ts, and names that process model.
//   2. Every module in client/src that defines a machine is registered on some process model — an unregistered
//      machine is a hazard-bearing state the safety analysis cannot see.
//   3. A machine marked `// STPA-FSM-PENDING: <module> (<issue>)` exists and is NOT yet on the primitive — so
//      flipping it to the primitive forces the record to be updated in the same change.
const ROOT = path.resolve(__dirname, "..", "..");
const CONTROL_STRUCTURE = path.join(ROOT, ".tracking", "safety", "control-structure.sysml");
const SRC = path.join(ROOT, "client", "src");

const read = (p: string) => fs.readFileSync(p, "utf8");
const model = read(CONTROL_STRUCTURE);

/** (processModel, module, machine) triples from the `// STPA-FSM:` lines, attributed to the enclosing ProcessModel. */
function registered(): { pm: string; module: string; machine: string }[] {
  const out: { pm: string; module: string; machine: string }[] = [];
  let pm = "";
  for (const line of model.split("\n")) {
    const p = /part (\w+) : ProcessModel \{/.exec(line); if (p) pm = p[1];
    const m = /\/\/ STPA-FSM: (client\/src\/[\w./-]+\.ts)#(\w+)/.exec(line);
    if (m) out.push({ pm, module: m[1], machine: m[2] });
  }
  return out;
}
function pending(): { module: string; issue: string }[] {
  return [...model.matchAll(/\/\/ STPA-FSM-PENDING: (client\/src\/[\w./-]+\.ts) \((\w+)\)/g)].map((m) => ({ module: m[1], issue: m[2] }));
}
function machineModules(): string[] {
  return fs.readdirSync(SRC).filter((f) => f.endsWith(".ts") && f !== "fsm.ts")
    .filter((f) => /defineMachine</.test(read(path.join(SRC, f))))
    .map((f) => `client/src/${f}`);
}

describe("STPA ↔ fsm.ts conformance", () => {
  const reg = registered();

  it("the model registers at least the machines this sprint put on the primitive", () => {
    expect(reg.length).toBeGreaterThanOrEqual(4);
  });

  it("every registered machine exists, is built on fsm.ts, and names its process model", () => {
    for (const { pm, module, machine } of reg) {
      const file = path.join(ROOT, module);
      expect(fs.existsSync(file), `${module} (registered on ${pm}) exists`).toBe(true);
      const src = read(file);
      expect(src, `${module} imports ./fsm`).toMatch(/from "\.\/fsm"/);
      expect(src, `${module} exports ${machine} via defineMachine`).toMatch(new RegExp(`export const ${machine} = defineMachine`));
      expect(src, `${machine} in ${module} is named after its process model ${pm}`).toContain(`name: "${pm}"`);
    }
  });

  it("every module that defines a machine is registered on a process model (no invisible hazard-bearing state)", () => {
    const registeredModules = new Set(reg.map((r) => r.module));
    for (const mod of machineModules()) expect(registeredModules.has(mod), `${mod} is registered in control-structure.sysml`).toBe(true);
  });

  it("a PENDING machine exists and is not yet on the primitive (flipping it must update the record)", () => {
    for (const { module, issue } of pending()) {
      const file = path.join(ROOT, module);
      expect(fs.existsSync(file), `${module} (pending, ${issue}) exists`).toBe(true);
      expect(read(file), `${module} is still pending - once on fsm.ts, register it with STPA-FSM and close ${issue}`).not.toMatch(/defineMachine</);
    }
  });
});

// SR-36 (panel finding CV5, 2026-09-11): mountMachine is the ONLY lifecycle writer. Three direct `scope.state = "…"`
// assignments had crept in beside mountTransition() — states the machine had no edge into (localGone, diverged
// from mounting/offline), so the table the analysis reads was not the table the code ran. Every write must go
// through mountTransition(); this grep guards it.
describe("mount lifecycle: every state write goes through the machine (SR-36)", () => {
  it("no `.state = \"<literal>\"` assignment on a mount scope outside mountfsm.ts", () => {
    const offenders: string[] = [];
    for (const file of ["mountsync.ts", "main.ts", "mountengine.ts", "mountsettings.ts", "settings.ts"]) {
      const src = read(path.join(SRC, file)).split("\n");
      src.forEach((line, i) => { if (/\.state\s*=\s*"(detached|mounting|live|syncing|diverged|offline|unmounting|localGone|failed)"/.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`); });
    }
    expect(offenders).toEqual([]);
  });
});
