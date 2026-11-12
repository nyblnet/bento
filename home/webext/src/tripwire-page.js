// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The tripwire's report page: one recorded check (?id=…), or the newest, and
// the recent ones. It reads the record tripwire.js wrote and changes nothing.
// Rule and verdict names are shown as they are recorded (`bytes`, `scripts`,
// `csp`…): they are what a report to the Bento team needs to quote.

import { t, localize, initI18n } from './i18n.js'

const LOG_KEY = 'tripwireLog'
const $ = (id) => document.getElementById(id)

await initI18n()
localize()
document.title = t('twPageTitle')
const log = (await chrome.storage.local.get(LOG_KEY))[LOG_KEY] ?? []
const want = new URLSearchParams(location.search).get('id')
const ev = (want && log.find((e) => e.id === want)) || log[0] || null

if (ev) {
  const listBad = ev.list?.status === 'invalid' || ev.list?.status === 'conflict'
  const bad = ev.verdict === 'mismatch' || listBad
  $('verdict').hidden = false
  $('verdict').classList.toggle('bad', bad)
  // literal keys, so the catalogue rig can see every one is used
  $('title').textContent = listBad ? t('twListTitle')
    : ev.verdict === 'mismatch' ? t('twMismatchTitle')
    : ev.verdict === 'outdated' ? t('twOldTitle')
    : t('twPageTitle')
  $('meta').textContent = `${ev.at} · ${ev.url} · ${ev.verdict}${ev.serial != null ? ` · #${ev.serial}` : ''}`
  $('todo').hidden = !bad
  $('report').hidden = !bad
  for (const f of ev.failures ?? []) {
    const c = document.createElement('code')
    c.textContent = f.rule
    $('rules').append(c)
  }
  $('details').hidden = false
  $('details').textContent = JSON.stringify(ev, null, 2)
  $('copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(JSON.stringify(ev, null, 2)); $('copy').textContent = t('twPageCopied') } catch { /* selectable below */ }
  })
}
$('none').hidden = log.length > 0
for (const e of log.slice(0, 20)) {
  const li = document.createElement('li')
  const a = document.createElement('a')
  a.href = `?id=${encodeURIComponent(e.id)}`
  a.textContent = `${e.at} · ${e.verdict} · ${e.url}`
  li.append(a)
  $('recent').append(li)
}
