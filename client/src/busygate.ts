import type { ButtonComponent } from "obsidian";

// BUSY STATE, surfaced where it gates a function (owner, 2026-09-07: "this state should be tracked and indicated
// somewhere... grey out some options until actually ready, along with an indication as to why").
//
// While a sync pass runs, file reads and writes queue behind the reconcile's own — on a large vault a modal
// opened mid-pass sat on its placeholder for minutes and read as broken. The state itself is a PURE
// PROJECTION owned by the plugin (busyState(): engine phase + live connect stage — never a stored flag);
// this helper is the one way a surface shows it: a banner naming the reason, and the surface's COMMITTING
// buttons disabled until the plugin reports settled. Non-committing actions (copy, close) stay live.
export interface BusyState { busy: boolean; reason: string }
export interface BusySource {
  busyState(): BusyState;
  /** Subscribe to busy-state changes; returns the unsubscribe. */
  onBusyChange(fn: () => void): () => void;
}
export interface BusyGate { refresh(): void; dispose(): void }

/**
 * Mount a busy banner at the top of `container` and keep `buttons()` disabled while `src` is busy.
 * `buttons` is a thunk so a surface can register its buttons after mounting and call refresh().
 * `verb` names what is paused ("Resolving", "Switching vaults").
 */
export function mountBusyGate(src: BusySource, container: HTMLElement, buttons: () => ButtonComponent[], verb: string): BusyGate {
  const banner = container.createEl("div", { cls: "selfsync-busy-gate" });
  banner.setAttribute("style", "display:none;font-size:12px;margin:0 0 10px;padding:6px 8px;border-radius:6px;"
    + "background:rgba(255,170,0,.14);border:1px solid rgba(255,170,0,.35);");
  container.prepend(banner);
  const refresh = () => {
    const s = src.busyState();
    banner.textContent = s.busy
      ? `⏳ ${s.reason}. ${verb} is paused until it finishes — file reads queue behind the sync pass, and a choice must apply to a settled file.`
      : "";
    banner.style.display = s.busy ? "" : "none";
    for (const b of buttons()) b.setDisabled(s.busy);
  };
  const unsubscribe = src.onBusyChange(refresh);
  refresh();
  return { refresh, dispose: unsubscribe };
}
