use serde::{Deserialize, Serialize};

// The wire-protocol / index-schema contract version. The client advertises the version it
// speaks and refuses to sync against a server on a DIFFERENT version, surfacing a clear
// "upgrade one of them" message instead of an undiagnosable malformed-response retry loop
// (a self-hoster auto-updates the BRAT plugin independently of the server). Bump this on any
// breaking change to the sync wire format or the on-disk index schema.
pub const API_VERSION: u32 = 1;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct FileMeta {
    pub path: String,
    pub hash: String,
    pub size: u64,
    pub mtime: i64,
    pub version: u64,
    pub chunks: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Deletion {
    pub path: String,
    pub version: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ChangesResponse {
    pub version: u64,
    pub upserts: Vec<FileMeta>,
    pub deletes: Vec<Deletion>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct LoginResponse {
    pub token: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
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
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct MissingRequest {
    pub hashes: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct MissingResponse {
    pub missing: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct RegisterRequest {
    pub username: String,
    pub password: String,
    #[serde(default)]
    pub invite: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct VaultListResponse {
    pub vaults: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct CreateVaultRequest {
    pub name: String,
}

// Per-vault health, surfaced so a client never treats a degraded/empty manifest as
// authoritative: status "ready" = normal; "error" = index corrupt, sync ops 503 until
// an operator reindexes. `detail` is a human-readable reason (empty when ready).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct StatusResponse {
    pub status: String,
    pub detail: String,
    pub version: u64,
    // The server's protocol/index-schema version (see API_VERSION). The client checks this on
    // connect (the status call it already makes) and refuses to sync on a mismatch. Defaulted so
    // an older client deserializing a newer response — or vice versa — doesn't hard-fail parsing.
    #[serde(default)]
    pub api_version: u32,
}
