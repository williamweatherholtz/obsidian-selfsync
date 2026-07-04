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
    // True when the persisted index was unreadable/corrupt. The vault OPENS (so the
    // process survives and the operator can inspect + repair) but refuses every sync
    // operation until `reindex()` rebuilds the manifest from the materialized files.
    // This is the "fail loud, require explicit repair" model (Postgres/SQLite), NOT
    // silent auto-reset — a blank index would advertise an empty vault and our
    // hash-based reconcile could read that as "delete everything".
    corrupt: bool,
}

impl Vault {
    pub fn open(root: &Path) -> std::io::Result<Self> {
        let vault_dir = root.join("vault");
        std::fs::create_dir_all(&vault_dir)?;
        let store = ContentStore::open(&root.join(".chunks"))?;
        // A corrupt index must NOT silently reset to blank (that would drop every
        // file->chunk mapping and advertise an empty vault). Instead open in a
        // locked/corrupt state: the vault exists but refuses sync ops until an
        // operator runs reindex. Only a genuinely-absent file (first run) is fresh.
        let (idx, corrupt): (Index, bool) = match std::fs::read(root.join(".sync-index.json")) {
            Ok(b) => match serde_json::from_slice::<Index>(&b) {
                Ok(idx) => (idx, false),
                Err(e) => {
                    eprintln!(
                        "[vault] {} .sync-index.json is CORRUPT ({e}); opening in ERROR state — run reindex to rebuild",
                        root.display()
                    );
                    (Index::default(), true)
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (Index::default(), false),
            Err(e) => return Err(e),
        };
        let mut idx = idx;
        if idx.version == 0 { idx.version = 1; }
        Ok(Vault { root: root.to_path_buf(), vault_dir, store, idx, corrupt })
    }

    // True while the persisted index was corrupt and has not yet been reindexed.
    pub fn is_corrupt(&self) -> bool { self.corrupt }

    // Rebuild the manifest from the materialized bind-mount files — the operator's
    // explicit repair for a corrupt index (and safe to run on a healthy vault).
    // Version-PRESERVING: a file whose bytes are unchanged keeps its old version, so
    // clients see no spurious change. Files are re-ingested as WHOLE-FILE chunks: the
    // FastCDC chunk boundaries live only client-side, so the server can't re-derive
    // them — dedup re-establishes as clients next edit each file. Deterministic:
    // same files on disk -> same {path->hash->chunks} mapping every run.
    pub fn reindex(&mut self) -> std::io::Result<()> {
        let mut new_files: HashMap<String, FileMeta> = HashMap::new();
        let mut new_refs: HashMap<String, u64> = HashMap::new();
        let mut max_version = self.idx.version;
        let mut rels: Vec<(String, PathBuf)> = Vec::new();
        collect_files(&self.vault_dir, &self.vault_dir, &mut rels)?;
        rels.sort(); // deterministic version assignment order
        for (rel, abs) in rels {
            let body = std::fs::read(&abs)?;
            let hash = sha256_hex(&body);
            self.store.put(&hash, &body)?; // content-addressed; idempotent
            let mtime = std::fs::metadata(&abs)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            // version-preserving: unchanged path+hash keeps its version
            let version = match self.idx.files.get(&rel) {
                Some(old) if old.hash == hash => old.version,
                _ => { max_version += 1; max_version }
            };
            *new_refs.entry(hash.clone()).or_insert(0) += 1;
            new_files.insert(rel.clone(), FileMeta {
                path: rel, hash, size: body.len() as u64, mtime, version, chunks: vec![],
            });
        }
        // fix up single-chunk lists (borrow dance: set chunks from each file's hash)
        for meta in new_files.values_mut() { meta.chunks = vec![meta.hash.clone()]; }
        // GC chunks no longer referenced by any file
        for h in self.idx.chunk_refs.keys() {
            if !new_refs.contains_key(h) { let _ = self.store.remove(h); }
        }
        self.idx.files = new_files;
        self.idx.chunk_refs = new_refs;
        self.idx.version = max_version;
        self.corrupt = false;
        self.persist()
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

// Recursively collect every file under `dir` as (forward-slash rel path, abs path),
// relative to `base`. Used by reindex to rebuild the manifest from materialized files.
fn collect_files(dir: &Path, base: &Path, out: &mut Vec<(String, PathBuf)>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)?.flatten() {
        let abs = entry.path();
        let ft = entry.file_type()?;
        if ft.is_dir() {
            collect_files(&abs, base, out)?;
        } else if ft.is_file() {
            if let Ok(rel) = abs.strip_prefix(base) {
                let rel = rel.components()
                    .filter_map(|c| match c { Component::Normal(s) => s.to_str(), _ => None })
                    .collect::<Vec<_>>()
                    .join("/");
                if !rel.is_empty() { out.push((rel, abs)); }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Materialize a file directly into the vault's bind-mount tree (as if it were
    // present on disk but absent/lost from the index) and return its abs path.
    fn write_vault_file(root: &Path, rel: &str, body: &[u8]) {
        let abs = root.join("vault").join(rel);
        std::fs::create_dir_all(abs.parent().unwrap()).unwrap();
        std::fs::write(abs, body).unwrap();
    }

    #[test]
    fn corrupt_index_opens_in_error_state_not_blank() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("vault")).unwrap();
        std::fs::write(dir.path().join(".sync-index.json"), b"{ this is not json").unwrap();
        let v = Vault::open(dir.path()).unwrap(); // opens (survives), does NOT error out
        assert!(v.is_corrupt(), "corrupt index must open in ERROR state");
    }

    #[test]
    fn reindex_rebuilds_from_materialized_files_and_clears_error() {
        let dir = tempfile::tempdir().unwrap();
        write_vault_file(dir.path(), "notes/a.md", b"hello");
        write_vault_file(dir.path(), "b.md", b"world");
        std::fs::write(dir.path().join(".sync-index.json"), b"corrupt!!").unwrap();

        let mut v = Vault::open(dir.path()).unwrap();
        assert!(v.is_corrupt());
        assert!(v.changes(0).upserts.is_empty(), "corrupt vault advertises nothing");

        v.reindex().unwrap();
        assert!(!v.is_corrupt(), "reindex clears ERROR state");
        let mut paths: Vec<_> = v.changes(0).upserts.iter().map(|m| m.path.clone()).collect();
        paths.sort();
        assert_eq!(paths, vec!["b.md".to_string(), "notes/a.md".to_string()]);
        // content is fetchable via the single whole-file chunk
        let meta = v.changes(0).upserts.iter().find(|m| m.path == "b.md").unwrap().clone();
        assert_eq!(meta.chunks.len(), 1);
        assert_eq!(v.get_chunk(&meta.chunks[0]).unwrap().unwrap(), b"world");
        assert_eq!(meta.hash, sha256_hex(b"world"));
    }

    #[test]
    fn reindex_is_version_preserving_for_unchanged_files() {
        let dir = tempfile::tempdir().unwrap();
        // Commit a file the normal (healthy) way so it has a real version.
        let mut v = Vault::open(dir.path()).unwrap();
        let body = b"stable content";
        let hash = sha256_hex(body);
        v.put_chunk(&hash, body).unwrap();
        let meta = v.commit(CommitRequest {
            path: "keep.md".into(), hash: hash.clone(), size: body.len() as u64,
            mtime: 1, chunks: vec![hash.clone()],
        }).unwrap();
        let original_version = meta.version;

        v.reindex().unwrap(); // same bytes on disk -> version must not bump
        let after = v.changes(0).upserts.iter().find(|m| m.path == "keep.md").unwrap().clone();
        assert_eq!(after.version, original_version, "unchanged file keeps its version");
        assert_eq!(after.hash, hash);
    }

    #[test]
    fn reindex_is_deterministic() {
        let dir = tempfile::tempdir().unwrap();
        write_vault_file(dir.path(), "x/one.md", b"1");
        write_vault_file(dir.path(), "two.md", b"22");
        let mut v = Vault::open(dir.path()).unwrap();
        v.reindex().unwrap();
        let map1: HashMap<_, _> = v.changes(0).upserts.iter().map(|m| (m.path.clone(), m.hash.clone())).collect();
        v.reindex().unwrap();
        let map2: HashMap<_, _> = v.changes(0).upserts.iter().map(|m| (m.path.clone(), m.hash.clone())).collect();
        assert_eq!(map1, map2, "same files -> same path->hash mapping");
    }
}
