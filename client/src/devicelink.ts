import { App, Modal, Notice, Setting } from "obsidian";
import qrcode from "qrcode-generator";

// "Add a device" modal: renders the selfsync:// setup link as a scannable QR plus a
// copyable text field. The QR/text carry server + username only — never the password
// (see connstr.ts). Fully self-contained (bundled encoder, no external fetch — CSP-safe).
export class DeviceLinkModal extends Modal {
  constructor(app: App, private link: string) { super(app); }

  onOpen() {
    this.titleEl.setText("Add a device");
    const c = this.contentEl;
    c.createEl("p", { text: "On the other device: install SelfSync, then scan this code or paste the link into “I have a setup link”." });

    // Encode the link. Type 0 = auto-size to fit the data; "M" = medium error correction.
    const qr = qrcode(0, "M");
    qr.addData(this.link);
    qr.make();
    const box = c.createEl("div");
    // Always render on white so the dark QR scans regardless of the Obsidian theme.
    box.setAttribute("style", "display:flex;justify-content:center;padding:12px;background:#fff;border-radius:8px;margin:8px 0;");
    box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2 });

    const field = c.createEl("input");
    field.setAttr("readonly", "true");
    field.value = this.link;
    field.setAttribute("style", "width:100%;font-family:var(--font-monospace);font-size:12px;");

    new Setting(c).addButton((b) => b.setButtonText("Copy link").setCta().onClick(() => {
      navigator.clipboard?.writeText(this.link).then(
        () => new Notice("SelfSync: link copied"),
        () => field.select(),
      );
    }));

    c.createEl("p", { text: "The link contains the server address and your username — but not your password." })
      .setAttribute("style", "font-size:12px;opacity:0.7;");
  }

  onClose() { this.contentEl.empty(); }
}
