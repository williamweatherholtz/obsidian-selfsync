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
}
export const DEFAULT_SETTINGS: NewLiveSyncSettings = {
  serverUrl: "http://127.0.0.1:8789", // 127.0.0.1 (not localhost) forces IPv4; 8789 avoids Docker/WSL on 8080
  username: "admin",
  password: "admin",
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
};

export class NewLiveSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: NewLiveSyncPlugin) { super(app, plugin); }
  private statusCardEl?: HTMLElement;

  display(): void {
    const { containerEl } = this; containerEl.empty();
    const s = this.plugin.settings;
    const configured = Boolean(s.vaultId && s.serverUrl && s.username);

    // A stable container so the card can live-refresh in place (see refreshStatusCard);
    // the plugin calls our listener whenever the sync state changes while this tab is open.
    this.statusCardEl = containerEl.createEl("div");
    this.refreshStatusCard();
    this.plugin.statusListener = () => this.refreshStatusCard();
    if (!configured) return; // unconfigured: only the status card + Set up button

    // Four groups, one home for each concern: transitions you perform, the standing
    // connection facts, what gets synced, and the rarely-touched knobs.
    this.renderSetup(containerEl);
    this.renderConnection(containerEl, s);
    this.renderWhatSyncs(containerEl, s);
    this.renderAdvanced(containerEl, s);
  }

  hide(): void { this.plugin.statusListener = undefined; } // stop live-refreshing once closed

  // Just the relative time ("2m ago" / "just now" / a clock time), or "—". The
  // "Last synced" label is the row/name; this is the value.
  private lastSyncedAgo(s: NewLiveSyncSettings): string {
    if (!s.lastSyncedAt) return "—";
    const mins = Math.round((Date.now() - s.lastSyncedAt) / 60000);
    if (mins <= 0) return "just now";
    if (mins < 60) return `${mins}m ago`;
    return new Date(s.lastSyncedAt).toLocaleTimeString();
  }

  // Lean status card: state (dot + title) + issue, rendered into the stable container so
  // it updates live as the sync state changes (called by the plugin's statusListener).
  // This is the single state readout in settings — actions live in their own groups.
  private refreshStatusCard(): void {
    const card = this.statusCardEl;
    if (!card) return;
    card.empty();
    const s = this.plugin.settings;
    const configured = Boolean(s.vaultId && s.serverUrl && s.username);
    const phase = this.plugin.statusText(); // FSM Phase
    card.setAttribute("style", "padding:12px 14px;border:1px solid var(--background-modifier-border);border-radius:8px;margin-bottom:18px;");
    const title = configured ? statusTitle(phase) : "Not set up";
    const color = configured ? light(phase).color : "var(--text-muted)";
    card.createEl("div", { text: "● " + title }).setAttribute("style", `font-weight:600;color:${color};`);
    if (!configured) {
      card.createEl("div", { text: "Sync your notes to your own server." })
        .setAttribute("style", "opacity:0.75;font-size:12px;margin-top:2px;");
    } else {
      const issue = this.plugin.getLastIssue();
      if (phase !== "idle" && issue) {
        card.createEl("div", { text: issue }).setAttribute("style", "font-size:12px;margin-top:4px;color:var(--text-error);");
      }
    }
    const bar = card.createEl("div"); bar.setAttribute("style", "display:flex;gap:8px;margin-top:12px;");
    if (!configured) {
      const setup = bar.createEl("button", { text: "Set up SelfSync" }); setup.addClass("mod-cta");
      setup.onclick = () => this.plugin.openSetup();
      return;
    }
    if (phase === "offline") { const r = bar.createEl("button", { text: "Reconnect" }); r.onclick = () => this.plugin.reconnect(); }
  }

  // Setup & transitions — the explicit actions you perform (change wiring, switch vault,
  // link a device). Kept separate from the standing Connection facts below.
  private renderSetup(c: HTMLElement): void {
    new Setting(c).setName("Setup & transitions").setHeading();
    new Setting(c).setName("Server & account").setDesc("Change the server URL or the account you sign in with.")
      .addButton((b) => b.setButtonText("Reconfigure").onClick(() => this.plugin.openSetup()));
    new Setting(c).setName("Switch vault").setDesc("Point this Obsidian vault at a different remote vault (you choose how to combine the data at switch time).")
      .addButton((b) => b.setButtonText("Switch vault").onClick(() => new SwitchVaultModal(this.app, this.plugin).open()));
    new Setting(c).setName("Add a device").setDesc("Show a link/QR to set SelfSync up on another device.")
      .addButton((b) => b.setButtonText("Add a device").onClick(() => this.showDeviceLink()));
  }

  private showDeviceLink(): void {
    new DeviceLinkModal(this.app, this.plugin.addDeviceLink()).open();
  }

  // Connection — the standing facts of the current connection (values), plus the two ways
  // to end it. Changing these values is done via the Setup group above.
  private renderConnection(c: HTMLElement, s: NewLiveSyncSettings): void {
    new Setting(c).setName("Connection").setHeading();
    new Setting(c).setName("Server").setDesc(s.serverUrl);
    new Setting(c).setName("Account").setDesc(`Signed in as ${s.username}. Sign out also forgets this device's password (you'll re-enter it next time).`)
      .addButton((b) => b.setButtonText("Sign out").setWarning().onClick(async () => { await this.plugin.signOut(); this.display(); }));
    new Setting(c).setName("Remote vault")
      .setDesc(s.vaultOwner ? `${s.vaultOwner}/${s.vaultId} · shared with you${s.vaultReadOnly ? " (read-only)" : ""}` : s.vaultId);
    new Setting(c).setName("Last synced").setDesc(this.lastSyncedAgo(s));
    new Setting(c).setName("Disconnect").setDesc("Stop syncing this vault (you stay signed in; local files are kept).")
      .addButton((b) => b.setButtonText("Disconnect").setWarning().onClick(async () => { await this.plugin.disconnect(); this.display(); }));
  }

  private renderWhatSyncs(c: HTMLElement, s: NewLiveSyncSettings): void {
    new Setting(c).setName("What syncs").setHeading();
    new Setting(c).setName("Notes & attachments").setDesc("Always synced.");
    new Setting(c).setName("Conflict resolution")
      .setDesc("When the same file changed on two devices: merge the changes automatically, or keep both as a conflict file.")
      .addDropdown((dd) => dd
        .addOption("auto-merge", "Automatically merge")
        .addOption("conflict-file", "Create conflict file")
        .setValue(s.conflictStrategy)
        .onChange(async (v) => { s.conflictStrategy = v as NewLiveSyncSettings["conflictStrategy"]; await this.plugin.saveSettings(); }));

    const cs = s.configSync;
    new Setting(c).setName("Obsidian settings")
      .setDesc("Sync your .obsidian config — settings, hotkeys, themes — between devices. Community-plugin CODE is a separate opt-in below (off by default). SelfSync's own login is never synced.")
      .addToggle((tg) => tg.setValue(cs.enabled).onChange(async (v) => {
        cs.enabled = v; await this.plugin.saveSettings(); this.display();
      }));
    if (!cs.enabled) return;

    // The key trust signal — shown whenever config sync is on, not gated on community.
    const locked = c.createEl("div"); locked.addClass("selfsync-locked");
    locked.createEl("span", { text: "🔒", cls: "selfsync-lock" });
    locked.createEl("span", { text: "SelfSync's own settings (server, login, vault) are never synced — they stay on this device." });

    // Minor categories: compact toggles (see styles.css) so hotkeys/snippets don't
    // read as major decisions.
    const cats = c.createEl("div"); cats.addClass("selfsync-cats");
    const cat = (name: string, desc: string, key: "core" | "hotkeys" | "appearance" | "snippets" | "community") =>
      new Setting(cats).setName(name).setDesc(desc).addToggle((tg) => tg.setValue(cs[key]).onChange(async (v) => {
        cs[key] = v; await this.plugin.saveSettings(); if (key === "community") this.display();
      }));
    cat("Core settings", "app.json, core-plugins.json", "core");
    cat("Hotkeys", "hotkeys.json", "hotkeys");
    cat("Appearance & themes", "appearance.json, themes/", "appearance");
    cat("CSS snippets", "snippets/", "snippets");
    cat("Community plugins", "Each plugin's code + settings across devices. Off by default — pushing plugin code (incl. desktop-only plugins to mobile) is riskier.", "community");

    if (cs.community) {
      this.renderPluginChecklist(c, cs);
    } else {
      c.createEl("div", { text: "Community plugins are NOT syncing — turn on “Community plugins” above to include their code + settings." })
        .setAttribute("style", "font-size:12px;opacity:0.7;margin:6px 0 0 6px;");
    }
  }

  private renderAdvanced(c: HTMLElement, s: NewLiveSyncSettings): void {
    const adv = c.createEl("details"); adv.addClass("selfsync-section");
    adv.createEl("summary", { text: "Advanced" });
    new Setting(adv).setName("Show sync status in the editor")
      .setDesc("Show a sync-status icon in the open note's header. Off by default. Handy on mobile — there's no status bar and the ribbon icon sits in the sidebar drawer, so this is the way to get a visible indicator there.")
      .addToggle((tg) => tg.setValue(s.editorStatus).onChange((v) => this.plugin.setEditorStatus(v)));
    new Setting(adv).setName("Store password on this device")
      .setDesc("Keep your password for silent reconnect. Turn off for token-only: the password is removed now and you re-enter it when the session expires (~30 days) or is revoked.")
      .addToggle((tg) => tg.setValue(s.storePassword).onChange(async (v) => {
        s.storePassword = v;
        if (!v) s.password = ""; // token-only: forget the password immediately (the token stays)
        await this.plugin.saveSettings();
      }));
    new Setting(adv).setName("Device name").setDesc("Shown in conflict-copy filenames. Blank = auto (the greyed name is what's used).")
      .addText((t) => t.setPlaceholder(this.plugin.autoDeviceName()).setValue(s.deviceName).onChange(async (v) => { s.deviceName = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(adv).setName("Diagnostics")
      .addButton((b) => b.setButtonText("Show sync log").onClick(() => this.plugin.showLog()))
      .addButton((b) => b.setButtonText("Copy debug info").onClick(() => this.copyDebugInfo(s)));
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

  // Per-plugin allow/deny (the SelfSync-never-syncs reassurance is shown once, above).
  private renderPluginChecklist(c: HTMLElement, cs: NewLiveSyncSettings["configSync"]): void {
    const selfId = this.plugin.selfFolderId();
    const manifests = ((this.app as any).plugins?.manifests ?? {}) as Record<string, { id: string; name: string }>;
    const ids = Object.keys(manifests)
      .filter((id) => id !== selfId)
      .sort((a, b) => (manifests[a].name || a).localeCompare(manifests[b].name || b));
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
