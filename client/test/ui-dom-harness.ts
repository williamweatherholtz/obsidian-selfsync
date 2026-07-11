// Shared harness for the happy-dom UI tests (settings tab + modals). Provides a fake plugin that
// covers every method/prop the UI surfaces call (spies for actions, canned data for reads), plus DOM
// query helpers to find rendered controls by their label/text and assert their wiring.
import { vi } from "vitest";

export function makeApp(): any {
  return {
    workspace: { on: () => ({}), getActiveViewOfType: () => null, onLayoutReady: (cb: any) => cb(), trigger: () => {} },
    vault: { on: () => ({}), adapter: {}, getAbstractFileByPath: () => null },
    setting: { close: () => {} },
  };
}

// A fake NewLiveSyncPlugin: real `settings`, spy action methods, canned reads. Cast `as any` at the
// call site (it stands in for the concrete plugin type). Override any member via `over`.
export function fakePlugin(over: any = {}) {
  const settings = {
    serverUrl: "https://sync.example", username: "alice", password: "", vaultId: "notes",
    authToken: "tok-abc", storePassword: false, deviceName: "", editorStatus: false,
    vaultOwner: "", vaultReadOnly: false, lastSyncedAt: 0, apiVersion: 1,
    configSync: { enabled: true, core: true, hotkeys: true, appearance: true, snippets: true, community: false, pluginAllow: [] as string[] },
    configConflicts: [] as string[], noteConflicts: [] as { copy: string; original: string }[],
    ...(over.settings || {}),
  };
  const p: any = {
    app: makeApp(),
    settings,
    saveSettings: vi.fn(async () => {}),
    applyConfigSyncChange: vi.fn(async () => {}),
    reconnect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}),
    recreateVault: vi.fn(async () => {}),
    diagnoseConnection: vi.fn(async () => ({ ok: true, steps: [] })),
    addDeviceLink: vi.fn(() => "selfsync://link"),
    autoDeviceName: vi.fn(async () => "Test Device"),
    getConfigConflicts: () => settings.configConflicts,
    configConflictSides: vi.fn(async () => ({ local: true, remote: true })),
    resolveConfigGroup: vi.fn(async () => {}),
    getLastIssue: () => undefined,
    getLogText: () => "",
    isVaultGone: () => false,
    listNoteConflicts: () => settings.noteConflicts,
    readTextOrEmpty: vi.fn(async () => "content"),
    resolveNoteConflict: vi.fn(async () => true),
    openConfigConflicts: vi.fn(),
    openNoteConflicts: vi.fn(),
    openSetup: vi.fn(),
    setEditorStatus: vi.fn(),
    showLog: vi.fn(),
    selfFolderId: () => "obsidian-selfsync",
    statusText: () => "idle",
    statusListener: undefined,
    settingsRefresh: undefined,
    changePassword: vi.fn(async () => {}),
    myVaultShares: vi.fn(async () => []),
    shareVault: vi.fn(async () => {}),
    unshareVault: vi.fn(async () => {}),
    createShareLink: vi.fn(async () => "selfsync-share://redeem?server=https%3A%2F%2Fsync.example&token=tok"),
    listShareLinks: vi.fn(async () => []),
    revokeShareLink: vi.fn(async () => {}),
    redeemShareLink: vi.fn(async () => ({ owner: "alice", vault: "notes", perm: "readWrite" })),
    ...over,
  };
  p.settings = settings;
  return p;
}

// ---- DOM query helpers (operate on a rendered container / modal contentEl) ----------------------

export const rows = (root: any): any[] => [...root.querySelectorAll(".setting-item")];
export const rowByName = (root: any, name: string): any =>
  rows(root).find((r) => r.querySelector(".setting-item-name")?.textContent === name);
export const toggleByName = (root: any, name: string): any =>
  rowByName(root, name)?.querySelector('input[type="checkbox"]');
export const buttonByText = (root: any, text: string): any =>
  [...root.querySelectorAll("button")].find((b: any) => b.textContent === text);
export const textByName = (root: any, name: string): any =>
  rowByName(root, name)?.querySelector('input[type="text"], input[type="password"]');
export const inputByPlaceholder = (root: any, ph: string): any =>
  [...root.querySelectorAll("input")].find((i: any) => i.placeholder === ph);

// Flip a checkbox and fire the "change" event the onChange wiring listens for. (An explicit dispatch
// is more reliable across DOM implementations than relying on click() to both toggle AND emit change.)
export function flipToggle(cb: any) {
  cb.checked = !cb.checked;
  cb.dispatchEvent(new Event("change", { bubbles: true }));
}
// Set an input's value and fire the "input" event the onChange wiring listens for.
export function typeInto(input: any, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
// Flush pending microtasks (async render() in modals).
export const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
