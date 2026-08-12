import { App, Modal, Setting } from "obsidian";

// A small in-app confirmation modal, consistent with the plugin's other modals — used instead of the
// native window.confirm(), which on the mobile Capacitor webview renders out-of-context / unstyled and
// reads as less trustworthy at exactly the moment trust matters (a destructive confirm). Resolves true
// if the user confirms, false if they cancel or dismiss.
export function confirmModal(app: App, opts: { title: string; body: string; confirmText?: string; warn?: boolean }): Promise<boolean> {
  return new Promise((resolve) => new ConfirmModal(app, opts, resolve).open());
}

class ConfirmModal extends Modal {
  private answered = false;
  constructor(app: App, private opts: { title: string; body: string; confirmText?: string; warn?: boolean }, private done: (ok: boolean) => void) { super(app); }
  onOpen() {
    this.titleEl.setText(this.opts.title);
    const c = this.contentEl; c.empty();
    c.createEl("p", { text: this.opts.body }).setAttribute("style", "font-size:13px;");
    new Setting(c)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) => {
        b.setButtonText(this.opts.confirmText ?? "Continue");
        if (this.opts.warn) b.setWarning(); else b.setCta();
        b.onClick(() => { this.answered = true; this.done(true); this.close(); });
      });
  }
  onClose() { this.contentEl.empty(); if (!this.answered) this.done(false); } // dismissed = cancelled
}

// A small in-app single-line prompt (same styling as confirmModal). Resolves the trimmed entered text on
// confirm, or null on cancel/dismiss.
export function promptModal(app: App, opts: { title: string; body: string; placeholder?: string; initial?: string; confirmText?: string }): Promise<string | null> {
  return new Promise((resolve) => new PromptModal(app, opts, resolve).open());
}

class PromptModal extends Modal {
  private answered = false;
  private value: string;
  constructor(app: App, private opts: { title: string; body: string; placeholder?: string; initial?: string; confirmText?: string }, private done: (v: string | null) => void) {
    super(app);
    this.value = opts.initial ?? "";
  }
  onOpen() {
    this.titleEl.setText(this.opts.title);
    const c = this.contentEl; c.empty();
    c.createEl("p", { text: this.opts.body }).setAttribute("style", "font-size:13px;");
    new Setting(c).addText((t) => {
      t.setPlaceholder(this.opts.placeholder ?? "").setValue(this.value).onChange((v) => { this.value = v; });
      t.inputEl.style.width = "100%";
      t.inputEl.addEventListener("keydown", (e) => { if (e.key === "Enter") { this.answered = true; this.done(this.value.trim()); this.close(); } });
    });
    new Setting(c)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) => b.setButtonText(this.opts.confirmText ?? "OK").setCta().onClick(() => { this.answered = true; this.done(this.value.trim()); this.close(); }));
  }
  onClose() { this.contentEl.empty(); if (!this.answered) this.done(null); } // dismissed = cancelled
}
