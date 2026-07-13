import { App, Modal, Setting } from "obsidian";
import type { ConfigDirection } from "./configsync";

// Asks the FIRST-CONTACT direction when a config surface is turned on — the settings-sync parallel to
// the vault-switch download/upload prompt. No "merge": config files are opaque blobs (a line-merge
// could produce invalid/nonsense settings), so the only sane first-contact resolution is to take one
// whole side. On a read-only shared vault only "download" is offered (we can never push). `onChoose`
// fires only on a real pick; a cancel leaves the surface untouched (the caller re-renders to revert).
export class ConfigDirectionModal extends Modal {
  private chose = false;
  constructor(
    app: App,
    private label: string,
    private readOnly: boolean,
    private onChoose: (dir: ConfigDirection) => void,
    private onCancel?: () => void,
  ) { super(app); }

  onOpen() {
    this.titleEl.setText("Set up settings sync");
    const c = this.contentEl; c.empty();
    c.createEl("p", { text: `Turning on sync for ${this.label}. When this device's settings differ from the synced copy, which should win to start?` })
      .setAttribute("style", "font-size:13px;margin-bottom:10px;");

    new Setting(c).setName("Use the synced settings")
      .setDesc("Adopt what's already synced, replacing this device's version where they differ (download).")
      .addButton((b) => b.setButtonText("Use the synced version").onClick(() => this.pick("download")));

    if (!this.readOnly) {
      new Setting(c).setName("Use this device's settings")
        .setDesc("Make this device's settings the shared ones, overwriting the synced copy where they differ (upload).")
        .addButton((b) => b.setButtonText("Use this device's").setWarning().onClick(() => this.pick("upload")));
    } else {
      c.createEl("p", { text: "This is a read-only shared vault, so it can only adopt the owner's settings (download)." })
        .setAttribute("style", "font-size:12px;opacity:.75;");
    }

    new Setting(c).addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
  }

  private pick(dir: ConfigDirection) { this.chose = true; this.onChoose(dir); this.close(); }
  onClose() { this.contentEl.empty(); if (!this.chose) this.onCancel?.(); }
}
