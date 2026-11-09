// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// P2 install probe: an installable app with file_handlers (.html), launchQueue,
// share_target and a stored FileSystemFileHandle. Measures whether an
// installed app can write the file it was handed, in place.
//
// Everything stays in this browser: the handle lives in this site's IndexedDB,
// a shared file in this site's Cache Storage (put there by sw.js). Nothing is
// sent to any server.

(() => {
  'use strict'
  const P = window.probe
  const $ = (id) => document.getElementById(id)

  // --- tiny IndexedDB key/value ------------------------------------------------
  const dbp = new Promise((resolve, reject) => {
    const r = indexedDB.open('probe-p2', 1)
    r.onupgradeneeded = () => r.result.createObjectStore('kv')
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
  const kv = (mode, fn) => dbp.then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction('kv', mode)
    const q = fn(tx.objectStore('kv'))
    tx.oncomplete = () => resolve(q && q.result)
    tx.onerror = () => reject(tx.error)
  }))
  const kvGet = (k) => kv('readonly', (s) => s.get(k))
  const kvSet = (k, v) => kv('readwrite', (s) => s.put(v, k))
  const kvDel = (k) => kv('readwrite', (s) => s.delete(k))

  const S = {
    fsa: typeof window.showOpenFilePicker === 'function' ? 'yes' : 'no',
    launchQueue: 'launchQueue' in window ? 'yes' : 'no',
    sw: 'unsupported', opened: 'none', write: 'not tried', storedHandle: 'no', reloadPerm: 'n/a',
    requestPerm: 'not asked', launch: 'no', launchPerm: 'n/a', share: 'no', errors: [],
  }
  let handle = null // FileSystemFileHandle, when we have one
  let file = null // File, when all we have is bytes (input / share target)
  let lastText = null

  const err = (where, e) => { S.errors.push(where + ': ' + ((e && (e.name + ' ' + e.message)) || e)); show() }

  // --- worker (offline + the share target) -----------------------------------------
  if ('serviceWorker' in navigator) {
    S.sw = navigator.serviceWorker.controller ? 'controlled' : 'registering'
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(
      (r) => { if (!navigator.serviceWorker.controller) S.sw = r.active ? 'active-not-controlling' : 'installing'; show() },
      (e) => { S.sw = 'error ' + (e && e.message); show() })
  }

  // --- launched with a file (file_handlers) ------------------------------------------
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async (params) => {
      if (!params.files || !params.files.length) return
      handle = params.files[0]
      file = null
      S.launch = 'yes'
      S.opened = 'launch'
      try { S.launchPerm = await handle.queryPermission({ mode: 'readwrite' }) } catch (e) { S.launchPerm = 'error ' + (e && e.name) }
      try { await kvSet('handle', handle); S.storedHandle = 'yes' } catch (e) { err('store handle', e) }
      show()
    })
  }

  // --- a stored handle from an earlier visit ---------------------------------------------
  kvGet('handle').then(async (h) => {
    if (!h) return
    S.storedHandle = 'yes (from an earlier visit)'
    try { S.reloadPerm = await h.queryPermission({ mode: 'readwrite' }) } catch (e) { S.reloadPerm = 'error ' + (e && e.name) }
    if (!handle) { handle = h; if (S.opened === 'none') S.opened = 'stored handle' }
    $('reconnect').hidden = false
    show()
  }, (e) => err('read stored handle', e))

  // --- a shared file (share_target, answered by sw.js) -----------------------------------
  if (new URLSearchParams(location.search).get('shared') === '1') {
    caches.open('probe-p2-shared').then((c) => c.match('/shared-file')).then(async (r) => {
      if (!r) { S.share = 'redirected but nothing stored'; show(); return }
      const blob = await r.blob()
      const name = r.headers.get('x-probe-name') || 'shared.html'
      file = new File([blob], name, { type: 'text/html' })
      handle = null
      S.opened = 'share'
      S.share = 'received ' + blob.size + ' bytes (worker: ' + (r.headers.get('x-probe-sw-online') === 'false' ? 'offline' : 'online') + ', page ' + (navigator.onLine ? 'online' : 'offline') + ')'
      show()
    }, (e) => err('read shared file', e))
  }

  // --- buttons ----------------------------------------------------------------------------------
  $('open').addEventListener('click', async () => {
    if (typeof window.showOpenFilePicker === 'function') {
      try {
        const [h] = await window.showOpenFilePicker({ types: [{ description: 'HTML document', accept: { 'text/html': ['.html', '.htm'] } }] })
        handle = h; file = null; S.opened = 'picker'
        try { await kvSet('handle', h); S.storedHandle = 'yes' } catch (e) { err('store handle', e) }
        $('reconnect').hidden = false
      } catch (e) { if (!(e && e.name === 'AbortError')) err('picker', e) }
      show()
    } else $('file').click()
  })
  $('file').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0]
    if (!f) return
    file = f; handle = null; S.opened = 'input (no handle)'
    show()
  })
  $('reconnect').addEventListener('click', async () => {
    const h = await kvGet('handle').catch(() => null)
    if (!h) return
    try { S.requestPerm = await h.requestPermission({ mode: 'readwrite' }) } catch (e) { S.requestPerm = 'error ' + (e && e.name) }
    handle = h; file = null
    show()
  })
  $('forget').addEventListener('click', async () => {
    await kvDel('handle').catch(() => {})
    S.storedHandle = 'no'; $('reconnect').hidden = true
    show()
  })

  const MARK = /<!-- stage-0 probe P2 edit [^>]*-->\s*$/
  const mark = (text) => {
    const line = '<!-- stage-0 probe P2 edit ' + new Date().toISOString() + ' -->\n'
    return MARK.test(text) ? text.replace(MARK, line) : text + (text.endsWith('\n') ? '' : '\n') + line
  }

  $('save').addEventListener('click', async () => {
    if (handle) {
      try {
        const q = await handle.queryPermission({ mode: 'readwrite' })
        if (q !== 'granted') { S.requestPerm = await handle.requestPermission({ mode: 'readwrite' }) }
        const before = await handle.getFile()
        const text = mark(await before.text())
        const w = await handle.createWritable()
        await w.write(text)
        await w.close()
        const after = await handle.getFile()
        const back = await after.text()
        S.write = back === text ? 'in place, read back ok' : 'in place, read back DIFFERS'
        if (after.lastModified === before.lastModified) S.write += ', lastModified unchanged'
      } catch (e) { S.write = 'error ' + ((e && e.name) || '') + ' ' + ((e && e.message) || '') }
      show()
      return
    }
    if (file) {
      lastText = mark(await file.text())
      const a = document.createElement('a')
      a.href = URL.createObjectURL(new Blob([lastText], { type: 'text/html' }))
      a.download = file.name
      document.body.appendChild(a); a.click(); a.remove()
      S.write = 'no handle: download offered'
      $('share').hidden = !(navigator.canShare && navigator.canShare({ files: [new File([lastText], file.name, { type: 'text/html' })] }))
      show()
      return
    }
    S.write = 'nothing open'
    show()
  })
  $('share').addEventListener('click', async () => {
    if (!file || lastText == null) return
    try {
      await navigator.share({ files: [new File([lastText], file.name, { type: 'text/html' })] })
      S.write = 'no handle: shared through the share sheet'
    } catch (e) { S.write = 'share sheet: ' + (e && e.name) }
    show()
  })

  function show() {
    $('where').textContent = 'Running as: ' + P.display() + ' · file APIs: picker ' + S.fsa + ', launchQueue ' + S.launchQueue + ' · worker: ' + S.sw
    $('observed').textContent = [
      'opened: ' + S.opened + (handle ? ' (a handle)' : file ? ' (bytes only)' : ''),
      'stored handle: ' + S.storedHandle + ' · permission after reload: ' + S.reloadPerm + ' · after asking: ' + S.requestPerm,
      'launched with a file: ' + S.launch + ' · its permission: ' + S.launchPerm,
      'shared file: ' + S.share,
      'save: ' + S.write,
      S.errors.length ? 'errors: ' + S.errors.slice(-3).join('; ') : 'errors: none',
    ].join('\n')
  }
  show()

  P.setupCopy(() => P.line('P2', [
    ['ua', P.browser()], ['display', P.display()], ['fsa', S.fsa], ['launchQueue', S.launchQueue], ['sw', S.sw],
    ['opened', S.opened], ['write', S.write], ['stored-handle', S.storedHandle], ['reload-perm', S.reloadPerm],
    ['request-perm', S.requestPerm], ['launch', S.launch], ['launch-perm', S.launchPerm], ['share', S.share],
    ['prompt', $('m-prompt').value || '-'], ['open-with', $('m-openwith').value], ['disk-changed', $('m-disk').value],
    ['errors', S.errors.length ? S.errors.length + ' ' + S.errors[S.errors.length - 1] : '0'], ['notes', $('notes').value || '-'],
  ]))
})()
