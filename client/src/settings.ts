import { App, PluginSettingTab, Setting } from "obsidian";
import type NewLiveSyncPlugin from "./main";

export interface NewLiveSyncSettings {
  serverUrl: string;
  username: string;
  password: string;
  verbose: boolean; // show routine sync events as notices (noisy; for debugging)
}
export const DEFAULT_SETTINGS: NewLiveSyncSettings = {
  serverUrl: "http://127.0.0.1:8789", // 127.0.0.1 (not localhost) forces IPv4; 8789 avoids Docker/WSL on 8080
  username: "admin",
  password: "admin",
  verbose: false,
};

export class NewLiveSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: NewLiveSyncPlugin) { super(app, plugin); }
  display(): void {
    const { containerEl } = this; containerEl.empty();
    const s = this.plugin.settings;

    new Setting(containerEl).setName("Status").setDesc(`Connection: ${this.plugin.statusText()}`);

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

    new Setting(containerEl).setName("Connection").addButton((b) =>
      b.setButtonText("Reconnect now").setCta().onClick(() => this.plugin.reconnect()));
    new Setting(containerEl).setName("Diagnostics").addButton((b) =>
      b.setButtonText("Show sync log").onClick(() => this.plugin.showLog()));
  }
}
