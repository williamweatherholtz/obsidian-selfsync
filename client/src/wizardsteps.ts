// Pure logic behind the setup wizard + the settings status card. No Obsidian API,
// so it is fully unit-testable; SetupWizardModal / the settings tab render over it.
import { Phase } from "./syncstate";

export type WizardStep = "welcome" | "server" | "account" | "vault" | "done";

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

export interface StatusLineInput { user?: string; vault?: string; lastSyncedLabel?: string; }
export interface StatusLines { title: string; detail: string; }

const NOT_SET_UP: StatusLines = { title: "Not set up", detail: "Sync your notes to your own server." };

export function statusLine(phase: Phase, i: StatusLineInput): StatusLines {
  const configured = Boolean(i.user && i.vault);
  if (!configured || phase === "off") return NOT_SET_UP;
  const who = `Signed in as ${i.user} · Remote vault '${i.vault}'`;
  switch (phase) {
    case "connecting": return { title: "Connecting…", detail: who };
    case "syncing":    return { title: "Syncing…", detail: who };
    case "offline":    return { title: "Offline — retrying", detail: who };
    case "idle":       return { title: "Fully synced", detail: who + (i.lastSyncedLabel ? ` · ${i.lastSyncedLabel}` : "") };
    default:           return NOT_SET_UP;
  }
}
