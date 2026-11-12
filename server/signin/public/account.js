// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The sign-in host's account page (/account): sign in on this host, ask for a
// setup or reset link, and sign out every browser. It reads nothing from its
// URL and answers no message: everything here starts with the person's own
// button press on this page (account-client.js has the rules).

import { Refused, isAddress, savedAccount, signInHere, signOutEverywhere, startLink, when } from './account-client.js'

const $ = (id) => document.getElementById(id)
let busy = false

function show(state, reason) {
  document.body.dataset.state = state
  if (reason) document.body.dataset.reason = reason
  else delete document.body.dataset.reason
  for (const el of document.querySelectorAll('[data-for]')) el.hidden = el.dataset.for !== state
}

/** What a refusal means, in words. Anything unnamed: nothing changed. */
const FAILED = {
  'not-member': 'That passkey is not on a bento/id account. Nothing changed.',
  'quarantined': 'That passkey is suspended on its account, so it cannot sign in. Nothing changed.',
  'cancelled': 'The passkey prompt was closed. Nothing changed.',
  'bad-address': 'That is not an email address bento/id can use.',
  'no-account': 'There is no bento/id account for that address any more.',
  'network': 'bento/id could not be reached. Nothing changed. Try again.',
  'busy': 'Too many tries from here. Wait a while, then try again.',
}

function fail(e) {
  const reason = e instanceof Refused ? e.reason : e && e.name === 'NotAllowedError' ? 'cancelled' : 'error'
  $('failed-text').textContent = FAILED[reason] || 'Nothing changed. Try again.'
  show('failed', reason)
}

function home() {
  const account = savedAccount()
  if (!account) return show('signed-out')
  $('account').textContent = account
  for (const el of document.querySelectorAll('[data-account]')) el.textContent = account
  show('signed-in')
}

async function run(job) {
  if (busy) return
  busy = true
  try { await job() } catch (e) { fail(e) } finally { busy = false }
}

const signIn = () => run(async () => {
  show('working')
  await signInHere()
  home()
})

const ask = (kind) => run(async () => {
  const input = $(kind === 'reset' ? 'reset-email' : 'setup-email')
  const address = input.value.trim()
  if (!isAddress(address)) throw new Refused('bad-address')
  await startLink(kind, address)
  input.value = ''
  $('mailed-to').textContent = address
  show('mailed')
})

const signOutAll = () => run(async () => {
  const account = savedAccount()
  if (!account) return home()
  show('working')
  const at = await signOutEverywhere(account)
  $('signout-at').textContent = when(at)
  show('signed-out-all')
})

function start() {
  $('signin').addEventListener('click', signIn)
  $('switch').addEventListener('click', signIn)
  $('setup-start').addEventListener('click', () => ask('setup'))
  $('reset-start').addEventListener('click', () => ask('reset'))
  $('signout-ask').addEventListener('click', () => { if (!busy && savedAccount()) show('confirm-signout') })
  $('signout').addEventListener('click', signOutAll)
  for (const id of ['signout-cancel', 'mailed-back', 'signout-back', 'failed-back']) $(id).addEventListener('click', () => { if (!busy) home() })
  home()
}

start()
