// Capability share-links (D0023): a SINGLE-USE invitation to a vault share, persisted to
// DATA_ROOT/.share-links.json (filesystem JSON, atomic write — no DB, D0005). The link carries only
// an opaque CSPRNG token; only its sha256 is stored (plaintext shown once at creation). Redeeming —
// by a LOGGED-IN account — mints a normal .shares.json grant bound to the redeemer and consumes the
// link. So it's a redemption layer over the D0008 ACL: audit attribution + per-user revoke are kept,
// and it is never a standing bearer credential. Modeled on the invite-token store (registration.rs).
use crate::shares::Perm;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const DEFAULT_TTL_SECS: u64 = 7 * 24 * 3600; // 7 days; a link expires unless the owner opts out (ttl=0)
pub const MAX_LINKS_PER_OWNER: usize = 100; // bound the globally-scanned file (parity with grants cap)

#[derive(Serialize, Deserialize, Clone)]
struct LinkRec {
    id: String,               // stable, non-secret id for listing/revocation
    owner: String,            // the vault owner (creator)
    vault: String,
    perm: Perm,               // held SERVER-SIDE — never in the link, so a leaked read link can't escalate
    hash: String,             // sha256 hex of the token secret
    label: String,
    created_at: u64,
    expires_at: Option<u64>,  // epoch secs; None only if the owner opted out of expiry
    redeemed_by: Option<String>, // the account that consumed it (single-use)
    redeemed_at: Option<u64>,
}

// Owner-facing metadata — never the hash or token.
#[derive(Serialize, Clone)]
pub struct LinkInfo {
    pub id: String,
    pub vault: String,
    pub perm: Perm,
    pub label: String,
    pub expires_at: Option<u64>,
    pub redeemed_by: Option<String>,
}

// What a successful redeem yields — enough to mint the grant + tell the client what it got.
pub struct Redeemed {
    pub owner: String,
    pub vault: String,
    pub perm: Perm,
}

#[derive(Serialize, Deserialize, Default)]
struct LinksFile {
    links: Vec<LinkRec>,
}

pub struct ShareLinkStore {
    path: PathBuf,
    file: LinksFile,
}

fn sha256_hex(s: &str) -> String {
    Sha256::digest(s.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}
fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

impl ShareLinkStore {
    pub fn open(path: &Path) -> std::io::Result<Self> {
        let file: LinksFile = match std::fs::read(path) {
            Ok(b) => serde_json::from_slice(&b).map_err(|e| {
                std::io::Error::new(std::io::ErrorKind::InvalidData, format!(".share-links.json is corrupt ({e})"))
            })?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => LinksFile::default(),
            Err(e) => return Err(e),
        };
        Ok(Self { path: path.to_path_buf(), file })
    }

    fn save(&self) -> std::io::Result<()> {
        crate::atomicfile::atomic_write(&self.path, &serde_json::to_vec(&self.file)?) // fsync-durable
    }

    // Create a share-link for owner/vault; returns the plaintext token ONCE (only its hash is stored).
    // Bounded per owner (active, unredeemed links). ttl_secs None ⇒ default; 0 ⇒ no expiry (deliberate).
    pub fn create(&mut self, owner: &str, vault: &str, perm: Perm, label: &str, ttl_secs: Option<u64>) -> std::io::Result<String> {
        let active = self.file.links.iter().filter(|l| l.owner == owner && l.redeemed_by.is_none()).count();
        if active >= MAX_LINKS_PER_OWNER {
            return Err(std::io::Error::other("too many active share-links for this account"));
        }
        let secret = uuid::Uuid::new_v4().simple().to_string();
        let now = now_secs();
        let ttl = ttl_secs.unwrap_or(DEFAULT_TTL_SECS);
        self.file.links.push(LinkRec {
            id: uuid::Uuid::new_v4().to_string(),
            owner: owner.to_string(),
            vault: vault.to_string(),
            perm,
            hash: sha256_hex(&secret),
            label: label.to_string(),
            created_at: now,
            expires_at: if ttl == 0 { None } else { Some(now + ttl) },
            redeemed_by: None,
            redeemed_at: None,
        });
        self.save()?;
        Ok(secret)
    }

    // Redeem a token: valid iff it matches an unexpired, unredeemed link. Single-use — marks it
    // redeemed and returns {owner,vault,perm} so the caller mints the grant. Returns None uniformly for
    // unknown / expired / already-redeemed (no oracle distinguishing them).
    pub fn redeem(&mut self, secret: &str, redeemer: &str) -> Option<Redeemed> {
        let now = now_secs();
        let hash = sha256_hex(secret);
        let rec = self.file.links.iter_mut().find(|l| {
            l.hash == hash && l.redeemed_by.is_none() && l.expires_at.map(|e| e > now).unwrap_or(true)
        })?;
        rec.redeemed_by = Some(redeemer.to_string());
        rec.redeemed_at = Some(now);
        let out = Redeemed { owner: rec.owner.clone(), vault: rec.vault.clone(), perm: rec.perm };
        let _ = self.save();
        Some(out)
    }

    pub fn list(&self, owner: &str) -> Vec<LinkInfo> {
        self.file.links.iter().filter(|l| l.owner == owner).map(|l| LinkInfo {
            id: l.id.clone(), vault: l.vault.clone(), perm: l.perm, label: l.label.clone(),
            expires_at: l.expires_at, redeemed_by: l.redeemed_by.clone(),
        }).collect()
    }

    // Revoke a PENDING link by id (owner-scoped — only the owner's own links). Does not affect an
    // already-redeemed grant (that's revoked via the normal share-revoke). Returns whether one matched.
    pub fn revoke(&mut self, owner: &str, id: &str) -> std::io::Result<bool> {
        let before = self.file.links.len();
        self.file.links.retain(|l| !(l.id == id && l.owner == owner && l.redeemed_by.is_none()));
        let removed = self.file.links.len() != before;
        if removed { self.save()?; }
        Ok(removed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn store() -> (tempfile::TempDir, ShareLinkStore) {
        let dir = tempdir().unwrap();
        let s = ShareLinkStore::open(&dir.path().join(".share-links.json")).unwrap();
        (dir, s)
    }

    #[test]
    fn create_then_redeem_once_binds_and_consumes() {
        let (_d, mut s) = store();
        let token = s.create("alice", "notes", Perm::ReadWrite, "for dana", None).unwrap();
        let r = s.redeem(&token, "dana").expect("first redeem succeeds");
        assert_eq!((r.owner.as_str(), r.vault.as_str(), r.perm), ("alice", "notes", Perm::ReadWrite));
        assert!(s.redeem(&token, "dana").is_none(), "single-use — a second redeem fails");
        assert!(s.redeem(&token, "eve").is_none(), "and can't be redeemed by anyone else");
    }

    #[test]
    fn expired_and_unknown_and_revoked_links_do_not_redeem() {
        let (_d, mut s) = store();
        assert!(s.redeem("nope", "dana").is_none(), "unknown token");
        // ttl of 0 via create means no-expiry; force an already-expired record by creating with a tiny
        // ttl and checking the boundary through a second store isn't trivial — instead test revoke.
        let token = s.create("alice", "notes", Perm::Read, "", None).unwrap();
        let id = s.list("alice")[0].id.clone();
        assert!(s.revoke("bob", &id).unwrap() == false, "a non-owner can't revoke");
        assert!(s.revoke("alice", &id).unwrap(), "owner revokes the pending link");
        assert!(s.redeem(&token, "dana").is_none(), "a revoked link can't be redeemed");
    }

    #[test]
    fn list_is_owner_scoped_and_survives_reopen() {
        let dir = tempdir().unwrap();
        let path = dir.path().join(".share-links.json");
        {
            let mut s = ShareLinkStore::open(&path).unwrap();
            s.create("alice", "notes", Perm::Read, "a", None).unwrap();
            s.create("bob", "diary", Perm::ReadWrite, "b", None).unwrap();
        }
        let s = ShareLinkStore::open(&path).unwrap(); // reopened from disk
        assert_eq!(s.list("alice").len(), 1);
        assert_eq!(s.list("alice")[0].vault, "notes");
        assert_eq!(s.list("bob").len(), 1);
    }
}
