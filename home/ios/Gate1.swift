// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

import CryptoKit
import Foundation

/// GATE 1: is this file's runtime a genuine Bento release? A Swift port of
/// kernel/src/gate1.ts (bento/connect K5), held to every row of the conformance
/// corpus in home/fixtures/gate1/ by scripts/test-home-gate1.mjs.
///
/// The port copies the reference's RULES, not this platform's parsers. It works
/// on UTF-16 code units, as a JavaScript string does, so every index, slice and
/// search lands where the reference's would. Its "regular expressions" are
/// written out by hand with JavaScript's `\s` set and ASCII-only case folding.
/// That's what the corpus's scanner-split rows are there to catch.
///
/// - `verifyServed` is this host's path, since it serves the bytes it verified:
///   one release in the signed history must match EVERY block, and the answer
///   comes with the hash-pinned CSP to serve the file under.
/// - `verifyStrict` is the file:// fallback, ported so the corpus holds it too.
///   It only ever gives a result, never grounds for identity (security §16).
/// - `acceptHistory` is anti-rollback for an incoming, signature-checked history.
///
/// "Unknown" is never "tampered": the file is shown without identity.
enum Gate1 {
    typealias S = [UInt16]

    // MARK: - JavaScript string semantics over UTF-16

    static func u(_ s: String) -> S { Array(s.utf16) }
    static func str(_ s: S) -> String { String(decoding: s, as: UTF16.self) }

    /// JavaScript's `\s`
    static func isSpace(_ c: UInt16) -> Bool {
        switch c {
        case 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
            return true
        default: return false
        }
    }
    /// `\w` without the u flag
    static func isWord(_ c: UInt16) -> Bool {
        (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || c == 0x5F
    }
    /// the i flag without u: only ASCII letters fold
    static func fold(_ c: UInt16) -> UInt16 { (c >= 0x41 && c <= 0x5A) ? c + 32 : c }
    static func isLetter(_ c: UInt16) -> Bool { (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) }
    static func isDigit(_ c: UInt16) -> Bool { c >= 0x30 && c <= 0x39 }

    /// does `h` hold `word` (lowercase ASCII) at `at`, case-insensitively?
    static func ci(_ h: S, _ at: Int, _ word: S) -> Bool {
        guard at >= 0, at + word.count <= h.count else { return false }
        for k in 0..<word.count where fold(h[at + k]) != word[k] { return false }
        return true
    }
    static func at(_ h: S, _ i: Int, _ n: S) -> Bool {
        guard i >= 0, i + n.count <= h.count else { return false }
        for k in 0..<n.count where h[i + k] != n[k] { return false }
        return true
    }
    /// String.prototype.indexOf
    static func indexOf(_ h: S, _ n: S, _ from: Int = 0) -> Int {
        var i = max(0, from)
        if n.isEmpty { return min(i, h.count) }
        while i + n.count <= h.count { if at(h, i, n) { return i }; i += 1 }
        return -1
    }
    /// String.prototype.lastIndexOf
    static func lastIndexOf(_ h: S, _ n: S, _ from: Int) -> Int {
        var i = min(max(from, 0), h.count - n.count)
        while i >= 0 { if at(h, i, n) { return i }; i -= 1 }
        return -1
    }
    /// String.prototype.slice, negative indexes included
    static func slice(_ h: S, _ a: Int, _ b: Int? = nil) -> S {
        let n = h.count
        let s = a < 0 ? max(n + a, 0) : min(a, n)
        let e0 = b ?? n
        let e = e0 < 0 ? max(n + e0, 0) : min(e0, n)
        return s < e ? Array(h[s..<e]) : []
    }
    static func includes(_ h: S, _ n: S) -> Bool { indexOf(h, n) >= 0 }
    /// `h.split(n).length - 1`
    static func count(_ h: S, _ n: S) -> Int {
        var c = 0, i = 0
        while true { let k = indexOf(h, n, i); if k < 0 { return c }; c += 1; i = k + n.count }
    }
    /// case-insensitive search: /word/i.test(h)
    static func ciIncludes(_ h: S, _ word: S) -> Bool {
        guard h.count >= word.count else { return false }
        for i in 0...(h.count - word.count) where ci(h, i, word) { return true }
        return false
    }
    /// ASCII-only case fold, the HTML spec's, and LENGTH-PRESERVING: every index
    /// into the folded copy is an index into the file. (toLowerCase() turns U+0130
    /// into two units, so a Turkish İ before a block shifted every offset after it.)
    static func asciiLower(_ h: S) -> S { h.map(fold) }

    // MARK: - the scanner

    struct Block {
        let tag: String           // "script" | "style"
        let attrs: S
        let text: S
        /// offset of the start tag's "<"
        let tagStart: Int
        let start: Int
        /// just past the end tag's ">", as the tokenizer ends it (quoted values and all)
        let end: Int
        let type: String?
        let id: String?
        let src: String?
        let preview: Bool
        /// the start tag repeats an attribute, or puts "/" between attributes (Bento writes neither)
        let duplicate: Bool
        let slash: Bool
    }

    struct Unterminated: Error { let tag: String; let at: Int; let startTag: Bool }

    /// the HTML tokenizer's whitespace: tab, LF, FF, CR, space
    static func isWS(_ c: UInt16) -> Bool { c == 0x09 || c == 0x0A || c == 0x0C || c == 0x0D || c == 0x20 }

    struct StartTag {
        let name: S
        /// first value per name: names folded to ASCII lowercase, NUL as U+FFFD
        let attrs: [(S, S)]
        let duplicate: Bool
        let slash: Bool
        let end: Int
        func get(_ n: String) -> String? { let k = Gate1.u(n); return attrs.first { $0.0 == k }.map { Gate1.str($0.1) } }
        func has(_ n: String) -> Bool { let k = Gate1.u(n); return attrs.contains { $0.0 == k } }
    }

    /// A start tag's attributes, read the way the HTML tokenizer reads them: names
    /// separated by whitespace OR "/", a quoted value ends an attribute, a leading
    /// "=" is part of a name, names fold ASCII-only, the FIRST duplicate wins.
    /// nil: not a start tag, or unterminated.
    static func parseStartTag(_ html: S, _ i: Int) -> StartTag? {
        i < html.count && html[i] == 0x3C ? readTag(html, i + 1) : nil
    }

    /// An END tag, read exactly like a start tag: the tokenizer parses attributes
    /// in end tags too, quoted values included, then drops them. So
    /// `</p a="><b c='">` ends at its SECOND ">". nil if not "</" and a letter, or unterminated.
    static func parseEndTag(_ html: S, _ i: Int) -> StartTag? {
        i + 1 < html.count && html[i] == 0x3C && html[i + 1] == 0x2F ? readTag(html, i + 2) : nil
    }

    /// A tag's name and attributes, from its name's first character.
    private static func readTag(_ html: S, _ at0: Int) -> StartTag? {
        // /^([a-zA-Z][^\t\n\f\r />]*)/ within the next 256 units
        let window = min(html.count, at0 + 256)
        guard at0 < window, isLetter(html[at0]) else { return nil }
        var ne = at0 + 1
        while ne < window, !isWS(html[ne]), html[ne] != 0x2F, html[ne] != 0x3E { ne += 1 }
        let tagName = asciiLower(Array(html[at0..<ne]))
        var attrs: [(S, S)] = []
        var duplicate = false, slash = false
        var j = ne
        let len = html.count
        let ch = { (k: Int) -> UInt16? in k < len ? html[k] : nil }
        while j < len {
            let c = html[j]
            if isWS(c) { j += 1; continue }
            if c == 0x2F { slash = true; j += 1; continue }
            if c == 0x3E { return StartTag(name: tagName, attrs: attrs, duplicate: duplicate, slash: slash, end: j + 1) }
            var k = j
            var name: S = []
            if html[k] == 0x3D { name = [0x3D]; k += 1 }
            while k < len, !isWS(html[k]), html[k] != 0x2F, html[k] != 0x3E, html[k] != 0x3D { name.append(html[k]); k += 1 }
            name = asciiLower(name).map { $0 == 0 ? 0xFFFD : $0 }
            var value: S = []
            var p = k
            while let x = ch(p), isWS(x) { p += 1 }
            if ch(p) == 0x3D {
                p += 1
                while let x = ch(p), isWS(x) { p += 1 }
                if let q = ch(p), q == 0x22 || q == 0x27 {
                    let close = indexOf(html, [q], p + 1)
                    if close < 0 { return nil }
                    value = Array(html[(p + 1)..<close])
                    k = close + 1
                } else {
                    var e = p
                    while e < len, !isWS(html[e]), html[e] != 0x3E { e += 1 }
                    value = slice(html, p, e)
                    k = e
                }
            }
            if attrs.contains(where: { $0.0 == name }) { duplicate = true } else { attrs.append((name, value)) }
            j = k
        }
        return nil
    }

    /// Elements whose content is TEXT to a browser, never tags, up to their real end tag.
    static let rawText: Set<String> = ["script", "style", "textarea", "title"]

    /// Where a raw-text element really ends: "</name" (ASCII case-insensitive)
    /// followed by whitespace, "/" or ">", as the tokenizer requires. -1 if never.
    static func rawTextEnd(_ lower: S, _ name: S, _ from: Int) -> Int {
        var at = from
        let n = u("</") + name
        while true {
            at = indexOf(lower, n, at)
            if at < 0 { return -1 }
            let k = at + 2 + name.count
            if k >= lower.count || isWS(lower[k]) || lower[k] == 0x2F || lower[k] == 0x3E { return at }
            at += 2
        }
    }

    /// /^[a-z][a-z0-9-]*$/: the only tag names Bento writes
    static func plainTagName(_ n: S) -> Bool {
        guard let f = n.first, f >= 0x61 && f <= 0x7A else { return false }
        return n.allSatisfy { ($0 >= 0x61 && $0 <= 0x7A) || isDigit($0) || $0 == 0x2D }
    }

    /// JSON.stringify of a string, as the reference words its problems
    static func jsonString(_ s: S) -> String {
        var out: S = [0x22]
        var k = 0
        while k < s.count {
            let c = s[k]
            switch c {
            case 0x22: out += u("\\\""); case 0x5C: out += u("\\\\")
            case 0x08: out += u("\\b"); case 0x0C: out += u("\\f"); case 0x0A: out += u("\\n")
            case 0x0D: out += u("\\r"); case 0x09: out += u("\\t")
            case 0xD800...0xDBFF where k + 1 < s.count && (0xDC00...0xDFFF).contains(s[k + 1]):
                out += [c, s[k + 1]]; k += 1
            case 0..<0x20, 0xD800...0xDFFF: out += u(String(format: "\\u%04x", c))
            default: out.append(c)
            }
            k += 1
        }
        return str(out + [0x22])
    }

    /// ONE walk over the file, in document order, tag by tag, as a browser's
    /// tokenizer meets them. Both scanBlocks and markupProblems read it, so the
    /// blocks hashed and the markup judged come from the same reading. Searching
    /// for "<script" instead found one inside another tag's name
    /// (`<meta<style><script>`), where a browser sees one tag and a real script.
    static func walk(_ html: S) -> (blocks: [Block], problems: [String]) {
        var blocks: [Block] = [], problems: [String] = []
        let lower = asciiLower(html)
        var i = 0
        while true {
            i = indexOf(html, u("<"), i)
            if i < 0 { break }
            if at(html, i, u("<!--")) {
                // "<!-->" and "<!--->" are whole (empty) comments to a browser
                if at(html, i, u("<!-->")) { i += 5; continue }
                if at(html, i, u("<!--->")) { i += 6; continue }
                let end = indexOf(html, u("-->"), i + 4)
                if includes(slice(lower, i + 4, end < 0 ? html.count : end), u("<script")) { problems.append("a comment holds a <script>") }
                if end < 0 { problems.append("an unterminated comment"); break }
                i = end + 3; continue
            }
            let c1: UInt16? = i + 1 < html.count ? html[i + 1] : nil
            if c1 == 0x2F, i + 2 < html.count, isLetter(html[i + 2]) {
                // an end tag: tokenized with the start tag's attribute rules (see parseEndTag)
                guard let et = parseEndTag(html, i) else { problems.append("an unterminated end tag"); break }
                if !plainTagName(et.name) { problems.append("an end tag named \(jsonString(et.name))") }
                // a browser drops them, but they move where the tag ends: Bento writes none
                if !et.attrs.isEmpty { problems.append("an end tag </\(str(et.name))> carrying attributes") }
                i = et.end; continue
            }
            if at(html, i, u("</>")) { i += 3; continue }   // ignored entirely
            if c1 == 0x2F || c1 == 0x21 || c1 == 0x3F {
                // a doctype or a bogus comment: it ends at the first ">", quotes or not
                let end = indexOf(html, u(">"), i + 2)
                if end < 0 { problems.append("an unterminated tag"); break }
                i = end + 1; continue
            }
            guard let c = c1, isLetter(c) else { i += 1; continue }   // a "<" that starts no tag is text
            guard let tag = parseStartTag(html, i) else { problems.append("an unterminated start tag"); break }
            let name = str(tag.name)
            if !plainTagName(tag.name) { problems.append("a start tag named \(jsonString(tag.name))") }
            if ["iframe", "object", "embed", "base"].contains(name) { problems.append("a <\(name)>") }
            if name == "meta", refreshOrCSP(tag.attrs.first { $0.0 == u("http-equiv") }?.1 ?? []) { problems.append("a <meta> refresh or CSP") }
            if tag.attrs.contains(where: { $0.0.starts(with: u("on")) }) { problems.append("an on*= attribute on <\(name)>") }
            if name == "script", tag.duplicate || tag.slash {
                problems.append("a <script> start tag with a \(tag.duplicate ? "duplicate attribute" : "\"/\" between attributes") (Bento writes neither)")
            }
            if rawText.contains(name) {
                let close = rawTextEnd(lower, tag.name, tag.end)
                if close < 0 { problems.append("an unterminated <\(name)>"); break }
                if name != "script", includes(slice(lower, tag.end, close), u("<script")) { problems.append("a <\(name)> holds a <script>") }
                if name == "textarea" || name == "title" { i = close; continue }
                guard let et = parseEndTag(html, close) else { problems.append("an unterminated </\(name)>"); break }
                blocks.append(Block(tag: name, attrs: slice(html, i, tag.end), text: slice(html, tag.end, close),
                                    tagStart: i, start: tag.end, end: et.end,
                                    type: tag.get("type"), id: tag.get("id"), src: tag.get("src"), preview: tag.has("data-bento-preview"),
                                    duplicate: tag.duplicate, slash: tag.slash))
                i = close; continue   // its end tag is judged next, as an end tag
            }
            i = tag.end
        }
        return (blocks, problems)
    }

    /// Every <script> and <style> element in the file, with its raw text, in document order.
    static func scanBlocks(_ html: S) throws -> [Block] { walk(html).blocks }

    // MARK: - the grammar (security, 2026-10-21)

    /// The data types Bento writes, matched exactly (case-sensitive). Anything
    /// else in a <script> is executable.
    static let dataTypes: Set<String> = ["application/bento+json", "application/bento+lang", "bento/deflate-b64", "bento/deflate-b86"]
    static func isDataScript(_ b: Block) -> Bool { b.tag == "script" && b.src == nil && b.type.map(dataTypes.contains) == true }
    static func executableScripts(_ blocks: [Block]) -> [Block] { blocks.filter { $0.tag == "script" && !isDataScript($0) } }

    /// /^\s*(refresh|content-security-policy)\s*$/i on the http-equiv value
    private static func refreshOrCSP(_ v: S) -> Bool {
        var a = 0, b = v.count
        while a < b, isSpace(v[a]) { a += 1 }
        while b > a, isSpace(v[b - 1]) { b -= 1 }
        let core = Array(v[a..<b])
        for w in ["refresh", "content-security-policy"] where core.count == w.utf16.count && ci(core, 0, u(w)) { return true }
        return false
    }

    /// Markup a genuine Bento file never carries, outside a script or style
    /// element's own text. [] = none.
    static func markupProblems(_ html: S) throws -> [String] {
        let (blocks, problems0) = walk(html)
        var problems = problems0
        for b in blocks where isDataScript(b) && b.text.contains(0x3C) { problems.append("the \(b.type ?? "") block contains \"<\"") }
        return problems
    }

    // MARK: - hashing

    /// sha256 HEX of the text's UTF-8 bytes: every `blocks` pin
    static func sha256hex(_ s: S) -> String {
        SHA256.hash(data: Data(str(s).utf8)).map { String(format: "%02x", $0) }.joined()
    }
    /// 'sha256-' + BASE64: every `scriptSrc` pin. Never compared with a hex pin.
    static func cspHash(_ s: S) -> String {
        "sha256-" + Data(SHA256.hash(data: Data(str(s).utf8))).base64EncodedString()
    }

    // MARK: - pins, and checking a file against one release

    struct Pins {
        let rt: String?, rtCss: String?, loader: String?, remover: String?
        let scriptSrc: [String]
        init(_ j: JSON) {
            let b = j["blocks"]
            rt = b?["bento-rt"]?.string; rtCss = b?["bento-rt-css"]?.string
            loader = b?["loader"]?.string; remover = b?["remover"]?.string
            scriptSrc = j["scriptSrc"]?.array?.compactMap { $0.string } ?? []
        }
        func block(_ id: String) -> String? { id == "bento-rt" ? rt : rtCss }
    }

    static let codeIds = ["bento-rt", "bento-rt-css"]

    /// Problems with this file as ONE release's: [] = it's that release's file.
    static func checkAgainstPins(_ html: S, _ pins: Pins) throws -> [String] {
        var problems = try markupProblems(html)
        let blocks = try scanBlocks(html)
        for id in codeIds {
            let found = blocks.filter { $0.id == id }
            if found.count != 1 { problems.append("\(found.count) #\(id) blocks (exactly one expected)") }
            else if sha256hex(found[0].text) != pins.block(id) { problems.append("#\(id) does not match") }
        }
        let exec = executableScripts(blocks)
        let hashes = exec.map { sha256hex($0.text) }
        // `.filter(Boolean)`: null and "" drop out
        let allowed = Set([pins.loader, pins.remover].compactMap { $0 }.filter { !$0.isEmpty })
        for (k, s) in exec.enumerated() where s.src != nil || !allowed.contains(hashes[k]) {
            problems.append("an executable script that is neither the pinned loader nor the remover (\(s.src.map { "src=" + $0 } ?? "\(s.text.count)B"))")
        }
        let n = { (h: String?) in hashes.filter { $0 == h }.count }
        if n(pins.loader) == 0 { problems.append("no pinned loader") }
        if n(pins.loader) > 1 { problems.append("more than one loader") }
        if let r = pins.remover, !r.isEmpty, n(r) > 1 { problems.append("more than one remover") }
        return problems
    }

    // MARK: - the release history

    /// /^(\d+)\.(\d+)\.(\d+)$/
    static func semver(_ s: String) -> [Double]? {
        let parts = s.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3, parts.allSatisfy({ !$0.isEmpty && $0.utf16.allSatisfy(isDigit) }) else { return nil }
        return parts.map { Double($0)! }
    }
    static func cmpVersion(_ a: String, _ b: String) -> Int {
        let x = semver(a)!, y = semver(b)!
        for i in 0..<3 where x[i] != y[i] { return x[i] < y[i] ? -1 : 1 }
        return 0
    }
    /// `/^[0-9a-f]{64}$/.test(v ?? '')`, with JavaScript's coercion of non-strings
    private static func hex64(_ v: JSON?) -> Bool {
        func coerce(_ v: JSON?) -> String? {
            switch v {
            case nil, .null?: return ""
            case .string(let s)?: return s
            case .array(let a)?: return a.map { coerce($0) ?? "\u{0}" }.joined(separator: ",")
            default: return nil   // a number, bool or object never reads as 64 hex digits
            }
        }
        guard let s = coerce(v), s.utf16.count == 64 else { return false }
        return s.utf16.allSatisfy { isDigit($0) || ($0 >= 0x61 && $0 <= 0x66) }
    }
    /// typeof x === 'object' (null included)
    private static func isObjectish(_ v: JSON?) -> Bool {
        switch v { case .object?, .array?, .null?: return true; default: return false }
    }
    static func entryOk(_ e: JSON?) -> Bool {
        guard let e, e.truthy, let v = e["version"]?.string, semver(v) != nil, hex64(e["sha256"]),
              e["at"]?.string != nil, e["pins"]?["v"]?.number == 1, isObjectish(e["pins"]?["blocks"]) else { return false }
        return true
    }

    /// A history payload's shape problems; [] = well-formed (versions unique, newest first).
    static func historyProblems(_ h: JSON?) -> [String] {
        var p: [String] = []
        if h?.truthy != true || h?["v"]?.number != 1 { p.append("version \(h?["v"].map(String.init(describing:)) ?? "undefined") (expected 1)") }
        if (h?["app"]?.string ?? "").isEmpty { p.append("no app") }
        guard let rel = h?["releases"]?.array else { p.append("no releases"); return p }
        var seen = Set<String>()
        for (i, e) in rel.enumerated() {
            guard entryOk(e) else { p.append("entry \(i) is malformed"); continue }
            let v = e["version"]!.string!
            if seen.contains(v) { p.append("version \(v) appears twice") }
            seen.insert(v)
            if i > 0, entryOk(rel[i - 1]), cmpVersion(rel[i - 1]["version"]!.string!, v) <= 0 { p.append("entries are not newest-first at \(v)") }
        }
        return p
    }

    enum Accept: Equatable { case ok, refused(String) }

    /// ANTI-ROLLBACK: a host's acceptance of an incoming, signature-checked
    /// history, given the newest it holds.
    static func acceptHistory(held: JSON?, incoming: JSON, app: String) -> Accept {
        let problems = historyProblems(incoming)
        if let first = problems.first { return .refused("malformed: \(first)") }
        if incoming["app"]?.string != app { return .refused("for \(incoming["app"]?.string ?? ""), not \(app)") }
        guard let held, held != .null else { return .ok }
        let inc = incoming["releases"]?.array ?? [], hr = held["releases"]?.array ?? []
        if inc.isEmpty || (!hr.isEmpty && cmpVersion(inc[0]["version"]!.string!, hr[0]["version"]?.string ?? "0.0.0") < 0) {
            return .refused("rollback: its newest release is older than the newest already held")
        }
        for e in hr {
            let v = e["version"]?.string
            guard let there = inc.first(where: { $0["version"]?.string == v }) else {
                return .refused("rollback: it lacks \(v ?? ""), which is already held")
            }
            // JSON.stringify equality: same values AND the same key order
            if there != e { return .refused("\(v ?? "") changed: a history never changes an entry") }
        }
        return .ok
    }

    /// The ONE entry matching every block, or nil (none, or more than one: UNKNOWN).
    static func matchRelease(_ history: JSON, _ html: S) throws -> JSON? {
        let rt = try scanBlocks(html).filter { $0.id == "bento-rt" }
        guard rt.count == 1 else { return nil }
        let rtHash = sha256hex(rt[0].text)
        var full: [JSON] = []
        for e in history["releases"]?.array ?? [] where e["pins"]?["blocks"]?["bento-rt"]?.string == rtHash {
            if try checkAgainstPins(html, Pins(e["pins"]!)).isEmpty { full.append(e) }
        }
        return full.count == 1 ? full[0] : nil
    }

    // MARK: - the served path

    /// The CSP a verified document is served under (security §17/§18, §36a).
    static func hostPolicy(_ pins: Pins, frameAncestors: String = "'none'") -> String {
        [
            "default-src 'none'",
            "script-src \(pins.scriptSrc.map { "'\($0)'" }.joined(separator: " ")) blob:",
            "style-src 'unsafe-inline'",
            "img-src data: blob: https:",
            "media-src data: blob: https:",
            "font-src data: blob:",
            "connect-src https://bento.page https://sync.bento.page wss://sync.bento.page",
            "frame-src https:",
            "object-src 'none'",
            "base-uri 'none'",
            "form-action 'none'",
            "worker-src 'none'",
            "frame-ancestors \(frameAncestors)",
        ].joined(separator: "; ")
    }

    enum Served {
        case genuine(version: String, entry: JSON, csp: String)
        case unknown(String)
    }

    /// THE served-path gate. The history must already have passed the release-key
    /// signature check (`openSigned`) and `acceptHistory`.
    static func verifyServed(_ html: S, history: JSON, frameAncestors: String = "'none'") -> Served {
        if let first = historyProblems(history).first { return .unknown("the history is malformed: \(first)") }
        do {
            guard let release = try matchRelease(history, html) else {
                let markup = try markupProblems(html)
                return .unknown(markup.first ?? "no single release matches every block")
            }
            return .genuine(version: release["version"]!.string!, entry: release,
                            csp: hostPolicy(Pins(release["pins"]!), frameAncestors: frameAncestors))
        } catch let e as Unterminated {
            return .unknown("an unterminated <\(e.tag)>\(e.startTag ? " start tag" : "") at \(e.at)")
        } catch {
            return .unknown("unreadable")
        }
    }

    /// A served file judged against EVERY history the host holds. A fresh shell has
    /// an empty document block, so nothing in the file says which app it is: the
    /// history is never picked by a name read from the file. Exactly one held
    /// history must match; none, or more than one, is UNKNOWN. The verdict names
    /// the app that matched.
    static func verifyServedHeld(_ html: S, _ held: [JSON], frameAncestors: String = "'none'") -> (verdict: Served, app: String?) {
        var hits: [(app: String, v: Served)] = []
        for h in held {
            let v = verifyServed(html, history: h, frameAncestors: frameAncestors)
            if case .genuine = v { hits.append((h["app"]?.string ?? "", v)) }
        }
        if hits.count == 1 { return (hits[0].v, hits[0].app) }
        return (.unknown(hits.isEmpty ? "no held history matches" : "\(hits.count) held histories match (\(hits.map(\.app).joined(separator: ", ")))"), nil)
    }

    // MARK: - the signed history envelope

    /// `{ payload, sig }`: ECDSA P-256 SHA-256 over the payload's UTF-8, r‖s in
    /// base64. The payload, parsed, when the signature verifies; nil otherwise.
    static func openSigned(_ envelope: Data, publicKey: P256.Signing.PublicKey) -> JSON? {
        openSigned(envelope) { sig, msg in
            (try? P256.Signing.ECDSASignature(rawRepresentation: sig)).map { publicKey.isValidSignature($0, for: msg) } ?? false
        }
    }

    /// The same, checked by `verify(signature, message)`: ReleaseKeys.verify, any pinned key.
    static func openSigned(_ envelope: Data, verify: (Data, Data) -> Bool) -> JSON? {
        guard let env = try? JSON.parse(envelope), let payload = env["payload"]?.string, let sigB64 = env["sig"]?.string,
              let sigRaw = Data(base64Encoded: sigB64), verify(sigRaw, Data(payload.utf8)) else { return nil }
        return try? JSON.parse(Data(payload.utf8))
    }

    /// Is this file's runtime one the history knows at all? UNKNOWN with a runtime
    /// no entry carries reads as "made with a Bento this app doesn't know yet:
    /// check for updates", never as damage, because a newer release looks
    /// exactly like that until the history is refreshed. (Not part of the
    /// reference: only what the host tells the person.)
    static func runtimeKnown(_ html: S, history: JSON) -> Bool {
        guard let rt = try? scanBlocks(html).filter({ $0.id == "bento-rt" }), rt.count == 1 else { return false }
        let h = sha256hex(rt[0].text)
        return (history["releases"]?.array ?? []).contains { $0["pins"]?["blocks"]?["bento-rt"]?.string == h }
    }

    /// A public key from its JWK (EC, P-256).
    static func publicKey(jwk: Data) -> P256.Signing.PublicKey? {
        guard let j = try? JSON.parse(jwk), j["kty"]?.string == "EC", j["crv"]?.string == "P-256",
              let x = j["x"]?.string.flatMap(b64url), let y = j["y"]?.string.flatMap(b64url), x.count == 32, y.count == 32
        else { return nil }
        return try? P256.Signing.PublicKey(x963Representation: Data([4]) + x + y)
    }
    private static func b64url(_ s: String) -> Data? {
        var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while t.count % 4 != 0 { t += "=" }
        return Data(base64Encoded: t)
    }

    // MARK: - the strict file:// fallback (security §15)

    struct StrictExpected {
        let skeleton: S
        let remover: S?
    }

    static let closeTag = u("</" + "script>")
    static let docAnchor = u(" id=\"bento-doc\"")
    static let docOpen = u("<script type=\"application/bento+json\" id=\"bento-doc\">")

    /// /\son[a-z]+\s*=/i
    private static func spaceOnAttr(_ b: S) -> Bool {
        for p in 0..<b.count where isSpace(b[p]) && ci(b, p + 1, u("on")) {
            var k = p + 3
            let s = k
            while k < b.count, isLetter(b[k]) { k += 1 }
            guard k > s else { continue }
            while k < b.count, isSpace(b[k]) { k += 1 }
            if k < b.count, b[k] == 0x3D { return true }
        }
        return false
    }

    /// h.replace(/<title>[^<]*<\/title>/, '<title><!--TITLE--></title>')
    private static func collapseTitle(_ h: S) -> S {
        let open = u("<title>"), close = u("</title>")
        var p = indexOf(h, open)
        while p >= 0 {
            var k = p + open.count
            while k < h.count, h[k] != 0x3C { k += 1 }
            if at(h, k, close) { return Array(h[..<p]) + u("<title><!--TITLE--></title>") + Array(h[(k + close.count)...]) }
            p = indexOf(h, open, p + 1)
        }
        return h
    }

    private static func collapse(_ h0: S, _ remover: S?) -> Result<S, Refusal> {
        var h = h0
        let anchors = count(h, docAnchor)
        if anchors != 1 { return .failure(.init("doc anchor count \(anchors)")) }
        let di = indexOf(h, docAnchor)
        let dOpen = lastIndexOf(h, u("<"), di)
        let dTagEnd = indexOf(h, u(">"), di) + 1
        let dEnd = indexOf(h, closeTag, di) + closeTag.count
        if slice(h, dOpen, dTagEnd) != docOpen { return .failure(.init("doc block opening tag altered")) }
        if dEnd < closeTag.count || includes(slice(h, dTagEnd, dEnd - closeTag.count), u("<")) {
            return .failure(.init("\"<\" inside the doc block"))
        }
        h = slice(h, 0, dOpen) + u("<!--DOC-->") + slice(h, dEnd)
        if count(h, u("data-bento-preview")) > 0 {
            guard let remover, count(h, u("<script data-bento-preview")) == 1, count(h, remover) == 1 else {
                return .failure(.init("remover missing, altered or repeated"))
            }
            let pOpen = lastIndexOf(h, u("<"), indexOf(h, u("data-bento-preview")))
            let rem = indexOf(h, remover)
            let body = slice(h, pOpen, rem)
            if ciIncludes(body, u("<script")) { return .failure(.init("script inside the preview markup")) }
            if spaceOnAttr(body) || ciIncludes(body, u("javascript:")) { return .failure(.init("handler or javascript: in the preview markup")) }
            h = slice(h, 0, pOpen) + u("<!--PREVIEW-->") + slice(h, rem + remover.count)
        }
        return .success(collapseTitle(h))
    }

    struct Refusal: Error { let reason: String; init(_ r: String) { reason = r } }

    /// The strict check: each variable span type-checked and collapsed, then the
    /// WHOLE string equal to the release's saved skeleton, bound at both ends.
    static func verifyStrict(_ html: S, _ expected: StrictExpected) -> Result<Void, Refusal> {
        switch collapse(html, expected.remover) {
        case .failure(let r): return .failure(r)
        case .success(let c): return c == expected.skeleton ? .success(()) : .failure(.init("skeleton differs from the release's saved form"))
        }
    }
}

// MARK: - JSON, keeping key order

/// JSON as JSON.parse reads it, with each object's KEY ORDER kept, so that
/// equality is JSON.stringify equality (a reordered entry is a changed entry).
/// A repeated key keeps its first position and its last value, as JSON.parse does.
indirect enum JSON: Equatable {
    case null, bool(Bool), number(Double), string(String), array([JSON]), object([(String, JSON)])

    static func == (a: JSON, b: JSON) -> Bool {
        switch (a, b) {
        case (.null, .null): return true
        case (.bool(let x), .bool(let y)): return x == y
        case (.number(let x), .number(let y)): return x == y
        case (.string(let x), .string(let y)): return Array(x.utf16) == Array(y.utf16)
        case (.array(let x), .array(let y)): return x == y
        case (.object(let x), .object(let y)):
            return x.count == y.count && zip(x, y).allSatisfy { $0.0 == $1.0 && $0.1 == $1.1 }
        default: return false
        }
    }

    subscript(_ k: String) -> JSON? { if case .object(let o) = self { return o.first { $0.0 == k }?.1 }; return nil }
    var string: String? { if case .string(let s) = self { return s }; return nil }
    var number: Double? { if case .number(let n) = self { return n }; return nil }
    var array: [JSON]? { if case .array(let a) = self { return a }; return nil }
    var truthy: Bool {
        switch self {
        case .null: return false
        case .bool(let b): return b
        case .number(let n): return n != 0 && !n.isNaN
        case .string(let s): return !s.isEmpty
        default: return true
        }
    }

    struct ParseError: Error {}

    static func parse(_ d: Data) throws -> JSON {
        var p = Parser(Array(String(decoding: d, as: UTF8.self).utf16))
        let v = try p.value()
        p.ws()
        guard p.i == p.s.count else { throw ParseError() }
        return v
    }

    private struct Parser {
        let s: [UInt16]
        var i = 0
        init(_ s: [UInt16]) { self.s = s }
        mutating func ws() { while i < s.count, [0x20, 0x09, 0x0A, 0x0D].contains(s[i]) { i += 1 } }
        mutating func lit(_ w: String) throws { for c in w.utf16 { guard i < s.count, s[i] == c else { throw ParseError() }; i += 1 } }
        mutating func value() throws -> JSON {
            ws()
            guard i < s.count else { throw ParseError() }
            switch s[i] {
            case 0x7B:   // {
                i += 1; var o: [(String, JSON)] = []
                ws()
                if i < s.count, s[i] == 0x7D { i += 1; return .object(o) }
                while true {
                    ws(); let k = try string(); ws(); try lit(":")
                    let v = try value()
                    if let at = o.firstIndex(where: { $0.0 == k }) { o[at].1 = v } else { o.append((k, v)) }
                    ws()
                    guard i < s.count else { throw ParseError() }
                    if s[i] == 0x2C { i += 1; continue }
                    if s[i] == 0x7D { i += 1; return .object(o) }
                    throw ParseError()
                }
            case 0x5B:   // [
                i += 1; var a: [JSON] = []
                ws()
                if i < s.count, s[i] == 0x5D { i += 1; return .array(a) }
                while true {
                    a.append(try value()); ws()
                    guard i < s.count else { throw ParseError() }
                    if s[i] == 0x2C { i += 1; continue }
                    if s[i] == 0x5D { i += 1; return .array(a) }
                    throw ParseError()
                }
            case 0x22: return .string(try string())
            case 0x74: try lit("true"); return .bool(true)
            case 0x66: try lit("false"); return .bool(false)
            case 0x6E: try lit("null"); return .null
            default: return .number(try number())
            }
        }
        mutating func string() throws -> String {
            guard i < s.count, s[i] == 0x22 else { throw ParseError() }
            i += 1
            var out: [UInt16] = []
            while true {
                guard i < s.count else { throw ParseError() }
                let c = s[i]; i += 1
                if c == 0x22 { return String(decoding: out, as: UTF16.self) }
                if c < 0x20 { throw ParseError() }
                if c != 0x5C { out.append(c); continue }
                guard i < s.count else { throw ParseError() }
                let e = s[i]; i += 1
                switch e {
                case 0x22, 0x5C, 0x2F: out.append(e)
                case 0x62: out.append(0x08)
                case 0x66: out.append(0x0C)
                case 0x6E: out.append(0x0A)
                case 0x72: out.append(0x0D)
                case 0x74: out.append(0x09)
                case 0x75:
                    guard i + 4 <= s.count, let v = UInt16(String(decoding: s[i..<(i + 4)], as: UTF16.self), radix: 16) else { throw ParseError() }
                    out.append(v); i += 4
                default: throw ParseError()
                }
            }
        }
        mutating func number() throws -> Double {
            let st = i
            if i < s.count, s[i] == 0x2D { i += 1 }
            guard i < s.count, Gate1.isDigit(s[i]) else { throw ParseError() }
            if s[i] == 0x30 { i += 1 } else { while i < s.count, Gate1.isDigit(s[i]) { i += 1 } }
            if i < s.count, s[i] == 0x2E {
                i += 1; guard i < s.count, Gate1.isDigit(s[i]) else { throw ParseError() }
                while i < s.count, Gate1.isDigit(s[i]) { i += 1 }
            }
            if i < s.count, s[i] == 0x65 || s[i] == 0x45 {
                i += 1; if i < s.count, s[i] == 0x2B || s[i] == 0x2D { i += 1 }
                guard i < s.count, Gate1.isDigit(s[i]) else { throw ParseError() }
                while i < s.count, Gate1.isDigit(s[i]) { i += 1 }
            }
            guard let d = Double(String(decoding: s[st..<i], as: UTF16.self)) else { throw ParseError() }
            return d
        }
    }
}
