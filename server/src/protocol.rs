use serde::{Deserialize, Serialize};

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
}
