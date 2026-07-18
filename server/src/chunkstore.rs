use crate::hash::sha256_hex;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

pub struct ContentStore {
    root: PathBuf,
    // Monotonic counter for unique temp-file names, so concurrent puts of the SAME
    // hash (now possible under a shared read lock) can't collide on one .tmp path.
    tmp_seq: AtomicU64,
}

impl ContentStore {
    pub fn open(dir: &Path) -> std::io::Result<Self> {
        std::fs::create_dir_all(dir)?;
        let store = ContentStore { root: dir.to_path_buf(), tmp_seq: AtomicU64::new(0) };
        store.sweep_temp(); // reclaim any `*.tmp.N` left by a crash between write and rename
        Ok(store)
    }

    // Delete leftover atomic-write temp files (never valid blobs; would otherwise leak).
    fn sweep_temp(&self) {
        let Ok(shards) = std::fs::read_dir(&self.root) else { return; };
        for shard in shards.flatten() {
            if !shard.file_type().map(|t| t.is_dir()).unwrap_or(false) { continue; }
            if let Ok(entries) = std::fs::read_dir(shard.path()) {
                for e in entries.flatten() {
                    if e.file_name().to_str().map(|n| n.contains(".tmp.")).unwrap_or(false) {
                        let _ = std::fs::remove_file(e.path());
                    }
                }
            }
        }
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
    // @audit r2 2026-07-18 — FIXED: rename published the blob but never fsync'd the shard DIR, so an
    // acked commit's chunk dir-entry could vanish on power loss (write_mirror does the dir-fsync + falsely
    // claimed parity). Added the post-rename dir-fsync. (Also: shard-walk duplicated across sweep_temp/
    // list_hashes/sweep_orphans — a for_each_blob visitor could DRY it; deferred.)
    // @audit-hash sha256:d32e5537318339bd
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
        // has() would report present but get() would return corrupt. The temp name is
        // unique per call (a shared read lock now permits concurrent puts of the same
        // hash), and rename is atomic, so the worst case is a redundant write of
        // identical content — never a torn blob.
        let n = self.tmp_seq.fetch_add(1, Ordering::Relaxed);
        let tmp = p.with_extension(format!("tmp.{n}"));
        // fsync the blob before publishing it: a referenced chunk must survive power loss, since the
        // index (fsync'd on commit) will point at it. Without this, an acked commit could reference a
        // chunk whose bytes never reached disk → an unrecoverable missing-chunk on reboot. (R10-D1)
        {
            use std::io::Write;
            let mut f = std::fs::File::create(&tmp)?;
            f.write_all(bytes)?;
            f.sync_all()?;
        }
        std::fs::rename(&tmp, &p)?;
        // R10-D1: fsync the SHARD DIR after the rename too. sync_all made the bytes durable, but under
        // POSIX the directory entry created by the rename is not guaranteed to survive power loss without
        // this — so an acked commit could still reference a chunk whose dir-entry was lost. Best-effort
        // (the bytes are the authority), matching write_mirror's dir-fsync so the two paths truly agree.
        if let Some(dir) = p.parent() {
            if let Ok(d) = std::fs::File::open(dir) { let _ = d.sync_all(); }
        }
        Ok(())
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

    // Bump a blob's mtime to NOW. Called when a chunk is DE-REFERENCED (delete / commit-overwrite) so
    // the orphan sweep's TTL measures age-since-ORPHANED, not age-since-upload. Without this, a chunk
    // uploaded long ago but only just de-referenced looks instantly reclaimable, and a CONCURRENT
    // rename/dedup commit re-referencing it can be 404'd when the upload-path sweep reclaims it in the
    // gap. Touching can only ever keep a chunk alive longer — never removes it — so it introduces no
    // race; a genuinely-abandoned chunk is still reclaimed TTL after it was orphaned. Best-effort. (R16)
    pub fn touch(&self, hash: &str) {
        if !Self::is_valid_hash(hash) { return; }
        if let Ok(f) = std::fs::File::options().write(true).open(self.path_for(hash)) {
            let _ = f.set_modified(std::time::SystemTime::now());
        }
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

    // SEC#4 runtime orphan GC: reclaim blobs that are NOT in `referenced` (no file cites them) AND
    // whose on-disk file is OLDER than `older_than`. The age gate is the safety margin: a chunk just
    // uploaded and about to be committed is younger than the TTL, so it's spared — only genuinely
    // abandoned uploads (a ReadWrite grantee pushing chunks it never commits) are collected. This
    // bounds uncommitted-orphan disk at runtime (previously reclaimed only at startup/eviction).
    // Returns the number reclaimed. Best-effort per file (a remove failure is logged by the caller
    // via the count delta, never fatal). Safe under the shared read lock: it races no commit (that
    // holds the write lock) and never touches a referenced chunk.
    // @audit r2 2026-07-18 — FIXED (concision): dropped the per-entry String alloc on the hot GC path
    // (HashSet<String>::contains takes &str). Concurrency + fail-safe age-gate reasoning is exemplary —
    // left as-is. (Shard-walk still duplicated across sweep_temp/list_hashes/sweep_orphans — deferred.)
    // @audit-hash sha256:15289dcc8215b6ab
    pub fn sweep_orphans(&self, referenced: &std::collections::HashSet<String>, older_than: std::time::Duration) -> std::io::Result<usize> {
        let mut reclaimed = 0usize;
        for shard in std::fs::read_dir(&self.root)?.flatten() {
            if !shard.file_type().map(|t| t.is_dir()).unwrap_or(false) { continue; }
            for f in std::fs::read_dir(shard.path())?.flatten() {
                let fname = f.file_name();
                let Some(name) = fname.to_str() else { continue; };
                if !Self::is_valid_hash(name) || referenced.contains(name) { continue; }
                // Age gate: spare anything modified within the TTL (an in-flight upload). elapsed()
                // errs only if mtime is in the future → treat as age 0 (spared), never reclaim early.
                let age = f.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok());
                if age.map(|a| a >= older_than).unwrap_or(false) && std::fs::remove_file(f.path()).is_ok() {
                    reclaimed += 1;
                }
            }
        }
        Ok(reclaimed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sweep_orphans_reclaims_unreferenced_and_spares_referenced_and_young() {
        let dir = tempfile::tempdir().unwrap();
        let s = ContentStore::open(dir.path()).unwrap();
        let a = b"aaa"; let ha = sha256_hex(a);
        let b = b"bbb"; let hb = sha256_hex(b);
        s.put(&ha, a).unwrap(); s.put(&hb, b).unwrap();
        let referenced: std::collections::HashSet<String> = [ha.clone()].into_iter().collect();
        // older_than = 0 → age gate passes for any file: the referenced chunk is kept, the orphan goes.
        let n = s.sweep_orphans(&referenced, std::time::Duration::ZERO).unwrap();
        assert_eq!(n, 1);
        assert!(s.has(&ha), "referenced chunk kept");
        assert!(!s.has(&hb), "unreferenced orphan reclaimed");
        // A fresh orphan is SPARED by a real TTL — an in-flight upload about to be committed survives.
        let c = b"ccc"; let hc = sha256_hex(c); s.put(&hc, c).unwrap();
        let n2 = s.sweep_orphans(&referenced, std::time::Duration::from_secs(3600)).unwrap();
        assert_eq!(n2, 0, "young orphan spared by the TTL");
        assert!(s.has(&hc));
    }
}
