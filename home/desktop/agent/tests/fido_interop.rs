// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The PRF interop rig (security §34): ONE credential on ONE authenticator (the
// test-only virtual OpenSK key), the same PRF input through an INDEPENDENT
// WebAuthn client (python-fido2, which applies the PRF transform itself, as a
// browser does) and through the agent's libfido2 layer. The two outputs must be
// byte-equal, or a blob made on the web could never be opened here.
//
// Mutants (run by fido-rig.sh, each must FAIL this test): the agent built with
// `rig-mutant-double-hash` or `rig-mutant-raw-hash`.
#![cfg(all(target_os = "linux", feature = "fido"))]

use bento_id_agent::fido_linux;
use bento_id_agent::webauthn::PRF_INPUT;

#[test]
fn agent_prf_equals_an_independent_webauthn_client_on_the_same_credential() {
    let path = std::env::var("BENTO_FIDO_RIG").expect("BENTO_FIDO_RIG (the python-fido2 result file) is required");
    let rig: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(rig["prfInput"].as_str().unwrap().as_bytes(), PRF_INPUT, "both sides evaluate the same PRF input");
    let want = rig["prf"].as_str().unwrap();
    let got = fido_linux::get_assertion(
        rig["device"].as_str().unwrap(),
        "bento.page",
        &[7u8; 32],
        PRF_INPUT,
        Some(rig["pin"].as_str().unwrap()),
    )
    .expect("assertion through libfido2");
    assert_eq!(got.len(), 1, "one discoverable credential for bento.page");
    let hex: String = got[0].prf.iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(hex, want, "the agent's PRF output equals the independent WebAuthn client's");
    assert_eq!(got[0].client_data_json.contains("\"origin\":\"bento-desktop:linux\""), true);
}
