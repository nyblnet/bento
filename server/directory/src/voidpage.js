// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 The Bento authors
//
// The VOID PAGE: the one HTML page id.bento.page serves (G3, G4, G9′.6a).
//
// A mailed void link (links.js voidLink) opens it with everything in the
// fragment: the address, a 256-bit single-use token and the kind of link.
// The rules it keeps, each of which the rigs check in a real browser:
//
// - Opening it changes nothing and sends nothing. The page loads its own
//   script and stylesheet, reads the fragment, and takes the fragment out of
//   the address bar before anything else. A mail scanner that fetches the URL
//   gets this fixed page and never the token; only a button press POSTs.
// - It is fixed text. The only thing it shows from the link is the address,
//   through textContent. Which buttons it shows comes from the link's kind,
//   but the directory decides from its own record what the token may do.
// - It runs no WebAuthn and calls no WebAuthn Signal API (the
//   Permissions-Policy stops the first; nothing stops the second, which is why
//   no other page on id.bento.page runs script at all).
// - Its headers: script and style from this origin only, nothing inline, no
//   framing, no referrer, Trusted Types with no policy, nothing cached. A
//   response that lost them would let a page that frames it or injects into
//   it press the buttons, so the rig loads it framed and injected.
//
// The wording is a DRAFT for the maintainer.

export const VOID_PATHS = Object.freeze({ page: '/void', script: '/void.js', style: '/void.css' })

/** The page's own headers. Every other id.bento.page answer keeps worker.js's BASE. */
export const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "require-trusted-types-for 'script'",
  "trusted-types 'none'",
].join('; ')

export const PAGE_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex, nofollow',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': PAGE_CSP,
  'permissions-policy': 'publickey-credentials-get=(), publickey-credentials-create=()',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
})

export const VOID_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>bento/id</title>
<link rel="stylesheet" href="/void.css">
<script src="/void.js" defer></script>
</head>
<body>
<main>
<p class="brand">bento/id</p>
<noscript><p>This page needs JavaScript. Nothing has changed.</p></noscript>
<section id="loading" data-view><p>One moment.</p></section>
<section id="change" data-view hidden>
<h1>Stop this change?</h1>
<p>A change to the passkeys on the bento/id account for <strong data-address></strong> is waiting. The email that brought you here says what it is.</p>
<p id="hint-c" hidden>If you did not ask for this, the usual cause is a page that used your own passkey: choose Cancel. Choose Remove only if you do not recognise the passkey that asked.</p>
<p id="hint-o" hidden>If you did not ask for this, choose Cancel.</p>
<p class="buttons"><button id="cancel" type="button">Cancel this change</button>
<button id="remove" type="button" class="danger" hidden>Cancel, and remove the passkey that asked for it</button></p>
</section>
<section id="reset" data-view hidden>
<h1>Stop this reset?</h1>
<p>A reset of the bento/id account for <strong data-address></strong> is waiting. When it takes effect, every passkey on the account is replaced by one new passkey.</p>
<p>If you did not ask for it, stop it. Your passkeys stay as they are.</p>
<p class="buttons"><button id="cancel-reset" type="button">Cancel this reset</button></p>
</section>
<section id="undo" data-view hidden>
<h1>Put the passkey back?</h1>
<p>A passkey on the bento/id account for <strong data-address></strong> was suspended, and will be removed. If it was the wrong passkey, put it back: it works again at once.</p>
<p class="buttons"><button id="undo-btn" type="button">Put the passkey back</button></p>
</section>
<section id="cancelled" data-view hidden>
<h1>Cancelled</h1>
<p>Nothing changed. <span id="cool"></span></p>
</section>
<section id="suspended" data-view hidden>
<h1>Cancelled, and the passkey is suspended</h1>
<p>The passkey that asked for the change can no longer be used. It will be removed at <span id="removes"></span>. We sent an email with a link that puts it back, in case it was the wrong one.</p>
</section>
<section id="restored" data-view hidden>
<h1>The passkey is back</h1>
<p>It can be used again, and it will not be removed.</p>
</section>
<section id="used" data-view hidden>
<h1>This link no longer works</h1>
<p>It was already used, or what it was for has already taken effect or been stopped. Nothing changed.</p>
</section>
<section id="bad" data-view hidden>
<h1>This link is incomplete</h1>
<p>Open it again from the email, without changing it. Nothing changed.</p>
</section>
<p id="msg" role="status"></p>
</main>
</body>
</html>
`

export const VOID_CSS = `body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#1e2a3a;background:#fff}
.brand{font-weight:600;letter-spacing:.02em;color:#5a6472}
.buttons{display:flex;flex-wrap:wrap;gap:.75rem}
button{font:inherit;padding:.6rem 1.1rem;border-radius:.4rem;border:1px solid #1e2a3a;background:#1e2a3a;color:#fff;cursor:pointer}
button.danger{background:#fff;color:#b3261e;border-color:#b3261e}
button:disabled{opacity:.5;cursor:default}
#msg:empty{display:none}
#msg{padding:.6rem .8rem;border-radius:.4rem;background:#fdf3e1}
@media (prefers-color-scheme:dark){body{background:#14181f;color:#e8ebef}.brand{color:#9aa4b2}button{background:#e8ebef;color:#14181f;border-color:#e8ebef}button.danger{background:#14181f;color:#ff8a80;border-color:#ff8a80}#msg{background:#3a2f1a}}
`

export const VOID_JS = `(() => {
  'use strict'
  const $ = (id) => document.getElementById(id)
  const show = (id) => { for (const el of document.querySelectorAll('[data-view]')) el.hidden = el.id !== id }
  const say = (t) => { $('msg').textContent = t }
  const f = new URLSearchParams(location.hash.slice(1))
  // the token leaves the address bar (and the history entry) before anything else
  if (location.hash) history.replaceState(null, '', location.pathname)
  const keys = [...f.keys()]
  const valid = keys.length === 4 && new Set(keys).size === 4 && ['v', 'e', 't', 'k'].every((k) => f.has(k)) &&
    f.get('v') === '1' && /^[A-Za-z0-9_-]{43}$/.test(f.get('t')) && ['c', 'o', 'r', 'u'].includes(f.get('k')) &&
    f.get('e').length > 0 && f.get('e').length <= 254
  if (!valid) return show('bad')
  const email = f.get('e'), token = f.get('t'), kind = f.get('k')
  for (const el of document.querySelectorAll('[data-address]')) el.textContent = email
  if (kind === 'r') show('reset')
  else if (kind === 'u') show('undo')
  else {
    show('change')
    $(kind === 'c' ? 'hint-c' : 'hint-o').hidden = false
    $('remove').hidden = kind !== 'c'
  }
  const buttons = () => document.querySelectorAll('button')
  let busy = false
  async function send(choice) {
    if (busy) return
    busy = true
    say('')
    for (const b of buttons()) b.disabled = true
    let r = null, j = {}
    try {
      r = await fetch('/v1/void', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, token, choice }), credentials: 'omit', cache: 'no-store' })
      j = await r.json()
    } catch { /* shown below */ }
    const again = (t) => { say(t); busy = false; for (const b of buttons()) b.disabled = false }
    if (r && r.ok && j.done === 'cancelled') {
      $('cool').textContent = j.until ? 'The passkey that asked for it can still sign in, but cannot ask for another change until ' + new Date(j.until).toLocaleString() + '.' : ''
      return show('cancelled')
    }
    if (r && r.ok && j.done === 'suspended') { $('removes').textContent = new Date(j.removesAt).toLocaleString(); return show('suspended') }
    if (r && r.ok && j.done === 'restored') return show('restored')
    if (!r) return again('Could not reach bento/id. Check your connection and try again. Nothing changed.')
    if (r.status === 503) return again('We could not send the email that confirms this, so nothing changed. Try again in a few minutes, or choose Cancel.')
    if (r.status === 429) return again('Too many tries from this network. Try again later. Nothing changed.')
    if (j.error === 'choice') return again('That choice is not offered for this link. Nothing changed.')
    show('used')
  }
  $('cancel').addEventListener('click', () => send('cancel'))
  $('remove').addEventListener('click', () => send('remove'))
  $('cancel-reset').addEventListener('click', () => send('cancel'))
  $('undo-btn').addEventListener('click', () => send('undo'))
})()
`
