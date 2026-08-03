// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

import UIKit
import WebKit
import UniformTypeIdentifiers
import CryptoKit

/// Hosts one open deck in a WKWebView and bridges saving to UIDocument.
///
/// TWO decisions here carry the design:
///
/// 1. The document is served through a CUSTOM SCHEME, never `loadFileURL`. A
///    file:// page in WKWebView gets an opaque, unstable origin, which makes
///    localStorage and IndexedDB unreliable — that would silently break the
///    autosave backstop, the per-device collab member key, and the language and
///    reduce-motion preferences. A custom scheme is a stable secure origin, and
///    it keeps cross-origin fetches to the sync relay well-defined rather than
///    arriving as `Origin: null`.
///
///    The host is PER DOCUMENT, derived from the file's own path, not a single
///    shared `deck`. This app opens ANY self-contained HTML document, not only
///    Bento's, so a shared origin would let one document read another's
///    localStorage and IndexedDB — fine when every file is yours, a real leak
///    between unrelated third-party apps. Derived rather than random because
///    the origin IS the storage boundary: a fresh host per launch would wipe
///    that storage on every open. The trade is that moving or renaming a file
///    gives it a new origin and orphans its local state; that state is a
///    cache-and-backstop, never the document itself, which is why this is the
///    right way round.
///
/// 2. The web content is the DOCUMENT'S OWN runtime. The app bundles no shell
///    for rendering and has no opinion about which version a deck carries, so a
///    deck self-updates through Bento's normal signed channel and iOS users get
///    the same release as everyone else on the same day — no App Store
///    submission per release, no drift. What the app ships is file access.
final class EditorViewController: UIViewController, WKScriptMessageHandler, WKURLSchemeHandler,
                                  WKNavigationDelegate, WKDownloadDelegate {
    private let document: BentoDocument
    private var webView: WKWebView!

    /// Has the open document been handed to the web app yet? Bento only reaches
    /// a picker when it holds no handle — afterwards ⌘S, autosave write-back and
    /// in-place update all reuse it. So the FIRST request targets this document
    /// and needs no UI; any later one is a genuine Save-As or export and must
    /// not overwrite it. Comparing filenames instead would fail: Bento derives
    /// its suggested name from the deck TITLE, so it rarely matches.
    private var openDocumentVended = false
    private var isPresentingFullscreen = false
    private var fullscreenObs: NSKeyValueObservation?
    private var pendingExportName: String?

    /// Stable per-document host: a truncated SHA-256 of the file's path. Hex
    /// only, so it is always a valid host component.
    private lazy var originHost: String = {
        let path = document.fileURL.standardizedFileURL.path
        let digest = SHA256.hash(data: Data(path.utf8))
        return digest.compactMap { String(format: "%02x", $0) }.joined().prefix(24).description
    }()

    /// Called when the user leaves the document. The browser owns teardown —
    /// closing the UIDocument and releasing the security scope — because it
    /// owns both of those.
    var onDone: (() -> Void)?

    init(document: BentoDocument) {
        self.document = document
        super.init(nibName: nil, bundle: nil)
    }

    @objc private func doneTapped() { onDone?() }

    /// Fallback exit for when the nav bar is hidden (landscape).
    ///
    /// Deliberately DARK, not a light translucent pill: the first attempt used
    /// 70%-white on Bento's white editor and was invisible on screen.
    ///
    /// Bottom-leading, not top-leading. Bento's editor occupies every top edge
    /// — logo, toolbar, thumbnail rail — so a control up there lands on the
    /// wordmark. Any host control overlaps SOMETHING while the page's own
    /// chrome is this dense; the bottom-left corner is the quietest, and it is
    /// where a thumb rests when a phone is held sideways.
    private lazy var floatingExit: UIButton = {
        let b = UIButton(type: .system)
        var cfg = UIButton.Configuration.filled()
        cfg.image = UIImage(systemName: "chevron.left",
                            withConfiguration: UIImage.SymbolConfiguration(weight: .semibold))
        cfg.cornerStyle = .capsule
        cfg.baseBackgroundColor = UIColor.label.withAlphaComponent(0.55)
        cfg.baseForegroundColor = .systemBackground
        cfg.contentInsets = .init(top: 10, leading: 12, bottom: 10, trailing: 12)
        b.configuration = cfg
        b.accessibilityLabel = NSLocalizedString("Documents", comment: "back to the file browser")
        b.addTarget(self, action: #selector(doneTapped), for: .touchUpInside)
        b.isHidden = true
        return b
    }()

    /// Fade the exit out when nothing is happening, and bring it back on touch.
    ///
    /// Necessary because on iPhone there is no longer a fullscreen signal to key
    /// off: a page presenting itself by filling the web view looks, to the host,
    /// exactly like a page sitting idle. Rather than guess what the document is
    /// doing — which is the one thing this host refuses to do — the control
    /// simply gets out of the way when unused, which is right for presenting and
    /// harmless while editing.
    private func armIdleFade() {
        idleTimer?.invalidate()
        floatingExit.alpha = 1
        idleTimer = Timer.scheduledTimer(withTimeInterval: 3.5, repeats: false) { [weak self] _ in
            UIView.animate(withDuration: 0.4) { self?.floatingExit.alpha = 0.12 }
        }
    }

    /// The host shows ONE small control and nothing else.
    ///
    /// The nav bar is hidden in BOTH orientations now. The document already has
    /// its own toolbar, so a native bar above it was a second row of chrome
    /// competing with the first — it pushed Bento's topbar down and spent 44pt
    /// of a screen that has none to spare. Portrait is not as tight as
    /// landscape, but the bar was no more justified there; it was only ever a
    /// way to offer an exit, and the floating control does that for a fraction
    /// of the space.
    ///
    /// (`hidesBarsWhenVerticallyCompact` was tried early on and simply does not
    /// fire for a modally-presented navigation controller.)
    private func syncChrome() {
        navigationController?.setNavigationBarHidden(true, animated: false)
        floatingExit.isHidden = isPresentingFullscreen
        if !floatingExit.isHidden { armIdleFade() }
        view.bringSubviewToFront(floatingExit)
    }

    /// Hide the status bar wherever nothing forces it to exist.
    ///
    /// On iPad it is pure cost. There is no sensor housing to reserve a band
    /// for, so the status bar is the ONLY thing keeping the page off the whole
    /// screen — and it stayed lit over a presenting deck, which is the opposite
    /// of what presenting is for. Hiding it takes safeAreaInsets.top to 0, and
    /// the deck then goes edge to edge with even letterboxing.
    ///
    /// On iPhone it would buy nothing: landscape hides it already, and portrait
    /// draws it INSIDE the band the sensor housing reserves regardless, so
    /// hiding there would blank that band rather than reclaim it — losing the
    /// clock to gain no pixels.
    override var prefersStatusBarHidden: Bool {
        UIDevice.current.userInterfaceIdiom == .pad
    }

    /// Reserve exactly what the system says is unsafe at the top, and nothing
    /// else — so a document's own toolbar is reachable but never gives up a
    /// pixel it did not have to.
    ///
    /// Done NATIVELY rather than by asking the page to pad itself. env() is dead
    /// in this WKWebView, and --tray-safe-* only helps a page that has heard of
    /// this host — a third-party HTML file has no way to know, so its top
    /// controls ended up under the pill and could not be tapped. Insetting the
    /// web view works for every document without any cooperation.
    ///
    /// `safeAreaInsets.top` is the whole rule now, and it already says the right
    /// thing everywhere: iPhone portrait reports the sensor housing, so the page
    /// starts below the pill; iPhone landscape and iPad both report 0 once the
    /// status bar is gone, so the page gets the entire screen. No orientation or
    /// device test — the earlier one claimed landscape was always full bleed,
    /// which iPad quietly disproved.
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let top = view.safeAreaInsets.top
        webView.frame = CGRect(x: 0, y: top, width: view.bounds.width,
                               height: max(0, view.bounds.height - top))
        publishSafeArea(topHandledNatively: top > 0)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        view.setNeedsLayout()
    }

    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        view.setNeedsLayout()
    }

    /// Hand the real insets to the page as CSS custom properties.
    ///
    /// This exists because env(safe-area-inset-*) is DEAD in this WKWebView:
    /// the native view reports 62/0/34/0 while CSS reads 0px, with or without
    /// contentInsetAdjustmentBehavior. A page therefore cannot keep its chrome
    /// clear of the status bar or home indicator by the standard mechanism, and
    /// the host is the only thing that knows the numbers.
    ///
    /// Published as `--tray-safe-*` on the root element. A page that never
    /// heard of this host is unaffected: the variables go unread and it gets the
    /// same full-bleed treatment a browser would give it.
    private func publishSafeArea(topHandledNatively: Bool) {
        let i = view.safeAreaInsets
        // Report top as 0 when the web view is already inset by it, or a page
        // that DOES read these would pad twice.
        let top = topHandledNatively ? 0 : Int(i.top)
        let js = "(function(){var r=document.documentElement.style;"
            + "r.setProperty('--tray-safe-top','\(top)px');"
            + "r.setProperty('--tray-safe-right','\(Int(i.right))px');"
            + "r.setProperty('--tray-safe-bottom','\(Int(i.bottom))px');"
            + "r.setProperty('--tray-safe-left','\(Int(i.left))px');})();"
        webView.evaluateJavaScript(js)
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        syncChrome()
    }

    /// While the page is presenting, the host shows NOTHING. Element fullscreen
    /// puts the deck edge to edge, and a floating control sitting over it is
    /// exactly the chrome a slideshow is supposed to shed. Restored on exit.
    private func observeFullscreen() {
        fullscreenObs = webView.observe(\.fullscreenState, options: [.new]) { [weak self] wv, _ in
            guard let self else { return }
            let presenting = wv.fullscreenState == .inFullscreen || wv.fullscreenState == .enteringFullscreen
            self.isPresentingFullscreen = presenting
            self.syncChrome()
        }
    }

    override func traitCollectionDidChange(_ previous: UITraitCollection?) {
        super.traitCollectionDidChange(previous)
        if traitCollection.verticalSizeClass != previous?.verticalSizeClass { syncChrome() }
    }
    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        let cfg = WKWebViewConfiguration()
        // Element fullscreen is DECLINED on every device.
        //
        // WKWebView offers it as an opt-in that mobile Safari never gives a
        // page, so it looked like free capability. It is not. WebKit's
        // fullscreen view brings its own close button that no public API can
        // hide, restyle or move, and it insets the content — so a 16:9 deck
        // letterboxed asymmetrically, and the foreign ✕ spilled off the
        // letterbox onto the slide. It does not even hide the status bar on
        // iPad, so it fails at the one thing fullscreen is for.
        //
        // Declining costs nothing, because the host hands the page the whole
        // screen anyway (see prefersStatusBarHidden and viewDidLayoutSubviews):
        // the deck then fills the web view edge to edge, letterboxes evenly,
        // and wears its OWN chrome instead of WebKit's.
        //
        // A page refused fullscreen is not broken — that is exactly the path it
        // takes in mobile Safari, which is the well-trodden one.
        cfg.preferences.isElementFullscreenEnabled = false
        cfg.setURLSchemeHandler(self, forURLScheme: "bento-tray")
        cfg.userContentController.add(self, name: "bentoFile")

        // .atDocumentStart is required, not stylistic: Bento decides whether it
        // can save during boot, so a bridge injected later arrives after the
        // editor has already concluded it cannot.
        if let js = Bundle.main.url(forResource: "bridge", withExtension: "js"),
           let src = try? String(contentsOf: js, encoding: .utf8) {
            cfg.userContentController.addUserScript(
                WKUserScript(source: src, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }

        webView = WKWebView(frame: view.bounds, configuration: cfg)
        // frame is driven by viewDidLayoutSubviews, not autoresizing
        webView.allowsBackForwardNavigationGestures = false
        webView.navigationDelegate = self
        // Full bleed. WKWebView does NOT hand safe-area insets to CSS here —
        // measured both ways: with `.never` the page filled the screen and
        // env(safe-area-inset-*) read 0px on all four sides; with the default it
        // read 0px AND inset the content (innerHeight 956 -> 860). Since env()
        // is unusable either way, take the full screen and publish the insets
        // ourselves — see publishSafeArea().
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        view.addSubview(webView)
        observeFullscreen()
        webView.load(URLRequest(url: URL(string: "bento-tray://\(originHost)/index.html")!))

        view.addGestureRecognizer(TouchWatcher { [weak self] in self?.armIdleFade() })

        view.addSubview(floatingExit)
        floatingExit.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            floatingExit.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 10),
            floatingExit.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -10),
            // Explicit size rather than relying on intrinsic content size.
            floatingExit.widthAnchor.constraint(equalToConstant: 44),
            floatingExit.heightAnchor.constraint(equalToConstant: 44),
        ])

        // A way BACK. Presented full screen with no chrome, a document was a
        // one-way trip: full-screen modals have no interactive dismiss, so the
        // only exit was force-quitting the app. The host has to supply this
        // itself — it cannot ask the page for a close button without assuming
        // what the page is.
        navigationItem.leftBarButtonItem = UIBarButtonItem(
            title: NSLocalizedString("Documents", comment: "back to the file browser"),
            style: .plain, target: self, action: #selector(doneTapped))
    }

    // MARK: - serving the deck

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        let resp = HTTPURLResponse(url: task.request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
                                   headerFields: ["Content-Type": "text/html; charset=utf-8",
                                                  "Content-Length": String(document.html.count)])!
        task.didReceive(resp)
        task.didReceive(document.html)
        task.didFinish()
    }
    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

    // MARK: - downloads
    //
    // Not every self-contained HTML app saves through the File System Access
    // API. The older and still commonest idiom is a Blob plus `<a download>` —
    // TiddlyWiki, and most "export this page" tools. WKWebView DROPS those
    // silently unless a download delegate exists, so the button appears to do
    // nothing at all, which is the worst possible failure for a save.
    //
    // Downloads land in the app's Documents folder, which is visible in Files
    // under Bento Tray. A picker per save would be punishing for an app that
    // saves often, and a download cannot overwrite the user's original anyway —
    // that is what the FSA path is for.

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(navigationAction.shouldPerformDownload ? .download : .allow)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction,
                 didBecome download: WKDownload) { download.delegate = self }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse,
                 didBecome download: WKDownload) { download.delegate = self }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        guard let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
        else { completionHandler(nil); return }
        var dest = docs.appendingPathComponent(suggestedFilename)
        // never clobber: downloads are new files by definition
        var n = 2
        let ext = dest.pathExtension
        let stem = dest.deletingPathExtension().lastPathComponent
        while FileManager.default.fileExists(atPath: dest.path) {
            dest = docs.appendingPathComponent(ext.isEmpty ? "\(stem) \(n)" : "\(stem) \(n).\(ext)")
            n += 1
        }
        lastDownloadName = dest.lastPathComponent
        completionHandler(dest)
    }

    func downloadDidFinish(_ download: WKDownload) {
        notify(String(format: NSLocalizedString("Saved “%@” to this app’s folder in Files.",
                                                comment: "download finished"), lastDownloadName ?? "file"))
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        notify(NSLocalizedString("That download could not be saved.", comment: "download failed"))
    }

    private var lastDownloadName: String?
    private var idleTimer: Timer?

    private func notify(_ message: String) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: NSLocalizedString("OK", comment: ""), style: .default))
        present(a, animated: true)
    }

    // MARK: - the save bridge

    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let m = message.body as? [String: Any],
              let id = m["id"] as? Int, let op = m["op"] as? String else { return }

        switch op {
        case "begin":
            if !openDocumentVended {
                openDocumentVended = true
                reply(id, ok: true, value: document.fileURL.lastPathComponent)
            } else {
                // A copy/template/read-only export. Ask where it goes; it must
                // never land on the open document.
                pendingExportName = (m["suggestedName"] as? String) ?? "deck.bento.html"
                reply(id, ok: true, value: pendingExportName!)
            }

        case "read":
            // getFile() and createWritable({keepExistingData}) need the bytes
            // currently on disk. Only the OPEN document is readable — an export
            // target is somewhere we were handed once and do not hold.
            let want = (m["name"] as? String) ?? ""
            if want == document.fileURL.lastPathComponent {
                reply(id, ok: true, value: String(data: document.html, encoding: .utf8) ?? "")
            } else {
                reply(id, ok: true, value: nil)
            }

        case "write":
            let text = (m["text"] as? String) ?? ""
            let name = (m["name"] as? String) ?? ""
            if name == document.fileURL.lastPathComponent {
                document.html = Data(text.utf8)
                // updateChangeCount + autosave is the sanctioned path: it
                // coordinates with iCloud and file coordination rather than
                // writing behind UIDocument's back.
                document.updateChangeCount(.done)
                document.save(to: document.fileURL, for: .forOverwriting) { [weak self] ok in
                    self?.reply(id, ok: ok, value: ok ? nil : "write failed")
                }
            } else {
                exportCopy(named: name, text: text) { [weak self] ok, err in
                    self?.reply(id, ok: ok, value: err)
                }
            }

        default:
            reply(id, ok: false, value: "unknown op")
        }
    }

    private func reply(_ id: Int, ok: Bool, value: String?) {
        let arg = value.map { "\"\($0.replacingOccurrences(of: "\"", with: "\\\""))\"" } ?? "null"
        webView.evaluateJavaScript("window.__bentoNativeReply(\(id), \(ok), \(arg))")
    }

    /// Write an exported copy to a temp file and let the user place it. Kept
    /// separate from the open document on purpose — a share export carries
    /// different credentials (a read-only copy has the owner keys stripped), so
    /// overwriting the original with one would be a real data loss.
    private func exportCopy(named name: String, text: String, done: @escaping (Bool, String?) -> Void) {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(name)
        do { try Data(text.utf8).write(to: tmp) } catch { done(false, "\(error)"); return }
        let picker = UIDocumentPickerViewController(forExporting: [tmp], asCopy: true)
        present(picker, animated: true) { done(true, nil) }
    }
}

/// Reports that a touch began and then immediately FAILS, so it can never
/// recognize, consume, delay or cancel anything the page is doing.
///
/// A UITapGestureRecognizer was the obvious choice and the wrong one: it fires
/// only on a discrete tap, so a presenter swiping through a deck would never
/// wake the exit control — the gesture that most needs to keep it alive is the
/// one a tap recognizer cannot see. Observing touchesBegan catches every kind.
final class TouchWatcher: UIGestureRecognizer {
    private let onTouch: () -> Void

    init(onTouch: @escaping () -> Void) {
        self.onTouch = onTouch
        super.init(target: nil, action: nil)
        cancelsTouchesInView = false
        delaysTouchesBegan = false
        delaysTouchesEnded = false
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        onTouch()
        state = .failed
    }
}
