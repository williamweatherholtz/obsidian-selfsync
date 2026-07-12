import { App, Modal, Notice, Setting } from "obsidian";
import { HttpTransport } from "./transport";
import { parseSetupLink } from "./connstr";
import { isShareLink, parseShareLink } from "./sharelink";
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
  // When set (opened from a share link), the wizard is in REDEEM mode: the server is fixed by the link
  // and the goal is to sign in + redeem it, not pick/create a vault. See finishRedeem().
  private pendingShareLink = "";

  constructor(app: App, private plugin: NewLiveSyncPlugin, opts: { shareLink?: string } = {}) {
    super(app);
    const st = plugin.settings;
    this.pendingShareLink = opts.shareLink ?? "";
    // A share link fixes the server (that's the whole point — you don't need to be set up first).
    let linkServer = "";
    if (this.pendingShareLink) { try { linkServer = parseShareLink(this.pendingShareLink).server; } catch { /* handled on submit */ } }
    this.s = {
      server: linkServer || (st.serverUrl ?? ""), serverOk: false, mode: "login",
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
    const redeeming = Boolean(this.pendingShareLink);
    this.titleEl.setText(redeeming ? "Get access to a shared vault" : "Set up SelfSync");
    let serverInput: HTMLInputElement | undefined;
    let usernameInput: HTMLInputElement | undefined;
    let passwordInput: HTMLInputElement | undefined;
    let newVaultInput: HTMLInputElement | undefined;
    const onEnter = (el: HTMLInputElement | undefined, fn: () => void) =>
      el?.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); fn(); } });

    if (redeeming) {
      c.createEl("p", { text: `Someone shared a vault with you on ${this.s.server}. Sign in to your account on that server to get access — you don't need to be set up first.` })
        .setAttribute("style", "font-size:13px;margin-bottom:10px;");
    } else {
      new Setting(c).setName("Have a setup link?").setDesc("Prefill the server and account from a link created on another device.")
        .addButton((b) => b.setButtonText("Paste setup link").onClick(() => this.promptSetupLink()));
    }

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
      new Setting(c).addButton((b) => b.setButtonText(
        redeeming ? (this.s.mode === "login" ? "Log in & get access" : "Create account & get access")
                  : (this.s.mode === "login" ? "Log in" : "Create & log in")).setCta()
        .onClick(() => void this.doLogin()));
      onEnter(usernameInput, () => passwordInput?.focus());
      onEnter(passwordInput, () => { if (canLogIn(this.s)) void this.doLogin(); });
    }

    // ── Vault ── (needs a login to list what exists). SKIPPED in redeem mode: the vault comes from
    // the share link, added automatically after sign-in (finishRedeem).
    if (!redeeming) {
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
    }

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
        // (selfsync://connect?…). Pasting one here switches the wizard into REDEEM mode: prefill the
        // server from the link and guide the user through sign-in, then redeem automatically. No need
        // to be set up first — the link IS the onboarding.
        if (isShareLink(text)) {
          try {
            this.pendingShareLink = text;
            this.s.server = parseShareLink(text).server;
            this.s.serverOk = false; this.serverMsg = "";
            this.render();
          } catch (e: any) { new Notice(`SelfSync: ${e?.message ?? e}`); }
          return;
        }
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
      const { token, mustChange } = await HttpTransport.login(this.s.server, this.s.username, this.s.password);
      this.token = token;
      // IA.3.5.9: an admin-created/reset account must set a new password before ANY other call (every
      // route 403s until then — the cause of the "vaults: HTTP 403" a fresh account hit). Prompt here.
      if (mustChange) { this.promptMustChange(); return; }
      await this.afterAuthenticated();
    } catch (e: any) {
      new Notice(`SelfSync: ${this.friendlyAuthError(e)}`);
    }
  }

  // Forced first-password-change step (shown when login reports must_change). Sets a new password via
  // /api/password (returns a fresh, un-gated token), then continues exactly as a normal login would.
  private promptMustChange() {
    const c = this.contentEl; c.empty();
    this.titleEl.setText("Set a new password");
    c.createEl("p", { text: "This account was created with a temporary password and must set a new one before it can be used." })
      .setAttribute("style", "font-size:13px;margin-bottom:10px;");
    let np = "", np2 = "";
    let npInput: HTMLInputElement | undefined;
    new Setting(c).setName("New password").addText((t) => { npInput = t.inputEl; t.inputEl.type = "password"; t.onChange((v) => { np = v; }); });
    new Setting(c).setName("Confirm new password").addText((t) => { t.inputEl.type = "password"; t.onChange((v) => { np2 = v; }); });
    new Setting(c)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.render()))
      .addButton((b) => b.setButtonText("Set password & continue").setCta().onClick(() => void this.doMustChange(np, np2)));
    if (npInput) window.setTimeout(() => npInput!.focus(), 0);
  }

  private async doMustChange(np: string, np2: string) {
    if (np.length < 8) { new Notice("SelfSync: the new password must be at least 8 characters"); return; }
    if (np !== np2) { new Notice("SelfSync: the passwords don't match"); return; }
    try {
      // `this.s.password` is the temp password just used to log in; changePassword verifies it and
      // returns a fresh token with the must-change flag cleared.
      this.token = await HttpTransport.changePassword(this.s.server, this.token, this.s.password, np);
      this.s.password = np; // storePassword mode persists the NEW password; token-only clears it later
      await this.afterAuthenticated();
    } catch (e: any) { new Notice(`SelfSync: ${e?.message ?? e}`); }
  }

  // Post-authentication continuation (shared by normal login + forced-change): redeem mode finishes by
  // redeeming; otherwise load the vault list and reveal the vault step.
  private async afterAuthenticated() {
    if (this.pendingShareLink) { await this.finishRedeem(); return; }
    this.s.vaults = await HttpTransport.listVaults(this.s.server, this.token);
    // Keep a vault pre-selected from a setup link if the account actually has it; else default to the first.
    this.s.chosenVault = this.s.vaults.includes(this.s.chosenVault) ? this.s.chosenVault : (this.s.vaults[0] ?? this.s.chosenVault);
    this.s.loggedIn = true;
    this.s.serverOk = true; this.serverMsg = "Reachable ✓"; // a successful login proves reachability
    this.render();
  }

  // Redeem finish: persist the just-established session, redeem the shared vault, adopt it as this
  // device's sync target, and reconnect. This is the guided path a share link takes on a device that
  // wasn't set up — server came from the link, credentials from the login above.
  private async finishRedeem() {
    const st = this.plugin.settings;
    st.serverUrl = this.s.server; st.username = this.s.username; st.authToken = this.token;
    st.password = st.storePassword ? this.s.password : ""; // token-only at rest by default
    await this.plugin.saveSettings(); // redeemShareLink authenticates via these persisted creds
    try {
      const ref = await this.plugin.redeemShareLink(this.pendingShareLink);
      st.vaultId = ref.vault; st.vaultOwner = ref.owner; st.vaultReadOnly = ref.perm === "read";
      await this.plugin.saveSettings();
      new Notice(`SelfSync: access granted — now syncing ${ref.owner}/${ref.vault} (${ref.perm === "readWrite" ? "read-write" : "read-only"}).`, 9000);
      this.close();
      void this.plugin.reconnect();
    } catch (e: any) {
      new Notice(`SelfSync: ${e?.message ?? e}`, 9000);
      this.render(); // stay signed in so the user can see the error / retry
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
