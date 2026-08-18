// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The two auth pages: /setup (one-time, only reachable while no config row
// exists) and /login. Same hand-written, dark, no-framework aesthetic as
// demo.ts, sharing pageStyles.ts's base stylesheet.
import { PAGE_STYLES } from './pageStyles.ts'

function shell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
${PAGE_STYLES}
</style>
</head>
<body>
<div class="wrap narrow">
${body}
</div>
</body>
</html>`
}

export function renderSetupPage(): string {
  const body = `<header class="hero">
  <h1>Bento platform <span>·</span> set up</h1>
  <p class="subtitle">This runs once. Pick a username and password for the only account this
  deploy will ever have — nobody else can create one.</p>
</header>
<section class="card">
  <div class="field">
    <label for="username">Username</label>
    <input id="username" type="text" autocomplete="username" spellcheck="false">
  </div>
  <div class="field">
    <label for="password">Password</label>
    <input id="password" type="password" autocomplete="new-password">
  </div>
  <div class="field">
    <label for="password2">Confirm password</label>
    <input id="password2" type="password" autocomplete="new-password">
  </div>
  <div class="actions">
    <button id="submit" class="primary" type="button">Create account</button>
  </div>
  <div id="status" class="status"></div>
</section>
<script>
document.getElementById('submit').onclick = async () => {
  const status = document.getElementById('status')
  const username = document.getElementById('username').value.trim()
  const password = document.getElementById('password').value
  const password2 = document.getElementById('password2').value
  status.className = 'status'
  if (!username) { status.className = 'status err'; status.textContent = 'Username is required.'; return }
  if (password.length < 8) { status.className = 'status err'; status.textContent = 'Password must be at least 8 characters.'; return }
  if (password !== password2) { status.className = 'status err'; status.textContent = "Passwords don't match."; return }
  status.textContent = 'Creating…'
  status.style.display = 'block'
  try {
    const res = await fetch('/api/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    const body = await res.json()
    if (!res.ok) {
      status.className = 'status err'
      status.textContent = body.error || 'Setup failed.'
      return
    }
    location.href = '/'
  } catch (e) {
    status.className = 'status err'
    status.textContent = 'Request failed: ' + e.message
  }
}
</script>`
  return shell('Bento platform — set up', body)
}

export function renderLoginPage(opts: { error?: string } = {}): string {
  const errorBanner = opts.error
    ? `<div class="status err" style="display:block">${opts.error.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</div>`
    : ''
  const body = `<header class="hero">
  <h1>Bento platform <span>·</span> log in</h1>
  <p class="subtitle">Owner-only. Nothing here is publicly reachable except decks you've marked public.</p>
</header>
<section class="card">
  ${errorBanner}
  <div class="field">
    <label for="username">Username</label>
    <input id="username" type="text" autocomplete="username" spellcheck="false">
  </div>
  <div class="field">
    <label for="password">Password</label>
    <input id="password" type="password" autocomplete="current-password">
  </div>
  <div class="actions">
    <button id="submit" class="primary" type="button">Log in</button>
  </div>
  <div id="status" class="status"></div>
</section>
<script>
document.getElementById('password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('submit').click()
})
document.getElementById('submit').onclick = async () => {
  const status = document.getElementById('status')
  const username = document.getElementById('username').value.trim()
  const password = document.getElementById('password').value
  status.className = 'status'
  status.textContent = 'Logging in…'
  status.style.display = 'block'
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      status.className = 'status err'
      status.textContent = body.error || 'Login failed.'
      return
    }
    location.href = '/'
  } catch (e) {
    status.className = 'status err'
    status.textContent = 'Request failed: ' + e.message
  }
}
</script>`
  return shell('Bento platform — log in', body)
}
