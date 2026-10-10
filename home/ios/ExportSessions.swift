// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

import Foundation

/// Where each write a page sends to an EXPORT handle goes — "Save a copy…",
/// a template, a read-only copy. The open document's own writes never come
/// through here; they go to the UIDocument in place.
///
/// The rules are home/android's (#595), so the two hosts answer the same way:
///
/// - **A copy is remembered for the session, by the name its handle was vended
///   under.** Once the user has chosen where it goes, later writes and reads on
///   that name go straight there. That is what the handle means on a desktop
///   browser: after Save-As, the copy is the document being edited. It is
///   recorded the moment the picker returns, so an autosave arriving in between
///   goes to the copy rather than to a second picker.
/// - **One picker per name.** Writes that arrive while it is open join it; the
///   newest bytes win, and every write gets the one result. A *different* name
///   while a picker is open is refused out loud, not queued behind a dialog that
///   is visibly for another file.
/// - **A cancel is a cancel.** Every write waiting on the picker is told it
///   failed. The copy is not remembered, so the next write asks again.
///
/// Foundation-only, so the whole state machine can be checked standalone with
/// `swiftc`. EditorViewController presents the picker and does the writing; it
/// decides none of this itself.
struct ExportSessions {
    enum Step: Equatable {
        /// No picker yet and nowhere remembered: write the temp copy and ask.
        case present(name: String)
        /// A picker for this very name is open; this write rides on it.
        case joined
        /// The user already chose where this copy goes; write it there.
        case writeTo(URL)
        /// Say no, with this reason.
        case refuse(String)
    }

    private(set) var remembered: [String: URL] = [:]
    private var pending: (name: String, ids: [Int], text: String, presented: String)?

    var isAsking: Bool { pending != nil }

    mutating func write(name: String, text: String, id: Int) -> Step {
        if let dest = remembered[name] { return .writeTo(dest) }
        if var p = pending {
            guard p.name == name else { return .refuse("another save is waiting for a location") }
            p.ids.append(id)
            p.text = text            // newest bytes win
            pending = p
            return .joined
        }
        pending = (name, [id], text, text)
        return .present(name: name)
    }

    /// The user chose `dest`. Returns every write waiting on the picker, and the
    /// bytes still owed to `dest` if a later write replaced what the picker
    /// copied. The picker copies the temp file as it was when it opened, so a
    /// write that joined afterwards has to be written over the copy.
    mutating func picked(_ dest: URL) -> (ids: [Int], owed: String?) {
        guard let p = pending else { return ([], nil) }
        pending = nil
        remembered[p.name] = dest
        return (p.ids, p.text == p.presented ? nil : p.text)
    }

    /// The user cancelled, or the picker never appeared. Returns every write
    /// waiting on it, all of which failed.
    mutating func cancelled() -> [Int] {
        guard let p = pending else { return [] }
        pending = nil
        return p.ids
    }

    func destination(for name: String) -> URL? { remembered[name] }
}
