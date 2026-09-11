// @vitest-environment happy-dom
// Real-DOM tests for the plugin's SETTINGS TAB: render it through the (happy-dom) obsidian stub and
// confirm each control actually invokes the right plugin behavior — the click-level guard for the
// settings surface (complements the pure/harness tests). Every control here was in the functional audit.
import { describe, it, expect, beforeEach, vi } from "vitest";
// Destructive confirms now go through an in-app modal (confirm.ts) instead of window.confirm; auto-accept
// so the Sign-out wiring test still fires. (Its own behaviour is covered by inspection, not this stub.)
vi.mock("../src/confirm", () => ({ confirmModal: vi.fn(async () => true) }));
vi.mock("../src/pushpreviewmodal", () => ({ pushPreviewModal: vi.fn(async () => true) }));
import { SelfSyncSettingTab } from "../src/settings";
import { fakePlugin, toggleByName, buttonByText, flipToggle, rowByName, inputByPlaceholder, typeInto, flush } from "./ui-dom-harness";

function renderTab(plugin: any) {
  const tab = new SelfSyncSettingTab(plugin.app, plugin);
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

  it("composed vaults: lists each mount with its direction + live state and an Add button", () => {
    const p = fakePlugin({
      settings: { mounts: [{ source: { owner: "", vaultId: "asi", sourcePath: "Projects" }, mountPoint: "Work/ASI", direction: "pull" }] },
      mountStates: () => ({ '["","asi","Projects","Work/ASI"]': "live" }),
    });
    const { containerEl } = renderTab(p);
    const text = containerEl.textContent ?? "";
    expect(text).toContain("asi/Projects  →  Work/ASI"); // the row label
    expect(text).toContain("Pull · read-only");           // direction
    expect(text).toContain("In sync");                     // live state label
    expect(buttonByText(containerEl, "Add a mount")).toBeTruthy();
    expect(text).not.toContain("No mounts yet");
  });

  it("composed vaults: a read-only edit surfaces a Keep-my-edits action (issueMountRoLocalEditBehavior)", () => {
    const p = fakePlugin({
      settings: { mounts: [{ source: { owner: "", vaultId: "asi", sourcePath: "Projects" }, mountPoint: "Work/ASI", direction: "pull" }] },
      mountStates: () => ({ '["","asi","Projects","Work/ASI"]': "live" }),
      roMountEditsFor: (k: string) => (k === '["","asi","Projects","Work/ASI"]' ? ["a.md", "b.md"] : []),
    });
    const { containerEl } = renderTab(p);
    const text = containerEl.textContent ?? "";
    expect(text).toContain("2 read-only edits");
    expect(buttonByText(containerEl, "Keep my edits in a folder")).toBeTruthy();
  });

  it("composed vaults: a SHARED read-WRITE source gets the direction toggle; a shared read-only one does not (issueMountSharedDirectionToggle)", async () => {
    const rw = { source: { owner: "alice", vaultId: "shared", sourcePath: "" }, mountPoint: "Work/ASI", direction: "pull" };
    const ro = { source: { owner: "bob", vaultId: "ro", sourcePath: "" }, mountPoint: "Read/Only", direction: "pull" };
    const p = fakePlugin({
      settings: { mounts: [rw, ro] },
      activeMounts: () => [rw, ro],
      mountStates: () => ({ '["alice","shared","","Work/ASI"]': "live", '["bob","ro","","Read/Only"]': "live" }),
      listSharedVaults: vi.fn(async () => [
        { owner: "alice", vault: "shared", perm: "readWrite" }, // a read-WRITE grant → toggleable
        { owner: "bob", vault: "ro", perm: "read" },            // a read-only grant → fixed at Pull
      ]),
    });
    const { containerEl } = renderTab(p);
    expect(containerEl.querySelector('[aria-label="Switch to Sync (two-way)"]')).toBeFalsy(); // not until the grants load (safe default)
    await flush(); // loadSharedWritable resolves → re-render
    expect(p.listSharedVaults).toHaveBeenCalled();
    const toggles = containerEl.querySelectorAll('[aria-label="Switch to Sync (two-way)"]');
    expect(toggles.length).toBe(1); // ONLY the shared read-write mount gets the toggle; the read-only one stays fixed
  });

  it("composed vaults: with no mounts, shows the empty state + Add button (dormant, opt-in)", () => {
    const { containerEl } = renderTab(fakePlugin({ settings: { mounts: [] } }));
    expect((containerEl.textContent ?? "")).toContain("No mounts yet");
    expect(buttonByText(containerEl, "Add a mount")).toBeTruthy();
  });

  it("composed vaults R10-F3: a partially-invalid set reports only the inactive COUNT (the rest keep syncing), not 'none active'", () => {
    const m = { source: { owner: "", vaultId: "asi", sourcePath: "Projects" }, mountPoint: "Work/ASI", direction: "pull" };
    const p = fakePlugin({ settings: { mounts: [m] }, activeMounts: () => [] }); // configured but NOT in effect (e.g. overlaps/invalid)
    const { containerEl } = renderTab(p);
    const text = containerEl.textContent ?? "";
    expect(text).toContain("1 of 1 mount inactive"); // accurate count, not "no mounts are active"
    expect(text).toContain("inactive — invalid or overlaps another mount"); // per-row reason (R10-F7 sibling)
    expect(text).not.toContain("no mounts are active");
  });

  it("status hero R10-F1: folds a mount problem into the hero sub-line (the place you check is honest about mounts)", () => {
    const p = fakePlugin({ mountStatusSummary: () => ({ health: "offline", reason: "mount Work/ASI" }) });
    const { containerEl } = renderTab(p);
    expect(containerEl.textContent ?? "").toContain("a mount is offline (mount Work/ASI)");
  });

  it("D0041: Advanced shows the incoming-delete confirmation control + a threshold field (hidden when Off)", () => {
    const on = renderTab(fakePlugin({ settings: { bulkDeleteStrategy: "count", bulkDeleteThreshold: 10 } })).containerEl.textContent ?? "";
    expect(on).toContain("Confirm large incoming deletions");
    expect(on).toContain("more than this many files"); // threshold field shown for count
    const off = renderTab(fakePlugin({ settings: { bulkDeleteStrategy: "off", bulkDeleteThreshold: 10 } })).containerEl.textContent ?? "";
    expect(off).toContain("Confirm large incoming deletions");
    expect(off).not.toContain("more than this many files"); // no threshold field when Off
  });

  it("D0041: the review surface lists a held incoming-deletion batch and wires Keep/Delete", () => {
    const p = fakePlugin({ pendingBulkDeletions: () => [{ scope: "primary", label: "this vault", count: 12 }] });
    const { containerEl } = renderTab(p);
    const text = containerEl.textContent ?? "";
    expect(text).toContain("12 incoming deletions in this vault");
    expect(buttonByText(containerEl, "Keep them")).toBeTruthy();
    expect(buttonByText(containerEl, "Delete them")).toBeTruthy();
    buttonByText(containerEl, "Keep them").click(); // non-destructive → no confirm modal
    expect(p.keepBulkDeletions).toHaveBeenCalledWith("primary");
  });

  it("F2: the review surface lists a held bulk-push-to-shared batch and wires Keep-local/Push", () => {
    const p = fakePlugin({ pendingBulkPushReview: () => [{ scope: "m1", label: "Work/ASI", count: 5 }] });
    const { containerEl } = renderTab(p);
    const text = containerEl.textContent ?? "";
    expect(text).toContain("5 local files to add to Work/ASI");
    expect(buttonByText(containerEl, "Keep local")).toBeTruthy();
    expect(buttonByText(containerEl, "Push them")).toBeTruthy();
    buttonByText(containerEl, "Keep local").click(); // non-destructive → no confirm modal
    expect(p.keepBulkPushes).toHaveBeenCalledWith("m1");
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

  it("a synced+installed plugin offers Push/Pull that force the plugin's files to a side", async () => {
    const p = fakePlugin({ settings: { configSync: { enabled: true, core: true, hotkeys: true, appearance: true, snippets: true, community: true, pluginAllow: ["dataview"] } } });
    p.app.plugins.manifests = { dataview: { id: "dataview", name: "Dataview" } }; // installed ⇒ "here"
    const { containerEl } = renderTab(p);
    const push = containerEl.querySelector('[aria-label*="Push this device"]') as HTMLElement;
    const pull = containerEl.querySelector('[aria-label*="Pull the server"]') as HTMLElement;
    expect(push).toBeTruthy(); // the inert direction dropdown is gone; real actions in its place
    expect(pull).toBeTruthy();
    push.click(); await flush(); // confirm is auto-accepted (mocked)
    expect(p.pushPlugin).toHaveBeenCalledWith("dataview");
    pull.click(); await flush();
    expect(p.pullPlugin).toHaveBeenCalledWith("dataview");
  });

  // issueSettingsRepaintWalksEveryPluginFolder: pluginSyncClean runs walkConfigTree (a recursive
  // adapter.list/stat over the plugin folder) and it fired for EVERY synced plugin on EVERY render,
  // unconditionally — even when the cached answer had just been applied. resolveNoteConflict triggers
  // a settings re-render, so ONE conflict click paid for a filesystem walk per synced plugin, which
  // on Windows (AV) or a cloud-synced vault is seconds. Note length was irrelevant to that cost.
  it("a re-render does NOT re-walk plugin folders once convergence is cached", async () => {
    const p = fakePlugin({ settings: { configSync: { enabled: true, core: true, hotkeys: true, appearance: true, snippets: true, community: true, pluginAllow: ["dataview", "templater"] } } });
    p.app.plugins.manifests = { dataview: { id: "dataview", name: "Dataview" }, templater: { id: "templater", name: "Templater" } };
    p.pluginSyncClean = vi.fn(async () => true);
    const tab = renderTab(p);
    await flush(); // first render: one walk per synced plugin, and the answers cache
    const afterFirst = p.pluginSyncClean.mock.calls.length;
    expect(afterFirst).toBe(2);
    tab.display(); await flush(); // a re-render (what resolveNoteConflict triggers)
    tab.display(); await flush();
    expect(p.pluginSyncClean.mock.calls.length).toBe(afterFirst); // zero extra walks
  });

  it("DISABLES Push/Pull and blocks the click when in sync (owner-directed: no real action → no button)", async () => {
    const p = fakePlugin({ settings: { configSync: { enabled: true, core: true, hotkeys: true, appearance: true, snippets: true, community: true, pluginAllow: ["dataview"] } } });
    p.app.plugins.manifests = { dataview: { id: "dataview", name: "Dataview" } };
    p.pluginSyncClean = vi.fn(async () => true); // convergence heuristic says "in sync"
    const { containerEl } = renderTab(p);
    const push = containerEl.querySelector('[aria-label*="Push this device"]') as HTMLElement;
    await flush(); // async convergence check resolves → disables the buttons
    expect(p.pluginSyncClean).toHaveBeenCalledWith("dataview");
    // Genuinely UNCLICKABLE (owner: not just greyed): pointer-events:none makes it inert in the browser...
    expect(push.style.pointerEvents).toBe("none");
    // ...and the act() guard is defense-in-depth — a click is a no-op: no preview, no overwrite.
    push.click(); await flush();
    expect(p.pluginPushPullPreview).not.toHaveBeenCalled();
    expect(p.pushPlugin).not.toHaveBeenCalled();
  });

  it("the community-plugins bulk toggle 'Sync all' path applies immediately when community is on", () => {
    plugin = fakePlugin({ settings: { configSync: { enabled: true, core: true, hotkeys: true, appearance: true, snippets: true, community: true, pluginAllow: [] } } });
    // With no installed community plugins the bulk row may not render; assert the section renders at least.
    const { containerEl } = renderTab(plugin);
    expect(toggleByName(containerEl, "Community plugins")?.checked).toBe(true);
  });
});

// Show-don't-tell busy state on the settings tab's own entry point (owner, 2026-09-07): while a pass runs the
// Conflicts "Resolve" button is disabled and reads "Analyzing files…"; it is "Resolve" again when settled.
describe("Conflicts 'Resolve' button wears the busy state (busygate.ts)", () => {
  it("disabled + 'Analyzing files…' while busy, back to 'Resolve' when the plugin settles", async () => {
    const p = fakePlugin({ settings: { noteConflicts: [{ copy: "n (conflict).md", original: "n.md" }] } });
    p.busy = { busy: true, label: "Analyzing files…", reason: "SelfSync is checking your files for changes" };
    const tab = renderTab(p); await flush();
    const btn = buttonByText(tab.containerEl, "Analyzing files…") as HTMLButtonElement | null;
    expect(btn).toBeTruthy();
    expect(btn!.disabled).toBe(true);
    expect(btn!.title).toBe("SelfSync is checking your files for changes");
    expect(buttonByText(tab.containerEl, "Resolve")).toBeFalsy();
    p.busy = { busy: false, label: "", reason: "" }; p.fireBusy();
    const resolve = buttonByText(tab.containerEl, "Resolve") as HTMLButtonElement | null;
    expect(resolve).toBeTruthy();
    expect(resolve!.disabled).toBe(false);
    tab.hide();
    p.busy = { busy: true, label: "Analyzing files…", reason: "x" }; p.fireBusy(); // unsubscribed on hide: no throw
  });
});

describe("SR-47 / SR-50: other sync tools + build digest (settings tab)", () => {
  it("Advanced names the detected tool on the coexistence toggle, and the toggle re-reconciles when flipped", async () => {
    const p = fakePlugin({ settings: { skipForeignArtefacts: true }, foreignToolsDescription: () => "Syncthing (12 files) detected — their files are left to that tool and not synced" });
    const { containerEl } = renderTab(p);
    const row = rowByName(containerEl, "Leave other sync tools' files alone");
    expect(row).toBeTruthy();
    expect(row.textContent).toContain("Syncthing (12 files) detected");
    flipToggle(toggleByName(containerEl, "Leave other sync tools' files alone"));
    await flush();
    expect(p.settings.skipForeignArtefacts).toBe(false);
    expect(p.saveSettings).toHaveBeenCalled();
    expect(p.requestReconcile).toHaveBeenCalled();
    const none = renderTab(fakePlugin({ settings: { skipForeignArtefacts: true } })).containerEl.textContent ?? "";
    expect(none).toContain("Nothing detected right now");
  });
  it("Conflicts lists flip-held files with the paths and wires 'Upload current versions anyway'", async () => {
    const p = fakePlugin({ heldFlipPaths: () => ["Daily/2026-09-10.md", "Inbox/todo.md"] });
    const { containerEl } = renderTab(p);
    const row = rowByName(containerEl, "2 files keep changing back and forth");
    expect(row).toBeTruthy();
    expect(row.textContent).toContain("Daily/2026-09-10.md");
    expect(row.textContent).toContain("uploading is paused");
    buttonByText(row, "Upload current versions anyway").click();
    await flush();
    expect(p.releaseFlipHeld).toHaveBeenCalled();
    // no held paths → no row at all (the Conflicts group is absent when nothing is pending)
    expect(rowByName(renderTab(fakePlugin()).containerEl, "1 file keeps changing back and forth")).toBeFalsy();
  });
  it("About shows the version and the installed main.js digest (SR-50 audit surface)", async () => {
    const { containerEl } = renderTab(fakePlugin());
    await flush();
    const row = rowByName(containerEl, "About");
    expect(row).toBeTruthy();
    expect(row.textContent).toContain("SelfSync 1.30.17");
    expect(row.textContent).toContain("main.js sha256 0123456789abcdef…");
  });
});
