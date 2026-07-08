import { App, Modal, Notice, Setting } from "obsidian";
import type NewLiveSyncPlugin from "./main";

// Walk through unresolved note conflicts one at a time. A conflict copy holds THIS device's version,
// kept beside the note (which holds the other device's version) when concurrent edits couldn't merge
// cleanly. For each: keep this version, keep the other, or open both to merge by hand. The set is
// DERIVED from the vault, so resolving one drops it off and the count self-updates — no stale list.
export class NoteConflictModal extends Modal {
  constructor(app: App, private plugin: NewLiveSyncPlugin) { super(app); }

  onOpen() { this.titleEl.setText("Resolve conflicts"); void this.render(); }
  onClose() { this.contentEl.empty(); }

  private async render() {
    const c = this.contentEl; c.empty();
    const conflicts = this.plugin.listNoteConflicts();
    if (conflicts.length === 0) {
      c.createEl("p", { text: "No conflicts to resolve — everything is in sync." });
      new Setting(c).addButton((b) => b.setButtonText("Close").setCta().onClick(() => this.close()));
      return;
    }
    const { copy, original } = conflicts[0];
    c.createEl("p", { text: `${conflicts.length} file${conflicts.length > 1 ? "s" : ""} to resolve. “${original}” was edited on two devices at once:` })
      .setAttribute("style", "font-size:13px;margin-bottom:10px;opacity:.85;");

    this.preview(c, "This device's version", await this.plugin.readTextOrEmpty(copy));
    this.preview(c, "The other version (currently on disk)", await this.plugin.readTextOrEmpty(original));

    new Setting(c)
      .addButton((b) => b.setButtonText("Open both to merge").onClick(() => void this.merge(copy, original)))
      .addButton((b) => b.setButtonText("Keep the other").onClick(() => void this.resolve(copy, original, "theirs")))
      .addButton((b) => b.setButtonText("Keep this device's").setCta().onClick(() => void this.resolve(copy, original, "mine")));
  }

  private preview(c: HTMLElement, label: string, text: string) {
    c.createEl("div", { text: label }).setAttribute("style", "font-weight:600;font-size:12px;margin-top:8px;");
    const shown = text.length > 2000 ? text.slice(0, 2000) + "\n…" : (text || "(empty)");
    c.createEl("pre", { text: shown })
      .setAttribute("style", "max-height:180px;overflow:auto;background:var(--background-secondary);padding:8px;border-radius:6px;font-size:12px;white-space:pre-wrap;margin:2px 0 0;");
  }

  private async resolve(copy: string, original: string, choice: "mine" | "theirs") {
    try {
      await this.plugin.resolveNoteConflict(copy, original, choice);
      new Notice(`SelfSync: resolved ${original}`);
    } catch (e: any) { new Notice(`SelfSync: ${e?.message ?? e}`); }
    void this.render(); // advance to the next conflict, or the done state
  }

  private async merge(copy: string, original: string) {
    await this.plugin.resolveNoteConflict(copy, original, "manual");
    this.close(); // hand off to the editor; the copy stays listed until the user deletes it
  }
}
