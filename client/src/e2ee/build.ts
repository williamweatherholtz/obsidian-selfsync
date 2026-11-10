// The SELFSYNC_E2EE build define (D0112, spec section 4.9). esbuild.config.mjs replaces the identifier with
// a committed literal, so a release cut before the owner accepts the KDF default Decision compiles the E2EE
// entry points out. The build script refuses a true literal with no accepted Decision that depends on d0112
// and states the shipped cost. Four surfaces read this and block with E2eeUnsupportedBuild when it is off:
// an unpinned 200 on GET keyring, an e2ee=1 link, the changed-keyring card and the missing-keyring dialog.
// A pinned device syncs regardless of it. In vitest the identifier is undeclared, so the entries are ON.
declare const SELFSYNC_E2EE: boolean | undefined;

let testOverride: boolean | undefined;

export function e2eeBuildEnabled(): boolean {
  if (testOverride !== undefined) return testOverride;
  try { return typeof SELFSYNC_E2EE === "boolean" ? SELFSYNC_E2EE : true; } catch { return true; }
}

/** Tests only: force the define on or off for one scenario. Pass undefined to restore. */
export function setE2eeBuildEnabledForTests(on: boolean | undefined): void { testOverride = on; }

export const UNSUPPORTED_BUILD_REASON = "this plugin build does not support encrypted vaults";
