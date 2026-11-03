// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// bento/connect — the passkey ceremony, in an extension page.
//
// The passkey belongs to bento.page (rp.id), so the same passkey works in the
// extension, on bento.page and in the phone apps. Chrome lets an extension
// page use rp.id bento.page only while it holds host access to bento.page
// (measured), which the extension asks for HERE, at the person's click, as an
// optional permission: no install warning, and the narrowest grant.
//
// Rules from the measurement (vault, 2026-10-18):
//   · request bento.page on EVERY ceremony, never infer it from contains()
//     (a broad grant may cover it today and be removed tomorrow);
//   · a lost-focus refusal (NotAllowedError) is not a permission problem
//     (SecurityError) — the page tells them apart.
//
// One create (resident, user-verified, PRF requested) and one get (PRF
// evaluated over "bento/id/prf/v1"): the get is what returns the PRF output
// on most authenticators. No PRF → prfOutput null (no blob; never a weaker wrap).

const BENTO_PAGE = 'https://bento.page/*'

export class PasskeyError extends Error {
  constructor(code, message) { super(message); this.code = code }
  get name() { return 'PasskeyError' }
}

/** The ceremony; must run inside the person's click. `deps` for the rig. */
export async function runPasskeyCeremony({ prfEval, label = 'Bento ID' }, deps = {}) {
  const perms = deps.permissions ?? chrome.permissions
  const creds = deps.credentials ?? navigator.credentials
  const rand = deps.rand ?? ((n) => crypto.getRandomValues(new Uint8Array(n)))
  let granted = false
  try { granted = await perms.request({ origins: [BENTO_PAGE] }) } catch { granted = false }
  if (!granted) throw new PasskeyError('permission', 'Access to bento.page was not allowed, and a Bento ID passkey needs it.')
  const map = (e) => {
    if (e?.name === 'NotAllowedError') return new PasskeyError('cancelled', 'The passkey request was cancelled, timed out, or the window lost focus.')
    if (e?.name === 'SecurityError') return new PasskeyError('permission', 'Chrome refused the passkey for bento.page; check the extension\'s site access.')
    if (e?.name === 'InvalidStateError') return new PasskeyError('exists', 'This authenticator already has a Bento ID passkey for this account.')
    return new PasskeyError('failed', e?.message || String(e))
  }
  let created
  try {
    created = await creds.create({ publicKey: {
      rp: { id: 'bento.page', name: 'Bento' },
      user: { id: rand(16), name: label, displayName: label },
      challenge: rand(32),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      attestation: 'none',
      extensions: { prf: {} },
    } })
  } catch (e) { throw map(e) }
  const credentialId = new Uint8Array(created.rawId)
  let assertion
  try {
    assertion = await creds.get({ publicKey: {
      rpId: 'bento.page', challenge: rand(32), userVerification: 'required',
      allowCredentials: [{ type: 'public-key', id: credentialId }],
      extensions: { prf: { eval: { first: prfEval } } },
    } })
  } catch (e) { throw map(e) }
  const first = assertion.getClientExtensionResults?.()?.prf?.results?.first
  const prfOutput = first ? new Uint8Array(first) : null
  return { credentialId, prfOutput: prfOutput && prfOutput.length === 32 ? prfOutput : null }
}
