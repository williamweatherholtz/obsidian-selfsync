use crate::chunkstore::ContentStore;
use crate::hash::sha256_hex;
use crate::protocol::{ChangesResponse, CommitRequest, Deletion, FileMeta};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};

// Reject absurd/hostile declared file sizes before allocating anything for them.
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024 * 1024; // 2 GiB

// Cap on retained deletion tombstones. Tombstones only serve the INCREMENTAL
// changes(since) poll; a full reconcile infers deletions from absence, so dropping
// the oldest beyond this cap is safe (online clients see each delete promptly as the
// version advances; a long-offline client catches up via full reconcile on reconnect).
// Prevents the deletions Vec from growing without bound on a churny, long-lived vault.
const MAX_TOMBSTONES: usize = 10_000;

// Keep only the newest `max` tombstones (they're appended in ascending version order,
// so drop from the front). Pure + unit-tested.
fn compact_tombstones(dels: &mut Vec<Deletion>, max: usize) {
    if dels.len() > max {
        dels.drain(0..dels.len() - max);
    }
}

pub fn safe_rel_path(path: &str) -> Option<PathBuf> {
    if path.is_empty() || path.contains('\\') || path.starts_with('/') { return None; }
    let p = PathBuf::from(path);
    if p.is_absolute() { return None; }
    for c in p.components() {
        if !matches!(c, Component::Normal(_)) { return None; }
    }
    Some(p)
}

// Atomically mirror a committed file to the bind-mount path (create parents, write a sibling temp,
// then rename), so a crash mid-write never leaves a torn bind-mount file. (DI-3)
fn write_mirror(abs: &Path, body: &[u8]) -> std::io::Result<()> {
    if let Some(p) = abs.parent() { std::fs::create_dir_all(p)?; }
    let name = abs.file_name().and_then(|s| s.to_str()).unwrap_or("f");
    let tmp = abs.with_file_name(format!(".{name}.selfsync-tmp"));
    std::fs::write(&tmp, body)?;
    std::fs::rename(&tmp, abs)
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct Index {
    version: u64,
    files: HashMap<String, FileMeta>,
    deletions: Vec<Deletion>,
    chunk_refs: HashMap<String, u64>,
}

// After this many journalled mutations, fold the log back into a fresh .sync-index.json
// snapshot and truncate it (bounds replay cost + log size). D0010 (B9 Part A).
const JOURNAL_COMPACT_THRESHOLD: u64 = 500;

// One durable, ABSOLUTE mutation appended to .sync-index.log per commit/delete (the
// append-only journal — avoids rewriting the whole index on every change). Records carry
// full state (a FileMeta / a Deletion), so replay is idempotent and chunk_refs are
// RECOMPUTED from files on load rather than journalled — no fragile refcount deltas.
#[derive(Serialize, Deserialize)]
#[serde(tag = "op")]
enum JournalRecord {
    #[serde(rename = "put")]
    Put { meta: FileMeta },
    #[serde(rename = "del")]
    Del { del: Deletion },
}

// chunk_refs[h] = total occurrences of h across all files' chunk lists — a pure function
// of `files`, so it's rebuilt on load (self-healing; keeps the journal delta-free).
fn recompute_chunk_refs(idx: &mut Index) {
    let mut refs: HashMap<String, u64> = HashMap::new();
    for meta in idx.files.values() {
        for h in &meta.chunks {
            *refs.entry(h.clone()).or_insert(0) += 1;
        }
    }
    idx.chunk_refs = refs;
}

// Replay the append-only journal onto `idx`; returns the count applied. A torn TRAILING
// record (crash mid-append, i.e. bytes after the last newline) is silently discarded; a
// malformed COMPLETE record is genuine corruption and errors (caller opens ERROR state).
fn replay_journal(path: &Path, idx: &mut Index) -> std::io::Result<u64> {
    let data = match std::fs::read(path) {
        Ok(d) => d,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(e),
    };
    // Only bytes up to and including the final newline are complete records.
    let complete = match data.iter().rposition(|&b| b == b'\n') {
        Some(i) => &data[..=i],
        None => &[][..],
    };
    let mut n = 0u64;
    for line in complete.split(|&b| b == b'\n') {
        if line.is_empty() {
            continue;
        }
        let rec: JournalRecord = serde_json::from_slice(line).map_err(|e| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, format!("journal record: {e}"))
        })?;
        match rec {
            JournalRecord::Put { meta } => {
                idx.version = idx.version.max(meta.version);
                idx.deletions.retain(|d| d.path != meta.path);
                idx.files.insert(meta.path.clone(), meta);
            }
            JournalRecord::Del { del } => {
                idx.version = idx.version.max(del.version);
                idx.files.remove(&del.path);
                if !idx.deletions.iter().any(|d| d.path == del.path && d.version == del.version) {
                    idx.deletions.push(del);
                }
            }
        }
        n += 1;
    }
    Ok(n)
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
    // Mutations appended to .sync-index.log since the last full snapshot (triggers compaction).
    journal_len: u64,
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
        let (idx, mut corrupt): (Index, bool) = match std::fs::read(root.join(".sync-index.json")) {
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
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // No snapshot yet, but a JOURNAL is a valid reconstructable index (this is
                // the normal state between the first commit and the first compaction) —
                // replay it, don't trip ERROR.
                if root.join(".sync-index.log").exists() {
                    (Index::default(), false)
                } else {
                // A MISSING index (and no journal) is only "fresh" if there are no
                // MATERIALIZED FILES. Committed files live in vault/; if any exist but the
                // index is gone (e.g. a backup restored without it), opening blank would let
                // clients mass-delete against the empty manifest AND wipe chunks — open ERROR
                // instead and require reindex. (Blobs WITHOUT files are uploaded-but-never-
                // committed orphans — safe to treat as fresh; startup GC reclaims them.)
                let mut existing = Vec::new();
                // Fail CLOSED: if we can't scan the vault dir (permission/IO), we can't
                // prove it's empty — treat as data-present (ERROR) rather than open blank.
                let scan_ok = collect_files(&vault_dir, &vault_dir, &mut existing).is_ok();
                if !existing.is_empty() || !scan_ok {
                    eprintln!(
                        "[vault] {} has data but NO .sync-index.json — opening in ERROR state; run reindex to rebuild",
                        root.display()
                    );
                    (Index::default(), true)
                } else {
                    (Index::default(), false) // truly fresh first run
                }
                }
            }
            Err(e) => return Err(e),
        };
        let mut idx = idx;
        if idx.version == 0 { idx.version = 1; }
        // Replay the append-only journal onto the snapshot, then rebuild chunk_refs from the
        // resulting files. A corrupt (non-trailing) journal record fails closed → ERROR.
        let mut journal_len = 0u64;
        if !corrupt {
            match replay_journal(&root.join(".sync-index.log"), &mut idx) {
                Ok(n) => { journal_len = n; recompute_chunk_refs(&mut idx); }
                Err(e) => {
                    eprintln!("[vault] {} .sync-index.log is CORRUPT ({e}); opening in ERROR state — run reindex", root.display());
                    corrupt = true;
                }
            }
        }
        compact_tombstones(&mut idx.deletions, MAX_TOMBSTONES);
        let mut v = Vault { root: root.to_path_buf(), vault_dir, store, idx, corrupt, journal_len };
        if !v.corrupt { v.verify_and_gc(); }
        Ok(v)
    }

    // Startup integrity pass — safe because `open` runs before the handle is published,
    // so there are no concurrent uploads/commits:
    //   * dangling reference (index cites a chunk with no blob on disk) → mark the
    //     vault ERROR so the operator reindexes (rebuilds from the intact materialized
    //     files). This catches a crash between a blob removal and its would-be persist.
    //   * orphan blob (on disk but unreferenced — e.g. uploaded then the client dropped
    //     before committing) → reclaim it (bounded disk leak, B5).
    fn verify_and_gc(&mut self) {
        let missing: Vec<String> = self.idx.chunk_refs.keys().filter(|h| !self.store.has(h)).cloned().collect();
        if !missing.is_empty() {
            eprintln!(
                "[vault] {}: {} referenced chunk(s) missing on disk (e.g. {}); marking ERROR — run reindex",
                self.root.display(), missing.len(), &missing[0]
            );
            self.corrupt = true;
            return; // don't GC a vault we're about to rebuild
        }
        match self.store.list_hashes() {
            Ok(hashes) => {
                let mut reclaimed = 0usize;
                for h in hashes {
                    if !self.idx.chunk_refs.contains_key(&h) && self.store.remove(&h).is_ok() { reclaimed += 1; }
                }
                if reclaimed > 0 {
                    eprintln!("[vault] {}: reclaimed {reclaimed} orphan chunk(s)", self.root.display());
                }
            }
            Err(e) => eprintln!("[vault] {}: orphan GC skipped (list failed: {e})", self.root.display()),
        }
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
        // If any currently-indexed path is missing from disk, the vault dir is INCOMPLETE (a partial
        // restore / in-flight copy). Refuse rather than drop those paths + GC their chunks — that
        // would be permanent loss that then drives client-side deletions. A genuinely deleted file
        // went through delete() (which removed its index entry too), so it isn't in idx.files. (DI-4)
        let present: std::collections::HashSet<&str> = rels.iter().map(|(rel, _)| rel.as_str()).collect();
        let missing = self.idx.files.keys().filter(|k| !present.contains(k.as_str())).count();
        if missing > 0 {
            return Err(std::io::Error::new(std::io::ErrorKind::NotFound,
                format!("reindex aborted: {missing} indexed file(s) missing from disk (incomplete vault dir?)")));
        }
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
        self.snapshot() // fresh full index; drops any now-stale journal
    }

    // Write the full index snapshot atomically (.sync-index.json).
    fn persist(&self) -> std::io::Result<()> {
        let tmp = self.root.join(".sync-index.json.tmp");
        std::fs::write(&tmp, serde_json::to_vec(&self.idx)?)?;
        std::fs::rename(tmp, self.root.join(".sync-index.json")) // atomic replace
    }

    // Snapshot = fold the journal in: write the full index, then truncate the log. Ordering
    // is safe because journal records are absolute/idempotent — a crash between the two just
    // replays already-snapshotted records harmlessly on the next open.
    fn snapshot(&mut self) -> std::io::Result<()> {
        self.persist()?;
        let _ = std::fs::remove_file(self.root.join(".sync-index.log"));
        self.journal_len = 0;
        Ok(())
    }

    // Durably append one mutation to the journal (append + fsync) instead of rewriting the
    // whole index. Compacts to a fresh snapshot once the log grows past the threshold.
    fn journal(&mut self, rec: &JournalRecord) -> std::io::Result<()> {
        use std::io::Write;
        let mut line = serde_json::to_vec(rec)?;
        line.push(b'\n');
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.root.join(".sync-index.log"))?;
        f.write_all(&line)?;
        f.sync_all()?; // durable before we report the mutation committed
        self.journal_len += 1;
        if self.journal_len >= JOURNAL_COMPACT_THRESHOLD {
            let _ = self.snapshot(); // best-effort — the log is already the durable record
        }
        Ok(())
    }

    pub fn has_chunk(&self, hash: &str) -> bool { self.store.has(hash) }
    pub fn put_chunk(&self, hash: &str, bytes: &[u8]) -> std::io::Result<()> { self.store.put(hash, bytes) }
    pub fn get_chunk(&self, hash: &str) -> std::io::Result<Option<Vec<u8>>> { self.store.get(hash) }
    pub fn missing(&self, hashes: &[String]) -> Vec<String> {
        hashes.iter().filter(|h| !self.store.has(h)).cloned().collect()
    }
    pub fn version(&self) -> u64 { self.idx.version }

    // Decrement refcounts and RETURN the hashes that dropped to zero. The physical
    // blob removal is deferred to AFTER the index is durably persisted (see commit/
    // delete): removing a blob before persist risks a persist failure leaving the
    // on-disk index dangling-referencing a chunk that's already gone.
    fn decref_collect(&mut self, chunks: &[String]) -> Vec<String> {
        let mut to_remove = Vec::new();
        for h in chunks {
            let n = self.idx.chunk_refs.get(h).copied().unwrap_or(0);
            if n <= 1 { self.idx.chunk_refs.remove(h); to_remove.push(h.clone()); }
            else { self.idx.chunk_refs.insert(h.clone(), n - 1); }
        }
        to_remove
    }

    pub fn commit(&mut self, req: CommitRequest) -> std::io::Result<FileMeta> {
        let rel = safe_rel_path(&req.path)
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "bad path"))?;
        // Reject a case-only collision: two index keys differing only in case map to ONE file on a
        // case-insensitive FS, and a later reindex would collapse them (phantom deletion). (PROTO-4)
        if self.idx.files.keys().any(|k| k != &req.path && k.eq_ignore_ascii_case(&req.path)) {
            return Err(std::io::Error::new(std::io::ErrorKind::AlreadyExists, "a path differing only in case already exists"));
        }
        // Reject a hostile/absurd declared size before allocating (a client-supplied
        // u64 must never drive a capacity hint — 2^60 would panic/abort).
        if req.size > MAX_FILE_BYTES {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "file exceeds size limit"));
        }
        // reassemble from chunks (all must be present). Grow from empty — never pre-size
        // from the untrusted hint; the size/hash check below verifies the real bytes.
        let mut body = Vec::new();
        for h in &req.chunks {
            let c = self.store.get(h)?
                .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, format!("missing chunk {h}")))?;
            body.extend_from_slice(&c);
            // Bound the running total: req.chunks may repeat a hash arbitrarily, so cap
            // reassembly at the declared size (already ≤ MAX_FILE_BYTES) — aborts a
            // "one small chunk × 250k repeats → 250 GB in RAM" DoS before it grows.
            if body.len() as u64 > req.size {
                return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "reassembled size exceeds declared size"));
            }
        }
        if body.len() as u64 != req.size || sha256_hex(&body) != req.hash {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "file hash/size mismatch"));
        }
        // Idempotent re-commit: identical path+hash+chunks already recorded → return it unchanged,
        // with no version bump, no journal append, and no broadcast — so a client retry after a
        // transient error is a genuine no-op instead of version churn + a spurious "changed". (protocol-5)
        if let Some(existing) = self.idx.files.get(&req.path) {
            if existing.hash == req.hash && existing.chunks == req.chunks {
                return Ok(existing.clone());
            }
        }
        // --- mutate the index in memory, journal it durably, THEN mirror to the bind-mount file ---
        let snapshot = self.idx.clone();
        for h in &req.chunks { *self.idx.chunk_refs.entry(h.clone()).or_insert(0) += 1; }
        let to_remove = match self.idx.files.get(&req.path).map(|m| m.chunks.clone()) {
            Some(old) => self.decref_collect(&old),
            None => Vec::new(),
        };
        self.idx.version += 1;
        let meta = FileMeta {
            path: req.path.clone(), hash: req.hash, size: req.size, mtime: req.mtime,
            version: self.idx.version, chunks: req.chunks,
        };
        self.idx.files.insert(req.path.clone(), meta.clone());
        self.idx.deletions.retain(|d| d.path != req.path);
        if let Err(e) = self.journal(&JournalRecord::Put { meta: meta.clone() }) {
            self.idx = snapshot; // append failed → not durable (a torn record is dropped on replay); match disk
            return Err(e);
        }
        // Journal is durable. NOW mirror to the bind-mount file — AFTER the journal, via atomic
        // temp+rename, so disk is never ahead of the durable index. A crash before this leaves the
        // OLD file, and reindex can't resurrect never-committed content (DI-3). Best-effort: the
        // authoritative bytes live in the chunk store (served by get_chunk), so a mirror-write
        // failure is a recoverable mismatch, not a lost commit.
        let abs = self.vault_dir.join(&rel);
        if let Err(e) = write_mirror(&abs, &body) {
            eprintln!("[commit] WARN: bind-mount mirror write failed for '{}': {e} (content is durable in the chunk store)", req.path);
        }
        // Index is durable; NOW drop de-referenced blobs. A failure here is a
        // recoverable orphan (startup GC reclaims it), never corruption.
        self.remove_blobs(&to_remove);
        Ok(meta)
    }

    pub fn delete(&mut self, path: &str) -> std::io::Result<Option<Deletion>> {
        let Some(rel) = safe_rel_path(path) else { return Ok(None); };
        if !self.idx.files.contains_key(path) { return Ok(None); }
        let snapshot = self.idx.clone();
        let old = self.idx.files.remove(path).expect("present: checked above");
        let to_remove = self.decref_collect(&old.chunks);
        self.idx.version += 1;
        let d = Deletion { path: path.to_string(), version: self.idx.version };
        self.idx.deletions.push(d.clone());
        compact_tombstones(&mut self.idx.deletions, MAX_TOMBSTONES);
        if let Err(e) = self.journal(&JournalRecord::Del { del: d.clone() }) {
            self.idx = snapshot; // append failed → not durable; roll back to match disk
            return Err(e);
        }
        // Durable; now remove the materialized file + de-referenced blobs (best-effort).
        let abs = self.vault_dir.join(rel);
        if abs.exists() {
            if let Err(e) = std::fs::remove_file(&abs) {
                eprintln!("[vault] warning: delete persisted but bind-mount file {} not removed: {e}", abs.display());
            }
        }
        self.remove_blobs(&to_remove);
        Ok(Some(d))
    }

    // Best-effort physical blob removal, called only after a durable persist. A
    // failure leaves a reclaimable orphan (logged), never a dangling reference.
    fn remove_blobs(&self, hashes: &[String]) {
        for h in hashes {
            if let Err(e) = self.store.remove(h) {
                eprintln!("[vault] warning: chunk {h} de-referenced but not removed ({e}); will be reclaimed at next startup");
            }
        }
    }

    // Metadata for a single path (or None) — lets a client reconcile one file without
    // fetching the whole manifest.
    pub fn file_meta(&self, path: &str) -> Option<FileMeta> {
        self.idx.files.get(path).cloned()
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
// OS/tooling junk that must never count as vault data (would trip the missing-index
// ERROR check and get re-ingested by reindex). `.obsidian` config is NOT junk.
fn is_junk(name: &str) -> bool {
    matches!(name, ".DS_Store" | "Thumbs.db" | "desktop.ini" | ".git")
}

fn collect_files(dir: &Path, base: &Path, out: &mut Vec<(String, PathBuf)>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)?.flatten() {
        let abs = entry.path();
        let name = entry.file_name();
        let name = name.to_str().unwrap_or("");
        if is_junk(name) { continue; }
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

    // B6: a persist failure mid-commit must roll back in-memory state and never drop a
    // referenced blob (no data loss, no dangling reference).
    #[test]
    fn commit_rolls_back_on_journal_failure_without_losing_blobs() {
        let dir = tempfile::tempdir().unwrap();
        let mut v = Vault::open(dir.path()).unwrap();
        let b1 = b"version one"; let h1 = sha256_hex(b1);
        v.put_chunk(&h1, b1).unwrap();
        v.commit(CommitRequest { path: "f.md".into(), hash: h1.clone(), size: b1.len() as u64, mtime: 1, chunks: vec![h1.clone()] }).unwrap();
        let good_version = v.version();

        // Sabotage the journal append: a DIRECTORY where the log file belongs makes the
        // append open() fail (the first commit created it as a file, so remove-then-dir).
        std::fs::remove_file(dir.path().join(".sync-index.log")).ok();
        std::fs::create_dir(dir.path().join(".sync-index.log")).unwrap();
        let b2 = b"version two"; let h2 = sha256_hex(b2);
        v.put_chunk(&h2, b2).unwrap();
        let res = v.commit(CommitRequest { path: "f.md".into(), hash: h2.clone(), size: b2.len() as u64, mtime: 2, chunks: vec![h2.clone()] });
        assert!(res.is_err(), "commit must fail when the journal append fails");

        // rolled back: version unchanged, file still points at v1, v1's blob intact
        assert_eq!(v.version(), good_version);
        let meta = v.changes(0).upserts.into_iter().find(|m| m.path == "f.md").unwrap();
        assert_eq!(meta.chunks, vec![h1.clone()]);
        assert!(v.has_chunk(&h1), "referenced blob must NOT be removed on rollback");

        // and the vault is still usable once the fault clears
        std::fs::remove_dir(dir.path().join(".sync-index.log")).unwrap();
        v.commit(CommitRequest { path: "f.md".into(), hash: h2.clone(), size: b2.len() as u64, mtime: 3, chunks: vec![h2] }).unwrap();
        assert!(v.version() > good_version);
    }

    // B9 Part A — the append-only index journal.
    #[test]
    fn journal_survives_reopen_without_a_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let b = b"hello"; let h = sha256_hex(b);
        {
            let mut v = Vault::open(dir.path()).unwrap();
            v.put_chunk(&h, b).unwrap();
            v.commit(CommitRequest { path: "n.md".into(), hash: h.clone(), size: b.len() as u64, mtime: 1, chunks: vec![h.clone()] }).unwrap();
            // below the compaction threshold: only the journal exists, no snapshot yet
            assert!(!dir.path().join(".sync-index.json").exists());
            assert!(dir.path().join(".sync-index.log").exists());
        }
        let v = Vault::open(dir.path()).unwrap(); // reconstructs by replaying the journal
        assert!(!v.is_corrupt());
        assert!(v.changes(0).upserts.iter().any(|m| m.path == "n.md"));
    }

    #[test]
    fn journalled_delete_replays_on_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let b = b"x"; let h = sha256_hex(b);
        {
            let mut v = Vault::open(dir.path()).unwrap();
            v.put_chunk(&h, b).unwrap();
            v.commit(CommitRequest { path: "d.md".into(), hash: h.clone(), size: 1, mtime: 1, chunks: vec![h.clone()] }).unwrap();
            v.delete("d.md").unwrap();
        }
        let v = Vault::open(dir.path()).unwrap();
        assert!(!v.changes(0).upserts.iter().any(|m| m.path == "d.md"), "deleted file must not reappear after replay");
    }

    #[test]
    fn torn_trailing_journal_record_is_discarded() {
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let b = b"good"; let h = sha256_hex(b);
        {
            let mut v = Vault::open(dir.path()).unwrap();
            v.put_chunk(&h, b).unwrap();
            v.commit(CommitRequest { path: "g.md".into(), hash: h.clone(), size: 4, mtime: 1, chunks: vec![h.clone()] }).unwrap();
        }
        // crash mid-append: a partial record with NO trailing newline
        let mut f = std::fs::OpenOptions::new().append(true).open(dir.path().join(".sync-index.log")).unwrap();
        f.write_all(b"{\"op\":\"put\",\"meta\":{partial").unwrap();
        drop(f);
        let v = Vault::open(dir.path()).unwrap();
        assert!(!v.is_corrupt(), "a torn trailing record must not corrupt the vault");
        assert!(v.changes(0).upserts.iter().any(|m| m.path == "g.md"));
    }

    #[test]
    fn corrupt_complete_journal_record_opens_error() {
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let b = b"ok"; let h = sha256_hex(b);
        {
            let mut v = Vault::open(dir.path()).unwrap();
            v.put_chunk(&h, b).unwrap();
            v.commit(CommitRequest { path: "c.md".into(), hash: h.clone(), size: 2, mtime: 1, chunks: vec![h.clone()] }).unwrap();
        }
        // a COMPLETE but malformed record (has a trailing newline) is genuine corruption
        let mut f = std::fs::OpenOptions::new().append(true).open(dir.path().join(".sync-index.log")).unwrap();
        f.write_all(b"this is not json\n").unwrap();
        drop(f);
        let v = Vault::open(dir.path()).unwrap();
        assert!(v.is_corrupt(), "a malformed complete journal record must open ERROR");
    }

    #[test]
    fn chunk_refs_recomputed_keeps_shared_chunk_after_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let b = b"shared bytes"; let h = sha256_hex(b);
        {
            let mut v = Vault::open(dir.path()).unwrap();
            v.put_chunk(&h, b).unwrap();
            // two files reference the same chunk
            v.commit(CommitRequest { path: "a.md".into(), hash: h.clone(), size: b.len() as u64, mtime: 1, chunks: vec![h.clone()] }).unwrap();
            v.commit(CommitRequest { path: "b.md".into(), hash: h.clone(), size: b.len() as u64, mtime: 2, chunks: vec![h.clone()] }).unwrap();
        }
        // reopen → replay + recompute chunk_refs + startup GC: the shared chunk has 2 refs,
        // so it must NOT be reclaimed as an orphan.
        let v = Vault::open(dir.path()).unwrap();
        assert!(v.has_chunk(&h), "chunk referenced by 2 files must survive recompute + GC");
    }

    // B5: a chunk uploaded but never committed (client dropped) is reclaimed at startup.
    #[test]
    fn startup_reclaims_orphan_chunks() {
        let dir = tempfile::tempdir().unwrap();
        let body = b"uploaded but never committed";
        let orphan = sha256_hex(body);
        {
            let v = Vault::open(dir.path()).unwrap();
            v.put_chunk(&orphan, body).unwrap();
            assert!(v.has_chunk(&orphan));
        }
        let v2 = Vault::open(dir.path()).unwrap(); // startup GC runs
        assert!(!v2.has_chunk(&orphan), "orphan chunk should be reclaimed at startup");
    }

    // B6: a referenced chunk missing from disk on startup marks the vault ERROR so it
    // is reindexed rather than silently serving a dangling reference.
    #[test]
    fn startup_marks_corrupt_on_dangling_reference() {
        let dir = tempfile::tempdir().unwrap();
        let body = b"committed data";
        let h = sha256_hex(body);
        {
            let mut v = Vault::open(dir.path()).unwrap();
            v.put_chunk(&h, body).unwrap();
            v.commit(CommitRequest { path: "d.md".into(), hash: h.clone(), size: body.len() as u64, mtime: 1, chunks: vec![h.clone()] }).unwrap();
        }
        // Simulate a lost blob: delete it straight off disk (sharded by first 2 chars).
        let blob = dir.path().join(".chunks").join(&h[0..2]).join(&h);
        std::fs::remove_file(&blob).unwrap();
        let v2 = Vault::open(dir.path()).unwrap();
        assert!(v2.is_corrupt(), "dangling chunk reference must mark the vault ERROR");
    }

    // C1: a MISSING index with materialized data present must open ERROR (require
    // reindex), never "fresh empty" (which would wipe chunks + trigger client deletes).
    #[test]
    fn missing_index_with_existing_data_opens_error_not_fresh() {
        let dir = tempfile::tempdir().unwrap();
        write_vault_file(dir.path(), "a.md", b"data"); // materialized file, no index
        let v = Vault::open(dir.path()).unwrap();
        assert!(v.is_corrupt(), "missing index but data present must be ERROR, not fresh");
    }

    #[test]
    fn missing_index_empty_namespace_is_fresh() {
        let dir = tempfile::tempdir().unwrap();
        let v = Vault::open(dir.path()).unwrap();
        assert!(!v.is_corrupt(), "a genuinely empty namespace is a fresh first run");
    }

    // Index scaling: tombstones are capped, keeping the NEWEST (highest-version) ones.
    #[test]
    fn compact_tombstones_keeps_newest() {
        let mut dels: Vec<Deletion> = (1..=10).map(|v| Deletion { path: format!("f{v}"), version: v }).collect();
        compact_tombstones(&mut dels, 4);
        assert_eq!(dels.len(), 4);
        assert_eq!(dels.iter().map(|d| d.version).collect::<Vec<_>>(), vec![7, 8, 9, 10]);
        // under the cap: unchanged
        compact_tombstones(&mut dels, 100);
        assert_eq!(dels.len(), 4);
    }

    // H3: repeated hashes must not reassemble past the declared size (OOM DoS guard).
    #[test]
    fn commit_rejects_reassembly_exceeding_declared_size() {
        let dir = tempfile::tempdir().unwrap();
        let mut v = Vault::open(dir.path()).unwrap();
        let body = b"0123456789"; let h = sha256_hex(body); // 10 bytes
        v.put_chunk(&h, body).unwrap();
        // declare size 10 but reference the chunk 5× (would reassemble to 50)
        let res = v.commit(CommitRequest { path: "x.md".into(), hash: h.clone(), size: 10, mtime: 1, chunks: vec![h; 5] });
        assert!(res.is_err(), "reassembly beyond declared size must abort");
    }

    // C4: a hostile declared size is rejected before any allocation.
    #[test]
    fn commit_rejects_absurd_declared_size() {
        let dir = tempfile::tempdir().unwrap();
        let mut v = Vault::open(dir.path()).unwrap();
        let body = b"x"; let h = sha256_hex(body);
        v.put_chunk(&h, body).unwrap();
        let res = v.commit(CommitRequest { path: "big.md".into(), hash: h.clone(), size: u64::MAX, mtime: 1, chunks: vec![h] });
        assert!(res.is_err(), "absurd declared size must be rejected before allocation");
    }
}
