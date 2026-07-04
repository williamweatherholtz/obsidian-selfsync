import { App, Modal, Notice, Setting } from "obsidian";
import { HttpTransport } from "./transport";
import type NewLiveSyncPlugin from "./main";

// Onboarding: server URL → log in (or register) → pick or create the server vault
// this Obsidian vault syncs to. Saves settings and triggers a reconnect.
export class OnboardingModal extends Modal {
  private mode: "login" | "register" = "login";

  constructor(app: App, private plugin: NewLiveSyncPlugin) { super(app); }

  onOpen() {
    this.titleEl.setText("SelfSync — set up");
    this.render();
  }
  onClose() { this.contentEl.empty(); }

  private render() {
    const c = this.contentEl;
    c.empty();
    const s = this.plugin.settings;

    new Setting(c).setName("Server URL").addText((t) =>
      t.setValue(s.serverUrl).onChange((v) => { s.serverUrl = v.trim(); }));
    new Setting(c).setName("Username").addText((t) =>
      t.setValue(s.username).onChange((v) => { s.username = v.trim(); }));
    new Setting(c).setName("Password").addText((t) => {
      t.inputEl.type = "password";
      t.setValue(s.password).onChange((v) => { s.password = v; });
    });
    new Setting(c).setName("Mode")
      .setDesc(this.mode === "login" ? "Log in to an existing account." : "Create a new account (if the server allows it).")
      .addDropdown((dd) => dd
        .addOption("login", "Log in")
        .addOption("register", "Register")
        .setValue(this.mode)
        .onChange((v) => { this.mode = v as "login" | "register"; }));

    new Setting(c).addButton((b) =>
      b.setButtonText(this.mode === "login" ? "Log in" : "Register & log in").setCta()
        .onClick(() => void this.connectAndPickVault()));
  }

  private async connectAndPickVault() {
    const s = this.plugin.settings;
    try {
      if (this.mode === "register") {
        await HttpTransport.register(s.serverUrl, s.username, s.password);
        new Notice("SelfSync: account created");
      }
      const token = await HttpTransport.login(s.serverUrl, s.username, s.password);
      const vaults = await HttpTransport.listVaults(s.serverUrl, token);
      this.renderVaultPicker(token, vaults);
    } catch (e: any) {
      new Notice(`SelfSync: ${e?.message ?? e}`);
    }
  }

  private renderVaultPicker(token: string, vaults: string[]) {
    const c = this.contentEl;
    c.empty();
    this.titleEl.setText("SelfSync — choose a vault");
    const s = this.plugin.settings;
    let chosen = vaults[0] ?? "";
    let newName = "";

    if (vaults.length) {
      new Setting(c).setName("Sync this Obsidian vault to")
        .addDropdown((dd) => { for (const v of vaults) dd.addOption(v, v); dd.setValue(chosen).onChange((v) => { chosen = v; }); });
    } else {
      c.createEl("p", { text: "No vaults yet — create one below." });
    }

    new Setting(c).setName("Or create a new vault")
      .addText((t) => t.setPlaceholder("e.g. notes").onChange((v) => { newName = v.trim(); }));

    new Setting(c).addButton((b) =>
      b.setButtonText("Use this vault").setCta().onClick(async () => {
        try {
          let vault = chosen;
          if (newName) { await HttpTransport.createVault(s.serverUrl, token, newName); vault = newName; }
          if (!vault) { new Notice("SelfSync: pick or name a vault"); return; }
          s.vaultId = vault;
          await this.plugin.saveSettings();
          this.close();
          new Notice(`SelfSync: syncing to '${vault}'`);
          void this.plugin.reconnect();
        } catch (e: any) { new Notice(`SelfSync: ${e?.message ?? e}`); }
      }));
  }
}
