use crate::protocol::{ChangesResponse, Deletion, FileMeta};
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};

pub fn safe_rel_path(path: &str) -> Option<PathBuf> {
    if path.is_empty() || path.contains('\\') || path.starts_with('/') { return None; }
    let p = PathBuf::from(path);
    if p.is_absolute() { return None; }
    for c in p.components() {
        match c {
            Component::Normal(_) => {}
            _ => return None, // ParentDir, RootDir, Prefix, CurDir all rejected
        }
    }
    Some(p)
}

pub struct Vault {
    root: PathBuf,
    version: u64,
    files: HashMap<String, FileMeta>,
    deletions: Vec<Deletion>,
}

impl Vault {
    pub fn open(root: &Path) -> std::io::Result<Self> {
        std::fs::create_dir_all(root)?;
        let vpath = root.join(".sync-version");
        let version = std::fs::read_to_string(&vpath).ok()
            .and_then(|s| s.trim().parse::<u64>().ok())
            .unwrap_or(1);
        let mut files = HashMap::new();
        for entry in walkdir::WalkDir::new(root).into_iter().filter_map(Result::ok) {
            if !entry.file_type().is_file() { continue; }
            let abs = entry.path();
            let rel = abs.strip_prefix(root).unwrap();
            let rel_str = rel.to_string_lossy().replace('\\', "/");
            if rel_str == ".sync-version" { continue; }
            let bytes = std::fs::read(abs)?;
            let meta = std::fs::metadata(abs)?;
            let mtime = meta.modified().ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64).unwrap_or(0);
            files.insert(rel_str.clone(), FileMeta {
                path: rel_str, hash: blake3::hash(&bytes).to_hex().to_string(),
                size: bytes.len() as u64, mtime, version, chunks: vec![],
            });
        }
        let v = Vault { root: root.to_path_buf(), version, files, deletions: Vec::new() };
        v.persist_version()?;
        Ok(v)
    }

    fn persist_version(&self) -> std::io::Result<()> {
        std::fs::write(self.root.join(".sync-version"), self.version.to_string())
    }

    pub fn changes(&self, since: u64) -> ChangesResponse {
        ChangesResponse {
            version: self.version,
            upserts: self.files.values().filter(|m| m.version > since).cloned().collect(),
            deletes: self.deletions.iter().filter(|d| d.version > since).cloned().collect(),
        }
    }

    pub fn read(&self, path: &str) -> std::io::Result<Option<Vec<u8>>> {
        let Some(rel) = safe_rel_path(path) else { return Ok(None); };
        let abs = self.root.join(rel);
        match std::fs::read(&abs) {
            Ok(b) => Ok(Some(b)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }

    pub fn put(&mut self, path: &str, bytes: &[u8], mtime: i64) -> std::io::Result<FileMeta> {
        let rel = safe_rel_path(path)
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "bad path"))?;
        let abs = self.root.join(&rel);
        if let Some(parent) = abs.parent() { std::fs::create_dir_all(parent)?; }
        std::fs::write(&abs, bytes)?;
        self.version += 1;
        let meta = FileMeta {
            path: path.to_string(),
            hash: blake3::hash(bytes).to_hex().to_string(),
            size: bytes.len() as u64,
            mtime,
            version: self.version,
            chunks: vec![],
        };
        self.files.insert(path.to_string(), meta.clone());
        self.deletions.retain(|d| d.path != path);
        self.persist_version()?;
        Ok(meta)
    }

    pub fn delete(&mut self, path: &str) -> std::io::Result<Option<Deletion>> {
        let Some(rel) = safe_rel_path(path) else { return Ok(None); };
        if self.files.remove(path).is_none() { return Ok(None); }
        let abs = self.root.join(rel);
        if abs.exists() { std::fs::remove_file(&abs)?; }
        self.version += 1;
        let d = Deletion { path: path.to_string(), version: self.version };
        self.deletions.push(d.clone());
        self.persist_version()?;
        Ok(Some(d))
    }

    pub fn version(&self) -> u64 { self.version }
}
