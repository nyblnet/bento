import UIKit
import UniformTypeIdentifiers
import WebKit

/// WKWebView only shows the keyboard for focus caused directly by a user tap on
/// the element; bento focuses its text editors from its own tap handling, which
/// WebKit classes as programmatic → no keyboard. This rewrites the internal
/// focus call to always count as user-interactive (the long-standing
/// Ionic/Cordova workaround). If the selector ever disappears, this is a no-op.
private func allowProgrammaticKeyboard() {
    guard let contentView = NSClassFromString("WKContentView") else { return }
    let sel = sel_getUid(
        "_elementDidFocus:userIsInteracting:blurPreviousNode:activityStateChanges:userObject:")
    guard let method = class_getInstanceMethod(contentView, sel) else { return }
    typealias Original = @convention(c)
        (Any, Selector, UnsafeRawPointer, Bool, Bool, Int, Any?) -> Void
    let original = unsafeBitCast(method_getImplementation(method), to: Original.self)
    let block: @convention(block) (Any, UnsafeRawPointer, Bool, Bool, Int, Any?) -> Void = {
        me, node, _, blurPrevious, activityState, userObject in
        original(me, sel, node, true, blurPrevious, activityState, userObject)
    }
    method_setImplementation(method, imp_implementationWithBlock(block))
}

/// Hosts bento full-screen with no native chrome. Bento's own buttons drive the
/// native document cycle through the injected File System Access shim:
///   open  → injected toolbar button / Files tap → native picker, the picked
///           file becomes the backing document
///   save  → written back to the backing document in place (no dialog);
///           Files export sheet when there is no backing file (save-as)
/// localStorage is bridged to UserDefaults so bento's preferences survive
/// regardless of WKWebView's file-origin storage quirks.
class ViewController: UIViewController, WKScriptMessageHandler, WKUIDelegate,
                      WKNavigationDelegate, UIDocumentPickerDelegate {

    private var webView: WKWebView!

    /// Security-scoped bookmark of the deck file backing the current session.
    /// nil while running the default (bundled/OTA) deck.
    private var backingBookmark: Data?
    private var backingName: String?
    /// The sandboxed file actually rendered by the web view.
    private var renderURL: URL!

    private enum PickerMode { case none, open, export }
    private var pickerMode: PickerMode = .none
    private var pendingOpenURL: URL?

    private var documentsDir: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    }
    private var otaDeck: URL { documentsDir.appendingPathComponent("bento.html") }
    private var externalCopy: URL { documentsDir.appendingPathComponent("opened.bento.html") }

    private var defaultDeck: URL {
        FileManager.default.fileExists(atPath: otaDeck.path)
            ? otaDeck
            : Bundle.main.url(forResource: "bento", withExtension: "html")!
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        allowProgrammaticKeyboard()

        let controller = WKUserContentController()
        controller.add(self, name: "bento")

        let config = WKWebViewConfiguration()
        config.userContentController = controller
        config.mediaTypesRequiringUserActionForPlayback = []
        if #available(iOS 15.4, *) {
            config.preferences.isElementFullscreenEnabled = true
        }

        webView = WKWebView(frame: .zero, configuration: config)
        webView.uiDelegate = self
        webView.navigationDelegate = self
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        view.addSubview(webView)

        webView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
        ])

        if let pending = pendingOpenURL {
            pendingOpenURL = nil
            openExternal(url: pending)
        } else {
            loadDefaultDeck()
        }

        checkForUpdate()
    }

    // MARK: - Deck loading

    private func loadDefaultDeck() {
        backingBookmark = nil
        backingName = nil
        load(render: defaultDeck)
    }

    private func load(render url: URL) {
        renderURL = url
        refreshUserScripts()
        webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
    }

    /// Load a deck file from outside the sandbox (Files tap, Mail, AirDrop, or
    /// the injected Open button). A sandboxed copy is rendered for a stable
    /// file origin; saves are written back to the original in place.
    func openExternal(url: URL) {
        guard webView != nil else {
            pendingOpenURL = url  // launched cold via a file tap
            return
        }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url),
              (try? data.write(to: externalCopy, options: .atomic)) != nil
        else { return }
        backingBookmark = try? url.bookmarkData()
        backingName = url.lastPathComponent
        load(render: externalCopy)
    }

    /// User scripts are rebuilt before every load so the localStorage seed
    /// reflects the latest persisted state.
    private func refreshUserScripts() {
        let store = UserDefaults.standard.dictionary(forKey: "bentoLS") as? [String: String] ?? [:]
        let seed = (try? JSONSerialization.data(withJSONObject: store))
            .flatMap { String(data: $0, encoding: .utf8) } ?? "{}"

        let ucc = webView.configuration.userContentController
        ucc.removeAllUserScripts()
        ucc.addUserScript(WKUserScript(
            source: Self.storageJS.replacingOccurrences(of: "__SEED__", with: seed),
            injectionTime: .atDocumentStart, forMainFrameOnly: true))
        ucc.addUserScript(WKUserScript(
            source: Self.shimJS, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        ucc.addUserScript(WKUserScript(
            source: Self.logoMenuJS, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        // Removes the 350ms tap delay; the double-tap zoom itself is killed
        // natively in disableDoubleTapZoom().
        ucc.addUserScript(WKUserScript(
            source: """
                (function () {
                  var s = document.createElement('style');
                  s.textContent = 'html { touch-action: manipulation; }';
                  document.documentElement.appendChild(s);
                })();
                """,
            injectionTime: .atDocumentStart, forMainFrameOnly: true))
        ucc.addUserScript(WKUserScript(
            source: Self.editButtonJS, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
    }

    // MARK: - Shim messages

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard message.name == "bento",
              let body = message.body as? [String: Any],
              let action = body["action"] as? String
        else { return }

        switch action {
        case "save":
            let name = (body["name"] as? String).map { ($0 as NSString).lastPathComponent }
                ?? "presentation.bento.html"
            save(name: name, text: body["text"] as? String ?? "")
        case "open":
            presentOpenPicker()
        case "menu":
            let rect = CGRect(x: body["x"] as? Double ?? 20,
                              y: body["y"] as? Double ?? 20,
                              width: body["w"] as? Double ?? 44,
                              height: body["h"] as? Double ?? 32)
            presentDocumentMenu(anchor: rect)
        case "ls":
            var store = UserDefaults.standard.dictionary(forKey: "bentoLS") as? [String: String] ?? [:]
            if let key = body["key"] as? String {
                store[key] = body["value"] as? String  // nil value removes
            } else {
                store = [:]  // clear()
            }
            UserDefaults.standard.set(store, forKey: "bentoLS")
        default:
            break
        }
    }

    // MARK: - Document menu (logo tap)

    private func presentOpenPicker() {
        pickerMode = .open
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.html])
        picker.delegate = self
        present(picker, animated: true)
    }

    /// Native action sheet replacing bento's logo tap. Save / Save As drive
    /// bento's own handlers; Settings passes the tap through to what the logo
    /// would normally show.
    private func presentDocumentMenu(anchor: CGRect) {
        let menu = UIAlertController(title: backingName ?? "Bento",
                                     message: nil, preferredStyle: .actionSheet)

        menu.addAction(UIAlertAction(title: "Save", style: .default) { [weak self] _ in
            // Bento's save button carries "(⌘S)" in its tooltip in every locale;
            // fall back to the keyboard shortcut if the topbar changed.
            self?.webView.evaluateJavaScript("""
                (function () {
                  var bar = document.querySelector('.ed-topbar');
                  var btn = bar && Array.prototype.find.call(
                    bar.querySelectorAll('button'),
                    function (b) { return (b.title || '').indexOf('\\u2318S') >= 0; });
                  if (btn) { btn.click(); return; }
                  document.dispatchEvent(new KeyboardEvent('keydown',
                    { key: 's', code: 'KeyS', keyCode: 83, metaKey: true,
                      bubbles: true, cancelable: true }));
                })();
                """)
        })

        menu.addAction(UIAlertAction(title: "Save As…", style: .default) { [weak self] _ in
            // Opens bento's own save-as dropdown (copy, new deck, password…).
            self?.webView.evaluateJavaScript(
                "document.querySelector('.ed-topbar .ed-split-caret')?.click()")
        })

        menu.addAction(UIAlertAction(title: "Open…", style: .default) { [weak self] _ in
            self?.presentOpenPicker()
        })

        menu.addAction(UIAlertAction(title: "Settings…", style: .default) { [weak self] _ in
            self?.webView.evaluateJavaScript("""
                (function () {
                  var logo = document.querySelector('.ed-logo');
                  if (logo) { window.__bentoAllowLogo = true; logo.click(); }
                })();
                """)
        })

        menu.addAction(UIAlertAction(title: "Cancel", style: .cancel))

        if let popover = menu.popoverPresentationController {
            let zoom = webView.pageZoom
            popover.sourceView = webView
            popover.sourceRect = CGRect(x: anchor.minX * zoom, y: anchor.minY * zoom,
                                        width: anchor.width * zoom, height: anchor.height * zoom)
        }
        present(menu, animated: true)
    }

    /// In-place save to the backing document; export sheet when there is none
    /// or the deck was renamed (save-as).
    private func save(name: String, text: String) {
        if let bookmark = backingBookmark, name == backingName,
           writeBack(bookmark: bookmark, text: text) {
            if renderURL == externalCopy {
                try? text.write(to: externalCopy, atomically: true, encoding: .utf8)
            }
            return
        }
        if backingBookmark == nil {
            // First save of the default deck: it becomes the user's own file in
            // Documents (visible in Files ▸ Bento) and saves in place from then
            // on. Kept separate from the OTA engine copy so updates can never
            // clobber user edits.
            let dst = documentsDir.appendingPathComponent(name)
            if (try? text.write(to: dst, atomically: true, encoding: .utf8)) != nil {
                backingBookmark = try? dst.bookmarkData()
                backingName = name
                return
            }
        }
        exportSheet(name: name, text: text)
    }

    private func writeBack(bookmark: Data, text: String) -> Bool {
        var stale = false
        guard let url = try? URL(resolvingBookmarkData: bookmark, bookmarkDataIsStale: &stale)
        else { return false }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }

        var ok = false
        NSFileCoordinator().coordinate(writingItemAt: url, options: .forReplacing,
                                       error: nil) { dst in
            ok = (try? text.write(to: dst, atomically: true, encoding: .utf8)) != nil
        }
        if ok, stale { backingBookmark = try? url.bookmarkData() }
        return ok
    }

    private func exportSheet(name: String, text: String) {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(name)
        guard (try? text.write(to: tmp, atomically: true, encoding: .utf8)) != nil else { return }
        pickerMode = .export
        let picker = UIDocumentPickerViewController(forExporting: [tmp], asCopy: true)
        picker.delegate = self
        present(picker, animated: true)
    }

    // MARK: - Document picker results

    func documentPicker(_ controller: UIDocumentPickerViewController,
                        didPickDocumentsAt urls: [URL]) {
        let mode = pickerMode
        pickerMode = .none
        guard mode == .open, let url = urls.first else { return }
        openExternal(url: url)
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        pickerMode = .none
    }

    // MARK: - Gestures

    /// WKWebView's double-tap-to-zoom is a native recognizer that ignores CSS
    /// touch-action; disabling it is the only reliable off switch. WebKit can
    /// re-arm recognizers after layout, so this is re-applied after each load
    /// (with a delayed second pass).
    private func disableDoubleTapZoom() {
        for sub in webView.scrollView.subviews {
            for recognizer in sub.gestureRecognizers ?? [] {
                if let tap = recognizer as? UITapGestureRecognizer,
                   tap.numberOfTapsRequired >= 2 {
                    tap.isEnabled = false
                }
            }
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        disableDoubleTapZoom()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            self?.disableDoubleTapZoom()
        }
    }

    // MARK: - Resilience

    /// The web content process can be killed under memory pressure (heavy
    /// rotations included); a blank view otherwise stays blank forever.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if let url = renderURL {
            load(render: url)
        }
    }

    // MARK: - OTA update (applies on next launch)

    private func checkForUpdate() {
        let api = URL(string: "https://api.github.com/repos/nyblnet/bento/releases/latest")!
        URLSession.shared.dataTask(with: api) { [weak self] data, _, _ in
            guard let self,
                  let data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let tag = json["tag_name"] as? String,
                  tag != UserDefaults.standard.string(forKey: "otaTag"),
                  let assets = json["assets"] as? [[String: Any]],
                  let asset = assets.first(where: { ($0["name"] as? String)?.hasSuffix(".html") == true }),
                  let urlString = asset["browser_download_url"] as? String,
                  let assetURL = URL(string: urlString)
            else { return }

            URLSession.shared.dataTask(with: assetURL) { body, _, _ in
                guard let body,
                      body.count > 100_000,
                      String(data: body.prefix(4096), encoding: .utf8)?.contains("<") == true
                else { return }
                do {
                    try body.write(to: self.otaDeck, options: .atomic)
                    UserDefaults.standard.set(tag, forKey: "otaTag")
                } catch {}
            }.resume()
        }.resume()
    }

    // MARK: - JS dialogs → native alerts

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        alert.addTextField { $0.text = defaultText }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in
            completionHandler(alert.textFields?.first?.text)
        })
        present(alert, animated: true)
    }

    // MARK: - Injected scripts

    /// localStorage bridged to UserDefaults: immune to WKWebView's file/opaque
    /// origin storage quirks. Seeded synchronously, persisted via the bridge.
    private static let storageJS = """
        (function () {
          var data = __SEED__;
          function post(k, v) {
            webkit.messageHandlers.bento.postMessage({ action: 'ls', key: k, value: v });
          }
          var shim = {
            getItem: function (k) {
              return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null;
            },
            setItem: function (k, v) { v = String(v); data[k] = v; post(k, v); },
            removeItem: function (k) { delete data[k]; post(k, null); },
            clear: function () { data = {}; post(null, null); },
            key: function (i) {
              var keys = Object.keys(data);
              return i >= 0 && i < keys.length ? keys[i] : null;
            }
          };
          Object.defineProperty(shim, 'length', {
            get: function () { return Object.keys(data).length; }
          });
          try {
            Object.defineProperty(window, 'localStorage', { value: shim, configurable: true });
          } catch (e) {}
        })();
        """

    // Bridges the File System Access API (absent in WKWebView) to native.
    private static let shimJS = """
        (function () {
          if (window.__bentoShim) return;
          window.__bentoShim = true;

          function post(msg) { webkit.messageHandlers.bento.postMessage(msg); }

          function makeWritable(onClose) {
            return function () {
              var parts = [];
              return Promise.resolve({
                write: function (d) {
                  if (d && typeof d === 'object' && d.data !== undefined &&
                      !(d instanceof Blob) && !(d instanceof ArrayBuffer) && !ArrayBuffer.isView(d)) {
                    d = d.data;
                  }
                  parts.push(d);
                  return Promise.resolve();
                },
                truncate: function () { return Promise.resolve(); },
                seek: function () { return Promise.resolve(); },
                close: function () {
                  return new Blob(parts).text().then(onClose);
                }
              });
            };
          }

          window.showSaveFilePicker = function (opts) {
            var name = (opts && opts.suggestedName) || 'presentation.bento.html';
            return Promise.resolve({
              kind: 'file',
              name: name,
              createWritable: makeWritable(function (t) {
                post({ action: 'save', name: name, text: t });
              }),
              queryPermission: function () { return Promise.resolve('granted'); },
              requestPermission: function () { return Promise.resolve('granted'); }
            });
          };
        })();
        """

    /// Touch affordance for text editing: bento enters text edit on dblclick
    /// (stage listener → startTextEdit on the closest .bento-el-text), which is
    /// awkward on touch. When a text element is tapped (= selected), a floating
    /// ✎ Edit pill appears beside it; tapping the pill dispatches a synthetic
    /// dblclick on the element, entering bento's text editor (the keyboard
    /// swizzle then brings up the keyboard).
    private static let editButtonJS = """
        (function () {
          var btn = null, target = null;

          function hide() {
            if (btn) btn.style.display = 'none';
            target = null;
          }

          function ensureBtn() {
            if (btn) return btn;
            btn = document.createElement('button');
            btn.textContent = '\\u270E Edit';
            btn.setAttribute('style',
              'position:fixed;z-index:99999;display:none;padding:7px 14px;' +
              'background:#fff;color:#1a1a2e;border:1px solid #d8dce4;' +
              'border-radius:999px;font:600 13px -apple-system,sans-serif;' +
              'box-shadow:0 2px 10px rgba(0,0,0,.18);pointer-events:auto;');
            btn.addEventListener('click', function (e) {
              e.stopPropagation();
              if (!target) return;
              var el = target;
              hide();
              var r = el.getBoundingClientRect();
              el.dispatchEvent(new MouseEvent('dblclick', {
                bubbles: true, cancelable: true, view: window,
                clientX: r.left + r.width / 2, clientY: r.top + r.height / 2
              }));
            });
            document.documentElement.appendChild(btn);
            return btn;
          }

          function show(el) {
            target = el;
            var b = ensureBtn();
            var r = el.getBoundingClientRect();
            b.style.display = 'block';
            b.style.left = Math.min(Math.max(8, r.right - 30), window.innerWidth - 90) + 'px';
            b.style.top = Math.max(8, r.top - 44) + 'px';
          }

          document.addEventListener('pointerup', function (e) {
            if (e.target === btn) return;
            var el = e.target && e.target.closest && e.target.closest('.bento-el-text');
            if (el && !el.isContentEditable &&
                !(document.activeElement && document.activeElement.isContentEditable)) {
              setTimeout(function () { show(el); }, 50);
            } else {
              hide();
            }
          }, true);
          window.addEventListener('scroll', hide, true);
          window.addEventListener('resize', hide);
        })();
        """

    /// Tapping bento's logo normally opens project settings. Intercept it (at
    /// capture phase, so nothing else sees the tap) and show the native
    /// document menu instead; the Settings action re-clicks the logo with
    /// __bentoAllowLogo set, letting the original behavior through. If the
    /// topbar markup ever changes, interception silently doesn't attach and
    /// bento behaves as stock.
    private static let logoMenuJS = """
        (function () {
          var tries = 0;
          var timer = setInterval(function () {
            tries++;
            if (tries > 100) { clearInterval(timer); return; }
            var logo = document.querySelector('.ed-topbar .ed-logo');
            if (!logo) return;
            clearInterval(timer);
            logo.addEventListener('click', function (e) {
              if (window.__bentoAllowLogo) { window.__bentoAllowLogo = false; return; }
              e.preventDefault();
              e.stopImmediatePropagation();
              var r = logo.getBoundingClientRect();
              webkit.messageHandlers.bento.postMessage(
                { action: 'menu', x: r.left, y: r.top, w: r.width, h: r.height });
            }, true);
          }, 200);
        })();
        """
}
