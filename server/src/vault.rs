use crate::chunkstore::ContentStore;
use crate::hash::sha256_hex;
use crate::protocol::{ChangesResponse, CommitRequest, Deletion, FileMeta};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};

pub fn safe_rel_path(path: &str) -> Option<PathBuf> {
    if path.is_empty() || path.contains('\\') || path.starts_with('/') { return None; }
    let p = PathBuf::from(path);
    if p.is_absolute() { return None; }
    for c in p.components() {
        if !matches!(c, Component::Normal(_)) { return None; }
    }
    Some(p)
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct Index {
    version: u64,
    files: HashMap<String, FileMeta>,
    deletions: Vec<Deletion>,
    chunk_refs: HashMap<String, u64>,
}

pub struct Vault {
    root: PathBuf,
    vault_dir: PathBuf,
    store: ContentStore,
    idx: Index,
}

impl Vault {
    pub fn open(root: &Path) -> std::io::Result<Self> {
        let vault_dir = root.join("vault");
        std::fs::create_dir_all(&vault_dir)?;
        let store = ContentStore::open(&root.join(".chunks"))?;
        let idx: Index = match std::fs::read(root.join(".sync-index.json")) {
            Ok(b) => serde_json::from_slice(&b).unwrap_or_default(),
            Err(_) => Index::default(),
        };
        let mut idx = idx;
        if idx.version == 0 { idx.version = 1; }
        Ok(Vault { root: root.to_path_buf(), vault_dir, store, idx })
    }

    fn persist(&self) -> std::io::Result<()> {
        let tmp = self.root.join(".sync-index.json.tmp");
        std::fs::write(&tmp, serde_json::to_vec(&self.idx)?)?;
        std::fs::rename(tmp, self.root.join(".sync-index.json")) // atomic replace
    }

    pub fn has_chunk(&self, hash: &str) -> bool { self.store.has(hash) }
    pub fn put_chunk(&self, hash: &str, bytes: &[u8]) -> std::io::Result<()> { self.store.put(hash, bytes) }
    pub fn get_chunk(&self, hash: &str) -> std::io::Result<Option<Vec<u8>>> { self.store.get(hash) }
    pub fn missing(&self, hashes: &[String]) -> Vec<String> {
        hashes.iter().filter(|h| !self.store.has(h)).cloned().collect()
    }
    pub fn version(&self) -> u64 { self.idx.version }

    fn decref(&mut self, chunks: &[String]) -> std::io::Result<()> {
        for h in chunks {
            let n = self.idx.chunk_refs.get(h).copied().unwrap_or(0);
            if n <= 1 { self.idx.chunk_refs.remove(h); self.store.remove(h)?; }
            else { self.idx.chunk_refs.insert(h.clone(), n - 1); }
        }
        Ok(())
    }

    pub fn commit(&mut self, req: CommitRequest) -> std::io::Result<FileMeta> {
        let rel = safe_rel_path(&req.path)
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "bad path"))?;
        // reassemble from chunks (all must be present)
        let mut body = Vec::with_capacity(req.size as usize);
        for h in &req.chunks {
            let c = self.store.get(h)?
                .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, format!("missing chunk {h}")))?;
            body.extend_from_slice(&c);
        }
        if body.len() as u64 != req.size || sha256_hex(&body) != req.hash {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "file hash/size mismatch"));
        }
        // write bind-mount file
        let abs = self.vault_dir.join(&rel);
        if let Some(p) = abs.parent() { std::fs::create_dir_all(p)?; }
        std::fs::write(&abs, &body)?;
        // refcounts: incr new, decr old
        for h in &req.chunks { *self.idx.chunk_refs.entry(h.clone()).or_insert(0) += 1; }
        if let Some(old) = self.idx.files.get(&req.path).map(|m| m.chunks.clone()) {
            self.decref(&old)?;
        }
        self.idx.version += 1;
        let meta = FileMeta {
            path: req.path.clone(), hash: req.hash, size: req.size, mtime: req.mtime,
            version: self.idx.version, chunks: req.chunks,
        };
        self.idx.files.insert(req.path.clone(), meta.clone());
        self.idx.deletions.retain(|d| d.path != req.path);
        self.persist()?;
        Ok(meta)
    }

    pub fn delete(&mut self, path: &str) -> std::io::Result<Option<Deletion>> {
        let Some(rel) = safe_rel_path(path) else { return Ok(None); };
        let Some(old) = self.idx.files.remove(path) else { return Ok(None); };
        self.decref(&old.chunks)?;
        let abs = self.vault_dir.join(rel);
        if abs.exists() { std::fs::remove_file(&abs)?; }
        self.idx.version += 1;
        let d = Deletion { path: path.to_string(), version: self.idx.version };
        self.idx.deletions.push(d.clone());
        self.persist()?;
        Ok(Some(d))
    }

    pub fn changes(&self, since: u64) -> ChangesResponse {
        ChangesResponse {
            version: self.idx.version,
            upserts: self.idx.files.values().filter(|m| m.version > since).cloned().collect(),
            deletes: self.idx.deletions.iter().filter(|d| d.version > since).cloned().collect(),
        }
    }
}
