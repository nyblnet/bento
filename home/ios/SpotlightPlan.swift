// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

import Foundation

/// What the system search index (CoreSpotlight) may hold for a document, and
/// what to do to it when the document changes. LibraryIndex carries these plans
/// out; this file only decides, so scripts/test-home-spotlight.mjs can check every
/// rule without the real index.
///
/// - A SEALED document (its saved body is a bento/enc envelope) contributes
///   nothing from its content: its entry carries the saved file's own title
///   (the neutral one it writes while sealed) or the file name, no text, a fixed
///   description, and no keywords drawn from what it contains.
/// - When a save is sealed, the document's entry is DELETED before the file is
///   written, and replaced once it has been, so nothing from before survives
///   even an interrupted save.
/// - A full walk removes the entry of every document it no longer finds
///   (deleted, or moved out of a granted folder).
enum SpotlightPlan {
    struct Entry: Equatable {
        let id: String
        let title: String
        let text: String?
        let description: String?
        let keywords: [String]
    }

    enum Op: Equatable { case delete([String]), add([Entry]) }

    static let sealedDescription = "Encrypted Bento document"

    /// The entry for one document. `title` is the saved file's own <title> (nil
    /// when it has none); `base` is its file name without the extension.
    static func entry(path: String, title: String?, base: String, app: String?, sealed: Bool,
                      text: String?, folder: String) -> Entry {
        let shown = (title?.isEmpty == false ? title : nil) ?? base
        if sealed {
            return Entry(id: path, title: shown, text: nil, description: sealedDescription, keywords: ["bento"])
        }
        return Entry(id: path, title: shown, text: text,
                     description: text.map { String($0.prefix(200)) } ?? folder,
                     keywords: [app, "bento"].compactMap { $0 })
    }

    /// What happens BEFORE a save is written: when the outgoing file is sealed,
    /// its entry is deleted first, so if the write lands and the app dies before
    /// the re-index, the index holds nothing from before.
    static func beforeSave(id: String, sealed: Bool) -> [Op] {
        sealed ? [.delete([id])] : []
    }

    /// What one save does to the index once written: replace the entry, deleting
    /// the old one first when the document is sealed.
    static func refresh(_ new: Entry, sealed: Bool) -> [Op] {
        sealed ? [.delete([new.id]), .add([new])] : [.add([new])]
    }

    /// The entries a full walk must remove: indexed before, not found now.
    static func removals(before: [String], after: [String]) -> [String] {
        let found = Set(after)
        return before.filter { !found.contains($0) }
    }
}
