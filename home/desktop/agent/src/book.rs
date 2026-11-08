// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// PROVISIONAL (bento/id option G, 2026-11-08). Under option G an account is a
// passkey roster, and the signed `bind.` binding this file was shaped around is
// retired. What stays permanent here is `consent` (a yes per document, which is
// G-neutral). `own` and `seen` are kept only as the shape the bridge's whoami and
// resolve answers need until the kernel's roster format lands; after it (kernel
// PR 2) they become a CACHE of verified device certificates and roster entries,
// rewritten from those, never a store of record. Nothing here is account-key
// storage (paused under G) and nothing writes `own` or `seen` in a shipped build.
//
// What this device knows about people, and what the person has allowed which
// document. PUBLIC data only: names and addresses other people published, and
// a yes per document. No key material is ever written here (keys live in the
// key store, security §26).
//
// - `own`: the person's own binding on this device. Written by account setup /
//   linking (not built on desktop yet); nothing the page sends can reach it.
// - `seen`: bindings of OTHER people, keyed by the key a room knows them by,
//   first-use pinned (TOFU): `first_seen` never moves, and a different binding
//   for the same key sets `changed` and keeps it set. Written by the directory
//   client after it has VERIFIED a binding, never from a page.
// - `consent`: documents the person allowed to see who they are, keyed by a
//   hash of the docId (so the file does not list document ids).
//
// RESIDUAL (stated, for security): this file is plain JSON under the user's
// data directory, so a same-user process can edit it. It cannot reach a key,
// but it could make a name read wrongly; integrity at rest is the directory
// client's to add when it exists (a stored, signed binding re-verified on read).

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Binding {
    pub name: String,
    pub email: String,
    pub vouched_by: String,
    pub account_pub: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Seen {
    pub binding: Binding,
    pub first_seen: u64,
    pub changed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BookError {
    /// The file exists and is not a book we can read. Fail closed: calls answer
    /// `unavailable`, and nothing is written over it.
    Corrupt,
    Io(String),
}

#[derive(Debug, Clone, Default)]
pub struct Book {
    pub own: Option<Binding>,
    pub seen: Vec<(String, Seen)>,
    consent: Vec<String>,
}

fn consent_key(doc_id: &str) -> String {
    let mut h = Sha256::new();
    h.update(b"bento-consent-v1\0");
    h.update(doc_id.as_bytes());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

fn binding_json(b: &Binding) -> Value {
    json!({ "name": b.name, "email": b.email, "vouchedBy": b.vouched_by, "accountPub": b.account_pub })
}
fn binding_from(v: &Value) -> Option<Binding> {
    let s = |k: &str| v.get(k).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
    Some(Binding { name: s("name")?, email: s("email")?, vouched_by: s("vouchedBy")?, account_pub: s("accountPub")? })
}

impl Book {
    /// A missing file is an empty book; an unreadable or malformed one is `Corrupt`.
    pub fn load(path: &Path) -> Result<Book, BookError> {
        let text = match std::fs::read_to_string(path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Book::default()),
            Err(e) => return Err(BookError::Io(e.to_string())),
        };
        let v: Value = serde_json::from_str(&text).map_err(|_| BookError::Corrupt)?;
        if v.get("v").and_then(Value::as_u64) != Some(1) {
            return Err(BookError::Corrupt);
        }
        let own = match v.get("own") {
            None | Some(Value::Null) => None,
            Some(o) => Some(binding_from(o).ok_or(BookError::Corrupt)?),
        };
        let mut seen = vec![];
        if let Some(m) = v.get("seen").and_then(Value::as_object) {
            for (k, e) in m {
                let binding = binding_from(e).ok_or(BookError::Corrupt)?;
                let first_seen = e.get("firstSeen").and_then(Value::as_u64).ok_or(BookError::Corrupt)?;
                let changed = e.get("changed").and_then(Value::as_bool).ok_or(BookError::Corrupt)?;
                seen.push((k.clone(), Seen { binding, first_seen, changed }));
            }
        }
        let consent = v
            .get("consent")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        Ok(Book { own, seen, consent })
    }

    /// Write beside, then rename over; 0600 where the platform has modes.
    pub fn save(&self, path: &Path) -> Result<(), BookError> {
        let mut seen = Map::new();
        for (k, s) in &self.seen {
            let mut e = binding_json(&s.binding);
            e["firstSeen"] = json!(s.first_seen);
            e["changed"] = json!(s.changed);
            seen.insert(k.clone(), e);
        }
        let v = json!({ "v": 1, "own": self.own.as_ref().map(binding_json), "seen": seen, "consent": self.consent });
        let io = |e: std::io::Error| BookError::Io(e.to_string());
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(io)?;
        }
        let tmp: PathBuf = path.with_extension("tmp");
        std::fs::write(&tmp, serde_json::to_vec(&v).unwrap()).map_err(io)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600)).map_err(io)?;
        }
        std::fs::rename(&tmp, path).map_err(io)
    }

    pub fn consented(&self, doc_id: &str) -> bool {
        self.consent.contains(&consent_key(doc_id))
    }
    pub fn allow(&mut self, doc_id: &str) {
        let k = consent_key(doc_id);
        if !self.consent.contains(&k) {
            self.consent.push(k);
        }
    }

    /// A binding of another person, learned from a VERIFIED source. First use
    /// pins it; a different binding for the same key marks it changed.
    pub fn observe(&mut self, pub_key: &str, binding: Binding, now: u64) {
        match self.seen.iter_mut().find(|(k, _)| k == pub_key) {
            Some((_, s)) => {
                if s.binding != binding {
                    s.changed = true;
                }
            }
            None => self.seen.push((pub_key.to_string(), Seen { binding, first_seen: now, changed: false })),
        }
    }
    pub fn seen(&self, pub_key: &str) -> Option<&Seen> {
        self.seen.iter().find(|(k, _)| k == pub_key).map(|(_, s)| s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b(n: &str) -> Binding {
        Binding { name: n.into(), email: format!("{n}@example.org"), vouched_by: "id.bento.page".into(), account_pub: "ACC".into() }
    }
    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("bento-book-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d.join("identity.json")
    }

    #[test]
    fn round_trips_and_pins_on_first_use() {
        let p = tmp("rt");
        let mut k = Book::default();
        k.own = Some(b("ann"));
        k.observe("K1", b("bob"), 100);
        k.observe("K1", b("bob"), 900);
        k.allow("doc-1");
        k.save(&p).unwrap();
        let k = Book::load(&p).unwrap();
        assert_eq!(k.own, Some(b("ann")));
        let s = k.seen("K1").unwrap();
        assert_eq!((s.first_seen, s.changed), (100, false), "first use pins; a repeat moves nothing");
        assert!(k.consented("doc-1") && !k.consented("doc-2"));
    }

    #[test]
    fn a_different_binding_marks_changed_and_stays_marked() {
        let mut k = Book::default();
        k.observe("K1", b("bob"), 100);
        k.observe("K1", Binding { email: "evil@example.org".into(), ..b("bob") }, 200);
        let s = k.seen("K1").unwrap();
        assert!(s.changed);
        assert_eq!(s.binding, b("bob"), "the pinned binding is not replaced");
        assert_eq!(s.first_seen, 100);
        k.observe("K1", b("bob"), 300);
        assert!(k.seen("K1").unwrap().changed, "sticky until someone accepts it");
    }

    #[test]
    fn the_file_does_not_list_document_ids() {
        let p = tmp("hash");
        let mut k = Book::default();
        k.allow("doc-lq3k9z-8f2h1x");
        k.save(&p).unwrap();
        assert!(!std::fs::read_to_string(&p).unwrap().contains("lq3k9z"));
    }

    #[test]
    fn corrupt_fails_closed_and_is_not_overwritten_by_load() {
        let p = tmp("bad");
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, "{not json").unwrap();
        assert_eq!(Book::load(&p).unwrap_err(), BookError::Corrupt);
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "{not json");
        std::fs::write(&p, r#"{"v":2}"#).unwrap();
        assert_eq!(Book::load(&p).unwrap_err(), BookError::Corrupt, "unknown version");
        assert!(Book::load(&p.with_file_name("none.json")).unwrap().own.is_none(), "missing = empty");
    }
}
