// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// bento/connect W2 — the host page: open a file WITH identity.
//
//   serve.html?path=/Users/you/Decks/Q3.bento.html
//
// 1. Read the file's bytes ourselves (file access) — what is verified is what
//    is served, so there is no gap between the check and the use.
// 2. Gate 1 against the held signed histories (serve/history.js — fetched
//    here only if NONE is held yet; otherwise on its own daily cadence).
// 3. UNKNOWN → open the file as itself, in this tab, without identity.
//    GENUINE → serve it into the sandbox frame with its plan and ONE port.
// 4. Answer only on that port, only fixed-shape requests (serve/host.js).

import { prepare } from './prepare.js'
import { heldHistories, refresh, USED_KEY } from './history.js'
import { parseRequest, answer } from './host.js'
import { RELEASE_KEY } from '../release.js'
import { APPS } from '../library.js'
import { servedOpenEnabled } from './gate.js'

const path = new URLSearchParams(location.search).get('path') ?? ''
const fileUrl = 'file://' + path.split('/').map(encodeURIComponent).join('/')
const asItself = (why) => { console.info('[bento/connect] opening without identity:', why); location.replace(fileUrl) }

const storage = {
  get: async (k) => (await chrome.storage.local.get(k))[k] ?? null,
  set: async (k, v) => { await chrome.storage.local.set({ [k]: v }) },
}
const histDeps = { ...storage, fetch: (u, o) => fetch(u, o), now: () => Date.now(), jwk: RELEASE_KEY }
const apps = APPS.map(({ id, appId }) => ({ id, appId }))

async function main() {
  // both gates (serve/gate.js), checked HERE too: the page is reachable by URL
  if (!(await servedOpenEnabled())) return asItself('Open with Bento ID is off')
  if (!path.startsWith('/') || !path.endsWith('.bento.html')) return asItself('not a Bento document path')
  let html
  try {
    const r = await fetch(fileUrl)
    if (!r.ok) return asItself(`could not read it (${r.status})`)
    html = await r.text()
  } catch (e) { return asItself(`could not read it (${e?.message})`) }

  await storage.set(USED_KEY, true)
  let held = await heldHistories(histDeps)
  if (!Object.keys(held).length) { await refresh(apps, histDeps).catch(() => {}); held = await heldHistories(histDeps) }
  const v = await prepare(html, held)
  if (v.verdict !== 'genuine') return asItself(v.reason)

  document.title = path.split('/').pop()
  const frame = document.createElement('iframe')
  frame.src = chrome.runtime.getURL('src/serve/sandbox.html')
  const onReady = (ev) => {
    if (ev.source !== frame.contentWindow || ev.data?.kind !== 'bento-serve-ready') return
    removeEventListener('message', onReady)
    const { port1, port2 } = new MessageChannel()
    port1.onmessage = async (e) => {
      const req = parseRequest(e.data)
      if (!req) { console.info('[bento/connect] refused a malformed request'); return }
      const result = await answer(req, {
        writeFile: (text) => chrome.runtime.sendMessage({ op: 'serve.write', payload: { path, text } }),
      }).catch((err) => ({ ok: false, reason: String(err?.message ?? err) }))
      port1.postMessage({ id: req.id, result: result ?? null })
    }
    frame.contentWindow.postMessage({ kind: 'bento-serve', html, plan: v.plan, name: path.split('/').pop() }, '*', [port2])
  }
  addEventListener('message', onReady)
  document.body.appendChild(frame)
}
main()
