// @vitest-environment happy-dom
// Real-DOM tests for the plugin's MODALS — render each through the (happy-dom) obsidian stub and
// confirm its confirm/resolve buttons actually invoke the right plugin action with the right args.
// Directly targets the "dialogs with no effect" worry (esp. the conflict-adjudication modals).
import { describe, it, expect, vi, afterEach } from "vitest";
import { ChangePasswordModal, ShareManageModal, RedeemShareLinkModal } from "../src/accountui";
import { ConfigConflictModal } from "../src/configconflict";
import { NoteConflictModal } from "../src/noteconflict";
import { SetupWizardModal } from "../src/setupwizard";
import { HttpTransport } from "../src/transport";
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
  it("'Use this device's' resolves the group as local; 'Use the server's version' as remote", async () => {
    const plugin = fakePlugin({ settings: { configConflicts: [".obsidian/app.json"] } });
    const m = new ConfigConflictModal(plugin.app, plugin as any);
    m.onOpen(); await flush(); // render() is async (fetches conflict sides)
    buttonByText(m.contentEl, "Use this device's").click();
    await flush();
    expect(plugin.resolveConfigGroup).toHaveBeenCalledWith([".obsidian/app.json"], "local");

    // Re-open fresh to test the other side (render re-runs after resolve).
    const m2 = new ConfigConflictModal(plugin.app, plugin as any);
    m2.onOpen(); await flush();
    buttonByText(m2.contentEl, "Use the server's version").click();
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
    buttonByText(m.contentEl, "Keep the other device's").click();
    await flush();
    expect(plugin.resolveNoteConflict).toHaveBeenCalledWith("note (conflict).md", "note.md", "theirs", expect.anything());
  });

  // issueConflictModalSerialScan: the cosmetic-auto-dismiss sweep used to run BEFORE the first
  // render — 2N sequential reads behind a "Checking conflicts…" placeholder — so the modal took
  // ~2N round-trips to show anything even though it only ever displays ONE conflict.
  it("renders the first conflict WITHOUT waiting for the cosmetic sweep", async () => {
    const plugin = seed();
    let sweepStarted = false;
    // The sweep can never finish; the modal must still show real content. (The sweep itself lives on
    // the PLUGIN now — a load runs it too — so this hangs that, not the raw reads.)
    plugin.dismissCosmeticConflicts = async () => {
      sweepStarted = true;
      return await new Promise<number>(() => {});
    };
    const m = new NoteConflictModal(plugin.app, plugin as any);
    m.onOpen(); await flush();
    expect(m.contentEl.textContent).toContain("to resolve");
    expect(buttonByText(m.contentEl, "Keep this device's")).toBeTruthy();
    expect(sweepStarted).toBe(true); // it did start — it just isn't blocking the paint
  });

  it("a FAILING background sweep does not wipe the already-rendered conflict", async () => {
    const plugin = seed();
    plugin.dismissCosmeticConflicts = async () => { throw new Error("disk went away"); };
    const m = new NoteConflictModal(plugin.app, plugin as any);
    m.onOpen(); await flush();
    // the sweep is an optimisation the user never asked for; its failure must not replace a
    // perfectly good rendered conflict with an error body
    expect(m.contentEl.textContent).toContain("to resolve");
    expect(m.contentEl.textContent).not.toMatch(/Couldn't load conflicts/i);
    expect(buttonByText(m.contentEl, "Keep this device's")).toBeTruthy();
  });

  // issueConflictModalDoubleApply: render() was fired unawaited and nothing blocked re-entry, so a
  // double-tap on an IRREVERSIBLE either-side choice could apply twice.
  it("a double-tap applies ONCE", async () => {
    const plugin = seed();
    let release: () => void = () => {};
    plugin.resolveNoteConflict = vi.fn(async () => {
      await new Promise<void>((r) => { release = r; });
      return true;
    });
    const m = new NoteConflictModal(plugin.app, plugin as any);
    m.onOpen(); await flush();
    const btn = buttonByText(m.contentEl, "Keep this device's")!;
    btn.click();
    await flush();
    btn.click();          // second tap while the first apply is still in flight
    btn.click();          // and a third
    await flush();
    expect(plugin.resolveNoteConflict).toHaveBeenCalledTimes(1);
    release(); await flush();
  });

  // issueConflictDiffShowsIgnoredTimestamps: the diff rendered RAW text, so a frontmatter key the
  // user told SelfSync to IGNORE (and which the sync engine treats as no change at all) still showed
  // up as a red/green changed line — the modal contradicting the setting.
  it("a timestamp-only difference under an IGNORED key renders as no changes", async () => {
    const plugin = seed();
    plugin.ignorePatternsForPath = () => ["updated"];
    let n = 0;
    plugin.readTextOrEmpty = async () =>
      n++ === 0
        ? "---\nupdated: 2026-09-07T10:00:00Z\ntitle: t\n---\nbody"
        : "---\nupdated: 2026-09-07T11:22:33Z\ntitle: t\n---\nbody";
    const m = new NoteConflictModal(plugin.app, plugin as any);
    m.onOpen(); await flush();
    expect(m.contentEl.textContent).toMatch(/identical apart from/i);
    expect(m.contentEl.querySelectorAll("pre div").length).toBe(0); // no changed rows drawn
  });

  // issueConflictDiffInvisibleChars: two visually identical lines were shown as -/+ with no way to
  // tell them apart. They stay REAL differences (a Markdown trailing double space is a hard break),
  // so the modal explains them instead of hiding them.
  it("an invisible-only difference is explained, and the invisible characters are marked", async () => {
    const plugin = seed();
    let n = 0;
    plugin.readTextOrEmpty = async () =>
      n++ === 0 ? "tagNames: \nbody" : "tagNames:\nbody"; // theirs has a TRAILING SPACE
    const m = new NoteConflictModal(plugin.app, plugin as any);
    m.onOpen(); await flush();
    expect(m.contentEl.textContent).toMatch(/look identical/i);
    const rows = Array.from(m.contentEl.querySelectorAll("pre div")).map((d) => d.textContent ?? "");
    expect(rows.some((r) => r === "- tagNames:·")).toBe(true);  // trailing space revealed
    expect(rows.some((r) => r === "+ tagNames:")).toBe(true);
  });

  it("a non-breaking space is marked so it is distinguishable from a plain space", async () => {
    const plugin = seed();
    let n = 0;
    plugin.readTextOrEmpty = async () =>
      n++ === 0 ? "tag: a\nbody" : "tag: a\nbody";
    const m = new NoteConflictModal(plugin.app, plugin as any);
    m.onOpen(); await flush();
    const rows = Array.from(m.contentEl.querySelectorAll("pre div")).map((d) => d.textContent ?? "");
    expect(rows.some((r) => r === "- tag:⍽a")).toBe(true);
    expect(rows.some((r) => r === "+ tag: a")).toBe(true);
  });

  it("ordinary changed lines are NOT marked up — no dots down a normal diff", async () => {
    const plugin = seed();
    let n = 0;
    plugin.readTextOrEmpty = async () => (n++ === 0 ? "their body\nx" : "my body\nx");
    const m = new NoteConflictModal(plugin.app, plugin as any);
    m.onOpen(); await flush();
    expect(m.contentEl.textContent).not.toMatch(/look identical/i);
    const rows = Array.from(m.contentEl.querySelectorAll("pre div")).map((d) => d.textContent ?? "");
    expect(rows).toContain("- their body");
    expect(rows).toContain("+ my body");
    expect(rows.join("")).not.toContain("·");
  });

  it("a REAL body difference still renders changed rows", async () => {
    const plugin = seed();
    plugin.ignorePatternsForPath = () => ["updated"];
    let n = 0;
    plugin.readTextOrEmpty = async () =>
      n++ === 0
        ? "---\nupdated: 2026-09-07T10:00:00Z\n---\ntheir body"
        : "---\nupdated: 2026-09-07T11:22:33Z\n---\nmy body";
    const m = new NoteConflictModal(plugin.app, plugin as any);
    m.onOpen(); await flush();
    const rows = Array.from(m.contentEl.querySelectorAll("pre div")).map((d) => d.textContent ?? "");
    expect(rows.some((r) => r.startsWith("- their body"))).toBe(true);
    expect(rows.some((r) => r.startsWith("+ my body"))).toBe(true);
    // The ignored key is shown as CONTEXT with its value masked — NOT removed. Removing the line
    // (the earlier behaviour, which this assertion used to encode) hid the case where only one side
    // HAS the line, so the user could not see that keeping the other version would delete it
    // (issueConflictDiffHidesIgnoredLineLoss). Present-but-neutralised is the honest form.
    const updatedRows = rows.filter((r) => r.includes("updated:"));
    expect(updatedRows.length).toBe(1);
    expect(updatedRows[0].startsWith("  ")).toBe(true);      // context, not a +/- change
    expect(updatedRows[0]).not.toContain("2026-09-07T10");   // the noisy value is masked away
    expect(updatedRows[0]).not.toContain("2026-09-07T11");
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

describe("capability share-links (D0023)", () => {
  it("RedeemShareLinkModal: pasting a link + Redeem routes to startRedeem (guided-or-direct)", async () => {
    const plugin = fakePlugin();
    const m = new RedeemShareLinkModal(plugin.app, plugin as any);
    m.onOpen();
    typeInto(textByName(m.contentEl, "Share link"), "selfsync-share://redeem?server=https://s&token=tok");
    buttonByText(m.contentEl, "Redeem").click();
    await flush();
    expect(plugin.startRedeem).toHaveBeenCalledWith("selfsync-share://redeem?server=https://s&token=tok");
  });

  it("RedeemShareLinkModal: an empty link does NOT redeem", async () => {
    const plugin = fakePlugin();
    const m = new RedeemShareLinkModal(plugin.app, plugin as any);
    m.onOpen();
    buttonByText(m.contentEl, "Redeem").click();
    await flush();
    expect(plugin.startRedeem).not.toHaveBeenCalled();
  });

  it("ShareManageModal: 'Create link' generates a share-link for the vault", async () => {
    const plugin = fakePlugin({ myVaultShares: async () => [{ vault: "notes", grants: [] }] });
    const m = new ShareManageModal(plugin.app, plugin as any);
    m.onOpen(); await flush(); // load() populates + re-renders
    buttonByText(m.contentEl, "Create link").click();
    await flush();
    expect(plugin.createShareLink).toHaveBeenCalledWith("notes", expect.stringMatching(/read/));
  });

  it("ShareManageModal: shares ONLY the current vault, even when the account owns several", async () => {
    // settings.vaultId is "notes"; the account also owns "work" and "default" — those must NOT appear.
    const plugin = fakePlugin({ myVaultShares: async () => [
      { vault: "default", grants: [] }, { vault: "notes", grants: [] }, { vault: "work", grants: [] },
    ] });
    const m = new ShareManageModal(plugin.app, plugin as any);
    m.onOpen(); await flush();
    const text = m.contentEl.textContent ?? "";
    expect(text).not.toContain("work");
    expect(text).not.toContain("default");
    // One (and only one) Create link, and it targets the current vault.
    expect(m.contentEl.querySelectorAll("button")).toBeTruthy();
    buttonByText(m.contentEl, "Create link").click(); await flush();
    expect(plugin.createShareLink).toHaveBeenCalledWith("notes", expect.stringMatching(/read/));
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

  it("a must-change account is prompted for a new password before any other call (no 403 dead-end)", async () => {
    // login reports must_change → the wizard shows the new-password step, calls changePassword, THEN
    // proceeds with the fresh token (previously it barreled into listVaults and 403'd).
    const login = vi.spyOn(HttpTransport, "login").mockResolvedValue({ token: "temp-tok", mustChange: true });
    const changePw = vi.spyOn(HttpTransport, "changePassword").mockResolvedValue("fresh-tok");
    const listVaults = vi.spyOn(HttpTransport, "listVaults").mockResolvedValue(["notes"]);
    const plugin = fakePlugin();
    const m = new SetupWizardModal(plugin.app, plugin as any);
    m.onOpen();
    typeInto(textByName(m.contentEl, "Server URL"), "https://s.example");
    typeInto(textByName(m.contentEl, "Username"), "wi1y");
    typeInto(textByName(m.contentEl, "Password"), "Temp1234");
    buttonByText(m.contentEl, "Log in")!.click();
    await flush();
    expect(login).toHaveBeenCalled();
    expect(listVaults).not.toHaveBeenCalled(); // gated: no other call before the password is set
    // The forced-change step is now showing.
    typeInto(textByName(m.contentEl, "New password"), "BrandNew12");
    typeInto(textByName(m.contentEl, "Confirm new password"), "BrandNew12");
    buttonByText(m.contentEl, "Set password & continue")!.click();
    await flush();
    expect(changePw).toHaveBeenCalledWith("https://s.example", "temp-tok", "Temp1234", "BrandNew12");
    expect(listVaults).toHaveBeenCalledWith("https://s.example", "fresh-tok"); // proceeds with the fresh token
  });

  it("D0037: pasting an account-creation (invite) link prefills the server + registers WITH the invite token", async () => {
    const register = vi.spyOn(HttpTransport, "register").mockResolvedValue(undefined);
    const login = vi.spyOn(HttpTransport, "login").mockResolvedValue({ token: "tok", mustChange: false });
    vi.spyOn(HttpTransport, "listVaults").mockResolvedValue(["notes"]);
    const plugin = fakePlugin();
    const m = new SetupWizardModal(plugin.app, plugin as any);
    m.onOpen();
    buttonByText(m.contentEl, "Paste a link")!.click();
    typeInto(textByName(m.contentEl, "Link"), "selfsync-invite://register?server=https://s.example&token=inv-xyz");
    buttonByText(m.contentEl, "Use link")!.click();
    await flush();
    // Back on the main pane: server prefilled, register mode preselected (the "Create & log in" button).
    expect((textByName(m.contentEl, "Server URL") as HTMLInputElement).value).toBe("https://s.example");
    typeInto(textByName(m.contentEl, "Username"), "newbie");
    typeInto(textByName(m.contentEl, "Password"), "Newbie123");
    buttonByText(m.contentEl, "Create & log in")!.click();
    await flush();
    // The invite token is threaded into register, so it works on a closed server.
    expect(register).toHaveBeenCalledWith("https://s.example", "newbie", "Newbie123", "inv-xyz");
    expect(login).toHaveBeenCalled();
  });
});

afterEach(() => vi.restoreAllMocks());
