// Rewrite-loop breaker (STPA UCA-52 / SR-47 / C-50). Two authorities that each react to the other's writes —
// SelfSync and another sync tool, or SelfSync and a plugin that ALTERNATES a note between a bounded set of
// contents — can bounce ONE file A→B→A→B… indefinitely, each round a push. The plugin bounds only the echo of
// its OWN writes (recentSelfWrites); nothing bounded a loop driven by someone else. This tracker recognises the
// signature — a path whose content RETURNS to a value already seen within a window — and, past a limit, asks
// the caller to HOLD the push. A hold changes nothing on disk or on the server; it stops the plugin from being
// the loop's amplifier and surfaces the path for the user.
//
// A writer that produces a NEVER-SEEN value each round — a monotonic timestamp stamper on a key the ignore-timestamp
// rules do not mask, or in a .txt / excluded folder — is not an exact return. It IS a return of the content's SHAPE:
// the text with every timestamp-shaped token masked. Callers pass the shape of mergeable text (shapeOf) beside the
// hash; a shape already seen in the window counts as a flip too (panel ID3 residual, monotonicRewriteDetection).
//
// The hold lifts by itself when the content settles on a value NOT seen before (a real edit), when the flips age
// out of the window, or — one-shot — when the user chooses to upload the CURRENT content anyway: exactly that
// content passes; if the file flips again the hold is back. Pure + total; unit-tested (flipguard.test.ts).
export interface FlipVerdict { hold: boolean; flips: number }

// The content with timestamp-shaped tokens masked: ISO dates/date-times (any separator, optional zone), 10–13 digit
// epoch numbers, and HH:MM(:SS) clock times. Two rounds of a stamper differ only there, so their shapes are equal.
const TS_TOKEN = /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?|\b\d{10,13}\b|\b\d{1,2}:\d{2}(?::\d{2})?\b/g;
export function shapeOf(text: string): string { return text.replace(/\r\n?/g, "\n").replace(TS_TOKEN, "\u27e8ts\u27e9"); }

interface Entry {
  hashes: { hash: string; shape?: string; at: number }[]; // recent distinct observations, newest last
  last?: string;                          // the last content asked about (a REPEAT across passes is not a flip)
  flips: { at: number }[];                // when content returned to an earlier value
  releasedHash?: string;                  // the user's one-shot "upload this anyway" — valid for exactly this content
}

export class FlipGuard {
  private readonly seen = new Map<string, Entry>();
  // limit 6: a person toggling one checkbox back and forth five times in ten minutes is unusual but real; a tool
  // loop passes six returns in well under a minute. The window bounds how long a hold can outlive the loop.
  constructor(private readonly limit = 6, private readonly windowMs = 10 * 60_000) {}

  // Record that the reconciler wants to push `path` with content `hash` at `now`. Returns whether to hold.
  record(path: string, hash: string, now: number, shape?: string): FlipVerdict {
    let e = this.seen.get(path);
    if (!e) { e = { hashes: [], flips: [] }; this.seen.set(path, e); }
    const cutoff = now - this.windowMs;
    e.hashes = e.hashes.filter((h) => h.at >= cutoff);
    e.flips = e.flips.filter((f) => f.at >= cutoff);
    if (hash !== e.last) {
      const returning = e.hashes.some((h) => h.hash === hash || (shape !== undefined && h.shape === shape)); // exact return, OR the same shape with only timestamps moved
      if (returning) e.flips.push({ at: now });
      else if (e.last !== undefined && e.flips.length > 0) e.flips = []; // settled on something NEW: a real edit — the loop is over
      e.hashes.push({ hash, shape, at: now });
      e.last = hash;
    }
    if (e.flips.length === 0) e.releasedHash = undefined; // nothing held ⇒ nothing to override
    const flips = e.flips.length;
    const hold = flips >= this.limit && e.releasedHash !== hash;
    return { hold, flips };
  }

  // The user chose "upload the current version anyway": exactly the content currently held passes; a further flip
  // re-arms the hold (the override is one-shot, never a standing exemption for a path that keeps looping).
  release(path: string): void {
    const e = this.seen.get(path);
    if (e && e.last !== undefined) e.releasedHash = e.last;
  }

  held(now: number): string[] {
    const out: string[] = [];
    for (const [p, e] of this.seen) {
      const flips = e.flips.filter((f) => f.at >= now - this.windowMs).length;
      if (flips >= this.limit && e.releasedHash !== e.last) out.push(p);
    }
    return out.sort();
  }
}
