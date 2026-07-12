import { App, Modal, Notice, Setting } from "obsidian";
import type NewLiveSyncPlugin from "./main";
import type { SharePerm, ShareLinkInfo, VaultShares } from "./transport";

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
  private links: ShareLinkInfo[] = [];
  private loading = true;
  private error = "";

  constructor(app: App, private plugin: NewLiveSyncPlugin) { super(app); }

  onOpen() { this.titleEl.setText("Share your vaults"); this.render(); void this.load(); }
  onClose() { this.contentEl.empty(); }

  private async load() {
    try {
      this.vaults = await this.plugin.myVaultShares();
      this.links = await this.plugin.listShareLinks();
      this.error = "";
    } catch (e: any) { this.error = e?.message ?? String(e); }
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
      // D0023: or share via a single-use LINK — no username needed. Copies the link to send out-of-band.
      let linkPerm: SharePerm = "readWrite";
      new Setting(c).setName("Or share via link").setDesc("Single-use — anyone you send it to can redeem it once to gain access.")
        .addDropdown((dd) => { dd.addOption("readWrite", "read-write"); dd.addOption("read", "read-only"); dd.setValue(linkPerm).onChange((val) => { linkPerm = val as SharePerm; }); })
        .addButton((b) => b.setButtonText("Create link").onClick(() => void this.makeLink(v.vault, linkPerm)));
    }

    // Pending (unredeemed) share-links across the caller's vaults, with revoke. Redeemed ones already
    // appear as normal grants above.
    const pending = this.links.filter((l) => l.redeemed_by === null);
    if (pending.length) {
      new Setting(c).setName("Pending share links").setHeading();
      for (const l of pending) {
        new Setting(c).setName(`${l.vault} — ${l.perm === "readWrite" ? "read-write" : "read-only"}${l.label ? ` (${l.label})` : ""}`)
          .setDesc("Not yet redeemed.")
          .addButton((b) => b.setButtonText("Revoke").setWarning().onClick(() => void this.revokeLink(l.id)));
      }
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

  private async makeLink(vault: string, perm: SharePerm) {
    try {
      const link = await this.plugin.createShareLink(vault, perm);
      await navigator.clipboard?.writeText(link);
      new Notice(`SelfSync: single-use share link for '${vault}' copied — send it to the person you're sharing with.`, 8000);
      await this.load(); // show it under Pending
    } catch (e: any) { new Notice(`SelfSync: ${e?.message ?? e}`); }
  }

  private async revokeLink(id: string) {
    try { await this.plugin.revokeShareLink(id); new Notice("SelfSync: share link revoked."); await this.load(); }
    catch (e: any) { new Notice(`SelfSync: ${e?.message ?? e}`); }
  }
}

// Redeem a share-link someone sent you: paste it, redeem (binds a grant to your account), then offer
// to switch to sync the shared vault. Any account can use this (it's how you RECEIVE a share).
export class RedeemShareLinkModal extends Modal {
  private link = "";
  private busy = false;
  constructor(app: App, private plugin: NewLiveSyncPlugin, prefill = "") { super(app); this.link = prefill.trim(); }
  onOpen() { this.titleEl.setText("Redeem a share link"); this.render(); }
  onClose() { this.contentEl.empty(); }

  private render() {
    const c = this.contentEl; c.empty();
    c.createEl("p", { text: "Paste a selfsync-share:// link someone sent you to gain access to their vault. It works once." })
      .setAttribute("style", "font-size:13px;margin-bottom:10px;");
    new Setting(c).setName("Share link").addText((t) => t.setValue(this.link).setPlaceholder("selfsync-share://…").onChange((v) => { this.link = v.trim(); }));
    new Setting(c)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) => b.setButtonText("Redeem").setCta().onClick(() => void this.submit()));
  }

  private async submit() {
    if (this.busy) return;
    if (!this.link) { new Notice("SelfSync: paste a share link first"); return; }
    this.busy = true;
    try {
      const ref = await this.plugin.redeemShareLink(this.link);
      new Notice(`SelfSync: you now have ${ref.perm === "readWrite" ? "read-write" : "read-only"} access to ${ref.owner}/${ref.vault}. Use "Switch" to sync it.`, 9000);
      this.close();
    } catch (e: any) {
      new Notice(`SelfSync: ${e?.message ?? e}`);
    } finally { this.busy = false; }
  }
}
