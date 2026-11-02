// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// bento/connect — the recovery code and the key blobs, a port of
// kernel/src/recovery.ts (identity-design §2f, security §28). Every value is
// DETERMINISTIC in kernel/fixtures/recovery-v1.json, so this port reproduces the
// exact bytes end to end; tests/recovery.rs runs every row.
//
// Secrets (codes, Argon2id outputs, wrap keys, scalars) are returned in
// `Zeroizing` so they are wiped when dropped (§26b: plaintext key material
// lives only for the prompted use).

use crate::{b64u, statements::KxMode};
use aes_gcm::{aead::{Aead, KeyInit, Payload}, Aes256Gcm, Nonce};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use p256::elliptic_curve::sec1::ToSec1Point;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

pub type Secret = Zeroizing<Vec<u8>>;

// --- parameters (security §28) -------------------------------------------------

pub const ARGON2_VERSION: u32 = 0x13;
pub const ARGON2_PARALLELISM: u32 = 1;
pub const ARGON2_MEMORY_KIB: u32 = 65536;
pub const ARGON2_PASSES: u32 = 3;
pub const ARGON2_TAG_LEN: usize = 32;
pub const SALT_LEN: usize = 16;
pub const CODE_BYTES: usize = 10;

/// Free memory Argon2id insists on beyond its own working set.
pub const MEMORY_HEADROOM_KIB: u64 = 64 * 1024;

#[cfg(test)]
thread_local! {
    /// Unit tests only: pretend this much memory is available (KiB). Not in
    /// any build but `cargo test` of this crate (security, #823 review).
    static AVAILABLE_OVERRIDE_KIB: std::cell::Cell<Option<u64>> = const { std::cell::Cell::new(None) };
}

/// Physical memory available to THIS process right now, in KiB, where the
/// platform says. Linux: /proc/meminfo MemAvailable, capped by every cgroup v2
/// ancestor's (memory.max − memory.current) — Flatpak, Snap and containers set
/// those, and MemAvailable ignores them. Windows: GlobalMemoryStatusEx (owed
/// with the Windows store). Elsewhere: unknown (None).
pub fn available_memory_kib() -> Option<u64> {
    #[cfg(test)]
    if let Some(v) = AVAILABLE_OVERRIDE_KIB.with(|c| c.get()) {
        return Some(v);
    }
    #[cfg(target_os = "linux")]
    {
        let info = std::fs::read_to_string("/proc/meminfo").ok()?;
        let line = info.lines().find(|l| l.starts_with("MemAvailable:"))?;
        let mem: u64 = line.split_whitespace().nth(1)?.parse().ok()?;
        let cg = std::fs::read_to_string("/proc/self/cgroup").ok();
        return Some(match cg.as_deref().and_then(cgroup_v2_path) {
            Some(path) => mem.min(cgroup_free_kib(std::path::Path::new("/sys/fs/cgroup"), &path).unwrap_or(u64::MAX)),
            None => mem,
        });
    }
    #[allow(unreachable_code)]
    None
}

/// The unified (v2) hierarchy path from /proc/self/cgroup ("0::/a/b").
#[cfg(any(target_os = "linux", test))]
fn cgroup_v2_path(proc_cgroup: &str) -> Option<String> {
    proc_cgroup.lines().find_map(|l| l.strip_prefix("0::")).map(|p| p.trim().to_string())
}

/// The tightest (memory.max − memory.current) from `path` up to the root of
/// the cgroup v2 mount, in KiB; None when no ancestor sets a limit.
#[cfg(any(target_os = "linux", test))]
fn cgroup_free_kib(root: &std::path::Path, path: &str) -> Option<u64> {
    let mut best: Option<u64> = None;
    let mut dir = root.join(path.trim_start_matches('/'));
    loop {
        let max = std::fs::read_to_string(dir.join("memory.max")).ok();
        let cur = std::fs::read_to_string(dir.join("memory.current")).ok();
        if let (Some(max), Some(cur)) = (max, cur) {
            if let (Ok(max), Ok(cur)) = (max.trim().parse::<u64>(), cur.trim().parse::<u64>()) {
                let free = max.saturating_sub(cur) / 1024;
                best = Some(best.map_or(free, |b| b.min(free)));
            }
        }
        if dir == root || !dir.pop() || !dir.starts_with(root) {
            break;
        }
    }
    best
}

/// Raw Argon2id with explicit parameters, an optional secret and associated
/// data (the RFC 9106 §5.3 vector needs both). Our derivations use `argon2id`.
pub fn argon2id_raw(
    password: &[u8],
    salt: &[u8],
    secret: Option<&[u8]>,
    ad: Option<&[u8]>,
    memory_kib: u32,
    passes: u32,
    parallelism: u32,
    tag_len: usize,
) -> Result<Secret, String> {
    use argon2::{Algorithm, Argon2, AssociatedData, ParamsBuilder, Version};
    let mut pb = ParamsBuilder::new();
    pb.m_cost(memory_kib).t_cost(passes).p_cost(parallelism).output_len(tag_len);
    if let Some(ad) = ad {
        pb.data(AssociatedData::new(ad).map_err(|e| e.to_string())?);
    }
    let params = pb.build().map_err(|e| e.to_string())?;
    let a = match secret {
        Some(s) => Argon2::new_with_secret(s, Algorithm::Argon2id, Version::V0x13, params).map_err(|e| e.to_string())?,
        None => Argon2::new(Algorithm::Argon2id, Version::V0x13, params),
    };
    // FAIL CLOSED ON LOW MEMORY. A Rust allocation failure ABORTS the process
    // rather than returning an error (home-android saw the same with
    // OutOfMemoryError: catching it did not fail closed). And a fallible
    // reservation is NOT enough on its own (measured: with overcommit a 4 TiB
    // try_reserve SUCCEEDS, and the process is SIGKILLed later when the pages are
    // touched). So: check the AVAILABLE physical memory first (need + headroom),
    // then reserve fallibly and hand the buffer to the crate, which allocates
    // nothing itself.
    let blocks = a.params().block_count();
    let need_kib = blocks as u64; // one Argon2 block = 1 KiB
    if let Some(avail) = available_memory_kib() {
        if avail < need_kib + MEMORY_HEADROOM_KIB {
            return Err(format!("not enough free memory for Argon2id: need {need_kib} KiB + {MEMORY_HEADROOM_KIB} KiB headroom, {avail} KiB available"));
        }
    }
    let mut memory: Vec<argon2::Block> = Vec::new();
    memory
        .try_reserve_exact(blocks)
        .map_err(|_| format!("not enough memory for Argon2id ({} KiB)", blocks))?;
    memory.resize(blocks, argon2::Block::default());
    let mut out = Zeroizing::new(vec![0u8; tag_len]);
    let r = a.hash_password_into_with_memory(password, salt, &mut out, &mut memory);
    // the working memory held password-derived state: wipe it
    for b in memory.iter_mut() {
        *b = argon2::Block::default();
    }
    r.map_err(|e| e.to_string())?;
    Ok(out)
}

/// Argon2id with OUR parameters (v0x13, p=1, 64 MiB, t=3, 32 bytes).
/// Err when the 64 MiB cannot be reserved: refuse cleanly, never abort.
pub fn argon2id(password: &[u8], salt: &[u8]) -> Result<Secret, String> {
    argon2id_raw(password, salt, None, None, ARGON2_MEMORY_KIB, ARGON2_PASSES, ARGON2_PARALLELISM, ARGON2_TAG_LEN)
}

// --- the recovery code: 80 bits, Crockford base32, with a check symbol ----------

const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CHECK_ALPHABET: &[u8; 37] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ*~$=U";

fn to_u128(b: &[u8]) -> u128 {
    b.iter().fold(0u128, |x, v| (x << 8) | *v as u128)
}

/// The printed form: XXXX-XXXX-XXXX-XXXX-C.
pub fn format_recovery_code(code: &[u8]) -> String {
    assert_eq!(code.len(), CODE_BYTES, "a recovery code is 10 bytes");
    let n = to_u128(code);
    let s: String = (0..16).rev().map(|i| ALPHABET[((n >> (i * 5)) & 31) as usize] as char).collect();
    let check = CHECK_ALPHABET[(n % 37) as usize] as char;
    format!("{}-{}-{}-{}-{check}", &s[0..4], &s[4..8], &s[8..12], &s[12..16])
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodeRefusal {
    Length,
    Character,
    Check,
}
impl CodeRefusal {
    pub fn as_str(self) -> &'static str {
        match self {
            CodeRefusal::Length => "length",
            CodeRefusal::Character => "character",
            CodeRefusal::Check => "check",
        }
    }
}

/// Read what a person typed (recovery.ts parseRecoveryCode). JS semantics kept
/// on purpose: `toUpperCase()` then strip JS `\s` and '-', then O→0, I/L→1.
/// Non-ASCII survives as a non-alphabet character and is refused. Returns the
/// 10 bytes Argon2id takes, never the string.
pub fn parse_recovery_code(input: &str) -> Result<Zeroizing<[u8; CODE_BYTES]>, CodeRefusal> {
    let upper = input.to_uppercase();
    let s: Vec<char> = upper
        .chars()
        .filter(|c| !js_regex_space(*c) && *c != '-')
        .map(|c| match c {
            'O' => '0',
            'I' | 'L' => '1',
            c => c,
        })
        .collect();
    if s.len() != 17 {
        return Err(CodeRefusal::Length);
    }
    let mut n: u128 = 0;
    for c in &s[..16] {
        let v = ALPHABET.iter().position(|a| *a as char == *c).ok_or(CodeRefusal::Character)?;
        n = (n << 5) | v as u128;
    }
    let check = CHECK_ALPHABET.iter().position(|a| *a as char == s[16]).ok_or(CodeRefusal::Character)?;
    if check as u128 != n % 37 {
        return Err(CodeRefusal::Check);
    }
    let mut code = Zeroizing::new([0u8; CODE_BYTES]);
    for i in (0..CODE_BYTES).rev() {
        code[i] = (n & 0xff) as u8;
        n >>= 8;
    }
    Ok(code)
}

/// The JS regex `\s` class (WhiteSpace + LineTerminator).
fn js_regex_space(c: char) -> bool {
    matches!(c,
        '\u{0009}'..='\u{000D}' | '\u{0020}' | '\u{00A0}' | '\u{1680}' | '\u{2000}'..='\u{200A}'
        | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}')
}

// --- derivations ------------------------------------------------------------------

/// HKDF-SHA-256 → 32 bytes. An EMPTY salt is zero-length (= 32 zero bytes).
fn hkdf(ikm: &[u8], salt: &[u8], info: &str) -> Secret {
    let h = Hkdf::<Sha256>::new(Some(salt), ikm);
    let mut out = Zeroizing::new(vec![0u8; 32]);
    h.expand(info.as_bytes(), &mut out).expect("32 bytes is a valid HKDF length");
    out
}

/// HKDF-SHA-256(Argon2id(code, salt), empty, "bento/id/rc-wrap/v1").
pub fn recovery_wrap_key(code: &[u8], salt: &[u8]) -> Result<Secret, String> {
    assert_eq!((code.len(), salt.len()), (CODE_BYTES, SALT_LEN));
    Ok(hkdf(&argon2id(code, salt)?, &[], "bento/id/rc-wrap/v1"))
}

/// What the client sends the directory: Argon2id(code, salt_v).
pub fn recovery_verifier(code: &[u8], salt_v: &[u8]) -> Result<Secret, String> {
    assert_eq!((code.len(), salt_v.len()), (CODE_BYTES, SALT_LEN));
    argon2id(code, salt_v)
}

/// HKDF-SHA-256(PRF output, 32-byte salt, "bento/id/acct-wrap/v1").
pub fn prf_kek(prf_output: &[u8], salt: &[u8]) -> Secret {
    assert_eq!((prf_output.len(), salt.len()), (32, 32));
    hkdf(prf_output, salt, "bento/id/acct-wrap/v1")
}

// --- blob plaintext: raw private scalars, checked on import ------------------------

fn blob_kx(mode: KxMode) -> bool {
    matches!(mode, KxMode::A | KxMode::C)
}

pub struct BlobKeys {
    pub account: Zeroizing<[u8; 32]>,
    pub kx: Option<Zeroizing<[u8; 32]>>,
}

pub fn pack_scalars(keys: &BlobKeys, mode: KxMode) -> Secret {
    match (blob_kx(mode), &keys.kx) {
        (false, None) => Zeroizing::new(keys.account.to_vec()),
        (true, Some(kx)) => {
            let mut v = Zeroizing::new(keys.account.to_vec());
            v.extend_from_slice(&kx[..]);
            v
        }
        (false, Some(_)) => panic!("this kx mode carries no kx in the blob"),
        (true, None) => panic!("this kx mode needs a kx in the blob"),
    }
}

/// d·G as a raw uncompressed point, base64url; None when d is 0 or ≥ n.
///
/// CONSTANT-TIME by construction (security, #770 review): the recovered scalar
/// is SECRET, so the range check is p256's own `SecretKey::from_slice` (a
/// constant-time decode that refuses 0 and ≥ n) and d·G is p256's
/// constant-time scalar multiplication. Only the resulting PUBLIC points are
/// compared. Never replace this with a bignum compare or a hand-rolled
/// double-and-add: both branch on the secret.
fn public_of(d: &[u8]) -> Option<String> {
    let sk = p256::SecretKey::from_slice(d).ok()?;
    Some(b64u::enc(sk.public_key().to_sec1_point(false).as_bytes()))
}

/// Check a blob's plaintext before anything uses it: the right length for the
/// mode, every scalar in 1..n−1, and each one's public half equal to the
/// directory-signed one. A swapped blob fails closed here.
pub fn unpack_scalars(pt: &[u8], account_pub: &str, kx_pub: Option<&str>, mode: KxMode) -> Result<BlobKeys, &'static str> {
    let with_kx = blob_kx(mode);
    if pt.len() != if with_kx { 64 } else { 32 } {
        return Err("length");
    }
    let mut out = vec![];
    for (i, want) in [Some(account_pub), kx_pub].iter().take(if with_kx { 2 } else { 1 }).enumerate() {
        let d = &pt[i * 32..i * 32 + 32];
        // range first (1..n−1), as the reference
        let pub_d = public_of(d).ok_or("scalar-range")?;
        if *want != Some(pub_d.as_str()) {
            return Err("key-mismatch");
        }
        let mut s = Zeroizing::new([0u8; 32]);
        s.copy_from_slice(d);
        out.push(s);
    }
    let mut it = out.into_iter();
    Ok(BlobKeys { account: it.next().unwrap(), kx: it.next() })
}

// --- AES-256-GCM ------------------------------------------------------------------------

fn gcm_seal(key: &[u8], iv: &[u8], aad: &str, pt: &[u8]) -> Vec<u8> {
    assert_eq!((key.len(), iv.len()), (32, 12));
    Aes256Gcm::new_from_slice(key).unwrap().encrypt(&Nonce::from(<[u8; 12]>::try_from(iv).unwrap()), Payload { msg: pt, aad: aad.as_bytes() }).unwrap()
}
fn gcm_open(key: &[u8], iv: &[u8], aad: &str, ct: &[u8]) -> Option<Secret> {
    if key.len() != 32 || iv.len() != 12 {
        return None;
    }
    Aes256Gcm::new_from_slice(key).ok()?.decrypt(&Nonce::from(<[u8; 12]>::try_from(iv).ok()?), Payload { msg: ct, aad: aad.as_bytes() }).ok().map(Zeroizing::new)
}
fn sha256_b64u(b: &[u8]) -> String {
    b64u::enc(&Sha256::digest(b))
}
fn account_tag(account_pub: &str) -> String {
    sha256_b64u(account_pub.as_bytes())
}

// --- the PRF blob (one per passkey) -------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrfBlob {
    pub v: u32,
    pub cred: String,
    pub salt: String,
    pub iv: String,
    pub ct: String,
}

pub fn seal_prf_blob(prf_output: &[u8], credential_id: &[u8], salt: &[u8], iv: &[u8], keys: &BlobKeys, mode: KxMode) -> PrfBlob {
    let cred = sha256_b64u(credential_id);
    let kek = prf_kek(prf_output, salt);
    let ct = gcm_seal(&kek, iv, &format!("bento/id/acct-wrap/v1.{cred}"), &pack_scalars(keys, mode));
    PrfBlob { v: 1, cred, salt: b64u::enc(salt), iv: b64u::enc(iv), ct: b64u::enc(&ct) }
}

pub fn open_prf_blob(
    blob: &PrfBlob,
    prf_output: &[u8],
    credential_id: &[u8],
    account_pub: &str,
    kx_pub: Option<&str>,
    mode: KxMode,
) -> Result<BlobKeys, &'static str> {
    if blob.v != 1 {
        return Err("version");
    }
    let cred = sha256_b64u(credential_id);
    if blob.cred != cred {
        return Err("credential");
    }
    let (salt, iv, ct) = (b64u::dec(&blob.salt), b64u::dec(&blob.iv), b64u::dec(&blob.ct));
    let (Some(salt), Some(iv), Some(ct)) = (salt, iv, ct) else { return Err("grammar") };
    if salt.len() != 32 || iv.len() != 12 {
        return Err("grammar");
    }
    let pt = gcm_open(&prf_kek(prf_output, &salt), &iv, &format!("bento/id/acct-wrap/v1.{cred}"), &ct).ok_or("decrypt")?;
    unpack_scalars(&pt, account_pub, kx_pub, mode)
}

// --- the recovery-code blob, and the directory's pepper layer -------------------------

pub fn seal_recovery_inner(wrap_key: &[u8], iv: &[u8], account_pub: &str, keys: &BlobKeys, mode: KxMode) -> Vec<u8> {
    gcm_seal(wrap_key, iv, &format!("bento/id/rc-wrap/v1.{}", account_tag(account_pub)), &pack_scalars(keys, mode))
}

pub fn open_recovery_inner(
    ct: &[u8],
    wrap_key: &[u8],
    iv: &[u8],
    account_pub: &str,
    kx_pub: Option<&str>,
    mode: KxMode,
) -> Result<BlobKeys, &'static str> {
    let pt = gcm_open(wrap_key, iv, &format!("bento/id/rc-wrap/v1.{}", account_tag(account_pub)), ct).ok_or("decrypt")?;
    unpack_scalars(&pt, account_pub, kx_pub, mode)
}

/// The directory's per-account pepper keys (server side; here so the vectors
/// can be checked from Rust too): (verifyKey, wrapKey). Subkey labels per
/// security §28a.
pub fn pepper_keys(pepper: &[u8], account_pub: &str) -> (Secret, Secret) {
    let p = hkdf(pepper, &[], &format!("bento/id/pepper/v1.{}", account_tag(account_pub)));
    (hkdf(&p, &[], "bento/id/pepper/v1/verify"), hkdf(&p, &[], "bento/id/pepper/v1/wrap"))
}

pub fn pepper_verifier_tag(verify_key: &[u8], verifier: &[u8]) -> Vec<u8> {
    let mut m = <Hmac<Sha256> as Mac>::new_from_slice(verify_key).unwrap();
    m.update(verifier);
    m.finalize().into_bytes().to_vec()
}

pub fn pepper_seal(wrap_key: &[u8], iv: &[u8], inner: &[u8], account_pub: &str) -> Vec<u8> {
    gcm_seal(wrap_key, iv, &format!("bento/id/rc-pepper/v1.{}", account_tag(account_pub)), inner)
}

pub fn pepper_open(wrap_key: &[u8], iv: &[u8], outer: &[u8], account_pub: &str) -> Option<Secret> {
    gcm_open(wrap_key, iv, &format!("bento/id/rc-pepper/v1.{}", account_tag(account_pub)), outer)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn argon2id_refuses_cleanly_when_memory_is_short() {
        // kernel/home-android finding: low memory must FAIL CLOSED with an Err,
        // never abort or get the process killed. Simulated: 64 MiB needed + 64
        // MiB headroom, only 100 MiB "available".
        AVAILABLE_OVERRIDE_KIB.with(|c| c.set(Some(100 * 1024)));
        let r = argon2id(b"pw", &[0u8; 16]);
        AVAILABLE_OVERRIDE_KIB.with(|c| c.set(None));
        let e = r.err().expect("refused");
        assert!(e.contains("not enough free memory"), "{e}");
        // control: with enough available, it runs
        AVAILABLE_OVERRIDE_KIB.with(|c| c.set(Some(1024 * 1024)));
        assert!(argon2id(b"pw", &[0u8; 16]).is_ok());
        AVAILABLE_OVERRIDE_KIB.with(|c| c.set(None));
    }

    #[test]
    fn cgroup_limits_cap_available_memory() {
        // A fake cgroup v2 tree: the leaf sets no limit, its parent allows 512
        // MiB with 480 MiB used, the grandparent is unlimited ("max").
        let root = std::env::temp_dir().join(format!("bento-cg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let leaf = root.join("user.slice/app.scope/leaf");
        std::fs::create_dir_all(&leaf).unwrap();
        let w = |d: &std::path::Path, f: &str, v: &str| std::fs::write(d.join(f), v).unwrap();
        w(&root.join("user.slice"), "memory.max", "max\n");
        w(&root.join("user.slice"), "memory.current", "1000\n");
        w(&root.join("user.slice/app.scope"), "memory.max", &format!("{}\n", 512u64 << 20));
        w(&root.join("user.slice/app.scope"), "memory.current", &format!("{}\n", 480u64 << 20));
        assert_eq!(cgroup_free_kib(&root, "/user.slice/app.scope/leaf"), Some(32 * 1024), "the parent's limit binds");
        assert_eq!(cgroup_v2_path("12:pids:/x\n0::/user.slice/app.scope/leaf\n").as_deref(), Some("/user.slice/app.scope/leaf"));
        assert_eq!(cgroup_free_kib(&root, "/nonexistent"), None);
        let _ = std::fs::remove_dir_all(&root);
    }
}
