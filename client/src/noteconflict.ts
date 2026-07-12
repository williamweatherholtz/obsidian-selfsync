import { App, Modal, Notice, Setting } from "obsidian";
import { lcsPairs } from "./merge";
import type NewLiveSyncPlugin from "./main";

// A single line of a unified diff: shared context, or a line only on one side.
type DiffLine = { sign: " " | "-" | "+"; text: string };
// Unified line diff of `theirs` (the other/server version, left) vs `mine` (this device, right).
// EOL-normalized so line-ending differences don't show as noise. Exported for tests.
export function unifiedLineDiff(theirs: string, mine: string): DiffLine[] {
  // Normalize EOL + strip trailing blank lines (matches sameIgnoringEol) so a pure line-ending
  // difference shows as ZERO changes rather than a phantom trailing-empty-line diff.
  const norm = (s: string) => s.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  const A = norm(theirs).split("\n");
  const B = norm(mine).split("\n");
  const pairs = lcsPairs(A, B); // matched [ai,bi] in order
  const out: DiffLine[] = [];
  let ai = 0, bi = 0;
  for (const [ma, mb] of pairs) {
    while (ai < ma) out.push({ sign: "-", text: A[ai++] }); // only on the other side (removed here)
    while (bi < mb) out.push({ sign: "+", text: B[bi++] }); // only on this device (added here)
    out.push({ sign: " ", text: A[ma] }); ai = ma + 1; bi = mb + 1;
  }
  while (ai < A.length) out.push({ sign: "-", text: A[ai++] });
  while (bi < B.length) out.push({ sign: "+", text: B[bi++] });
  return out;
}

// Walk through unresolved note conflicts one at a time. A conflict copy holds THIS device's version,
// kept beside the note (which holds the other device's version) when concurrent edits couldn't merge
// cleanly. For each: keep this version, keep the other, or open both to merge by hand. The set is
// DERIVED from the vault, so resolving one drops it off and the count self-updates — no stale list.
// A copy that differs from the note ONLY by line endings / trailing newline is auto-dismissed (kept
// the note's version) — it was never a real conflict (issueFalseEolConflict), so the user isn't asked.
export class NoteConflictModal extends Modal {
  constructor(app: App, private plugin: NewLiveSyncPlugin) { super(app); }

  onOpen() { this.titleEl.setText("Resolve conflicts"); void this.run(); }
  onClose() { this.contentEl.empty(); }

  // Only line endings / trailing newline differ → not a real conflict.
  private cosmeticEqual(a: string, b: string): boolean {
    const n = (s: string) => s.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
    return n(a) === n(b);
  }

  // Entry point: show an IMMEDIATE placeholder (never a blank modal), auto-dismiss cosmetic-only
  // conflicts with visible progress, then draw the real state. Wrapped so an error shows a message
  // instead of leaving the body empty (the reported "display error").
  private async run() {
    const c = this.contentEl; c.empty();
    const status = c.createEl("p", { text: "Checking conflicts…" });
    status.setAttribute("style", "font-size:13px;opacity:.85;");
    try {
      // Auto-dismiss cosmetic-only conflicts (clears a batch of false EOL conflicts from an older
      // client without one tap per file). Bounded to the current list; updates the placeholder.
      const conflicts = this.plugin.listNoteConflicts();
      let dismissed = 0;
      for (const { copy, original } of conflicts) {
        // Per-entry isolation: a STALE entry (the copy or note was already removed → "File does not
        // exist") must be skipped, never abort the whole modal. Resolving a vanished copy is treated
        // as already-done — the derived list drops it on the next render.
        try {
          const mine = await this.plugin.readTextOrEmpty(copy);
          const theirs = await this.plugin.readTextOrEmpty(original);
          if (this.cosmeticEqual(mine, theirs)) {
            await this.plugin.resolveNoteConflict(copy, original, "theirs", theirs);
            status.setText(`Clearing cosmetic (line-ending-only) conflicts… ${++dismissed}`);
          }
        } catch { /* stale/missing entry — skip; it's effectively resolved */ }
      }
      await this.render();
    } catch (e: any) {
      c.empty();
      c.createEl("p", { text: `Couldn't load conflicts: ${e?.message ?? e}` }).setAttribute("style", "font-size:13px;");
      new Setting(c).addButton((b) => b.setButtonText("Close").setCta().onClick(() => this.close()));
    }
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
    this.renderDiff(c, theirs, mine);

    new Setting(c)
      .addButton((b) => b.setButtonText("Open both to merge").onClick(() => void this.merge(copy, original)))
      .addButton((b) => b.setButtonText("Keep the other").onClick(() => void this.resolve(copy, original, "theirs", theirs)))
      .addButton((b) => b.setButtonText("Keep this device's").setCta().onClick(() => void this.resolve(copy, original, "mine", theirs)));
  }

  // A real diff: shared lines dim, "− the other version" lines red, "+ this device's" lines green.
  // Capped so a huge note stays responsive.
  private renderDiff(c: HTMLElement, theirs: string, mine: string) {
    c.createEl("div", { text: "− the other version    + this device's" })
      .setAttribute("style", "font-size:11px;opacity:.7;margin:4px 0 2px;");
    const lines = unifiedLineDiff(theirs, mine);
    const changed = lines.filter((l) => l.sign !== " ").length;
    if (changed === 0) {
      c.createEl("p", { text: "The two versions are identical apart from line endings." })
        .setAttribute("style", "font-size:12px;opacity:.8;");
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
    try {
      // false = the file changed since we previewed it (resolveNoteConflict warned) → just re-render
      // so the user reviews the new content; true = resolved.
      if (await this.plugin.resolveNoteConflict(copy, original, choice, previewedOther)) new Notice(`SelfSync: resolved ${original}`);
    } catch (e: any) { new Notice(`SelfSync: ${e?.message ?? e}`); }
    void this.render(); // advance to the next conflict, or the done state
  }

  private async merge(copy: string, original: string) {
    await this.plugin.resolveNoteConflict(copy, original, "manual");
    this.close(); // hand off to the editor; the copy stays listed until the user deletes it
  }
}
