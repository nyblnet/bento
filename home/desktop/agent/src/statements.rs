// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// bento/connect — the signed statements, a port of kernel/src/statements.ts.
//
// The family rules (from the reference, unchanged): dot-joined printable-ASCII
// text signed over its EXACT bytes; every field is a closed dot-free token or
// base64url free text; split on '.', KEEP empty fields, require the exact
// count; times are epoch milliseconds; keys are raw uncompressed P-256 points;
// signatures are raw r‖s, LOW-S, base64url — never DER.
//
// Every check runs in the reference's ORDER, so a refused row is refused for
// the same reason the reference gives. The vectors compare reasons too.

use crate::{address, b64u};
use p256::ecdsa::{signature::Verifier, Signature, VerifyingKey};
use p256::elliptic_curve::PrimeField;
use sha2::{Digest, Sha256};
use std::collections::HashMap;

pub type Verdict<T> = Result<T, &'static str>;

// --- free text ---------------------------------------------------------------

/// base64url-of-UTF-8 → text, canonical both ways.
fn free_text(f: &str) -> Option<String> {
    let b = b64u::dec(f)?;
    let t = String::from_utf8(b).ok()?;
    (b64u::enc(t.as_bytes()) == f).then_some(t)
}

const MAX_DISPLAY: usize = 64;

pub use crate::display_table::{DISPLAY_FORBIDDEN_RANGES, UNICODE as DISPLAY_UNICODE};

/// statements.ts displayForbidden: the frozen ranges (display_table.rs,
/// generated from the fixture), binary-searched like the reference.
fn display_forbidden(c: char) -> bool {
    let cp = c as u32;
    DISPLAY_FORBIDDEN_RANGES
        .binary_search_by(|&(a, b)| {
            if cp < a {
                std::cmp::Ordering::Greater
            } else if cp > b {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Equal
            }
        })
        .is_ok()
}
fn is_joiner(c: char) -> bool {
    matches!(c, '\u{200C}' | '\u{200D}')
}

/// A name or device label a person sees. `[...t].length` in JS counts code
/// points (`chars().count()`); the text must already be NFC.
fn display_text(f: &str) -> Option<String> {
    use unicode_normalization::UnicodeNormalization;
    let t = free_text(f)?;
    if t.is_empty() || t.chars().count() > MAX_DISPLAY {
        return None;
    }
    if t.nfc().collect::<String>() != t {
        return None;
    }
    if t.chars().any(display_forbidden)
        || t.chars().next().is_some_and(is_joiner)
        || t.chars().last().is_some_and(is_joiner)
    {
        return None;
    }
    Some(t)
}

pub fn sha256_b64u(text: &str) -> String {
    b64u::enc(&Sha256::digest(text.as_bytes()))
}

// --- keys and signatures ---------------------------------------------------------

/// The P-256 group order, big-endian.
const N: [u8; 32] = [
    0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xbc, 0xe6, 0xfa, 0xad, 0xa7, 0x17, 0x9e, 0x84, 0xf3, 0xb9, 0xca, 0xc2, 0xfc, 0x63, 0x25, 0x51,
];
/// N >> 1, big-endian.
const HALF_N: [u8; 32] = [
    0x7f, 0xff, 0xff, 0xff, 0x80, 0x00, 0x00, 0x00, 0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xde, 0x73, 0x7d, 0x56, 0xd3, 0x8b, 0xcf, 0x42, 0x79, 0xdc, 0xe5, 0x61, 0x7e, 0x31, 0x92, 0xa8,
];
const ZERO: [u8; 32] = [0; 32];

/// A raw r‖s signature in range, with s in the lower half (r, s > 0; r < N; s ≤ N/2).
/// Big-endian byte arrays of equal length compare like the integers they hold.
fn sig_in_range(sig: &[u8]) -> bool {
    if sig.len() != 64 {
        return false;
    }
    let (r, s) = (&sig[..32], &sig[32..]);
    r > &ZERO[..] && r < &N[..] && s > &ZERO[..] && s <= &HALF_N[..]
}

/// The low-S form of a raw r‖s signature: every signer must emit this.
pub fn low_s(sig: &[u8; 64]) -> [u8; 64] {
    if sig[32..] <= HALF_N[..] {
        return *sig;
    }
    let mut repr = p256::FieldBytes::default();
    repr.copy_from_slice(&sig[32..]);
    let s = p256::Scalar::from_repr(repr);
    let mut out = *sig;
    if bool::from(s.is_some()) {
        out[32..].copy_from_slice(&(-s.unwrap()).to_repr());
    }
    out
}

/// A raw uncompressed P-256 point that is actually on the curve. The same
/// check serves a signing key and a kx (ECDH) key: WebCrypto's importKey
/// accepts exactly the valid points for both.
fn point(b64: &str) -> Option<VerifyingKey> {
    let raw = b64u::dec(b64)?;
    if raw.len() != 65 || raw[0] != 0x04 {
        return None;
    }
    VerifyingKey::from_sec1_bytes(&raw).ok()
}
pub fn is_signing_key(b64: &str) -> bool {
    point(b64).is_some()
}
pub fn is_kx_key(b64: &str) -> bool {
    point(b64).is_some()
}

/// Verify `sig_b64` (raw r‖s, low-S) by `pub_b64` over the exact UTF-8 of `text`.
pub fn verify_statement_sig(pub_b64: &str, sig_b64: &str, text: &str) -> bool {
    let Some(sig) = b64u::dec(sig_b64) else { return false };
    if !sig_in_range(&sig) {
        return false;
    }
    let Some(key) = point(pub_b64) else { return false };
    let Ok(sig) = Signature::from_slice(&sig) else { return false };
    key.verify(text.as_bytes(), &sig).is_ok()
}

/// Sign `text`, emitting the low-S raw form base64url. For tests and software
/// keys; hardware key stores produce the same bytes and fold through `low_s`.
pub fn sign_statement(key: &p256::ecdsa::SigningKey, text: &str) -> String {
    use p256::ecdsa::signature::Signer;
    let sig: Signature = key.sign(text.as_bytes());
    let raw: [u8; 64] = sig.to_bytes().into();
    b64u::enc(&low_s(&raw))
}

// --- strict parsing --------------------------------------------------------------

const MAX_STATEMENT: usize = 4096;

/// Printable ASCII only, exact prefix and field count, empty fields kept.
/// `count` includes the prefix.
fn fields<'a>(text: &'a str, prefix: &str, count: usize) -> Option<Vec<&'a str>> {
    if text.is_empty() || text.len() > MAX_STATEMENT || !text.bytes().all(|c| (0x21..=0x7e).contains(&c)) {
        return None;
    }
    let parts: Vec<&str> = text.split('.').collect();
    (parts.len() == count && parts[0] == prefix).then_some(parts)
}

/// INT_RE ^(0|[1-9][0-9]{0,15})$, and a JS safe integer.
fn is_int_text(f: &str) -> bool {
    let b = f.as_bytes();
    f == "0" || (!b.is_empty() && b.len() <= 16 && b[0] != b'0' && b.iter().all(u8::is_ascii_digit))
}
fn int(f: &str) -> Option<u64> {
    if !is_int_text(f) {
        return None;
    }
    let n: u64 = f.parse().ok()?;
    (n <= (1u64 << 53) - 1).then_some(n)
}
fn ms(f: &str) -> Option<u64> {
    int(f).filter(|n| *n > 0)
}
fn is_hash(f: &str) -> bool {
    b64u::dec(f).map(|b| b.len() == 32).unwrap_or(false)
}

fn lower_digit(c: u8) -> bool {
    c.is_ascii_lowercase() || c.is_ascii_digit()
}
/// KID_RE ^[a-z0-9][a-z0-9-]{0,62}$
fn is_kid(f: &str) -> bool {
    let b = f.as_bytes();
    !b.is_empty() && b.len() <= 63 && lower_digit(b[0]) && b.iter().all(|c| lower_digit(*c) || *c == b'-')
}
/// RP_RE ^(bento|vault-[a-z0-9][a-z0-9-]{0,62})$
fn is_rp(f: &str) -> bool {
    f == "bento" || f.strip_prefix("vault-").map(is_kid).unwrap_or(false)
}
fn b64_char(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_' || c == b'-'
}
/// DOCID_RE ^[A-Za-z0-9_-]{1,128}$ (security §19i)
pub fn is_doc_id(f: &str) -> bool {
    (1..=128).contains(&f.len()) && f.bytes().all(b64_char)
}
/// ROOM_RE ^w[A-Za-z0-9_-]{43}$
fn is_room(f: &str) -> bool {
    f.len() == 44 && f.as_bytes()[0] == b'w' && f.bytes().all(b64_char)
}
/// CODE_RE ^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$
fn is_code(f: &str) -> bool {
    f.len() == 8 && f.bytes().all(|c| b"23456789ABCDEFGHJKMNPQRSTUVWXYZ".contains(&c))
}

pub const SKEW_MS: u64 = 5 * 60_000;
const DAY: u64 = 86_400_000;
/// 13 × 30.5 days + 1 = 397.5 days, exactly.
pub const CERT_MAX_MS: u64 = 397 * DAY + DAY / 2;

fn lifetime(created: u64, expires: u64, now: u64) -> Option<&'static str> {
    if expires <= created || expires - created > CERT_MAX_MS {
        return Some("lifetime");
    }
    if created > now + SKEW_MS {
        return Some("not-yet-valid");
    }
    if now >= expires {
        return Some("expired");
    }
    None
}

// --- kx placement (unruled: both slots empty) ------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KxMode {
    Unruled,
    A,
    B,
    C,
}
impl KxMode {
    pub fn parse(s: &str) -> Option<KxMode> {
        Some(match s {
            "unruled" => KxMode::Unruled,
            "A" => KxMode::A,
            "B" => KxMode::B,
            "C" => KxMode::C,
            _ => return None,
        })
    }
    /// (bind slot required, dev slot required)
    fn slots(self) -> (bool, bool) {
        match self {
            KxMode::Unruled => (false, false),
            KxMode::A => (true, false),
            KxMode::B => (false, true),
            KxMode::C => (true, true),
        }
    }
}
/// The mode this build runs in. The maintainer has not ruled (§6b), so both
/// slots must be empty and nothing accepts a placement nobody chose.
pub const KX_MODE: KxMode = KxMode::Unruled;

/// Ok(None) = empty and allowed; Ok(Some(kx)) = present and valid; Err = refuse.
fn kx_slot(f: &str, required: bool, others: &[&str]) -> Result<Option<String>, ()> {
    if !required {
        return if f.is_empty() { Ok(None) } else { Err(()) };
    }
    if f.is_empty() || !is_kx_key(f) || others.contains(&f) {
        return Err(());
    }
    Ok(Some(f.to_string()))
}

// --- dev. ------------------------------------------------------------------------

/// `dev.<devicePub>.<consentPub|empty>.<accountPub>.<kx|empty>.<b64u(label)|empty>.<created>.<expires>`
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceCert {
    pub device_pub: String,
    pub consent_pub: Option<String>,
    pub account_pub: String,
    pub kx: Option<String>,
    pub label: Option<String>,
    pub created: u64,
    pub expires: u64,
}

pub fn build_dev(c: &DeviceCert) -> String {
    [
        "dev".into(),
        c.device_pub.clone(),
        c.consent_pub.clone().unwrap_or_default(),
        c.account_pub.clone(),
        c.kx.clone().unwrap_or_default(),
        c.label.as_deref().filter(|l| !l.is_empty()).map(|l| b64u::enc(l.as_bytes())).unwrap_or_default(),
        c.created.to_string(),
        c.expires.to_string(),
    ]
    .join(".")
}

pub fn verify_dev(text: &str, sig: &str, now: u64, kx_mode: KxMode) -> Verdict<DeviceCert> {
    let p = fields(text, "dev", 8).ok_or("grammar")?;
    let (device_pub, consent_f, account_pub, kx_f, label_f, created_f, expires_f) =
        (p[1], p[2], p[3], p[4], p[5], p[6], p[7]);
    if !is_signing_key(device_pub) || !is_signing_key(account_pub) || device_pub == account_pub {
        return Err("key");
    }
    let mut consent_pub = None;
    if !consent_f.is_empty() {
        if !is_signing_key(consent_f) || consent_f == device_pub || consent_f == account_pub {
            return Err("consent-key");
        }
        consent_pub = Some(consent_f.to_string());
    }
    let kx = kx_slot(kx_f, kx_mode.slots().1, &[device_pub, account_pub, consent_f]).map_err(|_| "kx")?;
    let mut label = None;
    if !label_f.is_empty() {
        label = Some(display_text(label_f).ok_or("label")?);
    }
    let (created, expires) = (ms(created_f).ok_or("grammar")?, ms(expires_f).ok_or("grammar")?);
    if let Some(l) = lifetime(created, expires, now) {
        return Err(l);
    }
    if !verify_statement_sig(account_pub, sig, text) {
        return Err("signature");
    }
    Ok(DeviceCert { device_pub: device_pub.into(), consent_pub, account_pub: account_pub.into(), kx, label, created, expires })
}

// --- bind. -----------------------------------------------------------------------

/// `bind.<b64u(address)>.<accountPub>.<kx|empty>.<b64u(name)|empty>.<seq>.<prev|empty>.<created>.<expires>`
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BindCert {
    pub address: String,
    pub account_pub: String,
    pub kx: Option<String>,
    pub name: Option<String>,
    pub seq: u64,
    pub prev: Option<String>,
    pub created: u64,
    pub expires: u64,
}

pub fn build_bind(c: &BindCert) -> String {
    [
        "bind".into(),
        b64u::enc(c.address.as_bytes()),
        c.account_pub.clone(),
        c.kx.clone().unwrap_or_default(),
        c.name.as_deref().filter(|n| !n.is_empty()).map(|n| b64u::enc(n.as_bytes())).unwrap_or_default(),
        c.seq.to_string(),
        c.prev.clone().unwrap_or_default(),
        c.created.to_string(),
        c.expires.to_string(),
    ]
    .join(".")
}

pub fn verify_bind(text: &str, sig: &str, now: u64, kx_mode: KxMode) -> Verdict<BindCert> {
    let p = fields(text, "bind", 9).ok_or("grammar")?;
    let (address_f, account_pub, kx_f, name_f, seq_f, prev_f, created_f, expires_f) =
        (p[1], p[2], p[3], p[4], p[5], p[6], p[7], p[8]);
    let address = free_text(address_f).filter(|a| address::is_normal(a)).ok_or("address")?;
    if !is_signing_key(account_pub) {
        return Err("key");
    }
    let kx = kx_slot(kx_f, kx_mode.slots().0, &[account_pub]).map_err(|_| "kx")?;
    let mut name = None;
    if !name_f.is_empty() {
        name = Some(display_text(name_f).ok_or("name")?);
    }
    let seq = int(seq_f).filter(|s| *s >= 1).ok_or("seq")?;
    if (seq == 1) != prev_f.is_empty() || (!prev_f.is_empty() && !is_hash(prev_f)) {
        return Err("prev");
    }
    let (created, expires) = (ms(created_f).ok_or("grammar")?, ms(expires_f).ok_or("grammar")?);
    if let Some(l) = lifetime(created, expires, now) {
        return Err(l);
    }
    if !verify_statement_sig(account_pub, sig, text) {
        return Err("signature");
    }
    Ok(BindCert {
        address,
        account_pub: account_pub.into(),
        kx,
        name,
        seq,
        prev: (!prev_f.is_empty()).then(|| prev_f.to_string()),
        created,
        expires,
    })
}

// --- att. ------------------------------------------------------------------------

/// `att.<sha256(bind text)>.<verifiedAt>.<issuedAt>.<kid>.<active|pending|frozen>`
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attestation {
    pub bind_hash: String,
    pub verified_at: u64,
    pub issued_at: u64,
    pub kid: String,
    pub state: String,
}

pub fn build_att(a: &Attestation) -> String {
    format!("att.{}.{}.{}.{}.{}", a.bind_hash, a.verified_at, a.issued_at, a.kid, a.state)
}

pub fn verify_att(
    text: &str,
    sig: &str,
    directory_keys: &HashMap<String, String>,
    bind_text: &str,
    now: u64,
    max_age_ms: u64,
) -> Verdict<Attestation> {
    let p = fields(text, "att", 6).ok_or("grammar")?;
    let (bind_hash, verified_f, issued_f, kid, state) = (p[1], p[2], p[3], p[4], p[5]);
    if !is_hash(bind_hash) || !is_kid(kid) || !matches!(state, "active" | "pending" | "frozen") {
        return Err("grammar");
    }
    let (verified_at, issued_at) = (ms(verified_f).ok_or("grammar")?, ms(issued_f).ok_or("grammar")?);
    if verified_at > issued_at {
        return Err("grammar");
    }
    if issued_at > now + SKEW_MS {
        return Err("not-yet-valid");
    }
    // `now - issuedAt > maxAgeMs` in JS, with issuedAt possibly ahead of now
    // (within the skew): signed arithmetic.
    if now as i128 - issued_at as i128 > max_age_ms as i128 {
        return Err("stale");
    }
    if bind_hash != sha256_b64u(bind_text) {
        return Err("bind-mismatch");
    }
    let key = directory_keys.get(kid).ok_or("unknown-kid")?;
    if !verify_statement_sig(key, sig, text) {
        return Err("signature");
    }
    Ok(Attestation { bind_hash: bind_hash.into(), verified_at, issued_at, kid: kid.into(), state: state.into() })
}

// --- tomb. -----------------------------------------------------------------------

/// `tomb.<sha256(last bind text)|empty>.<seq>.<deletedAt>.<holder|mailbox|operator>.<kid>`
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tombstone {
    pub last_bind_hash: Option<String>,
    pub seq: u64,
    pub deleted_at: u64,
    pub by: String,
    pub kid: String,
}

pub fn build_tomb(t: &Tombstone) -> String {
    format!("tomb.{}.{}.{}.{}.{}", t.last_bind_hash.clone().unwrap_or_default(), t.seq, t.deleted_at, t.by, t.kid)
}

pub fn verify_tomb(text: &str, sig: &str, directory_keys: &HashMap<String, String>, now: u64) -> Verdict<Tombstone> {
    let p = fields(text, "tomb", 6).ok_or("grammar")?;
    let (hash_f, seq_f, deleted_f, by, kid) = (p[1], p[2], p[3], p[4], p[5]);
    if !hash_f.is_empty() && !is_hash(hash_f) {
        return Err("grammar");
    }
    let seq = int(seq_f).filter(|s| *s >= 1).ok_or("grammar")?;
    let deleted_at = ms(deleted_f).ok_or("grammar")?;
    if !matches!(by, "holder" | "mailbox" | "operator") || !is_kid(kid) {
        return Err("grammar");
    }
    if deleted_at > now + SKEW_MS {
        return Err("not-yet-valid");
    }
    let key = directory_keys.get(kid).ok_or("unknown-kid")?;
    if !verify_statement_sig(key, sig, text) {
        return Err("signature");
    }
    Ok(Tombstone {
        last_bind_hash: (!hash_f.is_empty()).then(|| hash_f.to_string()),
        seq,
        deleted_at,
        by: by.into(),
        kid: kid.into(),
    })
}

// --- del. ------------------------------------------------------------------------

pub const DELETE_WINDOW_MS: u64 = 5 * 60_000;

pub fn build_del(address: &str, ts: u64) -> String {
    format!("del.{}.{}", b64u::enc(address.as_bytes()), ts)
}

pub fn verify_del(text: &str, sig: &str, account_pub: &str, now: u64) -> Verdict<(String, u64)> {
    let p = fields(text, "del", 3).ok_or("grammar")?;
    let address = free_text(p[1]).filter(|a| address::is_normal(a)).ok_or("address")?;
    let ts = ms(p[2]).ok_or("grammar")?;
    if now.abs_diff(ts) > DELETE_WINDOW_MS {
        return Err("expired");
    }
    if !verify_statement_sig(account_pub, sig, text) {
        return Err("signature");
    }
    Ok((address, ts))
}

// --- cmp. ------------------------------------------------------------------------

pub fn build_cmp(bind_hash: &str, code: &str) -> String {
    format!("cmp.{bind_hash}.{code}")
}

pub fn verify_cmp(text: &str, sig: &str, account_pub: &str, bind_text: &str) -> Verdict<(String, String)> {
    let p = fields(text, "cmp", 3).ok_or("grammar")?;
    let (bind_hash, code) = (p[1], p[2]);
    if !is_hash(bind_hash) || !is_code(code) {
        return Err("grammar");
    }
    if bind_hash != sha256_b64u(bind_text) {
        return Err("bind-mismatch");
    }
    if !verify_statement_sig(account_pub, sig, text) {
        return Err("signature");
    }
    Ok((bind_hash.into(), code.into()))
}

// --- cns. ------------------------------------------------------------------------

/// The consent purposes, a CLOSED set, and the statement family each authorises.
fn consent_family(purpose: &str) -> Option<&'static str> {
    Some(match purpose {
        "invite" => "inv.",
        "revoke" => "rev.",
        "link" => "dev.",
        "rotate" => "bind.",
        "unbind" => "del.",
        _ => return None,
    })
}
const RESERVED_PURPOSES: [&str; 2] = ["grant", "role"];
fn doc_scoped(purpose: &str) -> bool {
    matches!(purpose, "invite" | "revoke")
}

pub const CONSENT_MAX_TTL_MS: u64 = 5 * 60_000;

/// AUDIENCE_RE ^(dir|room:<room>)$
fn is_audience(a: &str) -> bool {
    a == "dir" || a.strip_prefix("room:").map(is_room).unwrap_or(false)
}

/// The channel binding (security §24):
/// b64u(SHA-256("cnst.v1." ‖ audience ‖ "." ‖ challenge ‖ "." ‖ b64u(SHA-256(payload)))).
/// None if a part breaks its grammar.
pub fn consent_transcript(audience: &str, challenge: &str, payload_text: &str) -> Option<String> {
    if !is_audience(audience) {
        return None;
    }
    let c = b64u::dec(challenge)?;
    if !(16..=64).contains(&c.len()) {
        return None;
    }
    Some(sha256_b64u(&format!("cnst.v1.{audience}.{challenge}.{}", sha256_b64u(payload_text))))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Consent {
    pub rp: String,
    pub purpose: String,
    pub doc_id: Option<String>,
    pub transcript: String,
    pub exp: u64,
}

/// `cns.<rp>.<purpose>.<docId|empty>.<transcript>.<exp>`, every field host-stamped.
pub fn build_consent(c: &Consent) -> String {
    format!("cns.{}.{}.{}.{}.{}", c.rp, c.purpose, c.doc_id.clone().unwrap_or_default(), c.transcript, c.exp)
}

pub struct ConsentCheck<'a> {
    /// from a VERIFIED dev. certificate's consentPub
    pub consent_pub: &'a str,
    pub rp: &'a str,
    pub audience: &'a str,
    pub challenge: &'a str,
    pub payload_text: &'a str,
    pub doc_id: Option<&'a str>,
    pub now: u64,
}

/// Verify a consent signature. The transcript is RECOMPUTED from the verifier's
/// own audience, challenge and payload. `spend` must mark the challenge used and
/// return false if it was already spent or expired; it runs right after the
/// grammar check, so any attempt consumes the challenge.
pub fn verify_consent(text: &str, sig: &str, o: &ConsentCheck, spend: impl FnOnce(&str) -> bool) -> Verdict<Consent> {
    let p = fields(text, "cns", 6).ok_or("grammar")?;
    if !spend(o.challenge) {
        return Err("replay");
    }
    let (rp, purpose, doc_id_f, transcript, exp_f) = (p[1], p[2], p[3], p[4], p[5]);
    if !is_rp(rp) || !is_hash(transcript) {
        return Err("grammar");
    }
    if RESERVED_PURPOSES.contains(&purpose) {
        return Err("reserved-purpose");
    }
    let family = consent_family(purpose).ok_or("grammar")?;
    let exp = ms(exp_f).ok_or("grammar")?;
    if rp != o.rp {
        return Err("rp");
    }
    if !o.payload_text.starts_with(family) {
        return Err("payload-family");
    }
    if doc_scoped(purpose) {
        if !is_doc_id(doc_id_f) || Some(doc_id_f) != o.doc_id {
            return Err("docid");
        }
    } else if !doc_id_f.is_empty() || o.doc_id.is_some() {
        return Err("docid");
    }
    match consent_transcript(o.audience, o.challenge, o.payload_text) {
        Some(t) if t == transcript => {}
        _ => return Err("transcript"),
    }
    if o.now >= exp {
        return Err("expired");
    }
    if exp - o.now > CONSENT_MAX_TTL_MS {
        return Err("lifetime");
    }
    if !verify_statement_sig(o.consent_pub, sig, text) {
        return Err("signature");
    }
    Ok(Consent {
        rp: rp.into(),
        purpose: purpose.into(),
        doc_id: (!doc_id_f.is_empty()).then(|| doc_id_f.to_string()),
        transcript: transcript.into(),
        exp,
    })
}

/// The light tier's clientDataJSON.challenge for a cns. (security §27).
pub fn webauthn_challenge_for(cns_text: &str) -> String {
    sha256_b64u(cns_text)
}

/// Prefixes reserved for statements not defined yet.
pub const RESERVED_PREFIXES: [&str; 1] = ["pk"];

// --- routine signing: which payload each SignPurpose may sign ---------------------

fn b64_len(f: &str, min: usize, exact: Option<usize>) -> bool {
    match b64u::dec(f) {
        Some(b) => exact.map(|e| b.len() == e).unwrap_or(b.len() >= min),
        None => false,
    }
}
fn is_pub_field(f: &str) -> bool {
    b64u::dec(f).map(|b| b.len() == 65 && b[0] == 0x04).unwrap_or(false)
}
fn iv(f: &str) -> bool {
    b64_len(f, 0, Some(12))
}
fn ct(f: &str) -> bool {
    b64_len(f, 16, None)
}
/// ^[rw][A-Za-z0-9_-]{1,64}$
fn is_room_name(f: &str) -> bool {
    let b = f.as_bytes();
    (2..=65).contains(&b.len()) && (b[0] == b'r' || b[0] == b'w') && b[1..].iter().all(|c| b64_char(*c))
}

/// Does `payload` have the exact shape of the statement `purpose` names?
/// The agent signs only a matching payload.
pub fn payload_matches_purpose(purpose: &str, payload: &str) -> bool {
    if payload.len() > MAX_STATEMENT {
        return false;
    }
    let p: Vec<&str> = payload.split('.').collect();
    match purpose {
        "frame" => p.len() == 2 && iv(p[0]) && ct(p[1]),
        "prove" => p.len() == 3 && p[0] == "prove" && b64_len(p[1], 16, None) && is_room_name(p[2]),
        "delegate" => p.len() == 2 && p[0] == "dlg" && is_pub_field(p[1]),
        "show" => {
            (p.len() == 1 && (p[0] == "live" || p[0] == "end"))
                || (p.len() == 4 && (p[0] == "nav" || p[0] == "black") && p[1] == "aud" && iv(p[2]) && ct(p[3]))
        }
        "invite" => {
            p.len() == 4 && p[0] == "inv" && is_pub_field(p[1])
                && matches!(p[2], "writer" | "commenter" | "audience") && is_int_text(p[3])
        }
        "revoke" => p.len() == 2 && p[0] == "rev" && is_pub_field(p[1]),
        _ => false,
    }
}
