import { App, PluginSettingTab, SettingGroup, Notice } from "obsidian";
import type NewLiveSyncPlugin from "./main";
import { ConfigSyncSelection, DEFAULT_CONFIG_SYNC, groupConfigConflicts } from "./configsync";
import { statusTitle } from "./wizardsteps";
import { light } from "./syncstate";
import { DeviceLinkModal } from "./devicelink";
import { SwitchVaultModal } from "./vaultswitch";

export interface NewLiveSyncSettings {
  serverUrl: string;
  username: string;
  password: string;
  conflictStrategy: "auto-merge" | "conflict-file";
  deviceName: string; // shown in conflict-copy filenames; blank = auto
  vaultId: string;    // which server-side vault this Obsidian vault syncs to
  configSync: ConfigSyncSelection; // which .obsidian/ config surfaces to sync (see configsync.ts)
  authToken?: string;    // cached bearer token to skip re-login (B7 makes server tokens durable/revocable)
  lastSyncedAt?: number; // epoch ms of the last successful reconcile; shown in the status card
  editorStatus: boolean; // opt-in: also show a sync-status indicator in the editor view
  vaultOwner?: string;   // set when the current vault is shared BY someone else (their username); empty/undefined = own vault
  vaultReadOnly?: boolean; // the current (shared) vault is read-only for us — pull only, never push
  storePassword: boolean; // keep the password on this device for silent re-login; off = token-only (re-enter when the session expires)
  configConflicts: string[]; // `.obsidian/` paths whose sync diverged (removal or both-edited) and await user adjudication (see reconcile + ConfigConflictModal)
  // D0019: the deletion-history floor this device last synced at, per vault (key = `owner/vaultId`).
  // When the server's floor advances past the stored one (a rebuild-from-disk reindex reset the
  // deletion history), the client stays conservative (keep + push) and shows ONE batched notice
  // instead of silently resurrecting. Persisted (state.version is ephemeral) so it works across
  // sessions — the common case is the server being reindexed while this device was offline.
  historyFloors?: Record<string, number>;
  // D0019 / critique-R8: the last server version this device synced at, per vault (key = `owner/vaultId`).
  // Persisted (state.version is ephemeral, reset each session) so a version REWIND that happened while
  // this device was offline (a restore to an older snapshot) is still detected as a history reset —
  // the in-memory rewind check alone is dead across a restart. Same fresh-per-instance handling as
  // historyFloors (omitted from DEFAULT_SETTINGS, lazily `??= {}`).
  lastVersions?: Record<string, number>;
}
export const DEFAULT_SETTINGS: NewLiveSyncSettings = {
  // First-run defaults are BLANK — a fresh install is "not configured" (see the `configured`
  // check below), which routes to the setup wizard where the user enters their own server URL
  // and account. Never ship a baked-in server address or (worse) a guessable credential.
  serverUrl: "",
  username: "",
  password: "",
  conflictStrategy: "auto-merge",
  deviceName: "",
  vaultId: "default",
  configSync: { ...DEFAULT_CONFIG_SYNC },
  authToken: undefined,
  lastSyncedAt: undefined,
  editorStatus: false,
  vaultOwner: undefined,
  vaultReadOnly: false,
  storePassword: true,
  configConflicts: [],
  // historyFloors intentionally omitted here: a module-level object literal in DEFAULT_SETTINGS
  // would be ALIASED across instances by Object.assign (a shared-mutable-default bug). It's created
  // fresh per instance by `this.settings.historyFloors ??= {}` on first use in doReconcileAll (D0019).
};

export class NewLiveSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: NewLiveSyncPlugin) { super(app, plugin); }
  private statusEl?: HTMLElement;

  display(): void {
    const { containerEl } = this; containerEl.empty();
    const s = this.plugin.settings;
    const configured = Boolean(s.vaultId && s.serverUrl && s.username);

    // Each section is a native SettingGroup — the heading renders OUTSIDE a single card that holds
    // its rows as flush, divider-separated entries (this is how BRAT/Obsidian group settings, and
    // how card-styling themes render one cohesive card per section instead of a card per row). The
    // status + connection facts live in a stable sub-container so they can live-refresh in place.
    this.statusEl = containerEl.createEl("div");
    this.refreshStatus();
    this.plugin.statusListener = () => this.refreshStatus();
    this.plugin.settingsRefresh = () => this.display(); // re-render when the conflict count changes
    if (!configured) return; // unconfigured: only the status group + Set up button

    this.renderObsidianConfig(containerEl, s); // what config syncs (scope)
    this.renderConflicts(containerEl, s);       // how divergence is handled (sibling to config)
    this.renderManage(containerEl);             // transitions: reconfigure / switch / device / disconnect / sign out
    this.renderAdvanced(containerEl, s);
  }

  hide(): void { this.plugin.statusListener = undefined; this.plugin.settingsRefresh = undefined; } // stop live-refreshing once closed

  // Just the relative time ("2m ago" / "just now" / a clock time), or "—".
  private lastSyncedAgo(s: NewLiveSyncSettings): string {
    if (!s.lastSyncedAt) return "—";
    const mins = Math.round((Date.now() - s.lastSyncedAt) / 60000);
    if (mins <= 0) return "just now";
    if (mins < 60) return `${mins}m ago`;
    return new Date(s.lastSyncedAt).toLocaleTimeString();
  }

  // The "Connection" card: the live status row + the standing connection facts. Live-refreshed by
  // the plugin's statusListener as the sync state changes. The only non-native touch is the status
  // dot's colour, which mirrors the ribbon/status-bar indicator so the state colour is consistent.
  private refreshStatus(): void {
    const el = this.statusEl;
    if (!el) return;
    el.empty();
    const s = this.plugin.settings;
    const configured = Boolean(s.vaultId && s.serverUrl && s.username);
    const phase = this.plugin.statusText(); // FSM Phase

    if (!configured) {
      new SettingGroup(el).addSetting((st) => st.setName("Not set up").setDesc("Sync your notes to your own server.")
        .addButton((b) => b.setButtonText("Set up SelfSync").setCta().onClick(() => this.plugin.openSetup())));
      return;
    }

    const g = new SettingGroup(el).setHeading("Connection");
    // Status row: a coloured dot + the phase title as the row name; the current issue as its
    // description; recovery actions (offline only) in the control area.
    g.addSetting((st) => {
      st.nameEl.createSpan({ cls: "selfsync-dot", text: "●" }).setAttribute("style", `color:${light(phase).color}`);
      st.nameEl.createSpan({ text: statusTitle(phase) });
      const issue = this.plugin.getLastIssue();
      if (phase !== "idle" && issue) st.setDesc(issue);
      if (phase === "offline") {
        st.addButton((b) => b.setButtonText("Reconnect").onClick(() => this.plugin.reconnect()));
        // D0021: the vault was deleted server-side — offer a deliberate re-create-from-this-device.
        if (this.plugin.isVaultGone()) {
          st.addButton((b) => b.setButtonText("Re-create vault from this device").setCta().onClick(() => void this.plugin.recreateVault()));
        }
      }
    });
    // Standing connection facts as plain rows (label + value).
    g.addSetting((st) => st.setName("Server").setDesc(s.serverUrl));
    g.addSetting((st) => st.setName("Account").setDesc(s.username));
    g.addSetting((st) => st.setName("Vault").setDesc(s.vaultOwner ? `${s.vaultOwner}/${s.vaultId}${s.vaultReadOnly ? " · read-only" : ""}` : s.vaultId));
    g.addSetting((st) => st.setName("Last synced").setDesc(this.lastSyncedAgo(s)));
  }

  private showDeviceLink(): void {
    new DeviceLinkModal(this.app, this.plugin.addDeviceLink()).open();
  }

  // Obsidian configuration — the opt-in .obsidian surface (notes/attachments always sync, so no
  // no-op "always synced" row). Community-plugin code is a further opt-in, its own card below.
  private renderObsidianConfig(c: HTMLElement, s: NewLiveSyncSettings): void {
    const cs = s.configSync;
    const g = new SettingGroup(c).setHeading("Obsidian configuration");
    g.addSetting((st) => st.setName("Sync settings, themes & plugins")
      .setDesc("Notes & attachments always sync. This adds your .obsidian config (settings, themes, plugins) across devices. Community-plugin code is a separate opt-in below (off by default). SelfSync's own login is never synced.")
      .addToggle((tg) => tg.setValue(cs.enabled).onChange(async (v) => {
        cs.enabled = v; await this.plugin.saveSettings(); this.display();
      })));
    if (!cs.enabled) return;

    // The key trust signal — shown whenever config sync is on. A description-only row.
    g.addSetting((st) => st.setDesc("🔒 SelfSync's own settings (server, login, vault) are never synced — they stay on this device."));

    const cat = (name: string, desc: string, key: "core" | "hotkeys" | "appearance" | "snippets" | "community") =>
      g.addSetting((st) => st.setName(name).setDesc(desc).addToggle((tg) => tg.setValue(cs[key]).onChange(async (v) => {
        cs[key] = v; await this.plugin.saveSettings(); if (key === "community") this.display();
      })));
    cat("Core settings", "app.json, core-plugins.json", "core");
    cat("Hotkeys", "hotkeys.json", "hotkeys");
    cat("Appearance & themes", "appearance.json, themes/", "appearance");
    cat("CSS snippets", "snippets/", "snippets");
    cat("Community plugins", "Each plugin's code + settings across devices. Off by default — pushing plugin code (incl. desktop-only plugins to mobile) is riskier.", "community");

    if (cs.community) {
      this.renderPluginChecklist(c, cs);
    } else {
      g.addSetting((st) => st.setDesc("Community plugins are NOT syncing — turn on “Community plugins” above to include their code + settings."));
    }
  }

  // Conflicts — how divergence between devices is handled. A sibling section to the config scope:
  // "Concurrent edits" applies to notes too, so it doesn't belong nested under configuration.
  private renderConflicts(c: HTMLElement, s: NewLiveSyncSettings): void {
    const g = new SettingGroup(c).setHeading("Conflicts");
    // Adjudication queue: config that diverged/was-removed across devices, awaiting a choice.
    // Surfaced prominently (not auto-resolved) so plugins are never silently deleted or resurrected.
    const conflictGroups = groupConfigConflicts(this.plugin.getConfigConflicts());
    if (conflictGroups.length) {
      g.addSetting((st) => st.setName(`Config differences (${conflictGroups.length})`).setClass("mod-warning")
        .setDesc("Settings or plugins differ across your devices. Nothing was deleted or overwritten — choose which version to keep.")
        .addButton((b) => b.setButtonText("Resolve").setCta().onClick(() => this.plugin.openConfigConflicts())));
    }
    g.addSetting((st) => st.setName("Concurrent edits to the same file")
      .setDesc("When a file changed on two devices: merge the changes automatically, or keep both as a conflict file.")
      .addDropdown((dd) => dd
        .addOption("auto-merge", "Automatically merge")
        .addOption("conflict-file", "Create conflict file")
        .setValue(s.conflictStrategy)
        .onChange(async (v) => { s.conflictStrategy = v as NewLiveSyncSettings["conflictStrategy"]; await this.plugin.saveSettings(); })));
  }

  // Manage — the transitions you perform (change wiring, switch vault, link a device, stop syncing).
  private renderManage(c: HTMLElement): void {
    const g = new SettingGroup(c).setHeading("Manage");
    g.addSetting((st) => st.setName("Server & account").setDesc("Change the server URL or the account you sign in with.")
      .addButton((b) => b.setButtonText("Reconfigure").onClick(() => this.plugin.openSetup())));
    g.addSetting((st) => st.setName("Switch vault").setDesc("Point this Obsidian vault at a different remote vault (you choose how to combine the data at switch time).")
      .addButton((b) => b.setButtonText("Switch vault").onClick(() => new SwitchVaultModal(this.app, this.plugin).open())));
    g.addSetting((st) => st.setName("Add a device").setDesc("Show a link/QR to set SelfSync up on another device.")
      .addButton((b) => b.setButtonText("Add a device").onClick(() => this.showDeviceLink())));
    g.addSetting((st) => st.setName("Disconnect").setDesc("Stop syncing this vault (you stay signed in; local files are kept).")
      .addButton((b) => b.setButtonText("Disconnect").setWarning().onClick(async () => { await this.plugin.disconnect(); this.display(); })));
    g.addSetting((st) => st.setName("Sign out").setDesc("Stop syncing and forget this device's password (you'll re-enter it next time).")
      .addButton((b) => b.setButtonText("Sign out").setWarning().onClick(async () => { await this.plugin.signOut(); this.display(); })));
  }

  private renderAdvanced(c: HTMLElement, s: NewLiveSyncSettings): void {
    const g = new SettingGroup(c).setHeading("Advanced");
    g.addSetting((st) => st.setName("Show sync status in the editor")
      .setDesc("Show a sync-status icon in the open note's header. Off by default. Handy on mobile — there's no status bar and the ribbon icon sits in the sidebar drawer, so this is the way to get a visible indicator there.")
      .addToggle((tg) => tg.setValue(s.editorStatus).onChange((v) => this.plugin.setEditorStatus(v))));
    g.addSetting((st) => st.setName("Store password on this device")
      .setDesc("Keep your password for silent reconnect. Turn off for token-only: the password is removed now and you re-enter it when the session expires (~30 days) or is revoked.")
      .addToggle((tg) => tg.setValue(s.storePassword).onChange(async (v) => {
        s.storePassword = v;
        if (!v) s.password = ""; // token-only: forget the password immediately (the token stays)
        await this.plugin.saveSettings();
      })));
    g.addSetting((st) => st.setName("Device name").setDesc("Shown in conflict-copy filenames. Blank = auto (the greyed name is what's used).")
      .addText((t) => t.setPlaceholder(this.plugin.autoDeviceName()).setValue(s.deviceName).onChange(async (v) => { s.deviceName = v.trim(); await this.plugin.saveSettings(); })));
    g.addSetting((st) => st.setName("Diagnostics")
      .addButton((b) => b.setButtonText("Show sync log").onClick(() => this.plugin.showLog()))
      .addButton((b) => b.setButtonText("Copy debug info").onClick(() => this.copyDebugInfo(s))));
  }

  private copyDebugInfo(s: NewLiveSyncSettings): void {
    let host = s.serverUrl;
    try { host = new URL(s.serverUrl).host; } catch { /* keep raw */ }
    const info = [
      `phase: ${this.plugin.statusText()}`,
      `server: ${host}`,
      `vault: ${s.vaultId}`,
      `configSync: ${s.configSync.enabled ? "on" : "off"}`,
      "--- recent log ---",
      this.plugin.getLogText(),
    ].join("\n");
    navigator.clipboard?.writeText(info).then(
      () => new Notice("SelfSync: debug info copied"),
      () => new Notice("SelfSync: copy failed — open the sync log instead"),
    );
  }

  // Per-plugin ALLOWLIST (opt-in): check a plugin to share its code + settings across devices.
  // A newly-installed plugin is NOT shared until you add it here — so installing something on one
  // device never auto-pushes it (overwriting the others) before you decide to. The SelfSync-never-
  // syncs reassurance is shown once, above.
  private renderPluginChecklist(c: HTMLElement, cs: NewLiveSyncSettings["configSync"]): void {
    const selfId = this.plugin.selfFolderId();
    const manifests = ((this.app as any).plugins?.manifests ?? {}) as Record<string, { id: string; name: string }>;
    const ids = Object.keys(manifests)
      .filter((id) => id !== selfId)
      .sort((a, b) => (manifests[a].name || a).localeCompare(manifests[b].name || b));
    if (ids.length === 0) return;
    const shared = ids.filter((id) => cs.pluginAllow.includes(id)).length;
    const g = new SettingGroup(c).setHeading("Shared community plugins");

    // Bulk actions: opt in everything at once (for a full mirror), or clear the set. The count
    // lives in this row's description (no separate intro line). New plugins stay unshared until added.
    g.addSetting((st) => st.setName("Share all installed plugins")
      .setDesc(`Add every currently-installed plugin to the shared set at once (${shared}/${ids.length} shared). Plugins you install LATER still won't share until you add them.`)
      .addButton((b) => b.setButtonText("Share all").onClick(async () => {
        cs.pluginAllow = ids.slice(); await this.plugin.saveSettings(); this.display();
      }))
      .addButton((b) => b.setButtonText("Share none").setWarning().onClick(async () => {
        cs.pluginAllow = []; await this.plugin.saveSettings(); this.display();
      })));

    for (const id of ids) {
      g.addSetting((st) => st.setName(manifests[id].name || id)
        .addToggle((tg) => tg.setValue(cs.pluginAllow.includes(id)).onChange(async (v) => {
          const set = new Set(cs.pluginAllow);
          if (v) set.add(id); else set.delete(id);
          cs.pluginAllow = [...set];
          await this.plugin.saveSettings();
        })));
    }
  }
}
