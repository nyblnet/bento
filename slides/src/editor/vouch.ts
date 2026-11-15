// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// "Who vouched" for a collaborator in the People panel (bento/id P1, with the
// option-G tiers). What may be said is decided in vouchstate.ts; this file asks
// the identity agent and paints the answer.
//
// The panel never verifies anything itself. It asks the agent the host provides
// (kernel/src/identity.ts `resolve`) and shows the answer in one of these
// states, all honest about what is and is not known:
//
//   verified    "✓ via <voucher>", plus "(passkey sign-in)", "new account" and
//               "account changed on <date>" where they apply
//   changed     the binding differs from the one this device saw before: no ✓
//   revoked     "this sign-in was revoked": no ✓; after an incident the room
//               owner also sees a flag on the row
//   unverified  the agent knows nobody by that key
//   unproven    the person's key is only CLAIMED in presence
//   failed      the agent errored, was malformed, or did not answer in time
//   checking    waiting for the agent
//
// THE PROOF RULE. A presence `pub` is a claim: anyone holding the room's read
// key can name someone else's key. A peer is looked up ONLY when the session
// says it proved that key (`session.keyProven(actor, pub)`), a method on the
// session, never a field of the peer, because a peer's presence is whatever
// that peer sent.
//
// OFF BY DEFAULT: nothing here runs unless localStorage `bento-people-vouch` is
// 'on' AND the host exposes an agent. Otherwise the People panel is unchanged.
import { identityAgent, type IdentityAgent } from '../../../kernel/src/identity.ts'
import { lsGet } from '../../../kernel/src/storage.ts'
import { claimedName, stateFromAnswer, type VouchState } from './vouchstate'

export type { VouchState } from './vouchstate'

/** How long the agent gets to answer before the row says it could not check. */
export const RESOLVE_TIMEOUT_MS = 5000
/** A settled answer is reused this long; a failure is retried sooner. */
const TTL_OK_MS = 30_000
const TTL_FAIL_MS = 5_000

export function vouchEnabled(): boolean {
  try { return lsGet('bento-people-vouch') === 'on' } catch { return false }
}

/** The agent to ask, or null when the flag is off or the host has none. */
export function vouchAgent(): IdentityAgent | null {
  return vouchEnabled() ? identityAgent() : null
}

const cache = new Map<string, { at: number; state: VouchState }>()
const inflight = new Map<string, Promise<VouchState>>()

/** What to show right now for a key, without waiting. */
function cachedState(pub: string): VouchState | undefined {
  const c = cache.get(pub)
  if (!c) return undefined
  const ttl = c.state.kind === 'failed' ? TTL_FAIL_MS : TTL_OK_MS
  return Date.now() - c.at < ttl ? c.state : undefined
}

/** Ask the agent who holds `pub`. Never rejects; a rejection, a malformed
 *  answer and a timeout are all `failed`. */
function resolvePeer(agent: IdentityAgent, pub: string): Promise<VouchState> {
  const hit = cachedState(pub)
  if (hit) return Promise.resolve(hit)
  const pending = inflight.get(pub)
  if (pending) return pending
  const p = new Promise<VouchState>((done) => {
    const timer = setTimeout(() => done({ kind: 'failed' }), RESOLVE_TIMEOUT_MS)
    let call: Promise<unknown>
    try { call = Promise.resolve(agent.resolve({ pub })) } catch { call = Promise.reject(new Error('resolve threw')) }
    call.then((r) => done(stateFromAnswer(r, Date.now())), () => done({ kind: 'failed' })).finally(() => clearTimeout(timer))
  }).then((state) => {
    cache.set(pub, { at: Date.now(), state })
    inflight.delete(pub)
    return state
  })
  inflight.set(pub, p)
  return p
}

type T = (key: string, vars?: Record<string, string | number>) => string

function day(at: number, loc: string): string {
  const d = new Date(at)
  try { return new Intl.DateTimeFormat(loc, { day: 'numeric', month: 'short', year: 'numeric' }).format(d) }
  catch { return d.toDateString() }
}

export interface PaintOpts {
  t: T
  /** the UI locale, for dates */
  locale: string
  /** the row shows the ✏️ editing mark */
  editing?: boolean
  /** the row to flag for the room owner after an incident; null when the
   *  viewer is not the owner */
  ownerRow?: HTMLElement | null
}

/** Paint one state into the row's name element. `claimed` is what the person
 *  typed; a verified name replaces it, with the typed one kept in the tooltip. */
export function paintVouch(who: HTMLElement, claimed: string, state: VouchState, o: PaintOpts): void {
  const { t } = o
  const mark = document.createElement('span')
  mark.className = 'vouch'
  mark.dataset.vouch = state.kind
  const tags: HTMLElement[] = []
  const tag = (kind: string, text: string, tip: string) => {
    const s = document.createElement('span')
    s.className = 'vouch-tag'
    s.dataset.tag = kind
    s.textContent = text
    s.title = tip
    tags.push(s)
    return tip
  }
  const label = (txt: string) => { mark.textContent = txt }
  const tips: string[] = []
  const shown = (state.kind === 'verified' || state.kind === 'changed') ? state.name : claimed
  // The name sits in its own direction-isolated span that alone takes the
  // ellipsis, so no name (long, right-to-left, or one that reads like a voucher)
  // can push the mark or the tags out of sight: they wrap below it instead.
  const nameEl = document.createElement('span')
  nameEl.className = 'vouch-name'
  nameEl.dir = 'auto'
  nameEl.textContent = o.editing ? `${shown} ✏️` : shown
  who.classList.add('vouched')
  who.replaceChildren(nameEl) // also clears any earlier mark
  switch (state.kind) {
    case 'checking': label(t('checking…')); break
    case 'verified':
      label(t('✓ via {via}', { via: state.via }))
      tips.push(state.name === claimed ? t('Verified by {via}', { via: state.via })
        : t('Verified by {via} — they call themselves “{claimed}” in this session', { via: state.via, claimed }))
      if (state.tier === 'passkey') {
        tips.push(tag('passkey', t('(passkey sign-in)'),
          t('Signed in with a passkey only, in a browser or on a new device. This kind of sign-in lasts up to a week.')))
      }
      if (state.newAccount) tips.push(tag('new', t('new account'), t('This account was set up less than 14 days ago.')))
      if (state.changedOn !== null) {
        const date = day(state.changedOn, o.locale)
        tips.push(tag('changed', t('account changed on {date}', { date }),
          t('Who can sign in to this account changed on {date}. If you didn’t expect that, check with them.', { date })))
      }
      break
    case 'changed':
      label(t('⚠ changed'))
      tips.push(t('This person’s verified identity differs from the one this device saw before. Check with them before you trust it.'))
      break
    case 'revoked':
      label(t('this sign-in was revoked'))
      tips.push(t('This sign-in was revoked, so their name is only what they typed.'))
      break
    case 'unverified':
      label(t('not verified'))
      tips.push(t('Nothing vouches for this person’s name — it is only what they typed.'))
      break
    case 'unproven':
      label(t('not verified'))
      tips.push(t('This person’s key can’t be checked yet, so their name is only what they typed.'))
      break
    case 'failed':
      label(t('couldn’t check'))
      tips.push(t('The identity service didn’t answer. Try again in a minute.'))
      break
  }
  mark.title = tips.join('\n')
  who.append(mark, ...tags)
  // the room owner's flag: a key revoked by the incident lever may have acted
  // here without its owner. One chip on the row, beside the remove control.
  const row = o.ownerRow
  if (row) {
    row.querySelector(':scope > .vouch-flag')?.remove()
    if (state.kind === 'revoked' && state.incident) {
      const flag = document.createElement('span')
      flag.className = 'vouch-flag'
      flag.textContent = '!'
      flag.title = t('This sign-in was revoked after a security incident. What this key did in this deck may not have been them: keep them, or remove this device with ✕.')
      const kick = row.querySelector(':scope > .kick')
      if (kick) row.insertBefore(flag, kick)
      else row.appendChild(flag)
    }
  }
}

/** Decorate a People row: show what is known now, then upgrade it when the
 *  agent answers. `proven` is whether the session proved the peer holds `pub`. */
export function decoratePeer(
  who: HTMLElement, claimed: string, pub: string | undefined, proven: boolean, agent: IdentityAgent, o: PaintOpts,
): void {
  const name = claimedName(claimed)
  if (!pub || !proven) { paintVouch(who, name, { kind: 'unproven' }, o); return }
  const hit = cachedState(pub)
  paintVouch(who, name, hit ?? { kind: 'checking' }, o)
  if (hit) return
  void resolvePeer(agent, pub).then((s) => { if (who.isConnected) paintVouch(who, name, s, o) })
}
