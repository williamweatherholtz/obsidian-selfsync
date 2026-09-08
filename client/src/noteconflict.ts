import { App, ButtonComponent, Modal, Notice, Setting } from "obsidian";
import { gateButtons, type BusyGate } from "./busygate";
import { resolveNext, resolveLabel, resolveInFlight, type ResolveState, type ResolveEvent } from "./resolvefsm";
import { lcsPairs, isTextExt } from "./merge";
import { maskedForDisplay } from "./frontmatter";
import type SelfSyncPlugin from "./main";

// A single line of a unified diff: shared context, or a line only on one side.
type DiffLine = { sign: " " | "-" | "+"; text: string };

// A text conflict larger than this is shown as sizes + dates, not a line diff: decoding + diffing tens of MB on
// the main thread is a hang, and a 4 MB note has no readable diff anyway.
const MAX_DIFF_BYTES = 4 * 1024 * 1024;
function fmtBytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.ceil(n / 1024))} KB`;
}

// ---- invisible differences (issueConflictDiffInvisibleChars) ----
// Field report: the diff showed `- tagNames:` and `+ tagNames:` — two VISUALLY IDENTICAL lines — so
// there was nothing to choose between. Line endings were never the cause (unifiedLineDiff normalizes
// CRLF, lone CR and trailing blank lines to nothing). The real causes are characters you cannot see:
// a trailing space or tab, a non-breaking space, a zero-width char.
//
// These are deliberately NOT ignored. In Markdown two trailing spaces are a HARD LINE BREAK, a tab is
// not four spaces inside a code block, and U+00A0 is not U+0020 — treating them as equal would hide a
// real edit and could silently discard the user's version. So the diff REVEALS them instead: the
// difference stays visible AND becomes explicable.
export function revealInvisible(text: string): string {
  return text
    .replace(/\t/g, "→")                        // tab
    .replace(/ /g, "⍽")                    // non-breaking space (renders exactly like a space)
    .replace(/[​-‍﻿]/g, "∅")     // zero-width space / joiners / BOM
    .replace(/ +$/, (run) => "·".repeat(run.length)); // TRAILING spaces only — marking interior
                                                      // spaces would be noise on every line
}

// True when the diff HAS changes and every one of them is invisible-only: the set of changed lines is
// identical once invisible characters are folded away. Drives the explanatory hint, so the user is
// told "the only differences here are invisible" rather than left staring at two identical lines.
export function invisibleOnlyDifference(lines: DiffLine[]): boolean {
  const fold = (s: string) =>
    s.replace(/[\t ]/g, " ").replace(/[​-‍﻿]/g, "").replace(/\s+$/, "").normalize("NFC");
  const minus = lines.filter((l) => l.sign === "-").map((l) => fold(l.text)).sort();
  const plus = lines.filter((l) => l.sign === "+").map((l) => fold(l.text)).sort();
  if (minus.length === 0 && plus.length === 0) return false; // nothing changed at all
  return minus.length === plus.length && minus.every((v, i) => v === plus[i]);
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
  // Busy gate: while the plugin is connecting / checking files, the two irreversible keep-buttons are disabled and
  // read "Analyzing files…" (busygate.ts — show, don't tell). Copy / Open-both stay live - they commit nothing.
  private gate?: BusyGate;
  private keepButtons: ButtonComponent[] = [];
  // The resolution FSM (resolvefsm.ts). `pressed` is the button whose label projects the state.
  private rs: ResolveState = { kind: "idle" };
  private pressed?: { button: ButtonComponent; own: string };
  private dispatch(e: ResolveEvent): void {
    this.rs = resolveNext(this.rs, e);
    if (this.pressed) this.pressed.button.setButtonText(resolveLabel(this.rs, this.pressed.own));
  }

  onOpen() { this.open_ = true; this.titleEl.setText("Resolve conflicts"); void this.run(); }
  onClose() { this.open_ = false; this.gate?.dispose(); this.gate = undefined; this.contentEl.empty(); }

  // Entry point: DRAW THE FIRST CONFLICT IMMEDIATELY, then clear cosmetic-only ones in the
  // background and redraw if any went. The old order ran the whole auto-dismiss sweep FIRST —
  // 2N sequential disk reads plus four full UTF-8 decodes per file (isMergeable twice, then
  // sameIgnoringEol decoding both again) — behind a "Checking conflicts…" placeholder, so the
  // modal took ~2N round-trips to show anything even though it only ever displays ONE conflict
  // (issueConflictModalSerialScan). Wrapped so an error shows a message rather than an empty body.
  private async run() {
    try {
      await this.render();          // the user is looking at real content after ~2 reads, not ~2N
    } catch (e: any) {
      const c = this.contentEl; c.empty();
      c.createEl("p", { text: `Couldn't load conflicts: ${e?.message ?? e}` }).setAttribute("style", "font-size:13px;");
      new Setting(c).addButton((b) => b.setButtonText("Close").setCta().onClick(() => this.close()));
      return;
    }
    // The sweep is BACKGROUND work and is caught SEPARATELY: it runs after the modal is already
    // drawn, so letting its failure fall into the catch above would wipe a perfectly good rendered
    // conflict and replace it with an error — losing the very UI the user is waiting on for a
    // failure in an optimisation they did not ask for. Log it and leave the modal alone.
    try {
      await this.autoDismissCosmetic();
    } catch { /* the list is still correct; the modal simply didn't auto-clear anything */ }
  }

  // Clear already-converged conflicts, then redraw if the list shrank. The sweep itself lives on the
  // PLUGIN (dismissCosmeticConflicts) because it is not a UI concern: a plugin load runs it too, so a
  // refresh auto-resolves what it safely can instead of leaving false conflicts in the count until
  // someone opens this modal (issueCosmeticConflictsNotSweptOnLoad). Passing open_ as the continue
  // predicate stops the background work the moment the modal closes.
  private async autoDismissCosmetic() {
    const dismissed = await this.plugin.dismissCosmeticConflicts(() => this.open_);
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
    this.gate?.dispose(); this.keepButtons = [];
    this.gate = gateButtons(this.plugin, () => this.keepButtons);
    // NOT EVERY CONFLICT IS TEXT (owner, 2026-09-08: "resolve totally hangs - i see no diff... it's an mp4"). The
    // modal read BOTH versions as text and line-diffed them - for a 200 MB recording that is decoding 200 MB into
    // a string on the main thread and then diffing it: a hang, and a diff that could mean nothing anyway. A
    // binary extension, or a text file too large to diff usefully, gets the NO-DIFF view: what each side IS
    // (size, modified) and the same keep choices. Nothing is read.
    const so = this.plugin.fileStat(original), sc = this.plugin.fileStat(copy);
    const biggest = Math.max(so?.size ?? 0, sc?.size ?? 0);
    if (!isTextExt(original) || !isTextExt(copy) || biggest > MAX_DIFF_BYTES) {
      this.renderNoDiff(c, conflicts.length, copy, original, so, sc, isTextExt(original) && isTextExt(copy) ? `too large to diff (${fmtBytes(biggest)})` : "a binary file, so there is no text diff");
      this.gate.refresh();
      return;
    }
    c.createEl("p", { text: `${conflicts.length} file${conflicts.length > 1 ? "s" : ""} to resolve. “${original}” was edited on two devices at once. − lines are the other device's version, + lines are this device's:` })
      .setAttribute("style", "font-size:13px;margin-bottom:10px;opacity:.85;");

    // Both sides IN PARALLEL: these are the only two reads between opening the modal and it becoming
    // usable, so on slow storage (antivirus on every open, or a cloud-synced vault hydrating
    // placeholders) doing them one after the other doubled the wait for no reason.
    const [theirs, mine] = await Promise.all([
      this.plugin.readTextOrEmpty(original), // captured to guard "keep mine" against a stale preview
      this.plugin.readTextOrEmpty(copy),
    ]);
    // Diff on CONTENT IDENTITY, masking the frontmatter timestamp keys the user told SelfSync to
    // ignore — the same basis the sync engine and the stale-preview guard use. Rendering raw text
    // meant an ignored `updated:` bump drew a red/green changed line, so the modal contradicted the
    // setting and invented a conflict the engine did not consider one.
    this.renderDiff(c, theirs, mine, this.plugin.ignorePatternsForPath(original));

    new Setting(c)
      // Copy FIRST: reaching for the text should never require committing to a side. It puts both
      // versions verbatim plus the marked-up diff on the clipboard, so the note can be repaired by
      // hand in an editor — including on mobile, where selecting text inside a modal is painful
      // (issueConflictDiffNotCopyable).
      .addButton((b) => b.setButtonText("Copy both versions").onClick(() => void this.copyDetails(copy, original, theirs, mine)))
      // Keep both (owner: "most of the time i just want to preserve data"): the copy becomes an ordinary note
      // beside the original, both sync, nothing is merged in an editor. The safe default when unsure.
      .addButton((b) => { this.keepButtons.push(b); b.setButtonText("Keep both").onClick(() => void this.resolve(copy, original, "both", undefined, b)); })
      // Each keep-button carries the diff's own sign, so the choice reads straight off the colours above.
      .addButton((b) => { this.keepButtons.push(b); b.setButtonText("Keep − other device's").onClick(() => void this.resolve(copy, original, "theirs", theirs, b)); })
      // No CTA (highlighted default) here: this is an unbiased, irreversible either-side choice, and a
      // highlighted default invites a reflexive tap that discards the OTHER device's edits (capture error).
      .addButton((b) => { this.keepButtons.push(b); b.setButtonText("Keep + this device's").onClick(() => void this.resolve(copy, original, "mine", theirs, b)); })
      // Last: the hand-merge path. Slow (opens both files in the editor) and rarely what is wanted.
      .addButton((b) => b.setButtonText("Open both to merge").onClick(() => void this.merge(copy, original)));
    this.gate.refresh(); // the buttons exist now - apply the current busy state to them
  }

  // The no-diff view for a binary / oversize conflict: the header, one line per side (size + modified, in the
  // diff's own −/+ colours), and the two keep choices - gated like the diff view. Nothing is read from disk.
  private renderNoDiff(c: HTMLElement, count: number, copy: string, original: string,
                       so: { size: number; mtime: number } | null, sc: { size: number; mtime: number } | null, why: string) {
    c.createEl("p", { text: `${count} file${count > 1 ? "s" : ""} to resolve. “${original}” exists in two versions — ${why}. Choose by size and date:` })
      .setAttribute("style", "font-size:13px;margin-bottom:10px;opacity:.85;");
    const row = (sign: string, label: string, st: { size: number; mtime: number } | null, color: string) => {
      const line = c.createEl("div", { text: `${sign} ${label}: ${st ? fmtBytes(st.size) : "size unknown"}${st?.mtime ? `, modified ${new Date(st.mtime).toLocaleString()}` : ""}` });
      line.setAttribute("style", `color:${color};font-weight:600;font-size:12px;margin:2px 0;`);
    };
    row("−", "other device's version", so, "var(--color-red)");
    row("+", "this device's version", sc, "var(--color-green)");
    new Setting(c)
      // No preview to go stale against (nothing was displayed but sizes), so no previewedOther: the choice
      // applies to whatever the other side holds now, which is exactly what the two lines above describe.
      .addButton((b) => { this.keepButtons.push(b); b.setButtonText("Keep both").onClick(() => void this.resolve(copy, original, "both", undefined, b)); })
      .addButton((b) => { this.keepButtons.push(b); b.setButtonText("Keep − other device's").onClick(() => void this.resolve(copy, original, "theirs", undefined, b)); })
      .addButton((b) => { this.keepButtons.push(b); b.setButtonText("Keep + this device's").onClick(() => void this.resolve(copy, original, "mine", undefined, b)); });
  }

  // A real diff: shared lines dim, "− the other version" lines red, "+ this device's" lines green.
  // Capped so a huge note stays responsive.
  private renderDiff(c: HTMLElement, theirs: string, mine: string, ignorePatterns: readonly string[] = []) {
    // The legend is the ONLY thing that tells the reader which side is which, so it is not fine print:
    // the same red −/green + the diff rows use, and the same words the buttons use, so "Keep − other
    // device's" can be read straight off the colours (owner report: "no indication as to which one is −
    // and which one is +").
    const legend = c.createEl("div");
    legend.setAttribute("style", "font-size:12px;margin:6px 0 2px;display:flex;gap:14px;");
    const minus = legend.createSpan({ text: "− other device's version" });
    minus.setAttribute("style", "color:var(--color-red);font-weight:600;");
    const plus = legend.createSpan({ text: "+ this device's version" });
    plus.setAttribute("style", "color:var(--color-green);font-weight:600;");
    // maskedForDisplay, NOT normalizedContent: the latter DELETES an ignored timestamp line, which
    // hides the fact that one side has it and the other does not — so the user could not see that
    // their `created:`/`updated:` lines would be lost (issueConflictDiffHidesIgnoredLineLoss).
    const lines = unifiedLineDiff(maskedForDisplay(theirs, ignorePatterns), maskedForDisplay(mine, ignorePatterns));
    const changed = lines.filter((l) => l.sign !== " ").length;
    if (changed === 0) {
      c.createEl("p", {
        text: ignorePatterns.length
          ? "The two versions are identical apart from line endings and the timestamp fields you chose to ignore."
          : "The two versions are identical apart from line endings.",
      }).setAttribute("style", "font-size:12px;opacity:.8;");
      return;
    }
    // When the two sides differ ONLY in characters you cannot see, say so up front. Without this the
    // user is asked to choose between two lines that look byte-identical and has no way to tell them
    // apart — the reported "- tagNames: / + tagNames:" case (issueConflictDiffInvisibleChars).
    if (invisibleOnlyDifference(lines)) {
      c.createEl("p", {
        text: "These versions look identical — they differ only in characters you can't see. "
          + "Below: · trailing space, → tab, ⍽ non-breaking space, ∅ zero-width character. "
          + "They are kept as real differences because in Markdown a trailing double space is a line break.",
      }).setAttribute("style", "font-size:12px;opacity:.85;margin:6px 0 2px;");
    }
    const pre = c.createEl("pre");
    // user-select:text so the diff can be SELECTED and copied — the log modal's pre already does this.
    // Without it the text is unselectable in the modal, so a user who wants to fix the note by hand
    // has no way to get at it (issueConflictDiffNotCopyable).
    pre.setAttribute("style", "max-height:340px;overflow:auto;background:var(--background-secondary);padding:8px;border-radius:6px;font-size:12px;white-space:pre-wrap;margin:2px 0 0;line-height:1.35;user-select:text;cursor:text;");
    const shown = lines.slice(0, 400);
    for (const l of shown) {
      const color = l.sign === "+" ? "var(--color-green)" : l.sign === "-" ? "var(--color-red)" : "var(--text-muted)";
      const bg = l.sign === "+" ? "rgba(0,180,0,.10)" : l.sign === "-" ? "rgba(220,0,0,.10)" : "transparent";
      // Reveal invisibles on CHANGED lines only. Marking them in unchanged context too would put
      // dots and arrows down the whole note for no decision-making benefit.
      const text = l.sign === " " ? l.text : revealInvisible(l.text);
      const row = pre.createEl("div", { text: `${l.sign} ${text}` });
      row.setAttribute("style", `color:${color};background:${bg};`);
    }
    if (lines.length > shown.length) pre.createEl("div", { text: `… (${lines.length - shown.length} more lines)` }).setAttribute("style", "opacity:.6;");
  }

  // Put the whole conflict on the clipboard as plain text: both versions VERBATIM (not the
  // normalized/masked forms the diff renders, because the point is to repair the real file) plus the
  // marked-up diff for orientation. Deliberately not truncated — a user asking for the text to fix it
  // explicitly wants all of it.
  private async copyDetails(copy: string, original: string, theirs: string, mine: string) {
    const pats = this.plugin.ignorePatternsForPath(original);
    const lines = unifiedLineDiff(maskedForDisplay(theirs, pats), maskedForDisplay(mine, pats));
    const diff = lines.map((l) => `${l.sign} ${l.sign === " " ? l.text : revealInvisible(l.text)}`).join("\n");
    const report = [
      `SelfSync conflict: ${original}`,
      `  other device's version: ${original}`,
      `  this device's version:  ${copy}`,
      "",
      "--- DIFF (- other device, + this device; · trailing space, → tab, ⍽ non-breaking space, ∅ zero-width) ---",
      diff,
      "",
      `--- OTHER DEVICE'S VERSION (${original}) ---`,
      theirs,
      "",
      `--- THIS DEVICE'S VERSION (${copy}) ---`,
      mine,
      "",
    ].join("\n");
    try {
      await navigator.clipboard.writeText(report);
      new Notice("SelfSync: conflict copied — both versions and the diff");
    } catch {
      // Clipboard can be unavailable (permissions, or an older mobile webview). Say so rather than
      // failing silently, and leave the modal untouched so selecting the text by hand still works.
      new Notice("SelfSync: couldn't reach the clipboard — select the diff text and copy it manually");
    }
  }
  // RESOLUTION runs the FSM in resolvefsm.ts (owner, 2026-09-08: "'step by step status' is a FSM. do proper state
  // tracking"). Events come from three sources - the plugin's typed steps (onStep), the engine (busyState), the
  // clock (grace / cap) - and the pressed button paints resolveLabel(state). The other keep-buttons are disabled
  // for the duration; Copy, Open-both and Close stay live; nothing is dimmed. On done the modal advances; on
  // stale / failed it re-renders so the user reviews the new content (the notice carries the why).
  private async resolve(copy: string, original: string, choice: "mine" | "theirs" | "both", previewedOther?: string, pressed?: ButtonComponent) {
    if (resolveInFlight(this.rs)) return; // a second tap while one is in flight
    const bs = this.plugin.busyState();
    if (bs.busy) { new Notice(`SelfSync: ${bs.reason} — try again when it finishes`); return; } // belt to the gate's braces
    this.gate?.dispose(); this.gate = undefined; // the FSM drives the buttons now, not the busy gate
    for (const b of this.keepButtons) b.setDisabled(true);
    this.pressed = pressed ? { button: pressed, own: pressed.buttonEl.textContent ?? "" } : undefined;
    this.dispatch({ kind: "start" });
    try {
      const ok = await this.plugin.resolveNoteConflict(copy, original, choice, previewedOther, (step) => this.dispatch({ kind: "step", step }));
      if (!ok) { this.dispatch({ kind: "stale" }); }
      else {
        this.dispatch({ kind: "localDone" });
        await this.awaitUploadSettled(8_000);
        new Notice(`SelfSync: resolved ${original}`);
      }
    } catch (e: any) {
      this.dispatch({ kind: "error", message: String(e?.message ?? e) });
      new Notice(`SelfSync: ${e?.message ?? e}`);
    }
    this.dispatch({ kind: "reset" }); this.pressed = undefined;
    if (this.open_) await this.render(); // advance to the next conflict, or the done state
  }

  // Drive the FSM's `uploading` state from the engine + the clock until it leaves that state. The engine queue is
  // asynchronous, so busy may appear a moment later (grace 600 ms); if it never does - nothing to upload, or offline
  // (the upload happens later) - or the cap passes, the FSM completes: the modal never waits on the network.
  private awaitUploadSettled(capMs: number): Promise<void> {
    return new Promise<void>((done) => {
      const start = Date.now();
      const finish = () => { unsubscribe(); window.clearInterval(timer); done(); };
      const tick = () => {
        if (this.rs.kind !== "uploading") return finish();
        const elapsed = Date.now() - start;
        if (this.plugin.busyState().busy) this.dispatch({ kind: "engineBusy" });
        else if (this.rs.sawBusy) this.dispatch({ kind: "engineIdle" });
        else if (elapsed > 600) this.dispatch({ kind: "graceElapsed" });
        if (this.rs.kind === "uploading" && elapsed > capMs) this.dispatch({ kind: "capElapsed" });
        if (this.rs.kind !== "uploading") finish();
      };
      const unsubscribe = this.plugin.onBusyChange(tick);
      const timer = window.setInterval(tick, 150);
      tick();
    });
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
