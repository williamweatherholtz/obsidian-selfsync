// E3b (10): the new embedded wire signature is compatible with the pre-E2EE server signature in both
// directions. An old plugin against the new server sees additive deltas only (the keyring route and type
// are non-gating). The new plugin against an old server sees no breaking delta either: an old server is the
// 404 arm of the keyring table, never a wire refusal. The fixture is the signature committed before E2EE.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EMBEDDED_SIGNATURE } from "../../src/wiresignature";
import { signatureVerdict, validateSignature, isNonGatingEndpoint } from "../../src/wiresignature";

const PRE = validateSignature(JSON.parse(readFileSync(fileURLToPath(new URL("./wire-signature-pre-e2ee.json", import.meta.url)), "utf8")));

describe("E3b (10) the embedded signature against the pre-E2EE one", () => {
  it("is compatible in both directions", () => {
    expect(PRE.endpoints).not.toContain("GET /api/v/:vault/keyring");
    expect(EMBEDDED_SIGNATURE.endpoints).toContain("GET /api/v/:vault/keyring");
    expect(signatureVerdict(PRE, EMBEDDED_SIGNATURE)).toEqual({ ok: true });      // old plugin, new server
    expect(signatureVerdict(EMBEDDED_SIGNATURE, PRE)).toEqual({ ok: true });      // new plugin, old server
  });
  it("the keyring routes are non-gating on both families", () => {
    expect(isNonGatingEndpoint("GET /api/v/:vault/keyring")).toBe(true);
    expect(isNonGatingEndpoint("GET /api/u/:owner/:vault/keyring")).toBe(true);
  });
});
