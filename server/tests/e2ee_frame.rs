// E2 clause (2): frame.rs parses an SSE1 frame header and computes its plaintext length without the key.
// This test reads the E1 test vector (client/test/e2ee/vector.json, the committed cross-language fixture)
// and agrees with the client on the frame hash, the plaintext length and the cid parsed from a mirror
// trailer built from the same vector. One vector, two languages, so a drift in either breaks here.
use selfsync_server::frame::{parse_frame_header, parse_mirror, split_frames, FRAME_OVERHEAD, HEADER_LEN, TRAILER_LEN};
use selfsync_server::hash::sha256_hex;

fn vector() -> serde_json::Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../client/test/e2ee/vector.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("E1 vector present")).unwrap()
}

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

#[test]
fn frame_header_agrees_with_the_e1_vector() {
    let v = vector();
    let frame = unhex(v["frame_hex"].as_str().unwrap());
    let pt = unhex(v["pt_hex"].as_str().unwrap());
    let h = parse_frame_header(&frame).expect("the vector frame parses");
    assert_eq!(h.pt_len, pt.len(), "plaintext length from the header alone");
    assert_eq!(h.ct_len, pt.len() + 48);
    assert_eq!(frame.len(), pt.len() + FRAME_OVERHEAD);
    assert_eq!(FRAME_OVERHEAD, 68);
    assert_eq!(HEADER_LEN, 20);
    assert_eq!(sha256_hex(&frame), v["frame_sha256"].as_str().unwrap(), "the chunk address is the frame hash");
}

#[test]
fn mirror_trailer_round_trips_the_cid() {
    let v = vector();
    let frame = unhex(v["frame_hex"].as_str().unwrap());
    let cid = v["cid"].as_str().unwrap();
    let mut mirror = frame.clone();
    mirror.extend_from_slice(b"SSEM");
    mirror.extend_from_slice(&unhex(cid));
    assert_eq!(TRAILER_LEN, 36);
    let m = parse_mirror(&mirror).expect("frame stream plus trailer parses");
    assert_eq!(m.cid, cid);
    assert_eq!(m.frames.len(), 1);
    assert_eq!(&mirror[m.frames[0].clone()], &frame[..]);
    assert_eq!(m.pt_len, unhex(v["pt_hex"].as_str().unwrap()).len() as u64);
    // the same bytes without the trailer are a frame stream, not a mirror
    assert!(parse_mirror(&frame).is_none());
    assert_eq!(split_frames(&frame).unwrap().len(), 1);
}

#[test]
fn malformed_frames_are_refused() {
    let v = vector();
    let frame = unhex(v["frame_hex"].as_str().unwrap());
    assert!(parse_frame_header(&frame[..frame.len() - 1]).is_none(), "truncated");
    let mut magic = frame.clone(); magic[0] = b'X';
    assert!(parse_frame_header(&magic).is_none(), "wrong magic");
    let mut short = frame.clone(); short[16..20].copy_from_slice(&47u32.to_le_bytes());
    assert!(parse_frame_header(&short).is_none(), "ct_len under 48");
    assert!(parse_frame_header(&frame[..19]).is_none(), "shorter than a header");
    // a stream with trailing garbage is not a complete frame stream
    let mut two = frame.clone(); two.extend_from_slice(&frame); two.push(0);
    assert!(split_frames(&two).is_err());
    two.pop();
    assert_eq!(split_frames(&two).unwrap().len(), 2);
    // an over-long ct_len is refused by the splitter (65584 is the ceiling: a 64 KiB chunk plus 48)
    let mut big = vec![0u8; HEADER_LEN + 65585];
    big[..4].copy_from_slice(b"SSE1");
    big[16..20].copy_from_slice(&65585u32.to_le_bytes());
    assert!(split_frames(&big).is_err());
    assert!(split_frames(&[]).is_err(), "at least one frame");
}
