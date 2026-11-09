// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// P1: register the frame site's worker (sw-frame.js). Opened first-party by
// the person, or framed (hidden) by the top page in "frame-site worker" mode,
// where it registers in the top site's partition. Reports to the parent when
// framed.
(() => {
  'use strict'
  const tell = (result) => {
    const out = document.getElementById('out')
    if (out) out.textContent = 'Worker: ' + result
    if (window.parent !== window) { try { window.parent.postMessage({ kind: 'probe-swinstall', result }, '*') } catch { /* none */ } }
  }
  const go = () => {
    if (!('serviceWorker' in navigator)) { tell('unsupported'); return }
    navigator.serviceWorker.register('/sw-frame.js', { scope: '/' }).then(async (r) => {
      const w = r.installing || r.waiting || r.active
      if (w && w.state !== 'activated') await new Promise((res) => { w.addEventListener('statechange', () => { if (w.state === 'activated' || w.state === 'redundant') res() }); setTimeout(res, 8000) })
      tell((window.parent !== window ? 'third-party ' : 'first-party ') + ((r.active && r.active.state) || 'not active'))
    }, (e) => tell('error ' + ((e && e.name) || '') + ' ' + ((e && e.message) || '')))
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go)
  else go()
})()
