// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// bento/home in your browser: the offline worker and the kill switch.
//
// On every load the library asks the signed release channel one question:
// has THIS build been withdrawn? The answer is a small manifest,
// `<release base>home/status.json`, signed with the release key (the same
// envelope as every release artifact):
//
//   { "app": "bento-home-status", "seq": 7, "at": "<ISO time>", "withdrawn": ["<build>", …] }
//
// where <build> is the hex sha256 of the library's one script (the build
// prints it, and the served CSP names it). Then:
//
//   - unreachable or 404 (offline, or nothing published yet): carry on. A
//     returning visit must open offline, so silence is not a withdrawal.
//   - signed, for this app, not older than the newest seen, and this build is
//     NOT listed: carry on, and register the worker.
//   - this build IS listed: withdraw (below).
//   - anything else that came back (a bad signature, another app's payload, an
//     older seq than this browser has seen, a malformed payload): fail CLOSED,
//     exactly as if withdrawn.
//
// Withdrawing unregisters every worker on this origin, deletes every cache,
// closes the open document and replaces the page with a fixed message (nothing
// from the manifest is ever shown). The next online load then comes from the
// server, whatever it serves now.
//
// No file opens until the check has answered (library.ts awaits `ready`), so a
// withdrawn build never runs a document, even for a person who drops a file
// the moment the page appears.
//
// What this cannot do: stop a build that does not run this check (a hostile
// deploy ships its own code and its own worker). That needs the host to answer
// the worker's update request itself (D5 c); see home/web/README.md.

import { verifySigned } from '../../webext/src/release.js'
import type { Jwk } from './verify.ts'

/** The one worker script, by exact URL: the library's CSP worker-src names it, and the Trusted Types policy allows only it. */
export const SW_PATH = '/sw.js'
/** The newest status seq this browser has taken. Not document data: one number. */
const SEQ_KEY = 'bento-home-status-seq'
/** Builds this browser has seen withdrawn: a copy served again from any cache stops without asking the network. */
const GONE_KEY = 'bento-home-withdrawn'
const STATUS_APP = 'bento-home-status'
const STATUS_MS = 8000

// The library's own script text, read while it runs: its sha256 is the build id.
const SELF = document.currentScript?.textContent ?? ''

export type Status = 'current' | 'unreachable' | 'withdrawn' | 'refused'

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('')
const mark = (k: string, v: string) => document.documentElement.setAttribute(k, v)

export async function buildId(): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(SELF)))
}

function seenSeq(): number {
  try { const n = Number(localStorage.getItem(SEQ_KEY)); return Number.isSafeInteger(n) && n > 0 ? n : 0 } catch { return 0 }
}
function keepSeq(n: number) {
  try { localStorage.setItem(SEQ_KEY, String(n)) } catch { /* storage refused: the check still ran */ }
}
function goneList(): string[] {
  try { const v = JSON.parse(localStorage.getItem(GONE_KEY) ?? '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [] } catch { return [] }
}
function keepGone(build: string) {
  try { localStorage.setItem(GONE_KEY, JSON.stringify([build, ...goneList().filter((b) => b !== build)].slice(0, 64))) } catch { /* storage refused */ }
}

/** Judge a status envelope for this build. Exported for node rigs. */
export async function judgeStatus(raw: string, key: Jwk, build: string, seen: number): Promise<{ status: Status; seq?: number; why?: string }> {
  let p: Record<string, unknown>
  try { p = await verifySigned(raw, 'bento/home status', key) as Record<string, unknown> } catch (e) { return { status: 'refused', why: String((e as Error)?.message ?? e) } }
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { status: 'refused', why: 'malformed' }
  if (p.app !== STATUS_APP) return { status: 'refused', why: `a payload for ${String(p.app)}` }
  const seq = p.seq
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1) return { status: 'refused', why: 'malformed seq' }
  if (!Array.isArray(p.withdrawn) || !p.withdrawn.every((w) => typeof w === 'string' && /^[0-9a-f]{64}$/.test(w))) return { status: 'refused', why: 'malformed list' }
  if (seq < seen) return { status: 'refused', why: `older than one already seen (${seq} < ${seen})` }
  return { status: p.withdrawn.includes(build) ? 'withdrawn' : 'current', seq }
}

/** Unregister every worker on this origin and delete every cache. */
async function cleanUp() {
  try { for (const r of await navigator.serviceWorker?.getRegistrations() ?? []) await r.unregister() } catch { /* no worker API */ }
  try { for (const k of await caches.keys()) await caches.delete(k) } catch { /* no caches API */ }
}

type SwPolicy = { createScriptURL(u: string): unknown }
type TT = { createPolicy(n: string, p: { createScriptURL(u: string): string }): SwPolicy }

/**
 * The Trusted Types policy, made NOW, while this script is the only code the
 * page has run, before the status check awaits anything. The library's CSP
 * allows one policy by this name, once: made later, any code that ran during
 * the (up to 8 s) status check could take the name first and stop the worker
 * from registering (security ruling 954, C6). It passes only the worker's URL.
 */
const SW_POLICY: SwPolicy | null | 'failed' = (() => {
  const tt = (globalThis as { trustedTypes?: TT }).trustedTypes
  if (!tt) return null
  try { return tt.createPolicy('bento-sw', { createScriptURL: (u) => { if (u !== SW_PATH) throw new TypeError('not the library worker'); return u } }) } catch { return 'failed' }
})()

function register() {
  const sw = navigator.serviceWorker
  if (!sw) { mark('data-bento-sw', 'unsupported'); return }
  // Trusted Types: this page's CSP allows ONE policy, by name, and it passes only the worker's URL.
  let url: unknown = SW_PATH
  if (SW_POLICY === 'failed') { mark('data-bento-sw', 'failed'); return }
  try { if (SW_POLICY) url = SW_POLICY.createScriptURL(SW_PATH) } catch { mark('data-bento-sw', 'failed'); return }
  sw.register(url as string, { scope: '/', updateViaCache: 'none' }).then(
    () => mark('data-bento-sw', 'registered'),
    () => mark('data-bento-sw', 'failed'),
  )
}

/**
 * Every tab of this library hears a stop. A tab that finds its build
 * withdrawn (or its status untrustworthy) tells the others, and each one
 * running the SAME build stops too, at once: without this, a second tab kept
 * running the withdrawn build until it was reloaded (security ruling 954, C6),
 * and with it bento/id's hourly check-ins. A tab of another build ignores it.
 */
const STOP_CHANNEL = 'bento-home-stop'
type Stop = { t: 'stop'; build: string; status: 'withdrawn' | 'refused' }
function stopChannel(): BroadcastChannel | null {
  try { return typeof BroadcastChannel === 'function' ? new BroadcastChannel(STOP_CHANNEL) : null } catch { return null }
}

/**
 * Check the status, then (unless withdrawn) register the worker. Resolves
 * true when documents may open. `onStop` takes over the page when not, and
 * also when another tab of this build is stopped later (it runs at most once).
 */
export function startOffline(opts: { releaseBase: string; key: Jwk; onStop: (status: 'withdrawn' | 'refused') => void }): Promise<boolean> {
  mark('data-bento-status', 'checking')
  const channel = stopChannel()
  let stopped = false
  const stop = (status: 'withdrawn' | 'refused') => {
    if (stopped) return
    stopped = true
    opts.onStop(status)
  }
  return (async () => {
    const build = await buildId()
    mark('data-bento-build', build)
    if (channel) channel.onmessage = (e: MessageEvent) => {
      const d = e.data as Partial<Stop> | null
      if (!d || d.t !== 'stop' || d.build !== build || (d.status !== 'withdrawn' && d.status !== 'refused')) return
      if (d.status === 'withdrawn') keepGone(build)
      stop(d.status)
      mark('data-bento-status', d.status)
    }
    let status: Status = 'unreachable'
    let raw: string | null = null
    // seen withdrawn before: stop now, whatever served this copy (an HTTP cache offline, a stale edge)
    if (goneList().includes(build)) status = 'withdrawn'
    else try {
      const ac = new AbortController()
      const t = setTimeout(() => ac.abort(), STATUS_MS)
      const r = await fetch(`${opts.releaseBase}home/status.json`, { cache: 'no-store', credentials: 'omit', redirect: 'error', signal: ac.signal })
      if (r.ok) raw = await r.text()
      clearTimeout(t)
    } catch { raw = null }
    if (raw !== null && status !== 'withdrawn') {
      const v = await judgeStatus(raw, opts.key, build, seenSeq())
      status = v.status
      if (v.seq && status !== 'refused') keepSeq(v.seq)
      if (v.why) console.warn('[bento/home] status refused:', v.why)
    }
    if (status === 'withdrawn' || status === 'refused') {
      if (status === 'withdrawn') keepGone(build)
      try { channel?.postMessage({ t: 'stop', build, status } satisfies Stop) } catch { /* no other tab to tell */ }
      stop(status)
      await cleanUp()
      mark('data-bento-status', status)
      return false
    }
    // a stop from another tab may have arrived while this one was checking
    if (stopped) return false
    mark('data-bento-status', status)
    register()
    return true
  })()
}
