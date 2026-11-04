// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The per-load capability and the navigation lock (security §19d, §19e).
//
// Tauri's IPC carries no frame identity, and its invoke key is per PROCESS and
// readable by any main-frame script. So neither the key nor the URL is a
// capability. Every privileged command needs a secret minted for THIS load of
// THIS webview, checked against the webview the call ARRIVED on.
//
// The rules, each a transition below:
// - EVERY main-frame load start revokes (§19e 1). A reload or a navigation
//   never inherits a secret.
// - Only a FINISHED load of the document's own URL mints one, and it stays
//   PENDING until the page echoes the nonce with the generation unchanged
//   (§19e 2). A load that starts between the mint and the echo voids it, which
//   closes the arming race.
// - ONE mint per generation. The engine may report a finished load twice for
//   one generation (measured on WebView2): a second report while PENDING hands
//   the page the SAME secret and nonce, and a second report once ARMED does
//   nothing at all. Re-minting there left the host pending under a secret an
//   armed page never takes, so every later call failed for the rest of the load.
// - Per-load state (the open-document handle, exports) resets in the SAME
//   step that mints (§19e 3), so a reload never carries a handle across.
// - Arming binds to the verdict of the bytes SERVED for this load (§19e 3):
//   identity commands ask `armed_genuine()`, never a re-read of the file. The
//   verdict is FIXED AT THE LOAD START, since the document is served before it:
//   every serve since the previous start counts, and ONE unknown serve makes
//   the load unknown. A serve after the start counts only against the next load,
//   so a genuine serve then (the page fetching its own URL after the file
//   changed) proves nothing about the bytes already running. The mint consumes
//   the verdict, so it can never outlive the load it judged.
// - The host holds every Load behind one lock, and load events and IPC take it
//   in arrival order: one serialized queue.

use std::collections::HashMap;
use std::path::PathBuf;

fn random_hex(bytes: usize) -> String {
    let mut b = vec![0u8; bytes];
    getrandom::fill(&mut b).expect("getrandom");
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Constant-time equality for secrets.
pub fn ct_eq(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[derive(Debug, Clone, PartialEq)]
enum State {
    Revoked,
    Pending { cap: String, nonce: String, generation: u64, genuine: bool },
    Armed { cap: String, generation: u64, genuine: bool },
}

/// What the host must hand the page's main frame after a finished document load.
#[derive(Debug, Clone, PartialEq)]
pub struct Arming {
    pub cap: String,
    pub nonce: String,
    pub generation: u64,
}

#[derive(Debug)]
pub struct Load {
    pub generation: u64,
    state: State,
    /// Every serve to this webview since the last load start, ANDed: `Some(true)`
    /// only if all of them were genuine. It cannot be keyed to a generation: the
    /// main document is served BEFORE its load start, which the engines raise at
    /// commit, so a serve cannot tell which load it belongs to.
    served_genuine: Option<bool>,
    /// The verdict of the load in progress, fixed at its start. A later serve
    /// cannot reach it, and the mint takes it.
    load_verdict: Option<bool>,
    /// bridge.js's rule: the FIRST begin is the open document, any later one an export.
    pub handed_out: bool,
    pub exports: HashMap<String, PathBuf>,
}

impl Default for Load {
    fn default() -> Self {
        Load { generation: 0, state: State::Revoked, served_genuine: None, load_verdict: None, handed_out: false, exports: HashMap::new() }
    }
}

impl Load {
    /// The protocol handler served the document's bytes, with this verdict.
    /// ANY request to the document's URL lands here, a page's own fetch included.
    pub fn served(&mut self, genuine: bool) {
        self.served_genuine = Some(self.served_genuine.unwrap_or(true) && genuine);
    }

    /// Any main-frame load start: revoke, start a new generation, and fix its verdict.
    pub fn load_started(&mut self) {
        self.generation += 1;
        self.state = State::Revoked;
        self.load_verdict = self.served_genuine.take();
    }

    /// A main-frame load finished. Mints a PENDING capability only for the
    /// document's own URL, only if its bytes were served, and only once per
    /// generation; resets per-load state in the same step as the mint.
    ///
    /// A repeat report for this generation mints nothing and resets nothing:
    /// PENDING hands back the same secret and nonce (the page may have missed
    /// the first delivery), ARMED answers None.
    pub fn load_finished(&mut self, is_document_url: bool) -> Option<Arming> {
        if !is_document_url { return None }
        match &self.state {
            State::Pending { cap, nonce, generation, .. } if *generation == self.generation => {
                return Some(Arming { cap: cap.clone(), nonce: nonce.clone(), generation: *generation })
            }
            State::Armed { generation, .. } if *generation == self.generation => return None,
            _ => {}
        }
        let genuine = self.load_verdict.take()?;
        let (cap, nonce) = (random_hex(16), random_hex(16));
        self.state = State::Pending { cap: cap.clone(), nonce: nonce.clone(), generation: self.generation, genuine };
        self.handed_out = false;
        self.exports.clear();
        Some(Arming { cap, nonce, generation: self.generation })
    }

    /// The page echoes the nonce (with the capability it was handed). Arms only
    /// if this is still the same load.
    pub fn confirm(&mut self, nonce: &str, cap: &str) -> Result<(), &'static str> {
        match &self.state {
            State::Pending { cap: c, nonce: n, generation, genuine } => {
                if *generation != self.generation { return Err("a newer load started") }
                if !ct_eq(n, nonce) || !ct_eq(c, cap) { return Err("arming refused") }
                self.state = State::Armed { cap: c.clone(), generation: *generation, genuine: *genuine };
                Ok(())
            }
            State::Armed { .. } => Err("already armed"),
            State::Revoked => Err("not pending"),
        }
    }

    /// In front of EVERY privileged command.
    pub fn check(&self, cap: Option<&str>) -> Result<(), &'static str> {
        match (&self.state, cap) {
            (State::Armed { cap: want, generation, .. }, Some(got)) if *generation == self.generation => {
                if ct_eq(want, got) { Ok(()) } else { Err("capability refused") }
            }
            (State::Armed { .. }, None) => Err("no capability"),
            (State::Pending { .. }, _) => Err("not armed yet"),
            _ => Err("not armed"),
        }
    }

    /// Identity commands: armed AND the bytes served for this load were genuine.
    pub fn armed_genuine(&self) -> bool {
        matches!(self.state, State::Armed { genuine: true, generation, .. } if generation == self.generation)
    }
}

/// Every webview's load, keyed by the webview label the host created it with.
#[derive(Default)]
pub struct Registry {
    pub loads: HashMap<String, Load>,
}

impl Registry {
    /// The capability check bound to the ARRIVAL webview: a secret minted for
    /// another webview is refused even if it is valid there.
    pub fn check(&self, arrival_label: &str, cap: Option<&str>) -> Result<(), &'static str> {
        self.loads.get(arrival_label).ok_or("unknown webview")?.check(cap)
    }
}

/// Is this URL the document? A fragment never reaches the protocol handler, so
/// `own#x` is the same bytes from the same origin. It has to count: a page moves
/// its own fragment without the host seeing it (pushState on both engines, a
/// plain `#x` link on WebView2), and from then on the engine reports the page's
/// URL with that fragment, so a reload compared exactly is refused, or bounced,
/// or never armed. A query is another URL: exact, as before.
pub fn is_document(url: &str, own: &str) -> bool {
    url.split('#').next() == Some(own)
}

/// The navigation policy for Tauri's on_navigation: the document's own URL, or
/// https (live embeds). Everything else is refused: http, file, data, blob,
/// javascript, and other documents' origins.
///
/// What this covers differs by engine. On WebKitGTK the callback also fires for
/// iframes, with no frame identity. On WebView2 it is wired to NavigationStarting
/// alone, so it sees the MAIN FRAME only: frames there are held by the document's
/// pinned CSP, and an unknown document (no CSP) has no frame policy at all.
pub fn navigation_allowed(url: &str, own: &str) -> bool {
    is_document(url, own) || url.starts_with("https://")
}

/// What to do when the MAIN FRAME starts loading something that isn't the
/// document (§19e 1: the bounce to the system browser is required).
#[derive(Debug, PartialEq)]
pub enum Bounce {
    /// It is the document: nothing to do.
    Stay,
    /// Go back to the document, and open this URL in the system browser.
    BackAndOpen(String),
    /// Go back to the document; nothing is opened (not a web or mail link).
    Back,
}

pub fn main_frame_load(url: &str, own: &str) -> Bounce {
    if is_document(url, own) { return Bounce::Stay }
    let lower = url.to_ascii_lowercase();
    if lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("mailto:") {
        Bounce::BackAndOpen(url.to_string())
    } else {
        Bounce::Back
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Every test serves the document BEFORE its load start, the order of both engines.
    fn armed(genuine: bool) -> (Load, Arming) {
        let mut l = Load::default();
        l.served(genuine);
        l.load_started();
        let a = l.load_finished(true).unwrap();
        l.confirm(&a.nonce, &a.cap).unwrap();
        (l, a)
    }

    #[test]
    fn a_finished_document_load_arms_only_after_the_echo() {
        let mut l = Load::default();
        l.served(true);
        l.load_started();
        let a = l.load_finished(true).unwrap();
        assert_eq!(l.check(Some(&a.cap)), Err("not armed yet"), "pending is not armed");
        l.confirm(&a.nonce, &a.cap).unwrap();
        assert_eq!(l.check(Some(&a.cap)), Ok(()));
        assert!(l.armed_genuine());
    }

    #[test]
    fn a_load_between_mint_and_echo_voids_the_arming() {
        let mut l = Load::default();
        l.served(true);
        l.load_started();
        let a = l.load_finished(true).unwrap();
        l.load_started(); // a reload races the echo
        assert!(l.confirm(&a.nonce, &a.cap).is_err());
        assert!(l.check(Some(&a.cap)).is_err());
    }

    #[test]
    fn every_load_start_revokes_and_a_reload_rotates_the_secret() {
        let (mut l, a) = armed(true);
        l.served(true);
        l.load_started();
        assert_eq!(l.check(Some(&a.cap)), Err("not armed"));
        let b = l.load_finished(true).unwrap();
        l.confirm(&b.nonce, &b.cap).unwrap();
        assert_ne!(a.cap, b.cap);
        assert!(l.check(Some(&a.cap)).is_err(), "the old load's secret is dead");
        assert!(l.check(Some(&b.cap)).is_ok());
    }

    #[test]
    fn a_foreign_page_in_the_main_frame_is_never_armed() {
        let mut l = Load::default();
        l.served(true);
        l.load_started();
        assert_eq!(l.load_finished(false), None);
        assert!(l.check(None).is_err());
    }

    #[test]
    fn nothing_served_means_nothing_to_arm() {
        let mut l = Load::default();
        l.load_started();
        assert_eq!(l.load_finished(true), None, "re-arming needs a verdict on SERVED bytes");
    }

    #[test]
    fn wrong_nonce_wrong_cap_and_double_confirm_are_refused() {
        let mut l = Load::default();
        l.served(false);
        l.load_started();
        let a = l.load_finished(true).unwrap();
        assert!(l.confirm("00", &a.cap).is_err());
        assert!(l.confirm(&a.nonce, "00").is_err());
        l.confirm(&a.nonce, &a.cap).unwrap();
        assert_eq!(l.confirm(&a.nonce, &a.cap), Err("already armed"));
        assert!(!l.armed_genuine(), "an unknown document's load arms the FILE capability only");
        assert!(l.check(Some(&a.cap)).is_ok());
        assert_eq!(l.check(None), Err("no capability"));
    }

    #[test]
    fn per_load_state_resets_in_the_same_step_as_minting() {
        let (mut l, _) = armed(true);
        l.handed_out = true;
        l.exports.insert("x".into(), PathBuf::from("/x"));
        l.served(true);
        l.load_started();
        let _ = l.load_finished(true).unwrap();
        assert!(!l.handed_out && l.exports.is_empty(), "a reload starts with a fresh handle");
    }

    #[test]
    fn the_capability_binds_to_the_arrival_webview() {
        let mut r = Registry::default();
        let (a, ca) = armed(true);
        let (b, cb) = armed(true);
        r.loads.insert("doc0".into(), a);
        r.loads.insert("doc1".into(), b);
        assert!(r.check("doc0", Some(&ca.cap)).is_ok());
        assert!(r.check("doc0", Some(&cb.cap)).is_err(), "doc1's secret arriving on doc0 is refused");
        assert!(r.check("doc2", Some(&ca.cap)).is_err());
    }

    #[test]
    fn the_verdict_is_the_served_one_not_a_later_one() {
        let mut l = Load::default();
        l.served(false);
        l.load_started();
        let a = l.load_finished(true).unwrap();
        l.served(true); // the file changed after this load was served
        l.confirm(&a.nonce, &a.cap).unwrap();
        assert!(!l.armed_genuine(), "this load runs the bytes that were served, which were unknown");
    }

    #[test]
    fn a_reload_after_a_save_re_arms_from_the_new_served_verdict() {
        let mut l = Load::default();
        l.served(false);
        l.load_started();
        let a = l.load_finished(true).unwrap();
        l.confirm(&a.nonce, &a.cap).unwrap();
        assert!(!l.armed_genuine());
        // the user saves; the saved bytes verify; the next load serves them
        l.served(true);
        l.load_started();
        let b = l.load_finished(true).unwrap();
        l.confirm(&b.nonce, &b.cap).unwrap();
        assert!(l.armed_genuine(), "the new load runs the new (genuine) bytes");
        // and the other way: genuine, then the file becomes unknown
        l.served(false);
        l.load_started();
        let c = l.load_finished(true).unwrap();
        l.confirm(&c.nonce, &c.cap).unwrap();
        assert!(!l.armed_genuine());
    }

    /// WebView2's report order, A: the page echoes between the two reports.
    #[test]
    fn a_repeat_finish_after_arming_changes_nothing() {
        let (mut l, a) = armed(true);
        l.handed_out = true;
        l.exports.insert("x".into(), PathBuf::from("/x"));
        assert_eq!(l.load_finished(true), None, "armed: nothing to deliver");
        assert_eq!(l.check(Some(&a.cap)), Ok(()), "the armed secret still works");
        assert!(l.armed_genuine());
        assert!(l.handed_out && l.exports.len() == 1, "a repeat report is not a new load");
    }

    /// WebView2's report order, B: both reports land before the echo.
    #[test]
    fn a_repeat_finish_while_pending_hands_back_the_same_secret() {
        let mut l = Load::default();
        l.served(true);
        l.load_started();
        let a = l.load_finished(true).unwrap();
        l.handed_out = true;
        let b = l.load_finished(true).unwrap();
        assert_eq!(a, b, "one mint per generation");
        assert!(l.handed_out, "a repeat report resets nothing");
        l.confirm(&a.nonce, &a.cap).unwrap();
        assert_eq!(l.check(Some(&a.cap)), Ok(()));
        assert_eq!(l.confirm(&b.nonce, &b.cap), Err("already armed"), "the second echo is refused, and changes nothing");
        assert_eq!(l.check(Some(&a.cap)), Ok(()));
    }

    #[test]
    fn the_next_generation_mints_afresh_after_a_repeat_finish() {
        let (mut l, a) = armed(true);
        assert_eq!(l.load_finished(true), None);
        l.served(true);
        l.load_started();
        let b = l.load_finished(true).unwrap();
        assert_ne!(a.cap, b.cap);
        assert_ne!(a.nonce, b.nonce);
    }

    /// B2, the AND half: the page's own fetch, after the file became genuine,
    /// cannot launder the unknown bytes already running.
    #[test]
    fn one_unknown_serve_makes_the_load_unknown() {
        for serves in [&[false, true][..], &[true, false], &[true, false, true], &[false, false]] {
            let mut l = Load::default();
            for s in serves { l.served(*s) }
            l.load_started();
            let a = l.load_finished(true).unwrap();
            l.confirm(&a.nonce, &a.cap).unwrap();
            assert!(!l.armed_genuine(), "{serves:?}");
        }
        let mut l = Load::default();
        l.served(true);
        l.load_started();
        l.served(true);
        let a = l.load_finished(true).unwrap();
        l.confirm(&a.nonce, &a.cap).unwrap();
        assert!(l.armed_genuine(), "every serve genuine: genuine");
    }

    /// B2 as reported: the reload's document is served BEFORE its load start, and
    /// the old page, still holding a live capability, swaps the file in between.
    #[test]
    fn a_reload_served_unknown_stays_unknown_whatever_is_served_after_the_commit() {
        let (mut l, _) = armed(false);
        l.served(false); // the reload's document, before the commit
        l.load_started(); // the commit
        l.served(true); // the new page fetches its own URL: the file is now genuine
        let a = l.load_finished(true).unwrap();
        l.confirm(&a.nonce, &a.cap).unwrap();
        assert!(!l.armed_genuine());
    }

    /// B4: the document reloads between its serve and the previous load's finish.
    /// That serve belongs to the NEXT load, so the previous load's mint must leave
    /// it alone, and a serve after the next load's start must not stand in for it.
    #[test]
    fn a_reload_served_before_the_previous_finish_keeps_its_own_verdict() {
        let mut l = Load::default();
        l.served(false);
        l.load_started();
        l.served(false); // the reload's document, before this load's finish
        let a = l.load_finished(true).unwrap();
        l.confirm(&a.nonce, &a.cap).unwrap();
        l.load_started(); // the reload commits: its unknown bytes are what run
        l.served(true); // the file is genuine by now, and the new page fetches its own URL
        let b = l.load_finished(true).unwrap();
        l.confirm(&b.nonce, &b.cap).unwrap();
        assert!(!l.armed_genuine(), "these bytes were served unknown");
        // the honest order: the reload opens armed, on its own verdict
        let mut l = Load::default();
        l.served(false);
        l.load_started();
        l.served(true);
        let a = l.load_finished(true).unwrap();
        l.confirm(&a.nonce, &a.cap).unwrap();
        assert!(!l.armed_genuine());
        l.load_started();
        let b = l.load_finished(true).unwrap();
        l.confirm(&b.nonce, &b.cap).unwrap();
        assert!(l.armed_genuine());
    }

    /// A load that never finished (the bounce's https load) leaves nothing behind.
    #[test]
    fn a_load_that_never_finished_hands_no_verdict_to_the_next() {
        let mut l = Load::default();
        l.served(true);
        l.load_started();
        l.load_started();
        assert_eq!(l.load_finished(true), None, "nothing was served for this load");
        let mut l = Load::default();
        l.served(false);
        l.load_started();
        l.served(true);
        l.load_started();
        let a = l.load_finished(true).unwrap();
        l.confirm(&a.nonce, &a.cap).unwrap();
        assert!(l.armed_genuine(), "its own serve is its verdict");
    }

    /// B2, the take half: a verdict dies with the mint that used it.
    #[test]
    fn a_verdict_is_consumed_by_its_mint() {
        let (mut l, _) = armed(true);
        l.load_started();
        assert_eq!(l.load_finished(true), None, "a load nobody served has no verdict to borrow");
        let (mut l, _) = armed(false);
        l.served(true);
        l.load_started();
        let a = l.load_finished(true).unwrap();
        l.confirm(&a.nonce, &a.cap).unwrap();
        assert!(l.armed_genuine(), "the last load's unknown verdict does not reach this one");
    }

    /// A serve after arming with a repeat report: the armed verdict stands, and
    /// the stray serve is still counted against the next load.
    #[test]
    fn a_serve_after_arming_with_a_repeat_finish_changes_nothing_now() {
        let (mut l, a) = armed(false);
        l.served(true);
        assert_eq!(l.load_finished(true), None);
        assert!(!l.armed_genuine(), "still the bytes that were served");
        assert_eq!(l.check(Some(&a.cap)), Ok(()));
        let (mut l, _) = armed(true);
        l.served(false); // the page fetched its own URL, and the bytes were unknown by then
        assert_eq!(l.load_finished(true), None);
        l.served(true);
        l.load_started();
        let b = l.load_finished(true).unwrap();
        l.confirm(&b.nonce, &b.cap).unwrap();
        assert!(!l.armed_genuine(), "a serve between mints counts against the next: fail closed");
    }

    /// A fragment is the document; a query, a longer path or a look-alike host is not.
    #[test]
    fn the_document_url_carries_any_fragment_and_nothing_else() {
        let own = "http://bento.abc.localhost/";
        for same in [own.to_string(), format!("{own}#x"), format!("{own}#p/1"), format!("{own}#"), format!("{own}#a#b")] {
            assert!(is_document(&same, own), "{same}");
            assert!(navigation_allowed(&same, own), "{same}");
            assert_eq!(main_frame_load(&same, own), Bounce::Stay, "{same}");
        }
        for other in ["http://bento.abc.localhost/?q", "http://bento.abc.localhost/?q#x", "http://bento.abc.localhost/x#y", "http://bento.abc.localhost", "http://bento.abd.localhost/#x", "#x", ""] {
            assert!(!is_document(other, own), "{other}");
            assert!(!navigation_allowed(other, own), "{other}");
            assert_ne!(main_frame_load(other, own), Bounce::Stay, "{other}");
        }
    }

    #[test]
    fn navigation_policy_and_bounce() {
        let own = "bento://abc.localhost/";
        assert!(navigation_allowed(own, own));
        assert!(navigation_allowed("https://www.youtube.com/embed/x", own));
        for bad in ["http://x.test/", "file:///etc/passwd", "data:text/html,x", "blob:bento://abc/1", "javascript:alert(1)", "bento://other.localhost/"] {
            assert!(!navigation_allowed(bad, own), "{bad}");
        }
        assert_eq!(main_frame_load(own, own), Bounce::Stay);
        assert_eq!(main_frame_load("https://bento.page/", own), Bounce::BackAndOpen("https://bento.page/".into()));
        assert_eq!(main_frame_load("mailto:a@b.c", own), Bounce::BackAndOpen("mailto:a@b.c".into()));
        assert_eq!(main_frame_load("file:///etc/passwd", own), Bounce::Back);
        assert_eq!(main_frame_load("bento://other.localhost/", own), Bounce::Back);
    }
}
