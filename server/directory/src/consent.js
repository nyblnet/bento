// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Consent the directory verifies itself: audience `dir` (threat model §24,
// §27; identity-directory §9.6c). Two forms, one rule: the directory
// RECOMPUTES the transcript from ITS audience, the challenge IT issued (already
// marked spent by the caller) and the payload it is about to apply. It never
// trusts a transcript carried in the request.
//
//  · native hosts: a `cns.` signed by a hardware consent key, certified by a
//    `dev.` that the binding's CURRENT account key signed;
//  · the light tier (no consent key): a WebAuthn assertion whose
//    clientDataJSON.challenge is b64u(SHA-256(the exact cns. bytes)). Here the
//    directory does not even parse a cns. from the request: it BUILDS the only
//    cns. it would accept, with kernel's builder, from its own values plus the
//    requested expiry, and requires the assertion to carry that hash.
//
// Every layout and verifier is the kernel's; this file only chooses inputs.

import {
  buildConsent, consentTranscript, CONSENT_MAX_TTL_MS, verifyConsent, verifyDev, webauthnChallengeFor,
} from './statements.js'
import { consentOrigins, credKey } from './webauthn.js'

export const AUDIENCE = 'dir'
export const RP = 'bento'

/**
 * @param env      the Worker env (CRED namespace, DEV/DEV_ORIGINS)
 * @param o.scope  the address storage name (the challenge's scope; a credential must belong to it)
 * @param o.accountPub the LIVE binding's account key, the only key that may certify a consent key
 * @param o.purpose the consent purpose this action needs ('rotate', …)
 * @param o.challenge the dir challenge, ALREADY SPENT by the caller
 * @param o.payloadText the exact statement the directory is about to apply
 * @param o.consent { dev, devSig, cns, cnsSig } | { webauthn: {credentialId, authenticatorData, clientDataJSON, signature}, exp }
 */
export async function verifyDirConsent(env, o) {
  const no = (reason) => ({ ok: false, reason })
  const c = o.consent
  if (!c || typeof c !== 'object') return no('consent')

  if (typeof c.cns === 'string') {
    const dev = await verifyDev(c.dev, c.devSig, { now: o.now })
    if (!dev.ok) return no(`dev:${dev.reason}`)
    if (dev.value.accountPub !== o.accountPub) return no('dev:account')
    if (!dev.value.consentPub) return no('dev:no-consent-key') // the light tier signs no cns.
    const v = await verifyConsent(c.cns, c.cnsSig, {
      consentPub: dev.value.consentPub, rp: RP, audience: AUDIENCE, challenge: o.challenge,
      payloadText: o.payloadText, docId: null, now: o.now,
      spend: () => true, // spent by the caller, first, before any of this ran
    })
    if (!v.ok) return no(`cns:${v.reason}`)
    if (v.value.purpose !== o.purpose) return no('cns:purpose')
    return { ok: true, via: 'consent-key' }
  }

  if (c.webauthn && typeof c.webauthn === 'object') {
    const exp = c.exp
    if (!Number.isSafeInteger(exp) || o.now >= exp) return no('expired')
    if (exp - o.now > CONSENT_MAX_TTL_MS) return no('lifetime')
    const transcript = await consentTranscript(AUDIENCE, o.challenge, o.payloadText)
    if (!transcript) return no('transcript')
    const cns = buildConsent({ rp: RP, purpose: o.purpose, docId: null, transcript, exp })
    const key = await credKey(c.webauthn.credentialId)
    if (!key) return no('credential')
    const stub = env.CRED.get(env.CRED.idFromName(key))
    const r = await (await stub.fetch('https://cred/op', {
      method: 'POST',
      body: JSON.stringify({
        op: 'assert', scope: o.scope, challenge: await webauthnChallengeFor(cns),
        assertion: c.webauthn, origins: [...consentOrigins(env)],
      }),
    })).json()
    return r.ok ? { ok: true, via: 'webauthn' } : no(`webauthn:${r.reason}`)
  }

  return no('consent')
}
