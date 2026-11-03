// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The no-TPM Linux store against a real Secret Service (gnome-keyring under a
// D-Bus session, as at login). Run via keyring-rig.sh. The EXPOSURE is
// asserted, not hidden: once the keyring is unlocked, a second connection reads
// the account key with no prompt.
#![cfg(all(target_os = "linux", feature = "keyring"))]

use bento_id_agent::agent::{Agent, Caller, Clock, KeyRole, KeyStore, Policy, Refusal};
use bento_id_agent::secret_linux::SecretStore;
use bento_id_agent::{b64u, statements as st};

struct Now;
impl Clock for Now {
    fn now_ms(&self) -> u64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64
    }
}
fn profile(tag: &str) -> String {
    format!("rig-{tag}-{}", std::process::id())
}

#[test]
fn routine_key_signs_and_verifies() {
    let mut s = SecretStore::open(&profile("routine")).unwrap();
    let pubk = b64u::enc(&s.create_device_key().unwrap());
    assert_eq!(s.public_key(&KeyRole::Device).unwrap().map(|p| b64u::enc(&p)), Some(pubk.clone()));
    let raw = s.sign(&KeyRole::Device, b"live", None).unwrap();
    assert!(st::verify_statement_sig(&pubk, &b64u::enc(&st::low_s(&raw)), "live"));
    s.wipe().unwrap();
    assert_eq!(s.public_key(&KeyRole::Device).unwrap(), None, "wipe removes the key");
}

#[test]
fn no_consent_key_so_aal3_is_refused() {
    let s = SecretStore::open(&profile("aal3")).unwrap();
    s.create_device_key().unwrap();
    assert!(!s.has_consent_key());
    let mut a = Agent::new(s, Now, Policy::default());
    let caller = Caller { verified: true, doc_id: Some("d1".into()) };
    let r = a.consent(&caller, "revoke", "rev.x", &b64u::enc(&[1u8; 24]));
    assert_eq!(r.unwrap_err(), Refusal::Unavailable, "no consent key on a no-TPM machine: AAL3 refused");
    a.begin_session();
    assert!(a.sign(&caller, "show", "live").is_ok(), "routine signing still works");
}

#[test]
fn stated_exposure_a_second_connection_reads_the_account_key_without_a_prompt() {
    let p = profile("exposure");
    let first = SecretStore::open(&p).unwrap();
    first.store_account(&[9u8; 32]).unwrap();
    drop(first);
    let other = SecretStore::open(&p).unwrap();
    assert_eq!(&other.account().unwrap()[..], &[9u8; 32][..], "RESIDUAL (stated): readable by any same-user process");
    other.wipe().unwrap();
    assert!(other.account().is_err());
}

#[test]
fn wipe_with_a_locked_keyring_never_reports_success_while_keys_remain() {
    // Security, #779 review: wipe() used to delete only UNLOCKED items, so with
    // a locked keyring every key survived and wipe still returned Ok.
    let s = SecretStore::open(&profile("locked")).unwrap();
    s.create_device_key().unwrap();
    s.store_account(&[3u8; 32]).unwrap();
    assert_eq!(s.count_items().unwrap(), 2);
    // Lock the default collection (test-only): the Secret Service's own Lock
    // method over D-Bus, on the default alias the store writes to.
    let st = std::process::Command::new("gdbus")
        .args(["call", "--session", "--dest", "org.freedesktop.secrets", "--object-path", "/org/freedesktop/secrets",
               "--method", "org.freedesktop.Secret.Service.Lock", "[\"/org/freedesktop/secrets/aliases/default\"]"])
        .status()
        .unwrap();
    assert!(st.success(), "Secret Service Lock");
    match s.wipe() {
        // either it unlocked and removed everything…
        Ok(()) => assert_eq!(s.count_items().unwrap(), 0, "wipe said Ok, so nothing may remain"),
        // …or it refused to claim success; then the keys are still there, and
        // the caller knows the wipe did not happen.
        Err(e) => {
            eprintln!("wipe refused on a locked keyring: {e:?}");
            assert!(s.count_items().unwrap() > 0, "an Err means keys remain");
        }
    }
}
