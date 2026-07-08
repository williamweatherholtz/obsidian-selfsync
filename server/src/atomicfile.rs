use std::io::Write;
use std::path::Path;

// Durable atomic replace: write to a temp file, fsync its CONTENTS, rename over the target, then
// fsync the parent DIRECTORY so both the bytes and the directory entry survive power loss. The JSON
// account stores (.users/.shares/.admins/.tokens/.registration.json) are the highest-value data on
// the server, yet their old save() did plain write+rename with NO fsync — on a crash the rename
// could land while the file was still zero-length/truncated, so on reboot the store parses as
// garbage and the server refuses to boot (accounts lost). This matches the chunk store's durability
// (fsync-before-rename) so account data is no less durable than a content chunk. (R12-CC2)
pub fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("json.tmp");
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)?;
    // Best-effort directory fsync so the rename itself is durable. Opening a directory as a File
    // works on Unix; on Windows it fails harmlessly (NTFS rename durability doesn't need it).
    if let Some(dir) = path.parent() {
        if let Ok(d) = std::fs::File::open(dir) { let _ = d.sync_all(); }
    }
    Ok(())
}
