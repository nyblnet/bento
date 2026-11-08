// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The Linux TPM key store (H1b), per security §26 / §26a / §26b and the H1 key
// table:
//
// - DEVICE (routine) key: an ECC P-256 signing key CREATED IN the TPM,
//   non-exportable (fixedTPM | fixedParent | sensitiveDataOrigin), with an empty
//   authValue — no per-use prompt; the agent's session timers gate the genuine
//   agent. Residual (security): a same-user process that can open the TPM can
//   ALSO sign routine frames with it; it can never copy it off the machine.
// - CONSENT key: the same, with the person's PIN as its authValue, so EVERY
//   signature needs the PIN, and the TPM's dictionary-attack lockout limits
//   guessing. A same-user process cannot use it without the PIN.
// - ACCOUNT key (shared across devices, so it cannot be born in one TPM): a
//   sealed data object under the same PIN, unsealed only for a prompted use and
//   zeroized at once (§26b).
//
// What is stored on disk is only the TPM-WRAPPED public/private blob pair: it
// loads on THIS TPM and nowhere else, so copying the files copies nothing usable.
//
// "TPM present" means this user can open it (tss group / /dev/tpmrm0); otherwise
// the host uses the no-TPM store and says so. tss-group access is per user, so it
// adds no isolation between that user's processes.

use crate::agent::{KeyRole, KeyStore, Prompt, StoreError};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use tss_esapi::{
    attributes::ObjectAttributesBuilder,
    constants::tss::{TPM2_RH_NULL, TPM2_ST_HASHCHECK},
    handles::KeyHandle,
    interface_types::{
        algorithm::{HashingAlgorithm, PublicAlgorithm},
        ecc::EccCurve,
        key_bits::RsaKeyBits,
        resource_handles::Hierarchy,
        session_handles::AuthSession,
    },
    structures::{
        Auth, Digest as TpmDigest, EccPoint, EccScheme, HashScheme, HashcheckTicket, KeyedHashScheme, Private, Public,
        PublicBuilder, PublicEccParametersBuilder, PublicKeyedHashParameters, SensitiveData, Signature, SignatureScheme,
        SymmetricDefinitionObject,
    },
    tss2_esys::TPMT_TK_HASHCHECK,
    traits::{Marshall, UnMarshall},
    utils::create_restricted_decryption_rsa_public,
    Context, TctiNameConf,
};
use zeroize::Zeroizing;

/// Asks the person for their TPM PIN, drawn by the HOST (never the page).
/// None = they declined.
pub type PinPrompt = Box<dyn FnMut(&Prompt) -> Option<Zeroizing<String>> + Send>;

pub struct TpmStore {
    ctx: Context,
    dir: PathBuf,
    pin: PinPrompt,
}

fn tpm_err(e: impl std::fmt::Display) -> StoreError {
    StoreError::Unavailable(e.to_string())
}

fn name(role: &KeyRole) -> &'static str {
    match role {
        KeyRole::Account => "account",
        KeyRole::Device => "device",
        KeyRole::Consent => "consent",
    }
}

fn ecc_signing_public(with_auth: bool) -> Result<Public, StoreError> {
    let attrs = ObjectAttributesBuilder::new()
        .with_fixed_tpm(true)
        .with_fixed_parent(true)
        .with_sensitive_data_origin(true)
        .with_user_with_auth(true)
        .with_sign_encrypt(true)
        .with_decrypt(false)
        .with_restricted(false)
        .build()
        .map_err(tpm_err)?;
    let _ = with_auth; // the authValue is set at create; userWithAuth applies to both
    PublicBuilder::new()
        .with_public_algorithm(PublicAlgorithm::Ecc)
        .with_name_hashing_algorithm(HashingAlgorithm::Sha256)
        .with_object_attributes(attrs)
        .with_ecc_parameters(
            PublicEccParametersBuilder::new_unrestricted_signing_key(
                EccScheme::EcDsa(HashScheme::new(HashingAlgorithm::Sha256)),
                EccCurve::NistP256,
            )
            .build()
            .map_err(tpm_err)?,
        )
        .with_ecc_unique_identifier(EccPoint::default())
        .build()
        .map_err(tpm_err)
}

fn sealed_public() -> Result<Public, StoreError> {
    let attrs = ObjectAttributesBuilder::new()
        .with_fixed_tpm(true)
        .with_fixed_parent(true)
        .with_user_with_auth(true)
        .build()
        .map_err(tpm_err)?;
    PublicBuilder::new()
        .with_public_algorithm(PublicAlgorithm::KeyedHash)
        .with_name_hashing_algorithm(HashingAlgorithm::Sha256)
        .with_object_attributes(attrs)
        .with_keyed_hash_parameters(PublicKeyedHashParameters::new(KeyedHashScheme::Null))
        .with_keyed_hash_unique_identifier(TpmDigest::default())
        .build()
        .map_err(tpm_err)
}

/// Raw uncompressed point from a TPM ECC public area.
fn point(public: &Public) -> Result<[u8; 65], StoreError> {
    match public {
        Public::Ecc { unique, .. } => {
            let (x, y) = (unique.x().value(), unique.y().value());
            if x.len() > 32 || y.len() > 32 {
                return Err(StoreError::Unavailable("bad point".into()));
            }
            let mut out = [0u8; 65];
            out[0] = 4;
            out[1 + 32 - x.len()..33].copy_from_slice(x);
            out[33 + 32 - y.len()..].copy_from_slice(y);
            Ok(out)
        }
        _ => Err(StoreError::Unavailable("not an ECC key".into())),
    }
}

impl TpmStore {
    /// Open the TPM named by `tcti` (e.g. "device:/dev/tpmrm0", "swtpm:port=2321")
    /// and keep blobs in `dir`.
    pub fn open(tcti: &str, dir: PathBuf, pin: PinPrompt) -> Result<TpmStore, StoreError> {
        let conf: TctiNameConf = tcti.parse().map_err(tpm_err)?;
        let ctx = Context::new(conf).map_err(tpm_err)?;
        std::fs::create_dir_all(&dir).map_err(tpm_err)?;
        Ok(TpmStore { ctx, dir, pin })
    }

    /// The storage primary key, re-derived from its template each time (same
    /// seed + same template = same key), so no persistent handle is needed.
    fn primary(&mut self) -> Result<KeyHandle, StoreError> {
        let public = create_restricted_decryption_rsa_public(
            SymmetricDefinitionObject::AES_128_CFB,
            RsaKeyBits::Rsa2048,
            Default::default(),
        )
        .map_err(tpm_err)?;
        let r = self
            .ctx
            .execute_with_session(Some(AuthSession::Password), |c| {
                c.create_primary(Hierarchy::Owner, public, None, None, None, None)
            })
            .map_err(tpm_err)?;
        Ok(r.key_handle)
    }

    fn paths(&self, role: &KeyRole) -> (PathBuf, PathBuf) {
        (self.dir.join(format!("{}.pub", name(role))), self.dir.join(format!("{}.priv", name(role))))
    }

    fn stored(&self, role: &KeyRole) -> Result<Option<(Public, Private)>, StoreError> {
        let (pp, pv) = self.paths(role);
        if !pp.exists() {
            return Ok(None);
        }
        let public = Public::unmarshall(&std::fs::read(pp).map_err(tpm_err)?).map_err(tpm_err)?;
        let private = Private::try_from(std::fs::read(pv).map_err(tpm_err)?).map_err(tpm_err)?;
        Ok(Some((public, private)))
    }

    fn save(&self, role: &KeyRole, public: &Public, private: &Private) -> Result<(), StoreError> {
        let (pp, pv) = self.paths(role);
        std::fs::write(pp, public.marshall().map_err(tpm_err)?).map_err(tpm_err)?;
        std::fs::write(pv, private.value()).map_err(tpm_err)
    }

    /// Create the device (no auth) or consent (PIN) key in the TPM.
    pub fn create_signing_key(&mut self, role: &KeyRole, pin: Option<&str>) -> Result<[u8; 65], StoreError> {
        let parent = self.primary()?;
        let public = ecc_signing_public(pin.is_some())?;
        let auth = pin.map(|p| Auth::try_from(p.as_bytes().to_vec())).transpose().map_err(tpm_err)?;
        let r = self
            .ctx
            .execute_with_session(Some(AuthSession::Password), |c| c.create(parent, public, auth, None, None, None))
            .map_err(tpm_err)?;
        self.ctx.flush_context(parent.into()).map_err(tpm_err)?;
        self.save(role, &r.out_public, &r.out_private)?;
        point(&r.out_public)
    }

    /// Seal `secret` (the account key) under the PIN.
    pub fn seal_account(&mut self, secret: &[u8], pin: &str) -> Result<(), StoreError> {
        let parent = self.primary()?;
        let data = SensitiveData::try_from(secret.to_vec()).map_err(tpm_err)?;
        let auth = Auth::try_from(pin.as_bytes().to_vec()).map_err(tpm_err)?;
        let public = sealed_public()?;
        let r = self
            .ctx
            .execute_with_session(Some(AuthSession::Password), |c| c.create(parent, public, Some(auth), Some(data), None, None))
            .map_err(tpm_err)?;
        self.ctx.flush_context(parent.into()).map_err(tpm_err)?;
        self.save(&KeyRole::Account, &r.out_public, &r.out_private)
    }

    /// Unseal the account key for ONE prompted use; the caller zeroizes it.
    pub fn unseal_account(&mut self, prompt: &Prompt) -> Result<Zeroizing<Vec<u8>>, StoreError> {
        let (public, private) = self.stored(&KeyRole::Account)?.ok_or(StoreError::NoKey)?;
        let pin = (self.pin)(prompt).ok_or(StoreError::Declined)?;
        let parent = self.primary()?;
        let h = self
            .ctx
            .execute_with_session(Some(AuthSession::Password), |c| c.load(parent, private, public))
            .map_err(tpm_err);
        self.ctx.flush_context(parent.into()).map_err(tpm_err)?;
        let h = h?;
        self.ctx.tr_set_auth(h.into(), Auth::try_from(pin.as_bytes().to_vec()).map_err(tpm_err)?).map_err(tpm_err)?;
        let out = self.ctx.execute_with_session(Some(AuthSession::Password), |c| c.unseal(h.into()));
        let _ = self.ctx.flush_context(h.into());
        let data = out.map_err(|e| auth_failure(e.to_string()))?;
        Ok(Zeroizing::new(data.value().to_vec()))
    }
}

/// A wrong PIN is a refusal the person can retry, not an outage. Matched on the
/// TPM's OWN authorization failures only (measured on swtpm: a wrong PIN on
/// Sign and on Unseal both return TPM_RC_AUTH_FAIL, "the authorization HMAC
/// check failed and DA counter incremented"), so an unrelated error can never
/// masquerade as "the person said no".
fn auth_failure(msg: String) -> StoreError {
    const AUTH: [&str; 3] = [
        "the authorization HMAC check failed",           // TPM_RC_AUTH_FAIL (counts toward DA lockout)
        "authorization failure without DA implications", // TPM_RC_BAD_AUTH
        "authorizations for objects subject to DA protection are not allowed at this time", // TPM_RC_LOCKOUT
    ];
    if AUTH.iter().any(|a| msg.contains(a)) {
        StoreError::Declined
    } else {
        StoreError::Unavailable(msg)
    }
}

impl KeyStore for TpmStore {
    fn public_key(&self, role: &KeyRole) -> Result<Option<[u8; 65]>, StoreError> {
        match self.stored(role)? {
            Some((public, _)) if *role != KeyRole::Account => Ok(Some(point(&public)?)),
            _ => Ok(None),
        }
    }

    fn sign(&mut self, role: &KeyRole, msg: &[u8], prompt: Option<&Prompt>) -> Result<[u8; 64], StoreError> {
        if *role == KeyRole::Account {
            return Err(StoreError::Unavailable("the account key signs via unseal_account".into()));
        }
        let (public, private) = self.stored(role)?.ok_or(StoreError::NoKey)?;
        // The consent key needs the PIN on EVERY use; the device key needs none.
        let pin = if *role == KeyRole::Consent {
            let p = prompt.ok_or(StoreError::Unavailable("consent needs a prompt".into()))?;
            Some((self.pin)(p).ok_or(StoreError::Declined)?)
        } else {
            None
        };
        let parent = self.primary()?;
        let h = self.ctx.execute_with_session(Some(AuthSession::Password), |c| c.load(parent, private, public)).map_err(tpm_err);
        self.ctx.flush_context(parent.into()).map_err(tpm_err)?;
        let h = h?;
        if let Some(pin) = &pin {
            self.ctx.tr_set_auth(h.into(), Auth::try_from(pin.as_bytes().to_vec()).map_err(tpm_err)?).map_err(tpm_err)?;
        }
        let digest = TpmDigest::try_from(Sha256::digest(msg).to_vec()).map_err(tpm_err)?;
        let ticket = HashcheckTicket::try_from(TPMT_TK_HASHCHECK {
            tag: TPM2_ST_HASHCHECK,
            hierarchy: TPM2_RH_NULL,
            digest: Default::default(),
        })
        .map_err(tpm_err)?;
        let sig = self
            .ctx
            .execute_with_session(Some(AuthSession::Password), |c| c.sign(h, digest, SignatureScheme::Null, ticket));
        let _ = self.ctx.flush_context(h.into());
        match sig.map_err(|e| auth_failure(e.to_string()))? {
            Signature::EcDsa(s) => {
                let (r, s) = (s.signature_r().value(), s.signature_s().value());
                if r.len() > 32 || s.len() > 32 {
                    return Err(StoreError::Unavailable("bad signature".into()));
                }
                let mut out = [0u8; 64];
                out[32 - r.len()..32].copy_from_slice(r);
                out[64 - s.len()..].copy_from_slice(s);
                Ok(out)
            }
            _ => Err(StoreError::Unavailable("unexpected signature scheme".into())),
        }
    }

    fn has_consent_key(&self) -> bool {
        self.paths(&KeyRole::Consent).0.exists()
    }
}
