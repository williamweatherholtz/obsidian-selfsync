// Pure logic behind the setup wizard + the settings status card. No Obsidian API,
// so it is fully unit-testable; SetupWizardModal / the settings tab render over it.

// Mirrors the server's safe_name: letters/numbers/.-_ , 1–64 chars, not "."/"..".
// Validated client-side so a bad new-vault name gets a clear message, not a raw 400.
// Normalize a user-typed vault name to what the server accepts: trimmed + lowercased (vault names are
// directories, so — like usernames — they're lowercase-canonical to avoid case-collisions on
// case-insensitive filesystems). "Testbrsin" → "testbrsin".
export function sanitizeVaultName(name: string): string {
  return name.trim().toLowerCase();
}

// Must match the server's safe_name rule EXACTLY (lowercase only) so a name that passes here never
// 400s server-side. Callers sanitizeVaultName() first, so uppercase input is already lowercased.
export function isValidVaultName(name: string): boolean {
  return /^[a-z0-9._-]{1,64}$/.test(name) && name !== "." && name !== "..";
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

// What the wizard's "Start syncing" persists into settings. Extracted as a pure function so the
// token-only-at-rest rule is unit-tested (real behavior), not buried in the modal's finish():
// with a session token already in hand, the plaintext password is written ONLY if the user opted
// into storing it — otherwise it must never touch data.json (default token-only).
export interface PersistedCredentials { serverUrl: string; username: string; password: string; vaultId: string; authToken: string; }
export function wizardCredentials(s: WizardState, vault: string, token: string, storePassword: boolean): PersistedCredentials {
  return {
    serverUrl: s.server,
    username: s.username,
    password: storePassword ? s.password : "",
    vaultId: vault,
    authToken: token,
  };
}
