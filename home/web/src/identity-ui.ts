// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The one line of bento/id in the library: who is signed in here, and the
// button that opens the sign-in host. Text only (textContent): the library's
// policy requires Trusted Types and allows none, so no markup sink can run.
//
// The full pages (setup, add this browser, sign out everywhere, the setup
// text about this browser's storage) are a later change; this line is what
// the agent needs to be driven and to ask "Confirm it's you" each week.
//
// Nothing here runs until main-identity.ts calls startIdentity(), which it
// does only once the kill switch has answered that this build may run
// (offline.ts: 'current' or 'unreachable'). stopIdentity() ends it for good
// when the page stops: a withdrawn build checks in with no one.

import { Agent, indexedStore, onStoreChanged, SIGNIN_ORIGIN, CHECKIN_EVERY_MS, type Status } from './identity.ts'

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

const agent = new Agent(indexedStore, (url, init) => fetch(url, init))

const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })

const ENDED: Record<string, string> = {
  expired: 'Your sign-in in this browser has ended. Confirm it’s you to sign in again.',
  revoked: 'bento/id ended this browser’s sign-in. Confirm it’s you to sign in again.',
  incident: 'bento/id asked every browser to sign in again after a security incident. Confirm it’s you to sign in again.',
  invalid: 'This browser’s sign-in could not be checked, so it was removed. Confirm it’s you to sign in again.',
}

const FAILED: Record<string, string> = {
  blocked: 'The bento/id window could not open. Allow pop-ups for this page and try again.',
  account: 'That is a different bento/id account. Sign out here first to switch accounts.',
  incident: 'bento/id is handling a security incident. Try again later.',
  network: 'bento/id could not be reached. Try again later.',
}
const failed = (reason: string) =>
  FAILED[reason] ?? (['cancelled', 'closed', 'failed', 'timeout'].includes(reason)
    ? 'Sign-in did not finish.'
    : 'bento/id’s answer could not be checked, so this browser was not signed in.')

let note = ''
let working = false
let started = false
let stopped = false
let timer: ReturnType<typeof setInterval> | null = null
let unlisten: (() => void) | null = null

function render(s: Status) {
  const box = $('id-box'), text = $('id-text'), act = $<HTMLButtonElement>('id-act'), out = $<HTMLButtonElement>('id-out')
  if (stopped) { box.hidden = true; return }
  box.hidden = false
  box.dataset.state = working ? 'working' : s.kind === 'signed-in' && s.confirm ? 'confirm' : s.kind
  if (s.kind === 'ended') box.dataset.why = s.why
  else delete box.dataset.why
  let line: string
  if (working) line = 'Finish signing in in the bento/id window.'
  else if (s.kind === 'signed-in') {
    line = `Signed in as ${s.address} (passkey sign-in).`
    if (s.confirm) line += ` This sign-in ends ${day(s.capAt)}: confirm it’s you to keep it.`
  } else if (s.kind === 'ended') line = ENDED[s.why] ?? ENDED.expired
  else line = 'bento/id: this browser is not signed in.'
  text.textContent = note ? `${line} ${note}` : line
  act.hidden = s.kind === 'signed-in' && !s.confirm
  act.textContent = s.kind === 'none' ? 'Sign in' : 'Confirm it’s you'
  act.disabled = working
  out.hidden = s.kind === 'none' || working
}

function wire() {
  $('id-act').addEventListener('click', () => {
    if (working || stopped) return
    const s = agent.status()
    // opened here, synchronously inside the click: a browser blocks a popup opened after an await
    const win = window.open(SIGNIN_ORIGIN + '/', `bento-id-${crypto.getRandomValues(new Uint32Array(1))[0]}`, 'popup,width=480,height=640')
    working = true
    note = ''
    render(s)
    void agent.signIn(win, s.kind !== 'none').then((r) => {
      working = false
      note = r.ok ? '' : failed(r.reason)
      $('id-box').dataset.reason = r.ok ? '' : r.reason
      render(agent.status())
    })
  })
  $('id-out').addEventListener('click', () => {
    if (working || stopped) return
    note = ''
    void agent.signOut().then(() => render(agent.status()))
  })
}

/**
 * Another tab signed in, signed out or ended its sign-in: take what the store
 * now holds at once, rather than showing the old address until the next
 * hourly check-in (security ruling 948, C5 residual). The same when this tab
 * becomes visible again, for a browser that has no BroadcastChannel.
 */
async function reread() {
  if (working || stopped) return
  render(await agent.load())
}
const onVisible = () => { if (document.visibilityState === 'visible') void reread() }

/** Start bento/id in this page: only after the kill switch has said this build may run. */
export function startIdentity() {
  if (started || stopped) return
  started = true
  wire()
  unlisten = onStoreChanged(() => void reread())
  document.addEventListener('visibilitychange', onVisible)
  void (async () => {
    render(await agent.load())
    if (stopped) return
    render(await agent.checkIn())
    if (stopped) return
    $('id-box').dataset.ready = '1'   // the first check-in is done (rigs wait for it)
    timer = setInterval(async () => { if (!working && !stopped) render(await agent.checkIn()) }, CHECKIN_EVERY_MS)
  })()
}

/** Stop bento/id in this page for good: no check-in, no line, no button (the page has stopped). */
export function stopIdentity() {
  stopped = true
  if (timer !== null) clearInterval(timer)
  timer = null
  unlisten?.()
  unlisten = null
  document.removeEventListener('visibilitychange', onVisible)
  const box = document.getElementById('id-box')
  if (box) { box.hidden = true; box.dataset.state = 'stopped' }
}
