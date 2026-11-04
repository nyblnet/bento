// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// H1b rigs: the Linux TPM key store against a real TPM 2.0 (swtpm in CI and
// development). Run with the `tpm` feature and BENTO_TPM_TCTI (the TPM under
// test) and BENTO_TPM_TCTI_OTHER (a SECOND, unrelated TPM, for the copy-off rig).
// Missing env is a FAILURE, never a skip.
#![cfg(all(target_os = "linux", feature = "tpm"))]

use bento_id_agent::agent::{Agent, Caller, Clock, KeyRole, KeyStore, Policy, Prompt, StoreError};
use bento_id_agent::tpm_linux::{PinPrompt, TpmStore};
use bento_id_agent::{b64u, statements as st};
use std::sync::{Arc, Mutex};
use zeroize::Zeroizing;

fn tcti(var: &str) -> String {
    std::env::var(var).unwrap_or_else(|_| panic!("{var} is required for the TPM rigs"))
}
fn dir(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("bento-tpm-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    d
}
/// A PIN prompt that answers from a queue and records every prompt it was shown.
fn pins(answers: Vec<Option<&str>>, seen: Arc<Mutex<Vec<Prompt>>>) -> PinPrompt {
    let q = Mutex::new(answers.into_iter().map(|a| a.map(|s| s.to_string())).collect::<Vec<_>>());
    Box::new(move |p: &Prompt| {
        seen.lock().unwrap().push(p.clone());
        let mut q = q.lock().unwrap();
        if q.is_empty() { None } else { q.remove(0).map(Zeroizing::new) }
    })
}
struct Now;
impl Clock for Now {
    fn now_ms(&self) -> u64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64
    }
}
const PIN: &str = "4711-bento";

#[test]
fn routine_key_signs_in_the_tpm_and_verifies_under_k2() {
    let d = dir("routine");
    let mut s = TpmStore::open(&tcti("BENTO_TPM_TCTI"), d, pins(vec![], Default::default())).unwrap();
    let pubk = s.create_signing_key(&KeyRole::Device, None).unwrap();
    let pub_b64 = b64u::enc(&pubk);
    for i in 0..8 {
        let text = format!("{}.{}", b64u::enc(&[i; 12]), b64u::enc(&[i; 40]));
        let raw = s.sign(&KeyRole::Device, text.as_bytes(), None).unwrap();
        let sig = b64u::enc(&st::low_s(&raw));
        assert!(st::verify_statement_sig(&pub_b64, &sig, &text), "TPM signature {i} verifies (low-S folded)");
    }
}

#[test]
fn consent_key_needs_the_pin_every_time() {
    let d = dir("consent");
    let seen = Arc::new(Mutex::new(vec![]));
    let mut s = TpmStore::open(&tcti("BENTO_TPM_TCTI"), d,
        pins(vec![Some("wrong-pin"), None, Some(PIN), Some(PIN)], seen.clone())).unwrap();
    s.create_signing_key(&KeyRole::Consent, Some(PIN)).unwrap();
    let p = Prompt { purpose: "revoke".into(), doc_id: Some("d1".into()) };
    assert_eq!(s.sign(&KeyRole::Consent, b"x", Some(&p)), Err(StoreError::Declined), "a wrong PIN is refused by the TPM");
    assert_eq!(s.sign(&KeyRole::Consent, b"x", Some(&p)), Err(StoreError::Declined), "a declined prompt signs nothing");
    assert!(s.sign(&KeyRole::Consent, b"x", Some(&p)).is_ok(), "the right PIN signs");
    assert!(s.sign(&KeyRole::Consent, b"y", Some(&p)).is_ok(), "and again: one PIN per signature");
    assert_eq!(seen.lock().unwrap().len(), 4, "every consent signature prompted");
    assert!(s.sign(&KeyRole::Consent, b"x", None).is_err(), "no prompt, no consent signature");
}

#[test]
fn agent_consent_on_the_tpm_verifies_under_k2() {
    let d = dir("agent");
    let mut s = TpmStore::open(&tcti("BENTO_TPM_TCTI"), d, pins(vec![Some(PIN)], Default::default())).unwrap();
    let dev = s.create_signing_key(&KeyRole::Device, None).unwrap();
    s.create_signing_key(&KeyRole::Consent, Some(PIN)).unwrap();
    let mut a = Agent::new(s, Now, Policy::default(), { let g = bento_id_agent::lockgate::LockGate::new(); g.watched(false); g });
    let caller = Caller { verified: true, doc_id: Some("doc-lq3k9z-8f2h1x".into()) };
    let challenge = b64u::enc(&[5u8; 32]);
    let statement = format!("rev.{}", b64u::enc(&dev));
    let c = a.consent(&caller, "revoke", &statement, &challenge).unwrap();
    let check = st::ConsentCheck {
        consent_pub: &c.consent_pub, rp: "bento", audience: "dir", challenge: &challenge,
        payload_text: &statement, doc_id: Some("doc-lq3k9z-8f2h1x"), now: Now.now_ms(),
    };
    assert!(st::verify_consent(&c.cns, &c.sig, &check, |_| true).is_ok(), "{}", c.cns);
    // routine signing through the agent, inside a session
    a.begin_session();
    let r = a.sign(&caller, "show", "live").unwrap();
    assert!(st::verify_statement_sig(&r.pub_key, &r.sig, "live"));
}

#[test]
fn sealed_account_key_unseals_only_with_the_pin() {
    let d = dir("account");
    let mut s = TpmStore::open(&tcti("BENTO_TPM_TCTI"), d,
        pins(vec![Some("nope"), Some(PIN)], Default::default())).unwrap();
    let secret = [0x5au8; 32];
    s.seal_account(&secret, PIN).unwrap();
    let p = Prompt { purpose: "link".into(), doc_id: None };
    assert!(matches!(s.unseal_account(&p), Err(StoreError::Declined)), "wrong PIN refused");
    assert_eq!(&s.unseal_account(&p).unwrap()[..], &secret[..], "right PIN unseals");
    assert_eq!(s.public_key(&KeyRole::Account).unwrap(), None, "the account key has no TPM public point");
}

#[test]
fn key_files_are_useless_on_another_tpm() {
    // "Cannot be copied off the machine": the stored blobs are TPM-wrapped, so a
    // second, unrelated TPM given the very same files cannot load them.
    let d = dir("copyoff");
    let mut a = TpmStore::open(&tcti("BENTO_TPM_TCTI"), d.clone(), pins(vec![], Default::default())).unwrap();
    a.create_signing_key(&KeyRole::Device, None).unwrap();
    assert!(a.sign(&KeyRole::Device, b"m", None).is_ok(), "control: it signs on its own TPM");
    let mut b = TpmStore::open(&tcti("BENTO_TPM_TCTI_OTHER"), d, pins(vec![], Default::default())).unwrap();
    let r = b.sign(&KeyRole::Device, b"m", None);
    assert!(matches!(r, Err(StoreError::Unavailable(_))), "another TPM cannot use the copied files: {r:?}");
}

#[test]
fn a_second_connection_cannot_use_consent_or_account_without_the_pin() {
    // Stand-in for "a second same-user process": a fresh connection to the same
    // TPM over the same files, whose prompt answers nothing. The routine key
    // stays usable — the accepted DESKTOP residual (security), asserted so it
    // stays visible rather than assumed.
    let d = dir("second");
    let mut first = TpmStore::open(&tcti("BENTO_TPM_TCTI"), d.clone(), pins(vec![], Default::default())).unwrap();
    first.create_signing_key(&KeyRole::Device, None).unwrap();
    first.create_signing_key(&KeyRole::Consent, Some(PIN)).unwrap();
    first.seal_account(&[7u8; 32], PIN).unwrap();
    drop(first);
    let mut other = TpmStore::open(&tcti("BENTO_TPM_TCTI"), d, pins(vec![None, None], Default::default())).unwrap();
    let p = Prompt { purpose: "link".into(), doc_id: None };
    assert_eq!(other.sign(&KeyRole::Consent, b"x", Some(&p)), Err(StoreError::Declined), "consent key: no PIN, no signature");
    assert!(matches!(other.unseal_account(&p), Err(StoreError::Declined)), "account key: no PIN, no key");
    assert!(other.sign(&KeyRole::Device, b"x", None).is_ok(), "RESIDUAL: the routine key signs without a prompt");
}
