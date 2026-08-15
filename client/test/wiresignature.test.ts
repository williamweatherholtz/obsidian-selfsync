import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  Signature, EMBEDDED_SIGNATURE, TYPE_ROLES, NON_GATING_TYPES, hashCheck, diffSignature, signatureVerdict,
  validateSignature, validateSchemaResponse, incompatibleMessage, FAIL_CLOSED_MESSAGE,
} from "../src/wiresignature";
import clientArtifact from "../src/wire-signature.json";

// D0042 wire-contract compatibility. StatusResponse is a RESPONSE type (client reads); CommitRequest is a
// REQUEST type (client sends) — the two directions the diff classifies differently.
const base: Signature = {
  version: 1,
  api_version: 1,
  endpoints: ["GET /a", "GET /b"],
  types: {
    StatusResponse: [{ name: "status", type: "string", required: true }, { name: "detail", type: "string", required: false }],
    CommitRequest: [{ name: "path", type: "string", required: true }],
  },
};
const clone = (s: Signature): Signature => JSON.parse(JSON.stringify(s));

describe("hashCheck — the cheap per-poll gate (fail-closed)", () => {
  it("no server hash → fail CLOSED (older server / stripped field)", () => {
    expect(hashCheck(undefined, "sha256:x").kind).toBe("failClosed");
    expect(hashCheck("", "sha256:x").kind).toBe("failClosed");
  });
  it("server hash equals a hash verified this session → compatible (cheap)", () => {
    expect(hashCheck("sha256:abc", "sha256:abc").kind).toBe("compatible");
  });
  it("unknown/changed hash → needsDiff (fetch /schema)", () => {
    expect(hashCheck("sha256:abc", undefined).kind).toBe("needsDiff");
    expect(hashCheck("sha256:abc", "sha256:old").kind).toBe("needsDiff");
  });
});

describe("signatureVerdict / diffSignature — directional classification", () => {
  it("identical contract → ok", () => {
    expect(signatureVerdict(base, clone(base))).toEqual({ ok: true });
  });

  it("NON-GATING: omitting or changing a SHARING type does NOT break core sync; a CORE type change still does (5-pass review)", () => {
    const withShare: Signature = { version: 1, api_version: 1, endpoints: ["GET /a"], types: {
      StatusResponse: [{ name: "status", type: "string", required: true }],
      SharedVault: [{ name: "owner", type: "string", required: true }, { name: "perm", type: "Perm", required: true }],
      VaultShares: [{ name: "vault", type: "string", required: true }, { name: "status", type: "string", required: true }],
    } };
    // An older/compatible server that simply OMITS the (additive) sharing types → core sync proceeds.
    const missing = clone(withShare); delete missing.types.SharedVault; delete missing.types.VaultShares;
    expect(signatureVerdict(withShare, missing)).toEqual({ ok: true });
    // A dropped field INSIDE a sharing type (incl. the client-unread VaultShares.status) → still non-gating.
    const dropped = clone(withShare);
    dropped.types.SharedVault = dropped.types.SharedVault.filter((f) => f.name !== "owner");
    dropped.types.VaultShares = dropped.types.VaultShares.filter((f) => f.name !== "status");
    expect(signatureVerdict(withShare, dropped)).toEqual({ ok: true });
    // But a CORE (non-sharing) type change is STILL breaking — the gate still protects core sync.
    const coreBroken = clone(withShare);
    coreBroken.types.StatusResponse = coreBroken.types.StatusResponse.filter((f) => f.name !== "status");
    expect(signatureVerdict(withShare, coreBroken).ok).toBe(false);
  });

  it("NON-GATING: a dropped SHARE/ADMIN endpoint does NOT break core sync; a dropped CORE endpoint does (5-pass verify, Fix 1)", () => {
    const withEps: Signature = { version: 1, api_version: 1, types: { StatusResponse: [{ name: "status", type: "string", required: true }] },
      endpoints: ["GET /api/v/:vault/changes", "GET /api/shared", "GET /api/share-links", "GET /api/admin/vaults"] };
    // Server drops the share/admin endpoints (older/compatible or a feature change) → core sync proceeds.
    const noShare = clone(withEps); noShare.endpoints = ["GET /api/v/:vault/changes"];
    expect(signatureVerdict(withEps, noShare)).toEqual({ ok: true });
    // Server drops a CORE endpoint → still breaking.
    const noCore = clone(withEps); noCore.endpoints = ["GET /api/shared", "GET /api/share-links", "GET /api/admin/vaults"];
    expect(signatureVerdict(withEps, noCore).ok).toBe(false);
  });

  it("RESPONSE: a field the client READS removed → breaking", () => {
    const s = clone(base); s.types.StatusResponse = s.types.StatusResponse.filter((f) => f.name !== "status");
    const v = signatureVerdict(base, s);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reasons.join()).toMatch(/StatusResponse\.status/);
  });
  it("RESPONSE: a field the client reads retyped → breaking", () => {
    const s = clone(base); s.types.StatusResponse[0].type = "integer";
    expect(signatureVerdict(base, s).ok).toBe(false);
  });
  it("RESPONSE: a NEW field (even required) is additive → ok (client ignores what it doesn't read)", () => {
    const s = clone(base); s.types.StatusResponse.push({ name: "schema_hash", type: "string", required: true });
    expect(signatureVerdict(base, s)).toEqual({ ok: true });
  });
  it("RESPONSE: a field the client requires becoming OPTIONAL (server may omit it) → breaking (F2)", () => {
    const s = clone(base); s.types.StatusResponse[0].required = false; // status: required → optional
    const v = signatureVerdict(base, s);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reasons.join()).toMatch(/may now omit "StatusResponse\.status"/);
  });

  it("RESPONSE: an OPTIONAL field the client reads that the server LACKS → NON-breaking (a newer client / older server; issueOptionalResponseFieldGates)", () => {
    const s = clone(base); s.types.StatusResponse = s.types.StatusResponse.filter((f) => f.name !== "detail"); // `detail` is optional
    expect(signatureVerdict(base, s)).toEqual({ ok: true }); // degrades gracefully — never gate core sync over an additive optional field
  });
  it("directional hint: server LACKS a required field → 'server' older; server DEMANDS a new field → 'plugin' older; a retype → 'either'", () => {
    const dropped = clone(base); dropped.types.StatusResponse = dropped.types.StatusResponse.filter((f) => f.name !== "status");
    const v1 = signatureVerdict(base, dropped);
    expect(v1.ok).toBe(false);
    if (!v1.ok) { expect(v1.older).toBe("server"); expect(incompatibleMessage(v1.reasons, v1.older)).toMatch(/server is missing something|server needs updating/); }
    const demands = clone(base); demands.types.CommitRequest.push({ name: "newthing", type: "string", required: true }); // client doesn't send it
    const v2 = signatureVerdict(base, demands);
    expect(v2.ok).toBe(false);
    if (!v2.ok) { expect(v2.older).toBe("plugin"); expect(incompatibleMessage(v2.reasons, v2.older)).toMatch(/update the plugin/); }
    const retyped = clone(base); retyped.types.StatusResponse[0].type = "integer";
    const v3 = signatureVerdict(base, retyped);
    expect(v3.ok).toBe(false);
    if (!v3.ok) { expect(v3.older).toBe("either"); expect(incompatibleMessage(v3.reasons, v3.older)).toMatch(/Update whichever is older/); }
  });

  it("GUARD: every OPTIONAL field in a GATING response type is KNOWN undefined-safe — a new one forces a conscious review (issueOptionalResponseFieldGates)", () => {
    // The relaxed gate treats a required:false response field the server LACKS as non-breaking, ASSUMING its
    // client consumer reads it undefined-safe. That invariant is enforced here (critique Finding 1): adding a new
    // optional response field to a GATING type FAILS this test until you confirm its consumer handles undefined.
    const UNDEFINED_SAFE = new Set([
      "ChangesResponse.history_floor",      // undefined → genesis; D0019 keep-and-push, never deletes
      "Deletion.author", "Deletion.device_id", "Deletion.device_name",   // undefined → unknown author → conservative notify
      "FileMeta.author", "FileMeta.device_id", "FileMeta.device_name",   // same as Deletion
      "LoginResponse.must_change_password", // undefined → falsy → no forced change (acceptable degradation)
      "StatusResponse.api_version",         // cosmetic epoch label (the wire gate carries the real epoch)
      "StatusResponse.schema_hash",         // undefined → the wire gate fails CLOSED (never silently trusted)
    ]);
    const stray: string[] = [];
    for (const [t, fields] of Object.entries(EMBEDDED_SIGNATURE.types)) {
      if (TYPE_ROLES[t] !== "response" || NON_GATING_TYPES.has(t)) continue; // NON_GATING types are skipped by the diff entirely
      for (const f of fields) if (!f.required && !UNDEFINED_SAFE.has(`${t}.${f.name}`)) stray.push(`${t}.${f.name}`);
    }
    expect(stray, `optional response field(s) not confirmed undefined-safe (add to the allowlist after checking the consumer): ${stray.join(", ")}`).toEqual([]);
  });

  it("SEMANTIC EPOCH: a change in api_version → breaking (F3, a shape-identical semantic bump)", () => {
    const s = clone(base); s.api_version = 2;
    const v = signatureVerdict(base, s);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reasons.join()).toMatch(/protocol epoch changed/);
  });

  it("REQUEST: server now REQUIRES a field the client doesn't send → breaking", () => {
    const s = clone(base); s.types.CommitRequest.push({ name: "token", type: "string", required: true });
    const v = signatureVerdict(base, s);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reasons.join()).toMatch(/requires "CommitRequest\.token"/);
  });
  it("REQUEST: a dropped field is additive → ok (unknown fields are ignored, no deny_unknown_fields)", () => {
    const s = clone(base); s.types.CommitRequest = [];
    expect(signatureVerdict(base, s)).toEqual({ ok: true });
  });
  it("REQUEST: a NEW OPTIONAL field is additive → ok", () => {
    const s = clone(base); s.types.CommitRequest.push({ name: "note", type: "string", required: false });
    expect(signatureVerdict(base, s)).toEqual({ ok: true });
  });
  it("REQUEST: a field the client SENDS retyped → breaking", () => {
    const s = clone(base); s.types.CommitRequest[0].type = "integer";
    expect(signatureVerdict(base, s).ok).toBe(false);
  });

  it("an endpoint the client needs is gone → breaking; an added endpoint is additive → ok", () => {
    const removed = clone(base); removed.endpoints = ["GET /a"];
    const rv = signatureVerdict(base, removed);
    expect(rv.ok).toBe(false);
    if (!rv.ok) expect(rv.reasons.join()).toMatch(/GET \/b/);
    const added = clone(base); added.endpoints = ["GET /a", "GET /b", "GET /c"];
    expect(signatureVerdict(base, added)).toEqual({ ok: true });
  });
  it("a whole type the client expects is gone → breaking", () => {
    const s = clone(base); delete (s.types as Record<string, unknown>).StatusResponse;
    expect(signatureVerdict(base, s).ok).toBe(false);
  });
});

describe("validateSignature — shape guard for the untrusted /schema response", () => {
  it("accepts a well-formed signature", () => {
    expect(validateSignature(clone(base))).toEqual(base);
  });
  it("rejects malformed shapes", () => {
    expect(() => validateSignature(null)).toThrow(/signature/);
    expect(() => validateSignature({ version: "1", api_version: 1, endpoints: [], types: {} })).toThrow(/version/);
    expect(() => validateSignature({ version: 1, endpoints: [], types: {} })).toThrow(/api_version/);
    expect(() => validateSignature({ version: 1, api_version: 1, endpoints: [1], types: {} })).toThrow(/endpoints/);
    expect(() => validateSignature({ version: 1, api_version: 1, endpoints: [], types: { T: [{ name: "x" }] } })).toThrow(/field entry/);
  });
});

describe("validateSchemaResponse — the /schema wrapper (F1)", () => {
  it("accepts {hash, signature} and validates the inner signature", () => {
    expect(validateSchemaResponse({ hash: "sha256:abc", signature: clone(base) })).toEqual({ hash: "sha256:abc", signature: base });
  });
  it("rejects a missing/empty hash or a malformed signature", () => {
    expect(() => validateSchemaResponse({ signature: clone(base) })).toThrow(/hash/);
    expect(() => validateSchemaResponse({ hash: "", signature: clone(base) })).toThrow(/hash/);
    expect(() => validateSchemaResponse({ hash: "sha256:abc", signature: { version: 1 } })).toThrow(/signature/);
  });
});

describe("incompatibleMessage", () => {
  it("lists reasons and caps at 3 with a +N more", () => {
    const m = incompatibleMessage(["r1", "r2", "r3", "r4", "r5"]);
    expect(m).toMatch(/r1; r2; r3; \+2 more/);
    expect(FAIL_CLOSED_MESSAGE).toMatch(/update your server/i);
  });
});

describe("the real embedded signature", () => {
  it("is self-compatible and covers the sync contract", () => {
    expect(signatureVerdict(EMBEDDED_SIGNATURE, EMBEDDED_SIGNATURE)).toEqual({ ok: true });
    expect(EMBEDDED_SIGNATURE.types.StatusResponse).toBeTruthy();
    expect(EMBEDDED_SIGNATURE.endpoints).toContain("GET /schema");
    expect(EMBEDDED_SIGNATURE.endpoints).toContain("GET /api/v/:vault/status");
  });
  it("every embedded type has a declared client role (adding a wire type forces a role decision)", () => {
    for (const name of Object.keys(EMBEDDED_SIGNATURE.types)) {
      expect(TYPE_ROLES[name], `type ${name} needs a TYPE_ROLES entry`).toBeDefined();
    }
  });
  // DRIFT GUARD: the client's embedded copy must equal the server-generated artifact. Regenerate the server
  // artifact (UPDATE_WIRE_SIGNATURE=1 cargo test) then copy it to client/src/wire-signature.json.
  it("client embedded copy matches the server artifact (no client<->server signature drift)", () => {
    const serverPath = resolve(process.cwd(), "../server/wire-signature.json");
    const serverArtifact = JSON.parse(readFileSync(serverPath, "utf8"));
    expect(clientArtifact).toEqual(serverArtifact);
  });
});
