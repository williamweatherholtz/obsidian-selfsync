// The per-vault SQLite index store (D0018) — SQLite (WAL) replacing the hand-rolled JSON snapshot +
// append-only journal. This is the storage-format-dependent scale + corruption answer: indexed
// changes(since) (RS-5), row-level writes with no whole-index clone (RS-2), no full snapshot (RS-6),
// bounded open (RS-7), and WAL + page checksums so bit-rot / a crash mid-write is a near-non-event.
//
// STEP 1 (this module): the store + schema + operations Vault needs, standalone + unit-tested. The
// live Vault still uses its JSON index; STEP 2 ports Vault onto this, STEP 3 forward-migrates the
// on-disk JSON index into it. Kept a concrete struct (the module IS the seam, D0018) — a trait/
// Postgres impl is deferred until a real need. The Connection lives behind a Mutex so the store is
// Sync (rusqlite::Connection is Send but !Sync) and drops into Arc<RwLock<Vault>> as axum State.
//
// SCHEMA (normalized so a chunk's reference count is an indexed query, not a stored counter):
//   meta(key TEXT PK, value INTEGER)                    -- 'version', 'history_floor'
//   files(path TEXT PK, hash, size, mtime, version)     -- + idx on version for changes(since)
//   file_chunks(path, seq, chunk, PK(path,seq))         -- ordered chunk list; + idx on chunk
//   deletions(path, version)                            -- tombstones; + idx on version

use crate::protocol::{ChangesResponse, Deletion, FileMeta};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use std::sync::Mutex;

fn io<E: std::fmt::Display>(e: E) -> std::io::Error {
    std::io::Error::other(e.to_string())
}

pub struct SqliteIndex {
    conn: Mutex<Connection>,
}

const SCHEMA: &str = "
    PRAGMA journal_mode=WAL;
    -- FULL (not NORMAL): fsync the WAL on every commit so an acked write survives power loss. The
    -- index is the authority (a committed file is 'durable' only if its index row is), and a
    -- self-hosted server runs on consumer hardware where power loss is real. (R10-D1)
    PRAGMA synchronous=FULL;
    -- Wait up to 5s for a competing writer instead of erroring immediately with SQLITE_BUSY — two
    -- requests can race to open/reindex the same cold vault through separate connections. (R10-D2)
    PRAGMA busy_timeout=5000;
    PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY, hash TEXT NOT NULL, size INTEGER NOT NULL,
        mtime INTEGER NOT NULL, version INTEGER NOT NULL, fold TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_files_version ON files(version);
    -- NOTE: the idx_files_fold index is created in migrate(), NOT here — applying this batch to a
    -- pre-`fold` DB would otherwise fail creating an index on a column that doesn't exist yet (R12-CC1).
    CREATE TABLE IF NOT EXISTS file_chunks (
        path TEXT NOT NULL, seq INTEGER NOT NULL, chunk TEXT NOT NULL, PRIMARY KEY(path, seq));
    CREATE INDEX IF NOT EXISTS idx_fc_chunk ON file_chunks(chunk);
    CREATE INDEX IF NOT EXISTS idx_fc_path ON file_chunks(path);
    CREATE TABLE IF NOT EXISTS deletions (path TEXT NOT NULL, version INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_del_version ON deletions(version);
";

impl SqliteIndex {
    // The on-disk table-shape version this binary understands. Bump + add a migrate() step for any
    // change to the `files`/`file_chunks`/`deletions` columns.
    const CURRENT_SCHEMA: u64 = 1;

    // Open (creating if absent) the per-vault index DB, apply the schema (idempotent), seed the
    // version + history_floor. WAL makes concurrent readers + a single writer crash-safe.
    pub fn open(path: &Path) -> std::io::Result<Self> {
        let conn = Connection::open(path).map_err(io)?;
        conn.execute_batch(SCHEMA).map_err(io)?; // creates tables on a FRESH db; a NO-OP on an existing one
        conn.execute("INSERT OR IGNORE INTO meta(key, value) VALUES ('version', 1)", []).map_err(io)?;
        conn.execute("INSERT OR IGNORE INTO meta(key, value) VALUES ('history_floor', 1)", []).map_err(io)?;
        conn.execute("INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', 1)", []).map_err(io)?;
        Self::migrate(&conn)?;
        Ok(SqliteIndex { conn: Mutex::new(conn) })
    }

    // R12-CC1: a REAL schema-migration seam. `CREATE TABLE IF NOT EXISTS` can only create tables on
    // a fresh DB — it can NEVER add a column to an existing table — and `schema_version` was written
    // but never read, so any column added to an existing table silently broke every write (the
    // shipped `fold` column already proved this). Now: (a) refuse to open a DB from a NEWER binary
    // (downgrade guard — don't run queries against an unknown shape and corrupt it); (b) run explicit
    // per-version migrations; (c) stamp the current version. Future changes add an `if v < N { … }` step.
    fn migrate(conn: &Connection) -> std::io::Result<()> {
        let v = Self::meta_get(conn, "schema_version").unwrap_or(1);
        if v > Self::CURRENT_SCHEMA {
            // R14-DI1: use a DISTINCT ErrorKind (Unsupported) so Vault::open can tell "newer schema —
            // refuse to open" apart from "corrupt DB — quarantine + rebuild". These need opposite
            // handling: a downgrade must be a HARD refusal (the DB is intact and authoritative — a
            // rebuild-from-disk here would destroy tombstones + rewind the version epoch, exactly the
            // damage this guard exists to prevent), NOT quarantine. SQLite/other failures stay Other.
            return Err(std::io::Error::new(std::io::ErrorKind::Unsupported, format!(
                "this vault's index was written by a NEWER server (schema v{v} > v{}); refusing to open \
                 with an older binary to avoid corruption — upgrade the server binary", Self::CURRENT_SCHEMA
            )));
        }
        // Heal a pre-`fold` DB (files table created before the fold column existed): it opens fine
        // but every INSERT / case-collision check referencing `fold` would fail. Add + backfill it.
        let has_fold: i64 = conn
            .query_row("SELECT COUNT(*) FROM pragma_table_info('files') WHERE name='fold'", [], |r| r.get(0))
            .map_err(io)?;
        if has_fold == 0 {
            conn.execute_batch(
                "ALTER TABLE files ADD COLUMN fold TEXT NOT NULL DEFAULT '';\n\
                 UPDATE files SET fold = lower(path);",
            ).map_err(io)?;
        }
        // Create the fold index here (moved out of SCHEMA) — now that the column is guaranteed to
        // exist on both a fresh and a just-healed DB. Idempotent on an already-indexed DB.
        conn.execute("CREATE INDEX IF NOT EXISTS idx_files_fold ON files(fold)", []).map_err(io)?;
        if v != Self::CURRENT_SCHEMA {
            conn.execute("UPDATE meta SET value=?1 WHERE key='schema_version'", params![Self::CURRENT_SCHEMA as i64]).map_err(io)?;
        }
        Ok(())
    }

    fn meta_get(conn: &Connection, key: &str) -> std::io::Result<u64> {
        conn.query_row("SELECT value FROM meta WHERE key=?1", params![key], |r| r.get::<_, i64>(0))
            .optional().map_err(io)?.map(|v| v as u64).ok_or_else(|| io(format!("meta '{key}' missing")))
    }

    pub fn version(&self) -> std::io::Result<u64> {
        let conn = self.conn.lock().map_err(io)?;
        Self::meta_get(&conn, "version")
    }

    // The oldest version at/above which deletion history is COMPLETE. Below it, tombstones may have
    // been rebased away — a client whose cursor is under the floor must reconcile conservatively
    // (historyRebase / RC-1). Genesis = 1 (full history) until a rebase advances it.
    pub fn history_floor(&self) -> std::io::Result<u64> {
        let conn = self.conn.lock().map_err(io)?;
        Self::meta_get(&conn, "history_floor")
    }

    // Raise the deletion-history floor (D0019): the version at/above which tombstone history is
    // COMPLETE. Called when a reindex rebuilds from disk and tombstones are unrecoverable — the
    // history is reset, so the floor moves up to the current version. Set-exact (a corrupt reindex
    // starts a fresh version epoch, so a MAX against a lost old value is meaningless).
    pub fn set_history_floor(&self, version: u64) -> std::io::Result<()> {
        let conn = self.conn.lock().map_err(io)?;
        conn.execute("UPDATE meta SET value=?1 WHERE key='history_floor'", params![version as i64]).map_err(io)?;
        Ok(())
    }

    fn chunks_of(conn: &Connection, path: &str) -> std::io::Result<Vec<String>> {
        let mut stmt = conn.prepare("SELECT chunk FROM file_chunks WHERE path=?1 ORDER BY seq").map_err(io)?;
        let rows = stmt.query_map(params![path], |r| r.get::<_, String>(0)).map_err(io)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(io)
    }

    fn row_to_meta(conn: &Connection, path: String, hash: String, size: i64, mtime: i64, version: i64) -> std::io::Result<FileMeta> {
        let chunks = Self::chunks_of(conn, &path)?;
        Ok(FileMeta { path, hash, size: size as u64, mtime, version: version as u64, chunks })
    }

    pub fn file_meta(&self, path: &str) -> std::io::Result<Option<FileMeta>> {
        let conn = self.conn.lock().map_err(io)?;
        let row = conn.query_row("SELECT hash, size, mtime, version FROM files WHERE path=?1", params![path],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?)))
            .optional().map_err(io)?;
        match row {
            Some((hash, size, mtime, version)) => Ok(Some(Self::row_to_meta(&conn, path.to_string(), hash, size, mtime, version)?)),
            None => Ok(None),
        }
    }

    // All files with version > since (upserts) + all tombstones with version > since (deletes),
    // via the version indexes — O(changed), not O(all). The empty-since (0) full manifest is the
    // one whole-table scan (bounded by file count), used on first sync / a full reconcile.
    pub fn changes(&self, since: u64) -> std::io::Result<ChangesResponse> {
        let conn = self.conn.lock().map_err(io)?;
        let version = Self::meta_get(&conn, "version")?;
        let history_floor = Self::meta_get(&conn, "history_floor")?;
        let mut upserts = Vec::new();
        {
            let mut stmt = conn.prepare("SELECT path, hash, size, mtime, version FROM files WHERE version > ?1").map_err(io)?;
            let rows = stmt.query_map(params![since as i64], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?, r.get::<_, i64>(4)?))).map_err(io)?;
            for row in rows { let (p, h, s, m, v) = row.map_err(io)?; upserts.push(Self::row_to_meta(&conn, p, h, s, m, v)?); }
        }
        let mut deletes = Vec::new();
        {
            let mut stmt = conn.prepare("SELECT path, version FROM deletions WHERE version > ?1").map_err(io)?;
            let rows = stmt.query_map(params![since as i64], |r| Ok(Deletion { path: r.get(0)?, version: r.get::<_, i64>(1)? as u64 })).map_err(io)?;
            for row in rows { deletes.push(row.map_err(io)?); }
        }
        Ok(ChangesResponse { version, upserts, deletes, history_floor })
    }

    // Every indexed path (for reindex's missing-from-disk / verify passes).
    pub fn all_paths(&self) -> std::io::Result<Vec<String>> {
        let conn = self.conn.lock().map_err(io)?;
        let mut stmt = conn.prepare("SELECT path FROM files").map_err(io)?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(io)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(io)
    }

    pub fn chunk_referenced(&self, hash: &str) -> std::io::Result<bool> {
        let conn = self.conn.lock().map_err(io)?;
        conn.query_row("SELECT EXISTS(SELECT 1 FROM file_chunks WHERE chunk=?1)", params![hash], |r| r.get::<_, i64>(0))
            .map(|n| n != 0).map_err(io)
    }

    pub fn all_referenced_chunks(&self) -> std::io::Result<Vec<String>> {
        let conn = self.conn.lock().map_err(io)?;
        let mut stmt = conn.prepare("SELECT DISTINCT chunk FROM file_chunks").map_err(io)?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(io)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(io)
    }

    // Upsert a file version (caller sets meta.version = next). Atomic: replace the row + its chunk
    // list, clear any tombstone for the path, and bump the stored version. Returns the chunks that
    // are now UNREFERENCED (were on the old version, not on the new, and used by no other file) so
    // the caller can drop those blobs — mirrors the JSON index's decref-collect.
    pub fn put(&self, meta: &FileMeta) -> std::io::Result<Vec<String>> {
        let mut conn = self.conn.lock().map_err(io)?;
        let tx = conn.transaction().map_err(io)?;
        let old = Self::chunks_of(&tx, &meta.path)?;
        tx.execute("INSERT INTO files(path, hash, size, mtime, version, fold) VALUES (?1,?2,?3,?4,?5,?6)
                    ON CONFLICT(path) DO UPDATE SET hash=?2, size=?3, mtime=?4, version=?5, fold=?6",
                   params![meta.path, meta.hash, meta.size as i64, meta.mtime, meta.version as i64, meta.path.to_lowercase()]).map_err(io)?;
        tx.execute("DELETE FROM file_chunks WHERE path=?1", params![meta.path]).map_err(io)?;
        for (i, c) in meta.chunks.iter().enumerate() {
            tx.execute("INSERT INTO file_chunks(path, seq, chunk) VALUES (?1,?2,?3)", params![meta.path, i as i64, c]).map_err(io)?;
        }
        tx.execute("DELETE FROM deletions WHERE path=?1", params![meta.path]).map_err(io)?;
        tx.execute("UPDATE meta SET value=MAX(value, ?1) WHERE key='version'", params![meta.version as i64]).map_err(io)?;
        // De-referenced = old chunks not in the new set AND now referenced by no file.
        let newset: std::collections::HashSet<&String> = meta.chunks.iter().collect();
        let mut dereferenced = Vec::new();
        for c in &old {
            if newset.contains(c) { continue; }
            let still: i64 = tx.query_row("SELECT EXISTS(SELECT 1 FROM file_chunks WHERE chunk=?1)", params![c], |r| r.get(0)).map_err(io)?;
            if still == 0 { dereferenced.push(c.clone()); }
        }
        tx.commit().map_err(io)?;
        Ok(dereferenced)
    }

    // Deliberate operator PRUNE (D0019 / tombstonePrune): physically drop tombstones strictly below
    // `floor` AND raise history_floor to it, atomically. Reclaims tombstone space; safe because a
    // client that ends up below the raised floor reconciles conservatively (keep + push + notify) per
    // the horizon. Returns the number of tombstones removed. Caller clamps floor to [current_floor, version].
    pub fn prune_tombstones(&self, floor: u64) -> std::io::Result<usize> {
        let mut conn = self.conn.lock().map_err(io)?;
        let tx = conn.transaction().map_err(io)?;
        let n = tx.execute("DELETE FROM deletions WHERE version < ?1", params![floor as i64]).map_err(io)?;
        tx.execute("UPDATE meta SET value=?1 WHERE key='history_floor'", params![floor as i64]).map_err(io)?;
        tx.commit().map_err(io)?;
        Ok(n)
    }

    // An existing index key that folds (full Unicode lower-case) to the same name as `path` but is
    // NOT `path` — the case/Unicode-collision guard commit uses (a folding FS would collapse them).
    // Uses the `fold` column (computed in Rust with to_lowercase, so it matches Rust's fold, not
    // SQLite's ASCII-only lower()).
    pub fn colliding_key(&self, path: &str) -> std::io::Result<Option<String>> {
        let conn = self.conn.lock().map_err(io)?;
        conn.query_row("SELECT path FROM files WHERE fold=?1 AND path<>?2 LIMIT 1",
                       params![path.to_lowercase(), path], |r| r.get::<_, String>(0)).optional().map_err(io)
    }

    // Transactionally REPLACE all file rows (+ their chunk lists) with `metas` and set the version —
    // reindex's rebuild. Tombstones (deletions) are left intact (a healthy reindex keeps history).
    pub fn replace_files(&self, metas: &[FileMeta], version: u64) -> std::io::Result<()> {
        let mut conn = self.conn.lock().map_err(io)?;
        let tx = conn.transaction().map_err(io)?;
        tx.execute("DELETE FROM file_chunks", []).map_err(io)?;
        tx.execute("DELETE FROM files", []).map_err(io)?;
        for m in metas {
            tx.execute("INSERT INTO files(path, hash, size, mtime, version, fold) VALUES (?1,?2,?3,?4,?5,?6)",
                       params![m.path, m.hash, m.size as i64, m.mtime, m.version as i64, m.path.to_lowercase()]).map_err(io)?;
            for (i, c) in m.chunks.iter().enumerate() {
                tx.execute("INSERT INTO file_chunks(path, seq, chunk) VALUES (?1,?2,?3)", params![m.path, i as i64, c]).map_err(io)?;
            }
        }
        tx.execute("UPDATE meta SET value=MAX(value, ?1) WHERE key='version'", params![version as i64]).map_err(io)?;
        tx.commit().map_err(io)?;
        Ok(())
    }

    // Delete a path: remove its row + chunks, record a tombstone at `version`, bump the stored
    // version. Returns the Deletion + the chunks now unreferenced (None if the path wasn't present).
    pub fn delete(&self, path: &str, version: u64) -> std::io::Result<Option<(Deletion, Vec<String>)>> {
        let mut conn = self.conn.lock().map_err(io)?;
        let tx = conn.transaction().map_err(io)?;
        let present: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM files WHERE path=?1)", params![path], |r| r.get::<_, i64>(0)).map_err(io)? != 0;
        if !present { return Ok(None); }
        let old = Self::chunks_of(&tx, path)?;
        tx.execute("DELETE FROM files WHERE path=?1", params![path]).map_err(io)?;
        tx.execute("DELETE FROM file_chunks WHERE path=?1", params![path]).map_err(io)?;
        tx.execute("INSERT INTO deletions(path, version) VALUES (?1,?2)", params![path, version as i64]).map_err(io)?;
        tx.execute("UPDATE meta SET value=MAX(value, ?1) WHERE key='version'", params![version as i64]).map_err(io)?;
        let mut dereferenced = Vec::new();
        for c in &old {
            let still: i64 = tx.query_row("SELECT EXISTS(SELECT 1 FROM file_chunks WHERE chunk=?1)", params![c], |r| r.get(0)).map_err(io)?;
            if still == 0 { dereferenced.push(c.clone()); }
        }
        tx.commit().map_err(io)?;
        Ok(Some((Deletion { path: path.to_string(), version }, dereferenced)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(path: &str, hash: &str, ver: u64, chunks: &[&str]) -> FileMeta {
        FileMeta { path: path.into(), hash: hash.into(), size: 4, mtime: 1, version: ver, chunks: chunks.iter().map(|s| s.to_string()).collect() }
    }

    #[test]
    fn migrate_heals_a_pre_fold_index() { // R12-CC1
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("i.db");
        // Simulate a DB created before the `fold` column existed: files table WITHOUT fold.
        {
            let conn = Connection::open(&p).unwrap();
            conn.execute_batch(
                "CREATE TABLE meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);\n\
                 CREATE TABLE files (path TEXT PRIMARY KEY, hash TEXT NOT NULL, size INTEGER NOT NULL, mtime INTEGER NOT NULL, version INTEGER NOT NULL);\n\
                 INSERT INTO files VALUES ('A.md','h',1,0,1);\n\
                 INSERT INTO meta(key,value) VALUES ('schema_version',1),('version',1),('history_floor',1);",
            ).unwrap();
        }
        // Opening must ADD + backfill `fold` (lowercased path), not leave a broken write path.
        let s = SqliteIndex::open(&p).unwrap();
        let conn = s.conn.lock().unwrap();
        let fold: String = conn.query_row("SELECT fold FROM files WHERE path='A.md'", [], |r| r.get(0)).unwrap();
        assert_eq!(fold, "a.md");
    }

    #[test]
    fn refuses_to_open_a_newer_schema_db() { // R12-CC1 downgrade guard
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("i.db");
        drop(SqliteIndex::open(&p).unwrap());
        { let conn = Connection::open(&p).unwrap(); conn.execute("UPDATE meta SET value=999 WHERE key='schema_version'", []).unwrap(); }
        let err = match SqliteIndex::open(&p) { Ok(_) => panic!("must refuse a DB written by a newer binary"), Err(e) => e };
        // R14-DI1: the downgrade error MUST be a distinct kind so Vault::open can refuse (not quarantine).
        assert_eq!(err.kind(), std::io::ErrorKind::Unsupported);
    }

    #[test]
    fn open_seeds_version_and_floor() {
        let dir = tempfile::tempdir().unwrap();
        let s = SqliteIndex::open(&dir.path().join("i.db")).unwrap();
        assert_eq!(s.version().unwrap(), 1);
        assert_eq!(s.history_floor().unwrap(), 1);
    }

    #[test]
    fn put_then_file_meta_and_changes() {
        let dir = tempfile::tempdir().unwrap();
        let s = SqliteIndex::open(&dir.path().join("i.db")).unwrap();
        s.put(&meta("a.md", "ha", 2, &["c1", "c2"])).unwrap();
        s.put(&meta("b.md", "hb", 3, &["c3"])).unwrap();
        assert_eq!(s.version().unwrap(), 3);
        let m = s.file_meta("a.md").unwrap().unwrap();
        assert_eq!(m.hash, "ha"); assert_eq!(m.chunks, vec!["c1", "c2"]); assert_eq!(m.version, 2);
        // changes(since) is incremental: since=2 returns only b.md (version 3), not a.md.
        let ch = s.changes(2).unwrap();
        assert_eq!(ch.version, 3);
        assert_eq!(ch.upserts.iter().map(|m| m.path.clone()).collect::<Vec<_>>(), vec!["b.md"]);
        // full manifest
        assert_eq!(s.changes(0).unwrap().upserts.len(), 2);
        assert!(s.file_meta("missing.md").unwrap().is_none());
    }

    #[test]
    fn put_dereferences_replaced_chunks_but_keeps_shared() {
        let dir = tempfile::tempdir().unwrap();
        let s = SqliteIndex::open(&dir.path().join("i.db")).unwrap();
        s.put(&meta("a.md", "h1", 2, &["shared", "old"])).unwrap();
        s.put(&meta("b.md", "h2", 3, &["shared"])).unwrap(); // shares 'shared'
        // re-commit a.md dropping 'old' and 'shared' -> 'old' de-refs (only a had it); 'shared' stays (b has it).
        let deref = s.put(&meta("a.md", "h3", 4, &["new"])).unwrap();
        assert_eq!(deref, vec!["old"]);
        assert!(s.chunk_referenced("shared").unwrap(), "still referenced by b.md");
        assert!(!s.chunk_referenced("old").unwrap());
    }

    #[test]
    fn delete_tombstones_and_dereferences() {
        let dir = tempfile::tempdir().unwrap();
        let s = SqliteIndex::open(&dir.path().join("i.db")).unwrap();
        s.put(&meta("a.md", "h1", 2, &["c1", "shared"])).unwrap();
        s.put(&meta("b.md", "h2", 3, &["shared"])).unwrap();
        let (del, deref) = s.delete("a.md", 4).unwrap().unwrap();
        assert_eq!(del.version, 4);
        assert_eq!(deref, vec!["c1"]);                 // c1 dropped, 'shared' kept (b.md)
        assert!(s.file_meta("a.md").unwrap().is_none());
        assert_eq!(s.changes(3).unwrap().deletes.iter().map(|d| d.path.clone()).collect::<Vec<_>>(), vec!["a.md"]);
        assert!(s.delete("a.md", 5).unwrap().is_none(), "deleting an absent path is a no-op");
    }

    #[test]
    fn colliding_key_finds_unicode_fold() {
        let dir = tempfile::tempdir().unwrap();
        let s = SqliteIndex::open(&dir.path().join("i.db")).unwrap();
        s.put(&meta("CAFÉ.md", "h", 2, &["c"])).unwrap();
        assert_eq!(s.colliding_key("café.md").unwrap().as_deref(), Some("CAFÉ.md")); // Unicode fold
        assert_eq!(s.colliding_key("CAFÉ.md").unwrap(), None);                        // same key, not a collision
        assert_eq!(s.colliding_key("other.md").unwrap(), None);
    }

    #[test]
    fn replace_files_rebuilds_and_keeps_tombstones() {
        let dir = tempfile::tempdir().unwrap();
        let s = SqliteIndex::open(&dir.path().join("i.db")).unwrap();
        s.put(&meta("old.md", "h", 2, &["c1"])).unwrap();
        s.delete("gone.md", 3).ok(); // no-op (absent) — but record a real tombstone via put+delete:
        s.put(&meta("t.md", "h", 4, &["c1"])).unwrap();
        s.delete("t.md", 5).unwrap();
        // Rebuild with a fresh set; tombstone for t.md must survive.
        s.replace_files(&[meta("new.md", "h2", 9, &["c2"])], 9).unwrap();
        assert_eq!(s.all_paths().unwrap(), vec!["new.md"]);
        assert!(s.file_meta("old.md").unwrap().is_none());
        assert_eq!(s.version().unwrap(), 9);
        assert!(s.changes(4).unwrap().deletes.iter().any(|d| d.path == "t.md"), "tombstone kept across rebuild");
    }

    #[test]
    fn history_floor_set_and_reported_in_changes() {
        let dir = tempfile::tempdir().unwrap();
        let s = SqliteIndex::open(&dir.path().join("i.db")).unwrap();
        assert_eq!(s.changes(0).unwrap().history_floor, 1, "genesis floor reported in changes");
        s.put(&meta("a.md", "h", 5, &["c"])).unwrap();
        s.set_history_floor(5).unwrap();
        assert_eq!(s.history_floor().unwrap(), 5);
        assert_eq!(s.changes(0).unwrap().history_floor, 5, "raised floor reported in changes");
    }

    #[test]
    fn prune_tombstones_drops_below_floor_and_raises_it() {
        let dir = tempfile::tempdir().unwrap();
        let s = SqliteIndex::open(&dir.path().join("i.db")).unwrap();
        s.put(&meta("a.md", "h", 2, &["c"])).unwrap(); s.delete("a.md", 3).unwrap();
        s.put(&meta("b.md", "h", 4, &["c"])).unwrap(); s.delete("b.md", 5).unwrap();
        // Prune below floor 4: a.md's tombstone (v3) goes, b.md's (v5) stays; floor raised to 4.
        let n = s.prune_tombstones(4).unwrap();
        assert_eq!(n, 1);
        assert_eq!(s.history_floor().unwrap(), 4);
        let dels: Vec<_> = s.changes(0).unwrap().deletes.iter().map(|d| d.path.clone()).collect();
        assert_eq!(dels, vec!["b.md"], "only the below-floor tombstone pruned");
    }

    #[test]
    fn survives_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("i.db");
        { let s = SqliteIndex::open(&path).unwrap(); s.put(&meta("n.md", "h", 2, &["c"])).unwrap(); }
        let s2 = SqliteIndex::open(&path).unwrap();
        assert_eq!(s2.version().unwrap(), 2);
        assert_eq!(s2.file_meta("n.md").unwrap().unwrap().chunks, vec!["c"]);
    }
}
