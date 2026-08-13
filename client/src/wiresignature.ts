// Client-side wire-contract compatibility (D0042). The server DERIVES a canonical signature of its wire
// contract from its own serde types (schemars) and advertises the signature's hash as `schemaHash` on
// /status, serving the full signature at GET /schema. This module compares the server's signature to the
// one THIS build was compiled against (client/src/wire-signature.json, copied from the server artifact) to
// decide compatibility — replacing the old single-integer versionVerdict.
//
// The gate runs at each connect/reconnect (not on every poll tick). Cheap path: a schemaHash already
// verified this session is compatible again (a string compare). First contact — or a hash that changed
// since (a server upgrade forces a reconnect, which re-runs this) — triggers a /schema fetch + a
// directional field-by-field diff. A mid-session contract swap self-heals on the next reconnect, and the
// response validators (validateStatus/validateChanges/validateFileMeta) backstop malformed data meanwhile.
//
// DIRECTIONAL classification: a hash tells you THAT the contract changed, never WHETHER it breaks — and
// breaking-ness is asymmetric, so the client (which alone knows what it SENDS vs RECEIVES) classifies:
//   - a RESPONSE type (the client reads it): breaking if a field it reads is REMOVED or RETYPED; a new
//     field (any) is additive — the client ignores what it doesn't read.
//   - a REQUEST type (the client sends it): breaking if the server now REQUIRES a field the client doesn't
//     send, or a sent field is RETYPED; a dropped field is harmless (the server ignores unknown fields —
//     no deny_unknown_fields anywhere), a new optional field is additive.
// This makes a bugfix (zero structural deltas → identical hash → never even diffs) always compatible, while
// a genuine breaking change is refused with the SPECIFIC field/endpoint and direction.

import embeddedJson from "./wire-signature.json";

export interface SigField {
  name: string;
  type: string;
  required: boolean;
}
export interface Signature {
  version: number;
  api_version: number; // the semantic epoch (F3): bumped for a shape-identical semantic break; a change is breaking
  endpoints: string[];
  types: Record<string, SigField[]>;
}

// The GET /schema body: the signature paired with the server's own hash of it. The client verifies this
// hash equals the schemaHash advertised on /status before trusting the signature (F1 — defeats a stale/
// cached /schema served against a fresher /status).
export interface SchemaResponse {
  hash: string;
  signature: Signature;
}

// The signature this plugin build was compiled against.
export const EMBEDDED_SIGNATURE: Signature = embeddedJson as Signature;

// How this client uses each wire type — the direction the signature itself can't carry. Every type in the
// embedded signature MUST appear here (a test enforces it), so adding a wire type forces a role decision.
export type TypeRole = "request" | "response";
export const TYPE_ROLES: Record<string, TypeRole> = {
  // responses the client READS
  FileMeta: "response",
  Deletion: "response",
  ChangesResponse: "response",
  LoginResponse: "response",
  MissingResponse: "response",
  VaultListResponse: "response",
  StatusResponse: "response",
  // sharing responses the client READS (F5)
  SharedVault: "response",
  VaultShares: "response",
  GrantView: "response",
  LinkInfo: "response",
  // requests the client SENDS
  LoginRequest: "request",
  ChangePasswordRequest: "request",
  CommitRequest: "request",
  MissingRequest: "request",
  RegisterRequest: "request",
  CreateVaultRequest: "request",
};

// Types that are covered for DRIFT (their fields ride in the signature + its hash, and the runtime response
// validators reject malformed data) but must NOT GATE core note sync. They belong to the share-management
// feature — NOT the core sync/auth/status protocol — so an older server that merely doesn't DECLARE them, or a
// benign change to a field the client doesn't consume, must not refuse-block a wire-compatible server (the
// review pass found the 1.27 client was refusing ALL sync against a 1.24–1.26 server over additive share
// metadata; owner-directed: make them non-gating). A REAL problem in one of these still surfaces at runtime
// where the client actually reads it (validateSharedVaults/VaultShares/ShareLinks throw on a bad shape).
export const NON_GATING_TYPES = new Set(["SharedVault", "VaultShares", "GrantView", "LinkInfo"]);

// An endpoint entry ("METHOD /path") belongs to the share-management / admin feature (not core sync) → its
// presence must not gate core note sync (Fix 1 symmetry). Covers /api/shared, /api/share-links*, /api/share-
// redeem*, and /api/admin/* — a server dropping one degrades the share UI (a caught fetch error), never sync.
export function isNonGatingEndpoint(entry: string): boolean {
  const path = entry.split(" ")[1] ?? "";
  return path.startsWith("/api/share") || path.startsWith("/api/admin");
}

export interface Delta {
  breaking: boolean;
  reason: string; // human, actionable — names the specific endpoint/field + direction
}

// A field lookup by name.
function byName(fields: SigField[]): Map<string, SigField> {
  return new Map(fields.map((f) => [f.name, f]));
}

// Directional field-by-field diff of the SERVER's signature against what this build EXPECTS (embedded).
// Only BREAKING deltas are returned with breaking:true; additive observations are omitted (they never
// block). Unknown-role types default to the conservative RESPONSE rule (removed/retyped = breaking).
export function diffSignature(embedded: Signature, server: Signature): Delta[] {
  const deltas: Delta[] = [];

  // Semantic epoch (F3): a change means the server declared a shape-identical but semantically breaking
  // change (e.g. a chunk-hash algorithm change) that a structural diff cannot see — refuse.
  if (embedded.api_version !== server.api_version) {
    deltas.push({ breaking: true, reason: `the server's protocol epoch changed (v${embedded.api_version} → v${server.api_version}) — a semantic change this plugin can't verify` });
  }

  // Endpoints the client relies on for CORE sync that the server no longer exposes → breaking. Share-management
  // + admin routes are NON-GATING for the same reason as the share types (5-pass verify, Fix 1 symmetry): they
  // belong to a non-core feature, so a server that drops/renames one must degrade the share UI, not refuse core
  // note sync. (A share route missing at runtime is a caught fetch error where the client actually calls it.)
  const serverEndpoints = new Set(server.endpoints);
  for (const e of embedded.endpoints) {
    if (isNonGatingEndpoint(e)) continue;
    if (!serverEndpoints.has(e)) {
      deltas.push({ breaking: true, reason: `the server no longer exposes "${e}", which this plugin needs` });
    }
  }

  for (const [typeName, eFields] of Object.entries(embedded.types)) {
    if (NON_GATING_TYPES.has(typeName)) continue; // share-metadata: drift-detected + runtime-validated, never gates core sync
    const sFields = server.types[typeName];
    if (!sFields) {
      deltas.push({ breaking: true, reason: `the server no longer defines "${typeName}", which this plugin expects` });
      continue;
    }
    const role: TypeRole = TYPE_ROLES[typeName] ?? "response";
    const eMap = byName(eFields);
    const sMap = byName(sFields);

    if (role === "response") {
      // The client READS this. A field it reads that's gone, retyped, or newly OMISSIBLE breaks it; new
      // fields are additive. (F2: a field the server used to guarantee (required) becoming optional means it
      // may now omit a value the client's response validator still requires → a real, otherwise-silent break.)
      for (const [name, ef] of eMap) {
        const sf = sMap.get(name);
        if (!sf) {
          deltas.push({ breaking: true, reason: `the server dropped "${typeName}.${name}", which this plugin reads` });
        } else if (sf.type !== ef.type) {
          deltas.push({ breaking: true, reason: `"${typeName}.${name}" changed type on the server (${ef.type} → ${sf.type}), which this plugin reads` });
        } else if (ef.required && !sf.required) {
          deltas.push({ breaking: true, reason: `the server may now omit "${typeName}.${name}", which this plugin requires` });
        }
      }
    } else {
      // The client SENDS this. A field the server now requires but the client doesn't send breaks it, as
      // does a retype of a field the client sends; a dropped field is harmless (unknown fields are ignored).
      for (const [name, sf] of sMap) {
        const ef = eMap.get(name);
        if (sf.required && (!ef || !ef.required)) {
          deltas.push({ breaking: true, reason: `the server now requires "${typeName}.${name}", which this plugin does not send` });
        } else if (ef && sf.type !== ef.type) {
          deltas.push({ breaking: true, reason: `"${typeName}.${name}" changed type on the server (${ef.type} → ${sf.type}), which this plugin sends` });
        }
      }
    }
  }
  return deltas;
}

export type SignatureVerdict = { ok: true } | { ok: false; reasons: string[] };

// Compatible iff the diff finds no BREAKING delta. Additive-only changes (and identical contracts) pass.
export function signatureVerdict(embedded: Signature, server: Signature): SignatureVerdict {
  const breaking = diffSignature(embedded, server).filter((d) => d.breaking).map((d) => d.reason);
  return breaking.length === 0 ? { ok: true } : { ok: false, reasons: breaking };
}

// The cheap connect-time gate over the server's advertised schemaHash. `verifiedHash` is a hash we already
// diffed-and-accepted this session (in-memory). Fail CLOSED on an absent hash — an older server that can't
// advertise a signature is treated as incompatible, never silently trusted.
export type HashCheck =
  | { kind: "compatible" }
  | { kind: "needsDiff" }
  | { kind: "failClosed" };
export function hashCheck(serverHash: string | undefined, verifiedHash: string | undefined): HashCheck {
  if (!serverHash) return { kind: "failClosed" };
  if (verifiedHash !== undefined && serverHash === verifiedHash) return { kind: "compatible" };
  return { kind: "needsDiff" };
}

// PROTO-3: validate the SHAPE of the untrusted /schema response before diffing it (a hostile/garbled
// signature must never drive a false "compatible"). Throws on any malformed field.
export function validateSignature(o: unknown): Signature {
  const s = o as Record<string, unknown>;
  if (!s || typeof s !== "object") throw new Error("malformed signature: not an object");
  if (typeof s.version !== "number") throw new Error("malformed signature: version not a number");
  if (typeof s.api_version !== "number") throw new Error("malformed signature: api_version not a number");
  if (!Array.isArray(s.endpoints) || s.endpoints.some((e) => typeof e !== "string")) {
    throw new Error("malformed signature: endpoints not string[]");
  }
  if (!s.types || typeof s.types !== "object") throw new Error("malformed signature: types not an object");
  const types: Record<string, SigField[]> = {};
  for (const [name, fields] of Object.entries(s.types as Record<string, unknown>)) {
    if (!Array.isArray(fields)) throw new Error(`malformed signature: ${name} fields not an array`);
    types[name] = fields.map((f) => {
      const x = f as Record<string, unknown>;
      if (typeof x?.name !== "string" || typeof x?.type !== "string" || typeof x?.required !== "boolean") {
        throw new Error(`malformed signature: ${name} field entry invalid`);
      }
      return { name: x.name, type: x.type, required: x.required };
    });
  }
  return { version: s.version, api_version: s.api_version, endpoints: s.endpoints as string[], types };
}

// Validate the GET /schema wrapper (untrusted): a `hash` string + a well-formed `signature`.
export function validateSchemaResponse(o: unknown): SchemaResponse {
  const r = o as Record<string, unknown>;
  if (!r || typeof r !== "object") throw new Error("malformed schema response: not an object");
  if (typeof r.hash !== "string" || r.hash.length === 0) throw new Error("malformed schema response: hash not a non-empty string");
  return { hash: r.hash, signature: validateSignature(r.signature) };
}

// User-facing messages (kept here so they're consistent + testable).
export const FAIL_CLOSED_MESSAGE =
  "Your server didn't report a sync-protocol signature, so this plugin can't confirm they're compatible — update your server. Not syncing until then (your notes are untouched).";
// The server DID advertise a signature hash, but its /schema couldn't be fetched or didn't match that
// hash (a mid-upgrade window or a stale cache in front of /schema — F1). Refuse until it settles.
export const UNVERIFIED_MESSAGE =
  "This plugin couldn't verify your server's sync-protocol signature (the server may be mid-upgrade, or a cache is serving a stale copy). Not syncing until it settles (your notes are untouched).";
export function incompatibleMessage(reasons: string[]): string {
  const shown = reasons.slice(0, 3).join("; ") + (reasons.length > 3 ? `; +${reasons.length - 3} more` : "");
  return `This plugin and your server have incompatible sync protocols — ${shown}. Update whichever is older. Not syncing until they match (your notes are untouched).`;
}
