// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// One origin per document (security §19g, §19i, §19f).
//
// origin = H(install salt, canonical path, docId), 96 bits, under .localhost:
// - derived HOST-SIDE, stable across launches (recovery, versions and member
//   keys are keyed by origin) and across safe saves (no inode: a temp file
//   plus rename changes it on every save);
// - the docId is read from the plaintext #bento-doc block only: the block's own
//   `<script … id="bento-doc">` tag, exactly one, the TOP-LEVEL docId, accepted
//   iff it matches ^[A-Za-z0-9_-]{1,128}$ and used exactly as stored. It only
//   NARROWS the derivation: a file carrying B's docId at another path never
//   gets B's origin;
// - an ENVELOPE document (password or identity-sealed: format "bento/enc") has
//   no host-readable docId, so it is path-only, plus an EPOCH that the change
//   detector bumps when the file at that path is replaced by something the host
//   did not write: a fresh origin, never a wipe and never a prompt.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::Path;

/// The plaintext #bento-doc block's JSON, if the file has exactly one such
/// script block.
fn doc_block(doc: &[u8]) -> Option<Value> {
    let html = std::str::from_utf8(doc).ok()?;
    let blocks = bento_gate1::scan_blocks(html);
    let mut it = blocks.iter().filter(|b| b.tag == "script" && b.id.as_deref() == Some("bento-doc"));
    let b = it.next()?;
    if it.next().is_some() { return None }
    serde_json::from_str(b.text.trim()).ok()
}

/// §19i: the top-level docId, exactly as stored, or None.
pub fn doc_id(doc: &[u8]) -> Option<String> {
    let v = doc_block(doc)?;
    let id = v.as_object()?.get("docId")?.as_str()?;
    let ok = (1..=128).contains(&id.len()) && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-');
    ok.then(|| id.to_string())
}

/// A password or identity-sealed document: the #bento-doc block is a
/// `bento/enc` envelope. §30: every title sink shows the neutral app name.
pub fn is_envelope(doc: &[u8]) -> bool {
    doc_block(doc).is_some_and(|v| v.get("format").and_then(Value::as_str) == Some("bento/enc"))
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// The origin host, `<24 hex>.localhost` (96 bits, §19f).
pub fn origin_host(salt: &[u8], canonical: &Path, doc_id: Option<&str>, epoch: u64) -> String {
    let mut h = Sha256::new();
    h.update(b"bento-home-origin-v1\0");
    h.update(salt);
    h.update(b"\0");
    h.update(canonical.to_string_lossy().as_bytes());
    h.update(b"\0");
    h.update(doc_id.unwrap_or("").as_bytes());
    if epoch > 0 {
        h.update(b"\0");
        h.update(epoch.to_string().as_bytes());
    }
    format!("{}.localhost", hex(&h.finalize()[..12]))
}

/// The file's instance identity: what changes when the file is REPLACED.
/// Unix: device and inode. Elsewhere: unmeasured, so never changes (the
/// Windows file ID is owed with the Windows host).
pub fn file_id(p: &Path) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if let Ok(m) = std::fs::metadata(p) { return format!("{}:{}", m.dev(), m.ino()) }
    }
    let _ = p;
    String::new()
}

/// The change detector's memory, kept in the data directory: per path (salted
/// hash, never the path itself) the instance the host last saw or wrote, and
/// the epoch.
pub struct Index {
    v: Value,
    path: Option<std::path::PathBuf>,
}

impl Index {
    pub fn open(path: Option<&Path>) -> Index {
        let v = path.and_then(|p| std::fs::read(p).ok()).and_then(|b| serde_json::from_slice(&b).ok()).filter(Value::is_object).unwrap_or_else(|| json!({}));
        Index { v, path: path.map(Path::to_path_buf) }
    }
    fn key(salt: &[u8], canonical: &Path) -> String {
        let mut h = Sha256::new();
        h.update(b"bento-home-index-v1\0");
        h.update(salt);
        h.update(b"\0");
        h.update(canonical.to_string_lossy().as_bytes());
        hex(&h.finalize()[..16])
    }
    fn save(&self) {
        if let Some(p) = &self.path {
            if let Some(d) = p.parent() { let _ = std::fs::create_dir_all(d); }
            let _ = std::fs::write(p, self.v.to_string());
        }
    }
    /// At open: the epoch for an envelope document at this path, bumped if the
    /// file is not the instance the host last saw or wrote.
    pub fn epoch_at_open(&mut self, salt: &[u8], canonical: &Path, fid: &str) -> u64 {
        let k = Self::key(salt, canonical);
        let rec = self.v.get(&k).cloned();
        let epoch = match rec {
            None => 0,
            Some(r) => {
                let e = r["epoch"].as_u64().unwrap_or(0);
                if !fid.is_empty() && r["fid"].as_str() != Some(fid) { e + 1 } else { e }
            }
        };
        self.v[&k] = json!({ "fid": fid, "epoch": epoch });
        self.save();
        epoch
    }
    /// After the host's own write: the new instance is OURS, so no rotation.
    pub fn host_wrote(&mut self, salt: &[u8], canonical: &Path, fid: &str) {
        let k = Self::key(salt, canonical);
        let epoch = self.v.get(&k).and_then(|r| r["epoch"].as_u64()).unwrap_or(0);
        self.v[&k] = json!({ "fid": fid, "epoch": epoch });
        self.save();
    }
}

/// The origin for a document at open.
pub fn origin_at_open(salt: &[u8], canonical: &Path, doc: &[u8], index: &mut Index) -> String {
    if is_envelope(doc) {
        let epoch = index.epoch_at_open(salt, canonical, &file_id(canonical));
        origin_host(salt, canonical, None, epoch)
    } else {
        origin_host(salt, canonical, doc_id(doc).as_deref(), 0)
    }
}

/// The per-install salt, 32 random bytes in the data directory. Not secret:
/// it keeps origins unlinkable across installs (§19f).
pub fn install_salt(data_dir: &Path) -> Vec<u8> {
    let p = data_dir.join("origin-salt");
    if let Ok(b) = std::fs::read(&p) {
        if b.len() == 32 { return b }
    }
    let mut b = vec![0u8; 32];
    getrandom::fill(&mut b).expect("getrandom");
    let _ = std::fs::create_dir_all(data_dir);
    let _ = std::fs::write(&p, &b);
    b
}

#[cfg(test)]
mod tests {
    use super::*;

    fn deck(json: &str) -> Vec<u8> {
        format!("<!doctype html><title>t</title><script type=\"application/bento+json\" id=\"bento-doc\">{json}</script>").into_bytes()
    }
    fn tmp(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("bento-origin-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn doc_id_accepts_every_shape_the_apps_mint_and_keeps_it_exact() {
        assert_eq!(doc_id(&deck(r#"{"docId":"aaf8d0e2-388a-4c3c-a170-fa14d26b0662"}"#)).as_deref(), Some("aaf8d0e2-388a-4c3c-a170-fa14d26b0662"));
        assert_eq!(doc_id(&deck(r#"{"docId":"doc-lq3k9z-8f2h1x"}"#)).as_deref(), Some("doc-lq3k9z-8f2h1x"));
        assert_eq!(doc_id(&deck(r#"{"docId":"Doc_ABC-1"}"#)).as_deref(), Some("Doc_ABC-1"));
    }

    #[test]
    fn doc_id_refuses_what_it_must() {
        for bad in [r#"{"docId":"a/b"}"#, r#"{"docId":""}"#, r#"{"docId":42}"#, r#"{"meta":{"docId":"nested"}}"#, r#"{"format":"bento/enc","ct":"x"}"#] {
            assert_eq!(doc_id(&deck(bad)), None, "{bad}");
        }
        assert_eq!(doc_id(&deck(&format!(r#"{{"docId":"{}"}}"#, "a".repeat(129)))), None);
        let mut two = deck(r#"{"docId":"x"}"#);
        two.extend_from_slice(br#"<script type="application/bento+json" id="bento-doc">{"docId":"y"}</script>"#);
        assert_eq!(doc_id(&two), None, "two anchors");
        // the id on a non-script element is not the anchor
        assert_eq!(doc_id(br#"<div id="bento-doc">{"docId":"x"}</div>"#), None);
    }

    #[test]
    fn envelopes_are_recognised_by_format_only() {
        assert!(is_envelope(&deck(r#"{"format":"bento/enc","v":1,"it":300000}"#)));
        assert!(is_envelope(&deck(r#"{"format":"bento/enc","v":1,"kdf":"hkdf-kdoc"}"#)));
        assert!(!is_envelope(&deck(r#"{"format":"bento/slides","docId":"x"}"#)));
        assert!(!is_envelope(b"<html>no block</html>"));
    }

    #[test]
    fn origins_separate_paths_docids_salts_and_epochs_and_are_96_bits() {
        let p = Path::new("/home/u/a.bento.html");
        let o = origin_host(b"s", p, Some("x"), 0);
        assert_eq!(o.len(), 24 + ".localhost".len());
        assert!(o.ends_with(".localhost") && o[..24].bytes().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(o, origin_host(b"s", p, Some("x"), 0), "stable");
        for other in [origin_host(b"s", Path::new("/home/u/b.bento.html"), Some("x"), 0), origin_host(b"s", p, Some("y"), 0), origin_host(b"t", p, Some("x"), 0), origin_host(b"s", p, None, 0), origin_host(b"s", p, None, 1)] {
            assert_ne!(o, other);
        }
        // a crafted file carrying B's docId at A's path gets A's path in the hash, not B's origin
        assert_ne!(origin_host(b"s", Path::new("/a"), Some("B"), 0), origin_host(b"s", Path::new("/b"), Some("B"), 0));
    }

    #[cfg(unix)]
    #[test]
    fn an_envelope_replaced_behind_the_hosts_back_gets_a_fresh_origin_and_the_hosts_own_save_does_not() {
        let d = tmp("envelope");
        let f = d.join("sealed.bento.html");
        let env = deck(r#"{"format":"bento/enc","v":1,"it":300000,"ct":"x"}"#);
        std::fs::write(&f, &env).unwrap();
        let f = std::fs::canonicalize(&f).unwrap();
        let mut ix = Index::open(Some(&d.join("index.json")));
        let o1 = origin_at_open(b"s", &f, &env, &mut ix);
        assert_eq!(o1, origin_at_open(b"s", &f, &env, &mut Index::open(Some(&d.join("index.json")))), "a relaunch keeps it");
        // the host's own safe save: temp + rename gives a NEW inode, recorded as ours
        let tmpf = d.join("sealed.tmp");
        std::fs::write(&tmpf, &env).unwrap();
        std::fs::rename(&tmpf, &f).unwrap();
        let mut ix = Index::open(Some(&d.join("index.json")));
        ix.host_wrote(b"s", &f, &file_id(&f));
        assert_eq!(o1, origin_at_open(b"s", &f, &env, &mut ix), "the host's own write keeps the origin");
        // someone else replaces the file
        let other = d.join("other.tmp");
        std::fs::write(&other, &env).unwrap();
        std::fs::rename(&other, &f).unwrap();
        let mut ix = Index::open(Some(&d.join("index.json")));
        let o2 = origin_at_open(b"s", &f, &env, &mut ix);
        assert_ne!(o1, o2, "an instance change the host did not cause: a fresh origin");
        // and it stays fresh-but-stable after that
        assert_eq!(o2, origin_at_open(b"s", &f, &env, &mut Index::open(Some(&d.join("index.json")))));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn plaintext_documents_ignore_the_change_detector() {
        let d = tmp("plain");
        let doc = deck(r#"{"docId":"abc"}"#);
        let mut ix = Index::open(None);
        let o = origin_at_open(b"s", &d.join("x.html"), &doc, &mut ix);
        assert_eq!(o, origin_host(b"s", &d.join("x.html"), Some("abc"), 0));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn the_install_salt_is_32_bytes_and_stable() {
        let d = tmp("salt");
        let a = install_salt(&d);
        assert_eq!(a.len(), 32);
        assert_eq!(a, install_salt(&d));
        let _ = std::fs::remove_dir_all(&d);
    }
}
