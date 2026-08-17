// The composition-recipe IMPORT modal (nComposeRecipe) — thin Obsidian glue over the pure codec + planner in
// composition-recipe.ts. Paste a recipe → REVIEW each mount (accessible / no-access / already-here / your own
// vault), edit the local folder, keep direction fail-closed (Sync only where a read-write grant allows) → apply
// the ones you accept as YOUR OWN mounts. The reader is always in control: nothing is auto-applied, no config or
// credential from the sharer is imported, and a source you can't access is shown with guidance, never grabbed.
import { App, Modal, Notice, Setting } from "obsidian";
import { Mount, MountDirection, normMountFolder, validateMounts, validMounts } from "./mounts";
import { SharedVaultRef } from "./transport";
import { normalizeServer } from "./connstr";
import { parseCompositionRecipe, planRecipeImport, mountFromPlanItem, RecipePlanItem } from "./composition-recipe";

// What the modal needs from the plugin (structural interface, so this module never imports the plugin class).
export interface RecipeImportHost {
  settings: { username: string; serverUrl?: string; vaultId?: string; vaultOwner?: string; mounts?: Mount[] };
  listSharedVaults(): Promise<SharedVaultRef[]>;
  addMount(m: Mount): Promise<void>;
}

// A per-row editing cell for a `ready` plan item: the reader's chosen local folder + direction + checked state.
interface Row { item: RecipePlanItem; checked: boolean; mountPoint: string; direction: MountDirection; err: string | null; errEl?: HTMLElement }

export class RecipeImportModal extends Modal {
  private applied = 0;
  constructor(app: App, private host: RecipeImportHost, private onDone: () => void, private initial?: string) { super(app); }

  async onOpen(): Promise<void> {
    this.titleEl.setText("Import a composition recipe");
    if (this.initial && this.host.settings.username) { await this.review(this.initial); return; }
    this.paste();
  }

  // Step 1 — paste. A recipe is a copyable string someone sent you; you review before anything is applied.
  private paste(): void {
    const c = this.contentEl; c.empty();
    c.createEl("p", { text: "Paste a composition recipe someone shared with you. It lists which folders to bring in from which vaults — no logins or settings. You'll review each one before anything is added.", attr: { style: "font-size:13px;margin-bottom:10px;" } });
    if (!this.host.settings.username) {
      c.createEl("p", { text: "Sign in to your server first — importing a recipe needs your account to check which vaults you can access.", attr: { style: "font-size:13px;color:var(--text-error);" } });
      new Setting(c).addButton((b) => b.setButtonText("Close").onClick(() => this.close()));
      return;
    }
    let text = "";
    new Setting(c).setName("Recipe").setDesc("Starts with selfsync-recipe://")
      .addTextArea((t) => { t.setPlaceholder("selfsync-recipe://import?…").onChange((v) => { text = v; }); t.inputEl.rows = 3; t.inputEl.style.width = "100%"; });
    const errEl = c.createEl("p", { attr: { style: "font-size:12px;color:var(--text-error);min-height:1em;" } });
    new Setting(c)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) => b.setButtonText("Review recipe").setCta().onClick(() => { errEl.setText(""); void this.review(text).catch((e) => errEl.setText(e instanceof Error ? e.message : String(e))); }));
  }

  // Step 2 — review + apply. Parses (may throw, surfaced by the caller), fetches my grants, plans each entry.
  private async review(raw: string): Promise<void> {
    const parsed = parseCompositionRecipe(raw); // throws a human message on a bad/empty recipe
    const c = this.contentEl; c.empty();
    const loading = c.createEl("p", { text: "Checking which vaults you can access…", attr: { style: "font-size:13px;opacity:.75;" } });

    let grants: SharedVaultRef[] = [];
    let grantsUnknown = false;
    try { grants = await this.host.listSharedVaults(); }
    catch { grantsUnknown = true; /* offline: foreign sources plan as non-writable/no-access (safe — never a false "ready"), but say WHY it's unavailable rather than "ask them to share it" */ }
    loading.remove();
    if (grantsUnknown) c.createEl("p", { text: "⚠ Couldn't check which vaults you can access — you may be offline. Shared sources are shown as unavailable until you reconnect and reopen this recipe.", attr: { style: "font-size:12px;color:var(--text-warning);margin:0 0 8px;" } });

    const myServer = this.host.settings.serverUrl ? normalizeServer(this.host.settings.serverUrl) : "";
    const plan = planRecipeImport(parsed.mounts, {
      myAccount: this.host.settings.username,
      primary: { owner: this.host.settings.vaultOwner ?? "", vaultId: this.host.settings.vaultId ?? "" },
      grants: grants.map((g) => ({ owner: g.owner, vault: g.vault, perm: g.perm })),
      existingMounts: this.host.settings.mounts ?? [],
    });

    if (parsed.server && myServer && parsed.server !== myServer) {
      c.createEl("p", { text: `⚠ This recipe was made for ${parsed.server}, but you're signed in to ${myServer}. The vaults it names likely don't exist here — sources you can't access are marked below.`, attr: { style: "font-size:12px;color:var(--text-warning);margin:0 0 8px;" } });
    }

    // Ready rows first so the applicable set is scannable even in a big recipe with many skipped entries (L1).
    const ordered = [...plan].sort((a, b) => (a.status === "ready" ? 0 : 1) - (b.status === "ready" ? 0 : 1));
    const rows: Row[] = ordered.map((item) => ({ item, checked: item.status === "ready", mountPoint: item.recipe.mountPoint, direction: item.suggestedDirection, err: null }));
    const readyCount = rows.filter((r) => r.item.status === "ready").length;
    if (!readyCount) c.createEl("p", { text: "None of these mounts can be added right now (see the reasons below).", attr: { style: "font-size:13px;color:var(--text-muted);margin:0 0 8px;" } });

    let importBtn: import("obsidian").ButtonComponent;
    // Recompute the per-row error for every CHECKED ready row against the existing mounts + the OTHER checked
    // rows, using the shared validateMounts rules — so two accepted rows that collide, or one that nests inside
    // an existing mount, are caught before apply. Disables Import while any checked row is invalid.
    const revalidate = () => {
      // Validate against the IN-EFFECT set (validMounts), so a pre-existing inactive/invalid mount can't poison
      // an otherwise-valid new row's check and falsely block the import (critique C3).
      const existing = validMounts(this.host.settings.mounts ?? []);
      for (const r of rows) {
        if (r.item.status !== "ready" || !r.checked) { r.err = null; continue; }
        const others = rows.filter((o) => o !== r && o.item.status === "ready" && o.checked)
          .map((o) => mountFromPlanItem(o.item, o.mountPoint, o.direction));
        const mine = mountFromPlanItem(r.item, r.mountPoint, r.direction);
        r.err = !normMountFolder(r.mountPoint) ? "Enter a local folder." : (validateMounts([...existing, ...others, mine])[0] ?? null);
      }
      for (const r of rows) r.errEl?.setText(r.err ?? "");
      const anyChecked = rows.some((r) => r.item.status === "ready" && r.checked);
      const anyErr = rows.some((r) => r.item.status === "ready" && r.checked && r.err);
      importBtn?.setButtonText(`Import ${rows.filter((r) => r.item.status === "ready" && r.checked).length} mount(s)`);
      importBtn?.setDisabled(!anyChecked || anyErr);
    };

    for (const r of rows) {
      const item = r.item;
      const src = item.recipe.source.owner ? `${item.recipe.source.owner}/${item.recipe.source.vaultId}` : item.recipe.source.vaultId;
      const sub = item.recipe.source.sourcePath ? `/${item.recipe.source.sourcePath}` : " (whole vault)";
      if (item.status !== "ready") {
        const why = item.status === "noAccess"
          ? (grantsUnknown ? `couldn't verify access to ${src} — reconnect and try again` : `you don't have access to ${src} — ask them to share it, then import again`)
          : item.status === "selfPrimary" ? "this is the vault you're currently syncing — it can't be mounted into itself"
          : "already mounted here";
        new Setting(this.contentEl).setName(`${src}${sub}`).setDesc(`Skipped — ${why}`).setClass("selfsync-recipe-skip")
          .then((s) => s.settingEl.style.opacity = "0.6");
        continue;
      }
      const foreign = item.localSource.owner !== ""; // a source shared BY someone else — Sync writes are visible to them
      const row = new Setting(this.contentEl).setName(`${src}${sub}`)
        .setDesc("Local folder — this folder stops syncing to your primary vault; existing files here merge with the source (a file that differs on both sides is kept as a conflict copy, never overwritten).");
      row.addToggle((t) => t.setValue(r.checked).onChange((v) => { r.checked = v; revalidate(); }));
      row.addText((t) => t.setPlaceholder("Local folder").setValue(r.mountPoint).onChange((v) => { r.mountPoint = v; revalidate(); }));
      const warnEl = this.contentEl.createEl("p", { attr: { style: "font-size:12px;color:var(--text-warning);min-height:1em;margin:-6px 0 6px;" } });
      // Honest destination warning (S2/H1), matching MountEditModal: a two-way Sync into a SHARED source uploads
      // your local edits there for everyone with access to see. Foreign rows default to Pull; this fires only if
      // the reader opts up to Sync.
      const paintWarn = () => warnEl.setText(r.direction === "sync" && foreign ? `⚠ Sync uploads your changes in this folder to ${src}, where anyone with access can see them.` : "");
      // Direction: Sync offered ONLY where the grant makes the source writable; otherwise fixed Pull (read-only).
      row.addDropdown((dd) => {
        dd.addOption("pull", "Pull (read-only)");
        if (item.writable) dd.addOption("sync", "Sync (two-way)");
        dd.setValue(r.direction).onChange((v) => { r.direction = v === "sync" ? "sync" : "pull"; paintWarn(); });
      });
      r.errEl = this.contentEl.createEl("p", { attr: { style: "font-size:12px;color:var(--text-error);min-height:1em;margin:-6px 0 6px;" } });
      paintWarn();
    }

    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) => { importBtn = b; b.setCta().onClick(async () => {
        const todo = rows.filter((r) => r.item.status === "ready" && r.checked && !r.err);
        if (!todo.length) return;
        b.setDisabled(true);
        for (const r of todo) {
          try { await this.host.addMount(mountFromPlanItem(r.item, r.mountPoint, r.direction)); this.applied++; }
          catch (e) { new Notice(`SelfSync: couldn't add ${r.mountPoint} — ${e instanceof Error ? e.message : String(e)}`); }
        }
        new Notice(this.applied ? `SelfSync: added ${this.applied} mount(s) from the recipe` : "SelfSync: no mounts were added");
        // Keep the modal open if NOTHING applied (every addMount failed), so the reviewed folders/selections
        // aren't discarded and the reader can retry after fixing the cause (L2). Otherwise close (onDone fires).
        if (this.applied > 0) this.close(); else b.setDisabled(false);
      }); });
    revalidate();
  }

  onClose(): void { this.contentEl.empty(); if (this.applied > 0) this.onDone(); }
}
