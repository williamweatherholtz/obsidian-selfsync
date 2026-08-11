import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  Signature, EMBEDDED_SIGNATURE, TYPE_ROLES, hashCheck, diffSignature, signatureVerdict,
  validateSignature, incompatibleMessage, FAIL_CLOSED_MESSAGE,
} from "../src/wiresignature";
import clientArtifact from "../src/wire-signature.json";

// D0042 wire-contract compatibility. StatusResponse is a RESPONSE type (client reads); CommitRequest is a
// REQUEST type (client sends) — the two directions the diff classifies differently.
const base: Signature = {
  version: 1,
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
    expect(() => validateSignature({ version: "1", endpoints: [], types: {} })).toThrow(/version/);
    expect(() => validateSignature({ version: 1, endpoints: [1], types: {} })).toThrow(/endpoints/);
    expect(() => validateSignature({ version: 1, endpoints: [], types: { T: [{ name: "x" }] } })).toThrow(/field entry/);
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
