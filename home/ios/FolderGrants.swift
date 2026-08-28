// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

import Foundation

/// Folders the reader has handed the app, kept across launches.
///
/// The document browser can open any single file the reader points at, but it
/// cannot ENUMERATE — and enumeration is what searching a library means. iOS
/// grants that through the document picker in folder mode, which returns a
/// security-scoped directory URL; a bookmark makes it survive a relaunch. It is
/// the same capability as `showDirectoryPicker` in `home/webext` and
/// `ACTION_OPEN_DOCUMENT_TREE` on Android, and it is the only new permission
/// this feature needs.
///
/// Nothing here reads a document. Access is granted here and spent in
/// `LibraryIndex`, so the rules about WHAT gets read — encrypted documents are
/// never opened for text — live in one place next to the extractor rather than
/// being restated wherever a file is touched.
final class FolderGrants {
    static let shared = FolderGrants()

    private let key = "bento.tray.folder-grants"
    private var bookmarks: [Data] = []

    private init() {
        bookmarks = (UserDefaults.standard.array(forKey: key) as? [Data]) ?? []
    }

    /// Folder URLs, freshly resolved. A grant whose bookmark no longer resolves
    /// — the folder was deleted, or the provider that served it is gone — is
    /// dropped rather than reported: there is nothing the reader can do about it
    /// and an error about a folder they may have removed on purpose is noise.
    var folders: [URL] {
        var kept: [Data] = []
        var urls: [URL] = []
        for data in bookmarks {
            var stale = false
            guard let url = try? URL(resolvingBookmarkData: data,
                                     bookmarkDataIsStale: &stale) else { continue }
            // A stale bookmark still resolves; re-minting it needs the scope
            // open, which the indexer does on its next pass.
            kept.append(data)
            urls.append(url)
        }
        if kept.count != bookmarks.count {
            bookmarks = kept
            UserDefaults.standard.set(bookmarks, forKey: key)
        }
        return urls
    }

    var isEmpty: Bool { bookmarks.isEmpty }

    func add(_ url: URL) {
        // The picker hands back a scoped URL; the bookmark has to be minted
        // while that scope is open or it resolves to something unreadable.
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? url.bookmarkData() else { return }
        guard !folders.contains(where: { $0.standardizedFileURL == url.standardizedFileURL }) else { return }
        bookmarks.append(data)
        UserDefaults.standard.set(bookmarks, forKey: key)
    }

    /// Revoking a folder also drops what was indexed from it — see
    /// `LibraryIndex.forget(folder:)`. Leaving prose in the system index for a
    /// folder the reader has just withdrawn would be the opposite of what they
    /// asked for.
    func remove(_ url: URL) {
        var kept: [Data] = []
        for data in bookmarks {
            var stale = false
            if let resolved = try? URL(resolvingBookmarkData: data, bookmarkDataIsStale: &stale),
               resolved.standardizedFileURL == url.standardizedFileURL { continue }
            kept.append(data)
        }
        bookmarks = kept
        UserDefaults.standard.set(bookmarks, forKey: key)
    }

    /// Run `body` with every granted folder's security scope open, and close
    /// them all again afterwards however it exits.
    func withAccess<T>(_ body: ([URL]) throws -> T) rethrows -> T {
        let urls = folders
        var opened: [URL] = []
        for url in urls where url.startAccessingSecurityScopedResource() { opened.append(url) }
        defer { for url in opened { url.stopAccessingSecurityScopedResource() } }
        return try body(urls)
    }

}
