// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// bento/connect — creating a Bento ID in the extension (W1b, identity-design §2e
// "Setup", §2f, security §28).
//
// One ceremony, on this device, with no server yet (the directory binding,
// the email code and the blob upload come with the directory client):
//
//   1. an ACCOUNT key (the person) and a DEVICE key (this browser profile);
//   2. the device certificate `dev.` — the account key vouching for the device
//      key — with an EMPTY consent slot: the light tier has no hardware consent
//      key, and its high-authority consent is verified by the directory (§27);
//   3. a PASSKEY for bento.page, evaluated with the PRF extension over the fixed
//      input "bento/id/prf/v1": its output seals the account scalar into a
//      blob only that passkey can open (kernel sealPrfBlob);
//   4. a RECOVERY CODE (80 random bits, shown ONCE, never stored): Argon2id
//      stretches it into the key for a second blob (sealRecoveryInner), and a
//      separate salt gives the verifier the directory will hold.
//
// THE ACCOUNT KEY (security §28): generated extractable ONLY inside this
// function, used to make the blobs and sign the certificate, then re-imported
// NON-extractable for routine use. The raw scalar, the PRF output and the wrap
// key are zeroed before returning — best effort: JavaScript may have copied
// them first (stated, not hidden). Never exported or stored as raw bytes by our
// code; the browser still keeps the non-extractable key's material in the
// profile, readable by same-user malware (security §20).
//
// A WAY BACK IS REQUIRED. A Bento ID with neither a PRF passkey blob nor a
// recovery blob would be lost the moment the extension is uninstalled, so
// setup refuses rather than create one. A passkey without PRF gets NO blob
// (never a weaker wrap); a device that cannot run Argon2id at 64 MiB gets no
// recovery code (RecoveryUnavailable). Either alone is enough.
//
// Pure: WebAuthn, Argon2id, randomness and time come in as `deps`, so
// scripts/test-webext-connect.ts runs this exact code in node.

import { buildDev, verifyDev, signStatement, CERT_MAX_MS, b64uEnc, b64uDec } from './gen/statements.js'
import { PRF_INPUT, sealPrfBlob, sealRecoveryInner, recoveryWrapKey, recoveryVerifier, formatRecoveryCode, SALT_LEN, CODE_BYTES } from './gen/recovery.js'

const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' }
const te = new TextEncoder()
export const PRF_EVAL = te.encode(PRF_INPUT)

export class SetupRefused extends Error {
  constructor(reason) { super(reason); this.reason = reason }
  get name() { return 'SetupRefused' }
}

const rawPub = async (subtle, publicKey) => b64uEnc(new Uint8Array(await subtle.exportKey('raw', publicKey)))
const wipe = (...arrays) => { for (const a of arrays) if (a instanceof Uint8Array) a.fill(0) }

/**
 * Create a Bento ID. Returns `{ record, recoveryCode }`: the record to store
 * (keys non-extractable, blobs, certificate), and the code to show the person
 * ONCE — it appears nowhere in the record.
 *
 * deps: { subtle, rand(n), now(), argon2id(password, salt), passkey({ prfEval })
 *         → { credentialId: Uint8Array, prfOutput: Uint8Array|null } }
 * `passkey` may throw (cancelled, permission refused): setup then stops and
 * nothing is created. A null prfOutput means the authenticator has no PRF.
 */
export async function createBentoId({ label = null } = {}, deps) {
  const { subtle, rand, now, argon2id, passkey } = deps
  const created = now()
  const account = await subtle.generateKey(ECDSA, true, ['sign', 'verify'])
  const device = await subtle.generateKey(ECDSA, false, ['sign', 'verify'])
  const accountPub = await rawPub(subtle, account.publicKey)
  const devicePub = await rawPub(subtle, device.publicKey)
  // the raw scalar the blobs carry (WebCrypto exposes it only through a JWK, so
  // one base64url string of it exists briefly; strings can't be zeroed — stated)
  const accountD = b64uDec((await subtle.exportKey('jwk', account.privateKey)).d)
  const secrets = [accountD]
  try {
    // 2. the device certificate, checked by the reference verifier before use
    const devText = buildDev({ devicePub, consentPub: null, accountPub, kx: null, label, created, expires: created + Math.floor(CERT_MAX_MS) - 86_400_000 })
    const devSig = await signStatement(account.privateKey, devText)
    const devOk = await verifyDev(devText, devSig, { now: created })
    if (!devOk.ok) throw new SetupRefused(`the device certificate does not verify (${devOk.reason})`)

    // 3. the passkey and its PRF blob
    const pk = await passkey({ prfEval: PRF_EVAL })
    const passkeys = []
    if (pk.prfOutput) {
      secrets.push(pk.prfOutput)
      const blob = await sealPrfBlob({ prfOutput: pk.prfOutput, credentialId: pk.credentialId, salt: rand(32), iv: rand(12), keys: { account: accountD } })
      passkeys.push({ credentialId: b64uEnc(pk.credentialId), blob, added: created })
    }

    // 4. the recovery code and its blob
    let recovery = null
    let recoveryCode = null
    try {
      const code = rand(CODE_BYTES)
      secrets.push(code)
      const salt = rand(SALT_LEN), saltV = rand(SALT_LEN), iv = rand(12)
      const wrapKey = await recoveryWrapKey(code, salt, argon2id)
      secrets.push(wrapKey)
      const verifier = await recoveryVerifier(code, saltV, argon2id)
      const inner = await sealRecoveryInner({ wrapKey, iv, accountPub, keys: { account: accountD } })
      // the verifier and the inner blob wait here only until the directory takes them
      recovery = { salt: b64uEnc(salt), saltV: b64uEnc(saltV), iv: b64uEnc(iv), inner: b64uEnc(inner), verifier: b64uEnc(verifier) }
      recoveryCode = formatRecoveryCode(code)
    } catch (e) {
      if (e?.name !== 'RecoveryUnavailable') throw e
    }

    if (!passkeys.length && !recovery) throw new SetupRefused('no way back: the passkey has no PRF and this device cannot make a recovery code')

    // the account key for routine use: NON-extractable from here on
    // (through PKCS#8 bytes, which can be zeroed, rather than a JWK's strings, which can't)
    const pkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', account.privateKey))
    secrets.push(pkcs8)
    const accountKey = await subtle.importKey('pkcs8', pkcs8, ECDSA, false, ['sign'])
    const record = {
      v: 1,
      state: 'local',          // not yet bound to an address (the directory comes next)
      label, created,
      accountPub, accountKey,
      devicePub, deviceKey: device.privateKey,
      dev: { text: devText, sig: devSig },
      passkeys,
      recovery,                // null on a device that cannot run Argon2id at 64 MiB
    }
    return { record, recoveryCode }
  } finally {
    wipe(...secrets)
  }
}
