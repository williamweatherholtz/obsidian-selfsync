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
    pub fn has(&self, hash: &str) -> bool { self.path_for(hash).exists() }
    pub fn put(&self, hash: &str, bytes: &[u8]) -> std::io::Result<()> {
        if sha256_hex(bytes) != hash {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "chunk hash mismatch"));
        }
        let p = self.path_for(hash);
        if p.exists() { return Ok(()); }
        if let Some(parent) = p.parent() { std::fs::create_dir_all(parent)?; }
        std::fs::write(p, bytes)
    }
    pub fn get(&self, hash: &str) -> std::io::Result<Option<Vec<u8>>> {
        match std::fs::read(self.path_for(hash)) {
            Ok(b) => Ok(Some(b)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }
    pub fn remove(&self, hash: &str) -> std::io::Result<()> {
        let p = self.path_for(hash);
        if p.exists() { std::fs::remove_file(p)?; }
        Ok(())
    }
}
