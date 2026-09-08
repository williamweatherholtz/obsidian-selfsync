#!/usr/bin/env python3
"""Resync .engine/ onto the keel 0.3.1 engine vintage and re-apply this project's own additions BY NAME (D0050).

`keel migrate .` brings the engine-shipped files to the binary's vintage, but it OVERWRITES engine-shipped
files this project had extended (relationships.sysml lost the D0045 markers; the shared skills registry
lost the eight project skills) and leaves the project-only processes in a shape the new schema rejects.
D0048 rolled the first attempt back for exactly that reason. This transform is the committed, idempotent
record of what has to happen ON TOP of the migrate so the result balances (D0067: expand/migrate/contract
with reconciled control totals; the ownership guard's only exemption for crossing engine-owned files is a
transform committed under this directory).

The route, in order:

  0. `keel migrate <root>`            - NOT run by this script (it is the engine's own, destructive step);
                                        run it first, by hand, then run this script.
  1. restore_project_owned()          - the four project-owned files migrate overwrites, from HEAD.
  2. readd_markers()                  - the D0045 marker declarations, appended only if absent. `Changes`
                                        is NOT re-added: 0 AST edges, 0 prose uses (retired, D0050).
                                        The D0139(B) `doc` justifications are hand-authored text and are
                                        left alone if present.
  3. move_project_skills()            - each project-only `part X : AISkill {...}` moved VERBATIM (same id)
                                        out of the shared registry into <skill>/registry.sysml (D0222);
                                        the shared registry then becomes the stock (empty) package.
  4. reshape_project_processes()      - `part` -> `action` usages, `:>> order` -> `first A then B;`
                                        successions (D0143), one `// APPLIES-WHEN:` per Process (D0225).
  5. hoist_covers_edges()             - `#Covers dependency` statements nested inside the delivery action
                                        def moved verbatim to package level, where the parser reads them
                                        (issueNestedCoversEdgesSkipped).
  6. report()                         - the control totals, to be reconciled against the decision record.

Idempotent: every step checks for its own result and does nothing when it is already in place, so a
second run reports the same totals and writes nothing. Dry-run by default; --apply writes.

Usage:
    python 2026-09-07-engine-vintage-resync.py [REPO_ROOT] [--apply] [--base-ref HEAD]
"""
from __future__ import annotations

import io
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))

# ---- what THIS project adds to the engine (the enumeration the totals are checked against) ----
PROJECT_OWNED_FILES = [
    ".engine/schema/codeaudit/codeelement.sysml",
    ".engine/contracts/reverify.toml",
    ".engine/deliverable-manifest.txt",
]
# The shared registry is restored too, but only as the SOURCE for the skill moves (step 3 replaces it).
SHARED_REGISTRY = ".engine/skills/skills-registry.sysml"

TRACEABILITY_MARKERS = ["Satisfies", "RealizedBy"]  # `Changes` retired: 0 edges, 0 prose uses (D0050)
STPA_MARKERS = ["Causes", "LeadsTo", "Inverts", "Enforces", "Senses", "Mitigates", "Analyzes", "Explains"]

PROJECT_PROCESSES = {
    "architecture-audit": "the deliverable is source code whose structure, coupling and invariants can be catalogued and ranked against Needs - there is a codebase to audit, not only a model",
    "code-critique": "the deliverable is source code in which runtime defects (data loss, security, concurrency, correctness) would matter, and independent critics can be run against it",
    "functional-decoupling": "a subsystem's functions have grown multi-responsibility and pure decision logic is entangled with side effects, so they are hard to test or reason about",
    "mutation-testing": "an automated test suite exists whose real fault-detection strength is unknown and worth measuring - coverage alone does not say what the suite would catch",
    "property-based-testing": "the code carries general invariants (contracts, round-trips, idempotence) that example tests cannot exhaust, and a property-testing engine is available",
    "release-versioning": "the deliverable is versioned and published to users (a plugin, package or binary), so each coherent change set must be cut, tagged and published as a release",
}

DELIVERY_FILE = ".tracking/delivery/delivery.sysml"
DELIVERY_ACTION_DEF = "SelfSyncDelivery"

# A file is "project-shaped" when it carries the sentinel this project put there; the migrate's stock
# copy never does. Step 1 restores ONLY files that are missing or not project-shaped, so a second run
# (or a later edit to one of them) is never clobbered back to the base ref.
PROJECT_SENTINELS = {
    ".engine/schema/codeaudit/codeelement.sysml": "CodeElement",
    ".engine/contracts/reverify.toml": "cd server && cargo test",
    ".engine/deliverable-manifest.txt": "task: deliverableTestGate",
}

AISKILL_BLOCK = re.compile(r"(    part (\w+) : AISkill \{.*?\n    \})", re.S)


def rd(p: str) -> str:
    return io.open(p, encoding="utf-8").read()


def git_show(root: str, ref: str, rel: str) -> str | None:
    r = subprocess.run(["git", "show", f"{ref}:{rel}"], cwd=root, capture_output=True, text=True, encoding="utf-8")
    return r.stdout if r.returncode == 0 else None


def project_skill_targets(root: str, base_ref: str) -> list[str]:
    """The per-skill registry paths the base ref's shared registry implies (where each project skill moves to)."""
    mono = git_show(root, base_ref, SHARED_REGISTRY) or ""
    out = []
    for m in AISKILL_BLOCK.finditer(mono):
        loc = re.search(r'location = "([^"]+)"', m.group(1))
        if loc:
            out.append(os.path.join(root, os.path.dirname(loc.group(1)), "registry.sysml"))
    return out


def wr(p: str, t: str, apply: bool) -> None:
    if apply:
        os.makedirs(os.path.dirname(p), exist_ok=True)
        io.open(p, "w", encoding="utf-8").write(t)


# ---------------------------------------------------------------------------------------------------
def restore_project_owned(root: str, base_ref: str, apply: bool) -> int:
    """Step 1: the project-owned files `keel migrate` overwrote, taken back from the base ref."""
    restored = 0
    for rel in PROJECT_OWNED_FILES:
        want = git_show(root, base_ref, rel)
        if want is None:
            continue  # not in the base ref - nothing this project owns there
        cur = os.path.join(root, rel)
        if os.path.exists(cur) and PROJECT_SENTINELS[rel] in rd(cur):
            continue  # already project-shaped (restored earlier, or since edited) - never clobber it
        wr(cur, want, apply)
        restored += 1
        print(f"  restore  {rel}")
    # The shared registry is restored only as the SOURCE for step 3: when some project skill still lacks its
    # per-skill registry, the monolith is needed to move it from; once every move is done it is left alone.
    if any(not os.path.exists(t) for t in project_skill_targets(root, base_ref)):
        want = git_show(root, base_ref, SHARED_REGISTRY)
        cur = os.path.join(root, SHARED_REGISTRY)
        if want is not None and (not os.path.exists(cur) or not AISKILL_BLOCK.search(rd(cur))):
            wr(cur, want, apply)
            restored += 1
            print(f"  restore  {SHARED_REGISTRY} (as the source for the skill moves)")
    return restored


def readd_markers(root: str, apply: bool) -> int:
    """Step 2: D0045 marker declarations, appended only where absent (bare form; docs are hand-authored)."""
    p = os.path.join(root, ".engine/schema/core/relationships.sysml")
    t = rd(p)
    present = set(re.findall(r"metadata def (\w+)", t))
    missing_tr = [m for m in TRACEABILITY_MARKERS if m not in present]
    missing_stpa = [m for m in STPA_MARKERS if m not in present]
    if not missing_tr and not missing_stpa:
        return 0
    block = "\n    // ---- PROJECT markers (project D0045, re-applied after the engine resync, D0050) ----\n"
    block += "    // Declared so the instance data's marker-form edges are TYPE-CHECKED (D0133). Each needs a\n"
    block += "    // D0139(B) `doc` justification - author it by hand; this script only restores the declaration.\n"
    for m in missing_tr + missing_stpa:
        block += f"    metadata def {m};\n"
        print(f"  marker   {m}")
    idx = t.rstrip().rfind("}")
    wr(p, t[:idx] + block + t[idx:], apply)
    return len(missing_tr) + len(missing_stpa)


def move_project_skills(root: str, apply: bool) -> int:
    """Step 3: project-only AISkill blocks moved verbatim (same id) beside their skill; registry -> stock."""
    p = os.path.join(root, SHARED_REGISTRY)
    mono = rd(p)
    if not AISKILL_BLOCK.search(mono):
        return 0  # already the stock shape: no registrations left in the shared file
    moved = 0
    for m in AISKILL_BLOCK.finditer(mono):
        block, name = m.group(1), m.group(2)
        loc = re.search(r'location = "([^"]+)"', block)
        if not loc:
            continue
        target = os.path.join(root, os.path.dirname(loc.group(1)), "registry.sysml")
        if os.path.exists(target):
            continue  # engine-shipped per-skill registry already exists (or already moved)
        pascal = re.sub(r"[^A-Za-z0-9]", "", name[:1].upper() + name[1:])
        body = (
            "// This skill's own registry declaration, beside the skill it describes (D0222).\n"
            "//\n"
            "// MOVED verbatim out of the shared skills-registry when this project resynced onto the engine\n"
            "// vintage that retired the shared registry: the id is unchanged, so `duplicate-identity` proves a\n"
            "// move rather than a copy. A project-authored skill (not shipped by the engine).\n"
            f"package SkillsRegistry{pascal} {{\n"
            "    private import EngineElement::*;\n"
            "    private import EngineSkills::*;\n\n"
            f"{block}\n"
            "}\n"
        )
        wr(target, body, apply)
        moved += 1
        print(f"  skill    {name} -> {os.path.relpath(target, root)}")
    # The shared file keeps its header and imports and loses every registration - the stock (D0222) shape.
    stripped = AISKILL_BLOCK.sub("", mono)
    stripped = re.sub(r"\n{3,}", "\n\n", stripped)
    wr(p, stripped, apply)
    return moved


def reshape_project_processes(root: str, base_ref: str, apply: bool) -> int:
    """Step 4: `action` usages, successions instead of `order`, an APPLIES-WHEN per Process."""
    changed = 0
    for name, cond in PROJECT_PROCESSES.items():
        p = os.path.join(root, f".engine/processes/{name}.sysml")
        t0 = t = rd(p)

        def ordered_steps(src: str) -> list[tuple[int, str]]:
            out = []
            for m in re.finditer(r"(?:part|action) (\w+) : ProcessStep \{(.*?)\n    \}", src, re.S):
                o = re.search(r":>> order = (\d+);", m.group(2))
                if o:
                    out.append((int(o.group(1)), m.group(1)))
            return sorted(out)

        steps = ordered_steps(t)
        if not steps and "\n    first " not in t:
            # `order` already stripped but no successions written (the first run of this transform tripped on
            # the word "first" in prose): recover the order from the base ref, where it is still recorded.
            steps = ordered_steps(git_show(root, base_ref, f".engine/processes/{name}.sysml") or "")
        t = re.sub(r"\n\s*:>> order = \d+;", "", t)
        t = re.sub(r"\bpart (\w+) : (Process|ProcessStep) \{", r"action \1 : \2 {", t)
        if "APPLIES-WHEN" not in t:
            t = re.sub(r"(:>> cadence = Cadence::\w+;)", r"\1\n        // APPLIES-WHEN: " + cond, t, count=1)
        if steps and "\n    first " not in t:
            chain = "\n    // step order, native succession (D0143 - was `order : Integer`; re-expressed after the engine resync)\n"
            for (_, a), (_, b) in zip(steps, steps[1:]):
                chain += f"    first {a} then {b};\n"
            idx = t.rstrip().rfind("}")
            t = t[:idx] + chain + t[idx:]
        if t != t0:
            wr(p, t, apply)
            changed += 1
            print(f"  process  {name}: {len(steps)} ordered steps -> {max(len(steps) - 1, 0)} successions")
    return changed


def hoist_covers_edges(root: str, apply: bool) -> int:
    """Step 5: nested `#Covers dependency` statements moved verbatim to package level (parser reads them there)."""
    p = os.path.join(root, DELIVERY_FILE)
    t = rd(p)
    kept, hoisted = [], []
    for ln in t.split("\n"):
        if re.match(r"^ {8}#Covers dependency from \w+ to \w+;\s*(//.*)?$", ln):
            hoisted.append(ln.strip())
        else:
            kept.append(ln)
    if not hoisted:
        return 0
    t = "\n".join(kept).rstrip()
    assert t.endswith("}")
    block = (
        "\n\n    // ---- #Covers edges (per-sitting review -> the sprint tasks it covers, D0049/issue040) ----\n"
        f"    // HOISTED to package level: these edges sat INSIDE `action def {DELIVERY_ACTION_DEF}`, and keel-parser\n"
        "    // records a `dependency` statement nested in an action body as SKIPPED (issueNestedCoversEdgesSkipped).\n"
        "    // Same edges, same order, nothing re-judged.\n"
    )
    t = t[:-1].rstrip() + "\n" + block + "".join("    " + h + "\n" for h in hoisted) + "}\n"
    wr(p, t, apply)
    print(f"  covers   {len(hoisted)} edges hoisted")
    return len(hoisted)


def report(root: str) -> dict:
    """Step 6: the control totals the decision record cites."""
    eng = os.path.join(root, ".engine")
    files = sum(len(fs) for _, _, fs in os.walk(eng))
    skills = 0
    for d, _, fs in os.walk(os.path.join(eng, "skills")):
        for f in fs:
            if f.endswith(".sysml"):
                skills += len(re.findall(r"part \w+ : AISkill", rd(os.path.join(d, f))))
    rel = rd(os.path.join(eng, "schema/core/relationships.sysml"))
    markers = len(re.findall(r"metadata def \w+", rel))
    with_doc = len(re.findall(r"metadata def \w+ \{ doc", rel))
    covers_nested = len(re.findall(r"^ {8}#Covers dependency", rd(os.path.join(root, DELIVERY_FILE)), re.M))
    covers_top = len(re.findall(r"^ {4}#Covers dependency", rd(os.path.join(root, DELIVERY_FILE)), re.M))
    orders = sum(len(re.findall(r":>> order = ", rd(os.path.join(eng, "processes", f"{n}.sysml")))) for n in PROJECT_PROCESSES)
    succ = sum(len(re.findall(r"^\s*first \w+ then \w+;", rd(os.path.join(eng, "processes", f"{n}.sysml")), re.M)) for n in PROJECT_PROCESSES)
    totals = {
        "engine_files": files,
        "aiskill_registrations": skills,
        "markers_declared": markers,
        "project_markers_with_doc": with_doc,
        "covers_edges_nested": covers_nested,
        "covers_edges_package_level": covers_top,
        "project_process_order_attrs": orders,
        "project_process_successions": succ,
    }
    for k, v in totals.items():
        print(f"  {k:32} {v}")
    return totals


def main(argv: list[str]) -> int:
    apply = "--apply" in argv
    base_ref = "HEAD"
    if "--base-ref" in argv:
        base_ref = argv[argv.index("--base-ref") + 1]
    roots = [a for a in argv[1:] if not a.startswith("--") and a != base_ref]
    root = os.path.abspath(roots[0]) if roots else DEFAULT_ROOT
    print(f"root={root}  mode={'APPLY' if apply else 'dry-run'}  base={base_ref}")
    print("[1] restore project-owned files");   n1 = restore_project_owned(root, base_ref, apply)
    print("[2] re-add D0045 markers");          n2 = readd_markers(root, apply)
    print("[3] move project skills (D0222)");   n3 = move_project_skills(root, apply)
    print("[4] reshape project processes");     n4 = reshape_project_processes(root, base_ref, apply)
    print("[5] hoist nested #Covers edges");    n5 = hoist_covers_edges(root, apply)
    print("[6] control totals");                report(root)
    print(f"edits: restore={n1} markers={n2} skills={n3} processes={n4} covers={n5}"
          + ("" if apply else "  (dry-run: nothing written)"))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
