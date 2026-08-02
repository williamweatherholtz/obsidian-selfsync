// Pure decisions the connect effect (main.ts `doConnect`) makes — extracted as TOTAL functions of their
// inputs (functional-core / imperative-shell, per the D0036 functional-decoupling process). `doConnect` is
// the imperative shell: it gathers the live state (health, settings, base) and applies the effects; these
// are the decision cores it was making inline, now testable in isolation instead of only through a
// full-connect integration test. No `this`, no I/O — same inputs, same answer, every time.

// Protocol version compatibility. R12-PB2: fail CLOSED — an unknown/absent server apiVersion means we can't
// confirm compatibility, so it is a mismatch (never a silent "assume ok"). `serverLabel` is the human string
// doConnect shows for the server's version.
export type VersionVerdict = { ok: true } | { ok: false; serverLabel: string };
export function versionVerdict(serverApiVersion: number | undefined, clientApiVersion: number): VersionVerdict {
  if (serverApiVersion === clientApiVersion) return { ok: true };
  return { ok: false, serverLabel: serverApiVersion === undefined ? "an unknown version" : `v${serverApiVersion}` };
}

// D0047 vault-change guard (fix ③): does the persisted base key belong to a DIFFERENT vault than the one we
// are about to sync? A NEW server-qualified key (`host|owner/vault`, contains `|`) is compared in full; an
// OLD server-blind key (no `|`) is GRANDFATHERED — compared only on owner/vault, so an upgrade doesn't force
// a spurious merge, while a genuine server / vault / owner change still trips. `currentKey` = the
// server-qualified identity of the vault being synced; `historyKey` = its server-blind owner/vault form.
export function vaultKeyMismatch(storedKey: string, currentKey: string, historyKey: string): boolean {
  return storedKey.includes("|") ? storedKey !== currentKey : storedKey !== historyKey;
}

// A persisted vault switch has ALREADY taken effect iff the base already belongs to the target vault (and is
// non-empty). Re-running an already-applied AUTHORITATIVE switch (download=take-remote / upload=take-local)
// would re-clobber local edits made since; doConnect clears it and reconciles normally instead. A
// not-yet-applied switch (base still the OLD vault) is NOT "already applied", so it still replays (R12-CA1).
export function switchAlreadyApplied(pendingSwitch: string | undefined, baseVaultKey: string | undefined, currentKey: string, baseNonEmpty: boolean): boolean {
  return !!pendingSwitch && baseVaultKey === currentKey && baseNonEmpty;
}
