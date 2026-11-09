// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// P1 storage page, the framed side: four checks, run when the embedding page
// asks. Each writes a timestamp and reports the one the previous run left.
(() => {
  'use strict'
  const KEY = 'probe-p1-storage'
  const now = new Date().toISOString()
  const err = (e) => 'throws ' + ((e && e.name) || 'error')

  function ls() {
    try {
      const prev = localStorage.getItem(KEY)
      localStorage.setItem(KEY, now)
      return (localStorage.getItem(KEY) === now ? 'works' : 'write lost') + ', previous ' + (prev || 'none')
    } catch (e) { return err(e) }
  }
  function idb() {
    return new Promise((resolve) => {
      let req
      try { req = indexedDB.open(KEY, 1) } catch (e) { resolve(err(e)); return }
      req.onupgradeneeded = () => req.result.createObjectStore('kv')
      req.onerror = () => resolve('open error ' + ((req.error && req.error.name) || ''))
      req.onsuccess = () => {
        const db = req.result
        try {
          const tx = db.transaction('kv', 'readwrite')
          const st = tx.objectStore('kv')
          const g = st.get('at')
          g.onsuccess = () => {
            const prev = g.result
            st.put(now, 'at')
            tx.oncomplete = () => { db.close(); resolve('works, previous ' + (prev || 'none')) }
            tx.onerror = () => resolve('write error')
          }
        } catch (e) { resolve(err(e)) }
      }
      setTimeout(() => resolve('no answer in 5 s'), 5000)
    })
  }
  function cookie() {
    try {
      const m = /(?:^|; )probe3p=([^;]*)/.exec(document.cookie)
      const prev = m ? decodeURIComponent(m[1]) : null
      document.cookie = 'probe3p=' + encodeURIComponent(now) + '; Path=/; Max-Age=2592000; SameSite=None; Secure'
      const back = /(?:^|; )probe3p=([^;]*)/.exec(document.cookie)
      return (back && decodeURIComponent(back[1]) === now ? 'works' : 'refused') + ', previous ' + (prev || 'none')
    } catch (e) { return err(e) }
  }
  async function sa() {
    if (typeof document.hasStorageAccess !== 'function') return 'hasStorageAccess unsupported'
    try { return 'hasStorageAccess=' + (await document.hasStorageAccess()) } catch (e) { return err(e) }
  }

  addEventListener('message', async (ev) => {
    if (ev.source !== window.parent || !ev.data || ev.data.kind !== 'probe-storage-run') return
    const result = { ls: ls(), idb: await idb(), cookie: cookie(), sa: await sa() }
    window.parent.postMessage({ kind: 'probe-storage', result }, ev.origin === 'null' ? '*' : ev.origin)
  })
})()
