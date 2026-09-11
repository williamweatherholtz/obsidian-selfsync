// Rewrite-loop breaker (STPA UCA-52 / SR-47 / C-50). Two authorities that each react to the other's writes —
// SelfSync and another sync tool, or SelfSync and a plugin that re-stamps a note on every open — can bounce ONE
// file between two (or a few) contents indefinitely: A→B→A→B…, each round a push. The plugin bounds only the
// echo of its OWN writes (recentSelfWrites); nothing bounded a loop driven by someone else. This tracker
// recognises the signature — a path whose content RETURNS to a value already seen within a window — and, past
// a limit, asks the caller to HOLD the push. A hold changes nothing on disk or on the server; it stops the
// plugin from being the loop's amplifier and surfaces the path for the user. The hold lifts by itself when
// the content settles on a value NOT seen before (a real edit), when the window expires, or when the user
// pushes anyway. Pure + total; unit-tested (flipguard.test.ts).
export interface FlipVerdict { hold: boolean; flips: number }

export class FlipGuard {
  // path -> recent (hash, at) observations, newest last; plus the last hash we saw so a REPEAT of the same
  // content across passes (a held push re-evaluated every pass) is not counted as a flip.
  private readonly seen = new Map<string, { hashes: { hash: string; at: number }[]; last?: string; flips: { at: number }[] }>();
  private readonly overridden = new Set<string>();
  constructor(private readonly limit = 4, private readonly windowMs = 10 * 60_000) {}

  // Record that the reconciler wants to push `path` with content `hash` at `now`. Returns whether to hold.
  record(path: string, hash: string, now: number): FlipVerdict {
    let e = this.seen.get(path);
    if (!e) { e = { hashes: [], flips: [] }; this.seen.set(path, e); }
    const cutoff = now - this.windowMs;
    e.hashes = e.hashes.filter((h) => h.at >= cutoff);
    e.flips = e.flips.filter((f) => f.at >= cutoff);
    if (hash !== e.last) {
      const returning = e.hashes.some((h) => h.hash === hash);
      if (returning) e.flips.push({ at: now });
      else if (e.last !== undefined && e.flips.length > 0) {
        // Content settled on something NEW after flipping: a real edit — the loop is over, start clean.
        e.flips = []; this.overridden.delete(path);
      }
      e.hashes.push({ hash, at: now });
      e.last = hash;
    }
    const flips = e.flips.length;
    const hold = flips >= this.limit && !this.overridden.has(path);
    return { hold, flips };
  }

  // The user chose "push anyway": let the CURRENT content through (and further pushes until the loop is broken
  // by a settled value or the window lapses — the override is per path, cleared on a real edit).
  release(path: string): void { this.overridden.add(path); }
  forget(path: string): void { this.seen.delete(path); this.overridden.delete(path); }
  held(now: number): string[] {
    const out: string[] = [];
    for (const [p, e] of this.seen) {
      const flips = e.flips.filter((f) => f.at >= now - this.windowMs).length;
      if (flips >= this.limit && !this.overridden.has(p)) out.push(p);
    }
    return out.sort();
  }
}
