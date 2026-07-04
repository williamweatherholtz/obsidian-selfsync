import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type NewLiveSyncPlugin from "./main";
import { ConfigSyncSelection, DEFAULT_CONFIG_SYNC } from "./configsync";
import { statusTitle } from "./wizardsteps";
import { light } from "./syncstate";
import { DeviceLinkModal } from "./devicelink";
import { SwitchVaultModal } from "./vaultswitch";

export interface NewLiveSyncSettings {
  serverUrl: string;
  username: string;
  password: string;
  verbose: boolean; // show routine sync events as notices (noisy; for debugging)
  conflictStrategy: "auto-merge" | "conflict-file";
  deviceName: string; // shown in conflict-copy filenames; blank = auto
  vaultId: string;    // which server-side vault this Obsidian vault syncs to
  configSync: ConfigSyncSelection; // which .obsidian/ config surfaces to sync (see configsync.ts)
  authToken?: string;    // cached bearer token to skip re-login (B7 makes server tokens durable/revocable)
  lastSyncedAt?: number; // epoch ms of the last successful reconcile; shown in the status card
}
export const DEFAULT_SETTINGS: NewLiveSyncSettings = {
  serverUrl: "http://127.0.0.1:8789", // 127.0.0.1 (not localhost) forces IPv4; 8789 avoids Docker/WSL on 8080
  username: "admin",
  password: "admin",
  verbose: false,
  conflictStrategy: "auto-merge",
  deviceName: "",
  vaultId: "default",
  configSync: { ...DEFAULT_CONFIG_SYNC },
  authToken: undefined,
  lastSyncedAt: undefined,
};

export class NewLiveSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: NewLiveSyncPlugin) { super(app, plugin); }
  display(): void {
    const { containerEl } = this; containerEl.empty();
    const s = this.plugin.settings;
    const configured = Boolean(s.vaultId && s.serverUrl && s.username);

    this.renderStatusCard(containerEl, s, configured);
    if (!configured) return; // unconfigured: only the status card + Set up button

    this.renderConnection(containerEl, s);
    this.renderWhatSyncs(containerEl, s);
    this.renderAdvanced(containerEl, s);
  }

  // Just the relative time ("2m ago" / "just now" / a clock time), or "—". The
  // "Last synced" label is the row/name; this is the value.
  private lastSyncedAgo(s: NewLiveSyncSettings): string {
    if (!s.lastSyncedAt) return "—";
    const mins = Math.round((Date.now() - s.lastSyncedAt) / 60000);
    if (mins <= 0) return "just now";
    if (mins < 60) return `${mins}m ago`;
    return new Date(s.lastSyncedAt).toLocaleTimeString();
  }

  // Lean status card: just the state (dot + title) + actions. Identity and last-synced
  // live under Connection, not crammed onto one line here.
  private renderStatusCard(c: HTMLElement, s: NewLiveSyncSettings, configured: boolean): void {
    const phase = this.plugin.statusText(); // FSM Phase
    const card = c.createEl("div");
    card.setAttribute("style", "padding:12px 14px;border:1px solid var(--background-modifier-border);border-radius:8px;margin-bottom:18px;");
    const title = configured ? statusTitle(phase) : "Not set up";
    const color = configured ? light(phase).color : "var(--text-muted)";
    card.createEl("div", { text: "● " + title }).setAttribute("style", `font-weight:600;color:${color};`);
    if (!configured) {
      card.createEl("div", { text: "Sync your notes to your own server." })
        .setAttribute("style", "opacity:0.75;font-size:12px;margin-top:2px;");
    }
    const bar = card.createEl("div"); bar.setAttribute("style", "display:flex;gap:8px;margin-top:12px;");
    if (!configured) {
      const setup = bar.createEl("button", { text: "Set up SelfSync" }); setup.addClass("mod-cta");
      setup.onclick = () => this.plugin.openSetup();
      return;
    }
    if (phase === "offline") { const r = bar.createEl("button", { text: "Reconnect" }); r.onclick = () => this.plugin.reconnect(); }
    const add = bar.createEl("button", { text: "Add a device" }); add.onclick = () => this.showDeviceLink();
  }

  private showDeviceLink(): void {
    new DeviceLinkModal(this.app, this.plugin.addDeviceLink()).open();
  }

  private renderConnection(c: HTMLElement, s: NewLiveSyncSettings): void {
    c.createEl("h3", { text: "Connection" });
    new Setting(c).setName("Server").setDesc(s.serverUrl)
      .addButton((b) => b.setButtonText("Change").onClick(() => this.plugin.openSetup()));
    new Setting(c).setName("Account").setDesc(`Signed in as ${s.username}`)
      .addButton((b) => b.setButtonText("Sign out").onClick(async () => { await this.plugin.signOut(); this.display(); }));
    // Switch vault reuses the existing session — no server/account re-entry.
    new Setting(c).setName("Remote vault").setDesc(s.vaultId)
      .addButton((b) => b.setButtonText("Switch vault").onClick(() => new SwitchVaultModal(this.app, this.plugin).open()));
    new Setting(c).setName("Last synced").setDesc(this.lastSyncedAgo(s));
  }

  private renderWhatSyncs(c: HTMLElement, s: NewLiveSyncSettings): void {
    c.createEl("h3", { text: "What syncs" });
    new Setting(c).setName("Notes & attachments").setDesc("Always synced.");

    const cs = s.configSync;
    new Setting(c).setName("Obsidian settings")
      .setDesc("Sync your .obsidian config (settings, plugins, hotkeys) between devices. SelfSync's own connection is never synced.")
      .addToggle((tg) => tg.setValue(cs.enabled).onChange(async (v) => {
        cs.enabled = v; await this.plugin.saveSettings(); this.display();
      }));
    if (!cs.enabled) return;

    // Minor categories: compact toggles (see styles.css) so hotkeys/snippets don't
    // read as major decisions.
    const cats = c.createEl("div"); cats.addClass("selfsync-cats");
    const cat = (name: string, key: "core" | "hotkeys" | "appearance" | "snippets" | "community") =>
      new Setting(cats).setName(name).addToggle((tg) => tg.setValue(cs[key]).onChange(async (v) => {
        cs[key] = v; await this.plugin.saveSettings(); if (key === "community") this.display();
      }));
    cat("Core settings", "core");
    cat("Hotkeys", "hotkeys");
    cat("Appearance & themes", "appearance");
    cat("CSS snippets", "snippets");
    cat("Community plugins", "community");

    // Community plugins are the "major" surface — the per-plugin list + the locked
    // SelfSync row get real prominence below.
    if (cs.community) this.renderPluginChecklist(c, cs);
  }

  private renderAdvanced(c: HTMLElement, s: NewLiveSyncSettings): void {
    const adv = c.createEl("details"); adv.addClass("selfsync-section");
    adv.createEl("summary", { text: "Advanced" });
    new Setting(adv).setName("Conflict resolution")
      .addDropdown((dd) => dd
        .addOption("auto-merge", "Automatically merge")
        .addOption("conflict-file", "Create conflict file")
        .setValue(s.conflictStrategy)
        .onChange(async (v) => { s.conflictStrategy = v as NewLiveSyncSettings["conflictStrategy"]; await this.plugin.saveSettings(); }));
    new Setting(adv).setName("Device name").setDesc("Shown in conflict-copy filenames. Blank = auto.")
      .addText((t) => t.setValue(s.deviceName).onChange(async (v) => { s.deviceName = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(adv).setName("Detailed logging")
      .addToggle((tg) => tg.setValue(s.verbose).onChange(async (v) => { s.verbose = v; await this.plugin.saveSettings(); }));
    new Setting(adv).setName("Diagnostics")
      .addButton((b) => b.setButtonText("Show sync log").onClick(() => this.plugin.showLog()))
      .addButton((b) => b.setButtonText("Copy debug info").onClick(() => this.copyDebugInfo(s)));
    new Setting(adv).setName("Disconnect").setDesc("Stop syncing this vault. Local files are kept.")
      .addButton((b) => b.setButtonText("Disconnect").setWarning().onClick(async () => { await this.plugin.disconnect(); this.display(); }));
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

  // Per-plugin allow/deny. SelfSync is shown as a LOCKED info row (not a toggle) so
  // it's unmistakable that it can never sync; every other plugin gets a real toggle.
  private renderPluginChecklist(c: HTMLElement, cs: NewLiveSyncSettings["configSync"]): void {
    const selfId = this.plugin.manifest.id;
    const manifests = ((this.app as any).plugins?.manifests ?? {}) as Record<string, { id: string; name: string }>;
    const ids = Object.keys(manifests)
      .filter((id) => id !== selfId)
      .sort((a, b) => (manifests[a].name || a).localeCompare(manifests[b].name || b));

    const locked = c.createEl("div"); locked.addClass("selfsync-locked");
    locked.createEl("span", { text: "🔒", cls: "selfsync-lock" });
    locked.createEl("span", { text: "SelfSync is never synced — this device keeps its own server & login." });

    if (ids.length === 0) return;
    const box = c.createEl("div"); box.addClass("selfsync-plugins");
    box.createEl("div", { text: "Community plugins — uncheck to exclude one:" })
      .setAttribute("style", "font-size:12px;opacity:0.7;margin:10px 0 2px;");
    for (const id of ids) {
      new Setting(box).setName(manifests[id].name || id)
        .addToggle((tg) => tg.setValue(!cs.pluginDeny.includes(id)).onChange(async (v) => {
          const set = new Set(cs.pluginDeny);
          if (v) set.delete(id); else set.add(id);
          cs.pluginDeny = [...set];
          await this.plugin.saveSettings();
        }));
    }
  }
}
