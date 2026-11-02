// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The Linux key store for a machine WITHOUT a usable TPM (the no-TPM column of
// the H1 key table): the freedesktop Secret Service (GNOME Keyring, KWallet),
// reached through the DISTRIBUTION's libsecret over a thin in-tree FFI — the
// same "distro C library + thin FFI" rule as libfido2 (security §34). This
// replaced the secret-service crate, whose zbus 5 tree carried three RustSec
// "unmaintained" notices.
//
// STATED EXPOSURE (security §26): the keyring is unlocked at login, so ANY
// process running as this user can read these keys silently — routine and
// account alike. There is no consent key here, so every AAL3 action is refused
// and routed to a phone or a security key (§2e (E)); an org's attestation policy
// can refuse such machines. The host must say this when it falls back here.
//
// Keys are software P-256 scalars stored as keyring secrets (hex), copied into
// Zeroizing buffers on read; libsecret's own copy is freed with
// secret_password_free, which clears it first. Errors are tri-state: any
// libsecret error is Unavailable; only a successful empty lookup is absent.

use crate::agent::{KeyRole, KeyStore, Prompt, StoreError};
use p256::ecdsa::{signature::Signer, Signature, SigningKey};
use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int, c_uint, c_void};
use std::ptr;
use zeroize::Zeroizing;

const APP: &str = "page.bento.home";

#[repr(C)]
struct SecretSchemaAttribute {
    name: *const c_char,
    kind: c_int, // SECRET_SCHEMA_ATTRIBUTE_STRING = 0
}
#[repr(C)]
struct SecretSchema {
    name: *const c_char,
    flags: c_int, // SECRET_SCHEMA_NONE = 0
    attributes: [SecretSchemaAttribute; 32],
    reserved: c_int,
    reserved1: *mut c_void,
    reserved2: *mut c_void,
    reserved3: *mut c_void,
    reserved4: *mut c_void,
    reserved5: *mut c_void,
    reserved6: *mut c_void,
    reserved7: *mut c_void,
}
// Immutable after construction; only pointers to static strings.
unsafe impl Sync for SecretSchema {}
unsafe impl Send for SecretSchema {}

#[repr(C)]
struct GError {
    domain: u32,
    code: c_int,
    message: *const c_char,
}

const SECRET_SEARCH_ALL: c_int = 1 << 1;

#[link(name = "secret-1")]
extern "C" {
    fn secret_password_store_sync(
        schema: *const SecretSchema,
        collection: *const c_char,
        label: *const c_char,
        password: *const c_char,
        cancellable: *mut c_void,
        error: *mut *mut GError,
        ...
    ) -> c_int;
    fn secret_password_lookup_sync(
        schema: *const SecretSchema,
        cancellable: *mut c_void,
        error: *mut *mut GError,
        ...
    ) -> *mut c_char;
    fn secret_password_clear_sync(
        schema: *const SecretSchema,
        cancellable: *mut c_void,
        error: *mut *mut GError,
        ...
    ) -> c_int;
    fn secret_password_search_sync(
        schema: *const SecretSchema,
        flags: c_int,
        cancellable: *mut c_void,
        error: *mut *mut GError,
        ...
    ) -> *mut c_void;
    fn secret_password_free(password: *mut c_char);
}
#[link(name = "glib-2.0")]
extern "C" {
    fn g_error_free(e: *mut GError);
    fn g_list_length(l: *mut c_void) -> c_uint;
    fn g_list_free_full(l: *mut c_void, free: unsafe extern "C" fn(*mut c_void));
}
#[link(name = "gobject-2.0")]
extern "C" {
    fn g_object_unref(o: *mut c_void);
}

fn schema() -> &'static SecretSchema {
    static NAME: &[u8] = b"page.bento.home.Key\0";
    static A: &[u8] = b"application\0";
    static P: &[u8] = b"profile\0";
    static R: &[u8] = b"role\0";
    static SCHEMA: std::sync::OnceLock<SecretSchema> = std::sync::OnceLock::new();
    SCHEMA.get_or_init(|| {
        let empty = || SecretSchemaAttribute { name: ptr::null(), kind: 0 };
        let mut attributes: [SecretSchemaAttribute; 32] = std::array::from_fn(|_| empty());
        attributes[0] = SecretSchemaAttribute { name: A.as_ptr().cast(), kind: 0 };
        attributes[1] = SecretSchemaAttribute { name: P.as_ptr().cast(), kind: 0 };
        attributes[2] = SecretSchemaAttribute { name: R.as_ptr().cast(), kind: 0 };
        SecretSchema {
            name: NAME.as_ptr().cast(),
            flags: 0,
            attributes,
            reserved: 0,
            reserved1: ptr::null_mut(),
            reserved2: ptr::null_mut(),
            reserved3: ptr::null_mut(),
            reserved4: ptr::null_mut(),
            reserved5: ptr::null_mut(),
            reserved6: ptr::null_mut(),
            reserved7: ptr::null_mut(),
        }
    })
}

/// Take ownership of a GError: its message, as Unavailable.
unsafe fn take_err(e: *mut GError) -> StoreError {
    let msg = if (*e).message.is_null() { "libsecret error".into() } else { CStr::from_ptr((*e).message).to_string_lossy().into_owned() };
    g_error_free(e);
    StoreError::Unavailable(msg)
}

fn role_name(role: &KeyRole) -> &'static str {
    match role {
        KeyRole::Account => "account",
        KeyRole::Device => "device",
        KeyRole::Consent => "consent",
    }
}

fn hex(b: &[u8]) -> Zeroizing<String> {
    Zeroizing::new(b.iter().map(|x| format!("{x:02x}")).collect())
}
fn unhex(s: &str) -> Option<Zeroizing<Vec<u8>>> {
    if s.len() % 2 != 0 {
        return None;
    }
    let mut out = Zeroizing::new(Vec::with_capacity(s.len() / 2));
    for i in (0..s.len()).step_by(2) {
        out.push(u8::from_str_radix(s.get(i..i + 2)?, 16).ok()?);
    }
    Some(out)
}

pub struct SecretStore {
    profile: CString,
}

/// The attribute values for one role, as C strings that outlive the call.
struct Attrs {
    app: CString,
    profile: CString,
    role: CString,
}

impl SecretStore {
    pub fn open(profile: &str) -> Result<SecretStore, StoreError> {
        Ok(SecretStore { profile: CString::new(profile).map_err(|e| StoreError::Unavailable(e.to_string()))? })
    }

    fn attrs(&self, role: &KeyRole) -> Attrs {
        Attrs { app: CString::new(APP).unwrap(), profile: self.profile.clone(), role: CString::new(role_name(role)).unwrap() }
    }

    fn read(&self, role: &KeyRole) -> Result<Option<Zeroizing<Vec<u8>>>, StoreError> {
        let a = self.attrs(role);
        let mut err: *mut GError = ptr::null_mut();
        unsafe {
            let p = secret_password_lookup_sync(
                schema(), ptr::null_mut(), &mut err,
                c"application".as_ptr(), a.app.as_ptr(), c"profile".as_ptr(), a.profile.as_ptr(),
                c"role".as_ptr(), a.role.as_ptr(), ptr::null::<c_char>(),
            );
            if !err.is_null() {
                if !p.is_null() {
                    secret_password_free(p);
                }
                return Err(take_err(err));
            }
            if p.is_null() {
                return Ok(None); // a SUCCESSFUL lookup that found nothing
            }
            let s = Zeroizing::new(CStr::from_ptr(p).to_string_lossy().into_owned());
            secret_password_free(p); // clears libsecret's copy, then frees it
            unhex(&s).map(Some).ok_or_else(|| StoreError::Unavailable("malformed stored key".into()))
        }
    }

    fn write(&self, role: &KeyRole, secret: &[u8]) -> Result<(), StoreError> {
        let a = self.attrs(role);
        let label = CString::new(format!("Bento ID {} key", role_name(role))).unwrap();
        let value = hex(secret);
        let value_c = Zeroizing::new(CString::new(value.as_str()).unwrap().into_bytes_with_nul());
        let mut err: *mut GError = ptr::null_mut();
        unsafe {
            let ok = secret_password_store_sync(
                schema(), ptr::null(), label.as_ptr(), value_c.as_ptr().cast(), ptr::null_mut(), &mut err,
                c"application".as_ptr(), a.app.as_ptr(), c"profile".as_ptr(), a.profile.as_ptr(),
                c"role".as_ptr(), a.role.as_ptr(), ptr::null::<c_char>(),
            );
            if !err.is_null() {
                return Err(take_err(err));
            }
            if ok == 0 {
                return Err(StoreError::Unavailable("the keyring refused to store the key".into()));
            }
        }
        Ok(())
    }

    /// Items of one role, locked OR unlocked (SECRET_SEARCH_ALL).
    fn count_role(&self, role: &KeyRole) -> Result<usize, StoreError> {
        let a = self.attrs(role);
        let mut err: *mut GError = ptr::null_mut();
        unsafe {
            let list = secret_password_search_sync(
                schema(), SECRET_SEARCH_ALL, ptr::null_mut(), &mut err,
                c"application".as_ptr(), a.app.as_ptr(), c"profile".as_ptr(), a.profile.as_ptr(),
                c"role".as_ptr(), a.role.as_ptr(), ptr::null::<c_char>(),
            );
            if !err.is_null() {
                if !list.is_null() {
                    g_list_free_full(list, g_object_unref);
                }
                return Err(take_err(err));
            }
            let n = if list.is_null() { 0 } else { g_list_length(list) as usize };
            if !list.is_null() {
                g_list_free_full(list, g_object_unref);
            }
            Ok(n)
        }
    }

    /// Mint the routine device key in software and store it. There is no
    /// consent key here (AAL3 is routed elsewhere).
    pub fn create_device_key(&self) -> Result<[u8; 65], StoreError> {
        // The OS random source; an RNG failure is an error, never a panic.
        let key = <SigningKey as p256::elliptic_curve::Generate>::try_generate().map_err(|e| StoreError::Unavailable(format!("random: {e}")))?;
        let d = Zeroizing::new(key.to_bytes().to_vec());
        self.write(&KeyRole::Device, &d)?;
        Ok(key.verifying_key().to_sec1_point(false).as_bytes().try_into().unwrap())
    }

    /// Store the account key's scalar. Readable by any same-user process.
    pub fn store_account(&self, scalar: &[u8]) -> Result<(), StoreError> {
        self.write(&KeyRole::Account, scalar)
    }

    /// The account scalar for one prompted use; zeroized when dropped.
    pub fn account(&self) -> Result<Zeroizing<Vec<u8>>, StoreError> {
        self.read(&KeyRole::Account)?.ok_or(StoreError::NoKey)
    }

    /// Remove every key of this profile (device retirement, the wipe path).
    /// Reports success only when NOTHING of this profile remains, locked or not
    /// (security, #779 review): a keyring that cannot be unlocked here makes
    /// wipe FAIL; it never pretends.
    pub fn wipe(&self) -> Result<(), StoreError> {
        for role in [KeyRole::Account, KeyRole::Device, KeyRole::Consent] {
            let a = self.attrs(&role);
            let mut err: *mut GError = ptr::null_mut();
            unsafe {
                secret_password_clear_sync(
                    schema(), ptr::null_mut(), &mut err,
                    c"application".as_ptr(), a.app.as_ptr(), c"profile".as_ptr(), a.profile.as_ptr(),
                    c"role".as_ptr(), a.role.as_ptr(), ptr::null::<c_char>(),
                );
                if !err.is_null() {
                    return Err(take_err(err));
                }
            }
            let left = self.count_role(&role)?;
            if left > 0 {
                return Err(StoreError::Unavailable(format!("wipe incomplete: {left} {} key item(s) remain", role_name(&role))));
            }
        }
        Ok(())
    }

    /// How many items of this profile exist, locked or not (rigs).
    #[doc(hidden)]
    pub fn count_items(&self) -> Result<usize, StoreError> {
        let mut n = 0;
        for role in [KeyRole::Account, KeyRole::Device, KeyRole::Consent] {
            n += self.count_role(&role)?;
        }
        Ok(n)
    }
}

impl KeyStore for SecretStore {
    fn public_key(&self, role: &KeyRole) -> Result<Option<[u8; 65]>, StoreError> {
        if *role != KeyRole::Device {
            return Ok(None);
        }
        match self.read(role)? {
            Some(d) => {
                let key = SigningKey::from_slice(&d).map_err(|e| StoreError::Unavailable(e.to_string()))?;
                Ok(Some(key.verifying_key().to_sec1_point(false).as_bytes().try_into().unwrap()))
            }
            None => Ok(None),
        }
    }

    fn sign(&mut self, role: &KeyRole, msg: &[u8], _prompt: Option<&Prompt>) -> Result<[u8; 64], StoreError> {
        if *role != KeyRole::Device {
            // No consent key on a no-TPM machine; the account key is used by the
            // account flows via `account()`, never through `sign`.
            return Err(StoreError::Unavailable("no hardware consent key on this machine".into()));
        }
        let d = self.read(role)?.ok_or(StoreError::NoKey)?;
        let key = SigningKey::from_slice(&d).map_err(|e| StoreError::Unavailable(e.to_string()))?;
        let sig: Signature = key.sign(msg);
        Ok(sig.to_bytes().into())
    }

    fn has_consent_key(&self) -> bool {
        false
    }
}
