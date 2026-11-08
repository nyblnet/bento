// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The trust store: which releases are genuine, and the CSP each one is served
// under.
//
// - The signed release histories (releases/<app>/history.json) are BUNDLED with
//   the app at build time. Each is verified against the pinned release key on
//   first read, like a fetched copy.
// - The newest verified history per app is kept in the app's data directory
//   and is the ANTI-ROLLBACK FLOOR: a bundled or offered history is adopted
//   only if gate1's accept_history() says so against what is held.
// - Histories are refreshed only by a user action (New document, Check for
//   updates). Never per open or per launch: `offer()` is the one entry point.
// - A document is genuine only if exactly ONE release, across every app's
//   history, matches every block.

use bento_gate1::{accept_history, verify_served_held, History, ServedVerdict};
use serde_json::Value;
use std::path::{Path, PathBuf};

/// The release signing public key, as JWK coordinates (base64url). THE one
/// place the desktop host pins it (kernel/src/update.ts carries the same key
/// for the web). A key rotation ships as an app update that pins only the new
/// key: change it here and nowhere else.
pub const RELEASE_KEY: (&str, &str) = ("GMHSKwWcAoJVq-Dz1ZxWZM6TXATWIKbaQBpjoTystH8", "flFNzbdXCmJN8RQYCeG71rBZnnbN-MCEnp1EbCLFrj0");

/// The conformance corpus's throwaway key, read from
/// home/fixtures/gate1/test-public-key.json at build time (regenerating the
/// corpus can change it). Trusted ONLY in builds with the rig-test-key feature.
#[cfg(any(test, feature = "rig-test-key"))]
pub fn test_key() -> (&'static str, &'static str) {
    static K: std::sync::OnceLock<(String, String)> = std::sync::OnceLock::new();
    let k = K.get_or_init(|| {
        let j: Value = serde_json::from_str(include_str!("../../../fixtures/gate1/test-public-key.json")).expect("corpus test key");
        (j["x"].as_str().unwrap().to_string(), j["y"].as_str().unwrap().to_string())
    });
    (k.0.as_str(), k.1.as_str())
}

/// Every key this build trusts.
pub fn pinned_keys() -> Vec<(&'static str, &'static str)> {
    #[allow(unused_mut)]
    let mut k = vec![RELEASE_KEY];
    #[cfg(feature = "rig-test-key")]
    k.push(test_key());
    k
}

/// A verified envelope's payload, or why not.
pub fn verify_envelope(envelope: &str, keys: &[(&str, &str)]) -> Result<History, String> {
    let mut last = String::from("no key is pinned");
    for (x, y) in keys {
        match History::from_signed(envelope, x, y) {
            Ok(h) => return Ok(h),
            Err(e) => last = e,
        }
    }
    Err(last)
}

#[derive(Debug, Clone, PartialEq)]
pub enum Verdict {
    Genuine { app: String, version: String, csp: String },
    Unknown { reason: String },
}

pub struct Trust {
    keys: Vec<(&'static str, &'static str)>,
    /// The floor: one verified history per app, with its signed envelope.
    held: Vec<(History, String)>,
    floor_dir: Option<PathBuf>,
}

impl Trust {
    /// The shipped constructor: the pinned keys, the bundled envelopes, and the
    /// floor kept in `floor_dir`. Returns what it refused, for the log.
    pub fn load<S: AsRef<str>>(bundled: &[S], floor_dir: &Path) -> (Trust, Vec<String>) {
        Self::load_with_keys(pinned_keys(), bundled, Some(floor_dir))
    }

    pub fn load_with_keys<S: AsRef<str>>(keys: Vec<(&'static str, &'static str)>, bundled: &[S], floor_dir: Option<&Path>) -> (Trust, Vec<String>) {
        let mut t = Trust { keys, held: vec![], floor_dir: floor_dir.map(Path::to_path_buf) };
        let mut notes = vec![];
        // the floor first: what this install has already verified
        if let Some(dir) = floor_dir {
            for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
                if e.path().extension().and_then(|x| x.to_str()) != Some("json") { continue }
                let Ok(env) = std::fs::read_to_string(e.path()) else { continue };
                match verify_envelope(&env, &t.keys) {
                    Ok(h) if accept_history(None, &h.raw, h.app().unwrap_or("")).is_ok() => t.held.push((h, env)),
                    Ok(_) => notes.push(format!("floor {}: malformed, ignored", e.path().display())),
                    Err(err) => notes.push(format!("floor {}: {err}, ignored", e.path().display())),
                }
            }
        }
        for env in bundled {
            if let Err(e) = t.offer_inner(env.as_ref(), false) { notes.push(format!("bundled history: {e}")) }
        }
        (t, notes)
    }

    /// A history from a user action (Check for updates, New document). Adopted
    /// only if it verifies and accept_history() takes it over the floor.
    pub fn offer(&mut self, envelope: &str) -> Result<(), String> {
        self.offer_inner(envelope, true)
    }

    fn offer_inner(&mut self, envelope: &str, _user_action: bool) -> Result<(), String> {
        let incoming = verify_envelope(envelope, &self.keys)?;
        let app = incoming.app().ok_or("history has no app")?.to_string();
        let at = self.held.iter().position(|(h, _)| h.app() == Some(app.as_str()));
        let held = at.map(|i| &self.held[i].0.raw);
        match accept_history(held, &incoming.raw, &app) {
            Ok(()) => {
                if let Some(dir) = &self.floor_dir {
                    let _ = std::fs::create_dir_all(dir);
                    std::fs::write(dir.join(format!("{}.json", file_safe(&app))), envelope).map_err(|e| format!("floor write: {e}"))?;
                }
                match at {
                    Some(i) => self.held[i] = (incoming, envelope.to_string()),
                    None => self.held.push((incoming, envelope.to_string())),
                }
                Ok(())
            }
            // Not adopted: the held (newer) history stays the floor. An older
            // bundle after a newer one was seen is expected, not an error.
            Err(e) if held.is_some() => Err(format!("{app}: kept the held history ({e})")),
            Err(e) => Err(format!("{app}: {e}")),
        }
    }

    pub fn apps(&self) -> Vec<String> {
        self.held.iter().filter_map(|(h, _)| h.app().map(str::to_string)).collect()
    }

    /// Gate 1 across every held history: genuine only if exactly one release
    /// in all of them matches every block.
    pub fn verdict(&self, doc: &[u8]) -> Verdict {
        // gate 1's own held-set rule (bento_gate1::verify_served_held, held to the
        // corpus's `held` rows): every held history tried, exactly one may match.
        let held: Vec<History> = self.held.iter().map(|(h, _)| h.clone()).collect();
        if held.is_empty() { return Verdict::Unknown { reason: "no release history is held".into() } }
        match verify_served_held(doc, &held, "'none'") {
            (ServedVerdict::Genuine { release, csp }, app) => Verdict::Genuine { app: app.unwrap_or_default(), version: release.version, csp },
            (ServedVerdict::Unknown { reason }, _) => Verdict::Unknown { reason },
        }
    }
}

fn file_safe(s: &str) -> String {
    s.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect()
}

/// The newest version an app's held history lists (for the log and the UI).
pub fn newest(h: &History) -> Option<String> {
    h.raw.get("releases").and_then(Value::as_array).and_then(|a| a.first()).and_then(|e| e["version"].as_str()).map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn corpus(p: &str) -> String {
        std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/gate1").join(p)).unwrap()
    }
    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("bento-hostcore-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }
    /// The corpus history's payload re-signed is impossible without the key, so
    /// the rollback rows use the corpus's unsigned history rows directly.
    fn envelope_of(payload: &Value) -> String {
        serde_json::json!({ "payload": payload.to_string(), "sig": "AAAA" }).to_string()
    }

    #[test]
    fn the_release_key_alone_does_not_trust_the_test_history() {
        let (t, notes) = Trust::load_with_keys(vec![RELEASE_KEY], &[corpus("history.json")], None);
        assert!(t.apps().is_empty(), "{notes:?}");
        assert!(matches!(t.verdict(corpus("served/genuine-1.0.0.html").as_bytes()), Verdict::Unknown { .. }));
    }

    #[test]
    fn with_the_test_key_genuine_files_verify_and_carry_the_pinned_csp() {
        let (t, notes) = Trust::load_with_keys(vec![test_key()], &[corpus("history.json")], None);
        assert!(notes.is_empty(), "{notes:?}");
        match t.verdict(corpus("served/genuine-1.2.0.html").as_bytes()) {
            Verdict::Genuine { app, version, csp } => {
                assert_eq!((app.as_str(), version.as_str()), ("bento-test", "1.2.0"));
                assert!(csp.contains("frame-ancestors 'none'") && csp.contains("script-src 'sha256-"), "{csp}");
            }
            v => panic!("{v:?}"),
        }
        assert!(matches!(t.verdict(corpus("served/src-script.html").as_bytes()), Verdict::Unknown { .. }));
    }

    #[test]
    fn a_tampered_envelope_is_refused_and_held_nothing() {
        let mut env: Value = serde_json::from_str(&corpus("history.json")).unwrap();
        env["payload"] = Value::String(env["payload"].as_str().unwrap().replacen("1.2.0", "1.2.1", 1));
        let (t, notes) = Trust::load_with_keys(vec![test_key()], &[env.to_string()], None);
        assert!(t.apps().is_empty());
        assert!(notes[0].contains("INVALID"), "{notes:?}");
    }

    #[test]
    fn the_floor_persists_across_launches_even_with_nothing_bundled() {
        let dir = tmp("floor");
        let full = corpus("history.json");
        let (t, _) = Trust::load_with_keys(vec![test_key()], &[full.clone()], Some(&dir));
        assert_eq!(t.apps(), vec!["bento-test".to_string()]);
        assert!(dir.join("bento-test.json").exists(), "the floor is written");
        // a fresh launch with NOTHING bundled still holds the floor
        let (t2, notes) = Trust::load_with_keys(vec![test_key()], &[] as &[&str], Some(&dir));
        assert_eq!(t2.apps(), vec!["bento-test".to_string()], "{notes:?}");
        assert!(matches!(t2.verdict(corpus("served/genuine-1.0.0.html").as_bytes()), Verdict::Genuine { .. }));
        // the same history again: accepted, no change
        let mut t3 = t2;
        assert!(t3.offer(&full).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_older_signed_history_is_refused_against_the_floor() {
        // the corpus's rollback rows, through the same accept path offer() uses
        let exp: Value = serde_json::from_str(&corpus("expected.json")).unwrap();
        for r in exp["history"].as_array().unwrap() {
            let held = if r["held"].is_null() { None } else { Some(&r["held"]) };
            let got = accept_history(held, &r["incoming"], exp["app"].as_str().unwrap());
            assert_eq!(got.is_ok(), r["ok"].as_bool().unwrap(), "{}: {got:?}", r["name"]);
        }
        // and an unsigned envelope never reaches accept_history at all
        let (t, notes) = Trust::load_with_keys(vec![test_key()], &[envelope_of(&exp["history"][0]["incoming"])], None);
        assert!(t.apps().is_empty() && !notes.is_empty());
    }

    #[test]
    fn a_mixed_held_set_puts_each_file_on_its_own_app() {
        // the corpus history (test key) AND the frozen real 1.2.10 history (release key)
        let (t, notes) = Trust::load_with_keys(vec![test_key(), RELEASE_KEY], &[corpus("history.json"), corpus("real/slides-1.2.10/history.json")], None);
        assert!(notes.is_empty(), "{notes:?}");
        assert_eq!(t.apps().len(), 2);
        match t.verdict(corpus("real/slides-1.2.10/Bento_Slides.bento.html").as_bytes()) {
            Verdict::Genuine { app, version, .. } => assert_eq!((app.as_str(), version.as_str()), ("bento-slides", "1.2.10")),
            v => panic!("the real shell: {v:?}"),
        }
        match t.verdict(corpus("served/genuine-1.0.0.html").as_bytes()) {
            Verdict::Genuine { app, .. } => assert_eq!(app, "bento-test"),
            v => panic!("the synthetic file: {v:?}"),
        }
        // the real history alone does not make a synthetic file genuine
        let (real_only, _) = Trust::load_with_keys(vec![RELEASE_KEY], &[corpus("real/slides-1.2.10/history.json")], None);
        assert!(matches!(real_only.verdict(corpus("served/genuine-1.0.0.html").as_bytes()), Verdict::Unknown { .. }));
    }

    #[test]
    fn pinned_keys_hold_only_the_release_key_without_the_rig_feature() {
        if cfg!(feature = "rig-test-key") { return }
        assert_eq!(pinned_keys(), vec![RELEASE_KEY]);
    }
}
