#!/usr/bin/env python3
"""Decouple the retired "new-livesync" working name from the SelfSync deliverable (D0046).

SelfSync is an independent implementation, not a fork or derivative of
vrtmrz/obsidian-livesync (which inspired the problem statement only). The repo still carried
the original working name in build identifiers and TypeScript class names, which misrepresents
that provenance. This codemod renames those identifiers.

Scope is CODE ONLY (build-affecting identifiers). Docs are updated as targeted edits in the
same commit so a historical plan keeps its dated record.

CRITICAL EXCLUSION -- the bare legacy plugin id `new-livesync` is NOT renamed. It is a live
compatibility + security fact: `client/src/configsync.ts` LEGACY_SELF_IDS names the FORMER
plugin folder so its `data.json` (this device's server URL + credentials) is excluded from
config sync. Renaming it would reintroduce a credential-leak path. Every rule below matches a
strictly LONGER string than the bare id, so the bare id is untouched by construction; the
post-check asserts its count is unchanged.

Idempotent (a site already in the new shape matches no rule). Dry-run by default; --apply writes.

Usage:
    python 2026-09-07-decouple-livesync-naming.py [REPO_ROOT] [--apply]
"""
from __future__ import annotations

import argparse
import hashlib
import re
import sys
from pathlib import Path

# Old -> new. Ordered longest-first so no rule can shadow another. Every key is longer than the
# bare legacy id "new-livesync", which therefore never matches.
RULES: list[tuple[str, str]] = [
    ("new_livesync_server", "selfsync_server"),   # Rust lib name + every `use` path
    ("new-livesync-server", "selfsync-server"),   # Cargo package + bin name, e2e binary paths
    ("new-livesync-client", "selfsync-client"),   # client package.json name
    ("NewLiveSync", "SelfSync"),                  # NewLiveSyncPlugin/Settings/SettingTab
]

# The bare legacy id must survive untouched (see module docstring).
LEGACY_ID = "new-livesync"

# Code trees only. Docs are handled as reviewed targeted edits, not by this codemod.
TARGETS: list[str] = [
    "client/src",
    "client/test",
    "client/e2e-admin",
    "client/e2e-obsidian",
    "server/src",
    "server/tests",
    "server/Cargo.toml",
    "client/package.json",
]

SUFFIXES = {".ts", ".tsx", ".rs", ".toml", ".json"}


def iter_files(root: Path) -> list[Path]:
    out: list[Path] = []
    for rel in TARGETS:
        p = root / rel
        if p.is_file():
            out.append(p)
        elif p.is_dir():
            for f in sorted(p.rglob("*")):
                if f.is_file() and f.suffix in SUFFIXES and "node_modules" not in f.parts and "target" not in f.parts:
                    out.append(f)
    return out


def count_all(root: Path, needle: str) -> int:
    """Occurrences of `needle` across the whole repo (excluding build/vcs dirs)."""
    total = 0
    skip = {"node_modules", "target", ".git"}
    for f in root.rglob("*"):
        if not f.is_file() or skip & set(f.parts):
            continue
        try:
            total += f.read_text(encoding="utf-8").count(needle)
        except (UnicodeDecodeError, OSError):
            continue
    return total


def bare_legacy_count(root: Path) -> int:
    """Bare-legacy-id occurrences: `new-livesync` NOT followed by `-server`/`-client`."""
    pat = re.compile(re.escape(LEGACY_ID) + r"(?!-server|-client)")
    total = 0
    skip = {"node_modules", "target", ".git"}
    for f in root.rglob("*"):
        if not f.is_file() or skip & set(f.parts):
            continue
        try:
            total += len(pat.findall(f.read_text(encoding="utf-8")))
        except (UnicodeDecodeError, OSError):
            continue
    return total


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("root", nargs="?", default=".")
    ap.add_argument("--apply", action="store_true", help="write changes (default: dry run)")
    args = ap.parse_args()
    root = Path(args.root).resolve()

    files = iter_files(root)
    before_bare = bare_legacy_count(root)

    # --- transform (in memory first, so reconciliation gates the write) ---
    planned: dict[Path, str] = {}
    per_rule_applied: dict[str, int] = {old: 0 for old, _ in RULES}
    migrated = skipped = errored = 0
    residue_hash_src: list[str] = []

    for f in files:
        try:
            text = f.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError) as e:
            print(f"ERROR reading {f}: {e}", file=sys.stderr)
            errored += 1
            continue
        new = text
        hits = 0
        for old, repl in RULES:
            n = new.count(old)
            if n:
                new = new.replace(old, repl)
                per_rule_applied[old] += n
                hits += n
        if hits == 0:
            skipped += 1  # already in the new shape, or never named
            continue
        migrated += 1
        planned[f] = new
        # CONTENT gate: strip every renamed token from both sides; the remainder must be identical,
        # proving the codemod changed nothing but the names.
        residue_hash_src.append(_residue(text) + "\x00" + _residue(new))

    # --- reconciliation (control totals) ---
    print(f"files scanned : {len(files)}")
    print(f"migrated      : {migrated}")
    print(f"skipped       : {skipped}")
    print(f"errored       : {errored}")
    print(f"no-leak       : {migrated + skipped + errored} == {len(files)} -> "
          f"{'OK' if migrated + skipped + errored == len(files) else 'FAIL'}")
    print("conservation (per rule, old occurrences in code tree -> renamed):")
    ok = migrated + skipped + errored == len(files) and errored == 0
    for old, repl in RULES:
        in_tree = sum(f.read_text(encoding='utf-8').count(old) for f in files
                      if _safe_read(f) is not None)
        got = per_rule_applied[old]
        good = in_tree == got
        ok = ok and good
        print(f"  {old:22s} -> {repl:18s} {in_tree:4d} == {got:4d}  {'OK' if good else 'FAIL'}")

    # CONTENT: every migrated file must be byte-identical once the names are masked out.
    content_ok = all(a == b for a, b in (p.split("\x00") for p in residue_hash_src))
    digest = hashlib.sha256("".join(residue_hash_src).encode()).hexdigest()[:16]
    print(f"content       : name-masked residue identical -> {'OK' if content_ok else 'FAIL'} (h={digest})")
    ok = ok and content_ok

    print(f"legacy id     : bare '{LEGACY_ID}' occurrences = {before_bare} (must be unchanged after apply)")

    if not ok:
        print("\nRECONCILE FAILED -- refusing to apply.", file=sys.stderr)
        return 1

    if not args.apply:
        print("\nDRY RUN -- nothing written. Re-run with --apply.")
        for f in planned:
            print(f"  would rewrite {f.relative_to(root)}")
        return 0

    for f, new in planned.items():
        f.write_text(new, encoding="utf-8")
    print(f"\nAPPLIED to {len(planned)} files.")

    after_bare = bare_legacy_count(root)
    print(f"post-check    : bare '{LEGACY_ID}' {before_bare} -> {after_bare} "
          f"{'OK' if before_bare == after_bare else 'FAIL (legacy id was touched!)'}")
    for old, _ in RULES:
        left = count_all(root, old)
        print(f"post-check    : '{old}' remaining repo-wide = {left} (docs handled separately)")
    return 0 if before_bare == after_bare else 1


def _residue(text: str) -> str:
    """`text` with every rename token (old and new) removed, so only unrelated content remains."""
    for old, repl in RULES:
        text = text.replace(old, "").replace(repl, "")
    return text


def _safe_read(f: Path) -> str | None:
    try:
        return f.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        return None


if __name__ == "__main__":
    raise SystemExit(main())
