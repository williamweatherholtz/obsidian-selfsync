// SSE1 frames on the server (D0100, spec sections 4.2, 4.5, 4.6). The server never holds a key. It
// parses the self-delimiting header: magic "SSE1", a 12-byte IV, a u32le ct_len, then ct with its tag.
// The plaintext length is ct_len minus the 32-byte commitment pad and the 16-byte tag. A mirror file
// of an encrypted vault is the frame stream followed by the trailer "SSEM" and the raw 32-byte cid.
use std::ops::Range;

pub const MAGIC: &[u8; 4] = b"SSE1";
pub const TRAILER_MAGIC: &[u8; 4] = b"SSEM";
pub const HEADER_LEN: usize = 4 + 12 + 4;
pub const PAD_LEN: usize = 32;
pub const TAG_LEN: usize = 16;
pub const MIN_CT_LEN: usize = PAD_LEN + TAG_LEN; // 48
/// A CDC chunk is at most 64 KiB of plaintext, so ct_len is at most 65536 + 48.
pub const MAX_CT_LEN: usize = 65536 + MIN_CT_LEN; // 65584
pub const FRAME_OVERHEAD: usize = HEADER_LEN + PAD_LEN + TAG_LEN; // 68
pub const CID_LEN: usize = 32;
pub const TRAILER_LEN: usize = 4 + CID_LEN; // 36

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrameHeader {
    pub ct_len: usize,
    pub pt_len: usize,
}

/// True when the first four bytes are the frame magic. Used by the refusal-two scan.
pub fn has_frame_magic(bytes: &[u8]) -> bool {
    bytes.len() >= 4 && &bytes[..4] == MAGIC
}

/// Header of ONE complete frame: `bytes` must be exactly one frame. No key is needed.
pub fn parse_frame_header(bytes: &[u8]) -> Option<FrameHeader> {
    let (h, consumed) = header_at(bytes, 0)?;
    if consumed != bytes.len() { return None; }
    Some(h)
}

// The header at `off`, and the offset just past that frame. None when the bytes there are not a
// well-formed frame start, or the frame would run past the end.
fn header_at(bytes: &[u8], off: usize) -> Option<(FrameHeader, usize)> {
    let rest = bytes.get(off..)?;
    if rest.len() < HEADER_LEN || &rest[..4] != MAGIC { return None; }
    let ct_len = u32::from_le_bytes([rest[16], rest[17], rest[18], rest[19]]) as usize;
    if !(MIN_CT_LEN..=MAX_CT_LEN).contains(&ct_len) { return None; }
    let end = off.checked_add(HEADER_LEN)?.checked_add(ct_len)?;
    if end > bytes.len() { return None; }
    Some((FrameHeader { ct_len, pt_len: ct_len - MIN_CT_LEN }, end))
}

#[derive(Debug)]
pub struct FrameStreamError {
    pub offset: usize,
    pub detail: &'static str,
}

impl std::fmt::Display for FrameStreamError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} at byte {}", self.detail, self.offset)
    }
}

/// Split a complete frame stream into frame ranges: at least one frame, every ct_len in range, and
/// the last frame ends exactly at the end. Length-prefixed, so no scanning.
pub fn split_frames(bytes: &[u8]) -> Result<Vec<Range<usize>>, FrameStreamError> {
    let mut out = Vec::new();
    let mut off = 0usize;
    while off < bytes.len() {
        let (_, end) = header_at(bytes, off).ok_or(FrameStreamError { offset: off, detail: "not an SSE1 frame" })?;
        out.push(off..end);
        off = end;
    }
    if out.is_empty() { return Err(FrameStreamError { offset: 0, detail: "no frame" }); }
    Ok(out)
}

#[derive(Debug)]
pub struct MirrorParse {
    pub frames: Vec<Range<usize>>,
    /// Hex of the 32-byte cid from the trailer.
    pub cid: String,
    /// Sum of the plaintext lengths of the frames.
    pub pt_len: u64,
}

/// A mirror file of an encrypted vault: a frame stream followed by exactly one trailer at the end.
pub fn parse_mirror(bytes: &[u8]) -> Option<MirrorParse> {
    if bytes.len() < FRAME_OVERHEAD + TRAILER_LEN { return None; }
    let (stream, trailer) = bytes.split_at(bytes.len() - TRAILER_LEN);
    if &trailer[..4] != TRAILER_MAGIC { return None; }
    let frames = split_frames(stream).ok()?;
    let pt_len = frames.iter().map(|r| header_at(bytes, r.start).map(|(h, _)| h.pt_len as u64).unwrap_or(0)).sum();
    Some(MirrorParse { frames, cid: crate::hash::hex(&trailer[4..]), pt_len })
}

/// The 36-byte trailer for `cid` (hex of 32 bytes). None when cid is not 64 lowercase hex chars.
pub fn trailer_for(cid: &str) -> Option<Vec<u8>> {
    if cid.len() != 2 * CID_LEN || !cid.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) { return None; }
    let mut out = Vec::with_capacity(TRAILER_LEN);
    out.extend_from_slice(TRAILER_MAGIC);
    for i in 0..CID_LEN {
        out.push(u8::from_str_radix(&cid[2 * i..2 * i + 2], 16).ok()?);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(pt_len: usize) -> Vec<u8> {
        let mut f = vec![0u8; HEADER_LEN + MIN_CT_LEN + pt_len];
        f[..4].copy_from_slice(MAGIC);
        f[16..20].copy_from_slice(&((MIN_CT_LEN + pt_len) as u32).to_le_bytes());
        f
    }

    #[test]
    fn a_zero_byte_file_is_one_68_byte_frame() {
        let f = frame(0);
        assert_eq!(f.len(), 68);
        assert_eq!(parse_frame_header(&f), Some(FrameHeader { ct_len: 48, pt_len: 0 }));
    }

    #[test]
    fn the_ceiling_frame_parses_and_one_more_does_not() {
        assert!(parse_frame_header(&frame(65536)).is_some());
        assert!(parse_frame_header(&frame(65537)).is_none());
    }

    #[test]
    fn trailer_round_trip() {
        let cid = "ab".repeat(32);
        let t = trailer_for(&cid).unwrap();
        assert_eq!(t.len(), TRAILER_LEN);
        let mut m = frame(3); m.extend_from_slice(&t);
        let p = parse_mirror(&m).unwrap();
        assert_eq!(p.cid, cid);
        assert_eq!(p.pt_len, 3);
        assert!(trailer_for(&"AB".repeat(32)).is_none(), "uppercase hex is refused");
        assert!(trailer_for("ab").is_none(), "wrong length is refused");
        assert!(trailer_for(&"zz".repeat(32)).is_none());
        // a trailer alone, or a trailer after garbage, is not a mirror
        assert!(parse_mirror(&t).is_none());
        let mut g = vec![1u8; 70]; g.extend_from_slice(&t);
        assert!(parse_mirror(&g).is_none());
    }
}
