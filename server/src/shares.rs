use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

// A share grants another account access to a vault. The vault stays owned by `owner`
// (it lives at DATA_ROOT/<owner>/<vault>); a grant lets `grantee` reach it. Central
// storage (DATA_ROOT/.shares.json) so both "who can see this vault" and "what's shared
// with me" are cheap lookups. No DB (D0005) — filesystem JSON, atomic-written.

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Perm {
    Read,
    ReadWrite,
}

// The access a request needs. Reads accept any grant; writes need ReadWrite (or ownership).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Access {
    Read,
    Write,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Grant {
    pub owner: String,
    pub vault: String,
    pub grantee: String,
    pub perm: Perm,
}

#[derive(Serialize, Deserialize, Default)]
struct SharesFile {
    grants: Vec<Grant>,
}

// Cap the grants a single owner may hold, so no authenticated user can inflate the global
// .shares.json into an unbounded ACL that's linearly scanned under the global shares Mutex on every
// vault request + WS check — degrading EVERY tenant (R16 MEDIUM-1, a regression of dropping the
// grantee-existence check for de-oracling). Far above any real sharing need; an UPSERT never counts.
pub const MAX_GRANTS_PER_OWNER: usize = 1000;

pub struct ShareStore {
    path: PathBuf,
    file: SharesFile,
}

impl ShareStore {
    pub fn open(path: &Path) -> std::io::Result<Self> {
        let file: SharesFile = match std::fs::read(path) {
            Ok(b) => serde_json::from_slice(&b).map_err(|e| {
                std::io::Error::new(std::io::ErrorKind::InvalidData, format!(".shares.json is corrupt ({e})"))
            })?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => SharesFile::default(),
            Err(e) => return Err(e),
        };
        Ok(ShareStore { path: path.to_path_buf(), file })
    }

    fn save(&self) -> std::io::Result<()> {
        crate::atomicfile::atomic_write(&self.path, &serde_json::to_vec(&self.file)?) // fsync-durable (R12-CC2)
    }

    // The effective permission `user` has on (owner, vault): the owner always has full
    // access; otherwise the matching grant's perm, else None (no access).
    pub fn permission(&self, owner: &str, vault: &str, user: &str) -> Option<Perm> {
        if user == owner {
            return Some(Perm::ReadWrite);
        }
        self.file
            .grants
            .iter()
            .find(|g| g.owner == owner && g.vault == vault && g.grantee == user)
            .map(|g| g.perm)
    }

    // Is `user` authorized for `access` on (owner, vault)? Server-enforced on every
    // vault request — the isolation invariant becomes "no access without ownership/grant".
    pub fn authorized(&self, owner: &str, vault: &str, user: &str, access: Access) -> bool {
        match self.permission(owner, vault, user) {
            Some(Perm::ReadWrite) => true,
            Some(Perm::Read) => access == Access::Read,
            None => false,
        }
    }

    // Grant (or update) a share. Upsert: a re-grant to the same grantee replaces the perm.
    pub fn grant(&mut self, owner: &str, vault: &str, grantee: &str, perm: Perm) -> std::io::Result<()> {
        self.file
            .grants
            .retain(|g| !(g.owner == owner && g.vault == vault && g.grantee == grantee));
        self.file.grants.push(Grant {
            owner: owner.to_string(),
            vault: vault.to_string(),
            grantee: grantee.to_string(),
            perm,
        });
        self.save()
    }

    // Revoke a share; takes effect immediately. No-op (no write) if it didn't exist.
    pub fn revoke(&mut self, owner: &str, vault: &str, grantee: &str) -> std::io::Result<()> {
        let before = self.file.grants.len();
        self.file
            .grants
            .retain(|g| !(g.owner == owner && g.vault == vault && g.grantee == grantee));
        if self.file.grants.len() != before {
            self.save()
        } else {
            Ok(())
        }
    }

    // How many grants this owner currently holds across all their vaults (for the per-owner cap).
    pub fn owner_grant_count(&self, owner: &str) -> usize {
        self.file.grants.iter().filter(|g| g.owner == owner).count()
    }

    // Grants on one owner's vault (for the owner's share-management view).
    pub fn grants_for(&self, owner: &str, vault: &str) -> Vec<Grant> {
        self.file
            .grants
            .iter()
            .filter(|g| g.owner == owner && g.vault == vault)
            .cloned()
            .collect()
    }

    // Vaults shared WITH a user (for "shared with me" — Phase 2 client consumption).
    pub fn shared_with(&self, user: &str) -> Vec<Grant> {
        self.file.grants.iter().filter(|g| g.grantee == user).cloned().collect()
    }

    // Drop every grant on a specific (owner, vault) — used when the vault is DELETED (R17), so a
    // grant can't linger invisibly (my_vaults only lists existing vaults) and silently REACTIVATE
    // if the owner later recreates a vault with the same name, re-exposing new content to a prior
    // grantee. Mirror of purge_user's account-delete cleanup.
    pub fn purge_vault(&mut self, owner: &str, vault: &str) -> std::io::Result<()> {
        let before = self.file.grants.len();
        self.file.grants.retain(|g| !(g.owner == owner && g.vault == vault));
        if self.file.grants.len() != before { self.save() } else { Ok(()) }
    }

    // Drop every grant referencing a user (as owner or grantee) — used when an account
    // is removed so no dangling grants remain.
    pub fn purge_user(&mut self, user: &str) -> std::io::Result<()> {
        let before = self.file.grants.len();
        self.file.grants.retain(|g| g.owner != user && g.grantee != user);
        if self.file.grants.len() != before {
            self.save()
        } else {
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn store() -> (tempfile::TempDir, ShareStore) {
        let dir = tempdir().unwrap();
        let s = ShareStore::open(&dir.path().join(".shares.json")).unwrap();
        (dir, s)
    }

    #[test]
    fn owner_has_full_access_without_a_grant() {
        let (_d, s) = store();
        assert_eq!(s.permission("alice", "notes", "alice"), Some(Perm::ReadWrite));
        assert!(s.authorized("alice", "notes", "alice", Access::Read));
        assert!(s.authorized("alice", "notes", "alice", Access::Write));
    }

    #[test]
    fn non_grantee_is_denied() {
        let (_d, s) = store();
        assert_eq!(s.permission("alice", "notes", "mallory"), None);
        assert!(!s.authorized("alice", "notes", "mallory", Access::Read));
        assert!(!s.authorized("alice", "notes", "mallory", Access::Write));
    }

    #[test]
    fn read_grant_allows_read_not_write() {
        let (_d, mut s) = store();
        s.grant("alice", "notes", "bob", Perm::Read).unwrap();
        assert!(s.authorized("alice", "notes", "bob", Access::Read));
        assert!(!s.authorized("alice", "notes", "bob", Access::Write));
        // scoped to that exact vault
        assert!(!s.authorized("alice", "other", "bob", Access::Read));
    }

    #[test]
    fn readwrite_grant_allows_both() {
        let (_d, mut s) = store();
        s.grant("alice", "notes", "bob", Perm::ReadWrite).unwrap();
        assert!(s.authorized("alice", "notes", "bob", Access::Read));
        assert!(s.authorized("alice", "notes", "bob", Access::Write));
    }

    #[test]
    fn revoke_removes_access_immediately() {
        let (_d, mut s) = store();
        s.grant("alice", "notes", "bob", Perm::ReadWrite).unwrap();
        s.revoke("alice", "notes", "bob").unwrap();
        assert_eq!(s.permission("alice", "notes", "bob"), None);
    }

    #[test]
    fn regrant_upserts_the_permission() {
        let (_d, mut s) = store();
        s.grant("alice", "notes", "bob", Perm::Read).unwrap();
        s.grant("alice", "notes", "bob", Perm::ReadWrite).unwrap();
        assert_eq!(s.grants_for("alice", "notes").len(), 1);
        assert_eq!(s.permission("alice", "notes", "bob"), Some(Perm::ReadWrite));
    }

    #[test]
    fn persists_across_reopen() {
        let dir = tempdir().unwrap();
        let p = dir.path().join(".shares.json");
        {
            let mut s = ShareStore::open(&p).unwrap();
            s.grant("alice", "notes", "bob", Perm::Read).unwrap();
        }
        let s = ShareStore::open(&p).unwrap();
        assert_eq!(s.permission("alice", "notes", "bob"), Some(Perm::Read));
    }

    #[test]
    fn shared_with_lists_a_users_grants() {
        let (_d, mut s) = store();
        s.grant("alice", "notes", "bob", Perm::Read).unwrap();
        s.grant("carol", "docs", "bob", Perm::ReadWrite).unwrap();
        s.grant("alice", "notes", "dave", Perm::Read).unwrap();
        assert_eq!(s.shared_with("bob").len(), 2);
    }

    #[test]
    fn owner_grant_count_counts_distinct_grants_not_upserts() { // R16 MEDIUM-1 (per-owner cap basis)
        let (_d, mut s) = store();
        s.grant("alice", "notes", "bob", Perm::Read).unwrap();
        s.grant("alice", "docs", "carol", Perm::Read).unwrap();
        assert_eq!(s.owner_grant_count("alice"), 2);
        s.grant("alice", "notes", "bob", Perm::ReadWrite).unwrap(); // upsert of an existing grant — NOT new
        assert_eq!(s.owner_grant_count("alice"), 2, "an upsert must not inflate the count");
        assert_eq!(s.owner_grant_count("carol"), 0, "scoped to the owner");
    }

    #[test]
    fn purge_vault_drops_only_that_vaults_grants() { // R17 (stale-grant reactivation)
        let (_d, mut s) = store();
        s.grant("alice", "notes", "bob", Perm::Read).unwrap();
        s.grant("alice", "docs", "bob", Perm::ReadWrite).unwrap();
        s.purge_vault("alice", "notes").unwrap();
        assert_eq!(s.permission("alice", "notes", "bob"), None, "the deleted vault's grant is dropped");
        assert_eq!(s.permission("alice", "docs", "bob"), Some(Perm::ReadWrite), "other vaults' grants are kept");
    }

    #[test]
    fn purge_user_drops_grants_as_owner_and_grantee() {
        let (_d, mut s) = store();
        s.grant("alice", "notes", "bob", Perm::Read).unwrap();
        s.grant("bob", "mine", "carol", Perm::Read).unwrap();
        s.purge_user("bob").unwrap();
        assert!(s.shared_with("bob").is_empty());
        assert_eq!(s.grants_for("bob", "mine").len(), 0);
    }
}
