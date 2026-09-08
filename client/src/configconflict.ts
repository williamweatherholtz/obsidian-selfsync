import { App, ButtonComponent, Modal, Notice, Setting } from "obsidian";
import { mountBusyGate, type BusyGate } from "./busygate";
import type SelfSyncPlugin from "./main";
import { groupConfigConflicts, ConflictGroup } from "./configsync";

// Adjudicate divergent `.obsidian/` config across devices. Config sync never auto-deletes and
// never resurrects; when a config file was edited differently on two devices it's queued here and
// the user picks a side — grouped so a whole PLUGIN is one choice (not one click per file), and
// labelled by what it is (not a raw filename). Resolving updates the list, which is grouped +
// self-clearing, so the count can't go stale.
export class ConfigConflictModal extends Modal {
  constructor(app: App, private plugin: SelfSyncPlugin) { super(app); }

  private gate?: BusyGate;
  private sideButtons: ButtonComponent[] = [];
  onOpen() { this.titleEl.setText("Config differences"); void this.render(); }
  onClose() { this.gate?.dispose(); this.gate = undefined; this.contentEl.empty(); }

  private async render() {
    const c = this.contentEl; c.empty();
    const groups = groupConfigConflicts(this.plugin.getConfigConflicts());
    if (groups.length === 0) {
      c.createEl("p", { text: "No config differences to resolve — everything is in sync." });
      new Setting(c).addButton((b) => b.setButtonText("Close").setCta().onClick(() => this.close()));
      return;
    }
    this.gate?.dispose(); this.sideButtons = [];
    this.gate = mountBusyGate(this.plugin, c, () => this.sideButtons, "Resolving"); // busy banner + disabled side buttons while a pass runs
    c.createEl("p", {
      text: "These settings and plugins differ across your devices. Nothing was deleted or overwritten — for each, keep this device's version or take the server's (your other device's) version.",
    }).setAttribute("style", "font-size:13px;margin-bottom:12px;opacity:.85;");

    for (const g of groups) {
      // Aggregate presence across the group's paths so the row can say which side has it.
      let local = false, remote = false;
      for (const p of g.paths) { const s = await this.plugin.configConflictSides(p); local ||= s.local; remote ||= s.remote; }
      const desc = local && remote ? "Differs across your devices."
        : local ? "On this device, not on the server's version."
        : "On the server's version, not on this device.";
      new Setting(c)
        .setName(g.label)
        .setDesc(desc)
        // Standardized vocabulary ("this device's" / "the server's version") + no CTA on this unbiased
        // both-edited choice, matching the note-conflict modal.
        .addButton((b) => { this.sideButtons.push(b); b.setButtonText("Use this device's").onClick(() => void this.resolve(g, "local")); })
        .addButton((b) => { this.sideButtons.push(b); b.setButtonText("Use the server's version").onClick(() => void this.resolve(g, "remote")); });
    }
    this.gate.refresh();
  }

  private async resolve(g: ConflictGroup, choice: "local" | "remote") {
    const bs = this.plugin.busyState();
    if (bs.busy) { new Notice(`SelfSync: ${bs.reason} — try again when it finishes`); return; }
    try {
      await this.plugin.resolveConfigGroup(g.paths, choice);
      new Notice(`SelfSync: resolved ${g.label}`);
    } catch (e: any) {
      new Notice(`SelfSync: ${e?.message ?? e}`);
    }
    void this.render(); // the resolved group drops off; count self-updates
  }
}
