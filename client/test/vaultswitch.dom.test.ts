// @vitest-environment happy-dom
// Real-DOM tests for SwitchVaultModal (src/vaultswitch.ts) — the highest-value surface: it drives the
// DESTRUCTIVE vault-switch flows (download/upload mirror deletes, fork overwrite). We mock its
// confirmModal dependency so we can assert the destructive GUARD behavior (proceed vs abort) exactly,
// and drive the real modal's flow methods. A bug here means permanent, unrecoverable data loss.
import { describe, it, expect, vi, beforeEach } from "vitest";

// The modal calls confirmModal from ../src/confirm — mock THAT dependency (not the code under test).
vi.mock("../src/confirm", () => ({ confirmModal: vi.fn() }));

import { SwitchVaultModal } from "../src/vaultswitch";
import { confirmModal } from "../src/confirm";
import { makeApp, fakePlugin, buttonByText, flush } from "./ui-dom-harness";

const cm = vi.mocked(confirmModal);
beforeEach(() => cm.mockReset());

function build(over: any = {}) {
  const plugin = fakePlugin({
    currentVaults: vi.fn(async () => ["notes", "other"]),
    listSharedVaults: vi.fn(async () => [] as any[]),
    hasLocalData: vi.fn(async () => true),
    switchToVault: vi.fn(async () => {}),
    forkVault: vi.fn(async () => {}),
    createRemoteVault: vi.fn(async () => {}),
    leaveSharedVault: vi.fn(async () => {}),
    settings: { vaultId: "notes" },
    ...over,
  });
  const m = new SwitchVaultModal(makeApp(), plugin as any);
  return { m, plugin };
}

// Drive the modal into the resolve view for a chosen target (private methods reached via `as any`;
// TS `private` is not enforced at runtime, and the REAL modal code runs).
function toResolve(m: any, target: string, readOnly: boolean, owner = "") {
  m.target = target; m.targetReadOnly = readOnly; m.targetOwner = owner;
  m.renderResolve();
}

describe("SwitchVaultModal — merge vs mirror guards", () => {
  it("Merge needs NO confirm and switches in merge mode", async () => {
    const { m, plugin } = build();
    m.onOpen(); await flush();
    toResolve(m as any, "other", false);
    buttonByText(m.contentEl, "Merge").click();
    await flush();
    expect(plugin.switchToVault).toHaveBeenCalledWith("other", "merge", "", false);
    expect(cm).not.toHaveBeenCalled();
  });

  it("Download is gated: proceeds when confirmed true", async () => {
    const { m, plugin } = build();
    m.onOpen(); await flush();
    toResolve(m as any, "other", false);
    cm.mockResolvedValue(true);
    buttonByText(m.contentEl, "Download").click();
    await flush();
    expect(cm).toHaveBeenCalled();
    expect(plugin.switchToVault).toHaveBeenCalledWith("other", "download", "", false);
  });

  it("Download does NOT switch when the confirm is declined", async () => {
    const { m, plugin } = build();
    m.onOpen(); await flush();
    toResolve(m as any, "other", false);
    cm.mockResolvedValue(false);
    buttonByText(m.contentEl, "Download").click();
    await flush();
    expect(cm).toHaveBeenCalled();
    expect(plugin.switchToVault).not.toHaveBeenCalled();
  });

  it("Upload is gated: proceeds when confirmed true", async () => {
    const { m, plugin } = build();
    m.onOpen(); await flush();
    toResolve(m as any, "other", false);
    cm.mockResolvedValue(true);
    buttonByText(m.contentEl, "Upload").click();
    await flush();
    expect(plugin.switchToVault).toHaveBeenCalledWith("other", "upload", "", false);
  });

  it("Upload does NOT switch when the confirm is declined", async () => {
    const { m, plugin } = build();
    m.onOpen(); await flush();
    toResolve(m as any, "other", false);
    cm.mockResolvedValue(false);
    buttonByText(m.contentEl, "Upload").click();
    await flush();
    expect(plugin.switchToVault).not.toHaveBeenCalled();
  });
});

describe("SwitchVaultModal — read-only resolve view", () => {
  it("omits Upload for a read-only target and includes it for read-write", async () => {
    const { m } = build();
    m.onOpen(); await flush();
    toResolve(m as any, "shared", true);
    expect(buttonByText(m.contentEl, "Download")).toBeTruthy();
    expect(buttonByText(m.contentEl, "Upload")).toBeFalsy();
    toResolve(m as any, "shared", false);
    expect(buttonByText(m.contentEl, "Upload")).toBeTruthy();
  });
});

describe("SwitchVaultModal — SF1 data-loss guard (selectShared)", () => {
  it("read-only share WITH local data shows the resolve prompt and never auto-downloads", async () => {
    const { m, plugin } = build({ hasLocalData: vi.fn(async () => true) });
    m.onOpen(); await flush();
    await (m as any).selectShared({ owner: "bob", vault: "shared", perm: "read" });
    await flush();
    // Must NOT silently mirror-delete: no download call, and the resolve prompt is showing.
    expect(plugin.switchToVault).not.toHaveBeenCalled();
    expect(buttonByText(m.contentEl, "Merge")).toBeTruthy();
    expect((m as any).targetReadOnly).toBe(true); // SF3: "read" fails closed to read-only
  });

  it("read-only share with NO local data auto-applies download", async () => {
    const { m, plugin } = build({ hasLocalData: vi.fn(async () => false) });
    m.onOpen(); await flush();
    cm.mockResolvedValue(true); // download still passes through the destructive confirm
    await (m as any).selectShared({ owner: "bob", vault: "shared", perm: "read" });
    await flush();
    expect(plugin.switchToVault).toHaveBeenCalledWith("shared", "download", "bob", true);
  });
});

describe("SwitchVaultModal — doFork overwrite guard", () => {
  it("a name that collides with an existing vault confirms, and does NOT fork when declined", async () => {
    const { m, plugin } = build();
    m.onOpen(); await flush();
    (m as any).forkName = "notes"; // already in currentVaults()
    cm.mockResolvedValue(false);
    await (m as any).doFork();
    expect(cm).toHaveBeenCalled();
    expect(plugin.forkVault).not.toHaveBeenCalled();
  });

  it("proceeds to fork when the collision is confirmed", async () => {
    const { m, plugin } = build();
    m.onOpen(); await flush();
    (m as any).forkName = "notes";
    cm.mockResolvedValue(true);
    await (m as any).doFork();
    expect(plugin.forkVault).toHaveBeenCalledWith("notes");
  });

  it("an invalid name never confirms and never forks", async () => {
    const { m, plugin } = build();
    m.onOpen(); await flush();
    (m as any).forkName = "Bad Name"; // sanitizes to "bad name" — the space is invalid
    await (m as any).doFork();
    expect(cm).not.toHaveBeenCalled();
    expect(plugin.forkVault).not.toHaveBeenCalled();
  });
});
