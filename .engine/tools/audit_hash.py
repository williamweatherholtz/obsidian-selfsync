#!/usr/bin/env python3
"""audit_hash.py — reproducible per-function code hashes for the function-audit methodology (D-audit-markers).

A line-by-line function audit leaves an in-code marker above each audited function:

    // @audit r2 2026-07-18 — <finding, or "clean">
    // @audit-hash sha256:<16hex>          <-- only when a fix was applied to that function

The hash pins the EXACT implementation that was audited/fixed, so a later audit can tell — cheaply,
without re-reading everything — whether a function has changed since it was last audited (drift → re-audit).
It is the per-function analogue of the engine's file-level `suspect` mechanism (verifiedAtCommit), embedded
in the code so the provenance travels with the function.

The hash is over the function's SOURCE (signature line through the matching close of its first `{` body),
normalized so it is stable across platforms and comment reflow:
  - CRLF/CR -> LF
  - trailing whitespace stripped per line
  - the `@audit` / `@audit-hash` marker comment lines are ABOVE the signature, so they are naturally
    excluded from the range and never affect their own hash.
Brace matching is naive (counts `{`/`}`); it is DETERMINISTIC, which is all drift detection needs — a
pathological brace-in-a-string only ever causes a harmless re-audit, never a false "unchanged".

Usage:
  compute <file> <signature_line>   # print the hash for the function whose signature starts at that line
  verify  [paths...]                # scan for @audit-hash markers; report OK / DRIFTED / stale (default: client/src server/src)

Exit code: `verify` returns non-zero if any marker DRIFTED or could not be resolved.
"""
import hashlib
import re
import sys
from pathlib import Path

MARKER_RE = re.compile(r"@audit-hash\s+sha256:([0-9a-f]{16})")
COMMENT_RE = re.compile(r"^\s*(//|#)")           # TS/Rust `//`, plus `#` just in case
AUDIT_LINE_RE = re.compile(r"@audit")
DEFAULT_ROOTS = ["client/src", "server/src"]
EXTS = {".ts", ".rs"}


def _normalize(lines):
    # CRLF/CR already gone (we read text); strip trailing whitespace per line, join with LF.
    return "\n".join(ln.rstrip() for ln in lines)


def _function_range(lines, sig_idx):
    """Given 0-based index of a function's signature line, return (start_idx, end_idx_inclusive)
    covering signature..matching-close of the BODY-opening `{`. None if no balanced body is found.

    The body-opening brace is the first `{` seen at paren-depth 0 AND angle-depth 0 — so a brace inside
    a parameter type (`base: { hash: string }`, which lives inside the `(...)`) or a generic return type
    (`Promise<{ token: string }>`, inside `<...>`) is skipped, not mistaken for the body. (Limitation: a
    BARE object return-type annotation `(): { a: number } { … }` isn't supported — none exist in the
    audited set. `>` is clamped at 0 so `->` / `=>` don't underflow the angle counter.)"""
    n = len(lines)
    paren = angle = 0
    body = None  # (line_idx, col) of the body-opening brace
    for j in range(sig_idx, n):
        for col, ch in enumerate(lines[j]):
            if ch == "(":
                paren += 1
            elif ch == ")":
                paren = max(0, paren - 1)
            elif ch == "<":
                angle += 1
            elif ch == ">":
                angle = max(0, angle - 1)
            elif ch == "{" and paren == 0 and angle == 0:
                body = (j, col)
                break
        if body:
            break
    if not body:
        return None
    depth = 0
    for j in range(body[0], n):
        segment = lines[j][body[1]:] if j == body[0] else lines[j]
        for ch in segment:
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    return (sig_idx, j)
    return None


def _hash_range(lines, start, end):
    body = _normalize(lines[start:end + 1])
    return hashlib.sha256(body.encode("utf-8")).hexdigest()[:16]


def _next_signature_idx(lines, after_idx):
    """First non-blank, non-comment line after `after_idx` — the function's signature start."""
    j = after_idx + 1
    while j < len(lines):
        s = lines[j].strip()
        if s and not COMMENT_RE.match(lines[j]) and not AUDIT_LINE_RE.search(lines[j]):
            return j
        j += 1
    return None


def cmd_compute(file, sig_line):
    lines = Path(file).read_text(encoding="utf-8").splitlines()
    rng = _function_range(lines, int(sig_line) - 1)
    if not rng:
        print(f"ERROR: no balanced {{...}} body found from {file}:{sig_line}", file=sys.stderr)
        return 2
    print(f"sha256:{_hash_range(lines, *rng)}")
    return 0


def _iter_files(paths):
    for p in paths:
        pp = Path(p)
        if pp.is_dir():
            for f in sorted(pp.rglob("*")):
                if f.suffix in EXTS:
                    yield f
        elif pp.suffix in EXTS:
            yield pp


def cmd_verify(paths):
    roots = paths or DEFAULT_ROOTS
    ok = drift = stale = 0
    for f in _iter_files(roots):
        lines = f.read_text(encoding="utf-8").splitlines()
        for idx, line in enumerate(lines):
            m = MARKER_RE.search(line)
            if not m:
                continue
            recorded = m.group(1)
            sig = _next_signature_idx(lines, idx)
            rng = _function_range(lines, sig) if sig is not None else None
            if not rng:
                print(f"STALE  {f}:{idx + 1} — marker resolves to no function")
                stale += 1
                continue
            actual = _hash_range(lines, *rng)
            if actual == recorded:
                ok += 1
            else:
                drift += 1
                print(f"DRIFT  {f}:{rng[0] + 1} — audited sha256:{recorded}, now sha256:{actual} (re-audit)")
    print(f"\naudit-hash: {ok} unchanged, {drift} drifted, {stale} stale")
    return 1 if (drift or stale) else 0


def main(argv):
    if len(argv) >= 3 and argv[1] == "compute":
        return cmd_compute(argv[2], argv[3]) if len(argv) >= 4 else 2
    if len(argv) >= 2 and argv[1] == "verify":
        return cmd_verify(argv[2:])
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
