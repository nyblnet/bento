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
    /// not overwrite it. Deciding that from the suggested name instead would
    /// fail: Bento derives it from the deck TITLE, so it rarely matches, and
    /// every save would wrongly prompt.
    private var openDocumentVended = false
    private var isPresentingFullscreen = false
    private var fullscreenObs: NSKeyValueObservation?

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
        // suggestedFilename is page-influenced (`<a download>` carries it), and
        // WebKit's sanitisation of it is undocumented — so it goes through the
        // same filter as an export name rather than resting on that. SUBSTITUTED
        // rather than refused, unlike an export: refusing loses a save the user
        // asked for, and here the directory is fixed and the loop below can only
        // create a new file, so a bad name costs a name, never a file.
        var dest = docs.appendingPathComponent(safeFileName(suggestedFilename) ?? "download.html")
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
                //
                // Normalised HERE as well as at the write, because this name is
                // handed back to the page and comes straight back as the write
                // target: sanitising only one end would leave the two disagreeing
                // about what file the handle refers to.
                reply(id, ok: true, value: exportName(m["suggestedName"] as? String))
            }

        case "read":
            // getFile() and createWritable({keepExistingData}) need the bytes
            // currently on disk. Only the OPEN document is readable — an export
            // target is somewhere we were handed once and do not hold.
            let want = (m["name"] as? String) ?? ""
            if targetsOpenDocument(want) {
                reply(id, ok: true, value: String(data: document.html, encoding: .utf8) ?? "")
            } else {
                reply(id, ok: true, value: nil)
            }

        case "write":
            let text = (m["text"] as? String) ?? ""
            let name = (m["name"] as? String) ?? ""
            if targetsOpenDocument(name) {
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

    /// The name to vend for an export handle: sanitised, and never the open
    /// document's.
    ///
    /// The vended name IS the handle as far as this bridge is concerned — read
    /// and write carry nothing else to tell two handles apart — so an export
    /// vended under the open document's filename would BE the open document's
    /// handle, and its close() would overwrite the original in place. That is
    /// the loss exportCopy exists to prevent (an export carries different
    /// credentials: a read-only copy has the owner keys stripped), and it is not
    /// exotic: Bento suggests an export name derived from the deck TITLE, so a
    /// deck saved under its own title — "Notes" as Notes.bento.html — makes
    /// "Duplicate as new deck…" suggest exactly the open file's name.
    ///
    /// Disambiguated rather than refused, because the export is a save the user
    /// asked for and the picker still shows them where it lands. Prefixed rather
    /// than numbered, because ".bento.html" is a DOUBLE extension that
    /// deletingPathExtension splits down the middle ("Notes.bento 2.html").
    private func exportName(_ suggested: String?) -> String {
        let name = safeFileName(suggested) ?? "deck.bento.html"
        return name == document.fileURL.lastPathComponent ? "copy of \(name)" : name
    }

    /// Does a read/write from the page address the OPEN document, or an export?
    ///
    /// Both halves are load-bearing. Comparing names is only sound because
    /// exportName() guarantees no export handle is ever vended under this name;
    /// requiring that the document was actually vended means a name the page
    /// produced on its own — no handle for it ever handed out — cannot address
    /// the file on disk. Routing on `openDocumentVended` alone could not work:
    /// the page can hold the document's handle AND an export's at once, so which
    /// handle a write came through is the question, not how many exist.
    private func targetsOpenDocument(_ name: String) -> Bool {
        openDocumentVended && name == document.fileURL.lastPathComponent
    }

    private func reply(_ id: Int, ok: Bool, value: String?) {
        webView.evaluateJavaScript("window.__bentoNativeReply(\(id), \(ok), \(value.map(jsString) ?? "null"))")
    }

    /// Encode one string as a JavaScript literal for the reply call.
    ///
    /// Escaping just `"` by hand was not enough, and the `read` op is the proof:
    /// it returns the WHOLE document HTML, which carries newlines and
    /// backslashes. A raw newline inside a JS string literal is a syntax error,
    /// so the reply never runs, `__bentoNativeReply` never fires and the promise
    /// in bridge.js waits forever — getFile() and createWritable({keepExistingData})
    /// hang rather than fail. A backslash is quieter and worse: save.ts writes
    /// every `<` in the data block as a JSON unicode escape, and interpolated
    /// raw the JS parser CONSUMES that escape — the page gets back a document
    /// whose `#bento-doc` block now contains a literal `<`, which is the one
    /// thing the splice contract escapes it to prevent.
    ///
    /// JSON strings are JS strings, so a JSON encoder is the whole answer.
    ///
    /// The unreachable failure branch replies `null`, not `""`: for the `read`
    /// op an empty string is a CLAIM — that the file on disk is empty — and a
    /// page acting on it would save a document built on nothing. `null` is the
    /// same thing the nil path already sends, and bridge.js turns it into an
    /// empty File either way, so nothing is lost by declining to assert.
    private func jsString(_ s: String) -> String {
        guard let d = try? JSONSerialization.data(withJSONObject: s, options: [.fragmentsAllowed]),
              let out = String(data: d, encoding: .utf8) else { return "null" }
        // JSON leaves U+2028/2029 bare; ES2019 made them legal in a string
        // literal, but this costs nothing and does not bet on the engine vintage.
        return out.replacingOccurrences(of: "\u{2028}", with: "\\u2028")
                  .replacingOccurrences(of: "\u{2029}", with: "\\u2029")
    }

    /// Reduce a page-supplied filename to ONE plain component, or refuse it.
    ///
    /// The name arrives from the document, and this host treats documents as
    /// mutually untrusted (that is why the origin is per-document). Passed
    /// straight to appendingPathComponent, `../Documents/Notes.bento.html`
    /// escapes the temp directory and overwrites a deck the user downloaded
    /// earlier and will later open and trust — and since the write lands BEFORE
    /// the export picker appears, the only thing they are shown is a picker for
    /// a different file. Refused rather than repaired: a legitimate export name
    /// is already a single filename, so anything else is not worth guessing at.
    private func safeFileName(_ raw: String?) -> String? {
        guard let raw else { return nil }
        // lastPathComponent drops any directory part; the remaining tests catch
        // what it leaves behind — "" from an empty name, "/" from bare root, and
        // a leading dot, which covers ".." and hidden files in one.
        let name = (raw as NSString).lastPathComponent
        guard !name.isEmpty, !name.contains("/"), !name.hasPrefix(".") else { return nil }
        return name
    }

    /// Write an exported copy to a temp file and let the user place it. Kept
    /// separate from the open document on purpose — a share export carries
    /// different credentials (a read-only copy has the owner keys stripped), so
    /// overwriting the original with one would be a real data loss.
    private func exportCopy(named name: String, text: String, done: @escaping (Bool, String?) -> Void) {
        guard let safe = safeFileName(name) else { done(false, "unsafe name"); return }
        let dir = FileManager.default.temporaryDirectory
        let tmp = dir.appendingPathComponent(safe)
        // Belt and braces over safeFileName. The write is the step that cannot be
        // taken back, so prove the resolved path is still inside the temp
        // directory instead of trusting that the name tests caught everything.
        // Both sides are standardized from the SAME base url, so this compares
        // like with like rather than /var against /private/var.
        guard tmp.standardizedFileURL.path.hasPrefix(dir.standardizedFileURL.path + "/") else {
            done(false, "unsafe name"); return
        }
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
