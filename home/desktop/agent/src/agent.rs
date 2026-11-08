// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The agent: what a verified document may ask (kernel/src/identity.ts, K1),
// answered from keys the document never sees.
//
// - The ONLY way in is a `Caller`, which the host builds after its capability
//   check (security §19d (a)) and gate 1 (a verified shell). The agent never
//   takes a docId or a caller name from the page.
// - Routine signing (frame/prove/delegate/show) uses the device ROUTINE key,
//   unprompted, inside a session bounded by the idle and overall timers
//   (§2e (B)): past either, even routine signatures are refused until the person
//   re-authenticates. These timers bind the GENUINE agent only — a same-user
//   process can call the OS key store directly (security, H1 key table).
// - Consent (`cns.`) is host-STAMPED (§2e (A)): the rp, audience, docId and
//   expiry are chosen here; the page supplies only the statement and the
//   verifier's challenge. Signed by the CONSENT key, which prompts every use.
// - kx: placement is mode C (§6b): a per-device kx in dev., a recovery kx in
//   bind. This agent does not enrol yet, so it holds no kx; the enrolment that
//   comes must mint both (see kernel/fixtures/README.md).

use crate::lockgate::{GateState, LockGate};
use crate::{b64u, statements as st};
use std::sync::Arc;

/// Which key. The account key is handled by the account flows (link, rotate,
/// unbind), not by `sign`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyRole {
    Account,
    /// the device ROUTINE key (`devicePub` in `dev.`)
    Device,
    /// the hardware CONSENT key (`consentPub` in `dev.`), UV on every use
    Consent,
}

/// What the host shows when a key store needs the person (the consent key's
/// per-use prompt). Drawn by the HOST or the OS, never by the page.
#[derive(Debug, Clone)]
pub struct Prompt {
    pub purpose: String,
    pub doc_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreError {
    /// the person said no at the OS/host prompt
    Declined,
    /// no such key on this device
    NoKey,
    /// the store cannot act right now (locked, no TPM, busy)
    Unavailable(String),
}

/// The OS key store: Windows NCrypt (TPM + Hello), Linux TPM, or Secret
/// Service. Private keys never leave it through this trait.
pub trait KeyStore {
    /// The raw uncompressed P-256 public point, or None if the key does not exist.
    fn public_key(&self, role: &KeyRole) -> Result<Option<[u8; 65]>, StoreError>;
    /// ECDSA P-256 / SHA-256 over `msg`, raw r‖s (either S; the agent folds).
    /// A store whose key needs the person (the consent key) shows `prompt`.
    fn sign(&mut self, role: &KeyRole, msg: &[u8], prompt: Option<&Prompt>) -> Result<[u8; 64], StoreError>;
    /// True when this store holds a hardware consent key (false: Linux without
    /// a TPM → AAL3 refused and routed elsewhere, §2e (E)).
    fn has_consent_key(&self) -> bool;
}

pub trait Clock {
    fn now_ms(&self) -> u64;
}

/// The routine session (§2e (B)). Defaults are the AAL2 SHOULDs; an org may
/// set the AAL3 ones (15 min / 12 h).
#[derive(Debug, Clone, Copy)]
pub struct Policy {
    pub idle_ms: u64,
    pub overall_ms: u64,
}
impl Default for Policy {
    fn default() -> Self {
        Policy { idle_ms: 60 * 60_000, overall_ms: 24 * 60 * 60_000 }
    }
}

/// Who is asking, as the HOST established it: after the per-webview capability
/// check, on a verified shell. `doc_id` is the host's key for THE FILE IT OPENED
/// (on desktop: install salt + canonical path + the file's docId, hashed), never
/// the bare docId, which whoever wrote the file chose. Not constructible from
/// page input by design: the host builds it.
#[derive(Debug, Clone)]
pub struct Caller {
    pub verified: bool,
    pub doc_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    Declined,
    Reauth,
    Purpose,
    NoIdentity,
    Unavailable,
}
impl Refusal {
    /// The K1 `SignRefusal` word.
    pub fn as_str(self) -> &'static str {
        match self {
            Refusal::Declined => "declined",
            Refusal::Reauth => "reauth",
            Refusal::Purpose => "purpose",
            Refusal::NoIdentity => "no-identity",
            Refusal::Unavailable => "unavailable",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Signed {
    /// raw r‖s, low-S, base64url
    pub sig: String,
    /// the key that signed, raw point base64url
    pub pub_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConsentSigned {
    /// the exact `cns.` text the consent key signed
    pub cns: String,
    pub sig: String,
    pub consent_pub: String,
}

/// bento's relying party in a `cns.` (a vault id when there is one).
pub const RP: &str = "bento";
/// Phase 1's only consent audience: the directory (security §24).
pub const AUDIENCE: &str = "dir";
/// Stamped consent lifetime: under CONSENT_MAX_TTL_MS (5 min), as Android.
pub const CONSENT_TTL_MS: u64 = 2 * 60_000;

const ROUTINE: [&str; 4] = ["frame", "prove", "delegate", "show"];

pub struct Agent<S: KeyStore, C: Clock> {
    store: S,
    clock: C,
    policy: Policy,
    /// None = must re-authenticate
    session: Option<Session>,
    /// What the OS says about the person's session. A routine session lives only
    /// while this stays open at the epoch it began in.
    gate: Arc<LockGate>,
}

#[derive(Clone, Copy)]
struct Session {
    start: u64,
    last: u64,
    epoch: u64,
}

fn store_refusal(e: StoreError) -> Refusal {
    match e {
        StoreError::Declined => Refusal::Declined,
        StoreError::NoKey => Refusal::NoIdentity,
        StoreError::Unavailable(_) => Refusal::Unavailable,
    }
}

impl<S: KeyStore, C: Clock> Agent<S, C> {
    pub fn new(store: S, clock: C, policy: Policy, gate: Arc<LockGate>) -> Self {
        Agent { store, clock, policy, session: None, gate }
    }

    /// The key store, for the flows that mint keys (account setup) and for rigs.
    pub fn store_mut(&mut self) -> &mut S {
        &mut self.store
    }

    pub fn now_ms(&self) -> u64 {
        self.clock.now_ms()
    }

    /// This device's routine public key, if the store holds one.
    pub fn device_pub(&self) -> Result<Option<[u8; 65]>, Refusal> {
        self.store.public_key(&KeyRole::Device).map_err(store_refusal)
    }

    /// Whether the person could re-authenticate now, and the epoch to do it
    /// under. Take this BEFORE asking them. A locked screen is `Reauth` with
    /// nobody asked; with nothing listening for a lock, no answer could open a
    /// session, so it is `Unavailable`, again with nobody asked.
    pub fn reauth_ticket(&self) -> Result<u64, Refusal> {
        match self.gate.state() {
            GateState::Open(epoch) => Ok(epoch),
            GateState::Locked => Err(Refusal::Reauth),
            GateState::Unwatched => Err(Refusal::Unavailable),
        }
    }

    /// Open (or renew) the routine session under a ticket. False, and no
    /// session, if a lock came in since the ticket: a yes given across a lock or
    /// a sleep may not be from the person who is here now.
    pub fn begin_session_from(&mut self, ticket: u64) -> bool {
        if self.gate.state() != GateState::Open(ticket) {
            self.session = None;
            return false;
        }
        let now = self.clock.now_ms();
        self.session = Some(Session { start: now, last: now, epoch: ticket });
        true
    }

    /// `begin_session_from` for a host that has no prompt to span.
    pub fn begin_session(&mut self) -> bool {
        match self.reauth_ticket() {
            Ok(t) => self.begin_session_from(t),
            Err(_) => false,
        }
    }

    /// Lock: idle lock, sleep, session lock. Routine signing is refused after.
    /// The OS watcher reaches the same gate directly, since it must not wait for
    /// the host's lock on this agent.
    pub fn lock(&mut self) {
        self.session = None;
        self.gate.lock();
    }

    /// A session ENDS AT the idle or overall limit, not after it (>=; security's
    /// cross-host ruling, matching Android): at exactly `idle_ms` of idleness or
    /// `overall_ms` of age the session is gone.
    fn session_live(&mut self) -> bool {
        let now = self.clock.now_ms();
        match self.session {
            // The OS locked, slept or stopped telling us since this session began.
            Some(s) if self.gate.state() != GateState::Open(s.epoch) => {
                self.session = None;
                false
            }
            // A clock that moved BACKWARDS (before the session began or before its last use) would
            // stretch both limits: the session ends instead (security: iOS finding, as Android does).
            Some(Session { start, last, .. }) if now < last || now < start => {
                self.session = None;
                false
            }
            Some(Session { start, last, .. })
                if now.saturating_sub(last) < self.policy.idle_ms && now.saturating_sub(start) < self.policy.overall_ms =>
            {
                true
            }
            _ => {
                self.session = None;
                false
            }
        }
    }

    /// K1 `sign(purpose, payload)`.
    pub fn sign(&mut self, caller: &Caller, purpose: &str, payload: &str) -> Result<Signed, Refusal> {
        if !caller.verified {
            return Err(Refusal::Unavailable);
        }
        if !st::payload_matches_purpose(purpose, payload) {
            return Err(Refusal::Purpose);
        }
        if !ROUTINE.contains(&purpose) {
            // invite/revoke are signed by the room's OWNER key (the relay's `o`),
            // which in phase 1 lives in the document and is signed by the kernel
            // directly. No phase-1 agent holds an owner key, so it refuses
            // (kernel, 2026-10-18). Phase 2: the owner key moves into the agent,
            // signs after the host's prompt, and a cns. travels beside it.
            return Err(Refusal::Unavailable);
        }
        let pub_key = self.store.public_key(&KeyRole::Device).map_err(store_refusal)?.ok_or(Refusal::NoIdentity)?;
        if !self.session_live() {
            return Err(Refusal::Reauth);
        }
        let raw = self.store.sign(&KeyRole::Device, payload.as_bytes(), None).map_err(store_refusal)?;
        let now = self.clock.now_ms();
        if let Some(s) = &mut self.session {
            s.last = now;
        }
        Ok(Signed { sig: b64u::enc(&st::low_s(&raw)), pub_key: b64u::enc(&pub_key) })
    }

    /// A host-stamped consent (`cns.`) for `statement`, bound to the
    /// directory's single-use `challenge`. The page chooses neither the rp, the
    /// audience, the docId nor the expiry. Prompts every time (consent key).
    pub fn consent(&mut self, caller: &Caller, purpose: &str, statement: &str, challenge: &str) -> Result<ConsentSigned, Refusal> {
        if !caller.verified {
            return Err(Refusal::Unavailable);
        }
        if !self.store.has_consent_key() {
            // AAL3 refused on a machine with no consent key; routed elsewhere (§2e (E)).
            return Err(Refusal::Unavailable);
        }
        let family = match purpose {
            "invite" => "inv.",
            "revoke" => "rev.",
            "link" => "dev.",
            "rotate" => "bind.",
            "unbind" => "del.",
            _ => return Err(Refusal::Purpose),
        };
        if !statement.starts_with(family) {
            return Err(Refusal::Purpose);
        }
        let doc_id = if matches!(purpose, "invite" | "revoke") {
            match caller.doc_id.as_deref() {
                Some(d) if st::is_doc_id(d) => Some(d.to_string()),
                _ => return Err(Refusal::Purpose),
            }
        } else {
            None
        };
        let transcript = st::consent_transcript(AUDIENCE, challenge, statement).ok_or(Refusal::Purpose)?;
        let consent_pub =
            self.store.public_key(&KeyRole::Consent).map_err(store_refusal)?.ok_or(Refusal::NoIdentity)?;
        let cns = st::build_consent(&st::Consent {
            rp: RP.into(),
            purpose: purpose.into(),
            doc_id: doc_id.clone(),
            transcript,
            exp: self.clock.now_ms() + CONSENT_TTL_MS,
        });
        let prompt = Prompt { purpose: purpose.into(), doc_id };
        let raw = self.store.sign(&KeyRole::Consent, cns.as_bytes(), Some(&prompt)).map_err(store_refusal)?;
        Ok(ConsentSigned { cns, sig: b64u::enc(&st::low_s(&raw)), consent_pub: b64u::enc(&consent_pub) })
    }
}

// ----------------------------------------------------------------- test store

/// An in-memory software store. TESTS ONLY: it holds private keys in process
/// memory, which no shipped path may do (security §26).
#[cfg(any(test, feature = "test-store"))]
pub mod memory {
    use super::*;
    use p256::ecdsa::{signature::Signer, Signature, SigningKey};
    use std::collections::HashMap;

    #[derive(Default)]
    pub struct MemoryStore {
        pub keys: HashMap<String, SigningKey>,
        /// what the next prompted signature answers
        pub decline: bool,
        pub prompts: Vec<Prompt>,
        pub consent_capable: bool,
    }
    fn k(role: &KeyRole) -> String {
        format!("{role:?}")
    }
    impl MemoryStore {
        pub fn with_keys() -> Self {
            let mut s = MemoryStore { consent_capable: true, ..Default::default() };
            for (i, r) in [KeyRole::Account, KeyRole::Device, KeyRole::Consent].iter().enumerate() {
                s.keys.insert(k(r), SigningKey::from_slice(&[i as u8 + 11; 32]).unwrap());
            }
            s
        }
    }
    impl KeyStore for MemoryStore {
        fn public_key(&self, role: &KeyRole) -> Result<Option<[u8; 65]>, StoreError> {
            Ok(self.keys.get(&k(role)).map(|s| s.verifying_key().to_sec1_point(false).as_bytes().try_into().unwrap()))
        }
        fn sign(&mut self, role: &KeyRole, msg: &[u8], prompt: Option<&Prompt>) -> Result<[u8; 64], StoreError> {
            if let Some(p) = prompt {
                self.prompts.push(p.clone());
                if self.decline {
                    return Err(StoreError::Declined);
                }
            }
            let key = self.keys.get(&k(role)).ok_or(StoreError::NoKey)?;
            let sig: Signature = key.sign(msg);
            Ok(sig.to_bytes().into())
        }
        fn has_consent_key(&self) -> bool {
            self.consent_capable
        }
    }
}

#[cfg(test)]
mod tests {
    use super::memory::MemoryStore;
    use super::*;
    use std::cell::Cell;
    use std::rc::Rc;

    #[derive(Clone)]
    struct FakeClock(Rc<Cell<u64>>);
    impl Clock for FakeClock {
        fn now_ms(&self) -> u64 {
            self.0.get()
        }
    }
    fn agent() -> (Agent<MemoryStore, FakeClock>, Rc<Cell<u64>>) {
        let t = Rc::new(Cell::new(1_800_000_000_000));
        let gate = LockGate::new();
        gate.watched(false);
        (Agent::new(MemoryStore::with_keys(), FakeClock(t.clone()), Policy::default(), gate), t)
    }
    const OK: Caller = Caller { verified: true, doc_id: None };
    fn frame() -> String {
        format!("{}.{}", b64u::enc(&[1; 12]), b64u::enc(&[2; 32]))
    }

    #[test]
    fn routine_sign_low_s_and_verifies() {
        let (mut a, _) = agent();
        a.begin_session();
        let p = frame();
        let s = a.sign(&OK, "frame", &p).unwrap();
        assert!(st::verify_statement_sig(&s.pub_key, &s.sig, &p));
    }

    #[test]
    fn timers_gate_the_key_idle_and_overall() {
        let (mut a, t) = agent();
        assert_eq!(a.sign(&OK, "frame", &frame()), Err(Refusal::Reauth), "no session yet");
        a.begin_session();
        t.set(t.get() + 60 * 60_000 + 1);
        assert_eq!(a.sign(&OK, "frame", &frame()), Err(Refusal::Reauth), "idle > 1 h");
        // the boundary rows: ONE ms under the idle limit still signs, exactly AT it does not
        a.begin_session();
        t.set(t.get() + 60 * 60_000 - 1);
        assert!(a.sign(&OK, "frame", &frame()).is_ok(), "idle 1 ms under the limit");
        t.set(t.get() + 60 * 60_000);
        assert_eq!(a.sign(&OK, "frame", &frame()), Err(Refusal::Reauth), "idle exactly AT the limit ends the session");
        a.begin_session();
        // keep it busy every 30 min for 24 h: never idle, but past overall
        for _ in 0..47 {
            t.set(t.get() + 30 * 60_000);
            assert!(a.sign(&OK, "frame", &frame()).is_ok());
        }
        t.set(t.get() + 30 * 60_000 - 1);
        assert!(a.sign(&OK, "frame", &frame()).is_ok(), "overall 1 ms under 24 h");
        t.set(t.get() + 1);
        assert_eq!(a.sign(&OK, "frame", &frame()), Err(Refusal::Reauth), "overall exactly AT 24 h ends the session");
        // a clock moved backwards ends the session, by however little, and stays ended
        a.begin_session();
        t.set(t.get() + 10 * 60_000);
        assert!(a.sign(&OK, "frame", &frame()).is_ok());
        t.set(t.get() - 1);
        assert_eq!(a.sign(&OK, "frame", &frame()), Err(Refusal::Reauth), "clock 1 ms before the last use");
        t.set(t.get() + 5 * 60_000);
        assert_eq!(a.sign(&OK, "frame", &frame()), Err(Refusal::Reauth), "and the session does not come back");
        // control: the same steps with the clock moving forward keep signing
        a.begin_session();
        t.set(t.get() + 10 * 60_000);
        assert!(a.sign(&OK, "frame", &frame()).is_ok());
        t.set(t.get() + 1);
        assert!(a.sign(&OK, "frame", &frame()).is_ok(), "control: forward is fine");
        a.begin_session();
        a.lock();
        assert_eq!(a.sign(&OK, "frame", &frame()), Err(Refusal::Reauth), "locked");
    }

    fn gated() -> (Agent<MemoryStore, FakeClock>, Arc<LockGate>) {
        let (a, _) = agent();
        let g = a.gate.clone();
        (a, g)
    }

    #[test]
    fn the_os_ends_a_session_without_touching_the_agent() {
        let (mut a, g) = gated();
        assert!(a.begin_session());
        assert!(a.sign(&OK, "frame", &frame()).is_ok(), "control: signs while nothing has happened");
        g.lock();
        assert_eq!(a.sign(&OK, "frame", &frame()), Err(Refusal::Reauth), "Lock or PrepareForSleep");
        assert!(a.begin_session());
        g.set_locked(true);
        assert_eq!(a.sign(&OK, "frame", &frame()), Err(Refusal::Reauth), "LockedHint");
        g.set_locked(false);
        assert_eq!(a.sign(&OK, "frame", &frame()), Err(Refusal::Reauth), "an unlock opens nothing");
        assert!(a.begin_session());
        g.lost();
        g.watched(false);
        assert_eq!(a.sign(&OK, "frame", &frame()), Err(Refusal::Reauth), "the watcher came back: the session did not");
    }

    #[test]
    fn no_session_opens_while_locked_or_unwatched() {
        let (mut a, g) = gated();
        g.set_locked(true);
        assert!(!a.begin_session());
        assert_eq!(a.reauth_ticket(), Err(Refusal::Reauth));
        g.lost();
        assert!(!a.begin_session());
        assert_eq!(a.reauth_ticket(), Err(Refusal::Unavailable));
        assert_eq!(a.sign(&OK, "frame", &frame()), Err(Refusal::Reauth));
        g.watched(false);
        assert!(a.begin_session(), "control: open again once the OS is back");
    }

    #[test]
    fn a_yes_that_spans_a_lock_opens_nothing() {
        let (mut a, g) = gated();
        let t = a.reauth_ticket().unwrap();
        g.lock();
        assert!(!a.begin_session_from(t));
        assert_eq!(a.sign(&OK, "frame", &frame()), Err(Refusal::Reauth));
        assert!(a.begin_session_from(a.reauth_ticket().unwrap()), "control: a fresh ticket works");
    }

    #[test]
    fn purpose_and_caller_gates() {
        let (mut a, _) = agent();
        a.begin_session();
        assert_eq!(a.sign(&OK, "frame", "live"), Err(Refusal::Purpose), "a show payload is not a frame");
        assert_eq!(a.sign(&OK, "show", "live").map(|_| ()), Ok(()));
        assert_eq!(a.sign(&Caller { verified: false, doc_id: None }, "show", "live"), Err(Refusal::Unavailable));
        // invite/revoke: the owner key's job (the kernel, phase 1), never the agent's
        let rev_pub = a.store.public_key(&KeyRole::Device).unwrap().unwrap();
        assert_eq!(a.sign(&OK, "revoke", &format!("rev.{}", b64u::enc(&rev_pub))), Err(Refusal::Unavailable));
    }

    #[test]
    fn consent_is_host_stamped_and_verifies_under_k2() {
        let (mut a, t) = agent();
        let challenge = b64u::enc(&[9u8; 24]);
        let caller = Caller { verified: true, doc_id: Some("doc-lq3k9z-8f2h1x".into()) };
        let dev_pub = b64u::enc(&a.store.public_key(&KeyRole::Device).unwrap().unwrap());
        let statement = format!("rev.{dev_pub}");
        let c = a.consent(&caller, "revoke", &statement, &challenge).unwrap();
        assert_eq!(a.store.prompts.len(), 1, "the consent key prompted");
        let check = st::ConsentCheck {
            consent_pub: &c.consent_pub,
            rp: RP,
            audience: AUDIENCE,
            challenge: &challenge,
            payload_text: &statement,
            doc_id: Some("doc-lq3k9z-8f2h1x"),
            now: t.get(),
        };
        assert!(st::verify_consent(&c.cns, &c.sig, &check, |_| true).is_ok(), "{}", c.cns);
        // relayed to a room audience: refused
        let room = format!("room:w{}", "A".repeat(43));
        let relayed = st::ConsentCheck { audience: &room, ..check };
        assert_eq!(st::verify_consent(&c.cns, &c.sig, &relayed, |_| true).unwrap_err(), "transcript");
        // a different document: refused
        let other = st::ConsentCheck { doc_id: Some("another-doc"), audience: AUDIENCE, ..relayed };
        assert_eq!(st::verify_consent(&c.cns, &c.sig, &other, |_| true).unwrap_err(), "docid");
    }

    #[test]
    fn consent_refusals() {
        let (mut a, _) = agent();
        let ch = b64u::enc(&[9u8; 24]);
        let doc = Caller { verified: true, doc_id: Some("d1".into()) };
        assert_eq!(a.consent(&doc, "grant", "inv.x", &ch).unwrap_err(), Refusal::Purpose, "reserved purpose");
        assert_eq!(a.consent(&doc, "revoke", "inv.x", &ch).unwrap_err(), Refusal::Purpose, "wrong family");
        assert_eq!(a.consent(&OK, "revoke", "rev.x", &ch).unwrap_err(), Refusal::Purpose, "doc-scoped without a docId");
        assert_eq!(a.consent(&doc, "revoke", "rev.x", "short").unwrap_err(), Refusal::Purpose, "challenge under 16 bytes");
        a.store.decline = true;
        assert_eq!(a.consent(&doc, "revoke", "rev.x", &ch).unwrap_err(), Refusal::Declined);
        a.store.consent_capable = false;
        assert_eq!(a.consent(&doc, "revoke", "rev.x", &ch).unwrap_err(), Refusal::Unavailable, "no consent key: AAL3 refused");
    }
}
