import type { ButtonComponent } from "obsidian";

// BUSY STATE, shown where it gates a function — on the button itself (owner, 2026-09-07: "show don't tell.
// just disable the resolve button and change the text to 'analyzing files...'").
//
// While a sync pass runs, file reads and writes queue behind the reconcile's own — on a large vault a modal
// opened mid-pass sat on its placeholder for minutes and read as broken. The state is a PURE PROJECTION owned
// by the plugin (busyState(): engine phase + live connect stage — never a stored flag). This helper is the one
// way a surface shows it: each COMMITTING button is disabled and wears the short state label ("Analyzing
// files…") until the plugin reports settled, when its own label comes back. The fuller reason rides the native
// tooltip. No banner, no prose. Non-committing actions (copy, close) are never gated.
export interface BusyState {
  busy: boolean;
  /** The short label a gated button wears while busy, e.g. "Analyzing files…". */
  label: string;
  /** The fuller reason, for the tooltip, e.g. "SelfSync is connecting — checked 750/1420 files for changes". */
  reason: string;
}
export interface BusySource {
  busyState(): BusyState;
  /** Subscribe to busy-state changes; returns the unsubscribe. */
  onBusyChange(fn: () => void): () => void;
}
export interface BusyGate { refresh(): void; dispose(): void }

/**
 * Keep `buttons()` reflecting `src`'s busy state: disabled + state label while busy, their own label when not.
 * `buttons` is a thunk so a surface can register buttons after mounting and call refresh().
 */
export function gateButtons(src: BusySource, buttons: () => ButtonComponent[]): BusyGate {
  const ownLabel = new WeakMap<ButtonComponent, string>(); // each button's real label, captured the first time it is gated
  const refresh = () => {
    const s = src.busyState();
    for (const b of buttons()) {
      if (!ownLabel.has(b)) ownLabel.set(b, b.buttonEl.textContent ?? "");
      if (s.busy) {
        b.setDisabled(true).setButtonText(s.label);
        b.buttonEl.title = s.reason;
      } else {
        b.setDisabled(false).setButtonText(ownLabel.get(b) ?? "");
        b.buttonEl.removeAttribute("title");
      }
    }
  };
  const unsubscribe = src.onBusyChange(refresh);
  refresh();
  return { refresh, dispose: unsubscribe };
}
