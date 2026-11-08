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
  // The shim is no boundary against the page: the secret and nonce pass through this realm's
  // JSON.stringify on their way to the host. An attacker takes them there, fails the shim's own
  // call so it stays unarmed, and does the echo itself, so every later delivery reaches it too.
  if (MODE === 'restore') {
    const plain = JSON.stringify, taken = new Set()
    JSON.stringify = function (v) {
      const a = v && (typeof v.nonce === 'string' ? v : v.payload)
      if (a && typeof a.nonce === 'string' && typeof a.cap === 'string' && !taken.has(a.nonce)) {
        taken.add(a.nonce)
        R.hooked = (R.hooked || 0) + 1
        inv('bento_arm', { nonce: a.nonce, cap: a.cap }).then(() => { window.__rigCap = a.cap }, () => {})
        throw new Error('held')
      }
      return plain.apply(this, arguments)
    }
  }
  // realsave saves round the runtime's own bookkeeping, so the app would still ask about unsaved
  // changes, and on WebView2 that prompt stops the reload (measured: the row timed out). Installed
  // here so it runs ahead of the app's listener.
  if (MODE === 'realsave') addEventListener('beforeunload', (e) => e.stopImmediatePropagation(), true)
  // rig 3: which capability values ever pass through THIS realm's JSON.stringify?
  const seen = new Set(), js = JSON.stringify
  JSON.stringify = function (v) { try { if (v && typeof v === 'object' && typeof v.cap === 'string') seen.add(v.cap) } catch (_) {} return js.apply(this, arguments) }
  addEventListener('load', async () => {
    if (MODE === 'navlock') return runNavlock()
    if (MODE === 'fragment') return runFragment()
    if (MODE === 'race' || MODE === 'resave') return runRace()
    if (MODE === 'restore') return runRestore()
    if (MODE === 'leave' || MODE === 'leavestop') return runLeave()
    if (MODE === 'pushback') return runPushBack()
    if (MODE === 'swreg') return runSwReg()
    if (MODE === 'realsave') return runRealSave()
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
    // B1 slice 2: whoami (consent per document), resolve (keys already in the
    // room) and the host's re-auth prompt, through the real bridge, shim, host
    // and agent. Mode 'ident' runs three documents on the in-memory key (A and
    // B genuine, U unknown); 'keystore' and 'keystore-tpm' run ONE genuine
    // document on the REAL key store (the Secret Service, or a software TPM).
    if (window.__RIG_MODE === 'ident' || window.__RIG_MODE === 'keystore' || window.__RIG_MODE === 'keystore-tpm') {
      const I = { label: LABEL, mode: window.__RIG_MODE }
      const sess = (a) => inv('rig_session', { action: a })
      const skew = (ms) => inv('rig_skew', { addMs: ms })
      const answers = (consent) => inv('rig_answers', { consent })
      const counts = () => inv('rig_counts', {})
      const prov = (a) => inv('rig_provision', { action: a }).then((v) => v, (e) => 'ERR ' + e)
      const tag = (r) => (r && r.ok ? 'ok' : r && r.reason) || String(r)
      const MIN = 60000
      const FRAME = 'AAAAAAAAAAAAAAAA.' + 'A'.repeat(22)
      const b64u = (t) => Uint8Array.from(atob(t.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
      const flag = (k) => inv('rig_stash', { key: k })
      const waitFlag = async (k, ms) => { for (let t = 0; t < ms; t += 100) { if (await flag(k)) return true; await sleep(100) } return false }
      try {
        await until(() => window.__rigCap, 15000)
        const d = Object.getOwnPropertyDescriptor(window, '__bentoIdentity')
        I.present = !!d
        const raw = (op, extra) => inv('bento_id', { msg: JSON.stringify(Object.assign({ id: 'i-' + op, op }, extra)), cap: window.__rigCap }).then((t) => { const j = JSON.parse(t); return j.ok ? 'ok' : j.value }, (e) => 'THREW ' + e)
        if (!d) {
          // the unknown document: no agent object, and the host stops raw IPC before any prompt
          I.raw_whoami = await raw('id.whoami', {})
          I.raw_resolve = await raw('id.resolve', { pub: 'RIG-BOB' })
          I.raw_sign = await raw('id.sign', { purpose: 'frame', payload: FRAME })
          await waitFlag('ic.done', 90000)
          I.counts = await counts()
          await inv('rig_done', { report: { ident: I } })
          return
        }
        const ag = window.__bentoIdentity
        if (window.__RIG_MODE === 'ident' && LABEL === 'doc0') {
          // A: nothing to share yet, so nothing is asked
          await answers(true)
          I.no_account_whoami = await ag.whoami()
          I.no_account_counts = await counts()
          await prov('account')
          // the person says NO for this document
          await answers(false)
          I.a_decline = await ag.whoami()
          I.a_decline_again = await ag.whoami()
          I.a_counts = await counts()
          I.a_resolve_before = await ag.resolve({ pub: 'RIG-BOB' })
          await inv('rig_stash', { key: 'ia.declined', value: '1' })
          await waitFlag('ib.done', 60000)
          // B was allowed; that is not A's yes
          I.a_after_b_whoami = await ag.whoami()
          I.a_after_b_resolve = await ag.resolve({ pub: 'RIG-BOB' })
          I.counts_end = await counts()
          await inv('rig_done', { report: { ident: I } })
          return
        }
        if (window.__RIG_MODE === 'ident' && LABEL === 'doc3') {
          // C: a copy of B carrying B's docId, opened from another folder. B is allowed; C is a
          // different file, so the person is ASKED (and here says no), and resolve answers null.
          await waitFlag('ib.done', 90000)
          await answers(false)
          I.c_before = await counts()
          I.c_whoami = await ag.whoami()
          I.c_counts = await counts()
          I.c_resolve_bob = await ag.resolve({ pub: 'RIG-BOB' })
          await inv('rig_stash', { key: 'ic.done', value: '1' })
          await inv('rig_done', { report: { ident: I } })
          return
        }
        if (window.__RIG_MODE === 'ident') {
          // B: waits for A's no, then the person says YES for B only
          await waitFlag('ia.declined', 60000)
          await answers(true)
          I.b_whoami = await ag.whoami()
          I.b_whoami_again = await ag.whoami()
          I.b_counts = await counts()
          I.b_resolve_bob = await ag.resolve({ pub: 'RIG-BOB' })
          I.b_resolve_unknown = await ag.resolve({ pub: 'RIG-NOBODY' })
          I.b_resolve_email = await ag.resolve({ email: 'bob@example.org' })
          I.b_resolve_own = I.b_whoami ? await ag.resolve({ pub: I.b_whoami.devicePub }) : null
          await prov('changed')
          I.b_resolve_changed = await ag.resolve({ pub: 'RIG-BOB' })
          // re-auth, Linux v1 (maintainer 2026-11-08): this host has no verifier, so with no
          // session it REFUSES and tells the person why. Nothing the person or the page can
          // answer opens a session; only rig_session (the stand-in for a real verification) does.
          I.s_first = tag(await ag.sign('frame', FRAME))
          I.s_first_counts = await counts()
          // not told again inside the cooldown
          I.s_again = tag(await ag.sign('frame', FRAME))
          I.s_again_counts = await counts()
          // a bad payload never reaches the host's notice, past the cooldown or not
          await skew(2 * MIN)
          I.s_bad = tag(await ag.sign('frame', 'not-a-frame'))
          I.s_bad_counts = await counts()
          // past the cooldown: still refused, and told again
          I.s_after_cooldown = tag(await ag.sign('frame', FRAME))
          I.s_after_cooldown_counts = await counts()
          // CONTROL: a session opened by a verification signs, and nothing is shown
          I.s_begin = await sess('begin')
          I.s_inside = tag(await ag.sign('frame', FRAME))
          I.s_inside_counts = await counts()
          // past the idle limit the session is gone: refused and told, never re-opened by the host
          await skew(61 * MIN)
          I.s_idle = tag(await ag.sign('frame', FRAME))
          I.s_idle_counts = await counts()
          await inv('rig_stash', { key: 'ib.done', value: '1' })
          // CONTROL for the copy: after C's no, B (the file the person allowed) keeps its yes
          await waitFlag('ic.done', 90000)
          I.b_after_copy_whoami = await ag.whoami()
          I.b_after_copy_resolve = await ag.resolve({ pub: 'RIG-BOB' })
          I.b_after_copy_counts = await counts()
          await inv('rig_done', { report: { ident: I } })
          return
        }
        // keystore / keystore-tpm: the REAL store, end to end
        I.c0 = await counts()
        I.before_key_whoami = await ag.whoami()
        await prov('account')
        // an account with no key on this device has nothing to sign with
        I.no_key_sign = tag(await ag.sign('frame', FRAME))
        I.no_key_counts = await counts()
        I.devpub = await prov('device-key')
        await answers(true)
        I.whoami = await ag.whoami()
        // no session: refused, with the notice (Linux v1 has no verifier)
        I.no_session_sign = tag(await ag.sign('frame', FRAME))
        I.begin = await sess('begin')
        const s1 = await ag.sign('frame', FRAME)
        I.sign = tag(s1)
        if (s1.ok) {
          const key = await crypto.subtle.importKey('raw', b64u(s1.pub), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
          const ver = (msg) => crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64u(s1.sig), new TextEncoder().encode(msg))
          I.sig_valid = await ver(FRAME)
          I.sig_binds = !(await ver(FRAME + 'x'))
          I.sign_pub = s1.pub
        }
        I.keyring_items = await prov('keyring-items')
        I.counts = await counts()
        // the timers bind the real store too
        await skew(61 * MIN)
        I.idle_no = tag(await ag.sign('frame', FRAME))
        I.wipe = await prov('wipe')
      } catch (e) { I.error = String((e && e.stack) || e) }
      await inv('rig_done', { report: { ident: I } })
      return
    }
    // Security's ruling on #893: the OS ends the session. One genuine document signs through
    // the real bridge, shim, host and agent while rig/fakelogind.py plays the machine. Modes:
    // 'lock' the whole run, 'lock-start' a session that was already locked at launch,
    // 'lock-nobus' no bus at all.
    if ((window.__RIG_MODE || '').startsWith('lock')) {
      const K = { label: LABEL, mode: window.__RIG_MODE }
      const sess = (a) => inv('rig_session', { action: a })
      const gate = () => inv('rig_gate', {})
      // Linux v1 has no verifier: the host only ever REFUSES re-auth (and says so); nothing here can
      // answer it. A session opens through rig_session alone, the stand-in for a real verification.
      const prompts = async () => (await inv('rig_counts', {})).reauth
      const tag = (r) => (r && r.ok ? 'ok' : r && r.reason) || String(r)
      const FRAME = 'AAAAAAAAAAAAAAAA.' + 'A'.repeat(22)
      // act, then wait for the gate to move; if it never does, the row after it says so
      const bus = async (a) => {
        const g0 = await gate()
        await inv('rig_bus', { action: a })
        for (let t = 0; t < 2500 && (await gate()) === g0; t += 50) await sleep(50)
      }
      // for what must change nothing: the same wait, in full, so a change would be seen
      const quiet = async (a) => { await inv('rig_bus', { action: a }); await sleep(800) }
      const waitGate = async (want) => { for (let t = 0; t < 6000 && !(await gate()).startsWith(want); t += 100) await sleep(100); return gate() }
      try {
        await until(() => window.__rigCap, 15000)
        const ag = window.__bentoIdentity
        K.present = !!ag
        const sign = async () => tag(await ag.sign('frame', FRAME))
        if (window.__RIG_MODE === 'lock-nobus') {
          await sleep(2500) // the watcher has had its attempts
          K.gate = await gate()
          K.begin = await sess('begin')
          K.sign = await sign()
          K.prompts = await prompts()
        } else if (window.__RIG_MODE === 'lock-start') {
          K.gate = await waitGate('Locked')
          K.begin = await sess('begin')
          K.sign = await sign()
          K.prompts = await prompts()
          await bus('hint-off')
          K.gate_after = await gate()
          K.sign_after = await sign()
          K.prompts_after = await prompts()
          K.begin_after = await sess('begin')
          K.sign_after_begin = await sign()
        } else {
          K.gate0 = await waitGate('Open')
          K.begin0 = await sess('begin')
          K.control = await sign()
          K.control_again = await sign()
          // Lock: ends it, and the matching Unlock gives nothing back
          await bus('lock')
          K.after_lock = await sign()
          await quiet('unlock')
          K.after_unlock = await sign()
          // sleep: ends it, and waking gives nothing back
          K.begin1 = await sess('begin')
          K.sleep_control = await sign()
          await bus('sleep')
          K.after_sleep = await sign()
          await quiet('wake')
          K.after_wake = await sign()
          // waking is not a sleep
          K.begin2 = await sess('begin')
          await quiet('wake')
          K.wake_alone = await sign()
          // LockedHint: ends it; while it stands nothing opens and nobody is asked
          await bus('hint-on')
          K.gate_locked = await gate()
          K.after_hint = await sign()
          K.begin_locked = await sess('begin')
          await inv('rig_skew', { addMs: 120000 }) // past the cooldown of the no's above, or a prompt could not show here
          const p0 = await prompts()
          K.locked_sign = await sign()
          K.locked_prompts = (await prompts()) - p0
          // a signal claiming "unlocked" that logind does not back up changes nothing
          await quiet('hint-lie')
          K.gate_after_lie = await gate()
          // unlocked: the person can be told again (still refused: no verifier), and a verification signs
          await bus('hint-off')
          K.gate_unlocked = await gate()
          const p1 = await prompts()
          K.unlocked_sign = await sign()
          K.unlocked_prompts = (await prompts()) - p1
          K.begin_unlocked = await sess('begin')
          K.unlocked_control = await sign()
          // the same flag, announced with no value (a property invalidated, not changed)
          await bus('hint-on-invalidated')
          K.gate_invalidated = await gate()
          K.after_invalidated = await sign()
          await bus('hint-off')
          // logind leaves the bus: closed, nobody asked, and it reopens with no session
          K.begin3 = await sess('begin')
          K.name_control = await sign()
          await bus('name-drop')
          K.gate_no_name = await gate()
          K.begin_no_name = await sess('begin')
          const p3 = await prompts()
          K.no_name_sign = await sign()
          K.no_name_prompts = (await prompts()) - p3
          await inv('rig_bus', { action: 'name-back' })
          K.gate_name_back = await waitGate('Open')
          K.name_back_sign = await sign()
          // the session goes away under the host: the same
          K.begin4 = await sess('begin')
          K.session_control = await sign()
          await bus('session-gone')
          K.gate_session_gone = await gate()
          K.session_gone_sign = await sign()
          await inv('rig_bus', { action: 'session-back' })
          K.gate_session_back = await waitGate('Open')
          K.session_back_sign = await sign()
          K.begin5 = await sess('begin')
          K.session_back_control = await sign()
        }
      } catch (e) { K.error = String((e && e.stack) || e) }
      await inv('rig_done', { report: { lock: K } })
      // the bus itself dies. This page dies with it, so the host reports (rig_bus)
      if (window.__RIG_MODE === 'lock') await inv('rig_bus', { action: 'bus-down' })
      return
    }
    // B1 (security §2e B): the sign path through the REAL bridge, shim, host and
    // agent, across the idle and overall session limits. The genuine document
    // calls window.__bentoIdentity; the unknown one must not have it. The rig
    // plays the person (rig_session) and the clock (rig_skew).
    if (window.__RIG_SIGN) {
      const S = { label: LABEL }
      try {
        await until(() => window.__rigCap, 15000)
        const d = Object.getOwnPropertyDescriptor(window, '__bentoIdentity')
        S.present = !!d
        S.shape = d ? { data: 'value' in d, writable: d.writable, configurable: d.configurable, frozen: Object.isFrozen(d.value), keys: Object.keys(d.value).sort() } : null
        const raw = (op, extra) => inv('bento_id', { msg: JSON.stringify(Object.assign({ id: 's-' + op, op }, extra)), cap: window.__rigCap }).then((t) => { const j = JSON.parse(t); return j.ok ? 'ok' : j.value }, (e) => 'THREW ' + e)
        S.raw_sign_prefixed = await raw('id.sign', { purpose: 'frame', payload: 'not-a-frame' })
        if (!d) { await inv('rig_done', { report: { sign: S } }); return }
        const ag = window.__bentoIdentity
        const FRAME = 'AAAAAAAAAAAAAAAA.' + 'A'.repeat(22)
        const PROVE = 'prove.' + 'A'.repeat(22) + '.rabc'
        const MIN = 60000
        const sess = (a) => inv('rig_session', { action: a })
        const skew = (ms) => inv('rig_skew', { addMs: ms })
        const tag = (r) => (r && r.ok ? 'ok' : r && r.reason) || String(r)
        const b64u = (t) => Uint8Array.from(atob(t.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
        S.whoami = await ag.whoami()
        S.resolve = await ag.resolve({ pub: 'A'.repeat(87) })
        S.resolve_email = await ag.resolve({ email: 'a@example.org' })
        // no session yet: refused until the person authenticates
        S.before_session = tag(await ag.sign('frame', FRAME))
        await sess('begin')
        const first = await ag.sign('frame', FRAME)
        S.first = tag(first)
        // the signature is real: valid for this key over exactly these bytes, and only these
        const key = await crypto.subtle.importKey('raw', b64u(first.pub), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
        const ver = (msg) => crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64u(first.sig), new TextEncoder().encode(msg))
        S.sig_valid = await ver(FRAME)
        S.sig_binds_payload = !(await ver(FRAME + 'x'))
        // routine purposes the agent holds a key for; an owner purpose is not a phase-1 agent's
        S.prove = tag(await ag.sign('prove', PROVE))
        S.mismatch = tag(await ag.sign('prove', FRAME))
        // IDLE: one second inside the hour is fine (and counts as use), one second past is not
        await skew(60 * MIN - 1000)
        S.idle_inside = tag(await ag.sign('frame', FRAME))
        await skew(60 * MIN + 1000)
        S.idle_past = tag(await ag.sign('frame', FRAME))
        S.idle_past_prove = tag(await ag.sign('prove', PROVE))
        S.idle_past_again = tag(await ag.sign('frame', FRAME))
        // not healed by the passage of time, nor by a call that was refused
        await skew(1 * MIN)
        S.idle_past_later = tag(await ag.sign('frame', FRAME))
        // re-authentication restores it
        await sess('begin')
        S.after_reauth = tag(await ag.sign('frame', FRAME))
        // OVERALL: steady use every 50 minutes never trips the idle limit, so only the
        // 24-hour limit can end it. 28 steps = 23h20 (inside); the 29th = 24h10 (past).
        await sess('begin')
        const steps = []
        for (let k = 1; k <= 30; k++) { await skew(50 * MIN); steps.push(tag(await ag.sign('frame', FRAME))) }
        S.overall_steps = steps
        S.overall_first_refusal = steps.findIndex((x) => x !== 'ok') + 1
        await sess('begin')
        S.after_overall_reauth = tag(await ag.sign('frame', FRAME))
        await sess('lock')
        S.after_lock = tag(await ag.sign('frame', FRAME))
        // a clock moved BACKWARDS ends the session, and it stays ended (the agent's session_live;
        // saturating arithmetic alone would read it as no time at all). One minute back: the host
        // runs on the real clock, so a step smaller than the time between two calls is swamped by it
        // (measured: 1 ms back still signed). The agent's unit rows hold the 1 ms boundary.
        await sess('begin')
        S.back_control = tag(await ag.sign('frame', FRAME))
        await skew(-MIN)
        S.back_1min = tag(await ag.sign('frame', FRAME))
        await skew(5 * MIN)
        S.back_later = tag(await ag.sign('frame', FRAME))
        // CONTROL: the same step forward keeps signing
        await sess('begin')
        S.fwd_control = tag(await ag.sign('frame', FRAME))
        await skew(MIN)
        S.fwd_1min = tag(await ag.sign('frame', FRAME))
      } catch (e) { S.error = String((e && e.stack) || e) }
      await inv('rig_done', { report: { sign: S } })
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
        N.rows[t] = { same_realm: window.__nlRealm === realm, same_cap: window.__rigCap === cap, hash: location.hash, save: await saveVia(handle, 'b' + t), begin: await rawBegin() }
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

  // A document that moved its own fragment, by a link and by pushState (bento/spaces does both),
  // then reloads. The reload's URL carries the fragment: it must still load, arm and save, and
  // nothing may reach the system browser. A refused reload never reports, which fails the row.
  async function runFragment() {
    await until(() => window.__rigCap, 15000)
    const cap = window.__rigCap, kept = sessionStorage.getItem('frag')
    const handle = await openHandle()
    if (!kept) {
      const F = {}
      await mark('frag-start')
      location.href = '#frag-link'
      await sleep(600)
      F.link = location.hash
      history.pushState(null, '', '#p/frag')
      F.push = location.hash
      F.same_cap = window.__rigCap === cap
      F.save = await saveVia(handle, 'frag')
      sessionStorage.setItem('frag', JSON.stringify({ F, cap }))
      await mark('frag-reload')
      location.reload()
      return
    }
    const { F, cap: old } = JSON.parse(kept)
    await mark('frag-reloaded')
    Object.assign(F, { after: location.hash, armed: !!cap, rotated: cap !== old, save2: await saveVia(handle, 'frag2') })
    await inv('rig_done', { report: { fragment: F } })
  }

  // B2, security's mk2.py, on the rig. An UNKNOWN document, armed for its file only, tries
  // to get a genuine verdict for its own unknown bytes: it reloads, and swaps a genuine shell
  // over its own file after the reload's document was served and before the commit ends the
  // old page. Both pages then fetch their own URL, which serves the genuine bytes.
  // `resave` is the same swap, finished BEFORE the reload: the bytes that load are genuine, and
  // they stay unknown to the host because unknown script ran in this webview. Opening the
  // file again is what makes them genuine (scenario `reopened`).
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
      // The old page fetches its own URL once the swap lands: a genuine serve BEFORE the commit,
      // which only the AND keeps from judging the reload. Late ones die with the page.
      setTimeout(() => swap().then(() => { const x = new XMLHttpRequest(); x.open('GET', location.href, false); try { x.send() } catch (_) {} }), window.__RIG_RACE_DELAY)
      return
    }
    await inv('rig_done', { report: { race: { stage: stage || '0', attacker, armed: !!cap, id } } })
  }

  // A load with no document serve. The host's verdict comes from a serve, so a page brought back
  // whole from a back-forward cache would be judged on whatever was fetched before it. The
  // document leaves for https (the bounce brings it back, which makes the history), the second
  // page swaps a genuine shell over the file and fetches its own URL, which is the verdict an
  // unknown page would want, then goes back to the first entry.
  async function runRestore() {
    const stage = sessionStorage.getItem('restore')
    await until(() => window.__rigCap, 15000)
    const cap = window.__rigCap
    const attacker = document.getElementById('bento-doc').textContent.includes('"docId":"rig-u"')
    await mark(`restore stage=${stage || 0} attacker=${attacker} armed=${!!cap} length=${history.length}`)
    const report = async (how) => inv('rig_done', { report: { restore: { how, stage: stage || '0', attacker, hooked: R.hooked, armed: !!window.__rigCap, rotated: window.__rigCap !== cap, id: await idCall(window.__rigCap, 'sign'), begin: await rawBegin(), length: history.length } } })
    if (!stage) {
      addEventListener('pageshow', (e) => { if (e.persisted) sleep(1500).then(() => report('restored')) })
      sessionStorage.setItem('restore', '1')
      location.href = EMBED_URL + '?restore'
      return
    }
    if (stage === '1') {
      sessionStorage.setItem('restore', '2')
      const name = JSON.parse(await inv('bento_file', { msg: JSON.stringify({ id: 'restore-b', op: 'begin', launch: true }), cap })).value
      await inv('bento_file', { msg: JSON.stringify({ id: 'restore-w', op: 'write', name, text: window.__RIG_RACE_G }), cap })
      const x = new XMLHttpRequest(); x.open('GET', location.href, false); try { x.send() } catch (_) {}
      await mark('restore-going-back')
      history.go(1 - history.length)
      await sleep(6000)
      return report('stayed')
    }
    await report('reloaded')
  }

  // Puts a genuine verdict on the books while unknown bytes run: a genuine shell over the file,
  // then the document's own URL fetched.
  async function bookGenuine(cap, tag) {
    const name = JSON.parse(await inv('bento_file', { msg: JSON.stringify({ id: tag + '-b', op: 'begin', launch: true }), cap })).value
    await inv('bento_file', { msg: JSON.stringify({ id: tag + '-w', op: 'write', name, text: window.__RIG_RACE_G }), cap })
    const x = new XMLHttpRequest(); x.open('GET', location.href, false); try { x.send() } catch (_) {}
  }

  // B5, security's chain: an unknown document books a genuine verdict and leaves for https. The
  // hostile page is rig/embed.html (?b5). Afterwards the bounce brings back the file, which is
  // now the genuine shell, in a webview that ran unknown script.
  async function runLeave() {
    const stage = sessionStorage.getItem('leave')
    await until(() => window.__rigCap, 15000)
    const cap = window.__rigCap
    const attacker = document.getElementById('bento-doc').textContent.includes('"docId":"rig-u"')
    await mark(`leave stage=${stage || 0} attacker=${attacker} armed=${!!cap}`)
    if (!stage && attacker) {
      await bookGenuine(cap, 'leave')
      await mark('leave-going')
      sessionStorage.setItem('leave', '1')
      location.href = EMBED_URL + (MODE === 'leavestop' ? '?b5-stop' : '?b5')
      return
    }
    await inv('rig_done', { report: { leave: { stage: stage || '0', attacker, armed: !!cap, id: await idCall(cap, 'sign') } } })
  }

  // A move back through history that serves nothing, with a verdict on the books: same-document, so
  // no load may start and nothing may mint.
  async function runPushBack() {
    await until(() => window.__rigCap, 15000)
    const cap = window.__rigCap
    history.pushState({}, '', '#p')
    await bookGenuine(cap, 'pushback')
    await mark('pushback-going')
    history.back()
    await sleep(3000)
    await inv('rig_done', { report: { pushback: { hash: location.hash, same_cap: window.__rigCap === cap, id: await idCall(cap, 'sign') } } })
  }

  // A service worker is the one thing that could run unknown bytes in a FRESH webview, which has no
  // unknown serve to taint it. The document's origin serves only "/", as text/html, so a
  // registration must fail. The control is a real script from the same origin (rig builds only).
  async function runSwReg() {
    await until(() => window.__rigCap, 15000)
    const S = { secure: isSecureContext, api: 'serviceWorker' in navigator }
    const reg = (u) => S.api ? within(navigator.serviceWorker.register(u).then((r) => r.unregister().then(() => 'registered')), 8000, 'no answer').catch((e) => 'refused: ' + e) : 'no api'
    S.doc = await reg('/')
    S.query = await reg('/?sw')
    S.control = await reg('/rig-sw.js')
    await inv('rig_done', { report: { swreg: S } })
  }

  // The normal user: the real release, saved by its own serializer, reloaded in the SAME webview.
  async function runRealSave() {
    const stage = sessionStorage.getItem('realsave')
    await until(() => window.__rigCap, 15000)
    const booted = await until(() => window.bento && typeof window.bento.serialize === 'function', 30000)
    await mark(`realsave stage=${stage || 0} armed=${!!window.__rigCap} booted=${!!booted}`)
    if (!stage) {
      const handle = await openHandle()
      const d = JSON.parse(JSON.stringify(window.bento.doc)); d.title = 'desktop-rig-marker'
      window.bento.loadDoc(JSON.stringify(d))
      await sleep(500)
      const next = await window.bento.serialize()
      const w = await handle.createWritable(); await w.write(next); await w.close()
      sessionStorage.setItem('realsave', '1')
      await mark('realsave-reloading')
      location.reload()
      return
    }
    await inv('rig_done', { report: { realsave: { title: window.bento.doc.title, armed: !!window.__rigCap, id: await idCall(window.__rigCap, 'sign') } } })
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
