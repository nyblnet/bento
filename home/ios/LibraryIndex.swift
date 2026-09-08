// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

import CoreSpotlight
import Foundation
import UniformTypeIdentifiers

/// One document, as the index knows it.
struct IndexedDocument: Codable {
    var bookmark: Data?
    var path: String
    var name: String
    var base: String
    var folder: String
    var title: String
    var app: String?
    var encrypted: Bool
    var text: String?
    var size: Int
    var modified: Date
}

/// Where a query matched, so a result can show the reader why it is a result.
struct SearchHit {
    var document: IndexedDocument
    /// A window of the document's own prose around the match, or nil when the
    /// match was on the title or the file name.
    var snippet: String?
}

/// The library: what is in the granted folders, and what those documents say.
///
/// The walk, the budgets and the caching all mirror `home/webext`'s
/// `listDocuments`/`describe`, because the point of this feature is that a deck
/// is findable by a phrase on a slide on every host. `BentoIndex` is the shared
/// half — the part that reads bytes and decides what the words are — and it is
/// diffed against the extension's own copy by `scripts/test-tray-index.mjs`.
/// This file is the iOS half: where the files come from, when the work happens,
/// and where the answers go.
///
/// **The prose goes into CoreSpotlight**, which is what "the app contributes
/// nothing to search" was about. That is a deliberate reach beyond the app: the
/// reader's own device index gains the text of documents in folders they
/// granted. Two rules keep it honest — an encrypted document is never read for
/// text at all (`BentoIndex.describe` refuses), and revoking a folder deletes
/// everything indexed from it. Both are enforced here rather than described.
final class LibraryIndex {
    static let shared = LibraryIndex()

    /// The reference's budgets, so the two hosts list the same things.
    /// `maxDepth` is inclusive of the root, matching `depth > MAX_DEPTH`.
    private let maxDepth = 4
    private let maxDocs = 300
    private let maxSniffs = 400

    private let domain = "page.bento.home.documents"
    private let queue = DispatchQueue(label: "page.bento.home.index", qos: .utility)

    private(set) var documents: [IndexedDocument] = []
    private var cache: [String: IndexedDocument] = [:]
    private var indexing = false

    /// Fires on the main queue whenever `documents` changes.
    var onChange: (() -> Void)?

    private init() { load() }

    // MARK: - Query

    /// Title, file name, folder, and the document's own words.
    ///
    /// Deliberately the same four fields the extension searches. Ranking is by
    /// where the match landed rather than by score: a title match is what the
    /// reader meant if it exists, and prose matches are the long tail that make
    /// the feature worth having.
    func search(_ raw: String) -> [SearchHit] {
        let q = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return documents.map { SearchHit(document: $0, snippet: nil) } }

        var titled: [SearchHit] = []
        var named: [SearchHit] = []
        var prose: [SearchHit] = []
        for doc in documents {
            if doc.title.lowercased().contains(q) {
                titled.append(SearchHit(document: doc, snippet: nil))
            } else if doc.name.lowercased().contains(q) || doc.folder.lowercased().contains(q) {
                named.append(SearchHit(document: doc, snippet: nil))
            } else if let text = doc.text, let range = text.range(of: q, options: .caseInsensitive) {
                prose.append(SearchHit(document: doc, snippet: snippet(text, around: range)))
            }
        }
        return titled + named + prose
    }

    private func snippet(_ text: String, around range: Range<String.Index>) -> String {
        let pad = 60
        let start = text.index(range.lowerBound, offsetBy: -pad, limitedBy: text.startIndex) ?? text.startIndex
        let end = text.index(range.upperBound, offsetBy: pad, limitedBy: text.endIndex) ?? text.endIndex
        var out = String(text[start..<end])
        if start > text.startIndex { out = "…" + out }
        if end < text.endIndex { out += "…" }
        return out
    }

    // MARK: - Indexing

    /// Walk the granted folders and republish.
    ///
    /// `cache` and `documents` belong to the MAIN queue and the walk runs on a
    /// utility one, so the walk gets a SNAPSHOT of the cache and hands back a
    /// whole result to be installed. Reading the live dictionary from the
    /// background would race `forget(folder:)` — a revoke landing mid-walk is
    /// exactly when that happens, and a dictionary mutated during a read is a
    /// crash rather than a wrong answer.
    func reindex() {
        guard !indexing else { return }
        indexing = true
        let snapshot = cache
        queue.async { [weak self] in
            guard let self else { return }
            let (found, fresh) = FolderGrants.shared.withAccess { folders in
                self.walk(folders, cache: snapshot)
            }
            DispatchQueue.main.async {
                self.cache = fresh
                self.documents = found.sorted { $0.modified > $1.modified }
                self.save()
                self.donate(found)
                self.indexing = false
                self.onChange?()
            }
        }
    }

    private func walk(_ folders: [URL], cache: [String: IndexedDocument]) -> ([IndexedDocument], [String: IndexedDocument]) {
        var cache = cache
        var out: [IndexedDocument] = []
        // Reading is only free the first time. A granted home directory can hold
        // thousands of unrelated .html files, so the sniff budget is per pass
        // and documents named like ours never spend from it.
        var sniffs = maxSniffs
        let fm = FileManager.default

        for root in folders {
            guard out.count < maxDocs else { break }
            let keys: [URLResourceKey] = [.isDirectoryKey, .fileSizeKey, .contentModificationDateKey, .isRegularFileKey]
            guard let walker = fm.enumerator(at: root, includingPropertiesForKeys: keys,
                                             options: [.skipsHiddenFiles, .skipsPackageDescendants]) else { continue }
            let rootName = root.lastPathComponent
            while let url = walker.nextObject() as? URL {
                if out.count >= maxDocs { break }
                // `level` counts the root's own contents as 1, so this is the
                // reference's `depth > MAX_DEPTH` on a 0-based root.
                if walker.level > maxDepth + 1 { walker.skipDescendants(); continue }
                let values = try? url.resourceValues(forKeys: Set(keys))
                guard values?.isRegularFile == true else { continue }

                let name = url.lastPathComponent
                let named = name.range(of: #"\.bento\.html$"#, options: [.regularExpression, .caseInsensitive]) != nil
                let maybe = !named && name.range(of: #"\.html?$"#, options: [.regularExpression, .caseInsensitive]) != nil
                guard named || maybe else { continue }

                let size = values?.fileSize ?? 0
                let modified = values?.contentModificationDate ?? .distantPast
                let cacheKey = "\(url.path):\(size):\(modified.timeIntervalSince1970)"
                if let hit = cache[cacheKey] { out.append(hit); continue }

                if maybe {
                    guard sniffs > 0 else { continue }
                    sniffs -= 1
                    guard let head = read(url, limit: BentoIndex.sniffBytes),
                          BentoIndex.isDocument(head: head) else { continue }
                }

                guard let doc = describe(url, name: name, folder: rootName, size: size, modified: modified) else { continue }
                cache[cacheKey] = doc
                out.append(doc)
            }
        }
        return (out, cache)
    }

    private func describe(_ url: URL, name: String, folder: String, size: Int, modified: Date) -> IndexedDocument? {
        guard let data = try? Data(contentsOf: url, options: .mappedIfSafe) else { return nil }
        let head = String(decoding: data.prefix(BentoIndex.headBytes), as: UTF8.self)
        let sniffHead = String(decoding: data.prefix(BentoIndex.sniffBytes), as: UTF8.self)
        // The whole file is only decoded when the head says it is worth it. A
        // sniffed file has already proven it carries the marker; a named one has
        // not, and a 40MB video someone called `.html` should not be decoded to
        // find that out.
        guard BentoIndex.isDocument(head: sniffHead) else { return nil }
        let whole = String(decoding: data, as: UTF8.self)
        let base = name
            .replacingOccurrences(of: #"\.bento\.html$"#, with: "", options: [.regularExpression, .caseInsensitive])
            .replacingOccurrences(of: #"\.html?$"#, with: "", options: [.regularExpression, .caseInsensitive])
        let meta = BentoIndex.describe(head: head, sniffHead: sniffHead, whole: whole)
        // Minted HERE, inside the folder's open scope, because that is the only
        // moment it can be: a document inside a granted folder is readable only
        // while the FOLDER is scoped, and an editing session outlives this walk
        // by minutes. The bookmark is what lets the editor hold the file on its
        // own afterwards.
        return IndexedDocument(bookmark: try? url.bookmarkData(),
                               path: url.path,
                               name: name,
                               base: base,
                               folder: folder,
                               // The file name is what a listing shows for a
                               // document that never got a title of its own.
                               // That is a listing decision, so it is made here
                               // rather than inside the extractor.
                               title: meta.title ?? base,
                               app: meta.app,
                               encrypted: meta.encrypted,
                               text: meta.text,
                               size: size,
                               modified: modified)
    }

    private func read(_ url: URL, limit: Int) -> String? {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }
        guard let data = try? handle.read(upToCount: limit) else { return nil }
        return String(decoding: data, as: UTF8.self)
    }

    // MARK: - CoreSpotlight

    private func donate(_ docs: [IndexedDocument]) {
        let items: [CSSearchableItem] = docs.map { doc in
            let attrs = CSSearchableItemAttributeSet(contentType: UTType.html)
            attrs.title = doc.title
            attrs.displayName = doc.title
            attrs.contentURL = URL(fileURLWithPath: doc.path)
            // The whole point: the document's own prose, searchable from the
            // system. Encrypted documents carry nil here because nothing was
            // ever extracted from them.
            attrs.textContent = doc.text
            attrs.contentDescription = doc.encrypted
                ? "Encrypted Bento document"
                : (doc.text.map { String($0.prefix(200)) } ?? doc.folder)
            attrs.keywords = [doc.app, "bento"].compactMap { $0 }
            return CSSearchableItem(uniqueIdentifier: doc.path,
                                    domainIdentifier: domain,
                                    attributeSet: attrs)
        }
        guard !items.isEmpty else { return }
        CSSearchableIndex.default().indexSearchableItems(items) { error in
            if let error { NSLog("spotlight index failed: %@", String(describing: error)) }
        }
    }

    /// Drop a folder's documents from both the local list and the system index.
    func forget(folder: URL) {
        let name = folder.lastPathComponent
        let prefix = folder.standardizedFileURL.path
        let gone = documents.filter { $0.path.hasPrefix(prefix) || $0.folder == name }
        documents.removeAll { $0.path.hasPrefix(prefix) || $0.folder == name }
        cache = cache.filter { !$0.key.hasPrefix(prefix) }
        save()
        guard !gone.isEmpty else { return }
        CSSearchableIndex.default().deleteSearchableItems(withIdentifiers: gone.map(\.path)) { error in
            if let error { NSLog("spotlight delete failed: %@", String(describing: error)) }
        }
        onChange?()
    }

    /// Resolve a Spotlight result back to a document this app can open.
    func document(withIdentifier id: String) -> IndexedDocument? {
        documents.first { $0.path == id }
    }

    /// A URL carrying its own security scope, for opening outside the walk.
    func openableURL(for doc: IndexedDocument) -> URL? {
        if let data = doc.bookmark {
            var stale = false
            if let url = try? URL(resolvingBookmarkData: data, bookmarkDataIsStale: &stale) { return url }
        }
        // The bookmark can fail to resolve after the folder moved; the walk will
        // re-mint it, and in the meantime the raw path is still worth trying.
        return URL(fileURLWithPath: doc.path)
    }

    // MARK: - Persistence

    private var storeURL: URL? {
        guard let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        else { return nil }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("library-index.json")
    }

    private func load() {
        guard let url = storeURL, let data = try? Data(contentsOf: url),
              let saved = try? JSONDecoder().decode([IndexedDocument].self, from: data) else { return }
        documents = saved
        for doc in saved {
            cache["\(doc.path):\(doc.size):\(doc.modified.timeIntervalSince1970)"] = doc
        }
    }

    private func save() {
        guard let url = storeURL, let data = try? JSONEncoder().encode(documents) else { return }
        // The extracted prose is the reader's own document text; it stays inside
        // the app container with the same protection the documents themselves get.
        try? data.write(to: url, options: [.atomic, .completeFileProtectionUnlessOpen])
    }
}
