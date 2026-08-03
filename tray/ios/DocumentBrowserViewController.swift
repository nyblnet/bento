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
    }

    /// A new document is seeded from the bundled starter shell.
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
    /// The bundled seed is the only Bento version this app ships and it ages
    /// harmlessly: a new document self-updates through the normal signed
    /// channel the first time it checks.
    func documentBrowser(_ c: UIDocumentBrowserViewController,
                         didRequestDocumentCreationWithHandler handler:
                         @escaping (URL?, UIDocumentBrowserViewController.ImportMode) -> Void) {
        guard let seed = Bundle.main.url(forResource: "starter", withExtension: "bento.html"),
              let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
        else { handler(nil, .none); return }

        var dest = docs.appendingPathComponent("Untitled.bento.html")
        var n = 2
        while FileManager.default.fileExists(atPath: dest.path) {
            dest = docs.appendingPathComponent("Untitled \(n).bento.html")
            n += 1
        }
        do { try FileManager.default.copyItem(at: seed, to: dest) } catch { handler(nil, .none); return }

        handler(dest, .none)
        // Next runloop: the browser is mid-transition when the handler returns,
        // and presenting into that animation is how a present() silently fails.
        DispatchQueue.main.async { [weak self] in self?.openEditor(dest) }
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
