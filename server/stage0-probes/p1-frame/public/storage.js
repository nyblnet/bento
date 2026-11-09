// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// P1 storage page (sitting A3): asks the framed frame site to run its four
// storage checks (storage-frame.js) and shows the answer. Nothing leaves the
// browser.
(() => {
  'use strict'
  const P = window.probe
  const $ = (id) => document.getElementById(id)
  const frame = $('store-frame')
  frame.src = new URL('/storage-frame', window.probeFrameOrigin).href
  let R = null
  addEventListener('message', (ev) => {
    if (ev.source !== frame.contentWindow || !ev.data || ev.data.kind !== 'probe-storage') return
    R = ev.data.result
    $('observed').textContent = [
      '1. localStorage: ' + R.ls,
      '2. IndexedDB: ' + R.idb,
      '3. cookie: ' + R.cookie,
      '4. storage access: ' + R.sa,
    ].join('\n')
  })
  $('run').addEventListener('click', () => {
    $('observed').textContent = 'Running…'
    frame.contentWindow.postMessage({ kind: 'probe-storage-run' }, window.probeFrameOrigin)
    setTimeout(() => { if (!R) $('observed').textContent = 'The frame did not answer in 10 s (is the frame site reachable?).' }, 10000)
  })
  P.setupCopy(() => P.line('P1', [
    ['page', 'storage'], ['ua', P.browser()], ['frame', window.probeFrameOrigin],
    ['ls', R ? R.ls : 'not run'], ['idb', R ? R.idb : 'not run'], ['cookie', R ? R.cookie : 'not run'], ['sa', R ? R.sa : 'not run'],
    ['notes', $('notes').value || '-'],
  ]))
})()
