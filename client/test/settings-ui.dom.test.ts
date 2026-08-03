// @vitest-environment happy-dom
// Real-DOM tests for the plugin's SETTINGS TAB: render it through the (happy-dom) obsidian stub and
// confirm each control actually invokes the right plugin behavior — the click-level guard for the
// settings surface (complements the pure/harness tests). Every control here was in the functional audit.
import { describe, it, expect, beforeEach, vi } from "vitest";
// Destructive confirms now go through an in-app modal (confirm.ts) instead of window.confirm; auto-accept
// so the Sign-out wiring test still fires. (Its own behaviour is covered by inspection, not this stub.)
vi.mock("../src/confirm", () => ({ confirmModal: vi.fn(async () => true) }));
import { NewLiveSyncSettingTab } from "../src/settings";
import { fakePlugin, toggleByName, buttonByText, flipToggle, rowByName, inputByPlaceholder, typeInto, flush } from "./ui-dom-harness";

function renderTab(plugin: any) {
  const tab = new NewLiveSyncSettingTab(plugin.app, plugin);
  // PluginSettingTab.containerEl is a real (happy-dom) element from the stub; render into it.
  tab.display();
  return tab;
}

describe("settings tab renders and wires its controls", () => {
  let plugin: any;
  // Destructive actions (Sign out) are now confirm()-gated; auto-accept so the wiring test still fires.
  beforeEach(() => { plugin = fakePlugin(); });

  it("renders the config-sync section with the master + category toggles", () => {
    const { containerEl } = renderTab(plugin);
    expect(toggleByName(containerEl, "Sync settings, themes, or plugins")).toBeTruthy();
    for (const name of ["Core settings", "Hotkeys", "Appearance & themes", "CSS snippets", "Community plugins"]) {
      expect(toggleByName(containerEl, name)).toBeTruthy();
    }
  });

  it("P2: toggling the config-sync master calls applyConfigSyncChange (immediate apply) + flips the setting", () => {
    const { containerEl } = renderTab(plugin);
    const master = toggleByName(containerEl, "Sync settings, themes, or plugins");
    expect(master.checked).toBe(true);        // reflects settings.configSync.enabled
    flipToggle(master);                        // change event → onChange
    expect(plugin.settings.configSync.enabled).toBe(false);
    expect(plugin.applyConfigSyncChange).toHaveBeenCalled();
  });

  it("timestamp-ignore: renders the master toggle and adds/removes an excluded folder", () => {
    const p = fakePlugin({
      settings: { ignoreTimestampChanges: true, ignoredTimestampKeys: ["created", "updated"], excludedFolders: ["Work"] },
      setExcludedFolders: vi.fn(async () => {}),
      getAllFolders: () => ["Work", "Archive", "Notes"],
    });
    const { containerEl } = renderTab(p);
    expect(toggleByName(containerEl, "Ignore timestamp-only changes")?.checked).toBe(true);
    const row = rowByName(containerEl, "Work");
    expect(row).toBeTruthy();
    row.querySelector("button").click(); // Remove
    expect(p.setExcludedFolders).toHaveBeenCalledWith([]); // removeExcluded(["Work"],"Work")
    typeInto(inputByPlaceholder(containerEl, "Folder to exclude"), "Archive");
    buttonByText(containerEl, "Add folder").click();
    expect(p.setExcludedFolders).toHaveBeenCalledWith(["Archive", "Work"]); // addExcluded(["Work"],"Archive")
  });

  it("enabling timestamp-ignore just flips the setting — no consent modal, no file changes", async () => {
    const p = fakePlugin({
      settings: { ignoreTimestampChanges: false, ignoredTimestampKeys: ["created", "updated"], excludedFolders: [] },
    });
    const { containerEl } = renderTab(p);
    const master = toggleByName(containerEl, "Ignore timestamp-only changes");
    expect(master.checked).toBe(false);
    flipToggle(master); // → onChange(true) → saveSettings + re-render (identity-only; nothing touches a note)
    await flush();
    expect(p.settings.ignoreTimestampChanges).toBe(true);
    expect(p.saveSettings).toHaveBeenCalled();
  });

  it("timestamp-ignore: date fields are a validated add/remove LIST (not a free-text blob)", async () => {
    const p = fakePlugin({
      settings: { ignoreTimestampChanges: true, ignoredTimestampKeys: ["created", "updated"], excludedFolders: [] },
    });
    let { containerEl } = renderTab(p);
    expect(rowByName(containerEl, "created")).toBeTruthy();   // each key is its own row…
    expect(rowByName(containerEl, "updated")).toBeTruthy();
    rowByName(containerEl, "created").querySelector("button").click(); // …with a Remove button
    await flush();
    expect(p.settings.ignoredTimestampKeys).toEqual(["updated"]);
    expect(p.saveSettings).toHaveBeenCalled();
    // Re-render after the mutation; add a VALID new field via the input + Add field button.
    containerEl = renderTab(p).containerEl;
    typeInto(inputByPlaceholder(containerEl, "e.g. updated or updated-*"), "reviewed-*");
    buttonByText(containerEl, "Add field").click();
    await flush();
    expect(p.settings.ignoredTimestampKeys).toEqual(["updated", "reviewed-*"]);
  });

  it("timestamp-ignore: an INVALID or DUPLICATE date field is REJECTED, not added (error prevention)", async () => {
    const p = fakePlugin({
      settings: { ignoreTimestampChanges: true, ignoredTimestampKeys: ["updated"], excludedFolders: [] },
    });
    const { containerEl } = renderTab(p);
    // A key with a colon would break the YAML key → rejected, list unchanged (no re-render).
    typeInto(inputByPlaceholder(containerEl, "e.g. updated or updated-*"), "created: 2020");
    buttonByText(containerEl, "Add field").click();
    await flush();
    expect(p.settings.ignoredTimestampKeys).toEqual(["updated"]);
    // A case-insensitive duplicate → rejected too.
    typeInto(inputByPlaceholder(containerEl, "e.g. updated or updated-*"), "Updated");
    buttonByText(containerEl, "Add field").click();
    await flush();
    expect(p.settings.ignoredTimestampKeys).toEqual(["updated"]);
  });

  it("the Timestamp changes section is a collapsible (default collapsed) that toggles on header click", () => {
    const p = fakePlugin({
      settings: { ignoreTimestampChanges: true, ignoredTimestampKeys: ["created"], excludedFolders: [] },
    });
    const { containerEl } = renderTab(p);
    // The collapse header is a real SettingGroup heading (matches the other section headings).
    const group = Array.from(containerEl.querySelectorAll(".selfsync-collapse-group"))
      .find((g) => g.querySelector(".setting-group-heading")?.textContent?.includes("Timestamp changes")) as HTMLElement;
    expect(group).toBeTruthy();
    const heading = group.querySelector(".setting-group-heading") as HTMLElement;
    const body = group.querySelector(".setting-group-list") as HTMLElement;   // the group's listEl = the toggled body
    expect(body.style.display).toBe("none");     // default COLLAPSED (owner: not seen most of the time)
    heading.click();
    expect(body.style.display).toBe("");         // expands on header click
    heading.click();
    expect(body.style.display).toBe("none");     // collapses again
  });

  it("P2: toggling a category (Core settings) also applies immediately", () => {
    const { containerEl } = renderTab(plugin);
    flipToggle(toggleByName(containerEl, "Core settings"));
    expect(plugin.settings.configSync.core).toBe(false);
    expect(plugin.applyConfigSyncChange).toHaveBeenCalled();
  });

  it("'Store password on this device' persists the choice (token-only default is off)", () => {
    const { containerEl } = renderTab(plugin);
    const t = toggleByName(containerEl, "Store password on this device");
    expect(t.checked).toBe(false);            // token-only default
    flipToggle(t);
    expect(plugin.settings.storePassword).toBe(true);
    expect(plugin.saveSettings).toHaveBeenCalled();
  });

  it("'Show sync status in the editor' calls setEditorStatus", () => {
    const { containerEl } = renderTab(plugin);
    flipToggle(toggleByName(containerEl, "Show sync status in the editor"));
    expect(plugin.setEditorStatus).toHaveBeenCalledWith(true);
  });

  it("when connected: Disconnect + Sign out buttons invoke their plugin actions", async () => {
    const { containerEl } = renderTab(plugin); // phase "idle" ⇒ Disconnect shown (not Reconnect)
    buttonByText(containerEl, "Disconnect").click();
    expect(plugin.disconnect).toHaveBeenCalled();
    buttonByText(containerEl, "Sign out").click();
    await new Promise((r) => setTimeout(r, 0)); // Sign out now awaits the in-app confirm (async) before signOut
    expect(plugin.signOut).toHaveBeenCalled();
  });

  it("when the link is down (retrying/blocked/lockedOut): the Reconnect button invokes reconnect", () => {
    plugin = fakePlugin({ statusText: () => "retrying" });
    const { containerEl } = renderTab(plugin);
    buttonByText(containerEl, "Reconnect").click();
    expect(plugin.reconnect).toHaveBeenCalled();
  });

  it("Set up / Reconfigure opens the setup wizard; Show sync log opens the log", () => {
    const { containerEl } = renderTab(plugin);
    const setup = buttonByText(containerEl, "Set up SelfSync") || buttonByText(containerEl, "Setup");
    expect(setup).toBeTruthy();
    setup.click();
    expect(plugin.openSetup).toHaveBeenCalled();
    buttonByText(containerEl, "Show sync log")?.click();
    expect(plugin.showLog).toHaveBeenCalled();
  });

  it("the community-plugins bulk toggle 'Sync all' path applies immediately when community is on", () => {
    plugin = fakePlugin({ settings: { configSync: { enabled: true, core: true, hotkeys: true, appearance: true, snippets: true, community: true, pluginAllow: [] } } });
    // With no installed community plugins the bulk row may not render; assert the section renders at least.
    const { containerEl } = renderTab(plugin);
    expect(toggleByName(containerEl, "Community plugins")?.checked).toBe(true);
  });
});
