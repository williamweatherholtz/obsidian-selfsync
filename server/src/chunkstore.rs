use crate::hash::sha256_hex;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// Content-addressed blob store (chunks keyed by their SHA-256).
///
/// CONCURRENCY CONTRACT (made explicit per the boundedPool/contentAddressed audit,
/// issueFunctionalCoreShellsReDecide item 4). Each SINGLE operation here is self-consistent:
/// `put` publishes atomically (unique temp + rename + fsync) and `get`/`has`/`remove` act on the
/// final path, so no caller ever observes a torn blob. What this store does NOT provide is ORDERING
/// between operations on the same hash — there is no internal lock coupling `put` against a concurrent
/// `remove`/orphan-sweep. That ordering safety is deliberately BORROWED from two outer mechanisms and
/// is NOT re-enforced here (a second lock inside the store would only contend with — or deadlock
/// against — the Vault's `RwLock`):
///   1. The owning `Vault` holds its `RwLock` around the commit/dereference sequence, so a re-referencing
///      commit and the index update that records the reference are serialized.
///   2. The orphan sweep reclaims a de-referenced blob only after a TTL measured from when it was
///      orphaned (`touch` bumps the mtime on de-reference), giving a concurrent rename/dedup commit a
///      window to re-reference it before it can be collected.
///
/// Callers on the raw store (outside a Vault) MUST uphold #1/#2 themselves; the store assumes it.
pub struct ContentStore {
    root: PathBuf,
    // Monotonic counter for unique temp-file names, so concurrent puts of the SAME
    // hash (now possible under a shared read lock) can't collide on one .tmp path.
    tmp_seq: AtomicU64,
}

// A chunk hash whose FORMAT (exactly 64 ASCII-hex chars) has been validated. `parse` is the ONLY
// constructor, so a value of this type is a proof-of-format (parse-don't-validate, issuePatternUntagged
// ShouldAdopt): path_for + the atomic write take `&ChunkHash`, never a raw `&str`, so an unvalidated hash
// can't reach the filesystem-path computation (a `..`/oversize/short string is rejected at the boundary,
// not silently `join`ed). Each public store method parses its `&str` arg exactly once at entry; the check
// that used to be a free `is_valid_hash` re-called in every method is now that single parse, typed.
struct ChunkHash<'a>(&'a str);
impl<'a> ChunkHash<'a> {
    fn parse(hash: &'a str) -> Option<ChunkHash<'a>> {
        (hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit())).then_some(ChunkHash(hash))
    }
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
    fn path_for(&self, hash: &ChunkHash) -> PathBuf {
        // shard by first 2 hex chars to avoid huge flat dirs (a ChunkHash is always 64 hex → [0..2] is safe)
        self.root.join(&hash.0[0..2]).join(hash.0)
    }
    pub fn has(&self, hash: &str) -> bool {
        let Some(h) = ChunkHash::parse(hash) else { return false; };
        self.path_for(&h).exists()
    }
    // @audit r2 2026-07-18 — FIXED: rename published the blob but never fsync'd the shard DIR, so an
    // acked commit's chunk dir-entry could vanish on power loss (write_mirror does the dir-fsync + falsely
    // claimed parity). Added the post-rename dir-fsync. (Also: shard-walk duplicated across sweep_temp/
    // list_hashes/sweep_orphans — a for_each_blob visitor could DRY it; deferred.)
    // @audit-hash sha256:d32e5537318339bd
    pub fn put(&self, hash: &str, bytes: &[u8]) -> std::io::Result<()> {
        let Some(h) = ChunkHash::parse(hash) else {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "invalid chunk hash format"));
        };
        if sha256_hex(bytes) != hash {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "chunk hash mismatch"));
        }
        let p = self.path_for(&h);
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
        let Some(h) = ChunkHash::parse(hash) else { return Ok(None); };
        match std::fs::read(self.path_for(&h)) {
            Ok(b) => Ok(Some(b)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }
    pub fn remove(&self, hash: &str) -> std::io::Result<()> {
        let Some(h) = ChunkHash::parse(hash) else { return Ok(()); };
        let p = self.path_for(&h);
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
        let Some(h) = ChunkHash::parse(hash) else { return; };
        if let Ok(f) = std::fs::File::options().write(true).open(self.path_for(&h)) {
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
                    if ChunkHash::parse(name).is_some() { out.push(name.to_string()); }
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
                if ChunkHash::parse(name).is_none() || referenced.contains(name) { continue; }
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
    fn chunk_hash_parse_accepts_only_64_hex() {
        assert!(ChunkHash::parse(&"a".repeat(64)).is_some());
        assert!(ChunkHash::parse(&"0123456789abcdef".repeat(4)).is_some()); // 64 hex
        assert!(ChunkHash::parse(&"ABCDEF0123456789".repeat(4)).is_some()); // uppercase hex allowed
        assert!(ChunkHash::parse("").is_none());
        assert!(ChunkHash::parse(&"a".repeat(63)).is_none());  // too short
        assert!(ChunkHash::parse(&"a".repeat(65)).is_none());  // too long
        assert!(ChunkHash::parse(&"g".repeat(64)).is_none());  // non-hex
        // A path-traversal / non-hash string is rejected at the boundary, so it can never reach path_for.
        assert!(ChunkHash::parse("../../../etc/passwd").is_none());
    }

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

    // MUTATION-TESTING (D0030): the following pin behaviors cargo-mutants found untested on the
    // content-addressed store (the durability core beneath every committed file).

    // open() sweeps leftover `*.tmp.N` files (a crash between write and rename would otherwise leak
    // them forever, and they are never valid blobs). No test exercised the crash-recovery sweep.
    #[test]
    fn open_sweeps_leftover_temp_files() {
        let dir = tempfile::tempdir().unwrap();
        let shard = dir.path().join("ab");
        std::fs::create_dir_all(&shard).unwrap();
        let leftover = shard.join("deadbeef.tmp.0");
        std::fs::write(&leftover, b"partial").unwrap();
        let _s = ContentStore::open(dir.path()).unwrap(); // open() runs sweep_temp()
        assert!(!leftover.exists(), "a crash-leftover .tmp file must be reclaimed on open");
    }

    // put() rejects a malformed hash as a FORMAT error (ChunkHash::parse: len==64 AND all-hex) BEFORE
    // hashing the bytes. Weakening the `&&` to `||` (valid if EITHER holds) would let a bad-length /
    // non-hex hash slip past the format gate and fail later as a content mismatch instead.
    #[test]
    fn put_rejects_a_malformed_hash_as_a_format_error() {
        let dir = tempfile::tempdir().unwrap();
        let s = ContentStore::open(dir.path()).unwrap();
        // "abcd" is all-hex but only 4 chars — valid ONLY if the length check is dropped.
        let e = s.put("abcd", b"x").unwrap_err();
        assert!(e.to_string().contains("invalid chunk hash format"),
            "a malformed hash must be a FORMAT error, not a content mismatch (got: {e})");
        // A 64-char string with a non-hex char is the mirror case (right length, not hex).
        let non_hex = "g".repeat(64);
        let e2 = s.put(&non_hex, b"x").unwrap_err();
        assert!(e2.to_string().contains("invalid chunk hash format"), "got: {e2}");
    }

    // get() returns None only for a genuinely-absent blob (NotFound); any OTHER read error must
    // PROPAGATE (a permission/IO fault must never be laundered into "chunk absent"). Reading a
    // directory-at-the-blob-path errors with a kind != NotFound on both Windows and Linux.
    #[test]
    fn get_propagates_non_notfound_read_errors() {
        let dir = tempfile::tempdir().unwrap();
        let s = ContentStore::open(dir.path()).unwrap();
        let h = sha256_hex(b"z"); // a valid 64-hex hash
        let blob_path = dir.path().join(&h[0..2]).join(&h);
        std::fs::create_dir_all(&blob_path).unwrap(); // a DIRECTORY where the blob file would be
        assert!(s.get(&h).is_err(), "a non-NotFound read error must propagate, not read as absent");
    }

    // touch() resets a blob's mtime to now, so the orphan sweep measures age-since-ORPHANED (R16): a
    // long-uploaded chunk that is only just de-referenced must not look instantly reclaimable. Prove
    // the contract via its EFFECT — a touched old orphan is SPARED by a TTL that would otherwise reap it.
    #[test]
    fn touch_resets_the_orphan_age_so_an_old_chunk_is_spared() {
        let dir = tempfile::tempdir().unwrap();
        let s = ContentStore::open(dir.path()).unwrap();
        let a = b"aged"; let ha = sha256_hex(a);
        s.put(&ha, a).unwrap();
        // Backdate the blob well past the TTL so it WOULD be reclaimed...
        let p = dir.path().join(&ha[0..2]).join(&ha);
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(7200);
        std::fs::File::options().write(true).open(&p).unwrap().set_modified(old).unwrap();
        // ...then touch it: the age clock resets to now, so a 1-hour TTL sweep must SPARE it.
        s.touch(&ha);
        let empty: std::collections::HashSet<String> = std::collections::HashSet::new();
        let n = s.sweep_orphans(&empty, std::time::Duration::from_secs(3600)).unwrap();
        assert_eq!(n, 0, "a touched chunk's age is reset, so the TTL spares it");
        assert!(s.has(&ha), "the touched chunk survives the sweep");
    }
}
