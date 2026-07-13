import { App, PluginSettingTab, Setting, SettingGroup, Notice, Platform } from "obsidian";
import type NewLiveSyncPlugin from "./main";
import { ConfigSyncSelection, DEFAULT_CONFIG_SYNC, groupConfigConflicts, ConfigSurface, ConfigDirection } from "./configsync";
import { ConfigDirectionModal } from "./configdir";
import { light } from "./syncstate";
import { DeviceLinkModal } from "./devicelink";
import { SwitchVaultModal } from "./vaultswitch";
import { ChangePasswordModal, ShareManageModal } from "./accountui";

export interface NewLiveSyncSettings {
  serverUrl: string;
  username: string;
  password: string;
  deviceName: string; // shown in conflict-copy filenames; blank = auto
  vaultId: string;    // which server-side vault this Obsidian vault syncs to
  configSync: ConfigSyncSelection; // which .obsidian/ config surfaces to sync (see configsync.ts)
  authToken?: string;    // cached bearer token to skip re-login (B7 makes server tokens durable/revocable)
  lastSyncedAt?: number; // epoch ms of the last successful reconcile; shown in the status card
  editorStatus: boolean; // opt-in: also show a sync-status indicator in the editor view
  vaultOwner?: string;   // set when the current vault is shared BY someone else (their username); empty/undefined = own vault
  vaultReadOnly?: boolean; // the current (shared) vault is read-only for us — pull only, never push
  storePassword: boolean; // keep the password on this device for silent re-login; off = token-only (re-enter when the session expires)
  maxSyncMB: number; // per-file size cap for THIS device (MB). Files larger than this are skipped here; raise with care on mobile (files buffer in RAM). The server enforces its own ceiling (MAX_FILE_MB).
  configConflicts: string[]; // `.obsidian/` paths whose sync diverged (removal or both-edited) and await user adjudication (see reconcile + ConfigConflictModal)
  // NOTE conflicts are NOT stored here — they are DERIVED from the vault's conflict-copy files
  // (deriveNoteConflicts, D-conflict-model), so the list/count/modal can never drift from reality.
  // A vault-switch resolution awaiting the next reconnect. PERSISTED (R12-CA1) so a restart between
  // writing the new vaultId and applying the switch replays the chosen mode (download/upload/merge)
  // — otherwise the reconnect would do a plain MERGE against the OLD vault's stale base, silently
  // downgrading an authoritative overwrite and mis-merging same-named files.
  pendingSwitch?: "download" | "upload" | "merge";
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
  deviceName: "",
  vaultId: "default",
  configSync: { ...DEFAULT_CONFIG_SYNC },
  authToken: undefined,
  lastSyncedAt: undefined,
  editorStatus: false,
  vaultOwner: undefined,
  vaultReadOnly: false,
  // SEC-CMMC (IA.3.5.10): default to TOKEN-ONLY — do NOT persist the plaintext password on the device.
  // The revocable bearer token is stored instead; the user re-enters the password only when the session
  // expires. A user can opt back into stored-password for silent re-login, accepting the at-rest exposure.
  storePassword: false,
  maxSyncMB: 200, // default per-file sync cap (MB); was hard-coded 50 (mobile) / 200 (desktop)
  configConflicts: [],
  // historyFloors intentionally omitted here: a module-level object literal in DEFAULT_SETTINGS
  // would be ALIASED across instances by Object.assign (a shared-mutable-default bug). It's created
  // fresh per instance by `this.settings.historyFloors ??= {}` on first use in doReconcileAll (D0019).
};

export class NewLiveSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: NewLiveSyncPlugin) { super(app, plugin); }
  private statusGroup?: SettingGroup;
  private pluginsExpanded?: boolean; // persists the synced-plugins list expand state across re-renders

  display(): void {
    const { containerEl } = this; containerEl.empty();
    const s = this.plugin.settings;
    const configured = Boolean(s.vaultId && s.serverUrl && s.username);

    // Each section is a native SettingGroup — the heading renders OUTSIDE a single card that holds
    // its rows as flush, divider-separated entries (how BRAT/Obsidian group settings, and how
    // card-styling themes render one cohesive card per section). The Connection group is built
    // directly in containerEl (so it gets the same inter-group spacing as the others) and kept as a
    // member so status ticks refresh just its rows in place — no whole-tab rebuild that would drop
    // focus/scroll in the config groups below.
    this.statusGroup = new SettingGroup(containerEl).setHeading("Connection");
    this.fillStatus();
    this.plugin.statusListener = () => this.fillStatus();
    this.plugin.settingsRefresh = () => this.display(); // re-render when the conflict count changes
    if (!configured) return; // unconfigured: only the Connection group + Set up button

    this.renderObsidianConfig(containerEl, s); // what config syncs (scope)
    this.renderConflicts(containerEl);          // only surfaces pending conflicts needing a manual choice
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

  // One connection fact: label on the LEFT (row name), value on the RIGHT (control area), with an
  // optional management action button after the value — the old "Manage" section folded in here.
  private factRow(g: SettingGroup, label: string, value: string, extra?: (st: Setting) => void): void {
    g.addSetting((st) => {
      st.setName(label);
      st.controlEl.createSpan({ cls: "selfsync-value", text: value });
      extra?.(st);
    });
  }

  // Fill the Connection card's rows (into the group's listEl, so refresh replaces only these rows).
  // Facts first; the live status light + connection actions sit at the BOTTOM. The only non-native
  // touch is the status dot's colour, which mirrors the ribbon/status-bar indicator.
  private fillStatus(): void {
    const g = this.statusGroup;
    if (!g) return;
    g.listEl.empty();
    const s = this.plugin.settings;
    const configured = Boolean(s.vaultId && s.serverUrl && s.username);
    const phase = this.plugin.statusText(); // FSM Phase

    if (!configured) {
      g.addSetting((st) => st.setName("Not set up").setDesc("Sync your notes to your own server.")
        .addButton((b) => b.setButtonText("Set up SelfSync").setCta().onClick(() => this.plugin.openSetup())));
      return;
    }

    // Facts (label left, value right) with their management action integrated as a button.
    this.factRow(g, "Server", s.serverUrl); // Reconfigure lives under Advanced (rarely needed)
    this.factRow(g, "Account", s.username, (st) => st
      .addButton((b) => b.setButtonText("Change password").onClick(() => new ChangePasswordModal(this.app, this.plugin).open()))
      // Confirm: sign-out clears the token (and, in token-only mode, there's no saved password), so
      // getting back in needs the password re-entered — and the button sits right next to "Change
      // password", easy to fat-finger on mobile.
      .addButton((b) => b.setButtonText("Sign out").onClick(async () => {
        if (!confirm(`Sign out of ${s.serverUrl}? You'll need your password to sign back in. Your local files are kept.`)) return;
        await this.plugin.signOut(); this.display();
      })));
    this.factRow(g, "Vault", s.vaultOwner ? `${s.vaultOwner}/${s.vaultId}${s.vaultReadOnly ? " · read-only" : ""}` : s.vaultId,
      (st) => {
        // Sharing only applies to a vault you OWN (not one shared TO you).
        if (!s.vaultOwner) st.addButton((b) => b.setButtonText("Share").onClick(() => new ShareManageModal(this.app, this.plugin).open()));
        // "Switch" both changes vaults AND is where you redeem a share link to gain access to another
        // vault (redeeming isn't an action ON the current vault, so it doesn't belong beside it here).
        st.addButton((b) => b.setButtonText("Switch").onClick(() => new SwitchVaultModal(this.app, this.plugin).open()));
      });
    this.factRow(g, "Last synced", this.lastSyncedAgo(s));

    // Live status light at the BOTTOM: coloured dot + phase; issue as desc; connection actions right.
    g.addSetting((st) => {
      st.nameEl.createSpan({ cls: "selfsync-dot", text: "●" }).setAttribute("style", `color:${light(phase).color}`);
      const disp = this.plugin.statusDisplay(phase); // label + detail (Resuming… / Syncing… N pending / checking for changes)
      st.nameEl.createSpan({ text: disp.label + (disp.detail ? ` ${disp.detail}` : "") });
      const issue = this.plugin.getLastIssue();
      if (phase !== "idle" && issue) st.setDesc(issue);
      // Diagnose is always available: it names the first broken link so a silent offline — or a
      // "looks fine but isn't syncing" — gets an actionable reason instead of a shrug.
      st.addButton((b) => b.setButtonText("Diagnose").onClick(() => void this.runDiagnosis()));
      if (phase === "offline") {
        st.addButton((b) => b.setButtonText("Reconnect").onClick(() => this.plugin.reconnect()));
        // D0021: the vault was deleted server-side — offer a deliberate re-create-from-this-device.
        if (this.plugin.isVaultGone()) {
          st.addButton((b) => b.setButtonText("Re-create vault from this device").setCta().onClick(() => void this.plugin.recreateVault()));
        }
      } else {
        st.addButton((b) => b.setButtonText("Add a device").onClick(() => this.showDeviceLink()));
        // "Disconnect" (stop syncing, keep the login) moved to Advanced — "Sign out" is the primary
        // stop action; a bare disconnect is the rarer case.
      }
    });
  }

  private showDeviceLink(): void {
    new DeviceLinkModal(this.app, this.plugin.addDeviceLink()).open();
  }

  // Run the layered connection diagnosis and show the first broken link with an actionable message.
  private async runDiagnosis(): Promise<void> {
    new Notice("SelfSync: checking the connection…");
    try {
      const d = await this.plugin.diagnoseConnection();
      new Notice(`SelfSync — ${d.ok ? "OK" : d.layer}: ${d.detail}`, d.ok ? 6000 : 12000);
    } catch (e: any) {
      new Notice(`SelfSync: diagnosis failed — ${e?.message ?? e}`);
    }
  }

  // Obsidian configuration — the opt-in .obsidian surface (notes/attachments always sync, so no
  // no-op "always synced" row). Community-plugin code is a further opt-in, its own card below.
  private renderObsidianConfig(c: HTMLElement, s: NewLiveSyncSettings): void {
    const cs = s.configSync;
    const ro = !!s.vaultReadOnly;
    const g = new SettingGroup(c).setHeading("Obsidian configuration");
    g.addSetting((st) => st.setName("Sync settings, themes, or plugins")
      .setDesc("Sync your Obsidian configuration across devices.")
      .addToggle((tg) => tg.setValue(cs.enabled).onChange((v) => {
        if (!v) { cs.enabled = false; void this.plugin.applyConfigSyncChange().then(() => this.display()); return; }
        cs.enabled = true;
        if (ro) {
          // Read-only shared vault: settings sync is opt-in PER SURFACE (download-only) — start every
          // surface OFF so adopting the owner's config is a deliberate choice, never automatic.
          cs.core = cs.hotkeys = cs.appearance = cs.snippets = cs.community = false;
          void this.plugin.applyConfigSyncChange().then(() => this.display());
          return;
        }
        // Read-write: ask ONE first-contact direction for the surfaces that are on by default, then
        // reveal the per-surface toggles (each asks its own direction when toggled later).
        const active = (["core", "hotkeys", "appearance", "snippets", "community"] as ConfigSurface[]).filter((k) => cs[k]);
        if (!active.length) { void this.plugin.applyConfigSyncChange().then(() => this.display()); return; }
        new ConfigDirectionModal(this.app, "your settings", false,
          (dir) => { for (const k of active) this.plugin.markPendingConfigDir(k, dir); void this.plugin.applyConfigSyncChange().then(() => this.display()); },
          () => { cs.enabled = false; this.display(); }, // cancelled → don't enable; revert the toggle
        ).open();
      })));
    if (!cs.enabled) return;

    // A short trust signal — SelfSync never syncs its own credentials.
    g.addSetting((st) => st.setDesc(ro
      ? "🔒 Read-only vault: settings are adopted from the owner (download only) — SelfSync's own login is never synced."
      : "🔒 SelfSync's own login is never synced."));

    const cat = (name: string, desc: string, key: ConfigSurface) =>
      g.addSetting((st) => st.setName(name).setDesc(desc).addToggle((tg) => tg.setValue(cs[key]).onChange((v) => {
        if (!v) { void this.plugin.setConfigSurface(key, false).then(() => this.display()); return; }
        // Turning a surface ON asks its first-contact direction (download/upload; download-only on a
        // read-only vault). Cancel leaves it off — display() reverts the visual toggle.
        new ConfigDirectionModal(this.app, name, ro,
          (dir) => { void this.plugin.setConfigSurface(key, true, dir).then(() => this.display()); },
          () => this.display(),
        ).open();
      })));
    cat("Core settings", "app.json, core-plugins.json", "core");
    cat("Hotkeys", "hotkeys.json", "hotkeys");
    cat("Appearance & themes", "appearance.json, themes/", "appearance");
    cat("CSS snippets", "snippets/", "snippets");
    cat("Community plugins", "Each community plugin's code and settings.", "community");

    if (cs.community) this.renderPluginChecklist(c, cs);
  }

  // Conflicts — NOT a setting. Concurrent edits are handled automatically (clean three-way merge
  // where possible, else a conflict copy), so nothing to configure. This section appears ONLY when
  // there's a pending config divergence that needs a manual choice; otherwise it's absent entirely.
  private renderConflicts(c: HTMLElement): void {
    const configGroups = groupConfigConflicts(this.plugin.getConfigConflicts());
    const noteConflicts = this.plugin.listNoteConflicts();
    if (!configGroups.length && !noteConflicts.length) return;
    const g = new SettingGroup(c).setHeading("Conflicts");
    if (noteConflicts.length) {
      g.addSetting((st) => st.setName(`${noteConflicts.length} file${noteConflicts.length > 1 ? "s" : ""} need review`).setClass("mod-warning")
        .setDesc("Concurrent edits that couldn't merge automatically.")
        .addButton((b) => b.setButtonText("Resolve").setCta().onClick(() => this.plugin.openNoteConflicts())));
    }
    if (configGroups.length) {
      g.addSetting((st) => st.setName(`${configGroups.length} config differences`).setClass("mod-warning")
        .setDesc("Choose which version to keep.")
        .addButton((b) => b.setButtonText("Resolve").setCta().onClick(() => this.plugin.openConfigConflicts())));
    }
  }

  private renderAdvanced(c: HTMLElement, s: NewLiveSyncSettings): void {
    const g = new SettingGroup(c).setHeading("Advanced");
    g.addSetting((st) => st.setName("Show sync status in the editor")
      .setDesc("Show a sync-status icon in the open note's header.")
      .addToggle((tg) => tg.setValue(s.editorStatus).onChange((v) => this.plugin.setEditorStatus(v))));
    g.addSetting((st) => st.setName("Store password on this device")
      .setDesc("Keep your password on this device for silent reconnect.")
      .addToggle((tg) => tg.setValue(s.storePassword).onChange(async (v) => {
        s.storePassword = v;
        if (!v) s.password = ""; // token-only: forget the password immediately (the token stays)
        await this.plugin.saveSettings();
      })));
    g.addSetting((st) => st.setName("Max file size to sync (MB)")
      .setDesc(Platform.isMobile
        ? "Files larger than this are skipped ON THIS DEVICE. Mobile buffers files in memory — very large values can crash the app. Larger files still sync on desktop."
        : "Files larger than this are skipped on this device. The server enforces its own ceiling.")
      .addText((t) => {
        t.setPlaceholder("200").setValue(String(s.maxSyncMB)).onChange(async (v) => {
          const n = Math.floor(Number(v));
          if (Number.isFinite(n) && n > 0) { s.maxSyncMB = n; await this.plugin.saveSettings(); }
        });
        // Validate on blur so an invalid/empty entry gives feedback + reverts, instead of silently
        // keeping the old value (the "I changed it and don't know what happened" trap).
        t.inputEl.addEventListener("blur", () => {
          const n = Math.floor(Number(t.inputEl.value));
          if (!Number.isFinite(n) || n <= 0) { new Notice("SelfSync: enter a whole number of MB greater than 0"); t.setValue(String(s.maxSyncMB)); }
        });
      }));
    g.addSetting((st) => st.setName("Device name").setDesc("Shown in conflict-copy filenames.")
      .addText((t) => t.setPlaceholder(this.plugin.autoDeviceName()).setValue(s.deviceName).onChange(async (v) => { s.deviceName = v.trim(); await this.plugin.saveSettings(); })));
    g.addSetting((st) => st.setName("Diagnostics")
      .addButton((b) => b.setButtonText("Show sync log").onClick(() => this.plugin.showLog()))
      .addButton((b) => b.setButtonText("Copy debug info").onClick(() => this.copyDebugInfo(s))));
    g.addSetting((st) => st.setName("Connection").setDesc("Reconfigure re-opens setup (server/account/vault). Disconnect stops syncing on this device but keeps your login — 'Sign out' above does both.")
      .addButton((b) => b.setButtonText("Reconfigure").onClick(() => this.plugin.openSetup()))
      .addButton((b) => b.setButtonText("Disconnect").onClick(async () => { await this.plugin.disconnect(); this.display(); })));
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
    const installed = new Set(Object.keys(manifests).filter((id) => id !== selfId));
    const onServer = new Set(this.plugin.getServerPluginIds().filter((id) => id !== selfId));
    // UNION of installed + server-side plugins — so a fresh vault (nothing installed yet) can still SEE
    // and adopt the plugins an existing vault synced: ticking a not-installed one pulls its files, which
    // installs it. (Previously the list was installed-plugins-only, leaving a new vault with nothing to
    // pick.) Sorted by display name (manifest name if installed, else the id).
    const ids = [...new Set([...installed, ...onServer])]
      .sort((a, b) => (manifests[a]?.name || a).localeCompare(manifests[b]?.name || b));
    const ro = !!this.plugin.settings.vaultReadOnly;
    const shared = ids.filter((id) => cs.pluginAllow.includes(id)).length;
    const notInstalledOnServer = [...onServer].filter((id) => !installed.has(id) && !cs.pluginAllow.includes(id));
    const g = new SettingGroup(c).setHeading("Synced community plugins");

    // Standing RESTART reminder: a plugin adopted from the sync but not yet installed locally is on
    // disk (or downloading), but Obsidian only loads plugins at STARTUP — it stays dormant until a full
    // restart. The transient sync toast is easy to miss on mobile, so surface it as a persistent banner
    // here, where the user just tapped "Install." (Closes the "looks done but nothing happened" gap.)
    const needsRestart = ids.filter((id) => cs.pluginAllow.includes(id) && !installed.has(id));
    if (needsRestart.length) {
      g.addSetting((st) => st.setName(`${needsRestart.length} plugin${needsRestart.length > 1 ? "s" : ""} not active yet`).setClass("mod-warning")
        .setDesc("Downloaded from the sync — fully close and reopen Obsidian (on mobile, swipe the app away) to enable them."));
    }

    // Fresh vault, before the first full reconcile has reported the server's plugins: don't render an
    // empty group that reads as "nothing to sync" — say we're still looking.
    if (ids.length === 0) {
      g.addSetting((st) => st.setName("Checking the server for plugins…")
        .setDesc("Plugins synced from your other devices will appear here after the next sync — then tick them to install."));
      return;
    }

    // Bulk actions. "Install all from the sync" is the fresh-vault bootstrap — adopt every plugin the
    // server holds (download-only for the ones not installed here); shown only when there are such
    // plugins. setPluginSync records each added plugin's first-contact direction.
    g.addSetting((st) => {
      st.setName("All plugins").setDesc(`${shared} of ${ids.length} synced${notInstalledOnServer.length ? ` · ${notInstalledOnServer.length} available from the sync (not installed here)` : ""}.`);
      st.addButton((b) => b.setButtonText("Sync none").onClick(async () => { for (const id of ids) await this.plugin.setPluginSync(id, false); this.display(); }));
      if (notInstalledOnServer.length) st.addButton((b) => b.setButtonText("Install all from the sync").setCta().onClick(async () => { await this.plugin.installAllServerPlugins(); this.display(); }));
      else st.addButton((b) => b.setButtonText("Sync all").onClick(async () => { for (const id of ids) await this.plugin.setPluginSync(id, true); this.display(); }));
    });

    // Collapsible list — a big plugin roster shouldn't flood the pane. Collapses/expands independently
    // of each plugin's direction (a mix of download/upload is fine). Expand state persists across the
    // tab's re-renders (a membership toggle re-renders to show/hide that plugin's direction control).
    const expanded = this.pluginsExpanded ?? ids.length <= 8;
    const details = c.createEl("details"); (details as unknown as { open: boolean }).open = expanded;
    details.addEventListener("toggle", () => { this.pluginsExpanded = (details as unknown as { open: boolean }).open; });
    details.createEl("summary", { text: `${ids.length} plugins` }).setAttribute("style", "cursor:pointer;font-size:13px;opacity:.85;margin:4px 0;");
    const body = details.createDiv();

    for (const id of ids) {
      const on = cs.pluginAllow.includes(id);
      const here = installed.has(id);
      const st = new Setting(body).setName(manifests[id]?.name || id);
      // Say where each plugin lives so the choice is legible on a fresh vault.
      if (!here && onServer.has(id)) st.setDesc("from the sync — will be installed here");
      else if (here && !onServer.has(id)) st.setDesc("on this device only — will be uploaded");
      st.addToggle((tg) => tg.setValue(on).onChange(async (v) => { await this.plugin.setPluginSync(id, v); this.display(); }));
      // First-contact direction appears only when synced AND a divergence is possible — i.e. the plugin
      // is installed here on a read-write vault. A not-installed plugin can only download (it pulls +
      // installs); a read-only vault can only download. Both show as text, no choice.
      if (on && !here) st.setDesc("downloads from the sync (not installed here yet)");
      else if (on && ro) st.setDesc("download only (read-only vault)");
      else if (on) {
        st.addDropdown((dd) => dd
          .addOption("download", "Use synced")
          .addOption("upload", "Use this device's")
          .setValue(cs.pluginDir?.[id] ?? this.plugin.communityConfigDir() ?? "download")
          .onChange((v) => void this.plugin.setPluginDir(id, v as ConfigDirection)));
      }
    }
  }
}
