import { App, PluginSettingTab, Setting, SettingGroup, Notice, Platform, AbstractInputSuggest, ExtraButtonComponent, ButtonComponent, setIcon } from "obsidian";
import type NewLiveSyncPlugin from "./main";
import { addExcluded, removeExcluded, matchFolders } from "./excludedFolders";

// Folder-path autocomplete for the excluded-folders input: a thin adapter over the pure matchFolders,
// fed the live vault folder list. All ranking logic stays pure + unit-tested (excludedFolders.test).
class FolderSuggest extends AbstractInputSuggest<string> {
  constructor(app: App, inputEl: HTMLInputElement, private folders: () => string[]) { super(app, inputEl); }
  getSuggestions(query: string): string[] { return matchFolders(query, this.folders()); }
  renderSuggestion(value: string, el: HTMLElement): void { el.setText(value); }
  selectSuggestion(value: string): void { this.setValue(value); this.close(); }
}
import { ConfigSyncSelection, DEFAULT_CONFIG_SYNC, groupConfigConflicts, ConfigSurface } from "./configsync";
import { DEFAULT_IGNORED_TIMESTAMP_KEYS, validateTimestampKey } from "./frontmatter";
import { ConfigDirectionModal } from "./configdir";
import { confirmModal } from "./confirm";
import { pushPreviewModal } from "./pushpreviewmodal";
import { light } from "./syncstate";
import { DeviceLinkModal } from "./devicelink";
import { SwitchVaultModal } from "./vaultswitch";
import { ChangePasswordModal, ShareManageModal } from "./accountui";

// Case-insensitive set equality for the ignored-date-field list (so "Restore defaults" only shows when the
// list has genuinely drifted from the defaults, regardless of order/case).
function sameKeySet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const norm = (xs: readonly string[]) => new Set(xs.map((x) => x.toLowerCase()));
  const bs = norm(b);
  return [...norm(a)].every((x) => bs.has(x));
}

export interface NewLiveSyncSettings {
  serverUrl: string;
  username: string;
  password: string;
  deviceName: string; // shown in conflict-copy filenames; blank = auto
  vaultId: string;    // which server-side vault this Obsidian vault syncs to
  configSync: ConfigSyncSelection; // which .obsidian/ config surfaces to sync (see configsync.ts)
  // When to notify that a SYNCED config/plugin change arrived, by its SOURCE (never by vault shared/private
  // status): "user" (default) notifies only when ANOTHER PERSON (a different account) made the change —
  // your own devices stay silent; "userDevice" also notifies when it was YOU but from a DIFFERENT device.
  // The decision keys on the server-authenticated author + the stable device UUID (see configChangeSource).
  configChangeNotify: "user" | "userDevice";
  // Set-and-forget plugin sync (nPluginSyncAutopilot). When true: a plugin you install HERE, and a plugin
  // from another of YOUR OWN devices (same authenticated account), is auto-added to the synced allowlist —
  // no tab visit. A plugin added by ANOTHER PERSON never auto-adopts; it waits for your explicit approval
  // (a toast + the "Awaiting your approval" list). Default false — auto-propagating plugin CODE is
  // security-sensitive, so it's opt-in.
  autoSyncNewPlugins: boolean;
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
  // D0047 guard for the vault-change-skips-transition class: the `owner/vaultId` the persisted base belongs
  // to. On connect, if it doesn't match the vault we're about to sync (any path changed the vault without
  // going through switchTo), the base is FOREIGN and reconciling against it could silently overwrite — so we
  // force a safe merge-switch (clears the base). Stamped after each successful connect. Per-device (settings
  // never sync); omitted from DEFAULT_SETTINGS.
  baseVaultKey?: string;
  // This device's STABLE provenance UUID (change attribution). Minted once (crypto.randomUUID) and stamped
  // on every commit so peers can tell WHO wrote a change; identity is this UUID, not the mutable deviceName,
  // so a rename can't impersonate another device. Per-device (settings never sync); omitted from
  // DEFAULT_SETTINGS and lazily created by plugin.deviceId() on first use.
  deviceId?: string;
  // Plugin ids the auto-sync autopilot has already OBSERVED (per-device; omitted from DEFAULT_SETTINGS,
  // lazily []). The autopilot auto-adds a plugin only the FIRST time it sees it (not in this set), so once
  // you've un-ticked an auto-added plugin it stays un-synced — the policy never fights a manual choice.
  autopilotSeen?: string[];
  // Timestamp-ignore (the redesigned feature — SelfSync NEVER writes note timestamps). When on, a diff that
  // is only a TIMESTAMP-VALUED frontmatter key is excluded from sync change-detection, so it never causes a
  // conflict. Identity-only; it never edits a note. ON by default (safe: never writes; value-shape gated).
  ignoreTimestampChanges: boolean;
  // Frontmatter key patterns whose timestamp-valued lines are ignored. A trailing `*` is a prefix wildcard
  // (e.g. `updated-*` for per-device keys). Defaults to DEFAULT_IGNORED_TIMESTAMP_KEYS.
  ignoredTimestampKeys: string[];
  excludedFolders: string[]; // folders where timestamp-only diffs are NOT ignored (they sync raw; EOL/BOM still normalized)
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
  configChangeNotify: "user", // notify only on ANOTHER PERSON's synced config change (your own devices stay silent)
  autoSyncNewPlugins: false,  // opt-in: auto-sync your own new plugins everywhere; a peer's still needs approval
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
  // Timestamp-ignore (identity-only, default ON — it never writes notes; see the field docs above).
  ignoreTimestampChanges: true,
  ignoredTimestampKeys: [...DEFAULT_IGNORED_TIMESTAMP_KEYS],
  excludedFolders: [],
  // historyFloors intentionally omitted here: a module-level object literal in DEFAULT_SETTINGS
  // would be ALIASED across instances by Object.assign (a shared-mutable-default bug). It's created
  // fresh per instance by `this.settings.historyFloors ??= {}` on first use in doReconcileAll (D0019).
};

// Parse an untrusted persisted settings object (the `settings` sub-object of data.json) into a fully-
// hardened NewLiveSyncSettings — parse-don't-validate at the persistence boundary (issuePatternUntagged
// ShouldAdopt). Every field is defaulted from DEFAULT_SETTINGS, and each nested collection is rebuilt as a
// FRESH instance with its own type guard, so a corrupt / partial / hand-edited / hostile data.json can
// never leave a field aliasing a module constant (a shared-mutable bug) or holding the wrong type. The
// loader (loadSettings) then owns only the read + the separate BaseStore; the settings SHAPE is defined
// and defended here, right next to DEFAULT_SETTINGS, so the two can't drift.
export function parseSettings(raw: unknown): NewLiveSyncSettings {
  const s = (raw && typeof raw === "object" ? raw : {}) as Partial<NewLiveSyncSettings> & { configSync?: Partial<ConfigSyncSelection> };
  const out = Object.assign({}, DEFAULT_SETTINGS, s);
  // Fresh, fully-defaulted configSync (never share the module constant; backfill categories added since
  // this vault last saved), each nested collection its own fresh instance so in-place mutation can't reach
  // DEFAULT_CONFIG_SYNC.
  out.configSync = { ...DEFAULT_CONFIG_SYNC, ...(s.configSync ?? {}) };
  out.configSync.pluginAllow = [...(s.configSync?.pluginAllow ?? [])];
  out.configSync.pluginDir = { ...(s.configSync?.pluginDir ?? {}) };
  // Fresh array (the adjudication queue is mutated in place); a non-array persisted value → empty.
  out.configConflicts = Array.isArray(s.configConflicts) ? [...s.configConflicts] : [];
  // Fresh array (mutated in place by add/remove); a non-array persisted value → empty.
  out.excludedFolders = Array.isArray(s.excludedFolders) ? [...s.excludedFolders] : [];
  // Provenance fields: a stable per-device UUID (kept only if it's a non-empty string; else re-minted
  // lazily) and the notify mode (only the two known values; anything else → the safe "user" default).
  out.deviceId = typeof s.deviceId === "string" && s.deviceId ? s.deviceId : undefined;
  out.configChangeNotify = s.configChangeNotify === "userDevice" ? "userDevice" : "user";
  out.autoSyncNewPlugins = s.autoSyncNewPlugins === true; // opt-in; any non-true persisted value → off
  out.autopilotSeen = Array.isArray(s.autopilotSeen) ? [...new Set(s.autopilotSeen.filter((x): x is string => typeof x === "string"))] : undefined;
  // Migrate the retired 1.7-1.8 "embed timestamps" (which WROTE notes) to the identity-only "ignore
  // timestamp changes". Default ON for everyone — it never edits files and is value-shape gated, so even a
  // vault that never touched the old feature gets conflict suppression + the always-on EOL/BOM fix. Honor an
  // explicit new-field value if present; otherwise default on regardless of the old boolean.
  const legacy = s as Partial<{ ignoreTimestampChanges: boolean; ignoredTimestampKeys: string[]; timestampCreatedKey: string; timestampUpdatedKey: string }>;
  out.ignoreTimestampChanges = typeof legacy.ignoreTimestampChanges === "boolean" ? legacy.ignoreTimestampChanges : true;
  out.ignoredTimestampKeys = Array.isArray(legacy.ignoredTimestampKeys) && legacy.ignoredTimestampKeys.length
    ? [...legacy.ignoredTimestampKeys]
    : [...new Set([
        ...(legacy.timestampCreatedKey ? [legacy.timestampCreatedKey] : []),
        ...(legacy.timestampUpdatedKey ? [legacy.timestampUpdatedKey] : []),
        ...DEFAULT_IGNORED_TIMESTAMP_KEYS,
      ])];
  // Drop retired fields so a migrated data.json doesn't carry dead keys forward.
  const bag = out as unknown as Record<string, unknown>;
  for (const k of ["embeddedTimestamps", "timestampCreatedKey", "timestampUpdatedKey", "driveFsTimes", "timestampBackfill"]) delete bag[k];
  return out;
}

export class NewLiveSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: NewLiveSyncPlugin) { super(app, plugin); }
  private statusGroup?: SettingGroup;
  private pluginsExpanded?: boolean; // persists the synced-plugins list expand state across re-renders
  // Per-plugin "already in sync" cache (id → converged?) for the Push/Pull grey-out: applied instantly on a
  // re-render (no flicker) and refreshed async each render; an entry is dropped after a push/pull. Cleared on
  // hide() so a re-open re-checks fresh state.
  private pluginCleanCache = new Map<string, boolean>();
  private timestampExpanded?: boolean; // persists the (default-collapsed) Timestamp-changes section state
  private advancedExpanded?: boolean; // persists the (default-collapsed) Advanced section state

  // Section order answers "is my sync working?" FIRST (the live Status hero), then "what/how do I
  // sync" (Connection facts + What syncs), then the rarely-touched controls (collapsed). Each section
  // is a native SettingGroup so the heading renders OUTSIDE a single cohesive card (how Obsidian +
  // card themes group settings). The Status hero is a member group so FSM ticks refresh JUST its row
  // in place (fillStatus) — no whole-tab rebuild that would drop focus/scroll in the sections below.
  display(): void {
    const { containerEl } = this;
    // PRESERVE SCROLL across the rebuild (owner-reported: toggling a control jumped the page to the top). Many
    // handlers call display() — a full containerEl.empty()+rebuild — which otherwise discards the scroll
    // position. Capture the scrolling ancestor's scrollTop BEFORE emptying (its metrics are still valid) and
    // restore it after; the sections rebuild at the same heights, so the user stays put. Centralised here so
    // EVERY re-render is covered, not by per-handler vigilance.
    const scroller = this.scrollEl();
    const savedTop = scroller?.scrollTop ?? 0;
    containerEl.empty();
    const s = this.plugin.settings;
    const configured = Boolean(s.vaultId && s.serverUrl && s.username);

    // ① STATUS — the live sync state, first (the reason you opened settings).
    this.statusGroup = new SettingGroup(containerEl).setHeading("Status");
    this.fillStatus();
    this.plugin.statusListener = () => this.fillStatus();
    this.plugin.settingsRefresh = () => this.display(); // re-render when the conflict count changes
    if (configured) {
      this.renderConnection(containerEl, s);       // ② server / account / vault facts + manage actions
      this.renderWhatSyncs(containerEl, s);        // ③ the opt-in .obsidian config-sync scope
      this.renderConflicts(containerEl);           // ④ only when a manual choice is pending
      this.renderAdvanced(containerEl, s);         // ⑤ collapsed by default
      this.renderIgnoreTimestamps(containerEl, s); // ⑥ collapsed by default — identity-only timestamp masking
    } // else unconfigured: only the Status hero + Set up / Redeem buttons

    if (scroller && savedTop) scroller.scrollTop = savedTop; // stay where the user was, don't jump to the top
  }

  // The nearest SCROLLING ancestor of the settings content — the element whose scrollTop we preserve across a
  // rebuild. Called while the OLD content is still mounted, so scroll metrics are valid; walks up from
  // containerEl and falls back to it. (The scroller is an ancestor that survives containerEl.empty().)
  private scrollEl(): HTMLElement | null {
    for (let el: HTMLElement | null = this.containerEl; el; el = el.parentElement) {
      if (el.scrollHeight > el.clientHeight + 1) {
        const oy = getComputedStyle(el).overflowY;
        if (oy === "auto" || oy === "scroll") return el;
      }
    }
    return this.containerEl;
  }

  hide(): void { this.plugin.statusListener = undefined; this.plugin.settingsRefresh = undefined; this.pluginCleanCache.clear(); } // stop live-refreshing once closed; re-check convergence on re-open

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
    // The value goes in the DESCRIPTION (full-width, wraps) — not an inline control-area span. A long
    // value (e.g. the server URL) otherwise competes with the action buttons for width and pushes them
    // off the card on a narrow screen (owner-reported overflow). The control row then holds only buttons.
    g.addSetting((st) => {
      st.setName(label).setDesc(value);
      extra?.(st);
    });
  }

  // A button with a leading lucide glyph + label. Native icons (theme-coloured, identical on every
  // device — unlike emoji, which render inconsistently and can't take the warning tint). `warn` marks
  // a destructive/exit action (red). The label stays, so the button reads clearly on mobile.
  private iconBtn(b: ButtonComponent, icon: string, text: string, warn = false): ButtonComponent {
    b.setButtonText(text);
    b.buttonEl.addClass("selfsync-icon-btn");
    const ic = b.buttonEl.createSpan({ cls: "selfsync-btn-icon" });
    setIcon(ic, icon);
    b.buttonEl.insertBefore(ic, b.buttonEl.firstChild);
    if (warn) b.setWarning();
    return b;
  }

  // Fill the STATUS hero (into the group's listEl, so an FSM tick refreshes just this row). It answers
  // "is my sync working?" at a glance: a coloured dot + the live state label, last-synced as the
  // sub-line, and a fix action ONLY when the link is down. A pure projection of the sync FSM — the
  // status IS the diagnosis (no separate "Diagnose" probe that could falsely say "all good", an L-5 gap).
  private fillStatus(): void {
    const g = this.statusGroup;
    if (!g) return;
    g.listEl.empty();
    const s = this.plugin.settings;
    const configured = Boolean(s.vaultId && s.serverUrl && s.username);

    if (!configured) {
      g.addSetting((st) => st.setName("Not set up").setDesc("Sync your notes to your own server, or accept a vault someone shared with you.")
        .addButton((b) => this.iconBtn(b, "settings", "Set up SelfSync").setCta().onClick(() => this.plugin.openSetup()))
        // A brand-new recipient's entry point — accepting a shared vault shouldn't require first
        // knowing to open "Set up" and paste a link into a field labelled for setup links.
        .addButton((b) => this.iconBtn(b, "ticket", "Redeem a share link").onClick(() => this.plugin.openRedeem())));
      return;
    }

    const phase = this.plugin.statusText(); // FSM Phase
    const disp = this.plugin.statusDisplay(phase); // label + detail (pure projection: Fully synced / Syncing… N pending / …)
    const issue = this.plugin.getLastIssue();
    g.addSetting((st) => {
      st.settingEl.addClass("selfsync-status-hero");
      // realtime-aware dot colour, same source as the ribbon (no green-dot-over-polling divergence).
      st.nameEl.createSpan({ cls: "selfsync-dot", text: "●" }).setAttribute("style", `color:${light(phase, "", this.plugin.realtimeConnected).color}`);
      st.nameEl.createSpan({ cls: "selfsync-status-label", text: disp.label + (disp.detail ? ` ${disp.detail}` : "") });
      st.setDesc(`Last synced ${this.lastSyncedAgo(s)}` + (phase !== "idle" && issue ? ` · ${issue}` : ""));
      // A down link (any reason) — offer the fix inline.
      if (phase === "retrying" || phase === "blocked" || phase === "lockedOut") {
        st.addButton((b) => this.iconBtn(b, "refresh-cw", "Reconnect").onClick(() => this.plugin.reconnect()));
        // D0021: the vault was deleted server-side — offer a deliberate re-create-from-this-device.
        if (this.plugin.isVaultGone()) {
          st.addButton((b) => this.iconBtn(b, "upload-cloud", "Re-create vault from this device").setCta().onClick(() => void this.plugin.recreateVault()));
        }
      }
    });
  }

  // ② Connection — the identity/connection facts (server / account / vault) + a manage-actions row.
  // Static (server/account/vault change on reconfigure/switch/sign-out, which re-render the whole tab),
  // so it lives OUTSIDE the live Status hero. The manage row is deliberately not named "Connection"
  // (the group already is — an earlier group-and-row name collision).
  private renderConnection(c: HTMLElement, s: NewLiveSyncSettings): void {
    const g = new SettingGroup(c).setHeading("Connection");
    // Server + the connection-management actions live together (owner): "Setup" re-opens setup to change
    // the server connection (clearer than the old "Reconfigure"); "Disconnect" stops syncing but keeps
    // your login ("Sign out" on the Account row does both).
    this.factRow(g, "Server", s.serverUrl, (st) => st
      .addButton((b) => this.iconBtn(b, "settings", "Setup").onClick(() => this.plugin.openSetup()))
      .addButton((b) => this.iconBtn(b, "unplug", "Disconnect").onClick(async () => { await this.plugin.disconnect(); this.display(); })));
    this.factRow(g, "Account", s.username, (st) => st
      .addButton((b) => this.iconBtn(b, "key", "Change password").onClick(() => new ChangePasswordModal(this.app, this.plugin).open()))
      // Sign-out clears the token (token-only mode keeps no password), so getting back in needs the
      // password re-entered — confirm it (and it sits next to "Change password", easy to fat-finger).
      // Warn-tinted (red) as the "leave your account" exit action.
      .addButton((b) => this.iconBtn(b, "log-out", "Sign out", true).onClick(async () => {
        if (!(await confirmModal(this.app, { title: "Sign out?", body: `Sign out of ${s.serverUrl}? You'll need your password to sign back in. Your local files are kept.`, confirmText: "Sign out", warn: true }))) return;
        await this.plugin.signOut(); this.display();
      })));
    this.factRow(g, "Vault", s.vaultOwner ? `${s.vaultOwner}/${s.vaultId}${s.vaultReadOnly ? " · read-only" : ""}` : s.vaultId,
      (st) => {
        // "Share" here = share this vault with OTHER people (owned vaults only). Distinct from syncing
        // one of YOUR OWN devices below — kept as two clearly-different labels, not two "Share"s.
        if (!s.vaultOwner) st.addButton((b) => this.iconBtn(b, "share-2", "Share").onClick(() => new ShareManageModal(this.app, this.plugin).open()));
        // "Switch" also redeems a share link to gain access to another vault.
        st.addButton((b) => this.iconBtn(b, "arrow-left-right", "Switch").onClick(() => new SwitchVaultModal(this.app, this.plugin).open()));
      });
    // Set up another of YOUR devices — a one-time link. Named "Sync a device" (not "Add a device":
    // add to WHAT?); its own row, not a second "Share", so it's clearly about a device you own rather
    // than sharing the vault with someone else.
    g.addSetting((st) => st.setName("Sync a device")
      .setDesc("Get another of your devices syncing with a one-time setup link.")
      .addButton((b) => this.iconBtn(b, "link", "Create link").onClick(() => this.showDeviceLink())));
  }

  private showDeviceLink(): void {
    new DeviceLinkModal(this.app, this.plugin.addDeviceLink()).open();
  }

  // What syncs — the opt-in .obsidian config surface (notes/attachments always sync, so no no-op
  // "always synced" row). Community-plugin code is a further opt-in, its own card below.
  private renderWhatSyncs(c: HTMLElement, s: NewLiveSyncSettings): void {
    const cs = s.configSync;
    const ro = !!s.vaultReadOnly;
    const g = new SettingGroup(c).setHeading("What syncs");
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

    // Source-driven change notifications: a synced settings/plugin change is worth knowing about only when
    // SOMEONE ELSE made it. Your own edits never notify. Choose whether "someone else" means another person
    // (default) or also another of your own devices. (Notes are never part of this — only .obsidian config.)
    g.addSetting((st) => st.setName("Tell me when settings change")
      .setDesc("Only changes you didn't make here notify you — never your own edits. Choose whose count.")
      .addDropdown((dd) => dd
        .addOption("user", "Another person changes them")
        .addOption("userDevice", "Another of my devices changes them, too")
        .setValue(s.configChangeNotify)
        .onChange(async (v) => { s.configChangeNotify = v === "userDevice" ? "userDevice" : "user"; await this.plugin.saveSettings(); })));

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

  // Advanced — collapsed by default (rarely touched, so it stays out of the common view; one tap opens it).
  private renderAdvanced(c: HTMLElement, s: NewLiveSyncSettings): void {
    const body = this.collapsible(c, "Advanced", this.advancedExpanded ?? false, (v) => { this.advancedExpanded = v; });
    new Setting(body).setName("Show sync status in the editor")
      .setDesc("Show a sync-status icon in the open note's header.")
      .addToggle((tg) => tg.setValue(s.editorStatus).onChange((v) => this.plugin.setEditorStatus(v)));
    new Setting(body).setName("Store password on this device")
      .setDesc("Stay signed in on this device. Off is more secure — you re-enter your password if the session expires.")
      .addToggle((tg) => tg.setValue(s.storePassword).onChange(async (v) => {
        s.storePassword = v;
        if (!v) s.password = ""; // token-only: forget the password immediately (the token stays)
        await this.plugin.saveSettings();
      }));
    new Setting(body).setName("Max file size to sync (MB)")
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
      });
    new Setting(body).setName("Device name").setDesc("Shown in conflict-copy filenames.")
      .addText((t) => t.setPlaceholder(this.plugin.autoDeviceName()).setValue(s.deviceName).onChange(async (v) => { s.deviceName = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(body).setName("Diagnostics")
      .addButton((b) => b.setButtonText("Show sync log").onClick(() => this.plugin.showLog()))
      .addButton((b) => b.setButtonText("Copy debug info").onClick(() => this.copyDebugInfo(s)));
  }

  // Collapsible section built from Obsidian's OWN components: the header is a REAL `SettingGroup` section
  // heading — the SAME component as "Synced community plugins"/"Advanced" — so it renders identically to
  // the other section headings on every theme. The chevron is added with `addExtraButton` — the DOCUMENTED
  // way to put a control in a SettingGroup heading — so it lands IN the heading rather than being placed by
  // guessing the group's internal DOM (an earlier `listEl.previousElementSibling` guess was wrong on mobile
  // Obsidian: the chevron ended up inside the list card, divorced from the label). The whole heading row is
  // a toggle target, derived from the button via the stable `.setting-item` class (no structure guessing).
  // We toggle the group's public `listEl` (the body) and render rows into it. Returns that body element.
  private collapsible(c: HTMLElement, title: string, open: boolean, onToggle: (open: boolean) => void): HTMLElement {
    const group = new SettingGroup(c).setHeading(title).addClass("selfsync-collapse-group");
    let isOpen = open;
    let btn: ExtraButtonComponent | undefined;
    const paint = () => {
      btn?.setIcon(isOpen ? "chevron-down" : "chevron-right");
      group.listEl.style.display = isOpen ? "" : "none";
    };
    const toggle = () => { isOpen = !isOpen; onToggle(isOpen); paint(); };
    group.addExtraButton((b) => { btn = b; b.setTooltip("Expand or collapse").onClick(() => toggle()); });
    // The heading row itself toggles too — found from the button we just added (its `.setting-item`
    // ancestor is the heading), so we never assume the group's internal structure.
    const heading = (btn?.extraSettingsEl?.closest?.(".setting-item") ?? null) as HTMLElement | null;
    if (heading) {
      heading.addClass("selfsync-collapse-header");
      heading.addEventListener("click", (e) => {
        // The chevron button already toggles on its own click; ignore its bubbled event (no double-toggle).
        if (btn && btn.extraSettingsEl.contains(e.target as Node)) return;
        toggle();
      });
    }
    paint();
    return group.listEl;
  }

  // Timestamp-ignore controls, in a DEFAULT-COLLAPSED section (rarely touched — owner). Identity-only:
  // nothing here ever edits a note. Each list is a validated add / little-X-remove row (no free-text blob,
  // no huge Remove button); the list is easily restorable, so no scary warning. Re-render on change.
  private renderIgnoreTimestamps(c: HTMLElement, s: NewLiveSyncSettings): void {
    const body = this.collapsible(c, "Timestamp changes", this.timestampExpanded ?? false, (v) => { this.timestampExpanded = v; });
    new Setting(body).setName("Ignore timestamp-only changes")
      .setDesc("Don't treat a note that differs only in a date field (created, updated, …) as a change or conflict. SelfSync never edits these fields.")
      .addToggle((tg) => tg.setValue(s.ignoreTimestampChanges).onChange(async (v) => {
        s.ignoreTimestampChanges = v; // identity-only: safe to toggle freely, never touches a note's content
        await this.plugin.saveSettings(); this.display();
      }));
    if (!s.ignoreTimestampChanges) return;
    // Ignored date fields — a validated ADD-a-row list (not a free-text blob), each row removable by a little
    // X (poka-yoke; the validator rejects malformed/duplicate keys). Mirrors the plugin-checklist rows.
    new Setting(body).setName("Ignored date fields")
      .setDesc("Frontmatter keys treated as dates. Trailing * is a wildcard — updated-* matches updated-laptop, updated-phone.");
    for (const key of s.ignoredTimestampKeys) {
      new Setting(body).setName(key)
        .addExtraButton((b) => b.setIcon("x").setTooltip("Remove").onClick(async () => {
          s.ignoredTimestampKeys = s.ignoredTimestampKeys.filter((k) => k !== key);
          await this.plugin.saveSettings(); this.display();
        }));
    }
    {
      let input: { getValue(): string } | undefined;
      const st = new Setting(body).setName("Add a date field");
      st.addText((t) => { input = t; t.setPlaceholder("e.g. updated or updated-*"); });
      st.addButton((b) => b.setButtonText("Add field").onClick(async () => {
        const res = validateTimestampKey(input?.getValue() ?? "", s.ignoredTimestampKeys);
        if ("error" in res) { new Notice(`SelfSync: ${res.error}`); return; } // prevent the bad entry, tell the user why
        s.ignoredTimestampKeys = [...s.ignoredTimestampKeys, res.key];
        await this.plugin.saveSettings(); this.display();
      }));
    }
    // Easily restorable, so no warning needed: offer "Restore defaults" only when the list has drifted.
    if (!sameKeySet(s.ignoredTimestampKeys, DEFAULT_IGNORED_TIMESTAMP_KEYS)) {
      new Setting(body).setName("Restore default date fields")
        .addButton((b) => b.setButtonText("Restore defaults").onClick(async () => {
          s.ignoredTimestampKeys = [...DEFAULT_IGNORED_TIMESTAMP_KEYS];
          await this.plugin.saveSettings(); this.display();
        }));
    }
    new Setting(body).setName("Excluded folders")
      .setDesc("Folders where date-only changes still count (sync raw).");
    for (const folder of s.excludedFolders) {
      new Setting(body).setName(folder)
        .addExtraButton((b) => b.setIcon("x").setTooltip("Remove").onClick(async () => {
          await this.plugin.setExcludedFolders(removeExcluded(s.excludedFolders, folder)); this.display();
        }));
    }
    {
      let input: { getValue(): string } | undefined;
      const st = new Setting(body).setName("Add a folder");
      st.addText((t) => { input = t; t.setPlaceholder("Folder to exclude"); new FolderSuggest(this.app, t.inputEl as HTMLInputElement, () => this.plugin.getAllFolders()); });
      st.addButton((b) => b.setButtonText("Add folder").onClick(async () => {
        const v = (input?.getValue() ?? "").trim();
        if (v) { await this.plugin.setExcludedFolders(addExcluded(s.excludedFolders, v)); this.display(); }
      }));
    }
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
    const ro = !!this.plugin.settings.vaultReadOnly;
    const displayName = (id: string) => manifests[id]?.name || this.plugin.getPluginDisplayName(id) || id;
    const byName = (a: string, b: string) => displayName(a).localeCompare(displayName(b));
    const allIds = [...new Set([...installed, ...onServer])];
    // PARITY (issuePluginSyncStaleServerState): the main list is only what THIS device actually syncs —
    // installed here OR explicitly adopted (allowlisted). A plugin merely present on the server (from another
    // device) but not installed/adopted here is AVAILABLE-to-adopt, shown in a separate subordinate group —
    // never mixed into "Synced" (where it read as "this is syncing" when it wasn't).
    const syncedIds = allIds.filter((id) => installed.has(id) || cs.pluginAllow.includes(id)).sort(byName);
    const availableIds = allIds.filter((id) => onServer.has(id) && !installed.has(id) && !cs.pluginAllow.includes(id)).sort(byName);
    const shared = syncedIds.filter((id) => cs.pluginAllow.includes(id)).length;
    const g = new SettingGroup(c).setHeading("Synced community plugins");

    // Set-and-forget policy (nPluginSyncAutopilot): when on, your own new plugins auto-sync everywhere; a
    // plugin added by another person still waits for your approval below. Kick a pass on render (idempotent +
    // guarded) so opening the tab catches up without waiting for the next reconcile.
    g.addSetting((st) => st.setName("Auto-sync new plugins")
      .setDesc("New plugins you install here — and ones from your other devices — sync automatically. A plugin added by someone else still waits for your approval below.")
      .addToggle((tg) => tg.setValue(this.plugin.settings.autoSyncNewPlugins).onChange(async (v) => {
        this.plugin.settings.autoSyncNewPlugins = v; await this.plugin.saveSettings();
        if (v) void this.plugin.runPluginAutopilot();
        this.display();
      })));
    if (this.plugin.settings.autoSyncNewPlugins) void this.plugin.runPluginAutopilot();

    // Standing RESTART reminder: a plugin adopted from the sync but not yet installed locally is on
    // disk (or downloading), but Obsidian only loads plugins at STARTUP — it stays dormant until a full
    // restart. The transient sync toast is easy to miss on mobile, so surface it as a persistent banner
    // here, where the user just tapped "Install." (Closes the "looks done but nothing happened" gap.)
    const needsRestart = syncedIds.filter((id) => cs.pluginAllow.includes(id) && !installed.has(id));
    if (needsRestart.length) {
      g.addSetting((st) => st.setName(`${needsRestart.length} plugin${needsRestart.length > 1 ? "s" : ""} not active yet`).setClass("mod-warning")
        .setDesc("Downloaded from the sync — fully close and reopen Obsidian (on mobile, swipe the app away) to enable them."));
    }

    // Fresh vault, before the first full reconcile has reported the server's plugins: don't render an
    // empty group that reads as "nothing to sync" — say we're still looking.
    if (allIds.length === 0) {
      g.addSetting((st) => st.setName("Checking the server for plugins…")
        .setDesc("Plugins synced from your other devices will appear here after the next sync — then tick them to install."));
      return;
    }

    // Summary + the fresh-vault bootstrap ("Install all from the sync" adopts every server plugin, download-
    // only for the ones not installed here). "Sync none" removed (owner) — the auto-sync policy + per-plugin
    // ticks replace it.
    g.addSetting((st) => {
      st.setName("All plugins").setDesc(`${shared} of ${syncedIds.length} synced${availableIds.length ? ` · ${availableIds.length} available from the sync (not adopted here)` : ""}.`);
      if (availableIds.length) st.addButton((b) => b.setButtonText("Install all from the sync").setCta().onClick(async () => { await this.plugin.installAllServerPlugins(); this.display(); }));
    });

    // Explain the disabled Push/Pull state (owner-requested) — shown when there are installed synced plugins
    // (the ones that carry the buttons) on a writable vault.
    if (!ro && syncedIds.some((id) => installed.has(id))) {
      g.addSetting((st) => st.setDesc("Greyed Push/Pull = already in sync."));
    }

    // The plugins THIS device actually syncs.
    this.renderPluginRows(c, syncedIds, cs, manifests, installed, onServer, ro, `${syncedIds.length} synced`);

    // A SEPARATE, subordinate group for the AVAILABLE-to-adopt set: plugins on the server not installed/
    // adopted here. When the autopilot is on, the ones ANOTHER PERSON added are gated here for your approval
    // (own plugins were auto-adopted), so this doubles as the persistent "awaiting your approval" surface the
    // toast points to — labeled with WHO added each.
    if (availableIds.length) {
      const pendingAuthors = new Map(this.plugin.getPendingPeerPlugins().map((p) => [p.id, p.author]));
      const anyPending = availableIds.some((id) => pendingAuthors.has(id));
      const ag = new SettingGroup(c).setHeading(anyPending ? "Awaiting your approval" : "Available from the sync (not adopted)");
      ag.addSetting((st) => st.setDesc(anyPending
        ? "Someone else added these on the shared vault. They never auto-install — tick one to approve + adopt it here."
        : "On the server from your other devices, but not installed or synced here. Tick one to adopt it on this device."));
      this.renderPluginRows(c, availableIds, cs, manifests, installed, onServer, ro, `${availableIds.length} available`, pendingAuthors);
    }
  }

  // Render a collapsible list of plugin rows (toggle + first-contact direction). Shared by the "Synced"
  // and "Available from the sync" groups so the row logic lives in one place.
  private renderPluginRows(c: HTMLElement, ids: string[], cs: NewLiveSyncSettings["configSync"], manifests: Record<string, { id: string; name: string }>, installed: Set<string>, onServer: Set<string>, ro: boolean, summaryLabel: string, pendingAuthors?: Map<string, string>): void {
    if (!ids.length) return;
    const body = this.collapsible(c, summaryLabel, this.pluginsExpanded ?? ids.length <= 8, (v) => { this.pluginsExpanded = v; });
    for (const id of ids) {
      const on = cs.pluginAllow.includes(id);
      const here = installed.has(id);
      const st = new Setting(body).setName(manifests[id]?.name || this.plugin.getPluginDisplayName(id) || id);
      const addedBy = pendingAuthors?.get(id);
      if (addedBy) st.setDesc(`added by ${addedBy} — approve to install + sync it here`); // a peer's plugin awaiting approval
      else if (!here && onServer.has(id)) st.setDesc("from the sync — installs here on next sync");
      else if (here && !onServer.has(id)) st.setDesc("here only — uploads to the server on next sync");
      st.addToggle((tg) => tg.setValue(on).onChange(async (v) => { await this.plugin.setPluginSync(id, v); this.display(); }));
      // First-contact direction appears only when synced AND a divergence is possible — installed here on a
      // read-write vault. A not-installed plugin can only download (pull+install); a read-only vault too.
      if (on && !here) st.setDesc("downloads from the sync (not installed here yet)");
      else if (on && ro) st.setDesc("download only (read-only vault)");
      else if (on) {
        // Already-synced + installed on a read-write vault: the old "first-contact direction" dropdown was
        // INERT here (it only governed a no-base first contact), so it's replaced by the actions that
        // actually DO something now — Push this device's copy to the server, or Pull the server's copy here.
        // Each is a confirmed authoritative overwrite of THIS plugin's files (issuePluginDirectionInert),
        // fronted by a per-file PREVIEW (nPushPullPreview). The buttons GREY OUT when the folder is already in
        // sync (both would be no-ops) — computed instantly + network-free from the last-synced base, with the
        // fresh accurate preview run only on click. `act` runs the shared preview→confirm→apply flow.
        let pushB: ExtraButtonComponent, pullB: ExtraButtonComponent;
        const act = async (dir: "push" | "pull") => {
          // HARD guard (owner-directed 2026-08-05, reversing the §1 hint): when converged there's no real
          // action, so block the click too — the convergence state refreshes within ~a second, so a genuinely-
          // concurrent remote edit is a brief wait, and in exchange a live button ALWAYS means a real overwrite
          // (never misleading). The rare out-of-band size+mtime-preserved divergence is an accepted residual
          // (already an auto-sync blindspot). setDisabled alone doesn't block a click on the extra-button el, so
          // this guard is what enforces the no-op.
          if (this.pluginCleanCache.get(id)) return;
          const preview = await this.plugin.pluginPushPullPreview(id, dir);
          if (!preview) return; // offline — the plugin already surfaced a notice
          if (!(await pushPreviewModal(this.app, preview))) return; // (shows "nothing to change" for a true no-op)
          this.pluginCleanCache.delete(id); // the overwrite changed convergence — re-check on the next render
          await (dir === "push" ? this.plugin.pushPlugin(id) : this.plugin.pullPlugin(id));
          this.display();
        };
        st.addExtraButton((b) => { pushB = b; b.setIcon("upload").setTooltip("Push this device's copy to the server").onClick(() => void act("push")); });
        st.addExtraButton((b) => { pullB = b; b.setIcon("download").setTooltip("Pull the server's copy to this device").onClick(() => void act("pull")); });
        const applyClean = (clean: boolean) => {
          // DISABLE when there's no real action (owner-directed). setDisabled only GREYS an extra-button (it's
          // a div/anchor, not a native <button>) — it does NOT block the click — so also set pointer-events:none
          // to make it genuinely UNCLICKABLE (no click, no hover, not-allowed cursor), not just a guarded no-op.
          // The act() guard stays as defense-in-depth.
          pushB.setDisabled(clean); pullB.setDisabled(clean);
          pushB.extraSettingsEl.style.pointerEvents = clean ? "none" : "";
          pullB.extraSettingsEl.style.pointerEvents = clean ? "none" : "";
          pushB.setTooltip(clean ? "Already in sync — nothing to push" : "Push this device's copy to the server");
          pullB.setTooltip(clean ? "Already in sync — nothing to pull" : "Pull the server's copy to this device");
        };
        const cachedClean = this.pluginCleanCache.get(id);
        if (cachedClean !== undefined) applyClean(cachedClean); // instant (no flicker) on a re-render
        void this.plugin.pluginSyncClean(id).then((clean) => { this.pluginCleanCache.set(id, clean); applyClean(clean); });
      }
      // NB: no per-plugin "Remove from server" button (issuePluginRemoveButtonClutter) — it took a whole
      // button per row for a RARE need. Removing a plugin's files from the server is an owner/admin task,
      // done from the admin interface; the client keeps `removePluginFromServer` (tested) for that path, just
      // not as per-row UI clutter.
    }
  }
}
