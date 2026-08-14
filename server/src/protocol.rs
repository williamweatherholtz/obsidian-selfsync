use serde::{Deserialize, Serialize};

// The wire-protocol / index-schema contract version. The client advertises the version it
// speaks and refuses to sync against a server on a DIFFERENT version, surfacing a clear
// "upgrade one of them" message instead of an undiagnosable malformed-response retry loop
// (a self-hoster auto-updates the BRAT plugin independently of the server). Bump this on any
// breaking change to the sync wire format or the on-disk index schema.
pub const API_VERSION: u32 = 1;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default, schemars::JsonSchema)]
pub struct FileMeta {
    pub path: String,
    pub hash: String,
    pub size: u64,
    pub mtime: i64,
    pub version: u64,
    pub chunks: Vec<String>,
    // Provenance (source-of-change attribution) — recorded at commit, returned on every upsert so a
    // client can attribute an incoming config/plugin change to WHO made it. `author` is the SERVER-
    // AUTHENTICATED username (trustworthy, never client-set); `device_id` is the client-asserted STABLE
    // device UUID and `device_name` its friendly label. Identity for any "another device" decision is the
    // UUID — a renamed device can't impersonate another — and the name is display-only. All optional +
    // `#[serde(default)]`: a pre-provenance record (reindex-from-disk, or an older server) carries none,
    // which the client reads as an UNKNOWN author and handles conservatively (notify). `skip_serializing_if`
    // keeps the wire compact for the common None.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default, schemars::JsonSchema)]
pub struct Deletion {
    pub path: String,
    pub version: u64,
    // Provenance of the DELETION — same shape + rules as FileMeta's (recorded on the tombstone at delete
    // time, returned on every delete so a client can attribute an incoming config/plugin REMOVAL to WHO made
    // it, closing issueDeletionProvenanceUnnotified). `author` is the SERVER-AUTHENTICATED username; the
    // device fields are client-asserted (the stable UUID + friendly label). All optional + `#[serde(default)]`:
    // a pre-provenance tombstone (older server, or one preserved through a rebuild-from-disk that can't recover
    // authorship) carries none → the client reads UNKNOWN and notifies conservatively. Additive on the wire.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, schemars::JsonSchema)]
pub struct ChangesResponse {
    pub version: u64,
    pub upserts: Vec<FileMeta>,
    pub deletes: Vec<Deletion>,
    // The version at/above which DELETION history is complete (D0019). Genesis = 1. A rebuild-from-
    // disk reindex — which can't recover tombstones — raises it to the current version, declaring the
    // deletion history reset. A client whose stored floor is below this (or whose cursor rewound)
    // treats an absent-without-tombstone file conservatively (keep + push + a batched notice), never
    // deleting without a real tombstone. `#[serde(default)]` so an OLDER server (no field) decodes as
    // 0 on the client — which is < genesis, so it never false-triggers a reset.
    #[serde(default)]
    pub history_floor: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, schemars::JsonSchema)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
    // IA.3.5.3: the TOTP 6-digit code (or a recovery code) — required only when the account has MFA
    // enabled. Absent on a first attempt; the server replies 401 "mfa required" and the client re-submits with it.
    #[serde(default)]
    pub totp: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, schemars::JsonSchema)]
pub struct LoginResponse {
    pub token: String,
    // IA.3.5.9: true if the account was flagged for a forced password change (admin create/reset) and
    // must set a new password before the session can do anything else. Clients prompt on this; the
    // server also ENFORCES it (AuthToken rejects a must-change account on all routes but change/logout).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub must_change_password: bool,
}

// Authenticated self-service password change. On success the server RE-ISSUES a fresh token
// (returned as a LoginResponse) and REVOKES every other session for the user — so a leaked
// credential/token can be self-remediated without an admin. (R14 sec#2)
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, schemars::JsonSchema)]
pub struct ChangePasswordRequest {
    pub current: String,
    pub new_password: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default, schemars::JsonSchema)]
pub struct CommitRequest {
    pub path: String,
    pub hash: String,
    pub size: u64,
    pub mtime: i64,
    pub chunks: Vec<String>,
    // Optimistic concurrency (CAS): the server file version the client based this write on.
    // When set, the server rejects the commit (409) if its current version for this path
    // differs — the client then re-reconciles into a merge instead of silently overwriting an
    // intervening commit (the double-first-commit lost-update on a multi-writer shared vault).
    // Absent ⇒ no check (authoritative overwrites: vault switch, user adjudication). Older
    // clients omit it, so the field is optional + defaulted.
    #[serde(default)]
    pub expected_version: Option<u64>,
    // Source attribution (provenance): the committing device's STABLE UUID + friendly name, asserted by
    // the client. The server pairs these with the AUTHENTICATED user (never a client-sent username) and
    // records them as the file's last writer. Identity is the UUID, so renaming a device to match another
    // can't dodge a peer-change notification; the name is display-only. Optional — an older client omits
    // them and the change is recorded with an unknown device.
    #[serde(default)]
    pub device_id: Option<String>,
    #[serde(default)]
    pub device_name: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, schemars::JsonSchema)]
pub struct MissingRequest {
    pub hashes: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, schemars::JsonSchema)]
pub struct MissingResponse {
    pub missing: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, schemars::JsonSchema)]
pub struct RegisterRequest {
    pub username: String,
    pub password: String,
    #[serde(default)]
    pub invite: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, schemars::JsonSchema)]
pub struct VaultListResponse {
    pub vaults: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, schemars::JsonSchema)]
pub struct CreateVaultRequest {
    pub name: String,
}

// Per-vault health, surfaced so a client never treats a degraded/empty manifest as
// authoritative: status "ready" = normal; "error" = index corrupt, sync ops 503 until
// an operator reindexes. `detail` is a human-readable reason (empty when ready).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, schemars::JsonSchema)]
pub struct StatusResponse {
    pub status: String,
    pub detail: String,
    pub version: u64,
    // The server's protocol/index-schema version (see API_VERSION). Retained as a NON-AUTHORITATIVE
    // display label (D0042) — the authority is now the wire-signature diff below. Defaulted so an older
    // client deserializing a newer response — or vice versa — doesn't hard-fail parsing.
    #[serde(default)]
    pub api_version: u32,
    // D0042: the hash of this server's canonical wire-contract SIGNATURE (see wire_signature.rs). The
    // client compares it to its embedded signature hash on connect: a match ⇒ compatible (cheap, every
    // poll); a mismatch ⇒ fetch GET /schema and diff field-by-field. Defaulted so an OLDER server (no
    // field) decodes as "" — which the client reads as "no verifiable signature" and FAILS CLOSED.
    #[serde(default)]
    pub schema_hash: String,
}
