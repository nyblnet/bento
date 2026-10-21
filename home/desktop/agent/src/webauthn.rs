// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The native WebAuthn/PRF ceremony's pure parts (H1d, identity-design §2f).
//
// A desktop agent talks to authenticators BELOW the WebAuthn API (CTAP via
// libfido2 on Linux; webauthn.dll on Windows builds clientData itself too), so
// it must reproduce two things a browser does internally, byte for byte, or a
// passkey's blob made in a browser could never be opened here:
//   - the PRF extension → CTAP hmac-secret salt mapping (WebAuthn L3 §10.1.4):
//     salt = SHA-256(UTF-8("WebAuthn PRF") ‖ 0x00 ‖ input);
//   - clientDataJSON, serialised the way the spec's "limited verification"
//     algorithm expects: type, challenge, origin, crossOrigin, in that order,
//     with the spec's CCDToString string escaping.

use crate::b64u;
use sha2::{Digest, Sha256};

/// The fixed PRF input of the account-key blobs (§2f).
pub const PRF_INPUT: &[u8] = b"bento/id/prf/v1";

/// The CTAP2 hmac-secret salt for a WebAuthn PRF input.
pub fn prf_salt(input: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"WebAuthn PRF");
    h.update([0u8]);
    h.update(input);
    h.finalize().into()
}

/// WebAuthn CCDToString: a JSON string with only `"`, `\` and C0 controls
/// escaped (as \uXXXX, lower-case hex, except none of the short forms).
fn ccd_to_string(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\u0022"),
            '\\' => out.push_str("\\u005c"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Where this agent runs. The origin it declares is self-asserted (a native
/// app builds clientDataJSON itself), so it is DISTINCT from every web origin
/// and never `https://bento.page`: on the web the browser vouches for the
/// origin, which is where phishing resistance comes from (security §33). The
/// directory allow-lists these exact strings and names the platform in the
/// fetch notice as self-reported.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Linux,
    Windows,
}
impl Platform {
    pub fn origin(self) -> &'static str {
        match self {
            Platform::Linux => "bento-desktop:linux",
            Platform::Windows => "bento-desktop:windows",
        }
    }
    pub fn current() -> Platform {
        if cfg!(windows) { Platform::Windows } else { Platform::Linux }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ceremony {
    /// navigator.credentials.create
    Create,
    /// navigator.credentials.get
    Get,
}

/// clientDataJSON, serialised in the spec's order: type, challenge, origin,
/// crossOrigin (false). No topOrigin. `challenge` is the raw challenge bytes,
/// emitted as exact base64url.
pub fn client_data(ceremony: Ceremony, challenge: &[u8], platform: Platform) -> String {
    let ty = match ceremony {
        Ceremony::Create => "webauthn.create",
        Ceremony::Get => "webauthn.get",
    };
    format!(
        "{{\"type\":\"{ty}\",\"challenge\":{},\"origin\":{},\"crossOrigin\":false}}",
        ccd_to_string(&b64u::enc(challenge)),
        ccd_to_string(platform.origin())
    )
}

/// What the authenticator signs over: SHA-256(clientDataJSON).
pub fn client_data_hash(client_data_json: &str) -> [u8; 32] {
    Sha256::digest(client_data_json.as_bytes()).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prf_salt_is_the_webauthn_l3_mapping() {
        // Independent recomputation of the spec's definition, so a forgotten
        // 0x00 separator or a raw-input salt fails here.
        let mut h = Sha256::new();
        h.update(b"WebAuthn PRF\x00bento/id/prf/v1");
        let want: [u8; 32] = h.finalize().into();
        assert_eq!(prf_salt(PRF_INPUT), want);
        assert_ne!(prf_salt(PRF_INPUT), <[u8; 32]>::from(Sha256::digest(PRF_INPUT)), "not the raw input's hash");
        // pinned, so an accidental change to the construction is visible
        assert_eq!(
            prf_salt(PRF_INPUT).iter().map(|b| format!("{b:02x}")).collect::<String>(),
            "f99670d5db28529b25c8a9ec469959b60006b8d6625066cc77f075dab7ea3b77"
        );
    }

    #[test]
    fn client_data_exact_bytes_per_platform() {
        // security §33's rig rows: exact bytes for each platform and ceremony.
        let ch = [1u8, 2, 3];
        assert_eq!(client_data(Ceremony::Get, &ch, Platform::Linux),
            r#"{"type":"webauthn.get","challenge":"AQID","origin":"bento-desktop:linux","crossOrigin":false}"#);
        assert_eq!(client_data(Ceremony::Get, &ch, Platform::Windows),
            r#"{"type":"webauthn.get","challenge":"AQID","origin":"bento-desktop:windows","crossOrigin":false}"#);
        assert_eq!(client_data(Ceremony::Create, &ch, Platform::Linux),
            r#"{"type":"webauthn.create","challenge":"AQID","origin":"bento-desktop:linux","crossOrigin":false}"#);
        for p in [Platform::Linux, Platform::Windows] {
            let cd = client_data(Ceremony::Get, &ch, p);
            assert!(!cd.contains("https://bento.page") && !cd.contains("topOrigin"), "{cd}");
            let v: serde_json::Value = serde_json::from_str(&cd).unwrap();
            assert_eq!(v["crossOrigin"], false);
        }
    }

    #[test]
    fn ccd_escaping_matches_the_spec_and_stays_valid_json() {
        let s = ccd_to_string("a\"b\\c\u{1}");
        assert_eq!(s, r#""a\u0022b\u005cc\u0001""#);
        let back: String = serde_json::from_str(&s).unwrap();
        assert_eq!(back, "a\"b\\c\u{1}");
    }
}
