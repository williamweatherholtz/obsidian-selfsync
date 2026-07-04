import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type NewLiveSyncPlugin from "./main";
import { ConfigSyncSelection, DEFAULT_CONFIG_SYNC } from "./configsync";
import { statusLine } from "./wizardsteps";
import { light } from "./syncstate";
import { DeviceLinkModal } from "./devicelink";

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

  private lastSyncedLabel(s: NewLiveSyncSettings): string | undefined {
    if (!s.lastSyncedAt) return undefined;
    const mins = Math.round((Date.now() - s.lastSyncedAt) / 60000);
    if (mins <= 0) return "Last synced just now";
    if (mins < 60) return `Last synced ${mins}m ago`;
    return `Last synced ${new Date(s.lastSyncedAt).toLocaleTimeString()}`;
  }

  private renderStatusCard(c: HTMLElement, s: NewLiveSyncSettings, configured: boolean): void {
    const phase = this.plugin.statusText(); // FSM Phase
    const spec = light(phase);
    const lines = statusLine(phase, { user: s.username, vault: s.vaultId, lastSyncedLabel: this.lastSyncedLabel(s) });
    const card = c.createEl("div");
    card.setAttribute("style", "padding:12px;border:1px solid var(--background-modifier-border);border-radius:8px;margin-bottom:16px;");
    const head = card.createEl("div", { text: "● " + lines.title });
    head.setAttribute("style", `font-weight:600;color:${spec.color};`);
    card.createEl("div", { text: lines.detail }).setAttribute("style", "opacity:0.8;font-size:12px;margin-top:2px;");
    const bar = card.createEl("div"); bar.setAttribute("style", "display:flex;gap:8px;margin-top:10px;");
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
    new Setting(c).setName("Account").setDesc(s.username)
      .addButton((b) => b.setButtonText("Sign out").onClick(async () => { await this.plugin.signOut(); this.display(); }));
    new Setting(c).setName("Remote vault").setDesc(s.vaultId)
      .addButton((b) => b.setButtonText("Switch vault").onClick(() => this.plugin.openSetup()));
  }

  private renderWhatSyncs(c: HTMLElement, s: NewLiveSyncSettings): void {
    c.createEl("h3", { text: "What syncs" });
    new Setting(c).setName("Notes & attachments").setDesc("Always synced.");
    const cs = s.configSync;
    const summary = !cs.enabled ? "Off" :
      `On${cs.pluginDeny.length ? ` — ${cs.pluginDeny.length} plugin(s) excluded` : ""}`;
    const detail = c.createEl("details");
    detail.createEl("summary", { text: `Obsidian settings — ${summary}` });
    this.renderSelectiveSync(detail, s); // existing M6 panel, now nested
  }

  private renderAdvanced(c: HTMLElement, s: NewLiveSyncSettings): void {
    const adv = c.createEl("details");
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

  // Panel: which .obsidian/ config surfaces sync. See configsync.ts for the rules.
  private renderSelectiveSync(containerEl: HTMLElement, s: NewLiveSyncSettings): void {
    const cs = s.configSync;
    containerEl.createEl("h3", { text: "Settings & plugin sync" });

    new Setting(containerEl)
      .setName("Sync Obsidian settings")
      .setDesc("Sync the .obsidian/ config surface (settings, plugins, hotkeys) between devices. Notes always sync regardless. SelfSync's own config is never synced (this device's server/login stay local).")
      .addToggle((tg) => tg.setValue(cs.enabled).onChange(async (v) => {
        cs.enabled = v; await this.plugin.saveSettings(); this.display();
      }));

    if (!cs.enabled) return;

    const cat = (name: string, desc: string, key: "core" | "community" | "appearance" | "snippets" | "hotkeys") =>
      new Setting(containerEl).setName(name).setDesc(desc)
        .addToggle((tg) => tg.setValue(cs[key]).onChange(async (v) => {
          cs[key] = v; await this.plugin.saveSettings(); if (key === "community") this.display();
        }));

    cat("Core settings", "app.json, core-plugins.json", "core");
    cat("Hotkeys", "hotkeys.json", "hotkeys");
    cat("Community plugins", "community-plugins.json + each plugin's folder", "community");
    cat("Appearance & themes", "appearance.json, themes/ — off by default (per-device look)", "appearance");
    cat("CSS snippets", "snippets/ — off by default", "snippets");

    if (cs.community) this.renderPluginChecklist(containerEl, cs);
  }

  // Per-plugin allow/deny checklist. SelfSync is greyed and forced off.
  private renderPluginChecklist(containerEl: HTMLElement, cs: NewLiveSyncSettings["configSync"]): void {
    const selfId = this.plugin.manifest.id;
    const manifests = ((this.app as any).plugins?.manifests ?? {}) as Record<string, { id: string; name: string }>;
    const ids = Object.keys(manifests).sort((a, b) => (manifests[a].name || a).localeCompare(manifests[b].name || b));
    if (ids.length === 0) return;
    containerEl.createEl("div", { text: "Per-plugin (uncheck to exclude one plugin):" })
      .setAttribute("style", "margin:6px 0 2px;font-size:12px;opacity:0.75;");
    for (const id of ids) {
      const name = manifests[id].name || id;
      const isSelf = id === selfId;
      new Setting(containerEl)
        .setName(isSelf ? `${name} (SelfSync — never synced)` : name)
        .addToggle((tg) => {
          tg.setValue(isSelf ? false : !cs.pluginDeny.includes(id));
          if (isSelf) { tg.setDisabled(true); return; }
          tg.onChange(async (v) => {
            const set = new Set(cs.pluginDeny);
            if (v) set.delete(id); else set.add(id);
            cs.pluginDeny = [...set];
            await this.plugin.saveSettings();
          });
        });
    }
  }
}
