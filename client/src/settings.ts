import { App, PluginSettingTab, Setting } from "obsidian";
import type NewLiveSyncPlugin from "./main";

export interface NewLiveSyncSettings { serverUrl: string; username: string; password: string; }
export const DEFAULT_SETTINGS: NewLiveSyncSettings = { serverUrl: "http://localhost:8080", username: "admin", password: "admin" };

export class NewLiveSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: NewLiveSyncPlugin) { super(app, plugin); }
  display(): void {
    const { containerEl } = this; containerEl.empty();
    const s = this.plugin.settings;
    new Setting(containerEl).setName("Server URL").addText((t) =>
      t.setValue(s.serverUrl).onChange(async (v) => { s.serverUrl = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Username").addText((t) =>
      t.setValue(s.username).onChange(async (v) => { s.username = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Password").addText((t) => {
      t.setValue(s.password).onChange(async (v) => { s.password = v; await this.plugin.saveSettings(); });
      t.inputEl.type = "password";
    });
    new Setting(containerEl).setName("Reconnect").addButton((b) =>
      b.setButtonText("Connect").onClick(() => this.plugin.reconnect()));
  }
}
