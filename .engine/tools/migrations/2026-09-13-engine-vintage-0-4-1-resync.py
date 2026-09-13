#!/usr/bin/env python3
"""Engine vintage resync 0.3.1 -> keel 0.4.1 (project D0057; D0067 migration; the D0050 pattern reapplied).

`keel migrate .` (0.4.1) verifies the migrated tree with the project's own gate and REVERTS atomically when it fails.
On this tree it fails every time, for one reason: the migrate overwrites `.engine/schema/codeaudit/codeelement.sysml`
with the stock copy, and this project's `.tracking/architecture/elements.sysml` uses the enum members the project added
there (RiskClass::concurrency, DesignPattern::serializedActor, ...) - 567 semantic diagnostics, then the rollback. The
2026-09-07 transform's sentinel for that file ("CodeElement") also matches the STOCK copy, so its step 1 did not
restore it. This script is the recorded, repeatable sequence that lands the vintage and balances:

  0. `keel migrate --no-verify .`                        - the engine's own step, WITHOUT the auto-revert (the tree is
                                                            then written and UNVERIFIED, as 0.4.1 says; steps 1-5 verify it)
  1. restore the project-owned files the migrate overwrote, from the base ref:
       .engine/schema/codeaudit/codeelement.sysml         (project enum members; sentinel now `serializedActor`)
       .engine/contracts/activation.toml                  (this project's process set; charteredBy re-pointed to d0057
                                                           because 0.4.1's activation-manifest guard requires a PROJECT
                                                           decision, and the stock file cites the engine's d0226)
  2. re-run the 2026-09-07 transform (idempotent): project markers re-added to relationships.sysml, skills/processes
     reshaped, #Covers edges hoisted
  3. the pre-commit hook and CLAUDE.md move to the 0.4.1 gating family: `keel validate .` -> `keel gate validate .`,
     `keel guard` -> `keel gate guard` (D0452: validate/check/check-engine/guard/rules/assured under `keel gate`)
  4. `keel sync-claude .` regenerates the Claude surface stamped by this binary
  5. control totals, then the caller runs `keel gate validate . && keel gate guard . && keel gate check-engine .`

Usage:  python .engine/tools/migrations/2026-09-13-engine-vintage-0-4-1-resync.py [--apply] [--base-ref REF] [ROOT]
Dry-run by default: prints what each step WOULD do. Co-committed with the migration commit so the D0067/D0108
ownership suspension is visible (`ownership` announces it as a warning) rather than claimed.
"""
import io, os, re, subprocess, sys

PROJECT_OWNED = {
    ".engine/schema/codeaudit/codeelement.sysml": "serializedActor",   # a member only the project's copy declares
    ".engine/contracts/activation.toml": "Process activation (D0138)",
}
HOOK = ".githooks/pre-commit"
CLAUDE_MD = "CLAUDE.md"
RENAMES = [("keel validate .", "keel gate validate ."), ("keel guard <name>", "keel gate guard <name>"),
           ("`keel guard`", "`keel gate guard`"), ("keel guard`", "keel gate guard`"), ("keel guard ", "keel gate guard "),
           ("keel check-engine .", "keel gate check-engine ."), ("keel validate` ", "keel gate validate` ")]


def rd(p): return io.open(p, encoding="utf-8", newline="").read()
def wr(p, t, apply):
    if apply: io.open(p, "w", encoding="utf-8", newline="").write(t)
def git_show(root, ref, rel):
    r = subprocess.run(["git", "show", f"{ref}:{rel}"], cwd=root, capture_output=True, text=True, encoding="utf-8")
    return r.stdout if r.returncode == 0 else None


def main(argv):
    apply = "--apply" in argv
    base = argv[argv.index("--base-ref") + 1] if "--base-ref" in argv else "HEAD"
    roots = [a for a in argv[1:] if not a.startswith("--") and a != base]
    root = os.path.abspath(roots[0] if roots else ".")
    print(f"root={root} mode={'APPLY' if apply else 'dry-run'} base={base}")
    # 0
    print("[0] keel migrate --no-verify .", "(run)" if apply else "(would run)")
    if apply: subprocess.run(["keel", "migrate", "--no-verify", "."], cwd=root, check=False)
    # 1
    restored = 0
    for rel, sentinel in PROJECT_OWNED.items():
        p = os.path.join(root, rel)
        cur = rd(p) if os.path.exists(p) else ""
        if sentinel not in cur:
            src = git_show(root, base, rel); assert src, rel
            if rel.endswith("activation.toml"): src = re.sub(r'^charteredBy = "d\d+"', 'charteredBy = "d0057"', src, flags=re.M)
            wr(p, src, apply); restored += 1; print(f"[1] restore {rel}")
    # 2
    t = subprocess.run([sys.executable, os.path.join(root, ".engine/tools/migrations/2026-09-07-engine-vintage-resync.py"),
                        *(["--apply"] if apply else []), "--base-ref", base, root], capture_output=True, text=True)
    print("[2]", (t.stdout.strip().splitlines() or [""])[-1])
    # 3
    hook = rd(os.path.join(root, HOOK)); h2 = hook
    for old, new in [("\"$KEEL\" validate .", "\"$KEEL\" gate validate ."), ("\"$KEEL\" guard", "\"$KEEL\" gate guard"),
                     ("pre-commit: keel validate", "pre-commit: keel gate validate"), ("pre-commit: keel guard", "pre-commit: keel gate guard")]:
        h2 = h2.replace(old, new)
    if h2 != hook: wr(os.path.join(root, HOOK), h2, apply); print("[3] hook -> gate family")
    cm = rd(os.path.join(root, CLAUDE_MD)); c2 = cm
    for old, new in RENAMES: c2 = c2.replace(old, new)
    c2 = c2.replace("keel gate gate", "keel gate")
    if c2 != cm: wr(os.path.join(root, CLAUDE_MD), c2, apply); print(f"[3] CLAUDE.md -> gate family ({cm.count('keel validate') + cm.count('keel guard')} mentions)")
    # 4
    print("[4] keel sync-claude .", "(run)" if apply else "(would run)")
    if apply: subprocess.run(["keel", "sync-claude", "."], cwd=root, check=False)
    # 5
    rel = rd(os.path.join(root, ".engine/schema/core/relationships.sysml"))
    print("[5] totals:", f"markers_declared={rel.count('metadata def')}", f"restored={restored}",
          f"engine_files={sum(len(f) for _, _, f in os.walk(os.path.join(root, '.engine')))}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
