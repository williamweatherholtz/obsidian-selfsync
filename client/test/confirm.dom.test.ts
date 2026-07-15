// @vitest-environment happy-dom
// Real-DOM tests for the in-app confirmation modal (src/confirm.ts) — the destructive-action gate.
// A bug here (auto-resolving true, or never resolving) silently confirms or hangs a destructive flow,
// so we assert the exact resolved value on confirm / cancel / dismiss and the warn-vs-cta styling.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Modal } from "obsidian";
import { confirmModal } from "../src/confirm";
import { makeApp, buttonByText } from "./ui-dom-harness";

// The obsidian stub's Modal.open()/close() are no-ops — they don't fire the onOpen/onClose lifecycle
// the real Obsidian invokes. confirmModal builds its modal INTERNALLY and only hands back a Promise,
// so we bridge the lifecycle here (mirroring real Obsidian: open→onOpen, close→onClose) and capture
// the live instance so a test can drive its rendered contentEl. This is test infrastructure, not a
// change to the code under test (confirm.ts is exercised for real).
const opened: any[] = [];
let origOpen: any, origClose: any;
beforeAll(() => {
  origOpen = Modal.prototype.open;
  origClose = Modal.prototype.close;
  Modal.prototype.open = function (this: any) { opened.push(this); this.onOpen(); };
  Modal.prototype.close = function (this: any) { this.closed = true; this.onClose(); };
});
afterAll(() => { Modal.prototype.open = origOpen; Modal.prototype.close = origClose; });
beforeEach(() => { opened.length = 0; });
const lastModal = () => opened[opened.length - 1];

describe("confirmModal", () => {
  it("clicking the confirm button resolves true and uses warn styling when warn:true", async () => {
    const p = confirmModal(makeApp(), { title: "Danger", body: "Body", confirmText: "Overwrite", warn: true });
    const m = lastModal();
    const btn = buttonByText(m.contentEl, "Overwrite");
    expect(btn).toBeTruthy();
    expect(btn.classList.contains("mod-warning")).toBe(true);
    expect(btn.classList.contains("mod-cta")).toBe(false);
    btn.click();
    await expect(p).resolves.toBe(true);
  });

  it("uses cta (not warn) styling when warn is not set", () => {
    confirmModal(makeApp(), { title: "T", body: "B" });
    const btn = buttonByText(lastModal().contentEl, "Continue"); // default confirmText
    expect(btn).toBeTruthy();
    expect(btn.classList.contains("mod-cta")).toBe(true);
    expect(btn.classList.contains("mod-warning")).toBe(false);
  });

  it("clicking Cancel resolves false", async () => {
    const p = confirmModal(makeApp(), { title: "T", body: "B", confirmText: "Go" });
    buttonByText(lastModal().contentEl, "Cancel").click();
    await expect(p).resolves.toBe(false);
  });

  it("dismissing without clicking any button resolves false (never auto-confirms)", async () => {
    const p = confirmModal(makeApp(), { title: "Danger", body: "B", warn: true });
    // Simulate the user dismissing the dialog (Esc / click-away) — close() drives onClose, and with
    // no answer recorded onClose must resolve false. A regression to `true` here would silently
    // confirm a destructive action.
    lastModal().close();
    await expect(p).resolves.toBe(false);
  });
});
