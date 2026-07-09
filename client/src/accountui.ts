import { App, Modal, Notice, Setting } from "obsidian";
import type NewLiveSyncPlugin from "./main";
import type { SharePerm, VaultShares } from "./transport";

// Self-service password change (R14 sec#2). Verifies the current password server-side, sets the new
// one, and — critically — revokes every OTHER session, so a user whose credential/token leaked can
// self-remediate without an admin. This device gets a fresh token and stays signed in.
export class ChangePasswordModal extends Modal {
  private current = "";
  private next = "";
  private confirm = "";
  private busy = false;

  constructor(app: App, private plugin: NewLiveSyncPlugin) { super(app); }

  onOpen() { this.titleEl.setText("Change password"); this.render(); }
  onClose() { this.contentEl.empty(); }

  private render() {
    const c = this.contentEl; c.empty();
    c.createEl("p", { text: "Changing your password signs out every other device. This one stays signed in." })
      .setAttribute("style", "font-size:13px;margin-bottom:10px;");
    const pw = (s: Setting, set: (v: string) => void) =>
      s.addText((t) => { t.inputEl.type = "password"; t.onChange((v) => set(v)); });
    pw(new Setting(c).setName("Current password"), (v) => (this.current = v));
    pw(new Setting(c).setName("New password"), (v) => (this.next = v));
    pw(new Setting(c).setName("Confirm new password"), (v) => (this.confirm = v));
    new Setting(c)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) => b.setButtonText("Change password").setCta().onClick(() => void this.submit()));
  }

  private async submit() {
    if (this.busy) return;
    if (!this.current || !this.next) { new Notice("SelfSync: fill in both password fields"); return; }
    if (this.next !== this.confirm) { new Notice("SelfSync: the new passwords don't match"); return; }
    this.busy = true;
    try {
      await this.plugin.changePassword(this.current, this.next);
      new Notice("SelfSync: password changed — other devices were signed out");
      this.close();
    } catch (e: any) {
      new Notice(`SelfSync: ${e?.message ?? e}`);
    } finally {
      this.busy = false;
    }
  }
}

// Owner-scoped share management (R14 sec#4): grant/revoke access to the vaults you OWN. Reachable
// now that the endpoints are served on the public surface (was admin-web-page-only, unreachable in
// the recommended split deployment).
export class ShareManageModal extends Modal {
  private vaults: VaultShares[] = [];
  private loading = true;
  private error = "";

  constructor(app: App, private plugin: NewLiveSyncPlugin) { super(app); }

  onOpen() { this.titleEl.setText("Share your vaults"); this.render(); void this.load(); }
  onClose() { this.contentEl.empty(); }

  private async load() {
    try { this.vaults = await this.plugin.myVaultShares(); this.error = ""; }
    catch (e: any) { this.error = e?.message ?? String(e); }
    this.loading = false;
    this.render();
  }

  private render() {
    const c = this.contentEl; c.empty();
    if (this.loading) { c.createEl("p", { text: "Loading your vaults…" }); return; }
    if (this.error) { c.createEl("p", { text: `Couldn't load sharing: ${this.error}` }); return; }
    if (!this.vaults.length) { c.createEl("p", { text: "You don't own any vaults to share yet." }); return; }

    c.createEl("p", { text: "Grant another account access to a vault you own. Read-only can pull but never push." })
      .setAttribute("style", "font-size:13px;margin-bottom:10px;");

    for (const v of this.vaults) {
      new Setting(c).setName(v.vault).setHeading();
      if (v.grants.length === 0) {
        c.createEl("div", { text: "Not shared with anyone.", cls: "setting-item-description" });
      }
      for (const gr of v.grants) {
        new Setting(c).setName(gr.grantee).setDesc(gr.perm === "readWrite" ? "read-write" : "read-only")
          .addButton((b) => b.setButtonText("Remove").setWarning().onClick(() => void this.revoke(v.vault, gr.grantee)));
      }
      // Add-a-grant row: grantee username + permission + Add.
      let grantee = "";
      let perm: SharePerm = "readWrite";
      new Setting(c)
        .addText((t) => t.setPlaceholder("username to share with").onChange((val) => { grantee = val.trim(); }))
        .addDropdown((dd) => { dd.addOption("readWrite", "read-write"); dd.addOption("read", "read-only"); dd.setValue(perm).onChange((val) => { perm = val as SharePerm; }); })
        .addButton((b) => b.setButtonText("Add").setCta().onClick(() => void this.grant(v.vault, grantee, perm)));
    }
    new Setting(c).addButton((b) => b.setButtonText("Done").onClick(() => this.close()));
  }

  private async grant(vault: string, grantee: string, perm: SharePerm) {
    if (!grantee) { new Notice("SelfSync: enter a username to share with"); return; }
    try {
      await this.plugin.shareVault(vault, grantee, perm);
      new Notice(`SelfSync: shared '${vault}' with ${grantee}`);
      await this.load();
    } catch (e: any) {
      new Notice(`SelfSync: ${e?.message ?? e}`);
    }
  }

  private async revoke(vault: string, grantee: string) {
    try {
      await this.plugin.unshareVault(vault, grantee);
      new Notice(`SelfSync: stopped sharing '${vault}' with ${grantee}`);
      await this.load();
    } catch (e: any) {
      new Notice(`SelfSync: ${e?.message ?? e}`);
    }
  }
}
