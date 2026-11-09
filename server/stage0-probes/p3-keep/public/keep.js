// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// P3 keep probe (Q4, row 4): non-extractable P-256 keys in IndexedDB, the
// persist() answer, a fingerprint, a visit log, and "delete my key".
//
// THE RULE: loading the page only READS. A key is made only when the person
// presses Make keys (and, if one exists, confirms replacing it), so a lost key
// always shows as "no key", never as a silently different fingerprint.
// Nothing leaves the browser.

(() => {
  'use strict'
  const P = window.probe
  const $ = (id) => document.getElementById(id)
  const S = { idb: 'ok', key: 'reading', fp: '-', kxfp: '-', created: '-', sign: '-', kx: '-', extractable: '-', persisted: '-', persistAnswer: 'not asked', visits: 0, lastVisit: '-', quota: '-' }

  const dbp = new Promise((resolve, reject) => {
    let r
    try { r = indexedDB.open('probe-p3', 1) } catch (e) { reject(e); return }
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

  const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')
  async function fingerprint(pub) {
    const raw = await crypto.subtle.exportKey('raw', pub)
    return hex(await crypto.subtle.digest('SHA-256', raw)).slice(0, 16)
  }

  async function check(rec) {
    const fp = await fingerprint(rec.sign.publicKey)
    S.fp = fp
    S.kxfp = (await fingerprint(rec.kx.publicKey)).slice(0, 8)
    S.created = new Date(rec.created).toISOString()
    S.extractable = String(rec.sign.privateKey.extractable || rec.kx.privateKey.extractable)
    S.key = fp === rec.fp ? 'same' : 'MISMATCH (stored ' + rec.fp + ')'
    try {
      const msg = new TextEncoder().encode('stage-0 probe P3 ' + Date.now())
      const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, rec.sign.privateKey, msg)
      S.sign = (await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, rec.sign.publicKey, sig, msg)) ? 'ok' : 'verify FAILED'
    } catch (e) { S.sign = 'error ' + (e && e.name) }
    try {
      const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: rec.kx.publicKey }, rec.kx.privateKey, 256)
      S.kx = bits.byteLength === 32 ? 'ok' : 'odd length'
    } catch (e) { S.kx = 'error ' + (e && e.name) }
  }

  async function load() {
    let rec
    try { rec = await kvGet('keys') } catch (e) { S.idb = 'error ' + ((e && e.name) || e); S.key = 'error'; return }
    if (!rec) { S.key = 'none'; S.fp = S.kxfp = S.created = S.sign = S.kx = S.extractable = '-'; return }
    try { await check(rec) } catch (e) { S.key = 'error ' + ((e && e.name) || e) }
  }

  async function visit() {
    try {
      const v = (await kvGet('visits')) || []
      v.push({ at: new Date().toISOString(), key: S.key === 'same' ? S.fp : S.key, mode: P.display() })
      while (v.length > 200) v.shift()
      await kvSet('visits', v)
      S.visits = v.length
      S.lastVisit = v.length > 1 ? v[v.length - 2].at : 'first'
      $('visits').textContent = v.slice(-20).reverse().map((x) => x.at + '  ' + x.mode + '  ' + x.key).join('\n')
    } catch (e) { $('visits').textContent = 'could not write the visit log: ' + ((e && e.name) || e) }
  }

  async function storageInfo() {
    if (!navigator.storage) { S.persisted = 'unsupported'; return }
    try { S.persisted = navigator.storage.persisted ? String(await navigator.storage.persisted()) : 'unsupported' } catch (e) { S.persisted = 'error ' + (e && e.name) }
    try { if (navigator.storage.estimate) { const q = await navigator.storage.estimate(); S.quota = Math.round((q.quota || 0) / 1048576) + 'MB' } } catch { /* leave '-' */ }
  }

  function show() {
    const st = $('state')
    st.textContent = S.key === 'none' ? 'No key.' : S.key === 'same' ? 'Key present · fingerprint ' + S.fp : 'Key: ' + S.key
    st.className = S.key === 'same' ? 'ok' : S.key === 'none' ? '' : 'bad'
    $('observed').textContent = [
      'fingerprint ' + S.fp + ' · agreement key ' + S.kxfp + ' · made ' + S.created,
      'sign test ' + S.sign + ' · key-agreement test ' + S.kx + ' · extractable ' + S.extractable,
      'persisted ' + S.persisted + ' · persist() answer ' + S.persistAnswer + ' · quota ' + S.quota,
      'running as ' + P.display() + ' · storage ' + S.idb,
    ].join('\n')
  }

  $('make').addEventListener('click', async () => {
    const existing = await kvGet('keys').catch(() => null)
    if (existing && !confirm('A key already exists here. Replace it with a new one?')) return
    try {
      const sign = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
      const kx = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
      const fp = await fingerprint(sign.publicKey)
      await kvSet('keys', { sign, kx, fp, created: Date.now() })
    } catch (e) { S.key = 'error making keys: ' + ((e && e.name) || e) }
    await load(); show()
  })
  $('persist').addEventListener('click', async () => {
    if (!navigator.storage || !navigator.storage.persist) { S.persistAnswer = 'unsupported'; show(); return }
    try { S.persistAnswer = String(await navigator.storage.persist()) } catch (e) { S.persistAnswer = 'error ' + (e && e.name) }
    await storageInfo(); show()
  })
  $('delete').addEventListener('click', async () => {
    if (!confirm('Delete the key kept here?')) return
    await kvDel('keys').catch(() => {})
    await load(); show()
  })

  ;(async () => {
    await load()
    await storageInfo()
    await visit()
    show()
  })()

  P.setupCopy(() => {
    const ageDays = S.created !== '-' ? ((Date.now() - Date.parse(S.created)) / 86400000).toFixed(1) : '-'
    return P.line('P3', [
      ['ua', P.browser()], ['display', P.display()], ['key', S.key], ['fp', S.fp], ['kxfp', S.kxfp],
      ['created', S.created], ['age-days', ageDays], ['sign', S.sign], ['kx', S.kx], ['extractable', S.extractable],
      ['persisted', S.persisted], ['persist-answer', S.persistAnswer], ['visits', S.visits], ['previous-visit', S.lastVisit],
      ['storage', S.idb], ['notes', $('notes').value || '-'],
    ])
  })
})()
