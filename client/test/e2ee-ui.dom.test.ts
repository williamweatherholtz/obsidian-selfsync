// @vitest-environment happy-dom
// E3b (1) (3) (4) (6) (9) (12): the E2EE dialogs and the card actions, rendered through the happy-dom obsidian
// stub. The password modal refuses the three bad pairs and runs the work on a good one. The join modal shows
// the outcome table's text. The 409 modal offers join only, the delete behind the warnings, or nothing.
// The switch dialog's Encrypt toggle reaches createVaultFlow. The status card picks its action from the block
// reason, says "ask the owner" on a grantee, carries the encrypted indicator, and offers the owner delete.
import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("../src/confirm", () => ({ confirmModal: vi.fn(async () => true) }));
vi.mock("../src/pushpreviewmodal", () => ({ pushPreviewModal: vi.fn(async () => true) }));
import { __notices, __opened } from "./obsidian-stub"; // the same module instance as the "obsidian" alias
import { EncryptionPasswordModal, JoinVaultModal, CreateConflictModal, RecreateVaultModal } from "../src/e2eeui";
import { SwitchVaultModal } from "../src/vaultswitch";
import { SetupWizardModal } from "../src/setupwizard";
import { SelfSyncSettingTab } from "../src/settings";
import { KeyringError } from "../src/e2ee/keyring";
import { DELETE_VAULT_WARNING, LOST_PASSWORD_WARNING, MIGRATION_ROUTE, UNSUPPORTED_BUILD_TEXT } from "../src/e2ee/flows";
import { setE2eeBuildEnabledForTests } from "../src/e2ee/build";
import { FailureKind } from "../src/connstate";
import { fakePlugin, buttonByText, textByName, typeInto, flush, inputByPlaceholder, toggleByName, flipToggle, rowByName } from "./ui-dom-harness";

const GOOD = "correct horse battery staple";
const status = (root: any) => [...root.querySelectorAll("p")].map((p: any) => p.textContent).join("\n");

beforeEach(() => { setE2eeBuildEnabledForTests(true); __notices.length = 0; });

describe("EncryptionPasswordModal (E3b 1)", () => {
  it("refuses a short password, a mismatch and the login password; shows the lost-password warning; runs the work on a good pair", async () => {
    const plugin = fakePlugin();
    const work = vi.fn(async (_pw: string, progress: (f: number) => void) => { progress(0.5); });
    const m = new EncryptionPasswordModal(plugin.app, "login-pw-123", work);
    m.onOpen();
    expect(m.contentEl.textContent).toContain(LOST_PASSWORD_WARNING);
    typeInto(textByName(m.contentEl, "Encryption password"), "short");
    typeInto(textByName(m.contentEl, "Confirm encryption password"), "short");
    buttonByText(m.contentEl, "Encrypt and continue").click(); await flush();
    expect(status(m.contentEl)).toMatch(/at least 12/);
    expect(work).not.toHaveBeenCalled();
    typeInto(textByName(m.contentEl, "Encryption password"), GOOD);
    typeInto(textByName(m.contentEl, "Confirm encryption password"), GOOD + "x");
    buttonByText(m.contentEl, "Encrypt and continue").click(); await flush();
    expect(status(m.contentEl)).toMatch(/do not match/);
    typeInto(textByName(m.contentEl, "Encryption password"), "login-pw-123");
    typeInto(textByName(m.contentEl, "Confirm encryption password"), "login-pw-123");
    buttonByText(m.contentEl, "Encrypt and continue").click(); await flush();
    expect(status(m.contentEl)).toMatch(/login password/);
    expect(work).not.toHaveBeenCalled();
    typeInto(textByName(m.contentEl, "Encryption password"), GOOD);
    typeInto(textByName(m.contentEl, "Confirm encryption password"), GOOD);
    buttonByText(m.contentEl, "Encrypt and continue").click(); await flush();
    expect(work).toHaveBeenCalledTimes(1);
    expect(work.mock.calls[0][0]).toBe(GOOD);
    expect((m as any).closed).toBe(true);
    // the password field type is password: never echoed
    expect(Array.from(m.contentEl.querySelectorAll("input")).every((i: any) => i.type === "password")).toBe(true);
  });

  it("a failing work shows its message inline and keeps the modal open; cancel reports onCancel", async () => {
    const plugin = fakePlugin();
    const onCancel = vi.fn();
    const m = new EncryptionPasswordModal(plugin.app, "", async () => { throw new Error("vault exists (HTTP 409)"); }, { onCancel });
    m.onOpen();
    typeInto(textByName(m.contentEl, "Encryption password"), GOOD);
    typeInto(textByName(m.contentEl, "Confirm encryption password"), GOOD);
    buttonByText(m.contentEl, "Encrypt and continue").click(); await flush();
    expect(status(m.contentEl)).toContain("vault exists");
    expect((m as any).closed).toBe(false);
    m.onClose();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("JoinVaultModal (E3b 3)", () => {
  it("tells apart wrong password, unsupported and corrupt from the thrown KeyringError, and closes on success", async () => {
    const plugin = fakePlugin();
    let outcome: "wrongPassword" | "unsupported" | "corrupt" | "ok" = "wrongPassword";
    const work = vi.fn(async () => { if (outcome !== "ok") throw new KeyringError(outcome, outcome); });
    const m = new JoinVaultModal(plugin.app, work, { vaultLabel: "alice/notes" });
    m.onOpen();
    expect(m.contentEl.textContent).toContain("alice/notes");
    buttonByText(m.contentEl, "Join").click(); await flush();
    expect(status(m.contentEl)).toMatch(/Enter the encryption password/);
    expect(work).not.toHaveBeenCalled();
    typeInto(textByName(m.contentEl, "Encryption password"), "typo");
    buttonByText(m.contentEl, "Join").click(); await flush();
    expect(status(m.contentEl)).toMatch(/Wrong password/);
    outcome = "unsupported";
    buttonByText(m.contentEl, "Join").click(); await flush();
    expect(status(m.contentEl)).toMatch(/KDF parameters/);
    outcome = "corrupt";
    buttonByText(m.contentEl, "Join").click(); await flush();
    expect(status(m.contentEl)).toMatch(/corrupt/);
    expect((m as any).closed).toBe(false);
    outcome = "ok";
    buttonByText(m.contentEl, "Join").click(); await flush();
    expect((m as any).closed).toBe(true);
  });
});

describe("CreateConflictModal (E3b 1, the 409 rule)", () => {
  it("join: offers Join it only; delete: the route + both warnings behind one warn button; upgradeServer: names the version and offers nothing", async () => {
    const plugin = fakePlugin();
    const join = vi.fn(); const deleteThenRetry = vi.fn(async () => {});
    const a = new CreateConflictModal(plugin.app, "notes", { kind: "join" }, { join, deleteThenRetry });
    a.onOpen();
    expect(buttonByText(a.contentEl, "Join it")).toBeTruthy();
    expect(buttonByText(a.contentEl, "Delete it on the server and create encrypted")).toBeFalsy();
    buttonByText(a.contentEl, "Join it").click(); await flush();
    expect(join).toHaveBeenCalledTimes(1);
    const d = new CreateConflictModal(plugin.app, "notes", { kind: "delete" }, { join, deleteThenRetry });
    d.onOpen();
    expect(d.contentEl.textContent).toContain(MIGRATION_ROUTE);
    expect(d.contentEl.textContent).toContain(DELETE_VAULT_WARNING);
    expect(d.contentEl.textContent).toMatch(/not complete yet, or another device re-created/);
    expect(buttonByText(d.contentEl, "Join it")).toBeFalsy();
    buttonByText(d.contentEl, "Delete it on the server and create encrypted").click(); await flush();
    expect(deleteThenRetry).toHaveBeenCalledTimes(1);
    const u = new CreateConflictModal(plugin.app, "notes", { kind: "upgradeServer", minVersion: "1.33.0" }, { join, deleteThenRetry });
    u.onOpen();
    expect(u.contentEl.textContent).toContain("1.33.0");
    expect(buttonByText(u.contentEl, "Join it")).toBeFalsy();
    expect(buttonByText(u.contentEl, "Delete it on the server and create encrypted")).toBeFalsy();
  });
});

describe("SwitchVaultModal + SetupWizardModal: the Encrypt option (E3b 1, 12)", () => {
  it("the switch dialog's Encrypt toggle reaches createVaultFlow(name, true)", async () => {
    const plugin = fakePlugin();
    plugin.currentVaults = vi.fn(async () => ["notes"]);
    const m = new SwitchVaultModal(plugin.app, plugin as any);
    m.onOpen(); await flush(); await flush();
    typeInto(inputByPlaceholder(m.contentEl, "e.g. notes"), "secret");
    flipToggle(toggleByName(m.contentEl, "Encrypt the new vault"));
    buttonByText(m.contentEl, "Switch").click(); await flush(); await flush();
    expect(plugin.createVaultFlow).toHaveBeenCalledTimes(1);
    expect(plugin.createVaultFlow.mock.calls[0].slice(0, 2)).toEqual(["secret", true]);
  });

  it("with the define off, both Encrypt rows show the unsupported-build reason", async () => {
    setE2eeBuildEnabledForTests(false);
    const plugin = fakePlugin();
    plugin.currentVaults = vi.fn(async () => ["notes"]);
    const m = new SwitchVaultModal(plugin.app, plugin as any);
    m.onOpen(); await flush(); await flush();
    expect(rowByName(m.contentEl, "Encrypt the new vault").textContent).toContain(UNSUPPORTED_BUILD_TEXT);
    const w = new SetupWizardModal(plugin.app, plugin as any);
    (w as any).s.loggedIn = true; (w as any).s.vaults = ["notes"];
    w.onOpen(); await flush();
    expect(rowByName(w.contentEl, "Encrypt the new vault").textContent).toContain(UNSUPPORTED_BUILD_TEXT);
  });

  it("the wizard refuses an e2ee=1 setup link with the define off, before any sign-in", async () => {
    setE2eeBuildEnabledForTests(false);
    const plugin = fakePlugin();
    const w = new SetupWizardModal(plugin.app, plugin as any);
    w.onOpen(); await flush();
    const { encodeSetupLink } = await import("../src/connstr");
    const link = encodeSetupLink({ server: "https://s.example", user: "alice", vault: "notes", e2ee: true, vid: "EBESExQVFhcYGRobHB0eHw==" });
    buttonByText(w.contentEl, "Paste a link").click(); await flush();
    typeInto(inputByPlaceholder(w.contentEl, "selfsync…://…"), link);
    buttonByText(w.contentEl, "Use link").click(); await flush();
    expect(__notices.some((n: string) => n.includes(UNSUPPORTED_BUILD_TEXT))).toBe(true);
    // the state never took the link's server or vid
    expect((w as any).s.e2eeVid).toBeUndefined();
    expect((w as any).s.server).toBe("https://sync.example");
    // with the define on, the same link sets the vid the connect must see
    setE2eeBuildEnabledForTests(true);
    typeInto(inputByPlaceholder(w.contentEl, "selfsync…://…"), link);
    buttonByText(w.contentEl, "Use link").click(); await flush();
    expect((w as any).s.e2eeVid).toBe("EBESExQVFhcYGRobHB0eHw==");
    expect((w as any).s.server).toBe("https://s.example");
  });
});

describe("the status card and the Connection card (E3b 4, 6, 9, 12)", () => {
  function tab(plugin: any) { const t = new SelfSyncSettingTab(plugin.app, plugin); t.display(); return t; }
  function blocked(reason: FailureKind, settings: any = {}) {
    const plugin = fakePlugin({ settings });
    plugin.statusText = () => "blocked";
    plugin.blockReason = () => reason;
    plugin.getLastIssue = () => "the reason";
    return plugin;
  }

  it("E2eeJoinRequired offers Join, which reopens the prompt", () => {
    const plugin = blocked(FailureKind.E2eeJoinRequired);
    const t = tab(plugin);
    buttonByText(t.containerEl, "Join").click();
    expect(plugin.openJoinFromCard).toHaveBeenCalledTimes(1);
  });

  it("E2eeKeyringChanged offers Re-enrol", () => {
    const plugin = blocked(FailureKind.E2eeKeyringChanged);
    const t = tab(plugin);
    buttonByText(t.containerEl, "Re-enrol").click();
    expect(plugin.reenrol).toHaveBeenCalledTimes(1);
  });

  it("E2eeKeyringMissing on the owner offers Re-create encrypted (the create dialog with Encrypt on) and Delete on server", async () => {
    const plugin = blocked(FailureKind.E2eeKeyringMissing);
    const t = tab(plugin);
    buttonByText(t.containerEl, "Re-create encrypted").click();
    expect(plugin.recreateVault).toHaveBeenCalledWith(true);
    const del = Array.from(t.containerEl.querySelectorAll("button")).filter((b: any) => b.textContent === "Delete on server") as any[];
    expect(del.length).toBe(2); // the card action and the Connection row
    del[0].click(); await flush();
    expect(plugin.deleteVaultOnServer).toHaveBeenCalledTimes(1);
  });

  it("E2eeKeyringMissing on a grantee says 'ask the owner' and offers neither owner action", () => {
    const plugin = blocked(FailureKind.E2eeKeyringMissing, { vaultOwner: "alice" });
    const t = tab(plugin);
    expect(t.containerEl.textContent).toContain("ask the owner");
    expect(buttonByText(t.containerEl, "Re-create encrypted")).toBeFalsy();
    expect(buttonByText(t.containerEl, "Delete on server")).toBeFalsy(); // the Connection row is owner-only too
  });

  it("a pinned vault shows the end-to-end encrypted indicator; a plaintext one does not", () => {
    const plain = tab(fakePlugin());
    expect(plain.containerEl.textContent).not.toContain("end-to-end encrypted");
    const plugin = fakePlugin();
    plugin.e2eePin = () => ({ e2eeVaultId: "EBESExQVFhcYGRobHB0eHw==", vk: "00".repeat(32) });
    const enc = tab(plugin);
    expect(rowByName(enc.containerEl, "Vault").textContent).toContain("end-to-end encrypted");
  });

  it("the owner delete row carries the residue and re-share warning and calls deleteVaultOnServer in the idle state too", async () => {
    const plugin = fakePlugin();
    const t = tab(plugin);
    const row = rowByName(t.containerEl, "Delete this vault on the server");
    expect(row).toBeTruthy();
    row.querySelector("button").click(); await flush();
    expect(plugin.deleteVaultOnServer).toHaveBeenCalledTimes(1);
    const { confirmModal } = await import("../src/confirm");
    expect((confirmModal as any).mock.calls.at(-1)[1].body).toBe(DELETE_VAULT_WARNING);
  });
});

describe("the review fixes of Sprint 4 (E3b 1, 4, 5)", () => {
  it("CreateConflictModal: a close without a choice reports onCancel; a choice does not", async () => {
    const plugin = fakePlugin();
    const onCancel = vi.fn(); const join = vi.fn();
    const a = new CreateConflictModal(plugin.app, "notes", { kind: "join" }, { join, deleteThenRetry: async () => {}, onCancel });
    a.onOpen(); buttonByText(a.contentEl, "Cancel").click(); a.onClose();
    expect(onCancel).toHaveBeenCalledTimes(1);
    const b = new CreateConflictModal(plugin.app, "notes", { kind: "join" }, { join, deleteThenRetry: async () => {}, onCancel });
    b.onOpen(); buttonByText(b.contentEl, "Join it").click(); b.onClose();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(join).toHaveBeenCalledTimes(1);
  });

  it("RecreateVaultModal: a pinned name has Encrypt on and locked; an unpinned one offers the choice; a close answers undefined", async () => {
    const plugin = fakePlugin();
    let answer: boolean | undefined | "unset" = "unset";
    const pinned = new RecreateVaultModal(plugin.app, "notes", true, (v) => { answer = v; });
    pinned.onOpen();
    expect(toggleByName(pinned.contentEl, "Encrypt the vault").checked).toBe(true);
    expect(pinned.contentEl.textContent).toContain("Locked on");
    flipToggle(toggleByName(pinned.contentEl, "Encrypt the vault")); // locked: ignored
    buttonByText(pinned.contentEl, "Re-create").click(); pinned.onClose();
    expect(answer).toBe(true);
    answer = "unset";
    const plain = new RecreateVaultModal(plugin.app, "notes", false, (v) => { answer = v; });
    plain.onOpen();
    expect(toggleByName(plain.contentEl, "Encrypt the vault").checked).toBe(false);
    flipToggle(toggleByName(plain.contentEl, "Encrypt the vault"));
    buttonByText(plain.contentEl, "Re-create").click(); plain.onClose();
    expect(answer).toBe(true);
    answer = "unset";
    const closed = new RecreateVaultModal(plugin.app, "notes", false, (v) => { answer = v; });
    closed.onOpen(); closed.onClose();
    expect(answer).toBeUndefined();
  });

  it("the switch dialog stays open across the create and continues to the switch", async () => {
    const plugin = fakePlugin();
    plugin.currentVaults = vi.fn(async () => ["notes"]);
    const m = new SwitchVaultModal(plugin.app, plugin as any);
    m.onOpen(); await flush(); await flush();
    typeInto(inputByPlaceholder(m.contentEl, "e.g. notes"), "secret");
    flipToggle(toggleByName(m.contentEl, "Encrypt the new vault"));
    buttonByText(m.contentEl, "Switch").click(); await flush(); await flush(); await flush();
    expect(plugin.createVaultFlow).toHaveBeenCalledTimes(1);
    expect(plugin.switchToVault).toHaveBeenCalledWith("secret", "download", "", false); // no local data: adopt directly
  });

  it("E2eeLinkMismatch: the card says ask the owner for a current link and offers no Join or Re-enrol", () => {
    const plugin = fakePlugin();
    plugin.statusText = () => "blocked";
    plugin.blockReason = () => FailureKind.E2eeLinkMismatch;
    plugin.getLastIssue = () => "the reason";
    const t = new SelfSyncSettingTab(plugin.app, plugin); t.display();
    expect(t.containerEl.textContent).toContain("ask the owner for a current link");
    expect(buttonByText(t.containerEl, "Join")).toBeFalsy();
    expect(buttonByText(t.containerEl, "Re-enrol")).toBeFalsy();
  });

  it("the wizard's encrypted create on a 409 names the join and the Switch dialog, offers no delete, and a cancel restores the session", async () => {
    const plugin = fakePlugin();
    plugin.createEncryptedVault = vi.fn(async () => { throw new Error("create vault: HTTP 409 vault exists"); });
    const w = new SetupWizardModal(plugin.app, plugin as any);
    (w as any).s.loggedIn = true; (w as any).s.vaults = ["notes"]; (w as any).s.server = "https://new.example"; (w as any).s.username = "bob"; (w as any).s.password = "login-pw-123";
    (w as any).token = "tok-new";
    w.onOpen(); await flush();
    typeInto(inputByPlaceholder(w.contentEl, "e.g. notes"), "taken");
    flipToggle(toggleByName(w.contentEl, "Encrypt the new vault"));
    buttonByText(w.contentEl, "Start syncing").click(); await flush();
    // the password modal is the newest Modal; drive it through the plugin's app (the stub opens nothing), so find it by its work
    const modal = __opened.at(-1) as unknown as EncryptionPasswordModal;
    expect(modal).toBeInstanceOf(EncryptionPasswordModal);
    expect(plugin.settings.serverUrl).toBe("https://new.example"); // persisted for the create
    {
      modal.onOpen();
      typeInto(textByName(modal.contentEl, "Encryption password"), GOOD);
      typeInto(textByName(modal.contentEl, "Confirm encryption password"), GOOD);
      buttonByText(modal.contentEl, "Encrypt and continue").click(); await flush();
      expect(status(modal.contentEl)).toMatch(/already exists.*Switch vault/);
      expect(buttonByText(modal.contentEl, "Delete")).toBeFalsy();
      modal.onClose(); await flush();
    }
    expect(plugin.settings.serverUrl).toBe("https://sync.example"); // the cancel restored the session
    expect(plugin.settings.authToken).toBe("tok-abc");
  });
});
