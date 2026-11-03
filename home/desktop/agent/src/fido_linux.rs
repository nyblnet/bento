// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The Linux authenticator layer (H1d): security keys over CTAP-HID through
// the DISTRIBUTION's libfido2 (Yubico, BSD-2-Clause), declared minimum 1.12.
// A thin in-tree FFI over the ~30 calls we use — no binding crate, no bundled
// libfido2, no OpenSSL crate in the shipped graph (security §34). Windows does
// NOT use this: it goes through webauthn.dll only.
//
// THE PRF TRANSFORM HAPPENS EXACTLY ONCE, HERE. Callers pass the raw PRF input
// (e.g. webauthn::PRF_INPUT); this layer turns it into the CTAP hmac-secret salt
// with webauthn::prf_salt and hands THAT to libfido2, which applies nothing
// further. Passing a pre-hashed salt in would double-hash: deterministic, so
// nothing errors, but never equal to what the same key yields on the web.

use crate::webauthn::{client_data, client_data_hash, prf_salt, Ceremony, Platform};
use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int, c_uchar};
use std::ptr;
use zeroize::Zeroizing;

#[allow(non_camel_case_types)]
type fido_dev_t = std::ffi::c_void;
#[allow(non_camel_case_types)]
type fido_assert_t = std::ffi::c_void;
#[allow(non_camel_case_types)]
type fido_cred_t = std::ffi::c_void;
#[allow(non_camel_case_types)]
type fido_dev_info_t = std::ffi::c_void;

const FIDO_OK: c_int = 0;
const FIDO_OPT_TRUE: c_int = 2;
const FIDO_EXT_HMAC_SECRET: c_int = 0x01;
const COSE_ES256: c_int = -7;
const FIDO_ERR_UNSUPPORTED_EXTENSION: c_int = 0x16;
const FIDO_ERR_OPERATION_DENIED: c_int = 0x27;
const FIDO_ERR_NO_CREDENTIALS: c_int = 0x2e;
const FIDO_ERR_PIN_INVALID: c_int = 0x31;
const FIDO_ERR_PIN_BLOCKED: c_int = 0x32;
const FIDO_ERR_PIN_AUTH_BLOCKED: c_int = 0x34;
const FIDO_ERR_PIN_REQUIRED: c_int = 0x36;
const FIDO_ERR_ACTION_TIMEOUT: c_int = 0x3a;
const FIDO_ERR_UV_INVALID: c_int = 0x3f;

#[link(name = "fido2")]
extern "C" {
    fn fido_init(flags: c_int);
    fn fido_strerr(n: c_int) -> *const c_char;
    fn fido_dev_info_new(n: usize) -> *mut fido_dev_info_t;
    fn fido_dev_info_free(di: *mut *mut fido_dev_info_t, n: usize);
    fn fido_dev_info_manifest(di: *mut fido_dev_info_t, ilen: usize, olen: *mut usize) -> c_int;
    fn fido_dev_info_ptr(di: *const fido_dev_info_t, i: usize) -> *const fido_dev_info_t;
    fn fido_dev_info_path(di: *const fido_dev_info_t) -> *const c_char;
    fn fido_dev_new() -> *mut fido_dev_t;
    fn fido_dev_free(d: *mut *mut fido_dev_t);
    fn fido_dev_open(d: *mut fido_dev_t, path: *const c_char) -> c_int;
    fn fido_dev_close(d: *mut fido_dev_t) -> c_int;
    fn fido_dev_get_assert(d: *mut fido_dev_t, a: *mut fido_assert_t, pin: *const c_char) -> c_int;
    fn fido_dev_make_cred(d: *mut fido_dev_t, c: *mut fido_cred_t, pin: *const c_char) -> c_int;
    fn fido_assert_new() -> *mut fido_assert_t;
    fn fido_assert_free(a: *mut *mut fido_assert_t);
    fn fido_assert_set_rp(a: *mut fido_assert_t, id: *const c_char) -> c_int;
    fn fido_assert_set_clientdata_hash(a: *mut fido_assert_t, p: *const c_uchar, n: usize) -> c_int;
    fn fido_assert_set_extensions(a: *mut fido_assert_t, ext: c_int) -> c_int;
    fn fido_assert_set_hmac_salt(a: *mut fido_assert_t, p: *const c_uchar, n: usize) -> c_int;
    fn fido_assert_set_up(a: *mut fido_assert_t, o: c_int) -> c_int;
    fn fido_assert_set_uv(a: *mut fido_assert_t, o: c_int) -> c_int;
    fn fido_assert_count(a: *const fido_assert_t) -> usize;
    fn fido_assert_id_ptr(a: *const fido_assert_t, i: usize) -> *const c_uchar;
    fn fido_assert_id_len(a: *const fido_assert_t, i: usize) -> usize;
    fn fido_assert_authdata_ptr(a: *const fido_assert_t, i: usize) -> *const c_uchar;
    fn fido_assert_authdata_len(a: *const fido_assert_t, i: usize) -> usize;
    fn fido_assert_sig_ptr(a: *const fido_assert_t, i: usize) -> *const c_uchar;
    fn fido_assert_sig_len(a: *const fido_assert_t, i: usize) -> usize;
    fn fido_assert_hmac_secret_ptr(a: *const fido_assert_t, i: usize) -> *const c_uchar;
    fn fido_assert_hmac_secret_len(a: *const fido_assert_t, i: usize) -> usize;
    fn fido_assert_user_id_ptr(a: *const fido_assert_t, i: usize) -> *const c_uchar;
    fn fido_assert_user_id_len(a: *const fido_assert_t, i: usize) -> usize;
    fn fido_cred_new() -> *mut fido_cred_t;
    fn fido_cred_free(c: *mut *mut fido_cred_t);
    fn fido_cred_set_type(c: *mut fido_cred_t, cose: c_int) -> c_int;
    fn fido_cred_set_clientdata_hash(c: *mut fido_cred_t, p: *const c_uchar, n: usize) -> c_int;
    fn fido_cred_set_rp(c: *mut fido_cred_t, id: *const c_char, name: *const c_char) -> c_int;
    fn fido_cred_set_user(
        c: *mut fido_cred_t,
        id: *const c_uchar,
        n: usize,
        name: *const c_char,
        display: *const c_char,
        icon: *const c_char,
    ) -> c_int;
    fn fido_cred_set_rk(c: *mut fido_cred_t, o: c_int) -> c_int;
    fn fido_cred_set_uv(c: *mut fido_cred_t, o: c_int) -> c_int;
    fn fido_cred_set_extensions(c: *mut fido_cred_t, ext: c_int) -> c_int;
    fn fido_cred_id_ptr(c: *const fido_cred_t) -> *const c_uchar;
    fn fido_cred_id_len(c: *const fido_cred_t) -> usize;
    fn fido_cred_authdata_ptr(c: *const fido_cred_t) -> *const c_uchar;
    fn fido_cred_authdata_len(c: *const fido_cred_t) -> usize;
}

/// Why a ceremony gave nothing. Tri-state as everywhere else: the person
/// (declined / wrong PIN / cancelled), no matching credential, or an outage.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FidoError {
    Declined(String),
    NoCredential,
    PinRequired,
    Unavailable(String),
}

fn err(code: c_int) -> FidoError {
    let msg = unsafe { CStr::from_ptr(fido_strerr(code)) }.to_string_lossy().into_owned();
    match code {
        FIDO_ERR_OPERATION_DENIED | FIDO_ERR_ACTION_TIMEOUT | FIDO_ERR_PIN_INVALID | FIDO_ERR_PIN_BLOCKED
        | FIDO_ERR_PIN_AUTH_BLOCKED | FIDO_ERR_UV_INVALID => FidoError::Declined(msg),
        FIDO_ERR_NO_CREDENTIALS => FidoError::NoCredential,
        FIDO_ERR_PIN_REQUIRED => FidoError::PinRequired,
        FIDO_ERR_UNSUPPORTED_EXTENSION => FidoError::Unavailable(format!("no hmac-secret: {msg}")),
        _ => FidoError::Unavailable(msg),
    }
}
fn ok(code: c_int) -> Result<(), FidoError> {
    if code == FIDO_OK { Ok(()) } else { Err(err(code)) }
}
unsafe fn bytes(p: *const c_uchar, n: usize) -> Vec<u8> {
    if p.is_null() || n == 0 { Vec::new() } else { std::slice::from_raw_parts(p, n).to_vec() }
}

/// libfido2 returns authenticatorData CBOR-wrapped (a byte string); verifiers
/// want the raw bytes. Unwrap exactly one CBOR major-type-2 header.
pub fn unwrap_cbor_bstr(v: &[u8]) -> Option<Vec<u8>> {
    let (&h, rest) = v.split_first()?;
    if h >> 5 != 2 {
        return None;
    }
    let (len, body) = match h & 0x1f {
        n @ 0..=23 => (n as usize, rest),
        24 => (*rest.first()? as usize, &rest[1..]),
        25 => (u16::from_be_bytes([*rest.first()?, *rest.get(1)?]) as usize, &rest[2..]),
        _ => return None,
    };
    (body.len() == len).then(|| body.to_vec())
}

/// The security key's PIN as a NUL-terminated buffer that is zeroized when
/// dropped (the host draws the PIN prompt; it never comes from the page).
fn pin_bytes(pin: Option<&str>) -> Result<Option<Zeroizing<Vec<u8>>>, FidoError> {
    match pin {
        None => Ok(None),
        Some(p) if p.as_bytes().contains(&0) => Err(FidoError::Unavailable("PIN contains NUL".into())),
        Some(p) => {
            let mut v = Zeroizing::new(Vec::with_capacity(p.len() + 1));
            v.extend_from_slice(p.as_bytes());
            v.push(0);
            Ok(Some(v))
        }
    }
}

fn init() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| unsafe { fido_init(0) });
}

/// Paths of the FIDO devices present (hidraw on Linux).
pub fn devices() -> Result<Vec<String>, FidoError> {
    init();
    unsafe {
        let mut di = fido_dev_info_new(16);
        if di.is_null() {
            return Err(FidoError::Unavailable("libfido2 could not allocate".into()));
        }
        let mut n = 0usize;
        let r = fido_dev_info_manifest(di, 16, &mut n);
        let out = (0..n)
            .map(|i| CStr::from_ptr(fido_dev_info_path(fido_dev_info_ptr(di, i))).to_string_lossy().into_owned())
            .collect();
        fido_dev_info_free(&mut di, 16);
        ok(r)?;
        Ok(out)
    }
}

struct Dev(*mut fido_dev_t);
impl Dev {
    fn open(path: &str) -> Result<Dev, FidoError> {
        init();
        let c = CString::new(path).map_err(|e| FidoError::Unavailable(e.to_string()))?;
        unsafe {
            let d = fido_dev_new();
            if d.is_null() {
                return Err(FidoError::Unavailable("libfido2 could not allocate".into()));
            }
            let r = fido_dev_open(d, c.as_ptr());
            let dev = Dev(d);
            ok(r)?;
            Ok(dev)
        }
    }
}
impl Drop for Dev {
    fn drop(&mut self) {
        unsafe {
            fido_dev_close(self.0);
            fido_dev_free(&mut self.0);
        }
    }
}

/// One discoverable assertion with the PRF output (§2f step 2).
pub struct Assertion {
    pub credential_id: Vec<u8>,
    pub user_handle: Vec<u8>,
    /// raw authenticatorData (CBOR wrapper removed)
    pub authenticator_data: Vec<u8>,
    /// the authenticator's signature as returned (DER for ES256)
    pub signature: Vec<u8>,
    /// the exact clientDataJSON the signature covers
    pub client_data_json: String,
    /// the PRF output (CTAP hmac-secret output), 32 bytes
    pub prf: Zeroizing<Vec<u8>>,
}

/// The hmac-secret salt for a raw PRF input: prf_salt, ONCE. The two
/// `rig-mutant-*` features exist only so the interop rig can prove it catches
/// the two easy mistakes; a shipped build never enables them.
fn salt_for(prf_input: &[u8]) -> [u8; 32] {
    #[cfg(feature = "rig-mutant-double-hash")]
    return prf_salt(&prf_salt(prf_input));
    #[cfg(all(feature = "rig-mutant-raw-hash", not(feature = "rig-mutant-double-hash")))]
    {
        use sha2::{Digest, Sha256};
        return Sha256::digest(prf_input).into();
    }
    #[allow(unreachable_code)]
    prf_salt(prf_input)
}

/// A discoverable get with UP + UV and the PRF extension. `prf_input` is the
/// RAW PRF input: the salt transform is applied here, once.
pub fn get_assertion(
    path: &str,
    rp_id: &str,
    challenge: &[u8],
    prf_input: &[u8],
    pin: Option<&str>,
) -> Result<Vec<Assertion>, FidoError> {
    let dev = Dev::open(path)?;
    let cd = client_data(Ceremony::Get, challenge, Platform::Linux);
    let cdh = client_data_hash(&cd);
    let salt = salt_for(prf_input);
    let rp = CString::new(rp_id).map_err(|e| FidoError::Unavailable(e.to_string()))?;
    let pin_c = pin_bytes(pin)?;
    unsafe {
        let mut a = fido_assert_new();
        if a.is_null() {
            return Err(FidoError::Unavailable("libfido2 could not allocate".into()));
        }
        let res = (|| {
            ok(fido_assert_set_rp(a, rp.as_ptr()))?;
            ok(fido_assert_set_clientdata_hash(a, cdh.as_ptr(), cdh.len()))?;
            ok(fido_assert_set_extensions(a, FIDO_EXT_HMAC_SECRET))?;
            ok(fido_assert_set_hmac_salt(a, salt.as_ptr(), salt.len()))?;
            ok(fido_assert_set_up(a, FIDO_OPT_TRUE))?;
            ok(fido_assert_set_uv(a, FIDO_OPT_TRUE))?;
            ok(fido_dev_get_assert(dev.0, a, pin_c.as_ref().map_or(ptr::null(), |p| p.as_ptr() as *const c_char)))?;
            let mut out = vec![];
            for i in 0..fido_assert_count(a) {
                let prf = Zeroizing::new(bytes(fido_assert_hmac_secret_ptr(a, i), fido_assert_hmac_secret_len(a, i)));
                if prf.len() != 32 {
                    return Err(FidoError::Unavailable("authenticator returned no hmac-secret output".into()));
                }
                let ad = bytes(fido_assert_authdata_ptr(a, i), fido_assert_authdata_len(a, i));
                out.push(Assertion {
                    credential_id: bytes(fido_assert_id_ptr(a, i), fido_assert_id_len(a, i)),
                    user_handle: bytes(fido_assert_user_id_ptr(a, i), fido_assert_user_id_len(a, i)),
                    authenticator_data: unwrap_cbor_bstr(&ad).ok_or(FidoError::Unavailable("authdata".into()))?,
                    signature: bytes(fido_assert_sig_ptr(a, i), fido_assert_sig_len(a, i)),
                    client_data_json: cd.clone(),
                    prf,
                });
            }
            Ok(out)
        })();
        fido_assert_free(&mut a);
        res
    }
}

pub struct Credential {
    pub credential_id: Vec<u8>,
    pub authenticator_data: Vec<u8>,
    pub client_data_json: String,
}

/// Create a discoverable ES256 credential with hmac-secret (needed for PRF).
pub fn make_credential(
    path: &str,
    rp_id: &str,
    challenge: &[u8],
    user_id: &[u8],
    user_name: &str,
    pin: Option<&str>,
) -> Result<Credential, FidoError> {
    let dev = Dev::open(path)?;
    let cd = client_data(Ceremony::Create, challenge, Platform::Linux);
    let cdh = client_data_hash(&cd);
    let c = |s: &str| CString::new(s).map_err(|e| FidoError::Unavailable(e.to_string()));
    let (rp, name) = (c(rp_id)?, c(user_name)?);
    let pin_c = pin_bytes(pin)?;
    unsafe {
        let mut cr = fido_cred_new();
        if cr.is_null() {
            return Err(FidoError::Unavailable("libfido2 could not allocate".into()));
        }
        let res = (|| {
            ok(fido_cred_set_type(cr, COSE_ES256))?;
            ok(fido_cred_set_clientdata_hash(cr, cdh.as_ptr(), cdh.len()))?;
            ok(fido_cred_set_rp(cr, rp.as_ptr(), rp.as_ptr()))?;
            ok(fido_cred_set_user(cr, user_id.as_ptr(), user_id.len(), name.as_ptr(), name.as_ptr(), ptr::null()))?;
            ok(fido_cred_set_rk(cr, FIDO_OPT_TRUE))?;
            ok(fido_cred_set_uv(cr, FIDO_OPT_TRUE))?;
            ok(fido_cred_set_extensions(cr, FIDO_EXT_HMAC_SECRET))?;
            ok(fido_dev_make_cred(dev.0, cr, pin_c.as_ref().map_or(ptr::null(), |p| p.as_ptr() as *const c_char)))?;
            let ad = bytes(fido_cred_authdata_ptr(cr), fido_cred_authdata_len(cr));
            Ok(Credential {
                credential_id: bytes(fido_cred_id_ptr(cr), fido_cred_id_len(cr)),
                authenticator_data: unwrap_cbor_bstr(&ad).ok_or(FidoError::Unavailable("authdata".into()))?,
                client_data_json: cd.clone(),
            })
        })();
        fido_cred_free(&mut cr);
        res
    }
}

#[cfg(test)]
mod tests {
    use super::unwrap_cbor_bstr;
    #[test]
    fn cbor_bstr_unwrap() {
        assert_eq!(unwrap_cbor_bstr(&[0x43, 1, 2, 3]), Some(vec![1, 2, 3]));
        let long: Vec<u8> = std::iter::once(0x58).chain(std::iter::once(37)).chain(vec![9u8; 37]).collect();
        assert_eq!(unwrap_cbor_bstr(&long).map(|v| v.len()), Some(37));
        assert_eq!(unwrap_cbor_bstr(&[0x43, 1, 2]), None, "length mismatch refused");
        assert_eq!(unwrap_cbor_bstr(&[0x63, 1, 2, 3]), None, "a text string is not a byte string");
    }
}
