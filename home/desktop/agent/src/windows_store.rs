// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The Windows key store: NOT BUILT. It needs a real Windows PC: NCrypt keys in
// the Microsoft Platform Crypto Provider (a real TPM), Windows Hello user
// verification for the consent key, and a measurement of what a same-user
// process can do to them (security's §29b: measure platform claims, never
// relay them). None of that can be measured on a hosted CI runner, which has no
// TPM and no Hello. Until that session, this store holds no key and refuses
// every operation, so no identity call on Windows can succeed or sign anything.

use crate::agent::{KeyRole, KeyStore, Prompt, StoreError};

pub struct WindowsStore;

const WHY: &str = "the Windows key store is not built: it needs a real Windows PC (TPM, Windows Hello)";

impl KeyStore for WindowsStore {
    fn public_key(&self, _: &KeyRole) -> Result<Option<[u8; 65]>, StoreError> {
        Err(StoreError::Unavailable(WHY.into()))
    }
    fn sign(&mut self, _: &KeyRole, _: &[u8], _: Option<&Prompt>) -> Result<[u8; 64], StoreError> {
        Err(StoreError::Unavailable(WHY.into()))
    }
    fn has_consent_key(&self) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_operation_refuses_and_there_is_no_consent_key() {
        let mut s = WindowsStore;
        for r in [KeyRole::Account, KeyRole::Device, KeyRole::Consent] {
            assert!(matches!(s.public_key(&r), Err(StoreError::Unavailable(_))));
            assert!(matches!(s.sign(&r, b"x", None), Err(StoreError::Unavailable(_))));
        }
        assert!(!s.has_consent_key());
    }
}
