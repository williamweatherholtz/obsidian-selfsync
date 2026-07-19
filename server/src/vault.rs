use crate::chunkstore::ContentStore;
use crate::hash::sha256_hex;
use crate::index_store::SqliteIndex;
use crate::protocol::{ChangesResponse, CommitRequest, Deletion, FileMeta};
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};

// ABSOLUTE backstop against an absurd/hostile declared size (prevents a u64 overflow / giant capacity
// hint before allocating). The REAL, operator-tunable per-file limit is Config::max_file_bytes (env
// MAX_FILE_MB, default 512 MiB), enforced in api::commit BEFORE we get here — so this only has to sit
// safely above any sane configured value. commit reassembles the whole body into one Vec bounded by
// req.size (already ≤ the configured limit at the api layer). (SEC-5)
const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024 * 1024; // 4 GiB absolute backstop

// SEC#4 runtime orphan GC: opportunistically reclaim ABANDONED uploads (chunks pushed but never
// committed) so a ReadWrite grantee can't grow the owner's disk unbounded between restarts (orphans
// were previously reclaimed only at startup/handle-eviction). Driven by the UPLOAD path (so it fires
// even when the attacker never commits), gated to at most once per interval, and only reclaims
// chunks older than the TTL — an in-flight upload about to be committed is younger, so it's spared.
const ORPHAN_SWEEP_INTERVAL: std::time::Duration = std::time::Duration::from_secs(300);
const ORPHAN_TTL: std::time::Duration = std::time::Duration::from_secs(3600);

// Tombstones are retained DURABLY and are NEVER dropped by an arbitrary count cap. A cap was a
// timing/size crutch: under the tombstone-authoritative delete model (0.10.25), a delete-local
// requires a real tombstone, so silently dropping the oldest tombstones makes a long-offline
// client read a genuinely-deleted file as "never had it" and RESTORE it — resurrecting deleted
// data fleet-wide (Round-6 DI finding). Tombstones are tiny (a path + a u64); the correct way to
// bound their growth is a deliberate HISTORY REBASE (reset history to a floor version + a client
// horizon + a prompted reconcile below it), tracked as historyRebase — NOT an arbitrary cap.

// Windows reserved DOS device basenames (case-insensitive, with OR without an extension) — a file
// named e.g. `con.md` maps to a device, not a file, on a Windows host: the mirror write would hang
// or error and could wedge the write. Reject them so behavior is portable. (SEC-7)
fn is_reserved_win_name(component: &str) -> bool {
    let stem = component.split('.').next().unwrap_or(component).to_ascii_lowercase();
    matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
        || ((stem.starts_with("com") || stem.starts_with("lpt"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0')
}

// @audit r2 2026-07-18 — EXEMPLARY, no change: the canonical round-trip equality (segs.join("/") == path)
// rejects the whole //, ./, trailing-slash, and separator-alias class on top of the per-component
// Normal-only / `..` / absolute / control-char / reserved-name gates — a tight defense-in-depth boundary.
pub fn safe_rel_path(path: &str) -> Option<PathBuf> {
    if path.is_empty() || path.contains('\\') || path.starts_with('/') { return None; }
    let p = PathBuf::from(path);
    if p.is_absolute() { return None; }
    let mut segs: Vec<&str> = Vec::new();
    for c in p.components() {
        match c {
            Component::Normal(seg) => {
                let s = seg.to_str()?; // reject non-UTF-8 segments
                // R20: reject ASCII control characters (incl. \n, \r, \t, NUL, ANSI ESC). A real note
                // filename never contains them, and admitting them let an authenticated writer forge or
                // spoof audit-log lines — the path is logged verbatim on commit/delete — and smuggle
                // terminal escapes into an operator's log viewer (the analogous username path is already
                // control-stripped in auth.rs; this brings the file path to parity + tightens the on-disk name).
                if s.bytes().any(|b| b.is_ascii_control()) { return None; }
                // SEC-R3#1: reject a name Windows silently strips a trailing '.' or space from (or
                // that is all dots) — the index key ("evil.md.") would then differ from the on-disk
                // name ("evil.md"), re-opening the reindex-brick (DI-4) AND evading the reserved
                // check ("aux " → device AUX). On Linux these are literal, so this is a safe superset.
                if s.ends_with('.') || s.ends_with(' ') || s.bytes().all(|b| b == b'.') { return None; }
                // SEC-R2#2: reject a name reindex's collect_files would SKIP as junk (.DS_Store,
                // .git, …). Otherwise commit could put it in the index, but reindex wouldn't find
                // it on disk → the DI-4 "indexed file missing" check aborts every repair, bricking
                // the vault permanently (a readWrite grantee could inflict this on the owner).
                if is_reserved_win_name(s) || is_junk(s) { return None; }
                segs.push(s);
            }
            _ => return None,
        }
    }
    // DI-R4#1: the index key is the RAW request path but the on-disk mirror comes from this
    // Path-normalized value, which collapses "notes//a.md" and "notes/a.md/" → "notes/a.md".
    // Reject any input that isn't already its own canonical forward-slash form, so the index key
    // can never alias a different on-disk file (silent overwrite) or desync from it (reindex brick).
    if segs.join("/") != path { return None; }
    Some(p)
}

// Round-6 DI: names that reindex must refuse — a name commit would reject (safe_rel_path None) or
// a pair that folds to the same lowercase key (would collapse to one file on a case-insensitive
// client FS, causing overwrite + phantom-delete churn). Pure over the rel names so it's testable
// cross-platform (the real collision only materializes on a case-sensitive server FS).
// @audit r2 2026-07-18 — clean, no change: whole-path to_lowercase matches commit's colliding_key fold,
// and within-batch collision detection is the right scope for a full reindex rebuild.
fn conflicting_or_unsafe_rels(rels: &[String]) -> Vec<String> {
    let mut fold: HashMap<String, String> = HashMap::new();
    let mut bad: Vec<String> = Vec::new();
    for rel in rels {
        if safe_rel_path(rel).is_none() { bad.push(format!("{rel} (unsafe name)")); continue; }
        if let Some(prev) = fold.insert(rel.to_lowercase(), rel.clone()) {
            bad.push(format!("{rel} vs {prev} (case/fold collision)"));
        }
    }
    bad
}

// Atomically mirror a committed file to the bind-mount path (create parents, write a sibling temp,
// then rename), so a crash mid-write never leaves a torn bind-mount file. (DI-3)
fn write_mirror(abs: &Path, body: &[u8]) -> std::io::Result<()> {
    if let Some(p) = abs.parent() { std::fs::create_dir_all(p)?; }
    let name = abs.file_name().and_then(|s| s.to_str()).unwrap_or("f");
    let tmp = abs.with_file_name(format!(".{name}.selfsync-tmp"));
    // R14-DI4: fsync the temp contents + parent dir before/after rename, matching atomic_write + the
    // chunk store. The index + chunk store are authoritative, so a torn mirror is normally harmless —
    // but if the index is ALSO lost, reindex rebuilds from this mirror (see reindex's disk-rebuild
    // path), and a power-loss-torn/zero-length mirror file would then be ingested as authoritative.
    {
        use std::io::Write;
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(body)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, abs)?;
    if let Some(dir) = abs.parent() {
        if let Ok(d) = std::fs::File::open(dir) { let _ = d.sync_all(); }
    }
    Ok(())
}

// A file recoverable from the authoritative chunk store during reindex: (key, its index meta, the
// reassembled + hash-verified body). Named so classify_missing's return type stays legible.
type Recovered = (String, FileMeta, Vec<u8>);

// The vault's index-health lifecycle, an EXPLICIT state machine (crit R+1, issueVaultLifecycleImplicitFsm)
// replacing the old `corrupt` + `dangling_recovery` bool PAIR — which could represent the illegal combo
// (corrupt=false, dangling=true) and encoded transitions as scattered flag-sets. Only Ok serves sync ops
// (ensure_ready/is_corrupt); Corrupt/DanglingRecovery both await reindex, differing in whether the index
// is TRUSTWORTHY during the rebuild.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum VaultState {
    Ok,               // healthy: sync ops proceed.
    // The persisted index couldn't be trusted (unreadable DB, or an EMPTY index with materialized files
    // present). The vault OPENS (process survives; operator can inspect) but refuses every sync op until
    // reindex() rebuilds the manifest from disk — "fail loud, require explicit repair", NOT silent reset
    // (a blank index would advertise an empty vault and our hash-based reconcile could read "delete all").
    // reindex does a BLIND rebuild-from-disk here (the index is untrustworthy).
    Corrupt,
    // A dangling chunk reference on an otherwise INTACT index (all file rows + tombstones present) — only
    // a blob is missing, not the index. reindex treats the index as TRUSTWORTHY (keeps the R18 tombstone
    // ghost-skip + the prefer-store guard, so a dangling repair can't resurrect a ghost or adopt a stale
    // mirror). A FAILED dangling-repair downgrades to Corrupt (the one-shot in reindex).
    DanglingRecovery,
}

pub struct Vault {
    root: PathBuf,
    vault_dir: PathBuf,
    store: ContentStore,
    // The per-vault index: a SQLite (WAL) DB (D0018). Behind a Mutex internally so the Vault is Sync
    // and drops into Arc<RwLock<Vault>> as axum state. The index is a DERIVED view — the source of
    // truth is the chunk store + the bind-mount mirror — so a corrupt index is repaired by reindex.
    index: SqliteIndex,
    // The index-health lifecycle (see VaultState above). Was two bools; now one enum (no illegal combo).
    state: VaultState,
    // Current version, cached in lockstep with the index on every mutation, so version() is a field
    // read (hot /status path) rather than a DB round-trip.
    version: u64,
    // Deletion-history floor (D0019), cached from the index. Raised to the current version when a
    // reindex rebuilds from disk (tombstones unrecoverable — history reset). Reported to clients so a
    // below-floor client stays conservative (keep + push + a batched notice), never resurrecting silently.
    history_floor: u64,
    // SEC#4: wall-clock of the last runtime orphan sweep. Behind a Mutex so the upload path (which
    // holds only a shared read lock) can gate the sweep without &mut. Interior mutability, not vault state.
    last_orphan_sweep: std::sync::Mutex<std::time::Instant>,
}

impl Vault {
    pub fn open(root: &Path) -> std::io::Result<Self> {
        let vault_dir = root.join("vault");
        std::fs::create_dir_all(&vault_dir)?;
        let store = ContentStore::open(&root.join(".chunks"))?;
        let db_path = root.join(".sync-index.db");
        // Open the SQLite index. A genuinely-corrupt DB (bit-rot, truncation) fails to open; rather
        // than brick the vault (a corrupt DB would 500 every request AND block reindex, which needs
        // an open vault), quarantine the bad DB, open a FRESH empty index, and mark ERROR so the
        // operator reindexes from the authoritative chunk store + materialized files. The index is a
        // derived view, so discarding a corrupt one and rebuilding is safe — this mirrors the old
        // corrupt-JSON "open in ERROR, require reindex" behavior.
        let (index, mut corrupt) = match SqliteIndex::open(&db_path) {
            Ok(idx) => (idx, false),
            // R14-DI1: a NEWER-schema DB (downgrade guard, ErrorKind::Unsupported) is INTACT and
            // authoritative — refuse HARD, never quarantine. Quarantining here would open a fresh
            // empty index and reindex-from-disk, permanently destroying tombstones + rewinding the
            // version epoch (→ fleet-wide resurrection) and dropping any file whose mirror write had
            // failed. The safe recovery is "restore the correct (newer) binary", so surface the error.
            Err(e) if e.kind() == std::io::ErrorKind::Unsupported => {
                log::error!("[vault] {}: {e}", root.display());
                return Err(e);
            }
            Err(e) => {
                log::error!("[vault] {} index DB is CORRUPT ({e}); quarantining + opening in ERROR state — run reindex", root.display());
                Self::quarantine_db(&db_path);
                (SqliteIndex::open(&db_path)?, true) // fresh empty DB
            }
        };
        // crit R+1 (issueVersionEpochRewind): the index version RESETS to 1 on a quarantine/empty rebuild
        // (the index is the only home of the counter). An already-synced client at a higher cursor would
        // then never see the rebuilt versions in any incremental delta, and the RC-1 floor (which only
        // protects a BELOW-floor client) stays inert. A monotonic high-water mark in a separate fsync'd
        // sidecar (.version-hwm) survives an index corruption; seed from the max so the counter — and any
        // rebuild below, which assigns from self.version upward — never drops below the true high-water.
        let version = index.version()?.max(Self::read_version_hwm(root));
        let history_floor = index.history_floor()?;
        // A MISSING/empty index is only "fresh" when there are NO materialized files. Committed files
        // live in vault/; if any exist but the index is empty (e.g. a backup restored without the DB),
        // opening blank would let clients mass-delete against the empty manifest AND wipe chunks —
        // open ERROR instead and require reindex. Fail CLOSED: if we can't scan the vault dir, we
        // can't prove it's empty → treat as data-present (ERROR) rather than open blank.
        if !corrupt && index.all_paths()?.is_empty() {
            let mut existing = Vec::new();
            let scan_ok = collect_files(&vault_dir, &vault_dir, &mut existing).is_ok();
            if !existing.is_empty() || !scan_ok {
                log::error!("[vault] {} has data but an EMPTY index — opening in ERROR state; run reindex to rebuild", root.display());
                corrupt = true;
            }
        }
        let mut v = Vault {
            root: root.to_path_buf(), vault_dir, store, index,
            state: if corrupt { VaultState::Corrupt } else { VaultState::Ok },
            version, history_floor,
            last_orphan_sweep: std::sync::Mutex::new(std::time::Instant::now()),
        };
        if v.state == VaultState::Ok { v.verify_and_gc(); } // startup GC already clears orphans, so the runtime timer starts now
        // D0022: AUTO-REPAIR where safe. If the index is unusable (empty-with-data / corrupt DB /
        // dangling chunk ref) but the authoritative files + chunk store can rebuild it, do so
        // automatically instead of locking the vault for a manual reindex — safe now that
        // tombstone-authoritative delete + the D0019 horizon mean a rebuilt index can never make a
        // client delete. Stay ERROR only when a rebuild genuinely can't fix it (a file lost from BOTH
        // disk and the store → RC-2, or unsafe/colliding filenames), which needs a human (Force / rename).
        if v.state != VaultState::Ok {
            match v.reindex(false) {
                Ok(()) => log::info!("[vault] {}: auto-repaired the index (reindexed from disk).", v.root.display()),
                Err(e) => log::error!("[vault] {}: index unusable and NOT auto-repairable ({e}); staying in ERROR — run reindex with Force if files are truly lost, or fix the offending filenames.", v.root.display()),
            }
        }
        Ok(v)
    }

    // crit R+1 (issueVersionEpochRewind): the monotonic version high-water sidecar. A tiny fsync'd file
    // next to the index, read on open to floor the version and rewritten on every bump — so a quarantine
    // that resets the index counter can't rewind the vault's version below an already-synced client.
    fn version_hwm_path(root: &Path) -> PathBuf { root.join(".version-hwm") }
    fn read_version_hwm(root: &Path) -> u64 {
        std::fs::read_to_string(Self::version_hwm_path(root)).ok()
            .and_then(|s| s.trim().parse::<u64>().ok()).unwrap_or(0)
    }
    // Persist self.version as the high-water (fsync-durable via atomic_write). Best-effort: the index is
    // the primary record of the current version; the sidecar is the anti-rewind backstop, so a write
    // failure is logged, not fatal to an already-durable commit.
    fn write_version_hwm(&self) {
        if let Err(e) = crate::atomicfile::atomic_write(&Self::version_hwm_path(&self.root), self.version.to_string().as_bytes()) {
            log::warn!("[vault] {}: version high-water sidecar not persisted ({e}); index still authoritative", self.root.display());
        }
    }

    // Move a corrupt index DB (+ its WAL/SHM sidecars) aside so a fresh one can be created; the
    // quarantined copy is kept (renamed `.corrupt`) for forensics. Best-effort — the fresh open is
    // what matters, so a rename failure falls back to removing the unusable file.
    fn quarantine_db(db_path: &Path) {
        let base = db_path.to_string_lossy().to_string();
        for suffix in ["", "-wal", "-shm"] {
            let p = PathBuf::from(format!("{base}{suffix}"));
            if p.exists() {
                let bak = PathBuf::from(format!("{base}{suffix}.corrupt"));
                let _ = std::fs::remove_file(&bak); // clear a stale quarantine first
                if std::fs::rename(&p, &bak).is_err() { let _ = std::fs::remove_file(&p); }
            }
        }
    }

    // Startup integrity pass — safe because `open` runs before the handle is published, so there are
    // no concurrent uploads/commits:
    //   * dangling reference (index cites a chunk with no blob on disk) → mark the vault ERROR so the
    //     operator reindexes (rebuilds from the intact materialized files). This catches a crash
    //     between a blob removal and its would-be persist.
    //   * orphan blob (on disk but unreferenced — e.g. uploaded then the client dropped before
    //     committing) → reclaim it (bounded disk leak, B5).
    fn verify_and_gc(&mut self) {
        let referenced = match self.index.all_referenced_chunks() {
            Ok(r) => r,
            Err(e) => {
                log::error!("[vault] {}: index read failed ({e}); marking ERROR — run reindex", self.root.display());
                self.state = VaultState::Corrupt; // unreadable index → blind rebuild-from-disk
                return;
            }
        };
        let refset: std::collections::HashSet<String> = referenced.into_iter().collect();
        let missing: Vec<&String> = refset.iter().filter(|h| !self.store.has(h)).collect();
        if !missing.is_empty() {
            log::error!(
                "[vault] {}: {} referenced chunk(s) missing on disk (e.g. {}); marking ERROR — run reindex",
                self.root.display(), missing.len(), missing[0]
            );
            // R19: the index ITSELF is intact (rows + tombstones present) — only a chunk blob is gone.
            // DanglingRecovery makes the auto-repair reindex TRUST the index (keeps the ghost-skip +
            // prefer-store guards) instead of rebuilding blindly from disk.
            self.state = VaultState::DanglingRecovery;
            return; // don't GC a vault we're about to rebuild
        }
        match self.store.list_hashes() {
            Ok(hashes) => {
                let mut reclaimed = 0usize;
                for h in hashes {
                    if !refset.contains(&h) && self.store.remove(&h).is_ok() { reclaimed += 1; }
                }
                if reclaimed > 0 {
                    log::info!("[vault] {}: reclaimed {reclaimed} orphan chunk(s)", self.root.display());
                }
            }
            Err(e) => log::warn!("[vault] {}: orphan GC skipped (list failed: {e})", self.root.display()),
        }
    }

    // True while the persisted index was corrupt/empty-with-data and has not yet been reindexed.
    pub fn is_corrupt(&self) -> bool { self.state != VaultState::Ok }

    // Rebuild the manifest from the materialized bind-mount files — the operator's explicit repair
    // for a corrupt index (and safe to run on a healthy vault). Version-PRESERVING: a file whose
    // bytes are unchanged keeps its old version, so clients see no spurious change. Files are
    // re-ingested as WHOLE-FILE chunks (FastCDC boundaries live only client-side); dedup
    // re-establishes as clients next edit each file. Deterministic: same files -> same mapping.
    //
    // `force` (Round-7 RC-2): when a file is missing from disk AND unrecoverable from the chunk store
    // (truly gone), reindex normally ABORTS to preserve the DI-4 no-silent-drop guarantee. `force`
    // lets an authorized operator drop those provably-lost entries so the REST of the vault can be
    // repaired instead of the whole repair bricking permanently.
    pub fn reindex(&mut self, force: bool) -> std::io::Result<()> {
        // Round-6 DI: capture whether the index was CORRUPT before we clear the flag. When it was NOT
        // corrupt (an operator running reindex on a healthy vault, which the docs allow), the index is
        // trustworthy and the chunk store is AUTHORITATIVE — prefer it over the bind-mount mirror,
        // which can be stale after a best-effort mirror-write failure. Only a genuinely-corrupt index
        // forces a rebuild from disk bytes.
        // R19: a DANGLING-chunk auto-repair is NOT a true corruption — the index (rows + tombstones)
        // is intact, only a blob is missing. Treat it as a healthy reindex so the tombstone ghost-skip
        // and the prefer-store guard stay active (otherwise a dangling repair could resurrect a
        // tombstoned ghost or rebuild an intact file from a stale mirror). Only an UNREADABLE/empty
        // index (dangling_recovery == false) forces the blind rebuild-from-disk.
        let was_corrupt = self.state == VaultState::Corrupt;
        // R19 one-shot: consume the dangling flag — a DanglingRecovery that FAILS to reindex downgrades to
        // Corrupt (a full rebuild next time). (was_corrupt was captured above as false for DanglingRecovery,
        // so this reindex still TRUSTS the intact index; only an abort leaves it Corrupt.)
        if self.state == VaultState::DanglingRecovery { self.state = VaultState::Corrupt; }
        // The current manifest (empty when the DB was corrupt/blank). Also note whether the index
        // still HOLDS tombstones: replace_files preserves the deletions table, so a rebuild that keeps
        // them (e.g. a dangling-chunk auto-repair on an otherwise-intact index) must NOT raise the
        // history floor — the deletion history is still complete. Only a rebuild where tombstones were
        // genuinely LOST (an empty/quarantined index) resets history. (critique-R8 DI-M3.)
        let old = self.index.changes(0)?;
        let had_tombstones = !old.deletes.is_empty();
        // R18: paths the index has a TOMBSTONE for. A disk file whose path is tombstoned but has NO
        // live index entry is a GHOST — a delete whose best-effort mirror removal failed. On a HEALTHY
        // reindex the tombstones are trustworthy, so such a ghost must NOT be re-ingested (that would
        // resurrect a genuine deletion fleet-wide); it's dropped below. (Skipped when was_corrupt — a
        // corrupt index's deletions are as untrustworthy as everything else, so disk is truth there.)
        let tombstoned: std::collections::HashSet<String> = old.deletes.iter().map(|d| d.path.clone()).collect();
        let old_files: HashMap<String, FileMeta> =
            old.upserts.into_iter().map(|m| (m.path.clone(), m)).collect();
        let old_refs: Vec<String> = self.index.all_referenced_chunks()?;
        let mut new_files: Vec<FileMeta> = Vec::new();
        let mut new_refs: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut max_version = self.version;
        let mut rels: Vec<(String, PathBuf)> = Vec::new();
        collect_files(&self.vault_dir, &self.vault_dir, &mut rels)?;
        rels.sort(); // deterministic version assignment order
        let present: std::collections::HashSet<&str> = rels.iter().map(|(rel, _)| rel.as_str()).collect();
        // Round-7 RC-2 / R14-DI2: classify indexed files ABSENT from disk into RECOVERED (re-materializable
        // from the AUTHORITATIVE chunk store AND hash-verified) vs truly LOST (chunks gone, or a bit-rotted
        // chunk reassembling to the wrong hash). A best-effort mirror write can fail, leaving content in the
        // store but not on disk; a lost file aborts the reindex unless `force` (DI-4 no-silent-drop). Each
        // recovered entry carries its (key, meta, VERIFIED body) together, so re-materialization below needs
        // no second lookup and no invariant-asserting expect(). (See classify_missing.)
        let (recovered, mut lost) = self.classify_missing(&old_files, &present)?;
        if !lost.is_empty() && !force {
            lost.sort();
            return Err(std::io::Error::new(std::io::ErrorKind::NotFound,
                format!("reindex aborted: {} indexed file(s) missing from disk and unrecoverable from the chunk store: {}. Re-run with force to drop them (their content is already gone) and recover the rest.", lost.len(), lost.join(", "))));
        }
        // Round-6 DI: reindex must not mint index keys that commit would reject or that collide under
        // filesystem folding — check both on-disk names AND the recovered keys we re-materialize.
        let mut names: Vec<String> = rels.iter().map(|(r, _)| r.clone()).collect();
        names.extend(recovered.iter().map(|(k, ..)| k.clone()));
        let bad = conflicting_or_unsafe_rels(&names);
        if !bad.is_empty() {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput,
                format!("reindex aborted: {} path(s) unsafe or colliding — resolve on disk first: {}", bad.len(), bad.join("; "))));
        }
        // Re-materialize recoverable files from the store (keep the authoritative index entry, write
        // the mirror so disk matches). A parse-corrupt index is empty here, so `recovered` is empty
        // then — nothing to recover, and the full disk rebuild below proceeds.
        for (k, meta, body) in recovered {
            // Body was reassembled + hash-verified during classification (R14-DI2) — no re-fetch, no expect().
            if let Some(rel) = safe_rel_path(&k) {
                if let Err(e) = write_mirror(&self.vault_dir.join(&rel), &body) {
                    log::warn!("[reindex] could not re-materialize '{k}': {e} (content remains in the chunk store)");
                }
            }
            for h in &meta.chunks { new_refs.insert(h.clone()); }
            new_files.push(meta);
        }
        for (rel, abs) in rels {
            // R18: a disk file that is TOMBSTONED but has no live index entry is a ghost left by a
            // delete whose mirror removal failed. Re-ingesting it would resurrect the deletion (the
            // preserved tombstone + a fresh upsert would BOTH appear in changes(0), and clients pull it
            // back). On a healthy reindex the deletion is authoritative — drop the stale mirror, don't
            // re-ingest. (Only when NOT was_corrupt: a corrupt index's tombstones aren't trustworthy.)
            // (No !was_corrupt guard — R19: for a genuinely-unreadable index `tombstoned` is empty, so
            // this is inert there anyway; keying purely on the tombstone makes it fire for a dangling
            // auto-repair too, closing the resurrection-via-auto-repair path.)
            if tombstoned.contains(&rel) && !old_files.contains_key(&rel) {
                let _ = std::fs::remove_file(&abs);
                continue;
            }
            // Round-6 DI (prefer authoritative store): on a HEALTHY reindex, if the current index
            // already maps this path and all its chunks are present in the store, keep that entry
            // VERBATIM (content + version + real chunk list) instead of re-hashing the mirror — which
            // could revert the file to stale bytes left by a failed mirror write. Rebuild from disk
            // only when the index was corrupt (untrustworthy) or a chunk is missing.
            if !was_corrupt {
                if let Some(old) = old_files.get(&rel) {
                    if !old.chunks.is_empty() && old.chunks.iter().all(|h| self.store.has(h)) {
                        for h in &old.chunks { new_refs.insert(h.clone()); }
                        new_files.push(old.clone());
                        continue;
                    }
                }
            }
            let body = std::fs::read(&abs)?;
            let hash = sha256_hex(&body);
            // Content-defined chunking (matches the client chunker exactly, chunker.rs) so a reindexed
            // file dedups against client-uploaded chunks and a large file is NOT stored as one giant blob
            // that getVerifiedChunk buffers whole (OOM risk on mobile) — issueReindexSingleChunk. The
            // whole-file `hash` stays FileMeta.hash (integrity + version key); the manifest references the
            // per-chunk hashes, and each chunk (content-addressed, idempotent) is stored + GC-referenced.
            let parts = crate::chunker::chunk(&body);
            for (ch, bytes) in &parts { self.store.put(ch, bytes)?; new_refs.insert(ch.clone()); }
            let chunk_hashes: Vec<String> = parts.into_iter().map(|(h, _)| h).collect();
            let mtime = std::fs::metadata(&abs)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            // version-preserving: unchanged path+hash keeps its version
            let version = match old_files.get(&rel) {
                Some(old) if old.hash == hash => old.version,
                _ => { max_version += 1; max_version }
            };
            new_files.push(FileMeta { path: rel, hash, size: body.len() as u64, mtime, version, chunks: chunk_hashes });
        }
        // Publish the rebuilt manifest FIRST (the new index becomes authoritative), THEN GC chunks it
        // no longer references — so a GC'd blob is never still cited by the live index.
        self.index.replace_files(&new_files, max_version)?;
        self.version = max_version;
        self.write_version_hwm(); // crit R+1: persist the high-water so a future rebuild can't rewind below it
        // D0019 + critique-R8 DI-M3: raise the floor ONLY when tombstones were genuinely lost — a
        // rebuild-from-disk of an empty/quarantined index (no tombstones to preserve). A rebuild that
        // PRESERVED tombstones (a dangling-chunk auto-repair on an intact index — was_corrupt set by
        // verify_and_gc, but deletions kept) leaves the floor alone: history is still complete, so a
        // spurious floor bump (→ false client "history reset" notices + keep-push churn) is avoided.
        if was_corrupt && !had_tombstones {
            self.index.set_history_floor(max_version)?;
            self.history_floor = max_version;
        }
        self.state = VaultState::Ok;
        for h in &old_refs {
            if !new_refs.contains(h) { let _ = self.store.remove(h); }
        }
        Ok(())
    }

    // Classify each indexed file ABSENT from disk (Round-7 RC-2 / R14-DI2). RECOVERED = reassembles from
    // the authoritative chunk store AND matches its recorded hash — returned with its meta + VERIFIED body
    // so reindex re-materializes it without a second lookup or an invariant-asserting expect(). Everything
    // else — chunks gone, or a present-but-bit-rotted chunk reassembling to the wrong hash — is LOST (never
    // laundered into authoritative state; reindex aborts on it unless `force`). A parse-corrupt index has no
    // old_files, so both lists come back empty and the full disk rebuild governs.
    fn classify_missing(
        &self, old_files: &HashMap<String, FileMeta>, present: &std::collections::HashSet<&str>,
    ) -> std::io::Result<(Vec<Recovered>, Vec<String>)> {
        let mut recovered: Vec<Recovered> = Vec::new();
        let mut lost: Vec<String> = Vec::new();
        for (k, meta) in old_files {
            if present.contains(k.as_str()) { continue; }
            let mut body = Vec::new();
            let mut have_all = !meta.chunks.is_empty();
            for h in &meta.chunks {
                match self.store.get(h)? { Some(c) => body.extend_from_slice(&c), None => { have_all = false; break; } }
            }
            if have_all && sha256_hex(&body) == meta.hash {
                recovered.push((k.clone(), meta.clone(), body));
            } else {
                lost.push(k.clone());
            }
        }
        Ok((recovered, lost))
    }

    // Deliberate operator history prune (tombstonePrune / D0019): drop tombstones below `floor` and
    // raise the deletion-history floor to it. Clamps floor to [current floor, current version] so it's
    // monotonic and never claims completeness beyond what exists. Returns the count pruned. Reclaims
    // tombstone space; a client left below the raised floor reconciles conservatively (the horizon).
    pub fn prune_history(&mut self, requested_floor: u64) -> std::io::Result<usize> {
        let floor = requested_floor.clamp(self.history_floor, self.version);
        let n = self.index.prune_tombstones(floor)?;
        self.history_floor = floor;
        Ok(n)
    }

    pub fn has_chunk(&self, hash: &str) -> bool { self.store.has(hash) }
    pub fn put_chunk(&self, hash: &str, bytes: &[u8]) -> std::io::Result<()> {
        self.store.put(hash, bytes)?;
        self.maybe_sweep_orphans(); // SEC#4: opportunistic, interval-gated runtime orphan GC
        Ok(())
    }

    // SEC#4: reclaim abandoned uploads at runtime, at most once per ORPHAN_SWEEP_INTERVAL. Cheap when
    // not due (a lock + an elapsed check). Runs under the caller's shared read lock, which excludes
    // any concurrent commit (that takes the write lock), so the referenced set can't shift mid-sweep;
    // the TTL spares just-uploaded chunks. A corrupt vault never sweeps — reindex owns its blobs.
    fn maybe_sweep_orphans(&self) {
        if self.state != VaultState::Ok { return; }
        let due = {
            let Ok(mut last) = self.last_orphan_sweep.lock() else { return; };
            if last.elapsed() < ORPHAN_SWEEP_INTERVAL { return; }
            *last = std::time::Instant::now();
            true
        };
        if !due { return; }
        let referenced: std::collections::HashSet<String> = match self.index.all_referenced_chunks() {
            Ok(r) => r.into_iter().collect(),
            Err(e) => { log::warn!("[vault] {}: orphan sweep skipped (index read failed: {e})", self.root.display()); return; }
        };
        match self.store.sweep_orphans(&referenced, ORPHAN_TTL) {
            Ok(n) if n > 0 => log::info!("[vault] {}: runtime orphan sweep reclaimed {n} abandoned chunk(s)", self.root.display()),
            Ok(_) => {}
            Err(e) => log::warn!("[vault] {}: orphan sweep failed: {e}", self.root.display()),
        }
    }
    pub fn get_chunk(&self, hash: &str) -> std::io::Result<Option<Vec<u8>>> { self.store.get(hash) }
    pub fn missing(&self, hashes: &[String]) -> Vec<String> {
        hashes.iter().filter(|h| !self.store.has(h)).cloned().collect()
    }
    pub fn version(&self) -> u64 { self.version }

    pub fn commit(&mut self, req: CommitRequest) -> std::io::Result<FileMeta> {
        let rel = safe_rel_path(&req.path)
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "bad path"))?;
        // Reject a case-only / Unicode-fold collision: two index keys folding to ONE file on a
        // case-insensitive FS, which a later reindex would collapse (phantom deletion). (PROTO-4 /
        // DI-R5#1 — the `fold` column matches Rust's full-Unicode to_lowercase, not SQLite's ASCII
        // lower()). InvalidInput (→ 400): a permanent, client-side-fixable bad request, kept distinct
        // from the CAS AlreadyExists below (→ 409, so the client re-reconciles rather than skips).
        if self.index.colliding_key(&req.path)?.is_some() {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "a path differing only in case already exists"));
        }
        // Reject a hostile/absurd declared size before allocating (a client-supplied u64 must never
        // drive a capacity hint — 2^60 would panic/abort).
        if req.size > MAX_FILE_BYTES {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "file exceeds size limit"));
        }
        // reassemble from chunks (all must be present). Grow from empty — never pre-size from the
        // untrusted hint; the size/hash check below verifies the real bytes.
        let mut body = Vec::new();
        for h in &req.chunks {
            let c = self.store.get(h)?
                .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, format!("missing chunk {h}")))?;
            body.extend_from_slice(&c);
            // Bound the running total: req.chunks may repeat a hash arbitrarily, so cap reassembly at
            // the declared size (already ≤ MAX_FILE_BYTES) — aborts a "one small chunk × 250k repeats
            // → 250 GB in RAM" DoS before it grows.
            if body.len() as u64 > req.size {
                return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "reassembled size exceeds declared size"));
            }
        }
        if body.len() as u64 != req.size || sha256_hex(&body) != req.hash {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "file hash/size mismatch"));
        }
        // Read the current row ONCE and reuse it for both the idempotent short-circuit and the CAS
        // check below — the row can't change between them (this commit holds the write lock via
        // &mut self), so a second query would be a redundant round-trip and a second read to reconcile.
        let existing = self.index.file_meta(&req.path)?;
        // Idempotent re-commit: identical path+hash+chunks already recorded → return it unchanged,
        // with no version bump, no persist, and no broadcast — so a client retry after a transient
        // error is a genuine no-op instead of version churn + a spurious "changed". (protocol-5)
        if let Some(m) = &existing {
            if m.hash == req.hash && m.chunks == req.chunks {
                return Ok(m.clone());
            }
        }
        // Optimistic concurrency (CAS): if the client declared the version it based this write on,
        // reject when the server has since advanced past it. Two clients both at base v3 that edit and
        // commit concurrently would otherwise both push: the write lock serializes them, the second
        // silently overwrites the first, and the first committer later pulls it (a lost update). With
        // CAS the second commit sees current != expected and 409s; the client then re-reconciles and
        // MERGES the intervening change. Runs AFTER the idempotent short-circuit (a same-content retry
        // is a no-op, never a conflict) and only when the client opted in (an authoritative
        // switch/adjudication omits it). AlreadyExists → 409 in the API layer.
        if let Some(expected) = req.expected_version {
            let current = existing.as_ref().map(|m| m.version).unwrap_or(0);
            if expected != current {
                return Err(std::io::Error::new(std::io::ErrorKind::AlreadyExists,
                    format!("version conflict on '{}': client based on v{expected}, server at v{current}", req.path)));
            }
        }
        // Atomically upsert the new version. The SQLite transaction in put() IS the durability +
        // all-or-nothing guarantee that the old append-only journal + manual rollback provided: on
        // any failure the transaction rolls back and self.version is left untouched (we advance it
        // only after put() returns Ok). put() returns the chunks now referenced by NO file, to drop
        // AFTER the index is durable.
        let new_version = self.version + 1;
        let meta = FileMeta {
            path: req.path.clone(), hash: req.hash, size: req.size, mtime: req.mtime,
            version: new_version, chunks: req.chunks,
        };
        let dereferenced = self.index.put(&meta)?;
        self.version = new_version;
        self.write_version_hwm(); // crit R+1 (issueVersionEpochRewind): advance the monotonic version sidecar
        // Index is durable. NOW mirror to the bind-mount file — AFTER the index, via atomic
        // temp+rename, so disk is never ahead of the durable index. A crash before this leaves the
        // OLD file, and reindex recovers the committed content from the authoritative chunk store
        // (DI-3). Best-effort: the authoritative bytes live in the store (served by get_chunk), so a
        // mirror-write failure is a recoverable mismatch, not a lost commit.
        let abs = self.vault_dir.join(&rel);
        if let Err(e) = write_mirror(&abs, &body) {
            log::warn!("[commit] bind-mount mirror write failed for '{}': {e} (content is durable in the chunk store)", req.path);
        }
        // Index is durable. De-referenced blobs (chunks the OLD version cited that this version drops)
        // are TOUCHED, not removed eagerly (R16) — the same rename/dedup TOCTOU as the delete path:
        // with file-level concurrency, file A editing away chunk Y while file B concurrently adds Y via
        // dedup could have this commit remove Y between B's missing()=present and B's commit → 404.
        // Touching bumps Y's mtime so the sweep's TTL measures age-since-orphaned; a chunk still (about
        // to be) referenced is young + spared, a genuine orphan is reclaimed later. Startup GC + the
        // upload-path sweep do the actual reclamation.
        for h in &dereferenced { self.store.touch(h); }
        Ok(meta)
    }

    // @audit r2 2026-07-18 — FIXED (idiom): the mirror removal was exists()-then-remove_file (a double
    // stat + a TOCTOU window); now a single remove_file that stays quiet on NotFound. The DI-R5#4
    // delete-by-raw-key + durable-before-mirror-removal design is correct — left as-is.
    // @audit-hash sha256:3f932351b032f42e
    pub fn delete(&mut self, path: &str) -> std::io::Result<Option<Deletion>> {
        // DI-R5#4: a file committed BEFORE safe_rel_path was tightened (or ingested via the bind mount
        // + reindex, which doesn't apply safe_rel_path) may be an index key that no longer passes
        // safe_rel_path. It must still be DELETABLE — index.delete evicts by the exact raw key
        // regardless of name validity; otherwise a client's delete-remote 404-loops forever and the
        // tombstone never propagates. Only the on-disk mirror removal is skipped for a rejected name
        // (there's no safe rel path to join).
        let rel = safe_rel_path(path);
        let new_version = self.version + 1;
        match self.index.delete(path, new_version)? {
            None => Ok(None), // absent (or a bad name that isn't an index key) → nothing to delete
            Some((d, dereferenced)) => {
                self.version = new_version;
                self.write_version_hwm(); // crit R+1 (issueVersionEpochRewind): advance the monotonic version sidecar
                // Durable; now remove the materialized file. Only when the name has a valid rel path (a
                // legacy invalid-name key has no on-disk target).
                if let Some(rel) = rel {
                    let abs = self.vault_dir.join(rel);
                    if let Err(e) = std::fs::remove_file(&abs) {
                        if e.kind() != std::io::ErrorKind::NotFound {
                            log::warn!("[vault] delete persisted but bind-mount file {} not removed: {e}", abs.display());
                        }
                    }
                }
                // De-referenced chunk blobs are NOT removed eagerly (R15 sync#1/DI#2 + R16). Eager
                // removal raced a concurrent commit of the SAME content under a NEW path (a rename):
                // file-level reconcile concurrency pushes the delete + the create in one pass, and the
                // create's `missing()` sees the chunk present → skips upload → but the delete removed
                // it → the create's commit 404s → the moved file vanishes fleet-wide until the full
                // scan. We instead TOUCH the de-referenced chunks (bump mtime = "orphaned now") so the
                // orphan sweep's TTL measures age-since-orphaned: a chunk a concurrent rename is about
                // to re-reference is young and spared; a genuinely-abandoned chunk is reclaimed TTL
                // later by the upload-path / startup sweep. Touch never removes → no new race.
                for h in &dereferenced { self.store.touch(h); }
                Ok(Some(d))
            }
        }
    }

    // Metadata for a single path (or None) — lets a client reconcile one file without fetching the
    // whole manifest. A read error is exceptional (the DB opened + passed verify) → log + treat as
    // absent; the client re-fetches next poll.
    pub fn file_meta(&self, path: &str) -> Option<FileMeta> {
        self.index.file_meta(path).unwrap_or_else(|e| {
            log::warn!("[vault] {}: file_meta({path}) read failed: {e}", self.root.display());
            None
        })
    }

    pub fn changes(&self, since: u64) -> ChangesResponse {
        self.index.changes(since).unwrap_or_else(|e| {
            // A read error here is exceptional (the DB opened + passed verify). Return an empty delta
            // at the CLIENT'S OWN cursor (`since`), NOT self.version (R18): reporting the current
            // version with empty changes would make the incremental client advance its cursor to
            // `version` and LEAPFROG the real commits between `since` and now — they'd only reappear on
            // the 15-min full scan. Echoing `since` reads as "no change" (delta.version == cursor), so
            // the client holds its cursor and simply retries on the next poll. Tombstone-authoritative
            // delete means empty upserts/deletes still can't trigger a mass-delete.
            log::warn!("[vault] {}: changes({since}) read failed: {e}; echoing the client's cursor so it retries (no leapfrog)", self.root.display());
            ChangesResponse { version: since, upserts: Vec::new(), deletes: Vec::new(), history_floor: self.history_floor }
        })
    }
}

// OS/tooling junk that must never count as vault data (would trip the missing-index ERROR check and
// get re-ingested by reindex). `.obsidian` config is NOT junk.
fn is_junk(name: &str) -> bool {
    matches!(name, ".DS_Store" | "Thumbs.db" | "desktop.ini" | ".git")
        // R20: a leftover write_mirror atomic-write temp (a crash between its fsync and the rename
        // leaves a complete-content `.<name>.selfsync-tmp` in vault/). It's never a real note; excluding
        // it here keeps reindex from ingesting it as a phantom file that would propagate fleet-wide, and
        // makes safe_rel_path reject the suffix so a commit can't mint such an index key either.
        || name.ends_with(".selfsync-tmp")
        // R21: the SYMMETRIC client-side temp. The plugin streams a download into `<name>.selfsync-part`
        // then renames; a crash mid-download orphans a VISIBLE (non-dotfile) partial in the vault, which
        // the client would otherwise push and the server accept as a real note (torn content, fleet-wide).
        // Reject it on the server too so a stale/buggy client can never mint such an index key.
        || name.ends_with(".selfsync-part")
}

// Recursively collect every file under `dir` as (forward-slash rel path, abs path), relative to
// `base`. Used by reindex to rebuild the manifest from materialized files.
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

    #[test]
    fn safe_rel_path_rejects_windows_reserved_device_names() {
        // SEC-7: reserved DOS device basenames (with or without extension, any case) are rejected.
        for bad in ["con", "CON", "nul.md", "aux.txt", "com1", "LPT9.dat", "sub/con.md", "prn"] {
            assert!(safe_rel_path(bad).is_none(), "expected reject: {bad}");
        }
        // ...but names that merely CONTAIN a reserved word, or have a non-1..9 suffix, are fine.
        for ok in ["console.md", "com0.md", "com10.md", "connie/notes.md", "lpt.md", "auxiliary.md"] {
            assert!(safe_rel_path(ok).is_some(), "expected accept: {ok}");
        }
    }

    #[test]
    fn safe_rel_path_rejects_reindex_junk_names() {
        // SEC-R2#2: a name reindex's collect_files skips as junk must never enter the index,
        // or a later reindex would abort forever ("indexed file missing from disk").
        for bad in [".DS_Store", "Thumbs.db", "desktop.ini", ".git", "sub/.DS_Store", "a/b/.git"] {
            assert!(safe_rel_path(bad).is_none(), "expected reject: {bad}");
        }
        assert!(safe_rel_path("notes/.gitignore").is_some()); // .gitignore is a real file, not junk
    }

    #[test]
    fn safe_rel_path_rejects_trailing_dot_space_and_reserved_variants() {
        // SEC-R3#1: names Windows strips a trailing '.'/space from would desync index key vs disk.
        for bad in ["evil.md.", "evil.md ", "note ", "note.", "aux ", "CON.", "...", "sub/x.md.", "a/b.txt "] {
            assert!(safe_rel_path(bad).is_none(), "expected reject: {bad}");
        }
        // A leading dot or an interior dot/space is fine.
        for ok in [".gitignore", "my note.md", "a.b.c.md", "notes/deep file.md"] {
            assert!(safe_rel_path(ok).is_some(), "expected accept: {ok}");
        }
    }

    #[test]
    fn commit_rejects_unicode_case_collision_and_delete_evicts_legacy_key() {
        let dir = tempfile::tempdir().unwrap();
        let mut v = Vault::open(dir.path()).unwrap();
        // Store a chunk + commit 'CAFÉ.md' (uppercase É, U+00C9).
        let body = b"x";
        let h = crate::hash::sha256_hex(body);
        v.put_chunk(&h, body).unwrap();
        v.commit(CommitRequest { path: "CAFÉ.md".into(), hash: h.clone(), size: 1, mtime: 0, chunks: vec![h.clone()], expected_version: None }).unwrap();
        // DI-R5#1: committing the Unicode-case variant 'café.md' (lowercase é) is rejected.
        // (InvalidInput → 400: a permanent bad request, distinct from the CAS AlreadyExists → 409.)
        let err = v.commit(CommitRequest { path: "café.md".into(), hash: h.clone(), size: 1, mtime: 0, chunks: vec![h.clone()], expected_version: None }).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidInput);
        // DI-R5#4: an index key that safe_rel_path now rejects is still deletable (evicted). Insert it
        // straight into the index (commit would reject the name) to simulate a legacy key.
        v.index.put(&FileMeta { path: "legacy.md.".into(), hash: h.clone(), size: 1, mtime: 0, version: v.version() + 1, chunks: vec![h.clone()] }).unwrap();
        assert!(safe_rel_path("legacy.md.").is_none());
        let d = v.delete("legacy.md.").unwrap();
        assert!(d.is_some(), "legacy invalid-name key must be deletable");
        assert!(v.file_meta("legacy.md.").is_none());
    }

    // Optimistic concurrency (CAS): a commit that declares the wrong base version is rejected
    // (AlreadyExists → 409), an idempotent re-commit is a no-op regardless, and a correct/absent
    // expected_version commits normally. This is the double-first-commit lost-update guard.
    #[test]
    fn commit_cas_rejects_stale_expected_version() {
        let dir = tempfile::tempdir().unwrap();
        let mut v = Vault::open(dir.path()).unwrap();
        let b1 = b"one"; let h1 = sha256_hex(b1);
        v.put_chunk(&h1, b1).unwrap();
        // Create the file with expected_version = 0 (absent) — succeeds.
        let m1 = v.commit(CommitRequest { path: "n.md".into(), hash: h1.clone(), size: 3, mtime: 1, chunks: vec![h1.clone()], expected_version: Some(0) }).unwrap();
        // A second writer based on the SAME old base (0) tries to overwrite with different content:
        // the server is now at m1.version, so the CAS mismatch rejects it (409-mapped).
        let b2 = b"two"; let h2 = sha256_hex(b2);
        v.put_chunk(&h2, b2).unwrap();
        let err = v.commit(CommitRequest { path: "n.md".into(), hash: h2.clone(), size: 3, mtime: 2, chunks: vec![h2.clone()], expected_version: Some(0) }).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists, "stale expected_version must conflict");
        // Basing on the CURRENT version succeeds.
        v.commit(CommitRequest { path: "n.md".into(), hash: h2.clone(), size: 3, mtime: 3, chunks: vec![h2.clone()], expected_version: Some(m1.version) }).unwrap();
        // An idempotent re-commit (same content) with a stale expected_version is still a no-op,
        // not a conflict — the short-circuit runs before the CAS check.
        let again = v.commit(CommitRequest { path: "n.md".into(), hash: h2.clone(), size: 3, mtime: 9, chunks: vec![h2.clone()], expected_version: Some(0) }).unwrap();
        assert_eq!(again.hash, h2);
        // expected_version: None bypasses CAS entirely (authoritative overwrite).
        let b3 = b"three"; let h3 = sha256_hex(b3);
        v.put_chunk(&h3, b3).unwrap();
        v.commit(CommitRequest { path: "n.md".into(), hash: h3.clone(), size: 5, mtime: 4, chunks: vec![h3.clone()], expected_version: None }).unwrap();
    }

    #[test]
    fn safe_rel_path_rejects_noncanonical_paths() {
        // DI-R4#1: a path that isn't its own canonical forward-slash form would desync the raw
        // index key from the Path-normalized on-disk name (alias/overwrite + reindex brick).
        for bad in ["notes//a.md", "notes/a.md/", "a//b//c.md", "/a.md", "a/./b.md"] {
            assert!(safe_rel_path(bad).is_none(), "expected reject: {bad}");
        }
    }

    #[test]
    fn safe_name_is_lowercase_canonical() {
        // SEC-1: uppercase is rejected so store-key == on-disk segment (no case-collision).
        assert!(crate::users::safe_name("alice"));
        assert!(crate::users::safe_name("my-vault_2.0"));
        assert!(!crate::users::safe_name("Alice"));
        assert!(!crate::users::safe_name("MyVault"));
        assert!(!crate::users::safe_name("ADMIN"));
    }

    // Materialize a file directly into the vault's bind-mount tree (as if it were present on disk
    // but absent/lost from the index) and return its abs path.
    fn write_vault_file(root: &Path, rel: &str, body: &[u8]) {
        let abs = root.join("vault").join(rel);
        std::fs::create_dir_all(abs.parent().unwrap()).unwrap();
        std::fs::write(abs, body).unwrap();
    }

    // A garbage (non-SQLite) index DB is quarantined and then AUTO-REPAIRED from the disk files
    // (D0022) — the vault opens clean, not locked. (Was: opened in ERROR awaiting a manual reindex.)
    #[test]
    fn corrupt_db_is_quarantined_and_auto_repaired_from_disk() {
        let dir = tempfile::tempdir().unwrap();
        write_vault_file(dir.path(), "notes/a.md", b"hello");
        std::fs::write(dir.path().join(".sync-index.db"), b"this is not a sqlite database").unwrap();
        let v = Vault::open(dir.path()).unwrap();
        assert!(dir.path().join(".sync-index.db.corrupt").exists(), "corrupt DB quarantined for forensics");
        assert!(!v.is_corrupt(), "corrupt DB auto-repairs from the disk files");
        assert!(v.changes(0).upserts.iter().any(|m| m.path == "notes/a.md"));
    }

    // D0022: auto-repair CANNOT fix a file lost from BOTH disk and the chunk store — the vault stays
    // ERROR (fail-loud), and a manual FORCE reindex drops the provably-lost entry and clears it.
    #[test]
    fn unrecoverable_index_stays_error_until_forced() {
        let dir = tempfile::tempdir().unwrap();
        {
            let mut v = Vault::open(dir.path()).unwrap();
            let b = b"x"; let h = sha256_hex(b);
            v.put_chunk(&h, b).unwrap();
            v.commit(CommitRequest { path: "lost.md".into(), hash: h.clone(), size: 1, mtime: 1, chunks: vec![h.clone()], expected_version: None }).unwrap();
            // Lose it from BOTH sides so no rebuild source remains.
            std::fs::remove_file(dir.path().join("vault").join("lost.md")).unwrap();
            std::fs::remove_file(dir.path().join(".chunks").join(&h[0..2]).join(&h)).unwrap();
        }
        let mut v = Vault::open(dir.path()).unwrap();
        assert!(v.is_corrupt(), "a file lost from disk AND store can't auto-repair → stays ERROR");
        v.reindex(true).unwrap(); // operator force
        assert!(!v.is_corrupt());
        assert!(!v.changes(0).upserts.iter().any(|m| m.path == "lost.md"), "force-dropped the truly-lost file");
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
            mtime: 1, chunks: vec![hash.clone()], expected_version: None,
        }).unwrap();
        let original_version = meta.version;

        v.reindex(false).unwrap(); // same bytes on disk -> version must not bump
        let after = v.changes(0).upserts.iter().find(|m| m.path == "keep.md").unwrap().clone();
        assert_eq!(after.version, original_version, "unchanged file keeps its version");
        assert_eq!(after.hash, hash);
    }

    // MUTATION-TESTING (D0030, mutationTestingVaultReindex): the reindex REBUILD path (reached when the
    // prefer-store short-circuit does NOT fire) had untested branches — the healthy-reindex tests above
    // all take the prefer-store shortcut, so reindex:387/412 survived. These three drive the rebuild path.

    // 387 (`!empty && all_has` prefer-store) + 412 (version-preserve on rebuild): a HEALTHY reindex whose
    // file has a VANISHED chunk (mirror intact) must REBUILD from the mirror — re-storing the chunk, not
    // keeping the dangling verbatim entry — and, the content being unchanged, PRESERVE the version.
    #[test]
    fn reindex_rebuilds_a_file_whose_chunk_vanished_and_preserves_version() {
        let dir = tempfile::tempdir().unwrap();
        let mut v = Vault::open(dir.path()).unwrap();
        let body = b"stable content"; let h = sha256_hex(body);
        v.put_chunk(&h, body).unwrap();
        let m = v.commit(CommitRequest { path: "keep.md".into(), hash: h.clone(), size: body.len() as u64, mtime: 1, chunks: vec![h.clone()], expected_version: None }).unwrap();
        let original_version = m.version;
        // Blob vanishes from the store, but the mirror file stays on disk and the index row is intact, so
        // the vault is still HEALTHY (verify_and_gc not re-run) → reindex enters the prefer-store branch,
        // finds the chunk missing (all_has == false), and must fall through to the disk rebuild.
        v.store.remove(&h).unwrap();
        assert!(v.get_chunk(&h).unwrap().is_none(), "precondition: the chunk is gone");
        v.reindex(false).unwrap();
        assert!(v.get_chunk(&h).unwrap().is_some(), "387: a vanished chunk must be rebuilt from the mirror, not kept as a dangling ref");
        let after = v.changes(0).upserts.into_iter().find(|f| f.path == "keep.md").unwrap();
        assert_eq!(after.version, original_version, "412: an unchanged file keeps its version on rebuild");
    }

    // 412 (`old.hash == hash` guard → true): a CHANGED file that must be rebuilt (its old chunk is gone,
    // so prefer-store can't keep the stale entry) must get a NEW version — never keep the old one.
    #[test]
    fn reindex_bumps_version_for_a_changed_file_it_must_rebuild() {
        let dir = tempfile::tempdir().unwrap();
        let mut v = Vault::open(dir.path()).unwrap();
        let body1 = b"one"; let h1 = sha256_hex(body1);
        v.put_chunk(&h1, body1).unwrap();
        let m = v.commit(CommitRequest { path: "n.md".into(), hash: h1.clone(), size: 3, mtime: 1, chunks: vec![h1.clone()], expected_version: None }).unwrap();
        let original_version = m.version;
        // Change the mirror on disk AND drop the old chunk → reindex cannot prefer-store the stale entry
        // and must rebuild from the new bytes; the new hash must mint a new version.
        write_vault_file(dir.path(), "n.md", b"two-changed");
        v.store.remove(&h1).unwrap();
        v.reindex(false).unwrap();
        let after = v.changes(0).upserts.into_iter().find(|f| f.path == "n.md").unwrap();
        assert_eq!(after.hash, sha256_hex(b"two-changed"), "the changed disk content is ingested");
        assert!(after.version > original_version, "412: a changed file must get a NEW version on rebuild, not keep the old");
    }

    // 426 (`was_corrupt && !had_tombstones` floor-raise): a HEALTHY reindex with NO tombstones must LEAVE
    // the history floor at genesis — only a rebuild that genuinely LOST tombstones resets history.
    #[test]
    fn healthy_reindex_without_tombstones_leaves_history_floor_at_genesis() {
        let dir = tempfile::tempdir().unwrap();
        let mut v = Vault::open(dir.path()).unwrap();
        let body = b"x"; let h = sha256_hex(body);
        v.put_chunk(&h, body).unwrap();
        v.commit(CommitRequest { path: "a.md".into(), hash: h.clone(), size: 1, mtime: 1, chunks: vec![h.clone()], expected_version: None }).unwrap();
        assert_eq!(v.changes(0).history_floor, 1, "precondition: genesis floor");
        v.reindex(false).unwrap(); // healthy + zero tombstones → the floor must not move
        assert_eq!(v.changes(0).history_floor, 1, "426: a healthy, tombstone-free reindex must not raise the floor");
    }

    // CRITIQUE R+1 (issueVersionEpochRewind): the version counter must NOT rewind below its high-water
    // when a corrupt index is quarantined + rebuilt — else an already-synced client's cursor sits ABOVE
    // the server version and the rebuilt changes are invisible in every incremental delta. A persisted
    // fsync'd .version-hwm sidecar survives the index corruption and floors the rebuilt version.
    #[test]
    fn version_does_not_rewind_below_the_high_water_after_a_quarantine_rebuild() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let put = |v: &mut Vault, name: &str, body: &[u8]| {
            let h = sha256_hex(body); v.put_chunk(&h, body).unwrap();
            v.commit(CommitRequest { path: name.into(), hash: h.clone(), size: body.len() as u64, mtime: 1, chunks: vec![h], expected_version: None }).unwrap();
        };
        let hwm;
        {
            let mut v = Vault::open(root).unwrap();
            put(&mut v, "a.md", b"1"); // v2
            v.delete("a.md").unwrap();  // v3 (many edits/deletes push version well past the file count)
            put(&mut v, "b.md", b"2"); // v4
            put(&mut v, "c.md", b"3"); // v5
            hwm = v.version();
            assert!(hwm >= 5, "precondition: version advanced past the 2 surviving files");
        }
        // Corrupt the index DB so the next open QUARANTINEs it → a fresh index whose counter resets to 1.
        std::fs::write(root.join(".sync-index.db"), b"not a sqlite database at all").unwrap();
        let _ = std::fs::remove_file(root.join(".sync-index.db-wal"));
        let _ = std::fs::remove_file(root.join(".sync-index.db-shm"));
        let v2 = Vault::open(root).unwrap(); // quarantine → fresh index (would be version 1) → auto-reindex
        assert!(v2.version() >= hwm, "version rewound to {} below the high-water {hwm} — a synced client's cursor would sit above it", v2.version());
    }

    #[test]
    fn reindex_is_deterministic() {
        let dir = tempfile::tempdir().unwrap();
        write_vault_file(dir.path(), "x/one.md", b"1");
        write_vault_file(dir.path(), "two.md", b"22");
        let mut v = Vault::open(dir.path()).unwrap();
        v.reindex(false).unwrap();
        let map1: HashMap<_, _> = v.changes(0).upserts.iter().map(|m| (m.path.clone(), m.hash.clone())).collect();
        v.reindex(false).unwrap();
        let map2: HashMap<_, _> = v.changes(0).upserts.iter().map(|m| (m.path.clone(), m.hash.clone())).collect();
        assert_eq!(map1, map2, "same files -> same path->hash mapping");
    }

    // issueReindexSingleChunk: a large reindexed file must be content-defined-chunked (many chunks that
    // dedup + stream), NOT stored as one giant blob. Verifies the chunk list, the preserved whole-file
    // hash, and that the stored chunks reassemble to the original.
    #[test]
    fn reindex_chunks_a_large_file_into_many_chunks_that_reassemble() {
        let dir = tempfile::tempdir().unwrap();
        let mut s: u32 = 0x9e3779b9; // deterministic pseudo-random so CDC actually finds boundaries
        let big: Vec<u8> = (0..200_000).map(|_| { s = s.wrapping_mul(1103515245).wrapping_add(12345); ((s >> 16) & 0xff) as u8 }).collect();
        write_vault_file(dir.path(), "big.bin", &big);
        let mut v = Vault::open(dir.path()).unwrap();
        v.reindex(false).unwrap();
        let meta = v.changes(0).upserts.into_iter().find(|m| m.path == "big.bin").expect("big.bin indexed");
        assert!(meta.chunks.len() > 1, "a large reindexed file must be MANY chunks, not one blob (got {})", meta.chunks.len());
        assert_eq!(meta.hash, sha256_hex(&big), "whole-file hash preserved");
        let mut joined = Vec::new();
        for ch in &meta.chunks { joined.extend_from_slice(&v.get_chunk(ch).unwrap().expect("chunk stored")); }
        assert_eq!(joined, big, "stored chunks reassemble to the original file");
    }

    // A failed commit is atomic: a commit that fails validation must not bump the version, drop the
    // prior file, or lose a referenced blob. (Replaces the old journal-append rollback test — the
    // append-only journal is gone; the SQLite transaction in put() gives all-or-nothing.)
    #[test]
    fn failed_commit_is_atomic_and_keeps_blobs() {
        let dir = tempfile::tempdir().unwrap();
        let mut v = Vault::open(dir.path()).unwrap();
        let b1 = b"version one"; let h1 = sha256_hex(b1);
        v.put_chunk(&h1, b1).unwrap();
        v.commit(CommitRequest { path: "f.md".into(), hash: h1.clone(), size: b1.len() as u64, mtime: 1, chunks: vec![h1.clone()], expected_version: None }).unwrap();
        let good_version = v.version();

        // A commit referencing a chunk that was never uploaded must fail (NotFound) and change nothing.
        let b2 = b"version two"; let h2 = sha256_hex(b2);
        let res = v.commit(CommitRequest { path: "f.md".into(), hash: h2.clone(), size: b2.len() as u64, mtime: 2, chunks: vec![h2.clone()], expected_version: None });
        assert!(res.is_err(), "commit with a missing chunk must fail");

        assert_eq!(v.version(), good_version, "failed commit must not bump version");
        let meta = v.changes(0).upserts.into_iter().find(|m| m.path == "f.md").unwrap();
        assert_eq!(meta.chunks, vec![h1.clone()], "prior version intact");
        assert!(v.has_chunk(&h1), "referenced blob must survive a failed commit");
    }

    // SQLite persists on commit (no snapshot step): a committed file is durable across a reopen.
    #[test]
    fn commit_survives_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let b = b"hello"; let h = sha256_hex(b);
        {
            let mut v = Vault::open(dir.path()).unwrap();
            v.put_chunk(&h, b).unwrap();
            v.commit(CommitRequest { path: "n.md".into(), hash: h.clone(), size: b.len() as u64, mtime: 1, chunks: vec![h.clone()], expected_version: None }).unwrap();
        }
        let v = Vault::open(dir.path()).unwrap();
        assert!(!v.is_corrupt());
        assert!(v.changes(0).upserts.iter().any(|m| m.path == "n.md"));
    }

    #[test]
    fn delete_survives_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let b = b"x"; let h = sha256_hex(b);
        {
            let mut v = Vault::open(dir.path()).unwrap();
            v.put_chunk(&h, b).unwrap();
            v.commit(CommitRequest { path: "d.md".into(), hash: h.clone(), size: 1, mtime: 1, chunks: vec![h.clone()], expected_version: None }).unwrap();
            v.delete("d.md").unwrap();
        }
        let v = Vault::open(dir.path()).unwrap();
        assert!(!v.changes(0).upserts.iter().any(|m| m.path == "d.md"), "deleted file must not reappear after reopen");
    }

    #[test]
    fn shared_chunk_survives_reopen_gc() {
        let dir = tempfile::tempdir().unwrap();
        let b = b"shared bytes"; let h = sha256_hex(b);
        {
            let mut v = Vault::open(dir.path()).unwrap();
            v.put_chunk(&h, b).unwrap();
            // two files reference the same chunk
            v.commit(CommitRequest { path: "a.md".into(), hash: h.clone(), size: b.len() as u64, mtime: 1, chunks: vec![h.clone()], expected_version: None }).unwrap();
            v.commit(CommitRequest { path: "b.md".into(), hash: h.clone(), size: b.len() as u64, mtime: 2, chunks: vec![h.clone()], expected_version: None }).unwrap();
        }
        // reopen → startup GC: the shared chunk is referenced by 2 files, so it must NOT be reclaimed.
        let v = Vault::open(dir.path()).unwrap();
        assert!(v.has_chunk(&h), "chunk referenced by 2 files must survive reopen GC");
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

    // D0022: a referenced chunk missing from the store but whose file is still on the bind-mount
    // mirror AUTO-RECOVERS on open (re-ingests the file from disk), rather than staying ERROR.
    #[test]
    fn dangling_chunk_ref_auto_recovers_from_mirror() {
        let dir = tempfile::tempdir().unwrap();
        let body = b"committed data";
        let h = sha256_hex(body);
        {
            let mut v = Vault::open(dir.path()).unwrap();
            v.put_chunk(&h, body).unwrap();
            v.commit(CommitRequest { path: "d.md".into(), hash: h.clone(), size: body.len() as u64, mtime: 1, chunks: vec![h.clone()], expected_version: None }).unwrap();
        }
        // Lose only the CHUNK blob; the mirror file vault/d.md remains as the rebuild source.
        std::fs::remove_file(dir.path().join(".chunks").join(&h[0..2]).join(&h)).unwrap();
        let v2 = Vault::open(dir.path()).unwrap();
        assert!(!v2.is_corrupt(), "dangling ref recovers from the mirror on open");
        assert!(v2.changes(0).upserts.iter().any(|m| m.path == "d.md"));
    }

    // D0022: an empty index with materialized data present (e.g. after the SQLite format change)
    // AUTO-REPAIRS on open — rebuilds the index from disk, no manual reindex. (Was: opens ERROR.)
    #[test]
    fn empty_index_with_data_auto_repairs_on_open() {
        let dir = tempfile::tempdir().unwrap();
        write_vault_file(dir.path(), "a.md", b"data"); // materialized file, no index
        let v = Vault::open(dir.path()).unwrap();
        assert!(!v.is_corrupt(), "empty index + files must auto-repair, not stay ERROR");
        assert!(v.changes(0).upserts.iter().any(|m| m.path == "a.md"), "the file is indexed after auto-repair");
    }

    #[test]
    fn missing_index_empty_namespace_is_fresh() {
        let dir = tempfile::tempdir().unwrap();
        let v = Vault::open(dir.path()).unwrap();
        assert!(!v.is_corrupt(), "a genuinely empty namespace is a fresh first run");
    }

    // Tombstones are retained durably (no arbitrary cap): a long-offline client must still see a
    // genuine deletion's tombstone rather than reading absence as "never had it" and restoring it.
    #[test]
    fn tombstones_are_retained_not_capped() {
        let dir = tempfile::tempdir().unwrap();
        let mut v = Vault::open(dir.path()).unwrap();
        let b = b"x"; let h = sha256_hex(b);
        // Commit 50 distinct files (all sharing one chunk), THEN delete them all; every deletion
        // tombstone must survive (re-put the chunk each round since deletes GC it when refcount hits 0).
        for i in 0..50 {
            v.put_chunk(&h, b).unwrap();
            v.commit(CommitRequest { path: format!("f{i}.md"), hash: h.clone(), size: 1, mtime: 1, chunks: vec![h.clone()], expected_version: None }).unwrap();
        }
        for i in 0..50 { v.delete(&format!("f{i}.md")).unwrap(); }
        assert_eq!(v.changes(0).deletes.len(), 50, "all tombstones retained, none dropped by a cap");
    }

    // Round-6 DI: a HEALTHY reindex must keep the authoritative chunk-store content, never adopt
    // stale bind-mount bytes left by a failed mirror write.
    #[test]
    fn reindex_prefers_store_over_stale_mirror_when_healthy() {
        let dir = tempfile::tempdir().unwrap();
        let mut v = Vault::open(dir.path()).unwrap();
        let good = b"authoritative"; let h = sha256_hex(good);
        v.put_chunk(&h, good).unwrap();
        v.commit(CommitRequest { path: "n.md".into(), hash: h.clone(), size: good.len() as u64, mtime: 1, chunks: vec![h.clone()], expected_version: None }).unwrap();
        // Simulate a stale mirror: a failed mirror-write left OLD bytes on disk while the store holds the new ones.
        std::fs::write(dir.path().join("vault").join("n.md"), b"STALE").unwrap();
        assert!(!v.is_corrupt());
        v.reindex(false).unwrap();
        let meta = v.changes(0).upserts.into_iter().find(|m| m.path == "n.md").unwrap();
        assert_eq!(meta.hash, h, "healthy reindex must keep the authoritative store content, not the stale mirror");
        assert_eq!(v.get_chunk(&meta.chunks[0]).unwrap().unwrap(), good);
    }

    // Round-7 RC-2: reindex recovers a file missing from disk but present in the store (failed mirror
    // write) instead of bricking; a truly-lost file aborts unless forced.
    #[test]
    fn reindex_recovers_from_store_and_force_drops_truly_lost() {
        let dir = tempfile::tempdir().unwrap();
        let mut v = Vault::open(dir.path()).unwrap();
        let a = b"aaaa"; let ha = sha256_hex(a);
        let b = b"bbbb"; let hb = sha256_hex(b);
        v.put_chunk(&ha, a).unwrap(); v.commit(CommitRequest { path: "a.md".into(), hash: ha.clone(), size: 4, mtime: 1, chunks: vec![ha.clone()], expected_version: None }).unwrap();
        v.put_chunk(&hb, b).unwrap(); v.commit(CommitRequest { path: "b.md".into(), hash: hb.clone(), size: 4, mtime: 1, chunks: vec![hb.clone()], expected_version: None }).unwrap();
        // Failed mirror write for a.md: gone from disk, but its chunk is still in the store.
        std::fs::remove_file(dir.path().join("vault").join("a.md")).unwrap();
        v.reindex(false).unwrap(); // must RECOVER a.md from the store, not abort
        let paths: std::collections::HashSet<_> = v.changes(0).upserts.iter().map(|m| m.path.clone()).collect();
        assert!(paths.contains("a.md") && paths.contains("b.md"), "recoverable file re-materialized");
        assert!(dir.path().join("vault").join("a.md").exists(), "recovered file re-written to disk");
        // Now make b.md TRULY lost: off disk AND its chunk removed from the store.
        std::fs::remove_file(dir.path().join("vault").join("b.md")).unwrap();
        std::fs::remove_file(dir.path().join(".chunks").join(&hb[0..2]).join(&hb)).unwrap();
        assert_eq!(v.reindex(false).unwrap_err().kind(), std::io::ErrorKind::NotFound, "unforced reindex aborts on a truly-lost file");
        v.reindex(true).unwrap(); // force drops b.md, repairs the rest
        let paths2: std::collections::HashSet<_> = v.changes(0).upserts.iter().map(|m| m.path.clone()).collect();
        assert!(paths2.contains("a.md") && !paths2.contains("b.md"), "force drops only the truly-lost file");
    }

    // D0019 (RC-1): a rebuild-from-disk (corrupt) reindex cannot recover tombstones, so it raises
    // the deletion-history floor to the current version — the signal a below-floor client uses to
    // stay conservative (keep + push + notify) instead of silently resurrecting deleted files.
    #[test]
    fn corrupt_reindex_raises_history_floor() {
        let dir = tempfile::tempdir().unwrap();
        write_vault_file(dir.path(), "a.md", b"hello");
        write_vault_file(dir.path(), "b.md", b"world");
        std::fs::write(dir.path().join(".sync-index.db"), b"not a sqlite db").unwrap();
        // D0022: the corrupt DB auto-repairs on open (rebuild from disk), and that rebuild-from-disk
        // raises the history floor (tombstones were unrecoverable) — no manual reindex needed.
        let v = Vault::open(dir.path()).unwrap();
        assert!(!v.is_corrupt(), "auto-repaired on open");
        let floor = v.changes(0).history_floor;
        assert!(floor > 1, "auto-reindex from a corrupt index must raise the floor above genesis");
        assert_eq!(floor, v.version(), "floor = the current version (deletion history complete only from here)");
    }

    // A HEALTHY reindex preserves tombstones (replace_files keeps the deletions table), so it must
    // NOT raise the floor — an up-to-date client is never told history was reset in normal operation.
    #[test]
    fn healthy_reindex_keeps_history_floor_and_tombstones() {
        let dir = tempfile::tempdir().unwrap();
        let mut v = Vault::open(dir.path()).unwrap();
        let b = b"x"; let h = sha256_hex(b);
        v.put_chunk(&h, b).unwrap();
        v.commit(CommitRequest { path: "f.md".into(), hash: h.clone(), size: 1, mtime: 1, chunks: vec![h.clone()], expected_version: None }).unwrap();
        v.delete("f.md").unwrap(); // real tombstone
        assert_eq!(v.changes(0).history_floor, 1, "genesis floor");
        v.reindex(false).unwrap(); // healthy
        assert_eq!(v.changes(0).history_floor, 1, "healthy reindex must leave the floor at genesis");
        assert!(v.changes(0).deletes.iter().any(|d| d.path == "f.md"), "healthy reindex keeps the tombstone");
    }

    // SEC#4: an upload triggers the interval-gated runtime orphan sweep, but the TTL spares a
    // just-uploaded (in-flight) chunk — the sweep must never reclaim a chunk about to be committed.
    #[test]
    fn runtime_orphan_sweep_runs_on_upload_but_spares_inflight_chunks() {
        let dir = tempfile::tempdir().unwrap();
        let v = Vault::open(dir.path()).unwrap();
        let a = b"aaaa"; let ha = sha256_hex(a);
        v.put_chunk(&ha, a).unwrap(); // uploaded, not yet committed → an in-flight orphan
        // Force the sweep timer "due" so the next upload actually runs maybe_sweep_orphans.
        *v.last_orphan_sweep.lock().unwrap() = std::time::Instant::now() - std::time::Duration::from_secs(1000);
        let b = b"bbbb"; let hb = sha256_hex(b);
        v.put_chunk(&hb, b).unwrap(); // triggers the sweep
        // The ORPHAN_TTL (1h) spares both just-uploaded chunks: an in-flight upload is never reclaimed.
        assert!(v.has_chunk(&ha), "a just-uploaded (young) orphan must survive the runtime sweep");
        assert!(v.has_chunk(&hb));
        // And it commits fine afterward (the sweep didn't disturb the in-flight chunk).
        let mut v = v;
        v.commit(CommitRequest { path: "a.md".into(), hash: ha.clone(), size: 4, mtime: 1, chunks: vec![ha.clone()], expected_version: None }).unwrap();
        assert!(v.has_chunk(&ha));
    }

    // tombstonePrune (D0019): a deliberate prune drops tombstones below the floor and raises it;
    // recent tombstones are kept and the floor stays monotonic.
    #[test]
    fn prune_history_drops_old_tombstones_and_raises_floor() {
        let dir = tempfile::tempdir().unwrap();
        let mut v = Vault::open(dir.path()).unwrap();
        let b = b"x"; let h = sha256_hex(b);
        v.put_chunk(&h, b).unwrap();
        v.commit(CommitRequest { path: "a.md".into(), hash: h.clone(), size: 1, mtime: 1, chunks: vec![h.clone()], expected_version: None }).unwrap();
        v.delete("a.md").unwrap();
        let after_first = v.version(); // a.md's tombstone is at this version
        v.put_chunk(&h, b).unwrap();
        v.commit(CommitRequest { path: "b.md".into(), hash: h.clone(), size: 1, mtime: 1, chunks: vec![h.clone()], expected_version: None }).unwrap();
        v.delete("b.md").unwrap();
        assert_eq!(v.changes(0).deletes.len(), 2);
        // Prune below (after_first + 1): drops a.md's tombstone, keeps b.md's; floor raised.
        let n = v.prune_history(after_first + 1).unwrap();
        assert_eq!(n, 1);
        assert_eq!(v.changes(0).deletes.len(), 1, "only the below-floor tombstone pruned");
        assert!(v.changes(0).history_floor > after_first, "floor raised by the prune");
    }

    // critique-R8 DI-M3: a dangling-chunk auto-repair on an index that STILL HOLDS tombstones must
    // recover from the mirror, PRESERVE the tombstones, and NOT raise the history floor (no reset).
    #[test]
    fn dangling_ref_repair_preserves_tombstones_without_raising_floor() {
        let dir = tempfile::tempdir().unwrap();
        let a = b"aaaa"; let ha = sha256_hex(a);
        let b = b"bbbb"; let hb = sha256_hex(b);
        {
            let mut v = Vault::open(dir.path()).unwrap();
            v.put_chunk(&ha, a).unwrap();
            v.commit(CommitRequest { path: "a.md".into(), hash: ha.clone(), size: 4, mtime: 1, chunks: vec![ha.clone()], expected_version: None }).unwrap();
            v.put_chunk(&hb, b).unwrap();
            v.commit(CommitRequest { path: "b.md".into(), hash: hb.clone(), size: 4, mtime: 1, chunks: vec![hb.clone()], expected_version: None }).unwrap();
            v.delete("a.md").unwrap(); // a real tombstone; a.md's chunk is GC'd (unshared)
        }
        // Break b.md's chunk (dangling ref) but leave its mirror file on disk as the rebuild source.
        std::fs::remove_file(dir.path().join(".chunks").join(&hb[0..2]).join(&hb)).unwrap();
        let v = Vault::open(dir.path()).unwrap();
        assert!(!v.is_corrupt(), "dangling ref auto-recovers from the mirror");
        assert_eq!(v.changes(0).history_floor, 1, "tombstones preserved → floor must NOT bump");
        assert!(v.changes(0).deletes.iter().any(|d| d.path == "a.md"), "a.md tombstone preserved");
        assert!(v.changes(0).upserts.iter().any(|m| m.path == "b.md"), "b.md recovered from the mirror");
    }

    #[test]
    fn newer_schema_db_refuses_to_open_and_is_not_quarantined() { // R14-DI1 (release-blocker)
        let dir = tempfile::tempdir().unwrap();
        let a = b"aaaa"; let ha = sha256_hex(a);
        {
            let mut v = Vault::open(dir.path()).unwrap();
            v.put_chunk(&ha, a).unwrap();
            v.commit(CommitRequest { path: "a.md".into(), hash: ha.clone(), size: 4, mtime: 1, chunks: vec![ha.clone()], expected_version: None }).unwrap();
            v.delete("a.md").unwrap(); // a tombstone a destructive rebuild-from-disk would erase
        }
        // Simulate an index written by a NEWER server binary (higher schema_version).
        let db = dir.path().join(".sync-index.db");
        { let conn = rusqlite::Connection::open(&db).unwrap(); conn.execute("UPDATE meta SET value=999 WHERE key='schema_version'", []).unwrap(); }
        // An OLDER binary must REFUSE hard, NOT quarantine + rebuild — quarantining opens a fresh empty
        // index and reindexes from disk, permanently destroying the tombstone + rewinding the version.
        let err = match Vault::open(dir.path()) { Ok(_) => panic!("must refuse a newer-schema DB"), Err(e) => e };
        assert_eq!(err.kind(), std::io::ErrorKind::Unsupported);
        assert!(!dir.path().join(".sync-index.db.corrupt").exists(), "an intact newer DB must NOT be quarantined");
        assert!(db.exists(), "the authoritative index is left untouched for the correct binary");
    }

    #[test]
    fn reindex_routes_a_bitrotted_recovered_file_to_lost_not_corruption() { // R14-DI2
        let dir = tempfile::tempdir().unwrap();
        let a = b"aaaa"; let ha = sha256_hex(a);
        let b = b"bbbb"; let hb = sha256_hex(b);
        let mut v = Vault::open(dir.path()).unwrap();
        v.put_chunk(&ha, a).unwrap();
        v.commit(CommitRequest { path: "a.md".into(), hash: ha.clone(), size: 4, mtime: 1, chunks: vec![ha.clone()], expected_version: None }).unwrap();
        v.put_chunk(&hb, b).unwrap();
        v.commit(CommitRequest { path: "b.md".into(), hash: hb.clone(), size: 4, mtime: 1, chunks: vec![hb.clone()], expected_version: None }).unwrap();
        // a.md: remove its mirror (→ reindex must recover from the store) and BIT-ROT its chunk in place
        // (same filename, so it's still "present", but reassembles to the wrong hash).
        std::fs::remove_file(dir.path().join("vault").join("a.md")).unwrap();
        std::fs::write(dir.path().join(".chunks").join(&ha[0..2]).join(&ha), b"XXXX").unwrap();
        // A file that reassembles to the wrong hash is unrecoverable → routed to `lost`, so a
        // non-force reindex ABORTS rather than laundering corruption onto disk + into the index.
        assert!(v.reindex(false).is_err(), "a bit-rotted recovered file must abort reindex, not be materialized");
        // With force it's dropped (content is genuinely gone); the healthy file still recovers.
        v.reindex(true).unwrap();
        let ch = v.changes(0);
        assert!(ch.upserts.iter().all(|m| m.path != "a.md"), "corrupt file dropped on force, never materialized");
        assert!(ch.upserts.iter().any(|m| m.path == "b.md"), "the healthy file is recovered");
    }

    #[test]
    fn reindex_does_not_resurrect_a_tombstoned_ghost_mirror() { // R18
        let dir = tempfile::tempdir().unwrap();
        let a = b"aaaa"; let ha = sha256_hex(a);
        let b = b"bbbb"; let hb = sha256_hex(b);
        let mut v = Vault::open(dir.path()).unwrap();
        v.put_chunk(&ha, a).unwrap();
        v.commit(CommitRequest { path: "keep.md".into(), hash: hb.clone(), size: 4, mtime: 1, chunks: vec![hb.clone()], expected_version: None }).ok(); // keep the vault non-empty
        v.put_chunk(&hb, b).unwrap();
        v.commit(CommitRequest { path: "keep.md".into(), hash: hb.clone(), size: 4, mtime: 1, chunks: vec![hb.clone()], expected_version: None }).unwrap();
        v.commit(CommitRequest { path: "gone.md".into(), hash: ha.clone(), size: 4, mtime: 1, chunks: vec![ha.clone()], expected_version: None }).unwrap();
        v.delete("gone.md").unwrap(); // tombstone; mirror removed
        // Simulate a FAILED mirror removal: the deleted file's mirror is left on disk (a ghost).
        std::fs::write(dir.path().join("vault").join("gone.md"), a).unwrap();
        // A HEALTHY reindex must NOT re-ingest the tombstoned ghost (that would resurrect the deletion).
        v.reindex(false).unwrap();
        let ch = v.changes(0);
        assert!(ch.upserts.iter().all(|m| m.path != "gone.md"), "tombstoned ghost must NOT be resurrected");
        assert!(ch.deletes.iter().any(|d| d.path == "gone.md"), "the tombstone is preserved");
        assert!(!dir.path().join("vault").join("gone.md").exists(), "the stale ghost mirror is removed");
        assert!(ch.upserts.iter().any(|m| m.path == "keep.md"), "the live file is retained");
    }

    #[test]
    fn auto_repair_on_open_does_not_resurrect_a_tombstoned_ghost() { // R19 (dangling-repair path)
        let dir = tempfile::tempdir().unwrap();
        let a = b"aaaa"; let ha = sha256_hex(a);
        let b = b"bbbb"; let hb = sha256_hex(b);
        {
            let mut v = Vault::open(dir.path()).unwrap();
            v.put_chunk(&ha, a).unwrap();
            v.commit(CommitRequest { path: "keep.md".into(), hash: ha.clone(), size: 4, mtime: 1, chunks: vec![ha.clone()], expected_version: None }).unwrap();
            v.put_chunk(&hb, b).unwrap();
            v.commit(CommitRequest { path: "gone.md".into(), hash: hb.clone(), size: 4, mtime: 1, chunks: vec![hb.clone()], expected_version: None }).unwrap();
            v.delete("gone.md").unwrap(); // tombstone; mirror removed
            std::fs::write(dir.path().join("vault").join("gone.md"), b).unwrap(); // ghost: failed mirror removal
        }
        // Independently cause a DANGLING chunk ref (keep.md's blob vanishes) so open() auto-repairs via
        // reindex — the path that previously (R18 gated on !was_corrupt) resurrected the ghost.
        std::fs::remove_file(dir.path().join(".chunks").join(&ha[0..2]).join(&ha)).unwrap();
        let v = Vault::open(dir.path()).unwrap(); // verify_and_gc → dangling → auto-repair reindex
        assert!(!v.is_corrupt(), "auto-repaired");
        let ch = v.changes(0);
        assert!(ch.upserts.iter().all(|m| m.path != "gone.md"), "R19: dangling auto-repair must NOT resurrect the tombstoned ghost");
        assert!(ch.deletes.iter().any(|d| d.path == "gone.md"), "tombstone preserved");
        assert!(!dir.path().join("vault").join("gone.md").exists(), "ghost mirror removed");
        assert!(ch.upserts.iter().any(|m| m.path == "keep.md"), "the intact file is recovered");
    }

    #[test]
    fn safe_rel_path_rejects_control_chars() { // R20 log-injection / audit-forgery
        assert!(safe_rel_path("a\nb.md").is_none(), "newline rejected");
        assert!(safe_rel_path("a\r\n[login] user='x' -> OK.md").is_none(), "CRLF log-forge rejected");
        assert!(safe_rel_path("a\tb.md").is_none(), "tab rejected");
        assert!(safe_rel_path("\u{1b}[31mred.md").is_none(), "ANSI ESC rejected");
        assert!(safe_rel_path("x\u{0}.md").is_none(), "NUL rejected");
        assert!(safe_rel_path(".ghost.md.selfsync-tmp").is_none(), "R20: a mirror atomic-write temp name is rejected");
        assert!(safe_rel_path("notes/big.md.selfsync-part").is_none(), "R21: a client streamed-download temp name is rejected");
        assert!(safe_rel_path("notes/sub/real name (1).md").is_some(), "a normal path is still accepted");
    }

    #[test]
    fn reindex_ignores_leftover_mirror_temp_files() { // R20 crash-safety
        let dir = tempfile::tempdir().unwrap();
        let a = b"aaaa"; let ha = sha256_hex(a);
        let mut v = Vault::open(dir.path()).unwrap();
        v.put_chunk(&ha, a).unwrap();
        v.commit(CommitRequest { path: "keep.md".into(), hash: ha.clone(), size: 4, mtime: 1, chunks: vec![ha.clone()], expected_version: None }).unwrap();
        // Simulate a crash between write_mirror's fsync and its rename: a complete-content temp is left.
        std::fs::write(dir.path().join("vault").join(".keep.md.selfsync-tmp"), b"leftover").unwrap();
        // R21: and a crash mid client-download leaves a VISIBLE .selfsync-part partial.
        std::fs::write(dir.path().join("vault").join("keep.md.selfsync-part"), b"partial").unwrap();
        v.reindex(false).unwrap();
        let ch = v.changes(0);
        assert!(ch.upserts.iter().all(|m| !m.path.contains("selfsync-tmp")), "leftover mirror temp must NOT be ingested as a phantom file");
        assert!(ch.upserts.iter().all(|m| !m.path.contains("selfsync-part")), "R21: leftover client download temp must NOT be ingested");
        assert!(ch.upserts.iter().any(|m| m.path == "keep.md"), "the real file is kept");
    }

    // Round-6 DI: the reindex path-conflict guard (pure, so testable on a case-insensitive dev FS
    // where two folding files can't coexist on disk — the collision is a real case-sensitive-server
    // scenario). Commit already enforces this; reindex must too.
    #[test]
    fn reindex_path_conflict_guard() {
        // case/fold collision (would collapse to one file on a client FS)
        assert!(!conflicting_or_unsafe_rels(&["Notes/A.md".into(), "Notes/a.md".into()]).is_empty());
        // Unicode case fold
        assert!(!conflicting_or_unsafe_rels(&["CAFÉ.md".into(), "café.md".into()]).is_empty());
        // an unsafe name commit would reject (trailing dot / reserved / junk)
        assert!(!conflicting_or_unsafe_rels(&["evil.md.".into()]).is_empty());
        // distinct, safe names: no conflict
        assert!(conflicting_or_unsafe_rels(&["a.md".into(), "b.md".into(), "sub/c.md".into()]).is_empty());
    }

    // H3: repeated hashes must not reassemble past the declared size (OOM DoS guard).
    #[test]
    fn commit_rejects_reassembly_exceeding_declared_size() {
        let dir = tempfile::tempdir().unwrap();
        let mut v = Vault::open(dir.path()).unwrap();
        let body = b"0123456789"; let h = sha256_hex(body); // 10 bytes
        v.put_chunk(&h, body).unwrap();
        // declare size 10 but reference the chunk 5× (would reassemble to 50)
        let res = v.commit(CommitRequest { path: "x.md".into(), hash: h.clone(), size: 10, mtime: 1, chunks: vec![h; 5], expected_version: None });
        assert!(res.is_err(), "reassembly beyond declared size must abort");
    }

    // C4: a hostile declared size is rejected before any allocation.
    #[test]
    fn commit_rejects_absurd_declared_size() {
        let dir = tempfile::tempdir().unwrap();
        let mut v = Vault::open(dir.path()).unwrap();
        let body = b"x"; let h = sha256_hex(body);
        v.put_chunk(&h, body).unwrap();
        let res = v.commit(CommitRequest { path: "big.md".into(), hash: h.clone(), size: u64::MAX, mtime: 1, chunks: vec![h], expected_version: None });
        assert!(res.is_err(), "absurd declared size must be rejected before allocation");
    }

    // ==== MUTATION-TESTING (D0030): kill the request-path survivors cargo-mutants found on vault.rs. ====

    // safe_rel_path's front guard `is_empty() || contains('\\') || starts_with('/')` had no test for its
    // arms, so weakening a `||` to `&&` (admit an empty / backslash / absolute path) survived — a path-
    // safety hole. (On Windows the component/join backstop also catches the backslash case; this pins the
    // contract on every platform — the early guard is the sole defense on a POSIX FS where '\\' is literal.)
    #[test]
    fn safe_rel_path_rejects_empty_backslash_and_absolute() {
        assert!(safe_rel_path("").is_none(), "empty path rejected");
        assert!(safe_rel_path("a\\b.md").is_none(), "backslash rejected (Windows sep / traversal)");
        assert!(safe_rel_path("\\\\srv\\share").is_none(), "UNC-style backslash rejected");
        assert!(safe_rel_path("/etc/passwd").is_none(), "absolute path rejected");
        assert!(safe_rel_path("notes/ok.md").is_some(), "a normal relative path is accepted");
    }

    // commit's size gate is a STRICT `req.size > MAX_FILE_BYTES`. Weakening `>` reroutes an over-limit
    // request into a later content-mismatch error instead of the size-limit rejection (== survivor), or
    // rejects an at-limit request that should pass the gate (>= survivor). Tested via the DISTINCT error
    // — no allocation, since the gate compares the declared size before reassembly.
    #[test]
    fn commit_size_gate_is_strict_greater_than() {
        let dir = tempfile::tempdir().unwrap();
        let mut v = Vault::open(dir.path()).unwrap();
        let body = b"x"; let h = sha256_hex(body); v.put_chunk(&h, body).unwrap();
        let over = v.commit(CommitRequest { path: "big.md".into(), hash: h.clone(), size: MAX_FILE_BYTES + 1, mtime: 0, chunks: vec![h.clone()], expected_version: None }).unwrap_err();
        assert!(over.to_string().contains("exceeds size limit"), "over-limit must be the size-limit error (got: {over})");
        let at = v.commit(CommitRequest { path: "big.md".into(), hash: h.clone(), size: MAX_FILE_BYTES, mtime: 0, chunks: vec![h.clone()], expected_version: None }).unwrap_err();
        assert!(!at.to_string().contains("exceeds size limit"), "size == limit passes the gate, failing later as a mismatch (got: {at})");
    }

    // commit's integrity check is `len != size || hash != claimed`. Weakening the `||` to `&&` would
    // accept a right-SIZE but WRONG-HASH body — laundering corruption into a committed, served file.
    #[test]
    fn commit_rejects_correct_size_but_wrong_hash() {
        let dir = tempfile::tempdir().unwrap();
        let mut v = Vault::open(dir.path()).unwrap();
        let body = b"abc"; let h = sha256_hex(body); v.put_chunk(&h, body).unwrap();
        let wrong = sha256_hex(b"different");
        let e = v.commit(CommitRequest { path: "n.md".into(), hash: wrong, size: 3, mtime: 0, chunks: vec![h.clone()], expected_version: None }).unwrap_err();
        assert!(e.to_string().contains("hash/size mismatch"), "a right-size wrong-hash body must be rejected (got: {e})");
    }

    // commit's idempotent short-circuit is `hash == req.hash && chunks == req.chunks`. Weakening the
    // `&&` to `||` would treat a same-hash but DIFFERENTLY-CHUNKED re-commit as a no-op, freezing the
    // stale chunk list so a genuine re-chunk never takes effect.
    #[test]
    fn commit_idempotency_requires_both_hash_and_chunks_to_match() {
        let dir = tempfile::tempdir().unwrap();
        let mut v = Vault::open(dir.path()).unwrap();
        let body = b"helloworld"; let h = sha256_hex(body);
        v.put_chunk(&h, body).unwrap(); // decomposition A: one whole-body chunk
        v.commit(CommitRequest { path: "n.md".into(), hash: h.clone(), size: 10, mtime: 0, chunks: vec![h.clone()], expected_version: None }).unwrap();
        // decomposition B: same body/hash, two chunks
        let (p1, p2) = (b"hello".as_slice(), b"world".as_slice());
        let (c1, c2) = (sha256_hex(p1), sha256_hex(p2));
        v.put_chunk(&c1, p1).unwrap(); v.put_chunk(&c2, p2).unwrap();
        v.commit(CommitRequest { path: "n.md".into(), hash: h.clone(), size: 10, mtime: 0, chunks: vec![c1.clone(), c2.clone()], expected_version: None }).unwrap();
        assert_eq!(v.file_meta("n.md").unwrap().chunks, vec![c1, c2], "a same-hash re-chunk must be recorded, not treated as idempotent");
    }

    // new_version = self.version + 1 in BOTH commit and delete; a mutant turning `+ 1` into `* 1` (no
    // bump) stalls the version so peers never see the change/tombstone.
    #[test]
    fn commit_and_delete_each_bump_the_version() {
        let dir = tempfile::tempdir().unwrap();
        let mut v = Vault::open(dir.path()).unwrap();
        let body = b"v"; let h = sha256_hex(body); v.put_chunk(&h, body).unwrap();
        let before = v.version();
        v.commit(CommitRequest { path: "n.md".into(), hash: h.clone(), size: 1, mtime: 0, chunks: vec![h.clone()], expected_version: None }).unwrap();
        assert_eq!(v.version(), before + 1, "commit must bump the version");
        let after_commit = v.version();
        v.delete("n.md").unwrap();
        assert_eq!(v.version(), after_commit + 1, "delete must bump the version");
    }
}
