// Phase 4 of composed vaults (D0039): the mount-management UX — the pure helpers (source-vault options,
// draft validation, human labels) + the add-mount modal. Split so the decision logic (which vaults can be a
// source, why Save is disabled, how a mount reads) is unit-testable without Obsidian, and the modal is thin
// glue. Human-factors driven: default PULL (safe), SYNC gated on write permission + an explicit warning, the
// primary vault excluded as a source, live validation feedback, data-only stated up front.
import { App, Modal, Setting } from "obsidian";
import { Mount, MountDirection, validateMounts, normMountFolder } from "./mounts";
import { MountState } from "./mountfsm";
import { SharedVaultRef } from "./transport";

// A candidate SOURCE vault for a mount: the vaults I own + the vaults shared TO me, EXCLUDING the primary
// (you can't mount a vault into itself). canWrite gates whether a bidirectional `sync` mount is offerable —
// a read-only share can only be pulled.
export interface SourceOption { owner: string; vaultId: string; label: string; canWrite: boolean }

export function sourceOptions(myVaults: readonly string[], shared: readonly SharedVaultRef[], primary: { owner: string; vaultId: string }): SourceOption[] {
  const isPrimary = (owner: string, vaultId: string) => owner === primary.owner && vaultId === primary.vaultId;
  const out: SourceOption[] = [];
  for (const v of myVaults) if (!isPrimary("", v)) out.push({ owner: "", vaultId: v, label: v, canWrite: true });
  for (const s of shared) if (!isPrimary(s.owner, s.vault)) out.push({ owner: s.owner, vaultId: s.vault, label: `${s.owner}/${s.vault}`, canWrite: s.perm === "readWrite" });
  return out;
}

// One-line human label for a configured mount: "source[/subfolder]  →  local folder".
export function mountRowLabel(m: Mount): string {
  const src = m.source.owner ? `${m.source.owner}/${m.source.vaultId}` : m.source.vaultId;
  const sub = m.source.sourcePath ? `/${m.source.sourcePath}` : " (whole vault)";
  return `${src}${sub}  →  ${m.mountPoint}`;
}

// Human label for a mount's live state (the per-mount status shown in the section).
export function mountStateLabel(s: MountState): string {
  switch (s) {
    case "detached":   return "Not started";
    case "mounting":   return "Connecting…";
    case "live":       return "In sync";
    case "syncing":    return "Syncing…";
    case "diverged":   return "Needs review";
    case "offline":    return "Offline — will retry";
    case "unmounting": return "Removing…";
    case "failed":     return "Failed — can't reach the source";
  }
}

// Validate a DRAFT mount against the rest of the set. Returns the reason Save must stay disabled, or null when
// the draft is a valid addition. (Write-permission gating of `sync` is enforced by the modal's controls, not
// here — this is the structural validity: a source is picked, the local folder is real, no overlap.)
export function validateMountDraft(draft: Mount, others: readonly Mount[]): string | null {
  if (!draft.source.vaultId) return "Pick a source vault.";
  if (!normMountFolder(draft.mountPoint)) return "Enter a local folder (it can't be blank or the vault root).";
  const errs = validateMounts([...others, draft]);
  return errs.length ? errs[0] : null;
}

// What the modal needs from the plugin (a structural interface, so this module never imports the plugin class
// — no import cycle). The real plugin satisfies it.
export interface MountHost {
  settings: { vaultId?: string; vaultOwner?: string; mounts?: Mount[] };
  currentVaults(): Promise<string[]>;         // the vaults I own
  listSharedVaults(): Promise<SharedVaultRef[]>; // vaults shared TO me
  addMount(m: Mount): Promise<void>;
}

// The add-mount modal. Fetches the candidate sources on open, then a live-validated form. Default PULL; SYNC
// only when the source is writable and only behind a plain-language warning that it writes to the source.
export class MountEditModal extends Modal {
  private saved = false;
  constructor(app: App, private host: MountHost, private onDone: () => void) { super(app); }

  async onOpen(): Promise<void> {
    this.titleEl.setText("Add a composed mount");
    const c = this.contentEl; c.empty();
    c.createEl("p", { text: "Bring a folder from another vault into this one so its notes live alongside yours. Only notes and attachments sync — never plugin or app settings." }).setAttribute("style", "font-size:13px;margin-bottom:10px;");
    const loading = c.createEl("p", { text: "Loading your vaults…", attr: { style: "font-size:13px;opacity:.75;" } });

    let opts: SourceOption[];
    try {
      const [mine, shared] = await Promise.all([this.host.currentVaults(), this.host.listSharedVaults()]);
      opts = sourceOptions(mine, shared, { owner: this.host.settings.vaultOwner ?? "", vaultId: this.host.settings.vaultId ?? "" });
    } catch {
      loading.setText("Couldn't load your vaults — check your connection and try again.");
      new Setting(c).addButton((b) => b.setButtonText("Close").onClick(() => this.close()));
      return;
    }
    loading.remove();
    if (!opts.length) {
      c.createEl("p", { text: "No other vaults are available to mount. Create another vault or get access to a shared one first.", attr: { style: "font-size:13px;" } });
      new Setting(c).addButton((b) => b.setButtonText("Close").onClick(() => this.close()));
      return;
    }

    const others = this.host.settings.mounts ?? [];
    let source = opts[0];
    let sourcePath = "";
    let mountPoint = "";
    let direction: MountDirection = "pull";

    // Sanitize the user-typed folders (trim stray spaces / trailing dots / backslashes) so what's SAVED matches
    // the real FS and can't silently mis-mount or leak to the primary (R3-M3/L2).
    const draft = (): Mount => ({ source: { owner: source.owner, vaultId: source.vaultId, sourcePath: normMountFolder(sourcePath) }, mountPoint: normMountFolder(mountPoint), direction });

    new Setting(c).setName("Source vault").setDesc("The vault to bring a folder from.")
      .addDropdown((dd) => {
        opts.forEach((o, i) => dd.addOption(String(i), o.canWrite ? o.label : `${o.label} (read-only)`));
        dd.setValue("0").onChange((v) => { source = opts[Number(v)]; if (!source.canWrite) direction = "pull"; paintDirection(); revalidate(); });
      });
    new Setting(c).setName("Source subfolder").setDesc("Which folder inside the source vault (blank = the whole vault).")
      .addText((t) => t.setPlaceholder("Projects/Shared").onChange((v) => { sourcePath = v; revalidate(); }));
    new Setting(c).setName("Local folder").setDesc("Where it appears in THIS vault. This folder stops syncing to your primary vault and is managed by the mount instead; any existing files here merge with the source (a file that differs on both sides is kept as a conflict copy, never overwritten).")
      .addText((t) => t.setPlaceholder("Work/ASI").onChange((v) => { mountPoint = v; revalidate(); }));

    const dirSetting = new Setting(c).setName("Direction");
    const dirNote = c.createEl("p", { attr: { style: "font-size:12px;margin:-6px 0 10px;" } });
    const paintDirection = () => {
      dirSetting.clear();
      dirSetting.setDesc(direction === "pull" ? "Pull — read the source into this vault. The source is never changed." : "Sync — changes flow both ways.");
      dirSetting.addDropdown((dd) => {
        dd.addOption("pull", "Pull (read-only)");
        if (source.canWrite) dd.addOption("sync", "Sync (two-way)");
        dd.setValue(direction).onChange((v) => { direction = v === "sync" ? "sync" : "pull"; paintDirection(); revalidate(); });
      });
      if (!source.canWrite) { dirNote.setText("This source is read-only to you, so only Pull is available."); dirNote.style.color = "var(--text-muted)"; }
      else if (direction === "sync") { dirNote.setText(`⚠ Changes you make in the local folder will be written to ${source.label} and seen by anyone with access to it.`); dirNote.style.color = "var(--text-warning)"; }
      else { dirNote.setText(""); }
    };

    const errEl = c.createEl("p", { attr: { style: "font-size:12px;color:var(--text-error);min-height:1em;" } });
    let addBtn: import("obsidian").ButtonComponent;
    const revalidate = () => { const err = validateMountDraft(draft(), others); errEl.setText(err ?? ""); addBtn?.setDisabled(!!err); };

    new Setting(c)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) => { addBtn = b; b.setButtonText("Add mount").setCta().onClick(async () => {
        if (this.saved) return; // R10-F4: in-flight guard — a fast double-click must not add the mount twice
        if (!source.canWrite) direction = "pull"; // U1 defense-in-depth: never persist a sync mount on a read-only source (belt-and-suspenders over the dropdown gating)
        const m = draft();
        if (validateMountDraft(m, others)) return; // guarded — button is disabled while invalid, this is belt-and-suspenders
        this.saved = true; addBtn.setDisabled(true); // claim the submit BEFORE the await so a second click no-ops
        try { await this.host.addMount(m); }
        catch (e) { this.saved = false; addBtn.setDisabled(false); throw e; } // persist failed → let the user retry (no spurious onDone: still not closed)
        this.close();
      }); });

    paintDirection();
    revalidate();
  }
  onClose(): void { this.contentEl.empty(); if (this.saved) this.onDone(); }
}
