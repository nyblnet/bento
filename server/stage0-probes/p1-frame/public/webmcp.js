// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// P1 WebMCP page (sitting C2): register one tool on the top document; the
// sandboxed frame (frame.js ?webmcp=1) tries to register one inside itself.
(() => {
  'use strict'
  const P = window.probe
  const $ = (id) => document.getElementById(id)
  const S = { topApi: 'absent', topReg: 'n/a', frameApi: 'waiting', frameReg: 'waiting', frameOrigin: '?' }
  const api = document.modelContext || navigator.modelContext
  S.topApi = document.modelContext ? 'document.modelContext' : navigator.modelContext ? 'navigator.modelContext' : 'absent'
  if (api && typeof api.registerTool === 'function') {
    try {
      S.topReg = 'pending'
      Promise.resolve(api.registerTool({
        name: 'probe_top_tool',
        description: 'Stage-0 probe: a tool registered on the TOP page. Returns a fixed string.',
        inputSchema: { type: 'object', properties: {} },
        execute: async () => ({ content: [{ type: 'text', text: 'probe_top_tool answered' }] }),
      })).then(() => { S.topReg = 'ok'; show() }, (e) => { S.topReg = 'error: ' + (e && (e.name + ' ' + e.message)); show() })
    } catch (e) { S.topReg = 'error: ' + (e && (e.name + ' ' + e.message)) }
  } else if (api) S.topReg = 'no registerTool'
  const frame = $('mcp-frame')
  addEventListener('message', (ev) => {
    if (ev.source !== frame.contentWindow || !ev.data || ev.data.kind !== 'probe-webmcp-frame') return
    S.frameApi = String(ev.data.api); S.frameReg = String(ev.data.register); S.frameOrigin = String(ev.data.origin)
    show()
  })
  frame.src = new URL('/frame?webmcp=1', window.probeFrameOrigin).href
  setTimeout(() => { if (S.frameApi === 'waiting') { S.frameApi = 'no answer in 10 s'; show() } }, 10000)
  function show() {
    $('observed').textContent = 'top page: API ' + S.topApi + ', probe_top_tool ' + S.topReg + '\n' +
      'frame (' + S.frameOrigin + '): API ' + S.frameApi + ', probe_frame_tool ' + S.frameReg
  }
  show()
  P.setupCopy(() => P.line('P1', [
    ['page', 'webmcp'], ['ua', P.browser()], ['top-api', S.topApi], ['top-register', S.topReg],
    ['frame-api', S.frameApi], ['frame-register', S.frameReg], ['frame-origin', S.frameOrigin],
    ['agent-listed', $('notes').value || '-'],
  ]))
})()
