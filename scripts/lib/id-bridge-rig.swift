// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The rig side of scripts/test-home-id-bridge.mjs. Real WebKit (a WKWebView), the
// real home/bridge.js, a script-message handler that routes exactly as
// EditorViewController does (IdentityBridgeHost.handle -> replyScript), and the
// real IdentityAgent/IdentityKeys behind it. Only the things that need a screen
// are stand-ins: the consent prompt, the re-authentication prompt, and the clock.
// Prints `row.<name>=true|false`; the node side judges them.
import AppKit
import CryptoKit
import WebKit

typealias H = IdentityBridgeHost
final class Mem: HostDocStore.Secrets {
    var d: [String: Data] = [:]
    func get(_ a: String) -> HostDocStore.Read { d[a].map { .found($0) } ?? .absent }
    func set(_ a: String, _ v: Data) -> Bool { d[a] = v; return true }
    func delete(_ a: String) { d[a] = nil }
}
func row(_ n: String, _ ok: Bool) { print("row.\(n)=\(ok)"); fflush(stdout) }
func spin(_ s: Double) { RunLoop.main.run(until: Date().addingTimeInterval(s)) }

var clock = 1_800_000_000_000
let bridgeJS = try! String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
let store = Mem()
_ = try! IdentityKeys.createAccount(in: store)
let routineKey = try! IdentityKeys.device(.routine, in: store, enclave: false)
let routinePub = IdentityKeys.b64url(routineKey.publicRaw)
let accountPub = IdentityKeys.b64url(try! IdentityKeys.account(in: store).publicKey.x963Representation)
let emptyStore = Mem()
let me = H.Profile(name: "Ada Test", email: "ada@example.test", vouchedBy: "id.bento.page", since: 1_700_000_000_000)

/// One open document: a web view with bridge.js and the host behind it.
final class Doc: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    var web: WKWebView!
    var host: H!
    var hostCalls = 0
    var consentAsks = 0, reauthAsks = 0
    var consentAnswer = true
    var consentDelay = 0.0                  // the prompt is up this long before the person answers
    var holdReauth: ((Bool) -> Void)?       // when set, the reauth prompt stays up until the rig answers
    var reauthAnswer = true
    var managedFlag = false
    var loaded = false
    let session: H.Session
    init(genuine: Bool, key: String, session: H.Session, consent: H.ConsentBook, store: HostDocStore.Secrets = store,
         profile: H.Profile? = me, known: @escaping (String) -> H.Known? = { _ in nil }, hold: Bool = false) {
        self.session = session
        super.init()
        host = H(genuine: genuine, docKey: key, store: store, session: session, consent: consent,
                 profile: { profile }, known: known, managed: { [unowned self] in self.managedFlag },
                 askConsent: { [unowned self] _, done in
                     self.consentAsks += 1
                     if self.consentDelay > 0 { DispatchQueue.main.asyncAfter(deadline: .now() + self.consentDelay) { done(self.consentAnswer) } }
                     else { done(self.consentAnswer) }
                 },
                 askReauth: { [unowned self] done in
                     self.reauthAsks += 1
                     if hold { self.holdReauth = done } else { done(self.reauthAnswer) }
                 },
                 now: { clock }, enclave: false)
        let cfg = WKWebViewConfiguration()
        cfg.userContentController.add(self, name: "bentoFile")
        let caps = H.hostCaps(genuine: genuine).map { "'\($0)'" }.joined(separator: ", ")
        cfg.userContentController.addUserScript(WKUserScript(source: "window.__bentoHostCaps = [\(caps)];\n" + bridgeJS,
                                                             injectionTime: .atDocumentStart, forMainFrameOnly: true))
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: 400, height: 300), configuration: cfg)
        web.navigationDelegate = self
        web.loadHTMLString("<!doctype html><title>doc</title>", baseURL: URL(string: "https://doc.test/"))
        let end = Date().addingTimeInterval(15)
        while !loaded && Date() < end { spin(0.02) }
    }
    func webView(_ w: WKWebView, didFinish n: WKNavigation!) { loaded = true }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        guard let b = m.body as? [String: Any], let id = b["id"] as? Int, let op = b["op"] as? String else { return }
        hostCalls += 1
        guard H.ops.contains(op) else { return }
        host.handle(op: op, message: b) { [weak self] r in
            let w = H.wire(r)
            if let js = H.replyScript(id: id, ok: w.ok, json: w.value) { self?.web.evaluateJavaScript(js) }
        }
    }
    /// Run page script (an expression yielding a promise) and get its JSON back.
    func eval(_ expr: String, wait: Double = 10) -> Any? {
        var out: Any?? = nil
        web.callAsyncJavaScript("return JSON.stringify(await (\(expr)))", arguments: [:], in: nil, in: .page) { r in
            if case .success(let v) = r, let s = v as? String { out = .some(try? JSONSerialization.jsonObject(with: Data(s.utf8), options: [.fragmentsAllowed])) }
            else { out = .some(nil) }
        }
        let end = Date().addingTimeInterval(wait)
        while out == nil && Date() < end { spin(0.01) }
        return out ?? nil
    }
    func sign(_ purpose: String, _ payload: String) -> [String: Any]? {
        eval("window.__bentoIdentity.sign(\(js(purpose)), \(js(payload)))") as? [String: Any]
    }
    func js(_ s: String) -> String { String(data: try! JSONSerialization.data(withJSONObject: s, options: [.fragmentsAllowed]), encoding: .utf8)! }
}
func ok(_ r: [String: Any]?) -> Bool { r?["ok"] as? Bool == true && r?["sig"] is String }
func why(_ r: [String: Any]?) -> String { (r?["reason"] as? String) ?? (ok(r) ? "ok" : "none") }
let showLive = "live"
let frame = "AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

let tight = H.Session.Policy(idleMs: 1000, overallMs: 10_000)
let allowAll: () -> H.ConsentBook = { let b = H.ConsentBook(); b.record("d", allow: true); return b }

// ---- the policy defaults are the spec's (§2e B: 1 h idle, 24 h overall)
row("policy.defaults", H.Session.Policy.standard == .init(idleMs: 3_600_000, overallMs: 86_400_000))

// ---- who gets an agent at all
do {
    let g = Doc(genuine: true, key: "d", session: H.Session(policy: tight, clock: { clock }), consent: allowAll())
    let shape = g.eval("""
      (() => { const a = window.__bentoIdentity, d = Object.getOwnPropertyDescriptor(window, '__bentoIdentity');
        return Promise.resolve({ t: typeof a, c: a && a.contract, frozen: Object.isFrozen(a),
          fixed: d && !d.writable && !d.configurable && !d.enumerable, unwrap: typeof a.unwrap, share: typeof a.share }) })()
      """) as? [String: Any]
    row("agent.genuine.shape", shape?["t"] as? String == "object" && shape?["c"] as? Int == 1 && shape?["frozen"] as? Bool == true
        && shape?["fixed"] as? Bool == true && shape?["unwrap"] as? String == "undefined" && shape?["share"] as? String == "undefined")

    let u = Doc(genuine: false, key: "u", session: H.Session(policy: tight, clock: { clock }), consent: allowAll())
    row("agent.unknown.none", u.eval("Promise.resolve(typeof window.__bentoIdentity)") as? String == "undefined")
    // the page forges the wire anyway: the host's own gate is the authority
    let forged = u.eval("""
      new Promise((res) => { window.__bentoNativeReply = (id, ok, v) => res({ id, ok, v });
        window.webkit.messageHandlers.bentoFile.postMessage({ id: 77, op: 'id.sign', purpose: 'show', payload: 'live' }) })
      """) as? [String: Any]
    row("agent.unknown.forged-sign", forged?["ok"] as? Bool == false && forged?["v"] as? String == "unavailable")
    u.session.begin()
    let forged2 = u.eval("""
      new Promise((res) => { window.__bentoNativeReply = (id, ok, v) => res({ id, ok, v });
        window.webkit.messageHandlers.bentoFile.postMessage({ id: 78, op: 'id.sign', purpose: 'show', payload: 'live' }) })
      """) as? [String: Any]
    row("agent.unknown.forged-sign-live-session", forged2?["ok"] as? Bool == false && forged2?["v"] as? String == "unavailable" && u.reauthAsks == 0)
    let forged3 = u.eval("""
      new Promise((res) => { window.__bentoNativeReply = (id, ok, v) => res({ id, ok, v });
        window.webkit.messageHandlers.bentoFile.postMessage({ id: 79, op: 'id.whoami' }) })
      """) as? [String: Any]
    row("agent.unknown.forged-whoami", forged3?["ok"] as? Bool == false && forged3?["v"] as? String == "unavailable" && u.consentAsks == 0)
}

// ---- sign: session, idle, overall
do {
    let s = H.Session(policy: tight, clock: { clock })
    let d = Doc(genuine: true, key: "d", session: s, consent: allowAll())
    let r0 = d.sign("show", showLive)
    row("sign.nosession.reauth", why(r0) == "reauth")
    // the refusal raised exactly one prompt, and the person said yes: the next call finds the session
    row("sign.reauth.prompted-once", d.reauthAsks == 1)
    let t0 = clock
    let r1 = d.sign("show", showLive)
    row("sign.after-reauth.ok", ok(r1) && r1?["pub"] as? String == routinePub)
    if let sig = r1?["sig"] as? String, let raw = IdentityStatements.b64uDec(sig),
       let pk = try? P256.Signing.PublicKey(x963Representation: Data(base64URL: routinePub)),
       let es = try? P256.Signing.ECDSASignature(rawRepresentation: raw) {
        row("sign.signature-verifies", pk.isValidSignature(es, for: Data(showLive.utf8)))
    } else { row("sign.signature-verifies", false) }

    // a limit ENDS the session AT the limit (security's ruling): 1 ms short signs, exactly at it does not
    clock = t0 + 999
    row("sign.idle.just-inside.ok", ok(d.sign("show", showLive)))
    clock += 999
    row("sign.idle.again.ok", ok(d.sign("show", showLive)))
    clock += 1000
    let atLimit = d.sign("show", showLive)
    row("sign.idle.at-limit.reauth", why(atLimit) == "reauth" && atLimit?["sig"] == nil)
    clock += 1001
    let past = d.sign("show", showLive)
    row("sign.idle.past.reauth", why(past) == "reauth" && past?["sig"] == nil)
    let asks = d.reauthAsks

    // the prompt was answered yes, so a session is open again: overall limit
    let tb = clock
    var allOk = true
    var t = 500
    while t < 10_000 { clock = tb + t; if !ok(d.sign("show", showLive)) { allOk = false }; t += 500 }
    clock = tb + 9_999
    if !ok(d.sign("show", showLive)) { allOk = false }
    row("sign.overall.up-to-limit.ok", allOk)
    clock = tb + 10_000
    row("sign.overall.at-limit.reauth", why(d.sign("show", showLive)) == "reauth")
    row("sign.overall.reauth-prompted", d.reauthAsks > asks)

    s.lock()
    row("sign.lock.reauth", why(d.sign("show", showLive)) == "reauth")

    // a clock moved BACKWARDS fails closed (it would stretch both limits). The refusal above
    // reopened a session at `clock`; a use renews `last`, so even one ms back is refused.
    row("sign.clock.session-open.ok", ok(d.sign("show", showLive)))
    clock += 400
    row("sign.clock.forward.ok", ok(d.sign("show", showLive)))
    clock -= 1
    row("sign.clock.back-one-ms.reauth", why(d.sign("show", showLive)) == "reauth")
    // and a long way back, across many uses, never revives the overall limit
    var stayed = 0, base = clock
    for i in 0..<50 { clock = base + (i % 2 == 0 ? 400 : -400) * (i / 2 + 1); if ok(d.sign("show", showLive)) && clock < base { stayed += 1 } }
    row("sign.clock.set-back.never-live", stayed == 0)
}

// ---- reauth prompts: coalesced, and a cancel is not re-raised at once
do {
    let s = H.Session(policy: tight, clock: { clock })
    let d = Doc(genuine: true, key: "d", session: s, consent: allowAll(), hold: true)
    let all = d.eval("Promise.all([1,2,3].map(() => window.__bentoIdentity.sign('show', 'live')))") as? [[String: Any]]
    row("reauth.coalesced", d.reauthAsks == 1 && all?.allSatisfy { why($0) == "reauth" } == true)
    d.holdReauth?(false); d.holdReauth = nil
    clock += 1000
    _ = d.sign("show", showLive)
    row("reauth.cancel.cooldown", d.reauthAsks == 1)
    clock += H.reauthCooldownMs
    _ = d.sign("show", showLive)
    row("reauth.cancel.after-cooldown", d.reauthAsks == 2)
    d.holdReauth?(true); d.holdReauth = nil
    row("reauth.confirmed.opens-session", ok(d.sign("show", showLive)))
}

// ---- the real clock: idle of 1 s, inside and past
do {
    let s = H.Session(policy: .init(idleMs: 1000, overallMs: 60_000))
    let d = Doc(genuine: true, key: "d", session: s, consent: allowAll())
    s.begin()
    spin(0.3)
    row("realtime.idle.inside.ok", ok(d.sign("show", showLive)))
    spin(1.4)
    row("realtime.idle.past.reauth", why(d.sign("show", showLive)) == "reauth")
}

// ---- sign: purpose lock
do {
    let s = H.Session(policy: tight, clock: { clock })
    let d = Doc(genuine: true, key: "d", session: s, consent: allowAll())
    s.begin()
    let before = d.hostCalls
    row("purpose.unknown-purpose.page-refuses", why(d.sign("admin", showLive)) == "purpose" && d.hostCalls == before)
    row("purpose.mismatch.frame-as-show", why(d.sign("show", frame)) == "purpose")
    row("purpose.mismatch.show-as-frame", why(d.sign("frame", showLive)) == "purpose")
    row("purpose.mismatch.invite-text-as-show", why(d.sign("show", "inv.\(routinePub).writer.1800000000000")) == "purpose")
    row("purpose.mismatch.no-session-needed", { s.lock(); let a = d.reauthAsks; let r = d.sign("frame", showLive); return why(r) == "purpose" && a == d.reauthAsks }())
    s.begin()
    row("purpose.frame.ok", ok(d.sign("frame", frame)))
    row("purpose.invite.not-served", why(d.sign("invite", "inv.\(routinePub).writer.1800000000000")) == "unavailable")
    row("purpose.invite.mints-no-consent-key", { if case .absent = store.get(IdentityKeys.deviceItem(.consent)) { return true }; return false }())
    row("purpose.revoke.not-served", why(d.sign("revoke", "rev.\(routinePub)")) == "unavailable")
    row("purpose.nonstring.payload", why(d.eval("window.__bentoIdentity.sign('show', {})") as? [String: Any]) == "purpose")
}

// ---- whoami: per-document consent
do {
    let s = H.Session(policy: tight, clock: { clock })
    let book = H.ConsentBook()
    let d1 = Doc(genuine: true, key: "docA", session: s, consent: book)
    d1.consentAnswer = false
    // resolving the person's own key before consent says nothing
    let early = d1.eval("window.__bentoIdentity.resolve({ pub: \(d1.js(routinePub)) })")
    row("whoami.before-consent.resolve-own-nothing", early is NSNull && d1.consentAsks == 0)
    let n1 = d1.eval("window.__bentoIdentity.whoami()")
    row("whoami.declined.null", n1 is NSNull && d1.consentAsks == 1)
    _ = d1.eval("window.__bentoIdentity.whoami()")
    row("whoami.declined.not-asked-again", d1.consentAsks == 1)
    row("whoami.declined.resolve-own-nothing", d1.eval("window.__bentoIdentity.resolve({ pub: \(d1.js(accountPub)) })") is NSNull)

    let d2 = Doc(genuine: true, key: "docB", session: s, consent: book)
    d2.consentDelay = 0.4
    let all = d2.eval("Promise.all([1,2,3].map(() => window.__bentoIdentity.whoami()))") as? [[String: Any]]
    row("whoami.allowed.object", all?.count == 3 && all?.allSatisfy {
        $0["name"] as? String == me.name && $0["email"] as? String == me.email && $0["vouchedBy"] as? String == me.vouchedBy
            && $0["accountPub"] as? String == accountPub && $0["devicePub"] as? String == routinePub } == true)
    row("whoami.concurrent.one-prompt", d2.consentAsks == 1)
    _ = d2.eval("window.__bentoIdentity.whoami()")
    row("whoami.granted.remembered", d2.consentAsks == 1)
    let own = d2.eval("window.__bentoIdentity.resolve({ pub: \(d2.js(routinePub)) })") as? [String: Any]
    row("resolve.own-after-consent", own?["name"] as? String == me.name && own?["accountPub"] as? String == accountPub
        && own?["firstSeen"] as? Int == me.since && own?["changed"] as? Bool == false)
    // consent is per document: a third document asks for itself
    let d3 = Doc(genuine: true, key: "docC", session: s, consent: book)
    _ = d3.eval("window.__bentoIdentity.whoami()")
    row("whoami.per-document", d3.consentAsks == 1)
    // and an account-less device has no identity to give
    let d4 = Doc(genuine: true, key: "docD", session: s, consent: book, store: emptyStore, profile: nil)
    row("whoami.no-account.null", d4.eval("window.__bentoIdentity.whoami()") is NSNull && d4.consentAsks == 0)
    s.begin()
    row("sign.no-account.refused", why(d4.sign("show", showLive)) == "no-identity")
}

// ---- resolve: keys the host already holds, never an email
do {
    let other = P256.Signing.PrivateKey().publicKey.x963Representation
    let otherPub = IdentityKeys.b64url(other)
    let k = H.Known(name: "Bob Pinned", email: "bob@example.test", vouchedBy: "id.bento.page", accountPub: otherPub, firstSeen: 1_700_000_001_000, changed: true)
    let d = Doc(genuine: true, key: "d", session: H.Session(policy: tight, clock: { clock }), consent: allowAll(),
                known: { $0 == otherPub ? k : nil })
    let r = d.eval("window.__bentoIdentity.resolve({ pub: \(d.js(otherPub)) })") as? [String: Any]
    row("resolve.known", r?["email"] as? String == "bob@example.test" && r?["changed"] as? Bool == true && r?["firstSeen"] as? Int == 1_700_000_001_000)
    row("resolve.unknown-key.null", d.eval("window.__bentoIdentity.resolve({ pub: 'AAAA' })") is NSNull)
    let calls = d.hostCalls
    row("resolve.email.null-and-never-sent", d.eval("window.__bentoIdentity.resolve({ email: 'bob@example.test' })") is NSNull && d.hostCalls == calls)
    let both = d.eval("window.__bentoIdentity.resolve({ pub: 'AAAA', email: 'bob@example.test' })") is NSNull
    row("resolve.pub-and-email.unknown", both)
}

// ---- O1 deferred: any identity managed-config key stops every identity op
do {
    let s = H.Session(policy: tight, clock: { clock })
    let d = Doc(genuine: true, key: "d", session: s, consent: allowAll())
    s.begin()
    row("managed.control.absent.sign-ok", ok(d.sign("show", showLive)))
    row("managed.control.absent.whoami-ok", (d.eval("window.__bentoIdentity.whoami()") as? [String: Any])?["email"] as? String == me.email)
    d.managedFlag = true   // added AFTER the page loaded and the session opened
    row("managed.present.sign-refused", why(d.sign("show", showLive)) == "no-identity")
    row("managed.present.whoami-null", d.eval("window.__bentoIdentity.whoami()") is NSNull)
    row("managed.present.resolve-null", d.eval("window.__bentoIdentity.resolve({ pub: \(d.js(routinePub)) })") is NSNull)
    row("managed.present.no-reauth-prompt", { s.lock(); _ = d.sign("show", showLive); return d.reauthAsks == 0 }())
    d.managedFlag = false
    s.begin()
    row("managed.removed.resumes", ok(d.sign("show", showLive)))
}
print("done=1")
exit(0)

extension Data {
    init(base64URL s: String) {
        var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while t.count % 4 != 0 { t += "=" }
        self = Data(base64Encoded: t) ?? Data()
    }
}
