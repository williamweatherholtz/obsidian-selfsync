import { App, Modal, Setting } from "obsidian";
import { PluginPushPreview, FileChange, PushPullOp, DiffLine, countChanges, touchedCount } from "./pushpreview";

// The Push/Pull PREVIEW confirm (nPushPullPreview): instead of a generic "this overwrites the server's
// copy" warning, show WHAT the authoritative overwrite will do (per-file overwrite/add/remove + counts),
// clearly FROM which endpoint TO which, with an on-demand line diff for the changed text settings. Resolves
// true if the user confirms the overwrite, false on cancel/dismiss — same contract as confirmModal.
export function pushPreviewModal(app: App, preview: PluginPushPreview): Promise<boolean> {
  return new Promise((resolve) => new PushPreviewModal(app, preview, resolve).open());
}

const OP_TEXT: Record<PushPullOp, string> = { overwrite: "overwrite", create: "add", delete: "remove", unchanged: "unchanged" };
// Semantic colours (theme vars): add=green, remove=red, overwrite=amber/accent. Never invents a hue.
const OP_COLOR: Record<PushPullOp, string> = {
  overwrite: "var(--text-accent)", create: "var(--color-green, var(--text-success))",
  delete: "var(--color-red, var(--text-error))", unchanged: "var(--text-muted)",
};

export class PushPreviewModal extends Modal {
  private answered = false;
  constructor(app: App, private p: PluginPushPreview, private done: (ok: boolean) => void) { super(app); }

  onOpen() {
    const verb = this.p.direction === "push" ? "Push" : "Pull";
    this.titleEl.setText(`${verb} ${this.p.name}?`);
    const c = this.contentEl; c.empty();

    // WHAT to WHERE FROM — the endpoints, stated plainly (the owner's "what are we pushing to / from").
    const ep = c.createEl("p");
    ep.setAttribute("style", "font-size:13px;margin:0 0 4px;");
    ep.setText(`Overwrite ${this.p.toLabel} with ${this.p.fromLabel}.`);

    const counts = countChanges(this.p.changes);
    const touched = touchedCount(this.p.changes);
    const changed = this.p.changes.filter((ch) => ch.op !== "unchanged");

    const sum = c.createEl("p");
    sum.setAttribute("style", "font-size:13px;font-weight:600;margin:0 0 6px;");
    if (touched === 0) {
      sum.setText("Already in sync — nothing to change.");
    } else {
      const parts: string[] = [];
      if (counts.overwrite) parts.push(`${counts.overwrite} overwritten`);
      if (counts.create) parts.push(`${counts.create} added`);
      if (counts.delete) parts.push(`${counts.delete} removed`);
      sum.setText(`${touched} file${touched === 1 ? "" : "s"} change — ${parts.join(", ")}${counts.unchanged ? `; ${counts.unchanged} unchanged` : ""}.`);
    }

    if (changed.length) {
      const list = c.createEl("div");
      list.setAttribute("style", "max-height:42vh;overflow:auto;margin:4px 0 8px;");
      for (const ch of changed) this.renderFileRow(list, ch);
    }

    new Setting(c)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) => {
        b.setButtonText(verb);
        if (touched === 0) b.setDisabled(true); else b.setWarning(); // nothing to do → only Cancel is live
        b.onClick(() => { this.answered = true; this.done(true); this.close(); });
      });
  }

  // One changed file: an op badge + its path (relative to the plugin folder) + an on-demand diff toggle.
  private renderFileRow(list: HTMLElement, ch: FileChange) {
    const row = list.createEl("div");
    row.setAttribute("style", "border-top:1px solid var(--background-modifier-border);padding:6px 2px;");
    const head = row.createEl("div");
    head.setAttribute("style", "display:flex;gap:8px;align-items:center;");
    const badge = head.createEl("span", { text: OP_TEXT[ch.op] });
    badge.setAttribute("style", `font-size:11px;font-weight:600;color:${OP_COLOR[ch.op]};min-width:64px;`);
    head.createEl("span", { text: this.shortPath(ch.path) })
      .setAttribute("style", "font-size:12px;font-family:var(--font-monospace);word-break:break-all;");

    const box = row.createEl("pre");
    box.setAttribute("style", "display:none;font-size:11px;max-height:30vh;overflow:auto;margin:6px 0 0;padding:6px;background:var(--background-secondary);border-radius:4px;");
    const toggle = head.createEl("a", { text: "Show diff" });
    toggle.setAttribute("style", "font-size:11px;margin-left:auto;cursor:pointer;white-space:nowrap;");
    let loaded = false;
    toggle.onclick = async () => {
      if (box.style.display !== "none") { box.style.display = "none"; toggle.setText("Show diff"); return; }
      box.style.display = "block"; toggle.setText("Hide diff");
      if (loaded) return;
      loaded = true; box.setText("Loading…");
      try {
        const res = await this.p.loadDiff(ch.path);
        box.empty();
        if (res === "binary") box.setText("(binary file — no text diff)");
        else if (res === "too-large") box.setText("(too large to show a diff)");
        else this.renderDiff(box, res);
      } catch (e) {
        box.setText(`(couldn't load the diff: ${e instanceof Error ? e.message : String(e)})`);
      }
    };
  }

  private renderDiff(box: HTMLElement, lines: DiffLine[]) {
    if (!lines.length) { box.setText("(no line-level changes)"); return; }
    for (const l of lines) {
      const el = box.createEl("div", { text: (l.type === "add" ? "+ " : l.type === "del" ? "- " : "  ") + l.text });
      const col = l.type === "add" ? "var(--color-green, var(--text-success))"
        : l.type === "del" ? "var(--color-red, var(--text-error))" : "var(--text-muted)";
      el.setAttribute("style", `color:${col};white-space:pre-wrap;margin:0;`);
    }
  }

  // Strip the `.obsidian/plugins/<id>/` prefix so the row shows just `data.json`, `styles.css`, etc.
  private shortPath(p: string): string {
    const m = /\.obsidian\/plugins\/[^/]+\/(.*)$/.exec(p);
    return m ? m[1] : p;
  }

  onClose() { this.contentEl.empty(); if (!this.answered) this.done(false); } // dismissed = cancelled
}
