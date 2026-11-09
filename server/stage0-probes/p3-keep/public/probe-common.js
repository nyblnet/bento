// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Stage-0 measurement probes: the helpers every probe page shares. Each probe
// is deployed from its own folder, so this file is COPIED into each one; the
// rig (scripts/test-stage0-probes.mjs) fails if the copies differ.
//
// Nothing here talks to a network. "Copy results" builds one line, shows it in
// the page and puts it on the clipboard; the person pastes it themselves.

(() => {
  'use strict'

  /** A short browser label: name, major version, platform hint. */
  function browser() {
    const ua = navigator.userAgent
    let m
    let name = 'unknown'
    if ((m = ua.match(/EdgA?\/(\d+)/))) name = 'Edge/' + m[1]
    else if ((m = ua.match(/OPR\/(\d+)/))) name = 'Opera/' + m[1]
    else if ((m = ua.match(/SamsungBrowser\/(\d+)/))) name = 'Samsung/' + m[1]
    else if ((m = ua.match(/CriOS\/(\d+)/))) name = 'Chrome-iOS/' + m[1]
    else if ((m = ua.match(/FxiOS\/(\d+)/))) name = 'Firefox-iOS/' + m[1]
    else if ((m = ua.match(/Firefox\/(\d+)/))) name = 'Firefox/' + m[1]
    else if ((m = ua.match(/Chrome\/(\d+)/))) name = 'Chrome/' + m[1]
    else if ((m = ua.match(/Version\/(\d+(?:\.\d+)?).*Safari/))) name = 'Safari/' + m[1]
    let os = 'other'
    if (/iPhone/.test(ua)) os = 'iPhone'
    else if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) os = 'iPad'
    else if (/Android/.test(ua)) os = 'Android'
    else if (/Macintosh|Mac OS X/.test(ua)) os = 'Mac'
    else if (/Windows/.test(ua)) os = 'Windows'
    else if (/Linux/.test(ua)) os = 'Linux'
    return name + '@' + os
  }

  /** How the page is running: an installed app window, or a browser tab. */
  function display() {
    if (navigator.standalone === true) return 'standalone'
    for (const m of ['standalone', 'minimal-ui', 'fullscreen', 'window-controls-overlay']) {
      if (matchMedia('(display-mode: ' + m + ')').matches) return m
    }
    return 'tab'
  }

  /** One value inside a results line: no separators, no line breaks, bounded. */
  function clean(v, max = 400) {
    return String(v ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\|/g, '/').trim().slice(0, max) || '-'
  }

  /** Join `[key, value]` pairs into the one line the checklist asks for. */
  function line(probe, pairs) {
    return [probe + ' v1', ...pairs.map(([k, v]) => k + '=' + clean(v))].join(' | ')
  }

  /**
   * Wire the page's Copy results button. `build()` returns the line. The line
   * always lands in #result (so it can be copied by hand when the clipboard is
   * refused); #copy-status says whether the clipboard took it.
   */
  function setupCopy(build) {
    const btn = document.getElementById('copy')
    const out = document.getElementById('result')
    const status = document.getElementById('copy-status')
    btn.addEventListener('click', async () => {
      let text
      try { text = build() } catch (e) { text = 'error building results: ' + clean(e && e.message) }
      out.value = text
      out.hidden = false
      let how = 'shown below; select it and copy by hand'
      try {
        await navigator.clipboard.writeText(text)
        how = 'copied to the clipboard'
      } catch {
        try {
          out.focus(); out.select()
          if (document.execCommand('copy')) how = 'copied to the clipboard'
        } catch { /* keep the by-hand message */ }
      }
      status.textContent = 'Results ' + how + '.'
      btn.dataset.copied = '1'
    })
  }

  window.probe = Object.freeze({ browser, display, clean, line, setupCopy })
})()
