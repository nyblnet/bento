// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Which Linux key store a machine gets, and what the person is told about it
// (security §26.3): the TPM where this user can open one, the Secret Service
// otherwise, and never the webview's storage. Pure choice logic, so the order is
// tested everywhere; the stores themselves are tpm_linux / secret_linux.

use std::path::Path;

/// The resource-manager device: the one a non-root user may be granted (tss group).
pub const TPM_DEVICE: &str = "/dev/tpmrm0";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Tpm,
    SecretService,
    None,
}

impl Kind {
    pub fn name(self) -> &'static str {
        match self {
            Kind::Tpm => "tpm",
            Kind::SecretService => "secret-service",
            Kind::None => "none",
        }
    }
    /// What this store does and does not protect, in words for the person.
    /// PLACEHOLDER WORDING for the maintainer; the FACTS are security's (§26.3).
    pub fn exposure(self) -> &'static str {
        match self {
            Kind::Tpm => "Your Bento ID key is kept in this computer's TPM and cannot be copied off it. A program running as you could still use it to sign while you are signed in.",
            Kind::SecretService => "This computer has no usable TPM, so your Bento ID key is kept in your desktop's keyring. Any program running as you can read it without asking while the keyring is unlocked.",
            Kind::None => "This computer has no key store Bento can use, so Bento ID is unavailable here.",
        }
    }
}

/// True when this user can open the TPM resource manager for reading and writing.
pub fn tpm_usable(device: &Path) -> bool {
    std::fs::OpenOptions::new().read(true).write(true).open(device).is_ok()
}

pub enum Pick<A, B> {
    Tpm(A),
    Secret(B),
    Neither,
}

/// The TPM first; the Secret Service only if the TPM did not open. The second
/// closure is not run when the first succeeds, so a machine with a TPM never
/// touches the keyring.
pub fn pick<A, B>(tpm: impl FnOnce() -> Option<A>, secret: impl FnOnce() -> Option<B>) -> Pick<A, B> {
    if let Some(a) = tpm() {
        return Pick::Tpm(a);
    }
    match secret() {
        Some(b) => Pick::Secret(b),
        None => Pick::Neither,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn the_tpm_wins_and_the_keyring_is_not_touched() {
        let touched = Cell::new(false);
        let p = pick(|| Some("tpm"), || { touched.set(true); Some("kr") });
        assert!(matches!(p, Pick::Tpm("tpm")));
        assert!(!touched.get(), "a machine with a TPM never reaches for the keyring");
    }

    #[test]
    fn no_tpm_falls_back_to_the_keyring_then_to_none() {
        assert!(matches!(pick::<&str, &str>(|| None, || Some("kr")), Pick::Secret("kr")));
        assert!(matches!(pick::<&str, &str>(|| None, || None), Pick::Neither));
    }

    #[test]
    fn a_missing_device_is_not_usable_and_the_exposure_is_stated_where_there_is_no_tpm() {
        assert!(!tpm_usable(Path::new("/nonexistent/tpmrm0")));
        assert!(Kind::SecretService.exposure().contains("Any program running as you can read it"));
        assert!(Kind::SecretService.exposure().contains("no usable TPM"));
        assert!(!Kind::Tpm.exposure().contains("can read it"), "the TPM's words do not claim the keyring's exposure");
    }
}
