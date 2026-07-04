use crate::hash::sha256_hex;
use std::path::{Path, PathBuf};

pub struct ContentStore { root: PathBuf }

impl ContentStore {
    pub fn open(dir: &Path) -> std::io::Result<Self> {
        std::fs::create_dir_all(dir)?;
        Ok(ContentStore { root: dir.to_path_buf() })
    }
    fn path_for(&self, hash: &str) -> PathBuf {
        // shard by first 2 hex chars to avoid huge flat dirs
        self.root.join(&hash[0..2.min(hash.len())]).join(hash)
    }
    fn is_valid_hash(hash: &str) -> bool {
        hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit())
    }
    pub fn has(&self, hash: &str) -> bool {
        if !Self::is_valid_hash(hash) { return false; }
        self.path_for(hash).exists()
    }
    pub fn put(&self, hash: &str, bytes: &[u8]) -> std::io::Result<()> {
        if !Self::is_valid_hash(hash) {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "invalid chunk hash format"));
        }
        if sha256_hex(bytes) != hash {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "chunk hash mismatch"));
        }
        let p = self.path_for(hash);
        if p.exists() { return Ok(()); }
        if let Some(parent) = p.parent() { std::fs::create_dir_all(parent)?; }
        // Write atomically: a crash mid-write must not leave a truncated blob that
        // has() would report present but get() would return corrupt. (Vault ops are
        // serialized by the per-vault mutex, so a fixed .tmp name can't collide.)
        let tmp = p.with_extension("tmp");
        std::fs::write(&tmp, bytes)?;
        std::fs::rename(tmp, p)
    }
    pub fn get(&self, hash: &str) -> std::io::Result<Option<Vec<u8>>> {
        if !Self::is_valid_hash(hash) { return Ok(None); }
        match std::fs::read(self.path_for(hash)) {
            Ok(b) => Ok(Some(b)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }
    pub fn remove(&self, hash: &str) -> std::io::Result<()> {
        if !Self::is_valid_hash(hash) { return Ok(()); }
        let p = self.path_for(hash);
        if p.exists() { std::fs::remove_file(p)?; }
        Ok(())
    }

    // Every blob hash currently on disk (walks the 2-char shard dirs). Used by the
    // startup consistency check + orphan GC. Ignores stray .tmp/non-hash files.
    pub fn list_hashes(&self) -> std::io::Result<Vec<String>> {
        let mut out = Vec::new();
        for shard in std::fs::read_dir(&self.root)?.flatten() {
            if !shard.file_type().map(|t| t.is_dir()).unwrap_or(false) { continue; }
            for f in std::fs::read_dir(shard.path())?.flatten() {
                if let Some(name) = f.file_name().to_str() {
                    if Self::is_valid_hash(name) { out.push(name.to_string()); }
                }
            }
        }
        Ok(out)
    }
}
