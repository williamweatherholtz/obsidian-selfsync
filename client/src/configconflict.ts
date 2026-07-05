import { App, Modal, Notice, Setting } from "obsidian";
import type NewLiveSyncPlugin from "./main";
import { pluginIdOf } from "./configsync";

// Adjudicate divergent/removed `.obsidian/` config across devices. Config sync never
// auto-deletes and never resurrects (that's the data-resurrection anti-pattern); when a
// config file was removed on one device or edited differently on both, it's queued here and
// the user decides which side wins — per file. "Keep this device's" makes the local copy
// canonical (or, if it was removed here, propagates that removal); "Use the other device's"
// pulls the server copy (or adopts the removal locally).
export class ConfigConflictModal extends Modal {
  constructor(app: App, private plugin: NewLiveSyncPlugin) { super(app); }

  onOpen() { this.titleEl.setText("Config differences"); void this.render(); }
  onClose() { this.contentEl.empty(); }

  // A human label for a config path (plugin id, well-known file, or the bare relative path).
  private label(path: string): string {
    const id = pluginIdOf(path);
    if (id) return `Plugin: ${id}`;
    const rel = path.replace(/^\.obsidian\//, "");
    const known: Record<string, string> = {
      "community-plugins.json": "Enabled community plugins",
      "core-plugins.json": "Enabled core plugins",
      "app.json": "App settings",
      "appearance.json": "Appearance settings",
      "hotkeys.json": "Hotkeys",
    };
    return known[rel] ?? rel;
  }

  private async render() {
    const c = this.contentEl; c.empty();
    const paths = this.plugin.getConfigConflicts();
    if (paths.length === 0) {
      c.createEl("p", { text: "No config differences to resolve — everything is in sync." });
      new Setting(c).addButton((b) => b.setButtonText("Close").setCta().onClick(() => this.close()));
      return;
    }
    c.createEl("p", {
      text: "These settings/plugins differ across your devices. Nothing was deleted or overwritten automatically — choose which version to keep for each. This device's choice becomes the shared one.",
    }).setAttribute("style", "font-size:13px;margin-bottom:12px;opacity:.85;");

    for (const path of paths) {
      const sides = await this.plugin.configConflictSides(path);
      const here = sides.local ? "present here" : "removed here";
      const there = sides.remote ? "present on the server" : "removed on the server";
      new Setting(c)
        .setName(this.label(path))
        .setDesc(`${path} — ${here}, ${there}`)
        .addButton((b) => b.setButtonText("Keep this device's").setCta()
          .onClick(() => void this.resolve(path, "local")))
        .addButton((b) => b.setButtonText("Use the other device's")
          .onClick(() => void this.resolve(path, "remote")));
    }
  }

  private async resolve(path: string, choice: "local" | "remote") {
    try {
      await this.plugin.resolveConfigConflict(path, choice);
      new Notice(`SelfSync: resolved '${path}'`);
    } catch (e: any) {
      new Notice(`SelfSync: ${e?.message ?? e}`);
    }
    void this.render(); // refresh: the resolved item drops off the list
  }
}
