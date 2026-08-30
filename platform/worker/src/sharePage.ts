// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The password gate a non-owner hits at /d/:id (or /d/:id/download) when the
// deck has a share password set (migrations/0008_share_password.sql) and the
// request carries no valid unlock cookie yet — see index.ts's handleView.
// Same hand-written, no-framework aesthetic as authPages.ts/demo.ts, sharing
// pageStyles.ts's base stylesheet. Deliberately its OWN small page rather
// than a variant of the real doc/iframe view: the whole point of a
// server-side gate is that the protected content is never sent to the
// browser until the password is verified, so this page cannot know or hint
// at anything about what it's protecting.
import { PAGE_STYLES } from './pageStyles.ts'

export function renderDeckPasswordGate(id: string, download: boolean): string {
  const unlockUrl = `/api/decks/${id}/unlock`
  const targetUrl = download ? `/d/${id}/download` : `/d/${id}`
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Password required</title>
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="apple-touch-icon" href="/favicon.png">
<style>
${PAGE_STYLES}
</style>
</head>
<body>
<div class="wrap narrow">
<header class="hero">
  <h1>Password <span>required</span></h1>
  <p class="subtitle">This deck is protected. Enter the password to continue.</p>
</header>
<section class="card">
  <div class="field">
    <label for="password">Password</label>
    <input id="password" type="password" autocomplete="current-password">
  </div>
  <div class="actions">
    <button id="submit" class="primary" type="button">Unlock</button>
  </div>
  <div id="status" class="status"></div>
</section>
<script>
document.getElementById('password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('submit').click()
})
document.getElementById('submit').onclick = async () => {
  const status = document.getElementById('status')
  const password = document.getElementById('password').value
  status.className = 'status'
  status.textContent = 'Checking…'
  status.style.display = 'block'
  try {
    const res = await fetch(${JSON.stringify(unlockUrl)}, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      status.className = 'status err'
      status.textContent = body.error || 'Incorrect password.'
      return
    }
    location.href = ${JSON.stringify(targetUrl)}
  } catch (e) {
    status.className = 'status err'
    status.textContent = 'Request failed: ' + e.message
  }
}
</script>
</div>
</body>
</html>`
}
