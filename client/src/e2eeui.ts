// The E2EE dialogs (E3b, D0106 to D0111, spec sections 4.8, 4.9 and 6). Three modals over the pure rules of
// e2ee/flows.ts: the encryption password entry (create: double entry, the floor, the lost-password warning,
// progress during derivation), the join prompt (one entry, the three outcomes told apart), and the 409
// conflict offer of the plugin's create dialog (join only / delete behind the warnings / upgrade the server).
// The password never leaves the modal except into the KDF call; it is never logged, stored or echoed.
import { App, Modal, Notice, Setting } from "obsidian";
import type SelfSyncPlugin from "./main";
import { KeyringError } from "./e2ee/keyring";
import { CreateConflictDecision, DELETE_VAULT_WARNING, LOST_PASSWORD_WARNING, MIGRATION_ROUTE, PASSWORD_FLOOR, joinOutcomeText, passwordProblem } from "./e2ee/flows";

/** What a modal does with the password once it is accepted: the caller's work, with a progress sink. */
export type PasswordWork = (password: string, progress: (fraction: number) => void) => Promise<void>;

// Create: the password twice, the floor, the not-equal-to-login rule, the warning, then the caller's work with
// a progress line (Argon2id takes seconds). The modal stays open until the work resolves; an error shows inline.
export class EncryptionPasswordModal extends Modal {
  private pw = ""; private pw2 = "";
  private busy = false;
  private status = "";
  constructor(app: App, private loginPassword: string, private work: PasswordWork, private opts: { title?: string; intro?: string; onCancel?: () => void } = {}) { super(app); }
  onOpen() { this.render(); }
  onClose() { this.contentEl.empty(); if (!this.busy && !this.done) this.opts.onCancel?.(); }
  private done = false;

  private render() {
    const c = this.contentEl; c.empty();
    this.titleEl.setText(this.opts.title ?? "Encryption password");
    c.createEl("p", { text: this.opts.intro ?? "Choose the password that encrypts this vault's content before it leaves your devices. Every device that joins this vault will need it." }).setAttribute("style", "font-size:13px;margin-bottom:6px;");
    c.createEl("p", { text: LOST_PASSWORD_WARNING }).setAttribute("style", "font-size:13px;color:var(--text-warning);margin-bottom:8px;");
    let first: HTMLInputElement | undefined;
    new Setting(c).setName("Encryption password").setDesc(`At least ${PASSWORD_FLOOR} characters. Not your login password.`)
      .addText((t) => { first = t.inputEl; t.inputEl.type = "password"; t.setValue(this.pw).onChange((v) => { this.pw = v; }); });
    new Setting(c).setName("Confirm encryption password")
      .addText((t) => { t.inputEl.type = "password"; t.setValue(this.pw2).onChange((v) => { this.pw2 = v; }); });
    const statusEl = c.createEl("p", { text: this.status });
    statusEl.setAttribute("style", "font-size:12px;min-height:1.2em;");
    this.statusEl = statusEl;
    new Setting(c)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) => b.setButtonText("Encrypt and continue").setCta().onClick(() => void this.submit()));
    if (first) window.setTimeout(() => first!.focus(), 0);
  }
  private statusEl?: HTMLElement;
  private setStatus(s: string) { this.status = s; this.statusEl?.setText(s); }

  private async submit() {
    if (this.busy) return;
    const problem = passwordProblem(this.pw, this.pw2, this.loginPassword);
    if (problem) { this.setStatus(problem); return; }
    this.busy = true;
    this.setStatus("Deriving the key… (this takes a few seconds)");
    try {
      await this.work(this.pw, (f) => this.setStatus(`Deriving the key… ${Math.round(f * 100)}%`));
      this.done = true;
      this.close();
    } catch (e: any) {
      this.setStatus(String(e?.message ?? e));
    } finally {
      this.busy = false;
    }
  }
}

/** The join work: open the keyring with the password and pin; throws a KeyringError on the three outcomes. */
export type JoinWork = (password: string, progress: (fraction: number) => void) => Promise<void>;

// Join and Re-enrol: the password once; corrupt keyring, unsupported KDF parameters and wrong password are told
// apart by the outcome table (D0106) and shown inline, so a typo re-prompts and a tampered record is named.
export class JoinVaultModal extends Modal {
  private pw = "";
  private busy = false;
  private status = "";
  private statusEl?: HTMLElement;
  constructor(app: App, private work: JoinWork, private opts: { title?: string; intro?: string; vaultLabel?: string } = {}) { super(app); }
  onOpen() { this.render(); }
  onClose() { this.contentEl.empty(); }

  private render() {
    const c = this.contentEl; c.empty();
    this.titleEl.setText(this.opts.title ?? "Join an encrypted vault");
    c.createEl("p", { text: this.opts.intro ?? `This vault${this.opts.vaultLabel ? ` (${this.opts.vaultLabel})` : ""} is end-to-end encrypted. Enter its encryption password to read and write it on this device. The password never leaves this device.` })
      .setAttribute("style", "font-size:13px;margin-bottom:8px;");
    let input: HTMLInputElement | undefined;
    new Setting(c).setName("Encryption password")
      .addText((t) => { input = t.inputEl; t.inputEl.type = "password"; t.setValue(this.pw).onChange((v) => { this.pw = v; }); });
    this.statusEl = c.createEl("p", { text: this.status });
    this.statusEl.setAttribute("style", "font-size:12px;min-height:1.2em;");
    new Setting(c)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) => b.setButtonText("Join").setCta().onClick(() => void this.submit()));
    input?.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); void this.submit(); } });
    if (input) window.setTimeout(() => input!.focus(), 0);
  }
  private setStatus(s: string) { this.status = s; this.statusEl?.setText(s); }

  private async submit() {
    if (this.busy) return;
    if (!this.pw) { this.setStatus("Enter the encryption password."); return; }
    this.busy = true;
    this.setStatus("Checking the password… (this takes a few seconds)");
    try {
      await this.work(this.pw, (f) => this.setStatus(`Checking the password… ${Math.round(f * 100)}%`));
      this.close();
    } catch (e: any) {
      this.setStatus(e instanceof KeyringError ? joinOutcomeText(e.outcome) : String(e?.message ?? e));
    } finally {
      this.busy = false;
    }
  }
}

// The 409 offer of the plugin's create dialog (spec section 6, D0109). Join only on an encrypted name; the
// delete behind the residue and re-share warnings on a plaintext name; nothing on an old server.
export class CreateConflictModal extends Modal {
  constructor(app: App, private name: string, private decision: CreateConflictDecision,
              private actions: { join: () => void; deleteThenRetry: () => Promise<void> }) { super(app); }
  onOpen() {
    const c = this.contentEl; c.empty();
    this.titleEl.setText(`A vault named "${this.name}" already exists`);
    const d = this.decision;
    if (d.kind === "join") {
      c.createEl("p", { text: `"${this.name}" is an encrypted vault on this server. You can join it with its encryption password. A different vault needs a different name.` }).setAttribute("style", "font-size:13px;");
      new Setting(c)
        .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
        .addButton((b) => b.setButtonText("Join it").setCta().onClick(() => { this.close(); this.actions.join(); }));
      return;
    }
    if (d.kind === "upgradeServer") {
      c.createEl("p", { text: `"${this.name}" exists, and this server is older than ${d.minVersion}, the first release that supports encrypted vaults. Update the server first; nothing was changed.` }).setAttribute("style", "font-size:13px;");
      new Setting(c).addButton((b) => b.setButtonText("Close").setCta().onClick(() => this.close()));
      return;
    }
    c.createEl("p", { text: `"${this.name}" is a plaintext vault on this server: a delete that is not complete yet, or another device re-created the name.` }).setAttribute("style", "font-size:13px;");
    c.createEl("p", { text: MIGRATION_ROUTE }).setAttribute("style", "font-size:13px;");
    c.createEl("p", { text: DELETE_VAULT_WARNING }).setAttribute("style", "font-size:13px;color:var(--text-warning);");
    new Setting(c)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) => b.setButtonText("Delete it on the server and create encrypted").setWarning().onClick(async () => {
        this.close();
        try { await this.actions.deleteThenRetry(); } catch (e: any) { new Notice(`SelfSync: ${e?.message ?? e}`, 9000); }
      }));
  }
  onClose() { this.contentEl.empty(); }
}
