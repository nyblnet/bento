// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The isolated-world half of the bridge: a pure relay.
//
// Content scripts in the ISOLATED world can talk to the extension but cannot
// touch the page's globals; a MAIN-world script can define `showSaveFilePicker`
// but has no extension APIs. Neither half can do the job alone, so the pair
// meet over `window.postMessage`.
//
// This file deliberately holds NO logic. It does not decide what may be
// written, does not read the document, and does not touch the filesystem — it
// forwards message shapes and nothing else. Every decision that matters
// lives on the extension side, which is the only side the page cannot reach.
//
// Two transports. A save is one request and one answer, so it rides
// `sendMessage`. An assistant turn (slides/src/editor/assistant/transport.ts)
// streams: one `res` and then `evt` frames until done — so each turn opens a
// PORT, and the frames come back over it with the page's own id. The port is
// what binds the turn to this tab: an abort is posted on the port that started
// the turn, and there is no way to name anyone else's.
//
// WHAT THIS ACCEPTS IS THE SECURITY OF THE FEATURE (review of #512, §4):
// `ev.source === window` below, and the manifest's default `all_frames: false`,
// mean only the top document's own scripts can post a request here. An iframe
// on a slide — a live web embed runs with allow-scripts — can reach
// `parent.postMessage`, but its frame arrives with ITS window as the source and
// is dropped. Guarded by scripts/test-webext-assistant.ts.

const CH = '__bento_tray__'
const ASSISTANT_PORT = 'bento-assistant'
const ASSISTANT_ID = 'asst-'

/** Streaming turns in flight, by the page's request id, so an abort finds its port. */
const streams = new Map()

const post = (frame) => window.postMessage({ [CH]: true, ...frame }, '*')

/** One assistant turn over its own port; every frame back is re-posted to the page as-is. */
function streamTurn(d) {
  let port
  try {
    port = chrome.runtime.connect({ name: ASSISTANT_PORT })
  } catch (e) {
    post({ dir: 'res', id: d.id, result: { ok: false, reason: String(e?.message || e) } })
    return
  }
  streams.set(d.id, port)
  let answered = false
  port.onMessage.addListener((m) => {
    if (!m || m.id !== d.id) return
    if (m.dir === 'res') {
      answered = true
      post({ dir: 'res', id: d.id, result: m.result })
      if (!m.result?.ok) { streams.delete(d.id); port.disconnect() }
    } else if (m.dir === 'evt') {
      // `assistant.document` asks the page for the deck; `done` carries
      // prose or an ops patch (`mode`, `ops`, `note`, `focus`) — forwarded as
      // named fields, never the whole frame.
      post({ dir: 'evt', id: d.id, kind: m.kind, text: m.text, reason: m.reason, code: m.code, mode: m.mode, ops: m.ops, note: m.note, focus: m.focus })
      if (m.kind === 'assistant.done' || m.kind === 'assistant.error') { streams.delete(d.id); port.disconnect() }
    }
  })
  port.onDisconnect.addListener(() => {
    // The worker went away mid-turn (reload, eviction). The page is told once,
    // in whichever shape it is still waiting for.
    if (!streams.delete(d.id)) return
    if (!answered) post({ dir: 'res', id: d.id, result: { ok: false, reason: 'disconnected' } })
    else post({ dir: 'evt', id: d.id, kind: 'assistant.error', reason: 'disconnected' })
  })
  port.postMessage({ op: d.op, id: d.id, payload: d.payload })
}

/**
 * Say hello, once, on load.
 *
 * This is the ONLY thing here that the page did not ask for, and it exists to
 * fix a chicken-and-egg. The tray lists documents by walking granted folders,
 * but a `FileSystemDirectoryHandle` has no path, so it cannot turn one into a
 * URL to open. The path is learned by subtracting a file's route-from-the-grant
 * from its absolute `sender.url` — and that only happened during a SAVE. So on
 * a fresh install every row was listed and none could be opened, which is
 * exactly as useful as no list at all.
 *
 * Opening a document is the natural moment to learn where its folder is. One
 * document opened teaches the prefix for its whole folder, and every other
 * document in there becomes openable from the tray.
 *
 * It sends no payload — the extension reads `sender.url`, which the browser
 * stamps and this page cannot forge — and ignores the answer. A page that
 * cannot be placed inside a grant simply is not one, and nothing is written
 * either way.
 */
chrome.runtime.sendMessage({ op: 'hello' }).catch(() => {
  /* worker asleep, extension reloading, page outside every grant — all fine */
})

window.addEventListener('message', async (ev) => {
  const d = ev.data
  // Same-window only: `ev.source !== window` rejects anything posted in from a
  // frame or an opener, which is the one way a page could try to speak for
  // another document.
  if (ev.source !== window || !d || d[CH] !== true || d.dir !== 'req') return

  if (typeof d.op === 'string' && d.op.startsWith('assistant.')) {
    // The page mints these ids with a prefix of its own; anything else is not
    // the page's assistant client and gets nothing.
    if (typeof d.id !== 'string' || !d.id.startsWith(ASSISTANT_ID)) return
    if (d.op === 'assistant.send' || d.op === 'assistant.turn') return streamTurn(d)
    if (d.op === 'assistant.document' || d.op === 'assistant.check') {
      // The page's answer to the extension's ask (the material, or a dry
      // run of a patch), for a turn this tab is streaming: onto that turn's
      // port, never onto sendMessage.
      const port = streams.get(d.id)
      if (port) { try { port.postMessage({ op: d.op, id: d.id, payload: d.payload }) } catch { /* closed */ } }
      post({ dir: 'res', id: d.id, result: { ok: !!port } })
      return
    }
    if (d.op === 'assistant.abort') {
      // Only a turn THIS tab started has a port here to post on.
      const port = streams.get(d.payload?.req)
      if (port) { try { port.postMessage({ op: 'assistant.abort' }) } catch { /* already closed */ } }
      post({ dir: 'res', id: d.id, result: { ok: true } })
      return
    }
  }

  let result
  try {
    result = await chrome.runtime.sendMessage({ op: d.op, payload: d.payload })
  } catch (e) {
    // The service worker can be asleep or the extension reloading; a failure
    // here means the page falls back to the native picker, not that a save is
    // lost.
    result = { ok: false, reason: String(e?.message || e) }
  }
  window.postMessage({ [CH]: true, dir: 'res', id: d.id, result }, '*')
})
