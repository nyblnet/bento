// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The key store the Linux host holds: sealed to the TPM where this user can open
// one, the Secret Service otherwise (security §26.3). Private keys never leave
// the store through this type, and nothing here touches web storage.

use crate::agent::{KeyRole, KeyStore, Prompt, StoreError};
use crate::select::{pick, Kind, Pick, TPM_DEVICE};
#[cfg(feature = "tpm")]
use crate::select::tpm_usable;
use std::path::PathBuf;

pub enum LinuxStore {
    #[cfg(feature = "tpm")]
    Tpm(crate::tpm_linux::TpmStore),
    #[cfg(feature = "keyring")]
    Secret(crate::secret_linux::SecretStore),
    None,
}

pub struct Opened {
    pub store: LinuxStore,
    pub kind: Kind,
}

/// Where the TPM is reached. Production uses the resource-manager device; a
/// rig can name a software TPM's socket, or a device that is not there.
pub enum TpmSource {
    Device(PathBuf),
    Tcti(String),
}

/// Open the best store this machine has. `profile` names the keyring items;
/// `dir` holds the TPM-wrapped blobs (useless on any other TPM).
pub fn open_best(profile: &str, dir: PathBuf) -> Opened {
    open_best_with(profile, dir, TpmSource::Device(PathBuf::from(TPM_DEVICE)))
}

pub fn open_best_with(profile: &str, dir: PathBuf, source: TpmSource) -> Opened {
    let tpm = || -> Option<LinuxStore> {
        #[cfg(feature = "tpm")]
        {
            let tcti = match &source {
                TpmSource::Device(d) if tpm_usable(d) => format!("device:{}", d.display()),
                TpmSource::Device(_) => return None,
                TpmSource::Tcti(t) => t.clone(),
            };
            // The consent key's PIN prompt is not drawn yet (it needs a text
            // field the host dialogs do not have): until it is, a consent-key
            // use is declined, never defaulted.
            let pin: crate::tpm_linux::PinPrompt = Box::new(|_| None);
            return crate::tpm_linux::TpmStore::open(&tcti, dir.clone(), pin).ok().map(LinuxStore::Tpm);
        }
        #[allow(unreachable_code)]
        None
    };
    let secret = || -> Option<LinuxStore> {
        #[cfg(feature = "keyring")]
        {
            return crate::secret_linux::SecretStore::open(profile).ok().map(LinuxStore::Secret);
        }
        #[allow(unreachable_code)]
        None
    };
    let _ = (&dir, profile, &source);
    match pick(tpm, secret) {
        Pick::Tpm(s) => Opened { store: s, kind: Kind::Tpm },
        Pick::Secret(s) => Opened { store: s, kind: Kind::SecretService },
        Pick::Neither => Opened { store: LinuxStore::None, kind: Kind::None },
    }
}

impl KeyStore for LinuxStore {
    fn public_key(&self, role: &KeyRole) -> Result<Option<[u8; 65]>, StoreError> {
        match self {
            #[cfg(feature = "tpm")]
            LinuxStore::Tpm(s) => s.public_key(role),
            #[cfg(feature = "keyring")]
            LinuxStore::Secret(s) => s.public_key(role),
            LinuxStore::None => Ok(None),
        }
    }
    fn sign(&mut self, role: &KeyRole, msg: &[u8], prompt: Option<&Prompt>) -> Result<[u8; 64], StoreError> {
        match self {
            #[cfg(feature = "tpm")]
            LinuxStore::Tpm(s) => s.sign(role, msg, prompt),
            #[cfg(feature = "keyring")]
            LinuxStore::Secret(s) => s.sign(role, msg, prompt),
            LinuxStore::None => {
                let _ = (role, msg, prompt);
                Err(StoreError::NoKey)
            }
        }
    }
    fn has_consent_key(&self) -> bool {
        match self {
            #[cfg(feature = "tpm")]
            LinuxStore::Tpm(s) => s.has_consent_key(),
            #[cfg(feature = "keyring")]
            LinuxStore::Secret(s) => s.has_consent_key(),
            LinuxStore::None => false,
        }
    }
}

impl LinuxStore {
    /// Mint this device's routine key in the store (account setup calls this;
    /// the rig does too). TPM: created inside the TPM, non-exportable.
    pub fn create_device_key(&mut self) -> Result<[u8; 65], StoreError> {
        match self {
            #[cfg(feature = "tpm")]
            LinuxStore::Tpm(s) => s.create_signing_key(&KeyRole::Device, None),
            #[cfg(feature = "keyring")]
            LinuxStore::Secret(s) => s.create_device_key(),
            LinuxStore::None => Err(StoreError::Unavailable("no key store on this machine".into())),
        }
    }
    /// Remove this profile's keys from the Secret Service (rigs and device
    /// retirement). The TPM blobs are plain files in the store's directory.
    pub fn wipe(&mut self) -> Result<(), StoreError> {
        match self {
            #[cfg(feature = "tpm")]
            LinuxStore::Tpm(_) => Ok(()),
            #[cfg(feature = "keyring")]
            LinuxStore::Secret(s) => s.wipe(),
            LinuxStore::None => Ok(()),
        }
    }
}
