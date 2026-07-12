import { App, Modal, Notice, Setting } from "obsidian";
import { isValidVaultName, sanitizeVaultName } from "./wizardsteps";
import { RedeemShareLinkModal } from "./accountui";
import type NewLiveSyncPlugin from "./main";
import type { SwitchMode } from "./reconcile";
import type { SharedVaultRef } from "./transport";

// Switch which remote vault this Obsidian vault syncs to — WITHOUT re-asking for the
// server or account. We're already signed in, so this reuses the existing session
// (cached token, or a silent re-login with the stored password) to list vaults.
export class SwitchVaultModal extends Modal {
  private vaults: string[] = [];
  private shared: SharedVaultRef[] = [];
  private chosen = "";
  private newName = "";
  private loading = true;
  private error = "";
  private target = "";
  private targetOwner = "";      // set when switching to a vault shared BY someone else
  private targetReadOnly = false; // that share is read-only

  constructor(app: App, private plugin: NewLiveSyncPlugin) { super(app); }

  onOpen() { this.titleEl.setText("Switch remote vault"); this.render(); void this.load(); }
  onClose() { this.contentEl.empty(); }

  private async load() {
    try {
      this.vaults = await this.plugin.currentVaults();
      this.chosen = this.plugin.settings.vaultId || this.vaults[0] || "";
      try { this.shared = await this.plugin.listSharedVaults(); } catch { this.shared = []; }
    } catch {
      this.error = "Couldn't reach the server with your saved login. Open full setup to re-connect.";
    }
    this.loading = false;
    this.render();
  }

  private render() {
    const c = this.contentEl; c.empty();
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
      .addText((t) => t.setPlaceholder("e.g. notes").onChange((v) => { const n = sanitizeVaultName(v); this.newName = n; if (t.inputEl.value !== n) t.inputEl.value = n; }));
    new Setting(c).addButton((b) => b.setButtonText("Switch").setCta().onClick(() => void this.doSwitch()));

    // Vaults other people have shared with this account.
    if (this.shared.length) {
      new Setting(c).setName("Shared with you").setHeading();
      for (const ref of this.shared) {
        new Setting(c)
          .setName(`${ref.vault}`)
          .setDesc(`owned by ${ref.owner} · ${ref.perm === "read" ? "read-only" : "read-write"}`)
          .addButton((b) => b.setButtonText("Use").onClick(() => void this.selectShared(ref)))
          // Decline/leave: drop your OWN access to this shared vault (local files stay).
          .addButton((b) => b.setButtonText("Leave").setWarning().onClick(() => void this.leaveShared(ref)));
      }
    }
    // Redeeming a share link ADDS someone's vault to the "Shared with you" list above — so it lives
    // here (in the choose-a-vault flow), not as an action on the vault you're currently syncing.
    new Setting(c).setName("Have a share link?").setDesc("Redeem a link someone sent you to add their vault here.")
      .addButton((b) => b.setButtonText("Redeem a share link").onClick(() => { this.close(); new RedeemShareLinkModal(this.app, this.plugin).open(); }));
  }

  private async doSwitch() {
    try {
      let vault = this.chosen;
      if (this.newName) {
        const name = sanitizeVaultName(this.newName);
        if (!isValidVaultName(name)) { new Notice("SelfSync: vault name — lowercase letters, numbers, dots, dashes or underscores (max 64)."); return; }
        await this.plugin.createRemoteVault(name); vault = name;
      }
      if (!vault) { new Notice("SelfSync: pick or name a vault"); return; }
      this.target = vault; this.targetOwner = ""; this.targetReadOnly = false; // own vault
      // No local content to lose → adopt the target automatically (fetch), no prompt.
      if (!(await this.plugin.hasLocalData())) { await this.applySwitch("download"); return; }
      // Local content exists → the user adjudicates how to combine it with the target.
      this.renderResolve();
    } catch (e: any) {
      new Notice(`SelfSync: ${e?.message ?? e}`);
    }
  }

  // Switch to a vault shared BY someone else. Read-only shares can only be downloaded
  // (we can't push); read-write shares use the same resolution prompt as an own vault.
  private async leaveShared(ref: SharedVaultRef) {
    if (!confirm(`Leave the shared vault "${ref.owner}/${ref.vault}"? You'll lose access until it's re-shared. Your local files are kept.`)) return;
    try {
      await this.plugin.leaveSharedVault(ref.owner, ref.vault);
      new Notice(`SelfSync: left ${ref.owner}/${ref.vault}`);
      this.close();
      this.plugin.settingsRefresh?.(); // refresh the settings tab (vault may have been cleared)
    } catch (e: any) { new Notice(`SelfSync: ${e?.message ?? e}`); }
  }

  private async selectShared(ref: SharedVaultRef) {
    // SF3: fail CLOSED on the permission — writable ONLY if the server explicitly says "readWrite".
    // A missing/unknown value (server bug, version skew, MITM) must be treated as read-only, never
    // silently writable.
    this.target = ref.vault; this.targetOwner = ref.owner; this.targetReadOnly = ref.perm !== "readWrite";
    try {
      // SF1: only auto-download when there's NOTHING local to lose. If the device has content, ALWAYS
      // prompt — never silently mirror-delete. (Previously a read-only share short-circuited to
      // download, which PERMANENTLY deleted local-only notes on a flow — viewing a shared vault —
      // where the user expects zero destruction.)
      if (!(await this.plugin.hasLocalData())) { await this.applySwitch("download"); return; }
      this.renderResolve();
    } catch (e: any) {
      new Notice(`SelfSync: ${e?.message ?? e}`);
    }
  }

  // One-time transition prompt, shown only when this vault already holds content that a
  // switch could overwrite. Merge is the safe (nothing-lost) default; the two mirror
  // modes are marked as destructive.
  private renderResolve() {
    const c = this.contentEl; c.empty();
    this.titleEl.setText("This vault already has content");
    c.createEl("p", {
      text: `Choose how to combine this vault's files with '${this.target}'. This is a one-time action for this switch.`,
    }).setAttribute("style", "font-size:13px;margin-bottom:10px;");

    new Setting(c).setName("Merge — keep everything")
      .setDesc("Combine both sets. Files that differ on both sides are merged, or kept side-by-side as a conflict copy. Nothing is lost.")
      .addButton((b) => b.setButtonText("Merge").setCta().onClick(() => void this.applySwitch("merge")));

    new Setting(c).setName(`Download — mirror '${this.target}'`)
      .setDesc("Replace this vault with the target's content. Local files that aren't on the target are removed.")
      .addButton((b) => b.setButtonText("Download").setWarning().onClick(() => void this.applySwitch("download")));

    // Upload isn't possible on a read-only share (we can't push) — omit it there.
    if (!this.targetReadOnly) {
      new Setting(c).setName(`Upload — overwrite '${this.target}'`)
        .setDesc("Replace the target with this vault's content. Target files that aren't in this vault are removed.")
        .addButton((b) => b.setButtonText("Upload").setWarning().onClick(() => void this.applySwitch("upload")));
    }

    new Setting(c).addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
  }

  private async applySwitch(mode: SwitchMode) {
    this.close();
    const verb = mode === "download" ? "fetching" : mode === "upload" ? "uploading to" : "merging with";
    const label = this.targetOwner ? `${this.targetOwner}/${this.target}` : this.target;
    new Notice(`SelfSync: switching to '${label}' (${verb})…`);
    try {
      await this.plugin.switchToVault(this.target, mode, this.targetOwner, this.targetReadOnly);
      new Notice(`SelfSync: now syncing '${label}'${this.targetReadOnly ? " (read-only)" : ""}`);
    } catch (e: any) {
      new Notice(`SelfSync: ${e?.message ?? e}`);
    }
  }
}
