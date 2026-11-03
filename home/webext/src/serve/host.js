// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// bento/connect W2 — what the host answers on the port (pure: deps injected).
//
// The ONLY entry point for anything the served document asks. A message is
// acted on only if it has exactly the fixed shape — { id: short string,
// op: one of OPS, args: that op's typed fields, nothing else } — and the host
// never acts on a message that claims a consent outcome: consent is asked and
// answered in host chrome, never reported by the frame.
//
// Identity answers come from the extension's Bento ID (W1). Until the
// directory binds it to an address, there is no verified identity to give:
// whoami → null, sign → 'no-identity', resolve → null.

export const OPS = Object.freeze(['identity.whoami', 'identity.sign', 'identity.resolve', 'save.write', 'serve.failed'])
const SIGN_PURPOSES = ['frame', 'prove', 'delegate', 'show', 'invite', 'revoke']
const MAX_TEXT = 256 * 1024 * 1024

/** The fixed shape, or null. */
export function parseRequest(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null
  const keys = Object.keys(d).sort().join()
  if (keys !== 'args,id,op') return null
  if (typeof d.id !== 'string' || !/^[a-z0-9]{1,24}$/.test(d.id) || !OPS.includes(d.op)) return null
  const a = d.args
  const exact = (o, want) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).sort().join() === want
  switch (d.op) {
    case 'identity.whoami': return a === null ? { id: d.id, op: d.op, args: null } : null
    case 'identity.sign':
      return exact(a, 'payload,purpose') && SIGN_PURPOSES.includes(a.purpose) && typeof a.payload === 'string' && a.payload.length <= 4096 ? { id: d.id, op: d.op, args: { purpose: a.purpose, payload: a.payload } } : null
    case 'identity.resolve':
      return exact(a, 'email,pub') && (a.pub === null || typeof a.pub === 'string') && (a.email === null || typeof a.email === 'string') ? { id: d.id, op: d.op, args: { pub: a.pub, email: a.email } } : null
    case 'save.write':
      return exact(a, 'text') && typeof a.text === 'string' && a.text.length <= MAX_TEXT ? { id: d.id, op: d.op, args: { text: a.text } } : null
    case 'serve.failed':
      return exact(a, 'reason') && typeof a.reason === 'string' ? { id: d.id, op: d.op, args: { reason: a.reason.slice(0, 64) } } : null
  }
  return null
}

/** Answer one parsed request. deps: { writeFile(text) → {ok, reason?} }. */
export async function answer(req, deps) {
  switch (req.op) {
    // a Bento ID not yet bound to a verified address is no identity to give;
    // the directory slice fills these in
    case 'identity.whoami': return null
    case 'identity.sign': return { ok: false, reason: 'no-identity' }
    case 'identity.resolve': return null
    case 'save.write': return deps.writeFile(req.args.text)
    case 'serve.failed': return null
  }
  return null
}
