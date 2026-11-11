// E2EE server tests at the Vault level (E2, D0102/D0103, spec sections 4.4 to 4.6). A child module of
// vault.rs with private access: the flag derivation, both open refusals, the frame-splitting rebuild,
// the three-condition pre-pass abort, commit and put_chunk verification, and the mirror trailer.
use super::*;
use crate::error::{e2ee_refusal_body, E2EE_KEYRING_MISSING_MSG, E2EE_MIXED_MSG, E2EE_NO_MIRROR_MSG, E2EE_STALE_INDEX_MSG, E2EE_STALE_KEYRING_MSG};
use crate::frame::{trailer_for, FRAME_OVERHEAD, HEADER_LEN, TRAILER_LEN};

const KEYRING: &[u8] = br#"{"version":1,"vault_id":"EBESExQVFhcYGRobHB0eHw==","kdf":{"alg":"argon2id","m_kib":64,"t":1,"p":1,"salt":"oKGio6SlpqeoqaqrrK2urw=="},"check":"00","wrap":{"alg":"A256GCM","nonce":"0NHS09TV1tfY2drb","ct":"AA=="}}"#;

fn sidecar(root: &Path) { std::fs::write(Vault::keyring_path(root), KEYRING).unwrap(); }

// Vault is not Debug, so unwrap_err is unavailable: the refusal, or a panic.
fn open_err(root: &Path) -> std::io::Error {
    match Vault::open(root) { Ok(_) => panic!("expected the open to be refused"), Err(e) => e }
}

// A frame with `pt_len` bytes of plaintext: the server never holds a key, so the ciphertext is any bytes.
// `seed` makes distinct frames.
fn frame(pt_len: usize, seed: u8) -> Vec<u8> {
    let mut f = vec![0u8; FRAME_OVERHEAD + pt_len];
    f[..4].copy_from_slice(b"SSE1");
    for (i, b) in f[4..16].iter_mut().enumerate() { *b = seed.wrapping_add(i as u8); }
    f[16..20].copy_from_slice(&((pt_len + 48) as u32).to_le_bytes());
    for (i, b) in f[HEADER_LEN..].iter_mut().enumerate() { *b = seed ^ (i as u8); }
    f
}

fn cid(n: u8) -> String { format!("{:02x}", n).repeat(32) }

fn req(path: &str, frames: &[Vec<u8>], cid: Option<String>) -> CommitRequest {
    let mut stream = Vec::new();
    let mut pt = 0u64;
    for f in frames { stream.extend_from_slice(f); pt += (f.len() - FRAME_OVERHEAD) as u64; }
    CommitRequest { path: path.into(), hash: sha256_hex(&stream), size: pt, mtime: 1,
        chunks: frames.iter().map(|f| sha256_hex(f)).collect(), expected_version: None, device_id: None, device_name: None, cid }
}

fn commit_frames(v: &mut Vault, path: &str, frames: &[Vec<u8>], c: u8) -> FileMeta {
    for f in frames { v.put_chunk(&sha256_hex(f), f).unwrap(); }
    v.commit(req(path, frames, Some(cid(c))), "").unwrap()
}

fn remove_index(root: &Path) {
    for s in ["", "-wal", "-shm"] { let _ = std::fs::remove_file(root.join(format!(".sync-index.db{s}"))); }
}

// (4) The flag derives from the sidecar on a fresh open, the index is stamped 4, and the flag is read from
// memory on a reopen. A plaintext vault stays unflagged.
#[test]
fn encrypted_flag_derives_from_the_sidecar_on_a_fresh_open_and_persists() {
    let dir = tempfile::tempdir().unwrap();
    sidecar(dir.path());
    {
        let v = Vault::open(dir.path()).unwrap();
        assert!(v.encrypted());
        assert_eq!(v.index.schema_version().unwrap(), crate::index_store::SqliteIndex::CURRENT_SCHEMA); // at least v4 (E2EE); v5 since D0116
        assert_eq!(v.keyring_bytes().unwrap().unwrap(), KEYRING);
    }
    let v = Vault::open(dir.path()).unwrap();
    assert!(v.encrypted(), "the flag is in the index, so a reopen reads it without the sidecar scan");
    let plain = tempfile::tempdir().unwrap();
    let p = Vault::open(plain.path()).unwrap();
    assert!(!p.encrypted());
    assert!(p.keyring_bytes().unwrap().is_none());
}

// (4) Refusal one: encrypted=1 and no sidecar. The open fails with the path-free body, is never cached (no
// Vault value exists), and comes back once the sidecar is restored.
#[test]
fn refusal_one_when_the_flag_is_set_and_the_sidecar_is_gone() {
    let dir = tempfile::tempdir().unwrap();
    sidecar(dir.path());
    { Vault::open(dir.path()).unwrap(); }
    std::fs::remove_file(Vault::keyring_path(dir.path())).unwrap();
    let e = open_err(dir.path());
    assert_eq!(e2ee_refusal_body(&e), Some(E2EE_KEYRING_MISSING_MSG));
    sidecar(dir.path());
    assert!(Vault::open(dir.path()).unwrap().encrypted());
}

// (4) Refusal two, four bodies: a sidecar over a NON-fresh index without the flag. The magic scan names the
// stale part: all frames (index stale), none (keyring stale), mixed (both counts), no mirror file (both remedies).
#[test]
fn refusal_two_names_the_stale_part_from_the_mirror_magic() {
    // none: a plaintext vault with a committed plaintext file.
    let dir = tempfile::tempdir().unwrap();
    {
        let mut v = Vault::open(dir.path()).unwrap();
        let b = b"plain note"; let h = sha256_hex(b);
        v.put_chunk(&h, b).unwrap();
        v.commit(CommitRequest { path: "a.md".into(), hash: h.clone(), size: b.len() as u64, mtime: 1, chunks: vec![h], expected_version: None, device_id: None, device_name: None, cid: None }, "").unwrap();
    }
    sidecar(dir.path());
    let e = open_err(dir.path());
    assert_eq!(e2ee_refusal_body(&e), Some(E2EE_STALE_KEYRING_MSG));
    // all frames: a plaintext vault whose only committed file is frame-shaped (a host-FS edit can do that).
    let dir2 = tempfile::tempdir().unwrap();
    {
        let mut v = Vault::open(dir2.path()).unwrap();
        let f = frame(5, 1); let h = sha256_hex(&f);
        v.put_chunk(&h, &f).unwrap();
        v.commit(CommitRequest { path: "f.bin".into(), hash: h.clone(), size: f.len() as u64, mtime: 1, chunks: vec![h], expected_version: None, device_id: None, device_name: None, cid: None }, "").unwrap();
    }
    sidecar(dir2.path());
    let e = open_err(dir2.path());
    assert_eq!(e2ee_refusal_body(&e), Some(E2EE_STALE_INDEX_MSG));
    // mixed: add a plaintext file beside the frame file.
    std::fs::remove_file(Vault::keyring_path(dir2.path())).unwrap();
    {
        let mut v = Vault::open(dir2.path()).unwrap();
        let b = b"plain"; let h = sha256_hex(b);
        v.put_chunk(&h, b).unwrap();
        v.commit(CommitRequest { path: "p.md".into(), hash: h.clone(), size: 5, mtime: 1, chunks: vec![h], expected_version: None, device_id: None, device_name: None, cid: None }, "").unwrap();
    }
    sidecar(dir2.path());
    let e = open_err(dir2.path());
    let body = e2ee_refusal_body(&e).unwrap();
    assert!(body.starts_with(E2EE_MIXED_MSG), "{body}");
    assert!(body.ends_with("(1 encrypted, 1 plaintext)"), "{body}");
    // no mirror file: a non-fresh index that holds only a tombstone.
    let dir3 = tempfile::tempdir().unwrap();
    {
        let mut v = Vault::open(dir3.path()).unwrap();
        let b = b"gone"; let h = sha256_hex(b);
        v.put_chunk(&h, b).unwrap();
        v.commit(CommitRequest { path: "g.md".into(), hash: h.clone(), size: 4, mtime: 1, chunks: vec![h], expected_version: None, device_id: None, device_name: None, cid: None }, "").unwrap();
        v.delete("g.md").unwrap();
    }
    sidecar(dir3.path());
    let e = open_err(dir3.path());
    assert_eq!(e2ee_refusal_body(&e), Some(E2EE_NO_MIRROR_MSG));
}

// (3) put_chunk on a keyring vault accepts only frames; the refusal carries ErrorKind::Unsupported (422 at the
// API layer). A plaintext vault accepts anything, as before. (7) missing on a stored frame hash reports present.
#[test]
fn put_chunk_refuses_a_non_frame_on_an_encrypted_vault_only() {
    let dir = tempfile::tempdir().unwrap();
    sidecar(dir.path());
    let v = Vault::open(dir.path()).unwrap();
    let plain = b"not a frame"; let hp = sha256_hex(plain);
    let e = v.put_chunk(&hp, plain).unwrap_err();
    assert_eq!(e.kind(), std::io::ErrorKind::Unsupported);
    assert!(e.to_string().contains("SSE1"));
    let f = frame(11, 2); let hf = sha256_hex(&f);
    v.put_chunk(&hf, &f).unwrap();
    assert_eq!(v.missing(&[hf.clone(), hp.clone()]), vec![hp.clone()]);
    let pdir = tempfile::tempdir().unwrap();
    let p = Vault::open(pdir.path()).unwrap();
    p.put_chunk(&hp, plain).unwrap();
}

// (3) Commit on a keyring vault: an empty chunk list and a missing or malformed cid are InvalidInput; a
// plaintext sum that differs from the declared size is InvalidData; a good commit stores cid, returns it in
// changes and meta, and writes the mirror as frames plus the 36-byte trailer. (5) The idempotent self-heal
// rewrites the mirror with the trailer.
#[test]
fn commit_on_an_encrypted_vault_verifies_frames_and_writes_the_trailer() {
    let dir = tempfile::tempdir().unwrap();
    sidecar(dir.path());
    let mut v = Vault::open(dir.path()).unwrap();
    let frames = vec![frame(100, 3), frame(0, 4), frame(7, 5)];
    for f in &frames { v.put_chunk(&sha256_hex(f), f).unwrap(); }
    let empty = CommitRequest { path: "e.md".into(), hash: sha256_hex(b""), size: 0, mtime: 1, chunks: vec![], expected_version: None, device_id: None, device_name: None, cid: Some(cid(1)) };
    assert_eq!(v.commit(empty, "").unwrap_err().kind(), std::io::ErrorKind::InvalidInput);
    assert_eq!(v.commit(req("n.md", &frames, None), "").unwrap_err().kind(), std::io::ErrorKind::InvalidInput);
    assert_eq!(v.commit(req("n.md", &frames, Some("ZZ".repeat(32))), "").unwrap_err().kind(), std::io::ErrorKind::InvalidInput);
    let mut wrong = req("n.md", &frames, Some(cid(1))); wrong.size += 1;
    assert_eq!(v.commit(wrong, "").unwrap_err().kind(), std::io::ErrorKind::InvalidData);
    let mut wrong_hash = req("n.md", &frames, Some(cid(1))); wrong_hash.hash = sha256_hex(b"x");
    assert_eq!(v.commit(wrong_hash, "").unwrap_err().kind(), std::io::ErrorKind::InvalidData);
    let m = v.commit(req("n.md", &frames, Some(cid(1))), "").unwrap();
    assert_eq!(m.size, 107);
    assert_eq!(m.cid.as_deref(), Some(cid(1).as_str()));
    assert_eq!(v.file_meta("n.md").unwrap().cid, m.cid);
    assert_eq!(v.changes(0).upserts[0].cid, m.cid);
    let mirror = dir.path().join("vault").join("n.md");
    let bytes = std::fs::read(&mirror).unwrap();
    let stream: Vec<u8> = frames.concat();
    assert_eq!(bytes.len(), stream.len() + TRAILER_LEN);
    assert_eq!(&bytes[..stream.len()], &stream[..]);
    assert_eq!(&bytes[stream.len()..], &trailer_for(&cid(1)).unwrap()[..]);
    std::fs::remove_file(&mirror).unwrap();
    v.commit(req("n.md", &frames, Some(cid(1))), "").unwrap(); // idempotent re-commit self-heals
    assert_eq!(std::fs::read(&mirror).unwrap(), bytes);
    // a bound: repeating a frame past the declared size is refused before it grows
    let mut rep = req("r.md", &frames, Some(cid(2)));
    rep.chunks = vec![rep.chunks[0].clone(); 50];
    assert_eq!(v.commit(rep, "").unwrap_err().kind(), std::io::ErrorKind::InvalidData);
}

// (5) Rebuild-from-disk through the frame splitter: the corrupt-index rebuild gives a row equal to the
// committed row (hash, size, chunks, cid), and the recovered chunks are in the store.
#[test]
fn rebuild_from_the_mirror_equals_the_committed_row() {
    let dir = tempfile::tempdir().unwrap();
    sidecar(dir.path());
    let frames = vec![frame(3000, 6), frame(1, 7)];
    let committed = {
        let mut v = Vault::open(dir.path()).unwrap();
        commit_frames(&mut v, "deep/n.md", &frames, 9)
    };
    remove_index(dir.path());
    let v = Vault::open(dir.path()).unwrap();
    assert!(!v.is_corrupt(), "auto-repaired from the mirror");
    assert!(v.encrypted(), "a fresh index with a sidecar derives the flag before the rebuild");
    let row = v.file_meta("deep/n.md").unwrap();
    assert_eq!((row.hash, row.size, row.chunks, row.cid), (committed.hash, committed.size, committed.chunks, committed.cid));
    for f in &frames { assert!(v.has_chunk(&sha256_hex(f))); }
    // the missing-chunk fallthrough: drop one chunk, reopen, the mirror rebuilds it
    std::fs::remove_file(dir.path().join(".chunks").join(&sha256_hex(&frames[1])[0..2]).join(sha256_hex(&frames[1]))).unwrap();
    drop(v);
    let v = Vault::open(dir.path()).unwrap();
    assert!(!v.is_corrupt());
    assert!(v.has_chunk(&sha256_hex(&frames[1])));
    assert_eq!(v.file_meta("deep/n.md").unwrap().cid.as_deref(), Some(cid(9).as_str()));
}

// (5) The three-condition pre-pass on a plaintext vault: a frame-stream file this vault never committed
// (no sidecar, parses, CDC chunks not in the store) aborts with a named reason BEFORE any store write.
// `force` does not override it. Moving the file out and reindexing clears the reason. A plaintext vault
// that COMMITTED a frame-shaped file still reindexes, because its CDC chunks are in the store.
#[test]
fn no_sidecar_rebuild_aborts_on_an_uncommitted_frame_stream_and_stores_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let mut v = Vault::open(dir.path()).unwrap();
    let b = b"plain note"; let h = sha256_hex(b);
    v.put_chunk(&h, b).unwrap();
    v.commit(CommitRequest { path: "a.md".into(), hash: h.clone(), size: b.len() as u64, mtime: 1, chunks: vec![h], expected_version: None, device_id: None, device_name: None, cid: None }, "").unwrap();
    let mut dropped = frame(500, 8); dropped.extend_from_slice(&trailer_for(&cid(3)).unwrap());
    let abs = dir.path().join("vault").join("dropped.md");
    std::fs::write(&abs, &dropped).unwrap();
    let before: Vec<String> = v.store.list_hashes().unwrap();
    for _ in 0..2 {
        let e = v.reindex(false).unwrap_err();
        assert!(e.to_string().starts_with(ABORT_NO_SIDECAR_PREFIX), "{e}");
        assert!(e.to_string().contains("dropped.md"));
        assert!(v.is_corrupt());
        assert!(v.aborted_for_no_sidecar());
        assert_eq!(v.store.list_hashes().unwrap().len(), before.len(), "nothing stored before the abort");
    }
    let e = v.reindex(true).unwrap_err();
    assert!(e.to_string().starts_with(ABORT_NO_SIDECAR_PREFIX), "force does not override: {e}");
    std::fs::remove_file(&abs).unwrap();
    v.reindex(false).unwrap();
    assert!(!v.is_corrupt());
    assert!(v.abort_reason().is_none());
    // a committed frame-shaped file leaves its CDC chunks in the store, so a rebuild still ingests it
    let f = { let mut f = frame(20, 9); f.extend_from_slice(&trailer_for(&cid(4)).unwrap()); f };
    let hf = sha256_hex(&f);
    v.put_chunk(&hf, &f).unwrap();
    v.commit(CommitRequest { path: "f.bin".into(), hash: hf.clone(), size: f.len() as u64, mtime: 1, chunks: vec![hf], expected_version: None, device_id: None, device_name: None, cid: None }, "").unwrap();
    drop(v);
    remove_index(dir.path());
    let v = Vault::open(dir.path()).unwrap();
    assert!(!v.is_corrupt(), "a plaintext vault that committed a frame-shaped file reindexes");
    assert_eq!(v.file_meta("f.bin").unwrap().size, f.len() as u64);
}

// (5) With a sidecar: a fresh or quarantined rebuild aborts on a file that is not a frame stream, with its
// path, and force does not override it. A healthy reindex skips such a stray as foreign and leaves it.
#[test]
fn with_sidecar_a_fresh_rebuild_aborts_on_a_non_frame_file_and_a_healthy_reindex_skips_it() {
    let dir = tempfile::tempdir().unwrap();
    sidecar(dir.path());
    let frames = vec![frame(40, 10)];
    { let mut v = Vault::open(dir.path()).unwrap(); commit_frames(&mut v, "n.md", &frames, 5); }
    let stray = dir.path().join("vault").join("stray.md");
    std::fs::write(&stray, b"a plaintext file restored into an encrypted vault").unwrap();
    {
        let mut v = Vault::open(dir.path()).unwrap();
        v.reindex(false).unwrap();
        assert!(!v.is_corrupt(), "healthy reindex: the stray is foreign, skipped");
        assert!(v.file_meta("stray.md").is_none());
        assert!(stray.exists(), "never moved");
    }
    remove_index(dir.path());
    let mut v = Vault::open(dir.path()).unwrap();
    assert!(v.is_corrupt(), "a fresh rebuild with a sidecar aborts on the non-frame file");
    assert!(v.abort_reason().unwrap().contains("stray.md"));
    assert!(!v.aborted_for_no_sidecar(), "the sidecar is present: not the refusal-one class");
    let before = v.store.list_hashes().unwrap().len();
    assert!(v.reindex(true).is_err(), "force does not override");
    assert_eq!(v.store.list_hashes().unwrap().len(), before, "nothing stored before the abort");
    std::fs::remove_file(&stray).unwrap();
    v.reindex(false).unwrap();
    assert!(!v.is_corrupt());
    assert_eq!(v.file_meta("n.md").unwrap().cid.as_deref(), Some(cid(5).as_str()));
}

// (5) An indexed file whose mirror does not parse, with its chunks gone from the store, is LOST: the rebuild
// aborts unless force, and force drops the row.
#[test]
fn encrypted_indexed_file_with_an_unparseable_mirror_is_lost_until_forced() {
    let dir = tempfile::tempdir().unwrap();
    sidecar(dir.path());
    let frames = vec![frame(9, 11)];
    { let mut v = Vault::open(dir.path()).unwrap(); commit_frames(&mut v, "n.md", &frames, 6); }
    std::fs::write(dir.path().join("vault").join("n.md"), b"torn").unwrap();
    let h = sha256_hex(&frames[0]);
    std::fs::remove_file(dir.path().join(".chunks").join(&h[0..2]).join(&h)).unwrap();
    let mut v = Vault::open(dir.path()).unwrap();
    assert!(v.is_corrupt());
    let e = v.reindex(false).unwrap_err();
    assert_eq!(e.kind(), std::io::ErrorKind::NotFound);
    assert!(e.to_string().contains("n.md"));
    v.reindex(true).unwrap();
    assert!(!v.is_corrupt());
    assert!(v.file_meta("n.md").is_none(), "force dropped the lost row");
}

// (4) A warm-handle reindex derives the flag once the sidecar is back on a zero-row index: the operator's
// restore-then-reindex path yields an encrypted handle, never a plaintext handle with frame rows.
#[test]
fn warm_handle_reindex_derives_the_flag_from_a_restored_sidecar() {
    let dir = tempfile::tempdir().unwrap();
    let mut v = Vault::open(dir.path()).unwrap();
    assert!(!v.encrypted());
    sidecar(dir.path());
    let mut f = frame(12, 12); f.extend_from_slice(&trailer_for(&cid(7)).unwrap());
    std::fs::write(dir.path().join("vault").join("n.md"), &f).unwrap();
    v.reindex(false).unwrap();
    assert!(v.encrypted());
    assert_eq!(v.file_meta("n.md").unwrap().cid.as_deref(), Some(cid(7).as_str()));
    assert_eq!(v.file_meta("n.md").unwrap().size, 12);
}

// (4)(5) The warm zero-row reindex with a restored sidecar is a FRESH rebuild: a plaintext stray aborts it with
// its path, exactly as the absent-index case does, and force does not override.
#[test]
fn warm_zero_row_reindex_with_a_sidecar_aborts_on_a_plaintext_stray() {
    let dir = tempfile::tempdir().unwrap();
    let mut v = Vault::open(dir.path()).unwrap();
    sidecar(dir.path());
    std::fs::write(dir.path().join("vault").join("stray.md"), b"plaintext").unwrap();
    let e = v.reindex(false).unwrap_err();
    assert!(e.to_string().contains("stray.md"), "{e}");
    assert!(v.is_corrupt());
    assert!(v.encrypted(), "the flag derived before the abort, so the next rebuild is an encrypted one");
    assert!(v.reindex(true).is_err());
    std::fs::remove_file(dir.path().join("vault").join("stray.md")).unwrap();
    v.reindex(false).unwrap();
    assert!(!v.is_corrupt());
}

// (5) The flag is off, a sidecar sits beside a NON-fresh index, and a frame-stream stray appears on a warm
// handle: the abort names the index as the stale part (a distinct prefix), never a missing sidecar, so GET
// keyring does not answer refusal one for it. Every later failed rebuild reports its own cause.
#[test]
fn unflagged_handle_with_a_sidecar_names_the_old_index_not_a_missing_sidecar() {
    let dir = tempfile::tempdir().unwrap();
    let mut v = Vault::open(dir.path()).unwrap();
    let b = b"plain"; let h = sha256_hex(b);
    v.put_chunk(&h, b).unwrap();
    v.commit(CommitRequest { path: "a.md".into(), hash: h.clone(), size: 5, mtime: 1, chunks: vec![h], expected_version: None, device_id: None, device_name: None, cid: None }, "").unwrap();
    sidecar(dir.path());
    let mut f = frame(10, 14); f.extend_from_slice(&trailer_for(&cid(2)).unwrap());
    std::fs::write(dir.path().join("vault").join("f.md"), &f).unwrap();
    let e = v.reindex(false).unwrap_err();
    assert!(e.to_string().starts_with(ABORT_SIDECAR_OVER_OLD_INDEX_PREFIX), "{e}");
    assert!(!v.aborted_for_no_sidecar());
    assert!(!v.encrypted(), "a non-fresh index never derives the flag");
    // a later rebuild that fails for an unrelated reason reports ITS cause, not the stale one
    std::fs::remove_file(dir.path().join("vault").join("f.md")).unwrap();
    // lose a.md from disk AND the store: a lost-file abort, a different cause
    std::fs::remove_file(dir.path().join("vault").join("a.md")).unwrap();
    let ha = sha256_hex(b"plain");
    std::fs::remove_file(dir.path().join(".chunks").join(&ha[0..2]).join(&ha)).unwrap();
    let e = v.reindex(false).unwrap_err();
    assert_eq!(e.kind(), std::io::ErrorKind::NotFound, "{e}");
    assert!(v.abort_reason().is_none(), "the E2EE reason did not outlive the next rebuild");
}

// (7) A plaintext vault never stores or echoes a client-sent cid.
#[test]
fn plaintext_vault_drops_a_client_sent_cid() {
    let dir = tempfile::tempdir().unwrap();
    let mut v = Vault::open(dir.path()).unwrap();
    let b = b"plain"; let h = sha256_hex(b);
    v.put_chunk(&h, b).unwrap();
    let m = v.commit(CommitRequest { path: "a.md".into(), hash: h.clone(), size: 5, mtime: 1, chunks: vec![h], expected_version: None, device_id: None, device_name: None, cid: Some(cid(1)) }, "").unwrap();
    assert_eq!(m.cid, None);
    assert_eq!(v.file_meta("a.md").unwrap().cid, None);
    assert_eq!(v.changes(0).upserts[0].cid, None);
}

// issue011 (e2eeMirrorScanCap): the refusal-two magic scan walks every mirror file per refused request. This
// records the measured walk time for 2000 small files so the follow-up task has a number to cap against.
#[test]
fn mirror_magic_scan_walk_time_over_2000_files() {
    let dir = tempfile::tempdir().unwrap();
    let vd = dir.path().join("vault");
    for i in 0..2000u32 {
        let p = vd.join(format!("d{}", i % 20)).join(format!("n{i}.md"));
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, if i % 2 == 0 { b"SSE1 frame-shaped".as_slice() } else { b"plain note".as_slice() }).unwrap();
    }
    let t = std::time::Instant::now();
    let r = mirror_magic_scan(&vd);
    let elapsed = t.elapsed();
    match r { MirrorMagic::Mixed { frames, plain, first } => { assert_eq!((frames, plain), (1000, 1000)); assert_eq!(first.len(), 20); }, other => panic!("{other:?}") }
    eprintln!("mirror_magic_scan over 2000 files: {elapsed:?}");
    assert!(elapsed < std::time::Duration::from_secs(10), "the scan must stay far under the client's slow retry");
}

// (4) A QUARANTINED index with a sidecar is flagged before its rebuild, so the rebuild goes through the frame
// splitter and the vault opens encrypted with the committed row intact.
#[test]
fn quarantined_index_with_a_sidecar_is_flagged_before_its_rebuild() {
    let dir = tempfile::tempdir().unwrap();
    sidecar(dir.path());
    let frames = vec![frame(64, 13)];
    let committed = { let mut v = Vault::open(dir.path()).unwrap(); commit_frames(&mut v, "q.md", &frames, 8) };
    remove_index(dir.path());
    std::fs::write(dir.path().join(".sync-index.db"), b"this is not a sqlite database").unwrap();
    let v = Vault::open(dir.path()).unwrap();
    assert!(dir.path().join(".sync-index.db.corrupt").exists(), "quarantined");
    assert!(v.encrypted());
    assert!(!v.is_corrupt());
    let row = v.file_meta("q.md").unwrap();
    assert_eq!((row.hash, row.size, row.cid), (committed.hash, committed.size, committed.cid));
}
