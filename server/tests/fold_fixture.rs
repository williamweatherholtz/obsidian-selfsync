// E2EE clause (7) of e2eeCryptoCore (D0101, spec section 4.3): the server folds paths with Rust
// `str::to_lowercase`, and only clients compute `cid` over the folded path. So every JS engine a vault's
// devices run must fold exactly as Rust does. This test emits the fixture the client asserts against:
// every code point whose lowercase is not identity, with its mapping, plus string cases that a per-code-
// point map cannot express (final sigma) or that changed across Unicode versions (U+0130, Georgian
// Mtavruli). Run with FOLD_FIXTURE_WRITE=1 to rewrite client/test/e2ee/fold-fixture.json. Without the
// variable it compares the committed file to a fresh generation and fails on drift, so a toolchain
// bump that changes Rust's Unicode tables cannot silently diverge from the fixture the clients pin.
use std::collections::BTreeMap;
use std::path::PathBuf;

const STRINGS: &[&str] = &[
    "ΟΔΥΣΣΕΥΣ",         // final sigma: the last Σ folds to ς, the inner one to σ
    "ΟΔΥΣΣΕΥΣ.md",      // no final sigma: "." is case-ignorable and "m" is cased, so the last Σ folds to σ
    "Notes/ΣΑΣ ΣΑΣ.md", // final sigma before a space and at the end
    "İstanbul.md",      // U+0130 folds to i plus U+0307 in both engines
    "Ა/ᲐᲑ.md",           // Georgian Mtavruli U+1C90, U+1C91 fold to Mkhedruli (Unicode 11)
    "ǅemal.md",         // titlecase digraph U+01C5
    "STRASSE ẞ.md",     // capital sharp s U+1E9E
    "Ⅻ ⒈ Ⓐ.md",         // Roman numeral, circled letter: folded, circled digit: not
    "ﬀ ﬁ.md",            // ligatures have no lowercase mapping
];

fn generate() -> String {
    let mut map: BTreeMap<String, String> = BTreeMap::new();
    for cp in 0u32..0x110000 {
        let Some(c) = char::from_u32(cp) else { continue };
        let lower: String = c.to_lowercase().collect();
        if lower != c.to_string() {
            map.insert(format!("{cp:x}"), lower);
        }
    }
    let strings: Vec<[String; 2]> = STRINGS.iter().map(|s| [s.to_string(), s.to_lowercase()]).collect();
    let v = char::UNICODE_VERSION;
    let doc = serde_json::json!({
        "generator": "server/tests/fold_fixture.rs",
        "rust_unicode": format!("{}.{}.{}", v.0, v.1, v.2),
        "map": map,
        "strings": strings,
    });
    let mut text = serde_json::to_string_pretty(&doc).unwrap();
    text.push('\n');
    text
}

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../client/test/e2ee/fold-fixture.json")
}

#[test]
fn fold_fixture_matches_rust_to_lowercase() {
    let text = generate();
    let path = fixture_path();
    if std::env::var_os("FOLD_FIXTURE_WRITE").is_some() {
        std::fs::write(&path, &text).unwrap();
        return;
    }
    // A Windows clone with core.autocrlf=true checks the fixture out as CRLF. Compare line content.
    let committed = std::fs::read_to_string(&path).unwrap_or_default().replace("\r\n", "\n");
    assert!(
        committed == text,
        "fold-fixture.json differs from Rust to_lowercase on this toolchain. \
         Regenerate with FOLD_FIXTURE_WRITE=1 cargo test --test fold_fixture, then rerun the client fold test."
    );
}

#[test]
fn fold_fixture_has_the_string_cases() {
    let text = generate();
    let doc: serde_json::Value = serde_json::from_str(&text).unwrap();
    let map = doc["map"].as_object().unwrap();
    assert!(map.len() > 1000, "expected over 1000 lowercase mappings, got {}", map.len());
    assert_eq!(map["41"], "a");
    assert_eq!(map["130"], "i\u{307}");
    assert_eq!(map["1c90"], "\u{10d0}");
    assert_eq!(map["3a3"], "\u{3c3}");
    let strings = doc["strings"].as_array().unwrap();
    assert_eq!(strings[0][1], "οδυσσευς");
    assert_eq!(strings[1][1], "οδυσσευσ.md");
}
