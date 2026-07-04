// Pure logic behind the setup wizard + the settings status card. No Obsidian API,
// so it is fully unit-testable; SetupWizardModal / the settings tab render over it.
import { Phase } from "./syncstate";

export type WizardStep = "welcome" | "server" | "account" | "vault" | "done";

// Mirrors the server's safe_name: letters/numbers/.-_ , 1–64 chars, not "."/"..".
// Validated client-side so a bad new-vault name gets a clear message, not a raw 400.
export function isValidVaultName(name: string): boolean {
  return /^[A-Za-z0-9._-]{1,64}$/.test(name) && name !== "." && name !== "..";
}

export interface WizardState {
  server: string;
  serverOk: boolean;          // set true once "Test connection" succeeds
  mode: "login" | "register";
  username: string;
  password: string;
  loggedIn: boolean;          // set true once login/register succeeds
  vaults: string[];           // fetched after login
  chosenVault: string;        // an existing vault
  newVault: string;           // a to-be-created vault name
}

export function canAdvance(step: WizardStep, s: WizardState): boolean {
  switch (step) {
    case "welcome": return true;
    case "server": return s.serverOk;
    case "account": return s.loggedIn;
    case "vault": return Boolean(s.chosenVault || s.newVault.trim());
    case "done": return true;
  }
}

// A setup link prefills server + username and validates them, so we skip the server
// step and land on account (password only).
export function nextStep(step: WizardStep, opts?: { haveLink?: boolean }): WizardStep {
  switch (step) {
    case "welcome": return opts?.haveLink ? "account" : "server";
    case "server": return "account";
    case "account": return "vault";
    case "vault": return "done";
    case "done": return "done";
  }
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
