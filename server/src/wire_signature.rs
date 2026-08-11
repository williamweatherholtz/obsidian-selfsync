//! Wire-contract SIGNATURE (D0042) — the single source of truth for client<->server compatibility.
//!
//! The signature is DERIVED from the server's own serde types (via schemars), never hand-maintained.
//! It is a canonical, normalized description of the plugin<->server wire contract, with two parts.
//! `endpoints` is the set of client-facing routes ("METHOD /path"), so a REMOVED route is detectable.
//! `types` maps each core protocol type to its field structure (name -> {type, required}), so a
//! removed / retyped / newly-required field is detectable.
//!
//! Its SHA-256 hash (`schema_hash`) rides in `/status` + `/health`; the full signature is served at
//! `GET /schema`. The client compares the hash (cheap, every poll) and, on a mismatch, fetches the
//! full signature and diffs it field-by-field to decide breaking (refuse) vs additive (proceed).
//!
//! A hash detects THAT the contract changed; the STRUCTURE tells the client WHETHER the change is
//! breaking and WHICH field/endpoint differs. Comparing two parsed Values — not two formatted
//! strings — makes the committed-artifact drift gate insensitive to whitespace.
//!
//! Scope note (v1): the field-level `types` map covers the core sync/auth/status protocol types in
//! `protocol.rs` (they reference only each other + primitives, so the map is self-contained). Other
//! client routes (e.g. `/api/shared`) are covered at the endpoint level; their response shapes can
//! be promoted into the `types` map later without breaking the format.

use std::sync::OnceLock;

use schemars::JsonSchema;
use serde_json::{json, Map, Value};

use crate::protocol::{
    ChangePasswordRequest, ChangesResponse, CommitRequest, CreateVaultRequest, Deletion, FileMeta,
    LoginRequest, LoginResponse, MissingRequest, MissingResponse, RegisterRequest, StatusResponse,
    VaultListResponse,
};

/// Signature format version — bumped only if the SHAPE of the signature document itself changes
/// (not when the wire contract it describes changes). Lets a future client reason about the doc.
const SIGNATURE_FORMAT_VERSION: u64 = 1;

/// The client-facing routes (METHOD + path), as declared in `lib.rs::build`'s shared + public groups.
/// The web-admin-only management routes (served by the server's own same-version UI) are intentionally
/// excluded — they are not part of the plugin<->server contract. Sorted at build time.
const ENDPOINTS: &[&str] = &[
    "GET /health",
    "GET /schema",
    "POST /api/login",
    "POST /api/logout",
    "POST /api/password",
    "DELETE /api/vault",
    "GET /api/admin/me",
    "GET /api/admin/vaults",
    "DELETE /api/admin/shares",
    "POST /api/share-links",
    "GET /api/share-links",
    "DELETE /api/share-links/:id",
    "POST /api/share-redeem",
    "POST /api/share-redeem-register",
    "POST /api/register",
    "GET /api/vaults",
    "POST /api/vaults",
    "GET /api/shared",
    "DELETE /api/shared",
    "GET /api/v/:vault/changes",
    "GET /api/v/:vault/meta",
    "POST /api/v/:vault/chunks/missing",
    "PUT /api/v/:vault/chunk/:hash",
    "GET /api/v/:vault/chunk/:hash",
    "POST /api/v/:vault/commit",
    "GET /api/v/:vault/status",
    "POST /api/v/:vault/reindex",
    "DELETE /api/v/:vault/file",
    "GET /api/u/:owner/:vault/changes",
    "GET /api/u/:owner/:vault/meta",
    "POST /api/u/:owner/:vault/chunks/missing",
    "PUT /api/u/:owner/:vault/chunk/:hash",
    "GET /api/u/:owner/:vault/chunk/:hash",
    "POST /api/u/:owner/:vault/commit",
    "GET /api/u/:owner/:vault/status",
    "DELETE /api/u/:owner/:vault/file",
    "GET /api/ws",
];

/// Reduce a schemars property schema to a single normalized type string. Handles primitives, arrays
/// (`array<inner>`), `$ref` (the referenced type NAME), and the nullable forms schemars emits for
/// `Option<T>` (`"type":["string","null"]` or `anyOf:[{...},{"type":"null"}]`) — an Option contributes
/// its inner type; whether the field is optional is carried separately by the `required` set.
fn norm_type(p: &Value) -> String {
    if let Some(r) = p.get("$ref").and_then(Value::as_str) {
        return ref_name(r);
    }
    if let Some(t) = p.get("type") {
        if let Some(s) = t.as_str() {
            return type_str(s, p);
        }
        if let Some(arr) = t.as_array() {
            // nullable primitive, e.g. ["string","null"] — take the first non-null member.
            for x in arr {
                if let Some(s) = x.as_str() {
                    if s != "null" {
                        return type_str(s, p);
                    }
                }
            }
        }
    }
    for key in ["anyOf", "allOf", "oneOf"] {
        if let Some(arr) = p.get(key).and_then(Value::as_array) {
            for x in arr {
                let n = norm_type(x);
                if n != "null" {
                    return n;
                }
            }
        }
    }
    "unknown".to_string()
}

/// Format a JSON-schema primitive/array type, recursing into `items` for arrays.
fn type_str(s: &str, p: &Value) -> String {
    if s == "array" {
        let inner = p.get("items").map(norm_type).unwrap_or_else(|| "any".to_string());
        return format!("array<{inner}>");
    }
    s.to_string()
}

/// `#/definitions/FileMeta` (or `#/$defs/FileMeta`) -> `FileMeta`.
fn ref_name(r: &str) -> String {
    r.rsplit('/').next().unwrap_or(r).to_string()
}

/// Extract the sorted `[{name,type,required}]` field list from a root schema Value.
fn fields_from_schema(root: &Value) -> Vec<Value> {
    let required: Vec<&str> = root
        .get("required")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let mut fields: Vec<Value> = root
        .get("properties")
        .and_then(Value::as_object)
        .map(|props| {
            props
                .iter()
                .map(|(name, sch)| {
                    json!({
                        "name": name,
                        "type": norm_type(sch),
                        "required": required.contains(&name.as_str()),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    fields.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    fields
}

/// The normalized field list for one wire type T, from its schemars-generated root schema.
fn type_fields<T: JsonSchema>() -> Vec<Value> {
    let root = schemars::gen::SchemaGenerator::default().into_root_schema_for::<T>();
    let v = serde_json::to_value(root).expect("schema serializes");
    fields_from_schema(&v)
}

/// Build the canonical signature document. Keys are sorted (serde_json `Map` is a `BTreeMap` by
/// default) and every array is explicitly ordered, so the output is deterministic across runs.
pub fn canonical_signature() -> Value {
    let mut types = Map::new();
    // The core sync/auth/status protocol contract. Add a type here to bring it under the field-level
    // signature (and remember to regenerate the committed artifact).
    types.insert("FileMeta".into(), Value::Array(type_fields::<FileMeta>()));
    types.insert("Deletion".into(), Value::Array(type_fields::<Deletion>()));
    types.insert("ChangesResponse".into(), Value::Array(type_fields::<ChangesResponse>()));
    types.insert("LoginRequest".into(), Value::Array(type_fields::<LoginRequest>()));
    types.insert("LoginResponse".into(), Value::Array(type_fields::<LoginResponse>()));
    types.insert("ChangePasswordRequest".into(), Value::Array(type_fields::<ChangePasswordRequest>()));
    types.insert("CommitRequest".into(), Value::Array(type_fields::<CommitRequest>()));
    types.insert("MissingRequest".into(), Value::Array(type_fields::<MissingRequest>()));
    types.insert("MissingResponse".into(), Value::Array(type_fields::<MissingResponse>()));
    types.insert("RegisterRequest".into(), Value::Array(type_fields::<RegisterRequest>()));
    types.insert("VaultListResponse".into(), Value::Array(type_fields::<VaultListResponse>()));
    types.insert("CreateVaultRequest".into(), Value::Array(type_fields::<CreateVaultRequest>()));
    types.insert("StatusResponse".into(), Value::Array(type_fields::<StatusResponse>()));

    let mut endpoints: Vec<&str> = ENDPOINTS.to_vec();
    endpoints.sort_unstable();

    json!({
        "version": SIGNATURE_FORMAT_VERSION,
        // The SEMANTIC EPOCH (F3): a shape-identical but semantically breaking change — a chunk-hash
        // algorithm change, a `?since` cursor-semantics change — is invisible to a structural signature
        // (Rice's theorem). Bumping crate::protocol::API_VERSION for such a change flows into the signature
        // + its hash here, so the client's diff refuses it. A bugfix leaves it unchanged (no lockstep).
        "api_version": crate::protocol::API_VERSION,
        "endpoints": endpoints,
        "types": Value::Object(types),
    })
}

/// Deterministic compact JSON of the canonical signature (the bytes that get hashed).
pub fn signature_json() -> String {
    serde_json::to_string(&canonical_signature()).expect("signature serializes")
}

/// The `GET /schema` body: the canonical signature PAIRED with its own hash. The client verifies this
/// self-declared `hash` equals the `schemaHash` it got from /status BEFORE trusting the signature — so a
/// stale/cached `/schema` (it's unauthenticated + cacheable) served against a fresher /status (authed +
/// uncacheable) is detected as skew and refused, instead of yielding a false-compatible (F1).
pub fn schema_response() -> Value {
    json!({ "hash": signature_hash(), "signature": canonical_signature() })
}

/// `sha256:<hex>` of the canonical signature. Computed once (the contract is fixed at build time).
pub fn signature_hash() -> &'static str {
    static HASH: OnceLock<String> = OnceLock::new();
    HASH.get_or_init(|| {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(signature_json().as_bytes());
        format!("sha256:{:x}", h.finalize())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signature_is_deterministic() {
        assert_eq!(signature_json(), signature_json());
        assert_eq!(canonical_signature(), canonical_signature());
    }

    #[test]
    fn hash_is_well_formed() {
        let h = signature_hash();
        assert!(h.starts_with("sha256:"), "hash must be sha256-prefixed: {h}");
        let hex = &h["sha256:".len()..];
        assert_eq!(hex.len(), 64, "sha256 hex is 64 chars: {hex}");
        assert!(hex.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn captures_optional_vs_required_fields() {
        let sig = canonical_signature();
        let status = &sig["types"]["StatusResponse"];
        let by = |n: &str| status.as_array().unwrap().iter().find(|f| f["name"] == n).cloned();
        // `status` is a required String; `api_version` and `schema_hash` are #[serde(default)] => optional.
        assert_eq!(by("status").unwrap()["required"], json!(true));
        assert_eq!(by("status").unwrap()["type"], json!("string"));
        assert_eq!(by("api_version").unwrap()["required"], json!(false));
        assert_eq!(by("schema_hash").unwrap()["required"], json!(false));
        // FileMeta.author is Option + default => present but optional; chunks is a required array.
        let fm = &sig["types"]["FileMeta"];
        let ff = |n: &str| fm.as_array().unwrap().iter().find(|f| f["name"] == n).cloned();
        assert_eq!(ff("author").unwrap()["required"], json!(false));
        assert_eq!(ff("chunks").unwrap()["type"], json!("array<string>"));
        assert_eq!(ff("chunks").unwrap()["required"], json!(true));
    }

    #[test]
    fn norm_type_handles_edge_shapes() {
        // primitive, nullable primitive (Option<String>), array-of-primitive, array-of-ref,
        // $ref, anyOf(Option<Struct>), and an unrecognized shape.
        assert_eq!(norm_type(&json!({"type": "string"})), "string");
        assert_eq!(norm_type(&json!({"type": ["string", "null"]})), "string");
        assert_eq!(norm_type(&json!({"type": "array", "items": {"type": "integer"}})), "array<integer>");
        assert_eq!(norm_type(&json!({"type": "array", "items": {"$ref": "#/definitions/FileMeta"}})), "array<FileMeta>");
        assert_eq!(norm_type(&json!({"$ref": "#/$defs/Deletion"})), "Deletion");
        assert_eq!(norm_type(&json!({"anyOf": [{"$ref": "#/definitions/Perm"}, {"type": "null"}]})), "Perm");
        assert_eq!(norm_type(&json!({"weird": true})), "unknown");
    }

    #[test]
    fn nested_type_is_referenced_by_name() {
        // ChangesResponse.upserts is Vec<FileMeta> => "array<FileMeta>" (the type is referenced by name,
        // and FileMeta's own fields live under its own key).
        let sig = canonical_signature();
        let cr = &sig["types"]["ChangesResponse"];
        let up = cr.as_array().unwrap().iter().find(|f| f["name"] == "upserts").cloned().unwrap();
        assert_eq!(up["type"], json!("array<FileMeta>"));
        assert!(sig["types"].get("FileMeta").is_some());
    }

    #[test]
    fn signature_carries_the_semantic_epoch() {
        // F3: API_VERSION is folded into the signature so a shape-identical semantic bump is caught by the diff.
        assert_eq!(canonical_signature()["api_version"], json!(crate::protocol::API_VERSION));
    }

    #[test]
    fn schema_response_pairs_signature_with_its_hash() {
        // F1: /schema carries its own hash so the client can detect a stale/cached body vs a fresher /status.
        let r = schema_response();
        assert_eq!(r["hash"], json!(signature_hash()));
        assert_eq!(r["signature"], canonical_signature());
    }

    #[test]
    fn endpoints_include_the_sync_contract() {
        let sig = canonical_signature();
        let eps: Vec<&str> = sig["endpoints"].as_array().unwrap().iter().map(|e| e.as_str().unwrap()).collect();
        for expected in ["GET /api/v/:vault/status", "POST /api/v/:vault/commit", "GET /schema", "POST /api/login"] {
            assert!(eps.contains(&expected), "missing endpoint {expected}");
        }
        // sorted + deduped-by-construction
        let mut sorted = eps.clone();
        sorted.sort_unstable();
        assert_eq!(eps, sorted, "endpoints must be sorted");
    }

    // DRIFT GATE (D0042, srContractDriftGate): the committed artifact MUST match the signature derived
    // from the live types. A wire-type change that isn't reflected in wire-signature.json fails CI here.
    // Regenerate intentionally with: UPDATE_WIRE_SIGNATURE=1 cargo test -p new-livesync-server wire_signature
    #[test]
    fn committed_artifact_matches_generated() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/wire-signature.json");
        let generated = canonical_signature();
        if std::env::var("UPDATE_WIRE_SIGNATURE").is_ok() {
            std::fs::write(path, format!("{}\n", serde_json::to_string_pretty(&generated).unwrap()))
                .expect("write artifact");
            return;
        }
        let committed_raw = std::fs::read_to_string(path).unwrap_or_else(|_| {
            panic!("committed wire-signature.json missing — regenerate with UPDATE_WIRE_SIGNATURE=1")
        });
        let committed: Value = serde_json::from_str(&committed_raw).expect("committed artifact is valid JSON");
        assert_eq!(
            committed, generated,
            "wire contract drifted from the committed signature — review the change and regenerate with \
             UPDATE_WIRE_SIGNATURE=1 cargo test (D0042 srContractDriftGate)"
        );
    }
}
