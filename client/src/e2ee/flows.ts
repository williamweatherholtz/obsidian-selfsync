// The pure rules behind the E2EE dialogs (E3b, D0106 to D0111, spec sections 4.4, 4.9 and 6). No
// Obsidian API here, so every rule is unit-tested as a rule; the modals and cards render over them.
import { parseKeyring, type KeyringOutcome } from "./keyring";

/** The password floor (D0111): a length, not an entropy bound, and the spec says so. */
export const PASSWORD_FLOOR = 12;
export const LOST_PASSWORD_WARNING =
  "There is no recovery. If this password is lost, the vault's content is lost with it. SelfSync never stores it and cannot reset it.";

/** The first tagged release whose server stamps schema 4 and serves GET keyring. */
export const MIN_E2EE_SERVER_VERSION = "1.33.0";

/** Null when the pair is acceptable, else the problem to show. The login password is never the encryption password. */
export function passwordProblem(password: string, confirm: string, loginPassword: string): string | null {
  if (password.length < PASSWORD_FLOOR) return `The encryption password must be at least ${PASSWORD_FLOOR} characters.`;
  if (password !== confirm) return "The two entries do not match.";
  if (loginPassword && password === loginPassword) return "The encryption password must differ from your login password.";
  return null;
}

export type KeyringAnswer = { found: true; text: string } | { found: false };

/**
 * The 409 rule of spec section 6, for the PLUGIN's create dialog. A 200 on GET keyring means an encrypted
 * vault holds this name: join only. A 404 with the keyring route in the server's FRESH signature means a
 * plaintext vault holds it. That is a delete not complete yet, or a device that re-created it, so the
 * dialog offers the delete behind the warnings. A 404 without the route is an old server: name the
 * minimum version, offer nothing.
 */
export type CreateConflictDecision =
  | { kind: "join" }
  | { kind: "delete" }
  | { kind: "upgradeServer"; minVersion: string };
export function createConflictDecision(keyring: KeyringAnswer, signatureListsKeyring: boolean): CreateConflictDecision {
  if (keyring.found) return { kind: "join" };
  return signatureListsKeyring ? { kind: "delete" } : { kind: "upgradeServer", minVersion: MIN_E2EE_SERVER_VERSION };
}

/**
 * The post-create check (D0102, spec section 4.4). The client reads GET keyring after POST and pins only
 * when the returned vault_id is the one it sent. A 404 is an old server that created plaintext. The caller
 * then deletes the vault it just created, discards VK and names the version. Another id, or a record that
 * does not parse, fails closed and deletes nothing.
 */
export type PostCreateCheck = { kind: "ok" } | { kind: "oldServer"; minVersion: string } | { kind: "mismatch" };
export function postCreateCheck(sentVaultId: string, keyring: KeyringAnswer): PostCreateCheck {
  if (!keyring.found) return { kind: "oldServer", minVersion: MIN_E2EE_SERVER_VERSION };
  try {
    return parseKeyring(keyring.text).vault_id === sentVaultId ? { kind: "ok" } : { kind: "mismatch" };
  } catch {
    return { kind: "mismatch" };
  }
}

/** The join outcome wording (D0106): three outcomes told apart before any content is read. */
export function joinOutcomeText(outcome: KeyringOutcome): string {
  switch (outcome) {
    case "wrongPassword": return "Wrong password. Enter the vault's encryption password, not your login password.";
    case "unsupported": return "This vault's key record uses KDF parameters this plugin does not support. Update the plugin, or ask the owner.";
    case "corrupt": return "This vault's key record is corrupt on the server. Ask the owner to restore .keyring.json from a backup.";
  }
}

/** The reason every define-off surface shows (spec section 4.9). */
export const UNSUPPORTED_BUILD_TEXT = "This plugin build does not support encrypted vaults. Update the plugin.";

/** The residue and re-share warning every delete path carries (D0109, spec section 6). */
export const DELETE_VAULT_WARNING =
  "The server copy is deleted, not scrubbed: earlier operator backups still hold it. Every share grant and share link for this vault is purged, so re-share with each collaborator afterwards. Your local files are kept.";

/** The migration route, one order everywhere (D0109). */
export const MIGRATION_ROUTE =
  "To encrypt an existing vault: from the device that holds its content, delete the old vault on the server, create the encrypted vault under the same name, then switch to it.";
