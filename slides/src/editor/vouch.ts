// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// "Who vouched" for a collaborator in the People panel (bento/id P1).
//
// The panel never verifies anything itself. It asks the identity agent the host
// provides (kernel/src/identity.ts `resolve`) and shows the answer, in one of
// six states that are all honest about what is and is not known:
//
//   verified    the agent found a binding for this person's key
//   changed     ... but it differs from the one this device saw before
//   unverified  the agent knows nobody by that key
//   unproven    the person's key is only CLAIMED in presence (see below)
//   failed      the agent errored, was malformed, or did not answer in time
//   checking    waiting for the agent
//
// THE PROOF RULE. A presence beat is not signed (docs/collab-design.md): anyone
// holding the room's read key can put any `pub` in theirs, including someone
// else's device key. Asking the agent about a claimed key and showing a ✓ would
// let a reader borrow another person's tick. So a peer is resolved ONLY when
// the kernel session says its key is proven (`session.keyProven(actor, pub)`,
// which does not exist yet: it needs signed presence). It is a METHOD on the
// session, never a field of the peer, because a peer's presence is whatever
// that peer sent. Until the kernel provides it no peer is proven, and the
// flag must stay off.
//
// OFF BY DEFAULT: nothing in this file runs unless localStorage
// `bento-people-vouch` is 'on' AND the host exposes an agent. With no agent the
// People panel is exactly what it was.
import { identityAgent, type IdentityAgent, type ResolvedIdentity } from '../../../kernel/src/identity.ts'
import { lsGet } from '../../../kernel/src/storage.ts'

export type VouchState =
  | { kind: 'checking' }
  | { kind: 'verified'; name: string; via: string }
  | { kind: 'changed'; name: string; via: string }
  | { kind: 'unverified' }
  | { kind: 'unproven' }
  | { kind: 'failed' }

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

// control chars, zero-width and bidi marks: nothing the agent returns may reorder or hide text
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩﻿]/g
// tick-like marks: a typed name must not be able to draw its own
const TICKS = /[✓✔✅☑☒❗\u{1F5F8}]/gu

/** Agent-supplied text made safe to show: no invisible or bidi characters, bounded. */
export function cleanText(s: unknown, max: number): string {
  if (typeof s !== 'string') return ''
  const c = s.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim()
  return c.length > max ? c.slice(0, max - 1) + '…' : c
}

/** A name somebody TYPED, with any tick marks removed so it can't pose as a ✓. */
export function claimedName(s: string): string {
  return cleanText(s.replace(TICKS, ''), 80)
}

/** Validate an agent answer: anything malformed is a failure, never a ✓. */
export function stateFromAnswer(r: ResolvedIdentity | null): VouchState {
  if (r === null) return { kind: 'unverified' }
  if (typeof r !== 'object') return { kind: 'failed' }
  const name = cleanText(r.name, 80)
  const via = cleanText(r.vouchedBy, 80)
  if (!name || !via || typeof r.changed !== 'boolean') return { kind: 'failed' }
  return r.changed ? { kind: 'changed', name, via } : { kind: 'verified', name, via }
}

const cache = new Map<string, { at: number; state: VouchState }>()
const inflight = new Map<string, Promise<VouchState>>()

export function forgetVouchCache(): void { cache.clear(); inflight.clear() }

/** What to show right now for a key, without waiting. */
export function cachedState(pub: string): VouchState | undefined {
  const c = cache.get(pub)
  if (!c) return undefined
  const ttl = c.state.kind === 'failed' ? TTL_FAIL_MS : TTL_OK_MS
  return Date.now() - c.at < ttl ? c.state : undefined
}

/** Ask the agent who holds `pub`. Never rejects; a rejection, a malformed
 *  answer and a timeout are all `failed`. */
export function resolvePeer(agent: IdentityAgent, pub: string): Promise<VouchState> {
  const hit = cachedState(pub)
  if (hit) return Promise.resolve(hit)
  const pending = inflight.get(pub)
  if (pending) return pending
  const p = new Promise<VouchState>((done) => {
    const timer = setTimeout(() => done({ kind: 'failed' }), RESOLVE_TIMEOUT_MS)
    let call: Promise<ResolvedIdentity | null>
    try { call = Promise.resolve(agent.resolve({ pub })) } catch { call = Promise.reject(new Error('resolve threw')) }
    call.then((r) => done(stateFromAnswer(r)), () => done({ kind: 'failed' })).finally(() => clearTimeout(timer))
  }).then((state) => {
    cache.set(pub, { at: Date.now(), state })
    inflight.delete(pub)
    return state
  })
  inflight.set(pub, p)
  return p
}

type T = (key: string, vars?: Record<string, string | number>) => string

/** Paint one state into the row's name element. `claimed` is what the person
 *  typed; a verified name replaces it, with the typed one kept in the tooltip. */
export function paintVouch(who: HTMLElement, claimed: string, state: VouchState, t: T, editing = false): void {
  const mark = document.createElement('span')
  mark.className = 'vouch'
  mark.dataset.vouch = state.kind
  const label = (txt: string) => { mark.textContent = ' ' + txt }
  let title = ''
  const shown = (state.kind === 'verified' || state.kind === 'changed') ? state.name : claimed
  who.textContent = editing ? `${shown} ✏️` : shown // also clears any earlier mark
  switch (state.kind) {
    case 'checking': label(t('checking…')); break
    case 'verified':
      label(t('✓ via {via}', { via: state.via }))
      title = state.name === claimed ? t('Verified by {via}', { via: state.via })
        : t('Verified by {via} — they call themselves “{claimed}” in this session', { via: state.via, claimed })
      break
    case 'changed':
      label(t('⚠ changed'))
      title = t('This person’s verified identity differs from the one this device saw before. Check with them before you trust it.')
      break
    case 'unverified':
      label(t('not verified'))
      title = t('Nothing vouches for this person’s name — it is only what they typed.')
      break
    case 'unproven':
      label(t('not verified'))
      title = t('This person’s key can’t be checked yet, so their name is only what they typed.')
      break
    case 'failed':
      label(t('couldn’t check'))
      title = t('The identity service didn’t answer. Try again in a minute.')
      break
  }
  if (title) mark.title = title
  who.appendChild(mark)
}

/** Decorate a People row: show what is known now, then upgrade it when the
 *  agent answers. `proven` is whether the session proved the peer holds `pub`. */
export function decoratePeer(
  who: HTMLElement, claimed: string, pub: string | undefined, proven: boolean, agent: IdentityAgent, t: T, editing = false,
): void {
  const name = claimedName(claimed)
  if (!pub || !proven) { paintVouch(who, name, { kind: 'unproven' }, t, editing); return }
  const hit = cachedState(pub)
  paintVouch(who, name, hit ?? { kind: 'checking' }, t, editing)
  if (hit) return
  void resolvePeer(agent, pub).then((s) => { if (who.isConnected) paintVouch(who, name, s, t, editing) })
}
