import { App, Modal, Notice, Setting } from "obsidian";
import { lcsPairs, isTextExt } from "./merge";
import { normalizedContent } from "./frontmatter";
import type SelfSyncPlugin from "./main";

// A single line of a unified diff: shared context, or a line only on one side.
type DiffLine = { sign: " " | "-" | "+"; text: string };

// UTF-8 decode that REFUSES invalid input instead of substituting replacement characters, so a binary
// attachment can never be compared as text. Returns null rather than throwing so callers can skip it.
function strictDecode(bytes: Uint8Array): string | null {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return null; }
}
// Unified line diff of `theirs` (the other/server version, left) vs `mine` (this device, right).
// EOL-normalized so line-ending differences don't show as noise. Exported for tests.
// lcsPairs is an O(n·m) DP over a NESTED number matrix. Running it on whole notes with no bound froze
// the UI thread — measured, for notes differing by ONE line: 4k lines 447ms, 8k 1.96s, 12k 4.5s on a
// fast desktop, several times worse on mobile — and it ran on modal open AND again after every single
// resolve (issueConflictDiffQuadratic). merge3 already had MAX_MERGE_LINES for exactly this reason;
// the diff view had nothing. Bounded here in two stages, cheapest first.
const MAX_DIFF_CELLS = 2_000_000; // ≈1400×1400; measured ~65ms, so the worst allowed case stays snappy

export function unifiedLineDiff(theirs: string, mine: string): DiffLine[] {
  // Normalize EOL + strip trailing blank lines (matches sameIgnoringEol) so a pure line-ending
  // difference shows as ZERO changes rather than a phantom trailing-empty-line diff.
  const norm = (s: string) => s.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  const A = norm(theirs).split("\n");
  const B = norm(mine).split("\n");

  // (1) Strip the common prefix + suffix. They are context under any alignment, so the DP never needs
  // to see them, and the emitted diff is IDENTICAL — a one-line edit in a 12k-line note collapses to a
  // 1×1 problem. This is the whole win in the common case; the cap below only catches the pathological.
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;

  const out: DiffLine[] = [];
  for (let i = 0; i < pre; i++) out.push({ sign: " ", text: A[i] });

  const midA = A.slice(pre, A.length - suf);
  const midB = B.slice(pre, B.length - suf);
  if (midA.length * midB.length > MAX_DIFF_CELLS) {
    // (2) Two genuinely dissimilar large regions. Report the whole region as changed rather than
    // allocating an n·m matrix and freezing: coarser, but honest (nothing is hidden — every line on
    // each side is shown) and bounded. Mirrors merge3's fall-back-to-conflict at MAX_MERGE_LINES.
    for (const text of midA) out.push({ sign: "-", text });
    for (const text of midB) out.push({ sign: "+", text });
  } else {
    const pairs = lcsPairs(midA, midB); // matched [ai,bi] in order
    let ai = 0, bi = 0;
    for (const [ma, mb] of pairs) {
      while (ai < ma) out.push({ sign: "-", text: midA[ai++] }); // only on the other side (removed here)
      while (bi < mb) out.push({ sign: "+", text: midB[bi++] }); // only on this device (added here)
      out.push({ sign: " ", text: midA[ma] }); ai = ma + 1; bi = mb + 1;
    }
    while (ai < midA.length) out.push({ sign: "-", text: midA[ai++] });
    while (bi < midB.length) out.push({ sign: "+", text: midB[bi++] });
  }

  for (let i = A.length - suf; i < A.length; i++) out.push({ sign: " ", text: A[i] });
  return out;
}

// Walk through unresolved note conflicts one at a time. A conflict copy holds THIS device's version,
// kept beside the note (which holds the other device's version) when concurrent edits couldn't merge
// cleanly. For each: keep this version, keep the other, or open both to merge by hand. The set is
// DERIVED from the vault, so resolving one drops it off and the count self-updates — no stale list.
// A copy that differs from the note ONLY by line endings / trailing newline is auto-dismissed (kept
// the note's version) — it was never a real conflict (issueFalseEolConflict), so the user isn't asked.
export class NoteConflictModal extends Modal {
  constructor(app: App, private plugin: SelfSyncPlugin) { super(app); }

  // Set while the modal is on screen. The background cosmetic sweep and every render check it, so
  // closing the modal stops that work instead of letting it keep reading files and writing into a
  // detached contentEl (issueConflictModalWorkAfterClose).
  private open_ = false;
  // An apply is in flight. The buttons are an IRREVERSIBLE either-side choice, and `render()` used to
  // be fired unawaited, so a double-tap could enter resolve() twice — the second call racing against
  // a half-applied first and acting on a copy that was already gone
  // (issueConflictModalDoubleApply). One flag blocks the re-entry and greys the buttons.
  private busy = false;

  onOpen() { this.open_ = true; this.titleEl.setText("Resolve conflicts"); void this.run(); }
  onClose() { this.open_ = false; this.contentEl.empty(); }

  // Entry point: DRAW THE FIRST CONFLICT IMMEDIATELY, then clear cosmetic-only ones in the
  // background and redraw if any went. The old order ran the whole auto-dismiss sweep FIRST —
  // 2N sequential disk reads plus four full UTF-8 decodes per file (isMergeable twice, then
  // sameIgnoringEol decoding both again) — behind a "Checking conflicts…" placeholder, so the
  // modal took ~2N round-trips to show anything even though it only ever displays ONE conflict
  // (issueConflictModalSerialScan). Wrapped so an error shows a message rather than an empty body.
  private async run() {
    try {
      await this.render();          // the user is looking at real content after ~2 reads, not ~2N
      await this.autoDismissCosmetic();
    } catch (e: any) {
      const c = this.contentEl; c.empty();
      c.createEl("p", { text: `Couldn't load conflicts: ${e?.message ?? e}` }).setAttribute("style", "font-size:13px;");
      new Setting(c).addButton((b) => b.setButtonText("Close").setCta().onClick(() => this.close()));
    }
  }

  // Clear conflicts whose two sides are the SAME CONTENT (line-endings and the frontmatter timestamp
  // keys the user chose to ignore) — a batch of false conflicts from an older client, without one tap
  // per file. Three things keep it cheap: the extension gate is checked BEFORE any read (a `.png`
  // conflict costs zero IO), each side is decoded ONCE instead of three times, and the reads run with
  // bounded concurrency instead of strictly serially.
  private async autoDismissCosmetic() {
    const conflicts = this.plugin.listNoteConflicts();
    // Free filter first: isMergeable's extension check needs no bytes at all.
    const candidates = conflicts.filter((c) => isTextExt(c.copy) && isTextExt(c.original));
    if (candidates.length === 0) return;

    let dismissed = 0;
    const CONCURRENCY = 8;
    let next = 0;
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= candidates.length || !this.open_) return;
        const { copy, original } = candidates[i];
        // Per-entry isolation: a STALE entry (the copy or note already removed → "File does not
        // exist") must be skipped, never abort the whole modal. Resolving a vanished copy is treated
        // as already-done — the derived list drops it on the next render.
        try {
          const [mineB, theirsB] = await Promise.all([
            this.plugin.readBytesOrNull(copy),
            this.plugin.readBytesOrNull(original),
          ]);
          if (!mineB || !theirsB) continue;
          // Decode ONCE per side, fatally — a binary attachment or invalid UTF-8 throws here and falls
          // through to the modal. Never lossy-decode a binary to compare it: two DIFFERENT binaries can
          // decode equal and we would silently delete this device's only copy (critique F1).
          const mineT = strictDecode(mineB);
          const theirsT = strictDecode(theirsB);
          if (mineT === null || theirsT === null) continue;
          const pats = this.plugin.ignorePatternsForPath(original);
          if (normalizedContent(mineT, pats) !== normalizedContent(theirsT, pats)) continue;
          await this.plugin.resolveNoteConflict(copy, original, "theirs", theirsT);
          dismissed++;
        } catch { /* stale/missing entry — skip; it's effectively resolved */ }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, worker));
    if (dismissed > 0 && this.open_) await this.render(); // the list shrank — redraw the frontier
  }

  private async render() {
    const c = this.contentEl; c.empty();
    const conflicts = this.plugin.listNoteConflicts();

    if (conflicts.length === 0) {
      c.createEl("p", { text: "No conflicts to resolve — everything is in sync." });
      new Setting(c).addButton((b) => b.setButtonText("Close").setCta().onClick(() => this.close()));
      return;
    }
    const { copy, original } = conflicts[0];
    c.createEl("p", { text: `${conflicts.length} file${conflicts.length > 1 ? "s" : ""} to resolve. “${original}” was edited on two devices at once — changes are shown below:` })
      .setAttribute("style", "font-size:13px;margin-bottom:10px;opacity:.85;");

    const theirs = await this.plugin.readTextOrEmpty(original); // captured to guard "keep mine" against a stale preview
    const mine = await this.plugin.readTextOrEmpty(copy);
    // Diff on CONTENT IDENTITY, masking the frontmatter timestamp keys the user told SelfSync to
    // ignore — the same basis the sync engine and the stale-preview guard use. Rendering raw text
    // meant an ignored `updated:` bump drew a red/green changed line, so the modal contradicted the
    // setting and invented a conflict the engine did not consider one.
    this.renderDiff(c, theirs, mine, this.plugin.ignorePatternsForPath(original));

    new Setting(c)
      .addButton((b) => b.setButtonText("Open both to merge").onClick(() => void this.merge(copy, original)))
      .addButton((b) => b.setButtonText("Keep the other device's").onClick(() => void this.resolve(copy, original, "theirs", theirs)))
      // No CTA (highlighted default) here: this is an unbiased, irreversible either-side choice, and a
      // highlighted default invites a reflexive tap that discards the OTHER device's edits (capture error).
      .addButton((b) => b.setButtonText("Keep this device's").onClick(() => void this.resolve(copy, original, "mine", theirs)));
  }

  // A real diff: shared lines dim, "− the other version" lines red, "+ this device's" lines green.
  // Capped so a huge note stays responsive.
  private renderDiff(c: HTMLElement, theirs: string, mine: string, ignorePatterns: readonly string[] = []) {
    c.createEl("div", { text: "− the other version    + this device's" })
      .setAttribute("style", "font-size:11px;opacity:.7;margin:4px 0 2px;");
    const lines = unifiedLineDiff(normalizedContent(theirs, ignorePatterns), normalizedContent(mine, ignorePatterns));
    const changed = lines.filter((l) => l.sign !== " ").length;
    if (changed === 0) {
      c.createEl("p", {
        text: ignorePatterns.length
          ? "The two versions are identical apart from line endings and the timestamp fields you chose to ignore."
          : "The two versions are identical apart from line endings.",
      }).setAttribute("style", "font-size:12px;opacity:.8;");
      return;
    }
    const pre = c.createEl("pre");
    pre.setAttribute("style", "max-height:340px;overflow:auto;background:var(--background-secondary);padding:8px;border-radius:6px;font-size:12px;white-space:pre-wrap;margin:2px 0 0;line-height:1.35;");
    const shown = lines.slice(0, 400);
    for (const l of shown) {
      const color = l.sign === "+" ? "var(--color-green)" : l.sign === "-" ? "var(--color-red)" : "var(--text-muted)";
      const bg = l.sign === "+" ? "rgba(0,180,0,.10)" : l.sign === "-" ? "rgba(220,0,0,.10)" : "transparent";
      const row = pre.createEl("div", { text: `${l.sign} ${l.text}` });
      row.setAttribute("style", `color:${color};background:${bg};`);
    }
    if (lines.length > shown.length) pre.createEl("div", { text: `… (${lines.length - shown.length} more lines)` }).setAttribute("style", "opacity:.6;");
  }

  private async resolve(copy: string, original: string, choice: "mine" | "theirs", previewedOther: string) {
    if (this.busy) return; // a second tap while the first apply is still in flight
    this.busy = true;
    // Visible feedback: the apply writes + deletes a file and enqueues sync work, so on a big vault
    // there IS a pause. Dimming says "working" instead of leaving live-looking buttons under a
    // tap that now does nothing.
    this.contentEl.setAttribute("style", "opacity:.55;pointer-events:none;");
    try {
      // false = the file changed since we previewed it (resolveNoteConflict warned) → just re-render
      // so the user reviews the new content; true = resolved.
      if (await this.plugin.resolveNoteConflict(copy, original, choice, previewedOther)) new Notice(`SelfSync: resolved ${original}`);
    } catch (e: any) { new Notice(`SelfSync: ${e?.message ?? e}`); }
    finally { this.busy = false; this.contentEl.removeAttribute("style"); }
    if (this.open_) await this.render(); // advance to the next conflict, or the done state
  }

  private async merge(copy: string, original: string) {
    if (this.busy) return;
    this.busy = true;
    try { await this.plugin.resolveNoteConflict(copy, original, "manual"); }
    catch (e: any) { new Notice(`SelfSync: ${e?.message ?? e}`); }
    finally { this.busy = false; }
    this.close(); // hand off to the editor; the copy stays listed until the user deletes it
  }
}
