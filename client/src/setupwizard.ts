import { App, Modal, Notice, Setting } from "obsidian";
import { HttpTransport } from "./transport";
import { parseSetupLink } from "./connstr";
import { WizardState, canLogIn, canFinish, isValidVaultName } from "./wizardsteps";
import type NewLiveSyncPlugin from "./main";

// Guided first-run setup, all in ONE pane: Server → Account → Vault, revealed progressively.
// "Test" checks reachability (green ✓); "Log in" authenticates and loads the vault list; "Start
// syncing" finishes. A pasted setup link prefills server + username. No multi-step nav / welcome
// chooser — everything is visible on the single pane.
export class SetupWizardModal extends Modal {
  private token = "";
  private serverMsg = ""; // Test-connection result, persisted across re-renders
  private s: WizardState;

  constructor(app: App, private plugin: NewLiveSyncPlugin) {
    super(app);
    const st = plugin.settings;
    this.s = {
      server: st.serverUrl ?? "", serverOk: false, mode: "login",
      username: st.username ?? "", password: "", loggedIn: false,
      vaults: [], chosenVault: st.vaultId ?? "", newVault: "",
    };
  }

  onOpen() { this.render(); }
  onClose() { this.contentEl.empty(); }

  // Re-rendered on button actions (Test / Log in / Sign out); text fields update state via onChange
  // and are re-seeded from state, so their values survive a re-render.
  private render() {
    const c = this.contentEl; c.empty();
    this.titleEl.setText("Set up SelfSync");

    new Setting(c).setName("Have a setup link?").setDesc("Prefill the server and account from a link created on another device.")
      .addButton((b) => b.setButtonText("Paste setup link").onClick(() => this.promptSetupLink()));

    // ── Server ──
    new Setting(c).setName("Server").setHeading();
    new Setting(c).setName("Server URL")
      .addText((t) => t.setPlaceholder("https://sync.example.com").setValue(this.s.server)
        .onChange((v) => { this.s.server = v.trim(); this.s.serverOk = false; this.serverMsg = ""; }))
      .addButton((b) => b.setButtonText(this.s.serverOk ? "Reachable ✓" : "Test").setDisabled(!this.s.server).onClick(() => void this.doTest()));
    if (this.serverMsg) {
      c.createEl("p", { text: this.serverMsg })
        .setAttribute("style", this.s.serverOk ? "font-size:12px;color:var(--color-green);margin:0 0 8px;" : "font-size:12px;opacity:0.85;margin:0 0 8px;");
    }

    // ── Account ── (collapses to a "Signed in" line once authenticated)
    new Setting(c).setName("Account").setHeading();
    if (this.s.loggedIn) {
      new Setting(c).setName("Signed in").setDesc(`${this.s.username} ✓`)
        .addButton((b) => b.setButtonText("Sign out").onClick(() => {
          this.s.loggedIn = false; this.s.vaults = []; this.s.password = ""; this.render();
        }));
    } else {
      new Setting(c).setName("Mode")
        .addDropdown((dd) => dd.addOption("login", "Log in").addOption("register", "Create account")
          .setValue(this.s.mode).onChange((v) => { this.s.mode = v as "login" | "register"; }));
      new Setting(c).setName("Username").addText((t) => t.setValue(this.s.username).onChange((v) => { this.s.username = v.trim(); }));
      new Setting(c).setName("Password").addText((t) => { t.inputEl.type = "password"; t.setValue(this.s.password).onChange((v) => { this.s.password = v; }); });
      new Setting(c).addButton((b) => b.setButtonText(this.s.mode === "login" ? "Log in" : "Create & log in").setCta()
        .setDisabled(!canLogIn(this.s)).onClick(() => void this.doLogin()));
    }

    // ── Vault ── (needs a login to list what exists)
    new Setting(c).setName("Vault").setHeading();
    if (!this.s.loggedIn) {
      new Setting(c).setDesc("Log in to choose or create a vault.");
    } else {
      if (this.s.vaults.length) {
        new Setting(c).setName("Sync this vault to")
          .addDropdown((dd) => { for (const v of this.s.vaults) dd.addOption(v, v); dd.setValue(this.s.chosenVault).onChange((v) => { this.s.chosenVault = v; this.s.newVault = ""; }); });
      } else {
        new Setting(c).setDesc("No remote vaults yet — create one below.");
      }
      new Setting(c).setName("Or create a new vault")
        .addText((t) => t.setPlaceholder("e.g. notes").setValue(this.s.newVault).onChange((v) => { this.s.newVault = v.trim(); }));
    }

    // ── Finish ──
    new Setting(c).addButton((b) => b.setButtonText("Start syncing").setCta().setDisabled(!canFinish(this.s)).onClick(() => void this.finish()));
  }

  private promptSetupLink() {
    const c = this.contentEl; c.empty();
    this.titleEl.setText("Paste setup link");
    let text = "";
    new Setting(c).setName("Setup link").setDesc("selfsync://… from another device")
      .addText((t) => t.setPlaceholder("selfsync://connect?…").onChange((v) => { text = v; }));
    new Setting(c)
      .addButton((b) => b.setButtonText("Back").onClick(() => this.render()))
      .addButton((b) => b.setButtonText("Use link").setCta().onClick(() => {
        try {
          const link = parseSetupLink(text);
          this.s.server = link.server; this.s.username = link.user; this.s.serverOk = false; this.serverMsg = "";
          if (link.vault) this.s.chosenVault = link.vault; // pre-select the shared vault (kept if the account has it)
          this.render();
        } catch (e: any) { new Notice(`SelfSync: ${e?.message ?? e}`); }
      }));
  }

  private async doTest() {
    this.s.serverOk = await HttpTransport.testConnection(this.s.server);
    this.serverMsg = this.s.serverOk
      ? "Reachable ✓"
      : (/\/\/(127\.0\.0\.1|localhost)/.test(this.s.server)
          ? "Couldn't reach that server. Note: on a phone, 127.0.0.1/localhost is the phone itself — use the server's LAN IP or https address."
          : "Couldn't reach that server. Check the URL and that the server is running.");
    this.render();
  }

  private async doLogin() {
    try {
      if (this.s.mode === "register") await HttpTransport.register(this.s.server, this.s.username, this.s.password);
      this.token = await HttpTransport.login(this.s.server, this.s.username, this.s.password);
      this.s.vaults = await HttpTransport.listVaults(this.s.server, this.token);
      // Keep a vault pre-selected from a setup link if the account actually has it; else default to the first.
      this.s.chosenVault = this.s.vaults.includes(this.s.chosenVault) ? this.s.chosenVault : (this.s.vaults[0] ?? this.s.chosenVault);
      this.s.loggedIn = true;
      this.s.serverOk = true; this.serverMsg = "Reachable ✓"; // a successful login proves reachability
      this.render();
    } catch (e: any) {
      new Notice(`SelfSync: ${this.friendlyAuthError(e)}`);
    }
  }

  private friendlyAuthError(e: any): string {
    const m = String(e?.message ?? e);
    if (m.includes("401") && this.s.mode === "register") return "This server doesn't allow new accounts. Ask the admin for login details.";
    if (m.includes("401")) return "Wrong username or password.";
    return m;
  }

  private async finish() {
    try {
      let vault = this.s.chosenVault;
      if (this.s.newVault) {
        if (!isValidVaultName(this.s.newVault)) { new Notice("SelfSync: vault name — use letters, numbers, dots, dashes or underscores (max 64)."); return; }
        await HttpTransport.createVault(this.s.server, this.token, this.s.newVault); vault = this.s.newVault;
      }
      if (!vault) { new Notice("SelfSync: pick or name a vault"); return; }
      const st = this.plugin.settings;
      st.serverUrl = this.s.server; st.username = this.s.username; st.password = this.s.password;
      st.vaultId = vault; st.authToken = this.token;
      await this.plugin.saveSettings();
      new Notice(`SelfSync: now syncing '${vault}'`);
      this.close();
      void this.plugin.reconnect();
    } catch (e: any) { new Notice(`SelfSync: ${e?.message ?? e}`); }
  }
}
