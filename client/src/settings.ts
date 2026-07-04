import { App, PluginSettingTab, Setting } from "obsidian";
import type NewLiveSyncPlugin from "./main";
import { ConfigSyncSelection, DEFAULT_CONFIG_SYNC } from "./configsync";

export interface NewLiveSyncSettings {
  serverUrl: string;
  username: string;
  password: string;
  verbose: boolean; // show routine sync events as notices (noisy; for debugging)
  conflictStrategy: "auto-merge" | "conflict-file";
  deviceName: string; // shown in conflict-copy filenames; blank = auto
  vaultId: string;    // which server-side vault this Obsidian vault syncs to
  configSync: ConfigSyncSelection; // which .obsidian/ config surfaces to sync (see configsync.ts)
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
};

export class NewLiveSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: NewLiveSyncPlugin) { super(app, plugin); }
  display(): void {
    const { containerEl } = this; containerEl.empty();
    const s = this.plugin.settings;

    new Setting(containerEl).setName("Status").setDesc(`Connection: ${this.plugin.statusText()} · vault: ${s.vaultId || "(none)"}`);
    new Setting(containerEl).setName("Account & vault")
      .setDesc("Log in / register and choose which server vault this Obsidian vault syncs to.")
      .addButton((b) => b.setButtonText("Set up / switch vault").setCta().onClick(() => this.plugin.openSetup()));

    new Setting(containerEl).setName("Server URL").addText((t) =>
      t.setValue(s.serverUrl).onChange(async (v) => { s.serverUrl = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Username").addText((t) =>
      t.setValue(s.username).onChange(async (v) => { s.username = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Password").addText((t) => {
      t.setValue(s.password).onChange(async (v) => { s.password = v; await this.plugin.saveSettings(); });
      t.inputEl.type = "password";
    });
    new Setting(containerEl)
      .setName("Verbose notices")
      .setDesc("Pop a notice for every push/pull (noisy — useful while debugging).")
      .addToggle((tg) => tg.setValue(s.verbose).onChange(async (v) => { s.verbose = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl)
      .setName("Conflict handling")
      .setDesc("How to resolve a file edited on two devices before syncing.")
      .addDropdown((dd) => dd
        .addOption("auto-merge", "Auto-merge Markdown (recommended)")
        .addOption("conflict-file", "Always create a conflict copy")
        .setValue(s.conflictStrategy)
        .onChange(async (v) => { s.conflictStrategy = v as NewLiveSyncSettings["conflictStrategy"]; await this.plugin.saveSettings(); }));
    new Setting(containerEl)
      .setName("Device name")
      .setDesc("Shown in conflict-copy filenames. Blank = auto.")
      .addText((t) => t.setValue(s.deviceName).onChange(async (v) => { s.deviceName = v.trim(); await this.plugin.saveSettings(); }));

    this.renderSelectiveSync(containerEl, s);

    new Setting(containerEl).setName("Connection").addButton((b) =>
      b.setButtonText("Reconnect now").setCta().onClick(() => this.plugin.reconnect()));
    new Setting(containerEl).setName("Diagnostics").addButton((b) =>
      b.setButtonText("Show sync log").onClick(() => this.plugin.showLog()));
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
