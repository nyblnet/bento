// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// P1: where the frame site is, for the side pages (storage, WebMCP). The main
// page (top.js) has the same rule: ?frame=<url> overrides, remembered here.
(() => {
  'use strict'
  const DEFAULT_FRAME = 'https://bento-probe-frame.pages.dev/frame'
  const q = new URLSearchParams(location.search).get('frame')
  let url = q
  if (!url) { try { url = localStorage.getItem('probe-p1-frame') } catch { url = null } }
  try {
    const u = new URL(url || DEFAULT_FRAME)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('scheme')
    if (q) { try { localStorage.setItem('probe-p1-frame', u.href) } catch { /* none */ } }
    window.probeFrameUrl = u.href
  } catch { window.probeFrameUrl = DEFAULT_FRAME }
  window.probeFrameOrigin = new URL(window.probeFrameUrl).origin
})()
