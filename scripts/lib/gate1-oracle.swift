// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The browser oracle for scripts/test-home-gate1.mjs. A scanner that agrees
// with the reference can share the reference's bug, so the BROWSER decides here
// what runs. Each file is served the way the host will serve it: from a custom
// scheme, with the Content-Security-Policy that gate 1 would give it (plus
// 'report-sample'). A listener in an isolated content world records every
// script the page's CSP refuses: an inline script, a handler or a src= that
// isn't the release's loader or remover. A file gate 1 calls GENUINE must cause
// none, whatever the verdicts say.
//
//   gate1-oracle <cases.json>   [{ "file": path, "csp": policy }, ...]
// prints one JSON line per case: { "file", "loaded", "violations": [{ "directive", "sample", "blocked" }] }

import AppKit
import WebKit

struct Case: Decodable { let file: String; let csp: String }

final class Oracle: NSObject, WKURLSchemeHandler, WKScriptMessageHandler, WKNavigationDelegate {
    var cases: [Case] = []
    var index = 0
    var violations: [[String: String]] = []
    var loaded = false
    var web: WKWebView!
    var timer: Timer?

    func start(_ cases: [Case]) {
        self.cases = cases
        let cfg = WKWebViewConfiguration()
        cfg.setURLSchemeHandler(self, forURLScheme: "oracle")
        let listen = """
        document.addEventListener('securitypolicyviolation', (e) => {
          webkit.messageHandlers.v.postMessage({ directive: e.effectiveDirective || e.violatedDirective || '', sample: e.sample || '', blocked: e.blockedURI || '' })
        }, true)
        """
        cfg.userContentController.addUserScript(WKUserScript(source: listen, injectionTime: .atDocumentStart, forMainFrameOnly: false, in: .defaultClient))
        cfg.userContentController.add(self, contentWorld: .defaultClient, name: "v")
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: 800, height: 600), configuration: cfg)
        web.navigationDelegate = self
        next()
    }

    func next() {
        guard index < cases.count else { exit(0) }
        violations = []; loaded = false
        web.load(URLRequest(url: URL(string: "oracle://doc/\(index).html")!))
        // a page that never finishes still gets judged on what it did
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: false) { [weak self] _ in self?.finish() }
    }

    func finish() {
        timer?.invalidate(); timer = nil
        let out: [String: Any] = ["file": cases[index].file, "loaded": loaded, "violations": violations]
        print(String(decoding: try! JSONSerialization.data(withJSONObject: out, options: [.sortedKeys]), as: UTF8.self))
        fflush(stdout)
        index += 1
        next()
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url, url.lastPathComponent == "\(index).html",
              let body = FileManager.default.contents(atPath: cases[index].file) else {
            task.didFailWithError(URLError(.resourceUnavailable)); return
        }
        task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [
            "Content-Type": "text/html; charset=utf-8",
            "Content-Security-Policy": cases[index].csp,
        ])!)
        task.didReceive(body)
        task.didFinish()
    }
    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        guard let d = m.body as? [String: Any] else { return }
        violations.append(["directive": "\(d["directive"] ?? "")", "sample": "\(d["sample"] ?? "")", "blocked": "\(d["blocked"] ?? "")"])
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loaded = true
        // let violations raised during load reach the handler before judging
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: false) { [weak self] _ in self?.finish() }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { finish() }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { finish() }
}

let cases = try! JSONDecoder().decode([Case].self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let oracle = Oracle()
DispatchQueue.main.async { oracle.start(cases) }
app.run()
