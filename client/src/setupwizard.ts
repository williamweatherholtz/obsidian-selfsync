import { App, Modal, Notice, Setting } from "obsidian";
import { HttpTransport } from "./transport";
import { parseSetupLink } from "./connstr";
import { isShareLink } from "./sharelink";
import { RedeemShareLinkModal } from "./accountui";
import { WizardState, canLogIn, canFinish, isValidVaultName, sanitizeVaultName, wizardCredentials } from "./wizardsteps";
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
  // and are re-seeded from state, so their values survive a re-render. After each render we place
  // focus on the field the user should fill next and wire Enter to advance — so keyboard flow is
  // top-to-bottom and a re-render never strands focus (which read as tab order being "all over").
  private render() {
    const c = this.contentEl; c.empty();
    this.titleEl.setText("Set up SelfSync");
    let serverInput: HTMLInputElement | undefined;
    let usernameInput: HTMLInputElement | undefined;
    let passwordInput: HTMLInputElement | undefined;
    let newVaultInput: HTMLInputElement | undefined;
    const onEnter = (el: HTMLInputElement | undefined, fn: () => void) =>
      el?.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); fn(); } });

    new Setting(c).setName("Have a setup link?").setDesc("Prefill the server and account from a link created on another device.")
      .addButton((b) => b.setButtonText("Paste setup link").onClick(() => this.promptSetupLink()));

    // ── Server ──
    new Setting(c).setName("Server").setHeading();
    new Setting(c).setName("Server URL")
      .addText((t) => { serverInput = t.inputEl; t.setPlaceholder("https://sync.example.com").setValue(this.s.server)
        .onChange((v) => { this.s.server = v.trim(); this.s.serverOk = false; this.serverMsg = ""; }); })
      .addButton((b) => b.setButtonText(this.s.serverOk ? "Reachable ✓" : "Test").onClick(() => void this.doTest()));
    onEnter(serverInput, () => { if (this.s.server) void this.doTest(); });
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
      new Setting(c).setName("Username").addText((t) => { usernameInput = t.inputEl; t.setValue(this.s.username).onChange((v) => { this.s.username = v.trim(); }); });
      new Setting(c).setName("Password").addText((t) => { passwordInput = t.inputEl; t.inputEl.type = "password"; t.setValue(this.s.password).onChange((v) => { this.s.password = v; }); });
      new Setting(c).addButton((b) => b.setButtonText(this.s.mode === "login" ? "Log in" : "Create & log in").setCta()
        .onClick(() => void this.doLogin()));
      onEnter(usernameInput, () => passwordInput?.focus());
      onEnter(passwordInput, () => { if (canLogIn(this.s)) void this.doLogin(); });
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
        .addText((t) => { newVaultInput = t.inputEl; t.setPlaceholder("e.g. notes").setValue(this.s.newVault).onChange((v) => { const n = sanitizeVaultName(v); this.s.newVault = n; if (newVaultInput && newVaultInput.value !== n) newVaultInput.value = n; }); });
      onEnter(newVaultInput, () => { if (canFinish(this.s)) void this.finish(); });
    }

    // ── Finish ──
    new Setting(c).addButton((b) => b.setButtonText("Start syncing").setCta().onClick(() => void this.finish()));

    // Focus the next field to fill: the first blank of server → username → password before login,
    // then the create-vault box after. Deferred a tick so it wins over the modal's default focus.
    const target = !this.s.loggedIn
      ? (!this.s.server ? serverInput : (!this.s.username ? usernameInput : passwordInput))
      : newVaultInput;
    if (target) window.setTimeout(() => target.focus(), 0);
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
        // A vault SHARE link (selfsync-share://redeem?…) is a different thing from a device SETUP link
        // (selfsync://connect?…). If someone pastes a share link here, hand off to the redeem flow
        // instead of failing with "Not a SelfSync setup link".
        if (isShareLink(text)) { this.close(); new RedeemShareLinkModal(this.app, this.plugin, text).open(); return; }
        try {
          const link = parseSetupLink(text);
          this.s.server = link.server; this.s.username = link.user; this.s.serverOk = false; this.serverMsg = "";
          if (link.vault) this.s.chosenVault = link.vault; // pre-select the shared vault (kept if the account has it)
          this.render();
        } catch (e: any) { new Notice(`SelfSync: ${e?.message ?? e}`); }
      }));
  }

  private async doTest() {
    if (!this.s.server) { new Notice("SelfSync: enter a server URL first"); return; }
    this.s.serverOk = await HttpTransport.testConnection(this.s.server);
    if (this.s.serverOk) {
      // AC.3.1.9: surface the server's system-use/consent banner (if any) before the user signs in.
      const banner = await HttpTransport.fetchBanner(this.s.server);
      this.serverMsg = banner ? `Reachable ✓\n\n${banner}` : "Reachable ✓";
    } else {
      this.serverMsg = /\/\/(127\.0\.0\.1|localhost)/.test(this.s.server)
        ? "Couldn't reach that server. Note: on a phone, 127.0.0.1/localhost is the phone itself — use the server's LAN IP or https address."
        : "Couldn't reach that server. Check the URL and that the server is running.";
    }
    this.render();
  }

  private async doLogin() {
    if (!canLogIn(this.s)) { new Notice("SelfSync: enter the server, username, and password"); return; }
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
    if (!this.s.loggedIn) { new Notice("SelfSync: log in first, then choose a vault"); return; }
    try {
      let vault = this.s.chosenVault;
      if (this.s.newVault) {
        const name = sanitizeVaultName(this.s.newVault);
        if (!isValidVaultName(name)) { new Notice("SelfSync: vault name — lowercase letters, numbers, dots, dashes or underscores (max 64)."); return; }
        await HttpTransport.createVault(this.s.server, this.token, name); vault = name;
      }
      if (!vault) { new Notice("SelfSync: pick or name a vault"); return; }
      const st = this.plugin.settings;
      // Token-only-at-rest is the default (st.storePassword === false): we already hold a session token,
      // so the plaintext password must NOT be written to data.json. wizardCredentials() decides this
      // (pure + unit-tested). Setting authToken means the connect path uses the token and never runs
      // freshLogin — the only other place that clears the password — so clearing it here is what
      // actually honors the contract.
      const cred = wizardCredentials(this.s, vault, this.token, st.storePassword);
      st.serverUrl = cred.serverUrl; st.username = cred.username; st.password = cred.password;
      st.vaultId = cred.vaultId; st.authToken = cred.authToken;
      await this.plugin.saveSettings();
      new Notice(`SelfSync: now syncing '${vault}'`);
      this.close();
      void this.plugin.reconnect();
    } catch (e: any) { new Notice(`SelfSync: ${e?.message ?? e}`); }
  }
}
