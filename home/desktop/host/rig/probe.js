// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// RIG BUILDS ONLY: the security §19d–§19h probe, injected after the shim and
// bridge when BENTO_PROBE_<label> is set. Each window reports what it could and
// could not do; rig/check.py asserts the verdicts. The embed is a cross-origin
// https page (httpbin, base64) that tries Tauri's IPC from inside the document
// with whatever key and capability it is handed in its URL fragment.
;(function () {
  if (window.top !== window) return
  if (location.protocol === 'https:') return
  const EMBED_URL = "https://httpbin.org/base64/PCFkb2N0eXBlIGh0bWw-PHNjcmlwdD4KdmFyIGg9ZGVjb2RlVVJJQ29tcG9uZW50KGxvY2F0aW9uLmhhc2guc2xpY2UoMSkpLnNwbGl0KCd8Jyksa2V5PWhbMF18fCcnLGNhcD1oWzFdfHxudWxsLHRhZz1oWzJdfHwnJzsKdmFyIHI9e3RhZzp0YWd9OwpyLmJlbnRvR2xvYmFscz1PYmplY3QuZ2V0T3duUHJvcGVydHlOYW1lcyh3aW5kb3cpLmZpbHRlcihmdW5jdGlvbihuKXtyZXR1cm4gL2JlbnRvfHNwaWtlfFRBVVJJL2kudGVzdChuKX0pOwp0cnl7ci5wYXJlbnRTZWNyZXQ9U3RyaW5nKHBhcmVudC5fX3NwaWtlQ2FwKX1jYXRjaChlKXtyLnBhcmVudFNlY3JldD0nVEhSRVcnfQpyLndrSXBjPSEhKHdpbmRvdy53ZWJraXQmJndpbmRvdy53ZWJraXQubWVzc2FnZUhhbmRsZXJzJiZ3aW5kb3cud2Via2l0Lm1lc3NhZ2VIYW5kbGVycy5pcGMpOwpyLmNocm9tZVd2PSEhKHdpbmRvdy5jaHJvbWUmJndpbmRvdy5jaHJvbWUud2Vidmlldyk7CmZ1bmN0aW9uIHNlbmQoKXtwYXJlbnQucG9zdE1lc3NhZ2Uoe2VtYmVkOnJ9LCcqJyl9CnRyeXt2YXIgbT1KU09OLnN0cmluZ2lmeSh7Y21kOidiZW50b19maWxlJyxjYWxsYmFjazoxLGVycm9yOjIscGF5bG9hZDp7bXNnOid7ImlkIjoiJyt0YWcrJyIsIm9wIjoicmVhZCIsIm5hbWUiOiJ4In0nLGNhcDpjYXB9LG9wdGlvbnM6e2hlYWRlcnM6e319LF9fVEFVUklfSU5WT0tFX0tFWV9fOmtleX0pOwppZih3aW5kb3cuaXBjKXdpbmRvdy5pcGMucG9zdE1lc3NhZ2UobSk7ZWxzZSBpZihyLndrSXBjKXdpbmRvdy53ZWJraXQubWVzc2FnZUhhbmRsZXJzLmlwYy5wb3N0TWVzc2FnZShtKTtlbHNlIGlmKHIuY2hyb21lV3Ypd2luZG93LmNocm9tZS53ZWJ2aWV3LnBvc3RNZXNzYWdlKG0pO3IucmF3PSdzZW50J31jYXRjaChlKXtyLnJhdz0nVEhSRVcgJytlfQpzZXRUaW1lb3V0KHNlbmQsMTIwMCkKPC9zY3JpcHQ-"
  const LABEL = window.__RIG_LABEL, PEER = window.__RIG_PEER
  const R = (window.__probeR = { label: LABEL, violations: [] })
  document.addEventListener('securitypolicyviolation', (e) => {
    R.violations.push({ dir: e.violatedDirective, uri: e.blockedURI, sample: e.sample })
  })
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const inv = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args)
  const mark = (step) => inv('rig_stash', { key: LABEL + '.step', value: step }).catch(() => {})
  const until = async (f, ms) => { for (let t = 0; t < ms && !f(); t += 100) await sleep(100); return f() }
  // rig 3: which capability values ever pass through THIS realm's JSON.stringify?
  const seen = new Set(), js = JSON.stringify
  JSON.stringify = function (v) { try { if (v && typeof v === 'object' && typeof v.cap === 'string') seen.add(v.cap) } catch (_) {} return js.apply(this, arguments) }
  addEventListener('load', async () => {
    // rig 9 (security's watchdog ruling): the recreated webview starts from
    // zero, the dead webview's secret is refused, and a stale secret cannot
    // ride the new label
    if (window.__RIG_WATCHDOG) {
      const full = window.__RIG_FULL_LABEL
      const raw = (id, cap) => inv('bento_file', { msg: JSON.stringify({ id, op: 'read', name: '-' }), cap }).then((t) => JSON.parse(t).value, (e) => 'THREW ' + e)
      await until(() => window.__rigCap, 15000)
      if (!full.includes('_r')) {
        await inv('rig_stash', { key: 'wd.oldcap', value: window.__rigCap })
        await inv('rig_recreate', {})
        raw('wd-dead-old', window.__rigCap) // its Load is gone: the host logs the refusal
        // and the PROTOCOL handler: no read of the document from the dead label
        fetch(location.href, { cache: 'no-store' }).then((r) => String(r.status), (e) => 'blocked ' + e)
          .then((v) => inv('rig_stash', { key: 'wd.oldfetch', value: v }))
        return
      }
      const old = await inv('rig_stash', { key: 'wd.oldcap' })
      const W = { label: full, armed: !!window.__rigCap, fresh_cap: !!old && window.__rigCap !== old }
      W.old_on_new = await raw('wd-old-on-new', old)
      W.own_on_new = await raw('wd-own-on-new', window.__rigCap)
      // control: the LIVE label's fetch of its own document reaches the handler
      W.new_fetch = await fetch(location.href, { cache: 'no-store' }).then((r) => String(r.status), (e) => 'blocked ' + e)
      W.old_fetch = await inv('rig_stash', { key: 'wd.oldfetch' })
      await inv('rig_done', { report: { watchdog: W, violations: [] } })
      return
    }
    // rig 5's bounce brings the main frame back: record it, never run twice
    if (sessionStorage.getItem('rig-done')) {
      const back = await until(() => window.__rigCap, 15000)
      await inv('rig_stash', { key: LABEL + '.bounced-back', value: back ? 'armed' : 'not armed' })
      return
    }
    try {
      mark('loaded')
      R.armed_in_time = await until(() => window.__rigCap, 15000)
      // rig 6, phase 1: remember this load's capability, then reload once.
      if (!sessionStorage.getItem('rig-old')) {
        sessionStorage.setItem('rig-old', window.__rigCap || 'none')
        location.reload()
        return
      }
      mark('phase2')
      const old = sessionStorage.getItem('rig-old')
      R.cap_rotated = !!window.__rigCap && window.__rigCap !== old
      const tryCap = async (cap) => JSON.parse(await inv('bento_file', { msg: JSON.stringify({ id: 'cap-test', op: 'read', name: '-' }), cap })).value
      R.rig6_old_cap = await tryCap(old)
      R.rig6_no_cap = await tryCap(null)
      R.rig6_current_cap = await tryCap(window.__rigCap)
      // the page itself
      R.origin = location.origin
      R.secure_context = window.isSecureContext
      R.webcrypto = !!(window.crypto && crypto.subtle)
      R.bridge_installed = typeof window.showSaveFilePicker === 'function' && !!window.launchQueue
      // CSP: an inline script the page adds itself (not a pinned hash)
      const s = document.createElement('script'); s.textContent = 'window.__rigInline = 1'; document.head.appendChild(s)
      await sleep(200)
      R.dom_inline_ran = window.__rigInline === 1
      // Tauri core/plugin commands: no capability file ships, so all refused
      R.core_cmd = await inv('plugin:window|title', {}).then((v) => 'ALLOWED ' + v, (e) => 'refused: ' + String(e).slice(0, 60))
      // rig 8: storage + BroadcastChannel isolation between documents
      const ALL = (window.__RIG_ALL || LABEL).split(',')
      let myDoc = null
      try { myDoc = JSON.parse(document.getElementById('bento-doc').textContent).docId } catch (_) {}
      await inv('rig_stash', { key: LABEL + '.doc', value: String(myDoc) })
      const heard = new Set()
      const bcA = new BroadcastChannel('rig8'), bcB = new BroadcastChannel('bento-sync-' + myDoc)
      bcA.onmessage = (e) => e.data && e.data.rig8 && heard.add('rig8<-' + e.data.rig8)
      bcB.onmessage = (e) => e.data && e.data.rig8 && heard.add('sync<-' + e.data.rig8)
      await sleep(1500)
      for (const other of ALL) {
        if (other === LABEL) continue
        let od = null
        for (let t = 0; t < 50 && !od; t++) { od = await inv('rig_stash', { key: other + '.doc' }); if (!od) await sleep(200) }
        bcA.postMessage({ rig8: LABEL })
        if (od) new BroadcastChannel('bento-sync-' + od).postMessage({ rig8: LABEL })
      }
      R.rig8_idb_owner = await new Promise((res) => {
        const rq = indexedDB.open('rig8-db', 1)
        rq.onupgradeneeded = () => rq.result.createObjectStore('kv')
        rq.onerror = () => res('ERR')
        rq.onsuccess = () => {
          const tx = rq.result.transaction('kv', 'readwrite'), st = tx.objectStore('kv'), g = st.get('owner')
          g.onsuccess = () => { if (g.result) res(g.result); else { st.put(LABEL, 'owner'); res(LABEL + ' (claimed)') } }
        }
      })
      await sleep(2500)
      R.rig8_heard = [...heard].sort()
      R.rig8_docId = myDoc
      // the attacker's network: publish this window's capability, fetch the peer's
      await inv('rig_stash', { key: LABEL + '.cap', value: window.__rigCap })
      let peerCap = null
      if (PEER) { for (let t = 0; t < 100 && !peerCap; t++) { peerCap = await inv('rig_stash', { key: PEER + '.cap' }); if (!peerCap) await sleep(200) } }
      R.have_peer_cap = !!peerCap
      // rigs 1 and 2: an embed with Tauri's key only, and with the PEER's
      // capability; CONTROL: the embed handed this window's own capability,
      // which must be ACCEPTED, or the refusals prove nothing.
      R.embeds = {}
      const cases = [['rig1-key-only', ''], ['rig2-peer-cap', peerCap || ''], ['control-own-cap', window.__rigCap]]
      for (const [tag, cap] of cases) {
        if (tag === 'rig2-peer-cap' && !peerCap) continue
        const got = new Promise((res) => { const h = (e) => { if (e.data && e.data.embed && e.data.embed.tag === LABEL + ':' + tag) { removeEventListener('message', h); res(e.data.embed) } }; addEventListener('message', h); setTimeout(() => res('no report'), 12000) })
        const f = document.createElement('iframe')
        f.setAttribute('sandbox', 'allow-scripts allow-forms')
        f.src = EMBED_URL + '#' + encodeURIComponent([window.__RIG_INVOKE_KEY, cap, LABEL + ':' + tag].join('|'))
        document.body.appendChild(f)
        R.embeds[tag] = await got
      }
      // save in place through the bridge. A real Bento app saves with its own
      // serializer (what ⌘S writes); a corpus file gets a marker in its doc
      // block (the block is not pinned, so a genuine file stays genuine)
      mark('save')
      R.booted = await until(() => window.bento && typeof window.bento.serialize === 'function', 30000)
      const handle = await new Promise((res) => window.launchQueue.setConsumer((p) => res(p.files[0])))
      R.handle_name = handle && handle.name
      const text = await (await handle.getFile()).text()
      let next
      if (R.booted) {
        const d = JSON.parse(JSON.stringify(window.bento.doc)); d.title = 'desktop-rig-marker'
        window.bento.loadDoc(JSON.stringify(d))
        await sleep(500)
        next = await window.bento.serialize()
        R.saved_by_runtime = true
      } else {
        next = text.replace('"docId"', '"rigMarker":"desktop-rig-marker","docId"')
      }
      R.save_changed = next !== text
      const w = await handle.createWritable(); await w.write(next); await w.close()
      R.saved = true
      R.rig3_caps_seen_here = seen.size
      R.rig3_peer_cap_seen_here = !!peerCap && seen.has(peerCap)
    } catch (e) { R.error = String((e && e.stack) || e) }
    mark('reporting')
    sessionStorage.setItem('rig-done', '1')
    await inv('rig_done', { report: R })
    // rig 5, AFTER reporting: send the main frame to a foreign page. The host
    // must bounce it back (BOUNCE in its log) and never arm the foreign page.
    location.assign('https://example.com/')
  })
})()
