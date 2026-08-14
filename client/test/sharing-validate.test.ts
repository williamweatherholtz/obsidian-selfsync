import { describe, it, expect } from "vitest";
import {
  validateSharedVaults,
  validateVaultShares,
  validateShareLinks,
  validateRedeemedVault,
  validateRedeemedRegister,
} from "../src/transport";

// PROTO-3 (F5, issueSharingResponseTypesUncovered): the sharing responses the client consumes were
// `as`-cast straight from the wire into the vault-switcher + share UI. Validate them like the sync
// responses — a malformed/hostile body must throw, never reach the UI as a falsely-typed value.
describe("sharing response-shape validation (F5)", () => {
  describe("validateSharedVaults (/api/shared)", () => {
    const good = [{ owner: "alice", vault: "notes", perm: "read" }, { owner: "bob", vault: "work", perm: "readWrite" }];

    it("accepts a well-formed list and CONSTRUCTS fresh values (drops extras)", () => {
      expect(validateSharedVaults(good)).toEqual(good);
      expect(validateSharedVaults([{ ...good[0], evil: "x" }])[0]).not.toHaveProperty("evil");
      expect(validateSharedVaults([])).toEqual([]);
    });

    it("rejects a non-array or a missing string field; an unknown perm fails CLOSED to read (issueWirePermVariantBlindSpot)", () => {
      expect(() => validateSharedVaults({})).toThrow(/not an array/);
      expect(validateSharedVaults([{ owner: "a", vault: "v", perm: "admin" }])[0].perm).toBe("read"); // unknown/future variant → least-privilege read, not a whole-list throw
      expect(validateSharedVaults([{ owner: "a", vault: "v" }])[0].perm).toBe("read");                 // missing perm → read
      expect(() => validateSharedVaults([{ owner: 1, vault: "v", perm: "read" }])).toThrow(/owner/);   // a non-string owner still rejects (identity fields stay strict)
    });
  });

  describe("validateVaultShares (/api/admin/vaults)", () => {
    // The server also sends status/last_used; the client reads only vault + grants, so they're dropped.
    const wire = [{ vault: "notes", grants: [{ grantee: "bob", perm: "readWrite" }], status: "ready", last_used: 123 }];

    it("accepts well-formed shares, keeping only vault + grants", () => {
      expect(validateVaultShares(wire)).toEqual([{ vault: "notes", grants: [{ grantee: "bob", perm: "readWrite" }] }]);
    });

    it("rejects a non-array grants or a missing grantee; an unknown grant perm fails closed to read", () => {
      expect(() => validateVaultShares([{ vault: "v", grants: "nope" }])).toThrow(/grants/);
      expect(validateVaultShares([{ vault: "v", grants: [{ grantee: "b", perm: "x" }] }])[0].grants[0].perm).toBe("read"); // unknown perm → read
      expect(() => validateVaultShares([{ vault: "v", grants: [{ perm: "read" }] }])).toThrow(/grantee/);
    });
  });

  describe("validateShareLinks (/api/share-links)", () => {
    const good = [{ id: "L1", vault: "notes", perm: "read", label: "phone", expires_at: 1700, redeemed_by: null }];

    it("accepts a link with expires_at/redeemed_by present or null", () => {
      expect(validateShareLinks(good)).toEqual(good);
      expect(validateShareLinks([{ id: "L2", vault: "v", perm: "readWrite", label: "", expires_at: null, redeemed_by: "carol" }])).toEqual(
        [{ id: "L2", vault: "v", perm: "readWrite", label: "", expires_at: null, redeemed_by: "carol" }],
      );
    });

    it("rejects a bad optional type or a missing required field", () => {
      expect(() => validateShareLinks([{ ...good[0], expires_at: "soon" }])).toThrow(/expires_at/);
      expect(() => validateShareLinks([{ ...good[0], redeemed_by: 7 }])).toThrow(/redeemed_by/);
      expect(() => validateShareLinks([{ ...good[0], label: undefined }])).toThrow(/label/);
    });
  });

  describe("redeem single-object validators", () => {
    it("validateRedeemedVault accepts a ref; a non-string owner rejects, an unknown perm fails closed to read", () => {
      expect(validateRedeemedVault({ owner: "a", vault: "v", perm: "read" })).toEqual({ owner: "a", vault: "v", perm: "read" });
      expect(validateRedeemedVault({ owner: "a", vault: "v", perm: "nope" }).perm).toBe("read"); // unknown perm → read (graceful)
      expect(() => validateRedeemedVault({ owner: 1, vault: "v", perm: "read" })).toThrow(/owner/);
    });
    it("validateRedeemedRegister carries the session token through", () => {
      expect(validateRedeemedRegister({ owner: "a", vault: "v", perm: "readWrite", token: "T" })).toEqual(
        { owner: "a", vault: "v", perm: "readWrite", token: "T" },
      );
      expect(() => validateRedeemedRegister({ owner: "a", vault: "v", perm: "read" })).toThrow(/token/);
    });
  });
});
