// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The three calls of kernel/src/identity.ts as the desktop host answers them
// (bridge.js id.whoami / id.sign / id.resolve), on top of the agent's keys and
// the book of bindings. The host draws every prompt (`Ui`); the page never
// does, and nothing the page sends names a document, a caller or a key.
//
// - whoami: nothing to share (no own binding, or no device key) is
//   `no-identity` and NEVER prompts. Otherwise consent is PER DOCUMENT: the
//   first time a document asks, the person is asked, host-drawn, with what
//   would be shared. A yes is remembered for that document across launches; a
//   no is remembered until the host exits (there is no screen yet to undo a
//   permanent no, so none is stored).
// - resolve: answers only for a document the person has allowed, from bindings
//   this agent already holds; it never prompts (a prompt on resolve would let a
//   document spend the person's attention) and never reaches the network. An
//   unknown key and a refused document look the same: null.
// - sign: past the idle or overall limit, or after the OS locked or slept, the
//   agent says `reauth`; here the host asks the person to confirm (host-drawn)
//   and, on yes, opens a new session and signs once. The prompt is reached only
//   by a request that is otherwise valid (a matching payload, a device key
//   present), at most one at a time, and a no is not asked again for
//   REAUTH_COOLDOWN_MS. Nobody is asked while the screen is locked, or while
//   nothing is listening for a lock (`unavailable`: no answer could help), and a
//   yes that spans a lock or a sleep opens nothing.

use crate::agent::{Agent, Caller, Clock, KeyStore, Refusal, Signed};
use crate::book::{Binding, Book};
use crate::b64u;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::PathBuf;

pub const REAUTH_COOLDOWN_MS: u64 = 60_000;

/// What the HOST shows. Implemented over the platform's dialogs; the answers are
/// the person's, never the page's.
pub trait Ui {
    /// Allow this document to see who the person is? Shown with what it would see.
    fn consent(&mut self, doc_name: &str, who: &Binding) -> bool;
    /// Confirm it is the person, to keep signing. The reason is stated, not asked.
    fn reauth(&mut self, doc_name: &str) -> bool;
}

pub struct Calls<S: KeyStore, C: Clock> {
    pub agent: Agent<S, C>,
    book_path: PathBuf,
    /// documents the person said no to, until the host exits
    denied: HashSet<String>,
    reauth_blocked_until: u64,
}

fn book_refusal(_: crate::book::BookError) -> Refusal {
    Refusal::Unavailable
}

impl<S: KeyStore, C: Clock> Calls<S, C> {
    pub fn new(agent: Agent<S, C>, book_path: PathBuf) -> Self {
        Calls { agent, book_path, denied: HashSet::new(), reauth_blocked_until: 0 }
    }

    fn require_verified(caller: &Caller) -> Result<(), Refusal> {
        if caller.verified { Ok(()) } else { Err(Refusal::Unavailable) }
    }

    pub fn whoami(&mut self, caller: &Caller, doc_name: &str, ui: &mut dyn Ui) -> Result<Value, Refusal> {
        Self::require_verified(caller)?;
        // consent is per document: a document the host cannot name cannot be asked about
        let doc_id = caller.doc_id.as_deref().ok_or(Refusal::NoIdentity)?;
        let mut book = Book::load(&self.book_path).map_err(book_refusal)?;
        let own = book.own.clone().ok_or(Refusal::NoIdentity)?;
        let device = self.agent.device_pub()?.ok_or(Refusal::NoIdentity)?;
        if self.denied.contains(doc_id) {
            return Err(Refusal::Declined);
        }
        if !book.consented(doc_id) {
            if !ui.consent(doc_name, &own) {
                self.denied.insert(doc_id.to_string());
                return Err(Refusal::Declined);
            }
            book.allow(doc_id);
            book.save(&self.book_path).map_err(book_refusal)?;
        }
        Ok(json!({
            "name": own.name, "email": own.email, "vouchedBy": own.vouched_by,
            "accountPub": own.account_pub, "devicePub": b64u::enc(&device),
        }))
    }

    pub fn resolve(&mut self, caller: &Caller, pub_key: &str) -> Result<Value, Refusal> {
        Self::require_verified(caller)?;
        let Some(doc_id) = caller.doc_id.as_deref() else { return Ok(Value::Null) };
        let book = Book::load(&self.book_path).map_err(book_refusal)?;
        if !book.consented(doc_id) {
            return Ok(Value::Null);
        }
        let out = |b: &Binding, first_seen: u64, changed: bool| {
            json!({ "name": b.name, "email": b.email, "vouchedBy": b.vouched_by,
                    "accountPub": b.account_pub, "firstSeen": first_seen, "changed": changed })
        };
        if let Some(s) = book.seen(pub_key) {
            return Ok(out(&s.binding, s.first_seen, s.changed));
        }
        // this device's own key, or the account it belongs to: the person's own binding
        if let (Some(own), Ok(Some(dev))) = (&book.own, self.agent.device_pub()) {
            if pub_key == b64u::enc(&dev) || pub_key == own.account_pub {
                return Ok(out(own, 0, false));
            }
        }
        Ok(Value::Null)
    }

    pub fn sign(&mut self, caller: &Caller, doc_name: &str, purpose: &str, payload: &str, ui: &mut dyn Ui) -> Result<Signed, Refusal> {
        match self.agent.sign(caller, purpose, payload) {
            Err(Refusal::Reauth) => {}
            other => return other,
        }
        // `Reauth` is only reached by a request that is otherwise valid.
        let ticket = self.agent.reauth_ticket()?;
        if self.agent.now_ms() < self.reauth_blocked_until {
            return Err(Refusal::Reauth);
        }
        if !ui.reauth(doc_name) {
            self.reauth_blocked_until = self.agent.now_ms() + REAUTH_COOLDOWN_MS;
            return Err(Refusal::Reauth);
        }
        if !self.agent.begin_session_from(ticket) {
            return Err(Refusal::Reauth);
        }
        self.agent.sign(caller, purpose, payload)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::{memory::MemoryStore, Policy};
    use crate::lockgate::LockGate;
    use std::sync::Arc;
    use std::cell::Cell;
    use std::rc::Rc;

    #[derive(Clone)]
    struct T(Rc<Cell<u64>>);
    impl Clock for T {
        fn now_ms(&self) -> u64 {
            self.0.get()
        }
    }
    fn open_gate() -> Arc<LockGate> {
        let g = LockGate::new();
        g.watched(false);
        g
    }
    #[derive(Default)]
    struct Fake {
        yes_consent: bool,
        yes_reauth: bool,
        /// the machine locks while this prompt is on screen
        lock_during: Option<Arc<LockGate>>,
        consents: Vec<(String, String)>,
        reauths: Vec<String>,
    }
    impl Ui for Fake {
        fn consent(&mut self, d: &str, w: &Binding) -> bool {
            self.consents.push((d.into(), w.email.clone()));
            self.yes_consent
        }
        fn reauth(&mut self, d: &str) -> bool {
            self.reauths.push(d.into());
            if let Some(g) = &self.lock_during {
                g.lock();
            }
            self.yes_reauth
        }
    }
    fn me() -> Binding {
        Binding { name: "Ann".into(), email: "ann@example.org".into(), vouched_by: "id.bento.page".into(), account_pub: "ACC".into() }
    }
    fn calls(tag: &str, with_own: bool) -> (Calls<MemoryStore, T>, Rc<Cell<u64>>, PathBuf) {
        let d = std::env::temp_dir().join(format!("bento-calls-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let p = d.join("identity.json");
        let mut b = Book::default();
        if with_own {
            b.own = Some(me());
        }
        b.save(&p).unwrap();
        let t = Rc::new(Cell::new(1_800_000_000_000));
        (Calls::new(Agent::new(MemoryStore::with_keys(), T(t.clone()), Policy::default(), open_gate()), p.clone()), t, p)
    }
    fn caller(doc: &str) -> Caller {
        Caller { verified: true, doc_id: Some(doc.into()) }
    }
    fn frame() -> String {
        format!("{}.{}", b64u::enc(&[1; 12]), b64u::enc(&[2; 32]))
    }

    #[test]
    fn whoami_asks_once_per_document_and_remembers_a_yes() {
        let (mut c, _, p) = calls("w1", true);
        let mut ui = Fake { yes_consent: true, ..Default::default() };
        let v = c.whoami(&caller("A"), "a.bento.html", &mut ui).unwrap();
        assert_eq!(v["email"], "ann@example.org");
        assert_eq!(v["devicePub"].as_str().unwrap().len(), 87);
        assert_eq!(ui.consents, vec![("a.bento.html".to_string(), "ann@example.org".to_string())], "the prompt showed what is shared");
        c.whoami(&caller("A"), "a.bento.html", &mut ui).unwrap();
        assert_eq!(ui.consents.len(), 1, "no second prompt for the same document");
        c.whoami(&caller("B"), "b.bento.html", &mut ui).unwrap();
        assert_eq!(ui.consents.len(), 2, "a different document is asked");
        // across a launch: a fresh Calls over the same file
        let (mut c2, _, _) = (Calls::new(Agent::new(MemoryStore::with_keys(), T(Rc::new(Cell::new(1))), Policy::default(), open_gate()), p), (), ());
        c2.whoami(&caller("A"), "a.bento.html", &mut ui).unwrap();
        assert_eq!(ui.consents.len(), 2, "a yes survives a restart");
    }

    #[test]
    fn a_no_is_declined_and_not_asked_again_this_run() {
        let (mut c, _, p) = calls("w2", true);
        let mut ui = Fake::default();
        assert_eq!(c.whoami(&caller("A"), "a", &mut ui).unwrap_err(), Refusal::Declined);
        assert_eq!(c.whoami(&caller("A"), "a", &mut ui).unwrap_err(), Refusal::Declined);
        assert_eq!(ui.consents.len(), 1, "no nagging");
        assert!(!Book::load(&p).unwrap().consented("A"), "a no is not stored");
    }

    #[test]
    fn nothing_to_share_never_prompts() {
        let (mut c, _, _) = calls("w3", false);
        let mut ui = Fake { yes_consent: true, ..Default::default() };
        assert_eq!(c.whoami(&caller("A"), "a", &mut ui).unwrap_err(), Refusal::NoIdentity, "no own binding");
        let (mut c, _, _) = calls("w3b", true);
        assert_eq!(c.whoami(&Caller { verified: true, doc_id: None }, "a", &mut ui).unwrap_err(), Refusal::NoIdentity, "no docId");
        assert_eq!(c.whoami(&Caller { verified: false, doc_id: Some("A".into()) }, "a", &mut ui).unwrap_err(), Refusal::Unavailable, "unverified");
        c.agent = Agent::new(MemoryStore::default(), T(Rc::new(Cell::new(1))), Policy::default(), open_gate());
        assert_eq!(c.whoami(&caller("A"), "a", &mut ui).unwrap_err(), Refusal::NoIdentity, "no device key");
        assert!(ui.consents.is_empty());
    }

    #[test]
    fn a_corrupt_book_is_unavailable_and_untouched() {
        let (mut c, _, p) = calls("w4", true);
        std::fs::write(&p, "{x").unwrap();
        let mut ui = Fake { yes_consent: true, ..Default::default() };
        assert_eq!(c.whoami(&caller("A"), "a", &mut ui).unwrap_err(), Refusal::Unavailable);
        assert_eq!(c.resolve(&caller("A"), "K").unwrap_err(), Refusal::Unavailable);
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "{x");
    }

    #[test]
    fn resolve_answers_only_for_an_allowed_document_and_only_known_keys() {
        let (mut c, _, p) = calls("r1", true);
        let mut book = Book::load(&p).unwrap();
        book.observe("KBOB", Binding { name: "Bob".into(), email: "bob@example.org".into(), vouched_by: "id.bento.page".into(), account_pub: "BACC".into() }, 42);
        book.save(&p).unwrap();
        assert_eq!(c.resolve(&caller("A"), "KBOB").unwrap(), Value::Null, "not allowed yet: same as unknown");
        let mut ui = Fake { yes_consent: true, ..Default::default() };
        c.whoami(&caller("A"), "a", &mut ui).unwrap();
        let r = c.resolve(&caller("A"), "KBOB").unwrap();
        assert_eq!((r["name"].clone(), r["firstSeen"].clone(), r["changed"].clone()), (json!("Bob"), json!(42), json!(false)));
        assert_eq!(c.resolve(&caller("A"), "KNOBODY").unwrap(), Value::Null);
        assert_eq!(c.resolve(&caller("B"), "KBOB").unwrap(), Value::Null, "another document is not allowed");
        assert_eq!(c.resolve(&caller("A"), "ACC").unwrap()["email"], "ann@example.org", "the person's own account key");
        let dev = b64u::enc(&c.agent.device_pub().unwrap().unwrap());
        assert_eq!(c.resolve(&caller("A"), &dev).unwrap()["email"], "ann@example.org", "the person's own device key");
        assert_eq!(c.resolve(&Caller { verified: false, doc_id: Some("A".into()) }, "KBOB").unwrap_err(), Refusal::Unavailable);
        assert_eq!(ui.consents.len(), 1, "resolve never prompts");
    }

    #[test]
    fn a_changed_binding_reaches_the_page_as_changed() {
        let (mut c, _, p) = calls("r2", true);
        let mut book = Book::load(&p).unwrap();
        let bob = Binding { name: "Bob".into(), email: "bob@example.org".into(), vouched_by: "id.bento.page".into(), account_pub: "BACC".into() };
        book.observe("KBOB", bob.clone(), 1);
        book.observe("KBOB", Binding { email: "mallory@example.org".into(), ..bob }, 2);
        book.allow("A");
        book.save(&p).unwrap();
        let r = c.resolve(&caller("A"), "KBOB").unwrap();
        assert_eq!((r["changed"].clone(), r["email"].clone()), (json!(true), json!("bob@example.org")));
    }

    #[test]
    fn reauth_prompts_then_signs_once_and_a_no_is_not_repeated() {
        let (mut c, t, _) = calls("s1", true);
        let mut ui = Fake { yes_reauth: true, ..Default::default() };
        // no session yet: ask; yes opens it and signs
        assert!(c.sign(&caller("A"), "a.bento.html", "frame", &frame(), &mut ui).is_ok());
        assert_eq!(ui.reauths, vec!["a.bento.html".to_string()]);
        assert!(c.sign(&caller("A"), "a", "frame", &frame(), &mut ui).is_ok());
        assert_eq!(ui.reauths.len(), 1, "inside the limits: no prompt");
        // past idle: asked again
        t.set(t.get() + 60 * 60_000 + 1);
        assert!(c.sign(&caller("A"), "a", "frame", &frame(), &mut ui).is_ok());
        assert_eq!(ui.reauths.len(), 2);
        // past idle, the person says no: refused, and not asked again for the cooldown
        t.set(t.get() + 60 * 60_000 + 1);
        ui.yes_reauth = false;
        assert_eq!(c.sign(&caller("A"), "a", "frame", &frame(), &mut ui).unwrap_err(), Refusal::Reauth);
        assert_eq!(c.sign(&caller("A"), "a", "frame", &frame(), &mut ui).unwrap_err(), Refusal::Reauth);
        assert_eq!(ui.reauths.len(), 3, "one prompt, one no, then the cooldown");
        t.set(t.get() + REAUTH_COOLDOWN_MS + 1);
        ui.yes_reauth = true;
        assert!(c.sign(&caller("A"), "a", "frame", &frame(), &mut ui).is_ok());
        assert_eq!(ui.reauths.len(), 4, "asked again after the cooldown");
    }

    #[test]
    fn nobody_is_asked_while_the_screen_is_locked_or_nothing_is_listening() {
        let (mut c, _, _) = calls("s3", true);
        let g = open_gate();
        let keys = MemoryStore::with_keys();
        c.agent = Agent::new(keys, T(Rc::new(Cell::new(1_800_000_000_000))), Policy::default(), g.clone());
        let mut ui = Fake { yes_reauth: true, ..Default::default() };
        g.set_locked(true);
        assert_eq!(c.sign(&caller("A"), "a", "frame", &frame(), &mut ui).unwrap_err(), Refusal::Reauth);
        g.lost();
        assert_eq!(c.sign(&caller("A"), "a", "frame", &frame(), &mut ui).unwrap_err(), Refusal::Unavailable);
        assert!(ui.reauths.is_empty(), "no prompt on a locked screen, none that could not help");
        g.watched(false);
        assert!(c.sign(&caller("A"), "a", "frame", &frame(), &mut ui).is_ok(), "control: unlocked, watched, confirmed");
        assert_eq!(ui.reauths.len(), 1);
    }

    #[test]
    fn a_confirm_across_a_lock_signs_nothing_and_is_not_a_no() {
        let (mut c, _, _) = calls("s4", true);
        let g = open_gate();
        c.agent = Agent::new(MemoryStore::with_keys(), T(Rc::new(Cell::new(1_800_000_000_000))), Policy::default(), g.clone());
        let mut ui = Fake { yes_reauth: true, lock_during: Some(g), ..Default::default() };
        assert_eq!(c.sign(&caller("A"), "a", "frame", &frame(), &mut ui).unwrap_err(), Refusal::Reauth);
        ui.lock_during = None;
        assert!(c.sign(&caller("A"), "a", "frame", &frame(), &mut ui).is_ok(), "the person is asked afresh, with no cooldown");
        assert_eq!(ui.reauths.len(), 2);
    }

    #[test]
    fn reauth_is_reached_only_by_a_valid_request() {
        let (mut c, _, _) = calls("s2", true);
        let mut ui = Fake { yes_reauth: true, ..Default::default() };
        assert_eq!(c.sign(&caller("A"), "a", "frame", "not-a-frame", &mut ui).unwrap_err(), Refusal::Purpose);
        assert_eq!(c.sign(&Caller { verified: false, doc_id: None }, "a", "frame", &frame(), &mut ui).unwrap_err(), Refusal::Unavailable);
        assert_eq!(c.sign(&caller("A"), "a", "invite", "inv.x", &mut ui).unwrap_err(), Refusal::Purpose);
        c.agent = Agent::new(MemoryStore::default(), T(Rc::new(Cell::new(1))), Policy::default(), open_gate());
        assert_eq!(c.sign(&caller("A"), "a", "frame", &frame(), &mut ui).unwrap_err(), Refusal::NoIdentity, "no key: nothing to unlock");
        assert!(ui.reauths.is_empty(), "no prompt for a bad payload, an unverified caller, an owner purpose or no key");
    }
}
