// Pure logic behind the setup wizard + the settings status card. No Obsidian API,
// so it is fully unit-testable; SetupWizardModal / the settings tab render over it.
import { Phase } from "./syncstate";

// Mirrors the server's safe_name: letters/numbers/.-_ , 1–64 chars, not "."/"..".
// Validated client-side so a bad new-vault name gets a clear message, not a raw 400.
export function isValidVaultName(name: string): boolean {
  return /^[A-Za-z0-9._-]{1,64}$/.test(name) && name !== "." && name !== "..";
}

export interface WizardState {
  server: string;
  serverOk: boolean;          // set true once "Test connection" succeeds (or login proves reachability)
  mode: "login" | "register";
  username: string;
  password: string;
  loggedIn: boolean;          // set true once login/register succeeds
  vaults: string[];           // fetched after login
  chosenVault: string;        // an existing vault
  newVault: string;           // a to-be-created vault name
}

// The single-pane wizard has no step machine — it enables two actions as their inputs fill in:
// "Log in" once the server + credentials are present, and "Start syncing" once logged in with a
// vault chosen or named.
export function canLogIn(s: WizardState): boolean {
  return Boolean(s.server && s.username && s.password);
}

export function canFinish(s: WizardState): boolean {
  return s.loggedIn && Boolean(s.chosenVault || s.newVault.trim());
}

// The status-card headline for a connection phase. Identity (account, remote vault)
// and last-synced live under the Connection section, NOT the card — so this is just
// the state title. The unconfigured "Not set up" case is handled by the renderer.
export function statusTitle(phase: Phase): string {
  switch (phase) {
    case "off":        return "Not connected";
    case "connecting": return "Connecting…";
    case "syncing":    return "Syncing…";
    case "idle":       return "Fully synced";
    case "offline":    return "Offline — retrying";
  }
}
