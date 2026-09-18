// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The per-document assistant prompt. background.js opens this window with the
// facts in the query string and waits for ONE message back; the answer is
// persisted there, not here, and only from a sender that is this page.
//
// The heartbeat port is the other half of "waits": a service worker idles
// out after thirty seconds without an event, and a person reading a question
// can take longer. Each message on a port is an event, so a ping every twenty
// seconds keeps the worker — and the request that is waiting on this answer —
// alive until a button is pressed or the window is closed.

import { t, localize, initI18n } from './i18n.js'

const q = new URLSearchParams(location.search)
const doc = q.get('doc') ?? ''
const host = q.get('host') ?? ''
const model = q.get('model') ?? ''
const nonce = q.get('nonce') ?? ''

await initI18n()
localize()

let path = doc
try { path = decodeURIComponent(new URL(doc).pathname) } catch { /* shown as given */ }
document.getElementById('name').textContent = path.split('/').filter(Boolean).pop() || path
document.getElementById('path').textContent = path
document.getElementById('lead').textContent = t('consentLead', host, model)

let port = null
try {
  port = chrome.runtime.connect({ name: `bento-consent:${nonce}` })
  const beat = setInterval(() => { try { port.postMessage('ping') } catch { clearInterval(beat) } }, 20_000)
  port.onDisconnect.addListener(() => clearInterval(beat))
} catch { /* the worker will simply have to be quick */ }

async function answer(allow) {
  try { await chrome.runtime.sendMessage({ op: 'assistant.consent', nonce, doc, host, allow }) } catch { /* worker gone; nothing to record */ }
  window.close()
}
document.getElementById('allow').onclick = () => answer(true)
document.getElementById('deny').onclick = () => answer(false)
// A closed window is a "not now": the heartbeat port disconnects, and the
// worker resolves the waiting request as declined. Esc closes.
addEventListener('keydown', (e) => { if (e.key === 'Escape') answer(false) })
document.getElementById('allow').focus()
