// Persisted set of usernames granted SERVER-ADMIN beyond the bootstrap account (D0021). The
// bootstrap SYNC_USER is ALWAYS admin and is NOT stored here (implicit + undemotable); this set
// holds the ADDITIONALLY-promoted accounts, so an operator can delegate administration without
// sharing the bootstrap credential. A tiny JSON set beside the other stores (.admins.json).
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

pub struct AdminStore {
    path: PathBuf,
    set: BTreeSet<String>,
}

impl AdminStore {
    pub fn open(path: &Path) -> std::io::Result<Self> {
        let set = match std::fs::read(path) {
            // R12-CC3: fail LOUD on a corrupt .admins.json, like the sibling stores. The old
            // unwrap_or_default() silently dropped EVERY promoted admin (a stealth privilege
            // downgrade) and masked the exact corruption the other stores surface.
            Ok(b) => serde_json::from_slice(&b).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, format!(".admins.json is corrupt: {e}")))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => BTreeSet::new(),
            Err(e) => return Err(e),
        };
        Ok(AdminStore { path: path.to_path_buf(), set })
    }
    pub fn contains(&self, user: &str) -> bool { self.set.contains(user) }
    pub fn list(&self) -> Vec<String> { self.set.iter().cloned().collect() }
    fn persist(&self) -> std::io::Result<()> {
        crate::atomicfile::atomic_write(&self.path, &serde_json::to_vec(&self.set)?) // fsync-durable atomic replace (R12-CC2)
    }
    pub fn grant(&mut self, user: &str) -> std::io::Result<()> {
        if self.set.insert(user.to_string()) { self.persist()?; }
        Ok(())
    }
    pub fn revoke(&mut self, user: &str) -> std::io::Result<()> {
        if self.set.remove(user) { self.persist()?; }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn grant_revoke_persists() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join(".admins.json");
        {
            let mut s = AdminStore::open(&p).unwrap();
            assert!(!s.contains("alice"));
            s.grant("alice").unwrap();
            s.grant("alice").unwrap(); // idempotent
            assert!(s.contains("alice"));
            assert_eq!(s.list(), vec!["alice"]);
        }
        // survives reopen
        let mut s2 = AdminStore::open(&p).unwrap();
        assert!(s2.contains("alice"));
        s2.revoke("alice").unwrap();
        assert!(!s2.contains("alice"));
        assert!(AdminStore::open(&p).unwrap().list().is_empty());
    }
}
