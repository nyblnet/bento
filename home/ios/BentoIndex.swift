// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

import Foundation

/// What a Bento document says about itself, read without parsing it.
///
/// This is a port of `home/webext/src/library.js` — `sniff`, the metadata half
/// of `describe`, and `extractText`. The three hosts (extension, iOS, Android)
/// each carry their own copy, pinned to each other by a shared fixture corpus
/// rather than by shared code; the reasoning is in `docs/DECISIONS.md`
/// (2026-08-16, "Document search: the list stays native, the indexer is shared
/// by FIXTURE"). Read that before changing anything here — a change that is not
/// also made in the other two is a silent divergence, and the fixture is what
/// turns it into a loud one.
///
/// **Everything here works in UTF-16 code units, deliberately.** The reference
/// is JavaScript, where `indexOf`, `slice`, `String.length` and every regex
/// offset are UTF-16. Swift's `String` is grapheme-clustered, so the natural
/// Swift spelling of this code would silently disagree with the reference the
/// moment a document contains an emoji or a CJK character — which is to say, on
/// real documents rather than only on pathological ones. Counting the same
/// units the reference counts is the cheapest way to be able to prove agreement.
///
/// **No UIKit.** Kept Foundation-only so it compiles standalone with `swiftc`,
/// which is what `scripts/test-tray-index.mjs` does to diff this against the
/// live JavaScript. An indexer that can only be exercised inside a simulator is
/// an indexer whose agreement with the reference is an assertion rather than a
/// measurement.
enum BentoIndex {

    // MARK: - Budgets
    //
    // These four numbers are the reference's, and they are the ones the fixture
    // pins. Changing one here without changing it in `library.js` and in the
    // Android port makes the same document searchable by different words on
    // different platforms.

    /// The splice-contract marker every Bento app honours (`docs/PLATFORM.md`
    /// §2), frozen because old updaters depend on it. It is what makes a file a
    /// Bento document — the `.bento.html` name is a convention, and conventions
    /// get broken by people renaming things to email them.
    static let marker = "id=\"bento-doc\""

    /// How much of a file to read before deciding whether it is one of ours.
    /// Measured on a real shell the marker sits 5.8KB in, so this is generous —
    /// and deliberately much smaller than `headBytes`, because this runs against
    /// every stray `.html` in a granted folder and most of them are not ours.
    static let sniffBytes = 64 * 1024

    /// Enough to reach the title inside the document block. NOT enough to reach
    /// the end of that block, which runs to megabytes when a document carries
    /// images — an earlier metadata reader looked for the closing tag and so
    /// found nothing in any document with a picture in it.
    static let headBytes = 300 * 1024

    /// How much extracted prose to keep. Enough for any phrase somebody would
    /// search for; far short of storing the document twice.
    static let textBudget = 40 * 1024

    // MARK: - Result

    struct Meta {
        /// Is this one of ours at all? Everything below is nil or false when it
        /// is not — the shared corpus pins that, and it is why `title` is
        /// optional rather than falling back to the file name here. A file name
        /// is what the LISTING shows when a document has no title of its own;
        /// inventing one during extraction would report a title for a file that
        /// is not even a Bento document.
        var isDocument: Bool
        /// The document's own title, if it has one.
        var title: String?
        /// Which Bento this is — `slides`, `spaces`, `dash`. A pristine shell
        /// has no document in it yet and so no format: that is not a failure,
        /// it is a document nobody has saved.
        var app: String?
        var encrypted: Bool
        /// What the document SAYS, so search can find a deck by a phrase on a
        /// slide rather than only by what somebody happened to call the file.
        var text: String?
        /// The still first-page render the thumbnailers use, as raw HTML.
        var preview: String?

        static let notADocument = Meta(isDocument: false, title: nil, app: nil,
                                       encrypted: false, text: nil, preview: nil)
    }

    // MARK: - Sniff

    /// Is this actually a Bento document, whatever it is called?
    static func isDocument(head: String) -> Bool {
        Array(head.utf16).firstIndex(ofSequence: Array(marker.utf16)) != nil
    }

    // MARK: - Describe

    /// Everything a listing needs, from bytes already in hand.
    ///
    /// The three windows are the caller's to cut, because they are byte slices
    /// of the file and this function only sees decoded text: `sniffHead` is the
    /// first `sniffBytes`, `head` the first `headBytes`, `whole` all of it (or
    /// nil when the caller has decided not to pay for the full read). The split
    /// mirrors the reference — the title is cheap and near the front, the
    /// preview sits a quarter of the way into a 900KB file and cannot be had
    /// from the head at all.
    ///
    /// An ENCRYPTED document deliberately yields no text and no preview. That is
    /// a privacy rule, not an optimisation: a plaintext title page beside the
    /// ciphertext is the leak the password exists to prevent, and prose lifted
    /// into a system-wide search index is that same leak with a longer reach.
    ///
    /// The shape — `isDocument` folded in, everything else nil when it is false
    /// — is the SHARED contract in `home/fixtures/README.md`, not this host's
    /// choice. `home/webext`'s `describe()` never faces a non-document because
    /// its caller sniffs first; a port that answers all the questions in one
    /// call does, and has to say so.
    static func describe(head: String, sniffHead: String, whole: String?) -> Meta {
        guard isDocument(head: sniffHead) else { return .notADocument }
        let headU = Array(head.utf16)
        let encrypted = isEncrypted(headU)
        var meta = Meta(isDocument: true,
                        title: title(headU).flatMap { $0.isEmpty ? nil : $0 },
                        app: app(headU),
                        encrypted: encrypted,
                        text: nil,
                        preview: nil)
        guard !encrypted, let whole else { return meta }
        let wholeU = Array(whole.utf16)
        meta.preview = previewSlice(wholeU)
        meta.text = extractText(wholeU)
        return meta
    }

    // MARK: - The words a document actually contains

    /// Search used to cover the title, the file name and the folder — which
    /// finds a deck you can already name. What you usually remember is a phrase
    /// ON a slide, and the bytes to answer that were already read for the
    /// thumbnail and then thrown away.
    ///
    /// Deliberately NOT a JSON parse. The document block runs to megabytes with
    /// images inline, every app shapes it differently (slides put prose in
    /// `element.html`, spaces in blocks, dash in cells), and a parser that has
    /// to know the format is a parser that breaks when the format moves. Pulling
    /// string VALUES out — `:"…"`, never keys — is format-agnostic and degrades
    /// to "finds less" rather than "throws".
    ///
    /// Data URIs go first: one embedded image is bigger than every word in the
    /// document, and they would dominate both the work and the budget.
    static func extractText(_ html: [UInt16]) -> String? {
        guard let start = html.firstIndex(ofSequence: Array(marker.utf16)) else { return nil }
        guard let end = html.firstIndex(ofSequence: Array("</script>".utf16), from: start) else { return nil }

        let block = stripDataURIs(Array(html[start..<end]))

        var out: [UInt16] = []
        var size = 0
        var i = 0
        let n = block.count
        while i + 1 < n {
            guard block[i] == .colon, block[i + 1] == .quote else { i += 1; continue }
            guard let close = matchJSONValue(block, from: i + 2, maxReps: 400, minReps: 1) else {
                i += 1
                continue
            }
            let value = block[(i + 2)..<close]
            if hasRunOfLetters(value, 3) {
                if !out.isEmpty { out.append(.space) }   // the reference's join(' ')
                out.append(contentsOf: value)
                size += value.count
                // The value is kept BEFORE the budget is checked, exactly as the
                // reference does — so the budget overshoots by up to one value
                // and then the final slice trims it back. Reproduced rather than
                // tidied: tidying it would change what the last few words are.
                if size > textBudget { break }
            }
            i = close + 1
        }

        let cleaned = collapseWhitespace(stripEntities(stripTags(out)))
        let trimmed = trimWhitespace(cleaned)
        if trimmed.isEmpty { return nil }
        return String(decoding: clampToBudget(trimmed), as: UTF16.self)
    }

    // MARK: - Head fields

    static func title(_ head: [UInt16]) -> String? {
        guard let raw = quotedValue(after: "\"title\"", in: head, maxReps: 200) else { return nil }
        return String(decoding: unescape(raw), as: UTF16.self)
    }

    static func app(_ head: [UInt16]) -> String? {
        // Every `"format"` is tried, not just the first. A regex looks for the
        // first position where the WHOLE pattern matches, so a `"format"` whose
        // value is not `bento/…` makes the reference keep scanning rather than
        // give up — stopping at the first key would disagree with it on any
        // document that carries an unrelated `format` field ahead of its own.
        firstQuotedValue(after: "\"format\"", in: head, maxReps: 400) { raw in
            let prefix = Array("bento/".utf16)
            guard raw.count > prefix.count, Array(raw[0..<prefix.count]) == prefix else { return nil }
            let rest = Array(raw[prefix.count...])
            // `[a-z]+` — lowercase only, and the whole remainder must be letters.
            guard !rest.isEmpty, rest.allSatisfy({ $0 >= .lowerA && $0 <= .lowerZ }) else { return nil }
            return String(decoding: rest, as: UTF16.self)
        }
    }

    static func isEncrypted(_ head: [UInt16]) -> Bool {
        let enc = Array("bento/enc".utf16)
        let found: Bool? = firstQuotedValue(after: "\"format\"", in: head, maxReps: 400) { raw in
            raw == enc ? true : nil
        }
        if found == true { return true }
        return head.firstIndex(ofSequence: Array("data-bento-enc".utf16)) != nil
    }

    /// The preview sits AFTER the document block and is bounded by the script
    /// that removes it, which is the same pair the thumbnailers rely on.
    static func previewSlice(_ whole: [UInt16]) -> String? {
        guard let start = whole.firstIndex(ofSequence: Array("<div data-bento-preview".utf16)) else { return nil }
        guard let end = whole.firstIndex(ofSequence: Array("<script data-bento-preview".utf16), from: start),
              end > start else { return nil }
        return String(decoding: whole[start..<end], as: UTF16.self)
    }

    // MARK: - Scanners
    //
    // Hand-written rather than NSRegularExpression, for two reasons that both
    // showed up as real divergences from the reference:
    //
    //   * ICU's `\d` is Unicode Nd, so `&#\d+;` would swallow Arabic-Indic
    //     digits that the reference leaves alone; ICU's `\s` is `\p{Z}`-based and
    //     excludes U+FEFF, which JavaScript's `\s` includes.
    //   * The value pattern `(?:[^"\\]|\\.){1,400}` is a backtracking shape over
    //     a block that can be megabytes long.
    //
    // A single forward pass is both exactly specifiable and cheaper. Where the
    // reference relies on regex backtracking, the note above each scanner says
    // why the straight-line version is equivalent.

    /// `(?:[^"\\]|\\.){minReps,maxReps}"` starting at `p`, returning the index
    /// of the closing quote.
    ///
    /// Backtracking cannot change the answer here, which is why one pass is
    /// enough. `[^"\\]` cannot match a quote, so the greedy run only ever
    /// advances past positions that are NOT a quote; a quote can therefore only
    /// sit at the position where the run stops, never at an interior repetition
    /// boundary the engine could give back to. So if the run hits `maxReps`
    /// without a quote following it, every shorter alternative fails too, and
    /// the whole match fails — the reference then advances its start position by
    /// one, which is what the callers do.
    private static func matchJSONValue(_ s: [UInt16], from p: Int, maxReps: Int, minReps: Int) -> Int? {
        var j = p
        var reps = 0
        let n = s.count
        while reps < maxReps && j < n {
            let c = s[j]
            if c == .quote { break }
            if c == .backslash {
                // `\\.` — and `.` does not match a line terminator in either
                // language, so a backslash before one ends the run instead.
                guard j + 1 < n, !isLineTerminator(s[j + 1]) else { break }
                j += 2; reps += 1; continue
            }
            j += 1; reps += 1
        }
        guard reps >= minReps, j < n, s[j] == .quote else { return nil }
        return j
    }

    /// `"key"\s*:\s*"(value)"`, scanning every occurrence of the key.
    private static func quotedValue(after key: String, in s: [UInt16], maxReps: Int) -> [UInt16]? {
        firstQuotedValue(after: key, in: s, maxReps: maxReps) { $0 }
    }

    /// The same scan, but the caller decides whether a given value counts —
    /// which is what lets `app` and `isEncrypted` keep looking past a `"format"`
    /// that does not have the shape they want, exactly as a regex would.
    private static func firstQuotedValue<T>(after key: String, in s: [UInt16], maxReps: Int,
                                            accept: ([UInt16]) -> T?) -> T? {
        let k = Array(key.utf16)
        var from = 0
        while let at = s.firstIndex(ofSequence: k, from: from) {
            var j = skipWhitespace(s, at + k.count)
            if j < s.count, s[j] == .colon {
                j = skipWhitespace(s, j + 1)
                if j < s.count, s[j] == .quote,
                   let close = matchJSONValue(s, from: j + 1, maxReps: maxReps, minReps: 0),
                   let got = accept(Array(s[(j + 1)..<close])) {
                    return got
                }
            }
            from = at + 1
        }
        return nil
    }

    /// `/data:[^"\\]{200,}/g` → a single space.
    ///
    /// Greedy with nothing following it, so it simply takes the maximal run and
    /// never backtracks. A run shorter than 200 is not a match, and the
    /// reference then resumes one character later — which can find a `data:`
    /// INSIDE the run it just rejected, so that is what happens here too.
    private static func stripDataURIs(_ s: [UInt16]) -> [UInt16] {
        let needle = Array("data:".utf16)
        var out: [UInt16] = []
        out.reserveCapacity(s.count)
        var i = 0
        var copied = 0
        while let at = s.firstIndex(ofSequence: needle, from: i) {
            var j = at + needle.count
            while j < s.count, s[j] != .quote, s[j] != .backslash { j += 1 }
            if j - (at + needle.count) >= 200 {
                out.append(contentsOf: s[copied..<at])
                out.append(.space)
                i = j
                copied = j
            } else {
                i = at + 1
            }
        }
        out.append(contentsOf: s[copied...])
        return out
    }

    /// `/<[^>]{1,200}>/g` → a single space. Same no-backtracking argument as the
    /// value scanner: `[^>]` cannot match `>`.
    private static func stripTags(_ s: [UInt16]) -> [UInt16] {
        var out: [UInt16] = []
        out.reserveCapacity(s.count)
        var i = 0
        while i < s.count {
            guard s[i] == .lt else { out.append(s[i]); i += 1; continue }
            var j = i + 1
            var reps = 0
            while reps < 200, j < s.count, s[j] != .gt { j += 1; reps += 1 }
            if reps >= 1, j < s.count, s[j] == .gt {
                out.append(.space)
                i = j + 1
            } else {
                out.append(s[i]); i += 1
            }
        }
        return out
    }

    /// `/&[a-z]+;|&#\d+;/gi` → a single space. `\d` is ASCII in JavaScript, so
    /// it is ASCII here — ICU's Unicode-Nd reading would eat digits the
    /// reference keeps.
    private static func stripEntities(_ s: [UInt16]) -> [UInt16] {
        var out: [UInt16] = []
        out.reserveCapacity(s.count)
        var i = 0
        while i < s.count {
            guard s[i] == .amp else { out.append(s[i]); i += 1; continue }
            var j = i + 1
            var reps = 0
            while j < s.count, isAsciiLetter(s[j]) { j += 1; reps += 1 }
            if reps >= 1, j < s.count, s[j] == .semi {
                out.append(.space); i = j + 1; continue
            }
            // The alternation is ordered, so the numeric form is only tried
            // once the named form has failed.
            if i + 1 < s.count, s[i + 1] == .hash {
                j = i + 2; reps = 0
                while j < s.count, isAsciiDigit(s[j]) { j += 1; reps += 1 }
                if reps >= 1, j < s.count, s[j] == .semi {
                    out.append(.space); i = j + 1; continue
                }
            }
            out.append(s[i]); i += 1
        }
        return out
    }

    private static func collapseWhitespace(_ s: [UInt16]) -> [UInt16] {
        var out: [UInt16] = []
        out.reserveCapacity(s.count)
        var i = 0
        while i < s.count {
            if isJSWhitespace(s[i]) {
                out.append(.space)
                while i < s.count, isJSWhitespace(s[i]) { i += 1 }
            } else {
                out.append(s[i]); i += 1
            }
        }
        return out
    }

    private static func trimWhitespace(_ s: [UInt16]) -> [UInt16] {
        var a = 0, b = s.count
        while a < b, isJSWhitespace(s[a]) { a += 1 }
        while b > a, isJSWhitespace(s[b - 1]) { b -= 1 }
        return Array(s[a..<b])
    }

    /// `.slice(0, textBudget)` on UTF-16 units.
    ///
    /// ONE deliberate deviation from the reference, and the only one in this
    /// file. JavaScript will happily cut between a surrogate pair and hand back
    /// a lone surrogate; Swift cannot hold one, and decoding it yields U+FFFD.
    /// A trailing high surrogate is dropped instead. It costs the last half of
    /// one astral character in a document that happens to be exactly 40KB of
    /// prose long, and it avoids putting a replacement character into a search
    /// index. Written down because the fixture will show it as a one-unit
    /// length difference on such a document and it should read as a decision,
    /// not a bug.
    private static func clampToBudget(_ s: [UInt16]) -> [UInt16] {
        guard s.count > textBudget else { return s }
        var out = Array(s[0..<textBudget])
        if let last = out.last, last >= 0xD800, last <= 0xDBFF { out.removeLast() }
        return out
    }

    private static func unescape(_ s: [UInt16]) -> [UInt16] {
        var out: [UInt16] = []
        out.reserveCapacity(s.count)
        var i = 0
        while i < s.count {
            if s[i] == .backslash, i + 1 < s.count { out.append(s[i + 1]); i += 2 }
            else { out.append(s[i]); i += 1 }
        }
        return out
    }

    private static func skipWhitespace(_ s: [UInt16], _ from: Int) -> Int {
        var i = from
        while i < s.count, isJSWhitespace(s[i]) { i += 1 }
        return i
    }

    private static func hasRunOfLetters(_ s: ArraySlice<UInt16>, _ count: Int) -> Bool {
        var run = 0
        for c in s {
            if isAsciiLetter(c) {
                run += 1
                if run >= count { return true }
            } else {
                run = 0
            }
        }
        return false
    }

    // MARK: - Character classes

    private static func isAsciiLetter(_ c: UInt16) -> Bool {
        (c >= .upperA && c <= .upperZ) || (c >= .lowerA && c <= .lowerZ)
    }

    private static func isAsciiDigit(_ c: UInt16) -> Bool { c >= .zero && c <= .nine }

    private static func isLineTerminator(_ c: UInt16) -> Bool {
        c == 0x0A || c == 0x0D || c == 0x2028 || c == 0x2029
    }

    /// JavaScript's `\s`, written out. Notably it includes U+FEFF and U+00A0,
    /// which a `\p{Z}`-based class does not, and excludes U+200B, which people
    /// assume it contains. `markdown.ts` puts real NBSPs into documents, so this
    /// set is load-bearing rather than theoretical.
    private static func isJSWhitespace(_ c: UInt16) -> Bool {
        switch c {
        case 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680,
             0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
            return true
        case 0x2000...0x200A:
            return true
        default:
            return false
        }
    }
}

// MARK: - UTF-16 helpers

private extension UInt16 {
    static let colon: UInt16 = 0x3A
    static let quote: UInt16 = 0x22
    static let backslash: UInt16 = 0x5C
    static let space: UInt16 = 0x20
    static let lt: UInt16 = 0x3C
    static let gt: UInt16 = 0x3E
    static let amp: UInt16 = 0x26
    static let semi: UInt16 = 0x3B
    static let hash: UInt16 = 0x23
    static let zero: UInt16 = 0x30
    static let nine: UInt16 = 0x39
    static let upperA: UInt16 = 0x41
    static let upperZ: UInt16 = 0x5A
    static let lowerA: UInt16 = 0x61
    static let lowerZ: UInt16 = 0x7A
}

extension Array where Element == UInt16 {
    /// `String.prototype.indexOf`, in the units the reference counts.
    func firstIndex(ofSequence needle: [UInt16], from: Int = 0) -> Int? {
        guard !needle.isEmpty, count >= needle.count else { return nil }
        let last = count - needle.count
        guard from <= last else { return nil }
        var i = Swift.max(0, from)
        while i <= last {
            var k = 0
            while k < needle.count, self[i + k] == needle[k] { k += 1 }
            if k == needle.count { return i }
            i += 1
        }
        return nil
    }
}
