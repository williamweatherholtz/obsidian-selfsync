// @vitest-environment happy-dom
// Real-DOM tests for the plugin's MODALS — render each through the (happy-dom) obsidian stub and
// confirm its confirm/resolve buttons actually invoke the right plugin action with the right args.
// Directly targets the "dialogs with no effect" worry (esp. the conflict-adjudication modals).
import { describe, it, expect } from "vitest";
import { ChangePasswordModal } from "../src/accountui";
import { ConfigConflictModal } from "../src/configconflict";
import { NoteConflictModal } from "../src/noteconflict";
import { SetupWizardModal } from "../src/setupwizard";
import { fakePlugin, buttonByText, textByName, typeInto, flush } from "./ui-dom-harness";

describe("ChangePasswordModal", () => {
  it("submitting calls changePassword(current, new) after the confirm-match check", async () => {
    const plugin = fakePlugin();
    const m = new ChangePasswordModal(plugin.app, plugin as any);
    m.onOpen();
    typeInto(textByName(m.contentEl, "Current password"), "oldpw123");
    typeInto(textByName(m.contentEl, "New password"), "Newpass12");
    typeInto(textByName(m.contentEl, "Confirm new password"), "Newpass12");
    buttonByText(m.contentEl, "Change password").click();
    await flush();
    expect(plugin.changePassword).toHaveBeenCalledWith("oldpw123", "Newpass12");
  });

  it("a confirm mismatch does NOT call changePassword", async () => {
    const plugin = fakePlugin();
    const m = new ChangePasswordModal(plugin.app, plugin as any);
    m.onOpen();
    typeInto(textByName(m.contentEl, "Current password"), "oldpw123");
    typeInto(textByName(m.contentEl, "New password"), "Newpass12");
    typeInto(textByName(m.contentEl, "Confirm new password"), "Mismatch99");
    buttonByText(m.contentEl, "Change password").click();
    await flush();
    expect(plugin.changePassword).not.toHaveBeenCalled();
  });
});

describe("ConfigConflictModal (adjudication)", () => {
  it("'Use this device' resolves the group as local; 'Use synced' as remote", async () => {
    const plugin = fakePlugin({ settings: { configConflicts: [".obsidian/app.json"] } });
    const m = new ConfigConflictModal(plugin.app, plugin as any);
    m.onOpen(); await flush(); // render() is async (fetches conflict sides)
    buttonByText(m.contentEl, "Use this device").click();
    await flush();
    expect(plugin.resolveConfigGroup).toHaveBeenCalledWith([".obsidian/app.json"], "local");

    // Re-open fresh to test the other side (render re-runs after resolve).
    const m2 = new ConfigConflictModal(plugin.app, plugin as any);
    m2.onOpen(); await flush();
    buttonByText(m2.contentEl, "Use synced").click();
    await flush();
    expect(plugin.resolveConfigGroup).toHaveBeenCalledWith([".obsidian/app.json"], "remote");
  });

  it("with no conflicts it shows the all-clear message and a Close button", async () => {
    const plugin = fakePlugin();
    const m = new ConfigConflictModal(plugin.app, plugin as any);
    m.onOpen(); await flush();
    expect(m.contentEl.textContent).toContain("No config differences");
    expect(buttonByText(m.contentEl, "Close")).toBeTruthy();
  });
});

describe("NoteConflictModal (adjudication)", () => {
  const seed = () => fakePlugin({ settings: { noteConflicts: [{ copy: "note (conflict).md", original: "note.md" }] } });

  it("'Keep this device's' resolves 'mine'", async () => {
    const plugin = seed();
    const m = new NoteConflictModal(plugin.app, plugin as any);
    m.onOpen(); await flush();
    buttonByText(m.contentEl, "Keep this device's").click();
    await flush();
    expect(plugin.resolveNoteConflict).toHaveBeenCalledWith("note (conflict).md", "note.md", "mine", expect.anything());
  });

  it("'Keep the other' resolves 'theirs'", async () => {
    const plugin = seed();
    const m = new NoteConflictModal(plugin.app, plugin as any);
    m.onOpen(); await flush();
    buttonByText(m.contentEl, "Keep the other").click();
    await flush();
    expect(plugin.resolveNoteConflict).toHaveBeenCalledWith("note (conflict).md", "note.md", "theirs", expect.anything());
  });

  it("'Open both to merge' resolves 'manual'", async () => {
    const plugin = seed();
    const m = new NoteConflictModal(plugin.app, plugin as any);
    m.onOpen(); await flush();
    buttonByText(m.contentEl, "Open both to merge").click();
    await flush();
    expect(plugin.resolveNoteConflict).toHaveBeenCalledWith("note (conflict).md", "note.md", "manual");
  });
});

describe("SetupWizardModal", () => {
  it("renders the connection fields + Test and login buttons", () => {
    const plugin = fakePlugin();
    const m = new SetupWizardModal(plugin.app, plugin as any);
    m.onOpen();
    expect((m.contentEl as any).querySelectorAll("input").length).toBeGreaterThan(0);
    expect(buttonByText(m.contentEl, "Test")).toBeTruthy();
    const loginBtn = buttonByText(m.contentEl, "Log in") || buttonByText(m.contentEl, "Create & log in");
    expect(loginBtn).toBeTruthy();
  });

  it("clicking 'Start syncing' before logging in does NOT reconnect (guarded, not a silent no-op crash)", async () => {
    const plugin = fakePlugin();
    const m = new SetupWizardModal(plugin.app, plugin as any);
    m.onOpen();
    buttonByText(m.contentEl, "Start syncing")?.click();
    await flush();
    expect(plugin.reconnect).not.toHaveBeenCalled(); // finish() guards on "log in first"
  });
});
