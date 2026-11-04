// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// RIG BUILDS ONLY: the security §19d–§19h probe, injected after the shim and
// bridge when BENTO_PROBE_<label> is set. Each window reports what it could and
// could not do; rig/check.py asserts the verdicts. The embed is a cross-origin
// page (rig/embed.html, served by run.sh from its own loopback port) that tries Tauri's IPC from inside the document
// with whatever key and capability it is handed in its URL fragment.
;(function () {
  if (window.top !== window) return
  if (location.protocol === 'https:') return
  // The attacker's page is served by rig/run.sh on a loopback port the host passes in; no third party is involved.
  const EMBED_URL = window.__RIG_EMBED_URL || ''
  const LABEL = window.__RIG_LABEL, PEER = window.__RIG_PEER
  const R = (window.__probeR = { label: LABEL, violations: [] })
  document.addEventListener('securitypolicyviolation', (e) => {
    R.violations.push({ dir: e.violatedDirective, uri: e.blockedURI, sample: e.sample })
  })
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const inv = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args)
  const mark = (step) => inv('rig_stash', { key: LABEL + '.step', value: step }).catch(() => {})
  const until = async (f, ms) => { for (let t = 0; t < ms && !f(); t += 100) await sleep(100); return f() }
  const MODE = window.__RIG_MODE || ''
  // Never hangs: a call the shim queued for ever (armed nowhere) must read as a failure.
  const within = (p, ms, late) => Promise.race([p, sleep(ms).then(() => late)])
  const frameTag = (u, tag) => u + '#' + encodeURIComponent(['', '', tag].join('|'))
  const frameReport = (tag, go, ms) => new Promise((res) => {
    const h = (e) => { if (e.data && e.data.embed && e.data.embed.tag === tag) { removeEventListener('message', h); res(e.data.embed) } }
    addEventListener('message', h); setTimeout(() => { removeEventListener('message', h); res('no report') }, ms || 8000)
    go()
  })
  const addFrame = (url) => { const f = document.createElement('iframe'); f.src = url; document.body.appendChild(f); return f }
  // The real path: bridge handle, shim, this load's capability, the op, the disk, and back.
  const openHandle = () => within(new Promise((res) => window.launchQueue.setConsumer((p) => res(p.files[0]))), 15000, null)
  const saveVia = (handle, tag) => within((async () => {
    if (!handle) return 'no handle'
    const text = await (await handle.getFile()).text()
    const w = await handle.createWritable()
    await w.write(text.replace('"docId"', `"rig_${tag}":1,"docId"`))
    await w.close()
    return (await (await handle.getFile()).text()).includes(`"rig_${tag}":1`) ? 'saved' : 'not on disk'
  })().catch((e) => 'THREW ' + e), 6000, 'no answer')
  const rawBegin = () => inv('bento_file', { msg: JSON.stringify({ id: 'rig-begin', op: 'begin', launch: true }), cap: window.__rigCap }).then((t) => JSON.parse(t).value, (e) => 'THREW ' + e)
  const idCall = (cap, op) => inv('bento_id', { msg: JSON.stringify({ id: 'id-' + op, op, purpose: 'frame', payload: 'not-a-frame' }), cap }).then((t) => { const j = JSON.parse(t); return j.ok ? 'ok' : j.value }, (e) => 'THREW ' + e)
  // B2: the new page asks for its own URL, after the old page swapped the file
  // underneath it. Runs while the document parses, as security's mk2.py did.
  if (MODE === 'race' && sessionStorage.getItem('race') === '1') {
    const t0 = Date.now(); while (Date.now() - t0 < 150);
    const x = new XMLHttpRequest(); x.open('GET', location.href, false); try { x.send() } catch (_) {}
  }
  // rig 3: which capability values ever pass through THIS realm's JSON.stringify?
  const seen = new Set(), js = JSON.stringify
  JSON.stringify = function (v) { try { if (v && typeof v === 'object' && typeof v.cap === 'string') seen.add(v.cap) } catch (_) {} return js.apply(this, arguments) }
  addEventListener('load', async () => {
    if (MODE === 'navlock') return runNavlock()
    if (MODE === 'race' || MODE === 'resave') return runRace()
    if (MODE === 'oac') return runOac()
    if (MODE === 'acl') return runAcl()
    // §19h wedge scenario: once armed, count a heartbeat through the host every
    // 300 ms and do nothing else. The shell stops web processes and watches
    // which documents' counters freeze.
    if (window.__RIG_WEDGE) {
      await until(() => window.__rigCap, 15000)
      let n = 0
      setInterval(() => inv('rig_stash', { key: LABEL + '.hb', value: String(++n) }).catch(() => {}), 300)
      return
    }
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
    // rig 5's bounce brings the main frame back: record it, never run twice. Armed is
    // page state, so it proves nothing alone: the row is a real save through the host.
    if (sessionStorage.getItem('rig-done')) {
      const back = await until(() => window.__rigCap, 15000)
      const handle = await openHandle()
      const saved = await saveVia(handle, 'rig5')
      await inv('rig_stash', { key: LABEL + '.bounced-back', value: (back ? 'armed' : 'not-armed') + ',' + String(saved).replace(/\s+/g, '_').slice(0, 60) })
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
      // identity calls: gated on a GENUINE load. A mismatched payload is the
      // agent's own answer ("purpose"), so it proves the call REACHED the
      // agent; an unknown document must be stopped before it ("unavailable").
      R.id_sign = await idCall(window.__rigCap, 'sign')
      R.id_whoami = await idCall(window.__rigCap, 'whoami')
      R.id_no_cap = await idCall(null, 'sign')
      // Tauri core and plugin commands: nothing grants them, on either platform (§19e d3). The
      // two plugins the host links are named too: a dialog that opened would never answer,
      // and that is a failure as well.
      const refusedCmd = (cmd, args) => within(inv(cmd, args).then((v) => 'ALLOWED ' + v, (e) => 'refused: ' + String(e).slice(0, 80)), 3000, 'ALLOWED no answer')
      R.core_cmd = await refusedCmd('plugin:window|title', {})
      R.core_opener = await refusedCmd('plugin:opener|open_url', { url: 'https://127.0.0.1:9/rig-opener' })
      R.core_dialog = await refusedCmd('plugin:dialog|message', { message: 'rig' })
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
      // rig 8, cookies and Origin-Agent-Cluster. A document sets cookies on its own host and on every
      // PARENT domain it may name; once every peer has done the same, it lists what it can see. A
      // sibling document's cookie in the list is a leak; its own host-only cookie is the positive control.
      R.rig8_oac_type = typeof window.originAgentCluster; R.rig8_oac = window.originAgentCluster
      const hexHost = location.hostname.replace(/^bento\./, '')
      const ck = (n, dom) => { try { document.cookie = 'rck_' + LABEL + '_' + n + '=1; path=/' + (dom ? '; Domain=' + dom : '') } catch (_) {} }
      ck('host', ''); ck('dom_localhost', 'localhost'); ck('dom_dotlocalhost', '.localhost'); ck('dom_hex', hexHost)
      await inv('rig_stash', { key: LABEL + '.ck', value: 'set' })
      for (const other of ALL) { if (other === LABEL) continue; for (let t = 0; t < 50 && !(await inv('rig_stash', { key: other + '.ck' })); t++) await sleep(200) }
      await sleep(500)
      try { R.rig8_cookies = document.cookie } catch (e) { R.rig8_cookies = 'THREW ' + String(e).slice(0, 60) }
      try { document.domain = 'localhost' } catch (e) { R.rig8_domain_err = String(e).slice(0, 80) }
      R.rig8_domain_after = document.domain
      // `localhost` is one label and can never be set, so that row says nothing about the
      // header. The row that does: the document's own parent, a no-op under ?1.
      Object.assign(R, domainRow())
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
      R.embed_url = EMBED_URL
      if (!EMBED_URL) throw new Error('rig: no BENTO_RIG_EMBED_URL: the attacker fixture is not being served')
      // WebView2 (Windows): Tauri's IPC refuses a sandboxed frame outright ("Origin header is not a
      // valid URL": its origin is "null"), so the three capability rows use an UNSANDBOXED frame of
      // the attacker's own origin instead (a stronger attacker: a real origin, and the platform ACL
      // opened to it by capabilities-windows/rig-embed.json), and the sandboxed frame is recorded
      // as its own row. WebKitGTK keeps the sandboxed frames.
      const WIN = /Windows/.test(navigator.userAgent)
      const cases = [['rig1-key-only', ''], ['rig2-peer-cap', peerCap || ''], ['control-own-cap', window.__rigCap]]
      if (WIN) cases.push(['win-sandboxed', window.__rigCap])
      for (const [tag, cap] of cases) {
        if (tag === 'rig2-peer-cap' && !peerCap) continue
        const got = new Promise((res) => { const h = (e) => { if (e.data && e.data.embed && e.data.embed.tag === LABEL + ':' + tag) { removeEventListener('message', h); res(e.data.embed) } }; addEventListener('message', h); setTimeout(() => res('no report'), 12000) })
        const f = document.createElement('iframe')
        if (!WIN || tag === 'win-sandboxed') f.setAttribute('sandbox', 'allow-scripts allow-forms')
        f.src = EMBED_URL + '#' + encodeURIComponent([window.__RIG_INVOKE_KEY, cap, LABEL + ':' + tag].join('|'))
        document.body.appendChild(f)
        R.embeds[tag] = await got
      }
      // ORIGIN check (the sandboxed frames above report origin "null", as a real embed does): the
      // same fixture UNSANDBOXED must report its own loopback origin, different from the document's,
      // and be unable to read this realm.
      R.origin_ctl = {}
      let xf
      R.origin_ctl.cross = await frameReport(LABEL + ':xo', () => { xf = addFrame(frameTag(EMBED_URL, LABEL + ':xo')) }, 12000)
      // CONTROL (trust is per certificate, not per host): the same fixture served from a second
      // loopback port with a DIFFERENT self-signed certificate for 127.0.0.1 must NOT load. The
      // trusted certificate above is the positive control that frames do load.
      R.rogue = 'not tried'
      if (window.__RIG_ROGUE_URL) {
        R.rogue = await new Promise((res) => {
          const h = (e) => { if (e.data && e.data.embed && e.data.embed.tag === LABEL + ':rogue') { removeEventListener('message', h); res(e.data.embed) } }
          addEventListener('message', h); setTimeout(() => res('no report'), 8000)
          const rf = document.createElement('iframe'); rf.src = window.__RIG_ROGUE_URL + '#' + encodeURIComponent(['', '', LABEL + ':rogue'].join('|')); document.body.appendChild(rf)
        })
      }
      try { R.origin_ctl.cross_reads = String(xf.contentDocument.body) } catch (e) { R.origin_ctl.cross_reads = 'THREW' }
      // Windows, the capability's origin pattern in the real ACL: the rig serves a page at two
      // origins the pattern must refuse and one 24-hex origin it must admit. Only a document with
      // no CSP can frame them, so the genuine windows report nothing here.
      R.acl_frames = {}
      if (WIN) {
        for (const [tag, host] of [['evil', 'evil'], ['abc', 'a.b.c'], ['hex', '0123456789abcdef01234567']]) {
          const t = LABEL + ':acl-' + tag
          R.acl_frames[tag] = await frameReport(t, () => addFrame(frameTag(`http://bento.${host}.localhost/`, t)), 6000)
        }
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
    // rig 5, AFTER reporting: send the main frame to a foreign page, the rig's own
    // loopback fixture, so no third party is involved. The host must bounce it back
    // (BOUNCE in its log) and never arm the foreign page.
    location.assign(EMBED_URL + '?rig5')
  })

  function domainRow() {
    const own = document.domain, r = { rig8_domain_own: own }
    const parent = own.replace(/^bento\./, '')
    try { document.domain = parent; r.rig8_domain_hex_after = document.domain } catch (e) { r.rig8_domain_hex_after = 'THREW ' + e.name }
    r.rig8_domain_hex_tried = parent
    return r
  }

  // B3's negative control: this load's header is ?0.
  async function runOac() {
    await until(() => window.__rigCap, 15000)
    await inv('rig_done', { report: Object.assign({ oac: window.originAgentCluster, oac_type: typeof window.originAgentCluster }, domainRow()) })
  }

  // B1 and §19e d1/d4. Every row is a real save, so a host pending under a secret the
  // page never took reads as a failure. `begin` for the open document must still be
  // refused as already handed out: per-load state survived, so nothing re-minted.
  async function runNavlock() {
    const N = { rows: {}, d1: {}, d4: {} }
    // B1, order pending, pending, armed: a blocked navigation from the load event, before the
    // echo, so a finished report for it (WebView2) can land between the mint and the echo.
    // (A live port: the engines refuse port 9 themselves, before any policy is asked.)
    const plain = window.__RIG_PLAIN_URL
    if (!window.__rigCap) { N.early = true; try { location.href = plain + '?nl-early' } catch (_) {} }
    try {
      await mark('nl-load')
      N.armed = !!(await until(() => window.__rigCap, 15000))
      const cap = window.__rigCap
      const handle = await openHandle()
      N.first = await saveVia(handle, 'first')
      const realm = (window.__nlRealm = String(Math.random()))
      const targets = [
        ['http', plain + '?nl-http'], ['file', 'file:///etc/hosts'], ['data', 'data:text/html,x'],
        ['mailto', 'mailto:a@b.invalid'], ['blob', URL.createObjectURL(new Blob(['x'], { type: 'text/html' }))],
        ['hash', '#nl'],
      ]
      for (const [t, url] of targets) {
        await mark('blocked-' + t)
        try { location.href = url } catch (e) { N.rows[t + '_threw'] = String(e) }
        await sleep(900)
        await mark('after-' + t)
        N.rows[t] = { same_realm: window.__nlRealm === realm, same_cap: window.__rigCap === cap, save: await saveVia(handle, 'b' + t), begin: await rawBegin() }
      }
      // §19e d1: a live embed loads and navigates after arming, three ways. None of it may
      // touch the load: no load start, no finish, no mint, and the capability keeps working.
      if (!EMBED_URL) throw new Error('rig: no BENTO_RIG_EMBED_URL')
      await mark('d1-start')
      let f
      N.d1.loaded = await frameReport(LABEL + ':d1a', () => { f = addFrame(frameTag(EMBED_URL, LABEL + ':d1a')) })
      N.d1.src_changed = await frameReport(LABEL + ':d1b', () => { f.src = frameTag(EMBED_URL + '?d1b', LABEL + ':d1b') })
      N.d1.self_navigated = await frameReport(LABEL + ':d1c', () => { f.contentWindow.location.href = frameTag(EMBED_URL + '?d1c', LABEL + ':d1c') })
      await sleep(500)
      await mark('d1-end')
      N.d1.same_cap = window.__rigCap === cap
      N.d1.save = await saveVia(handle, 'd1')
      // §19e d4: a frame sent to plain http. The pinned CSP refuses it on both engines; with no
      // CSP WebKitGTK's on_navigation refuses it, and on WebView2 nothing does.
      if (plain) N.d4.plain = await frameReport(LABEL + ':d4', () => addFrame(frameTag(plain + '?d4-' + LABEL, LABEL + ':d4')), 5000)
      N.d4.csp = R.violations.filter((v) => /frame-src|child-src|default-src/.test(v.dir || '')).map((v) => v.uri)
      N.d4.save = await saveVia(handle, 'd4')
    } catch (e) { N.error = String((e && e.stack) || e) }
    await mark('nl-done')
    await inv('rig_done', { report: { navlock: N } })
  }

  // B2, security's mk2.py, on the rig. An UNKNOWN document, armed for its file only, tries
  // to get a genuine verdict for its own unknown bytes: it reloads, and swaps a genuine shell
  // over its own file after the reload's document was served and before the commit ends the
  // old page. The new page then fetches its own URL, which serves the genuine bytes.
  // `resave` is the honest route: the same swap, finished BEFORE the reload.
  async function runRace() {
    const stage = sessionStorage.getItem('race')
    await until(() => window.__rigCap, 15000)
    const cap = window.__rigCap
    const attacker = document.getElementById('bento-doc').textContent.includes('"docId":"rig-u"')
    const id = await idCall(cap, 'sign')
    await mark(`race stage=${stage || 0} attacker=${attacker} armed=${!!cap} id=${id}`)
    if (!stage && attacker) {
      const name = JSON.parse(await inv('bento_file', { msg: JSON.stringify({ id: 'race-b', op: 'begin', launch: true }), cap })).value
      sessionStorage.setItem('race', '1')
      const swap = () => inv('bento_file', { msg: JSON.stringify({ id: 'race-w', op: 'write', name, text: window.__RIG_RACE_G }), cap })
      if (MODE === 'resave') { await swap(); location.reload(); return }
      location.reload()
      setTimeout(swap, window.__RIG_RACE_DELAY)
      return
    }
    await inv('rig_done', { report: { race: { stage: stage || '0', attacker, armed: !!cap, id } } })
  }

  // §19e condition f: no embed gets past the ACL that ships. This build has no rig-embed.json,
  // so the frame holds this window's OWN capability and is still stopped before the host.
  async function runAcl() {
    const A = {}
    try {
      await until(() => window.__rigCap, 15000)
      const t = LABEL + ':acl-own-cap'
      A.armed = !!window.__rigCap
      A.embed = await frameReport(t, () => addFrame(window.__RIG_EMBED_URL + '#' + encodeURIComponent([window.__RIG_INVOKE_KEY, window.__rigCap, t].join('|'))), 12000)
      A.save = await saveVia(await openHandle(), 'acl')
    } catch (e) { A.error = String((e && e.stack) || e) }
    await inv('rig_done', { report: { acl: A } })
  }
})()
