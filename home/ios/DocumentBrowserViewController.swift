// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

import UIKit

/// The app's root: the system document browser. Opening IN PLACE is the whole
/// point — the user picks a deck wherever it already lives (Files, iCloud,
/// Dropbox, a Downloads folder) and edits travel back to that same file.
final class DocumentBrowserViewController: UIDocumentBrowserViewController,
                                           UIDocumentBrowserViewControllerDelegate {
    override func viewDidLoad() {
        super.viewDidLoad()
        delegate = self
        allowsDocumentCreation = true
        allowsPickingMultipleItems = false
        // The ONLY styling this screen gets. It is `UIDocumentBrowserViewController`
        // — Files, iCloud Drive, every File Provider on the device, drag-and-drop,
        // rename in place, favourites, tags — and keeping it as iOS designed it is
        // the decision (docs/DECISIONS.md, 2026-08-16), so it is not dressed up.
        // A tint on our own buttons is enough to say the app is ours; a branded
        // bar would fight the system chrome it sits in and win nothing.
        view.tintColor = Brand.accent
        // Search sits BESIDE the browser, never in place of it. The browser's
        // own field searches file names in whatever provider is being browsed;
        // this one searches what the documents say. See SearchViewController.
        additionalTrailingNavigationBarButtonItems = [
            UIBarButtonItem(image: UIImage(systemName: "text.magnifyingglass"),
                            style: .plain, target: self, action: #selector(openSearch))
        ]
    }

    @objc private func openSearch() {
        let search = SearchViewController()
        search.onOpen = { [weak self] url in self?.openEditor(url) }
        let nav = UINavigationController(rootViewController: search)
        present(nav, animated: true)
    }

    /// Open a document the index found. The URL carries its own security scope
    /// (`FolderGrants.detach`), so it outlives the walk that discovered it.
    func openIndexed(_ url: URL) { openEditor(url) }

    /// A new document is fetched from the signed release channel — never bundled.
    ///
    /// The reasoning, the verification and the cache all live in `Releases`.
    /// What belongs here is the browser's own contract:
    ///
    /// The document is placed OURSELVES and handed back with `.none` ("already
    /// in its final location") rather than handing the browser a temp file to
    /// import. Two reasons, both found by testing on iOS 26:
    ///
    /// 1. `didImportDocumentAt` IS NEVER CALLED for the creation flow. The
    ///    creation handler fires and the file lands correctly, but the delegate
    ///    callback never arrives — so the editor never opened and "+" appeared
    ///    to do nothing while silently creating files. Placing the file means we
    ///    hold the URL and can open it directly, depending on no callback.
    /// 2. Naming collisions become ours to control. Letting the system rename
    ///    produced "Untitled.bento 2.html", because it reads `.bento.html` as
    ///    the name "Untitled.bento" plus extension "html" and inserts the
    ///    counter before the last extension only. Ours reads "Untitled 2".
    ///
    /// Unlike Android's `ACTION_CREATE_DOCUMENT`, nothing exists on disk until
    /// we put it there, so a failed fetch needs no clean-up — it just answers
    /// `nil` and no empty document is left behind.
    func documentBrowser(_ c: UIDocumentBrowserViewController,
                         didRequestDocumentCreationWithHandler handler:
                         @escaping (URL?, UIDocumentBrowserViewController.ImportMode) -> Void) {
        chooseApp { [weak self] app in
            guard let self, let app else { handler(nil, .none); return }
            self.create(app, handler)
        }
    }

    /// Which Bento. The list is aspirational on purpose — only slides has a
    /// published channel today, and an unreleased one says so plainly rather
    /// than being hidden, because adding an app to `Releases.apps` is meant to
    /// be the whole integration.
    private func chooseApp(_ done: @escaping (Releases.App?) -> Void) {
        let sheet = UIAlertController(title: "New document", message: nil, preferredStyle: .actionSheet)
        for app in Releases.apps {
            sheet.addAction(UIAlertAction(title: "\(app.label) — \(app.blurb)", style: .default) { _ in
                done(app)
            })
        }
        sheet.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in done(nil) })
        sheet.popoverPresentationController?.sourceView = view
        sheet.popoverPresentationController?.sourceRect =
            CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 0, height: 0)
        present(sheet, animated: true)
    }

    private func create(_ app: Releases.App,
                        _ handler: @escaping (URL?, UIDocumentBrowserViewController.ImportMode) -> Void) {
        let waiting = UIAlertController(title: nil, message: "Fetching \(app.label)…", preferredStyle: .alert)
        present(waiting, animated: true)

        Task { @MainActor in
            var failure: String?
            var bytes: Data?
            do {
                bytes = try await Releases.seed(for: app)
            } catch {
                failure = error.localizedDescription
                // Offline, or the server is down. A shell cached by an earlier
                // "New" is still a signed release — it was verified when it was
                // cached — so it is a sound fallback rather than a guess.
                bytes = Releases.anyCached(app)
            }

            // WAIT for the spinner to be fully gone before anything else is
            // presented. `dismiss` returns immediately and the alert is still
            // on screen through its animation; presenting the editor into that
            // window silently does nothing, which looked exactly like a failed
            // fetch — the document was created correctly and the app just sat
            // there. Same class of bug as the runloop hop below.
            await withCheckedContinuation { done in
                waiting.dismiss(animated: true) { done.resume() }
            }

            guard let bytes,
                  let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
            else {
                handler(nil, .none)
                self.report(failure ?? "Could not reach the release server, and nothing is cached yet.")
                return
            }

            var dest = docs.appendingPathComponent("Untitled.bento.html")
            var n = 2
            while FileManager.default.fileExists(atPath: dest.path) {
                dest = docs.appendingPathComponent("Untitled \(n).bento.html")
                n += 1
            }
            do { try bytes.write(to: dest, options: .atomic) } catch {
                handler(nil, .none)
                self.report("Could not write the new document.")
                return
            }

            handler(dest, .none)
            // Next runloop: the browser is mid-transition when the handler
            // returns, and presenting into that animation is how a present()
            // silently fails.
            DispatchQueue.main.async { [weak self] in self?.openEditor(dest) }
        }
    }

    /// A refusal is worth saying out loud. A failed signature or hash check is
    /// the app protecting the reader, and silently doing nothing reads as a bug.
    private func report(_ message: String) {
        let alert = UIAlertController(title: "Could not create a document",
                                      message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        present(alert, animated: true)
    }

    /// Still implemented for documents imported from ELSEWHERE (dragged in,
    /// opened from another app) — that path does deliver the callback.
    func documentBrowser(_ c: UIDocumentBrowserViewController, didImportDocumentAt sourceURL: URL,
                         toDestinationURL destinationURL: URL) {
        openEditor(destinationURL)
    }

    func documentBrowser(_ c: UIDocumentBrowserViewController, didPickDocumentsAt urls: [URL]) {
        guard let url = urls.first else { return }
        openEditor(url)
    }

    /// Open a document handed to us by the SYSTEM — the share sheet, "Open in",
    /// AirDrop, or tapping a file in Files. `revealDocument` imports it into the
    /// browser's storage when it lives somewhere we cannot keep hold of, and
    /// surfaces it in the UI so the user can find it again afterwards.
    func openIncoming(_ url: URL) {
        revealDocument(at: url, importIfNeeded: true) { [weak self] revealed, error in
            guard let self else { return }
            // Falling back to the original URL matters: reveal fails for a file
            // already inside our own container, which is exactly where a
            // previously-imported document lives.
            self.openEditor(revealed ?? url)
            if let error { NSLog("reveal failed, opened in place: %@", String(describing: error)) }
        }
    }

    private func openEditor(_ url: URL) {
        // Security-scoped access: a document opened in place lives outside the
        // app container, so the URL must be scoped for the whole editing
        // session and released when the editor closes.
        let scoped = url.startAccessingSecurityScopedResource()
        let doc = BentoDocument(fileURL: url)
        doc.open { [weak self] ok in
            guard let self, ok else {
                if scoped { url.stopAccessingSecurityScopedResource() }
                return
            }
            let editor = EditorViewController(document: doc)
            // Two extensions: "Q3-board.bento.html" -> "Q3-board".
            editor.title = url.deletingPathExtension().deletingPathExtension().lastPathComponent
            let nav = DocumentNavigationController(rootViewController: editor)
            nav.modalPresentationStyle = .fullScreen
            editor.onDone = { [weak self, weak nav] in
                // close() flushes and relinquishes file coordination; without it
                // the document stayed open for the life of the app. The scope is
                // released only after the close completes — dropping it earlier
                // can fail the final write for a file outside our container.
                doc.close { _ in
                    if scoped { url.stopAccessingSecurityScopedResource() }
                }
                nav?.dismiss(animated: true)
                _ = self
            }
            self.present(nav, animated: true)
        }
    }
}

/// Lets the editor decide whether the status bar is shown.
///
/// A UINavigationController answers UIKit's status-bar questions itself unless
/// it is told to defer, so `prefersStatusBarHidden` on the view controller
/// inside it is simply never consulted — the editor's request to hide the bar
/// on iPad would be silently dropped.
final class DocumentNavigationController: UINavigationController {
    override var childForStatusBarHidden: UIViewController? { topViewController }
    override var childForStatusBarStyle: UIViewController? { topViewController }
}
