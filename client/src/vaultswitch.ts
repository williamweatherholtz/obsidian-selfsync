import { App, Modal, Notice, Setting } from "obsidian";
import type NewLiveSyncPlugin from "./main";

// Switch which remote vault this Obsidian vault syncs to — WITHOUT re-asking for the
// server or account. We're already signed in, so this reuses the existing session
// (cached token, or a silent re-login with the stored password) to list vaults.
export class SwitchVaultModal extends Modal {
  private vaults: string[] = [];
  private chosen = "";
  private newName = "";
  private loading = true;
  private error = "";

  constructor(app: App, private plugin: NewLiveSyncPlugin) { super(app); }

  onOpen() { this.titleEl.setText("Switch remote vault"); this.render(); void this.load(); }
  onClose() { this.contentEl.empty(); }

  private async load() {
    try {
      this.vaults = await this.plugin.currentVaults();
      this.chosen = this.plugin.settings.vaultId || this.vaults[0] || "";
    } catch {
      this.error = "Couldn't reach the server with your saved login. Open full setup to re-connect.";
    }
    this.loading = false;
    this.render();
  }

  private render() {
    const c = this.contentEl; c.empty();
    const s = this.plugin.settings;
    c.createEl("p", { text: `Signed in as ${s.username} · ${s.serverUrl}` })
      .setAttribute("style", "font-size:12px;opacity:.7;margin-bottom:8px;");

    if (this.loading) { c.createEl("p", { text: "Loading vaults…" }); return; }
    if (this.error) {
      c.createEl("p", { text: this.error });
      new Setting(c).addButton((b) => b.setButtonText("Open full setup").setCta()
        .onClick(() => { this.close(); this.plugin.openSetup(); }));
      return;
    }

    if (this.vaults.length) {
      new Setting(c).setName("Sync this vault to")
        .addDropdown((dd) => {
          for (const v of this.vaults) dd.addOption(v, v);
          dd.setValue(this.chosen).onChange((v) => { this.chosen = v; this.newName = ""; });
        });
    } else {
      c.createEl("p", { text: "No remote vaults yet — create one below." });
    }
    new Setting(c).setName("Or create a new vault")
      .addText((t) => t.setPlaceholder("e.g. notes").onChange((v) => { this.newName = v.trim(); }));
    new Setting(c).addButton((b) => b.setButtonText("Switch").setCta().onClick(() => void this.doSwitch()));
  }

  private async doSwitch() {
    try {
      let vault = this.chosen;
      if (this.newName) { await this.plugin.createRemoteVault(this.newName); vault = this.newName; }
      if (!vault) { new Notice("SelfSync: pick or name a vault"); return; }
      this.close();
      await this.plugin.switchToVault(vault);
      new Notice(`SelfSync: now syncing '${vault}'`);
    } catch (e: any) {
      new Notice(`SelfSync: ${e?.message ?? e}`);
    }
  }
}
