// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

package page.bento.home

/**
 * What this app can know about a file it did not write.
 *
 * A PORT, not an original. `home/doc-index.mjs` is the reference and
 * `home/fixtures/` is the corpus that holds this implementation to it —
 * `DocumentIndexTest` runs that same corpus on the JVM, so it needs no device
 * and no emulator. If the two ever disagree, this one is wrong.
 *
 * Why a port at all, rather than sharing the JavaScript: the list UI stays
 * native. Putting the extension's HTML library in a WebView was measured at
 * ~0.5s of extra cold start, costs iOS its system document browser, and makes
 * accessibility something you re-earn rather than get. See `docs/DECISIONS.md`,
 * 2026-08-16.
 */
object DocumentIndex {

    /** The splice contract's marker (docs/PLATFORM.md §2), frozen because old
     *  updaters depend on it. A Bento document is one because of what is INSIDE
     *  it — files get renamed to `deck.html` to email them, saved as
     *  `Q3(1).html`, downloaded without the compound extension. */
    const val MARKER = "id=\"bento-doc\""

    /** Read before deciding a file is not ours. Runs against every stray .html
     *  in a granted folder, most of which are not ours, so it is deliberately
     *  smaller than [HEAD_CHARS]. */
    const val SNIFF_CHARS = 64 * 1024

    /** Enough to reach the title, which sits inside the block. The block itself
     *  runs to megabytes when a document carries images. */
    const val HEAD_CHARS = 300 * 1024

    /** Enough prose for any phrase somebody would search for; far short of
     *  storing the document twice. */
    const val TEXT_BUDGET = 40 * 1024

    // ---------------------------------------------------------------- regexes
    //
    // Compiled once. Every one of these mirrors a JavaScript literal in the
    // reference, and two of them need care because Java and JavaScript disagree:
    //
    //  - `\s` in JavaScript is UNICODE-AWARE; in Java it is ASCII-only unless
    //    UNICODE_CHARACTER_CLASS is set, and even then it follows the
    //    White_Space property, which EXCLUDES U+FEFF. So the class is written
    //    out in full rather than spelled `\s`. A port that used `\s` would leave
    //    non-breaking and ideographic spaces sitting in the indexed text, and
    //    a phrase search across one of them would silently fail to match.
    //    `whitespace.html` in the corpus is what catches that.
    //  - `.` matches any character except a line terminator in both, so `\\.`
    //    inside the value pattern behaves identically. No flag needed.

    /** One embedded image outweighs every word in a document, so data URIs go
     *  first — before extraction, not after. */
    private val DATA_URI = Regex("""data:[^"\\]{200,}""")

    /** String VALUES only: `:"…"`, never keys. Deliberately not a JSON parse —
     *  the block runs to megabytes, every app shapes it differently (slides put
     *  prose in `element.html`, spaces in blocks, dash in cells), and a parser
     *  that has to know the format breaks when the format moves.
     *
     *  NOTE the `{1,400}`: a single value longer than 400 characters does not
     *  match and is therefore NOT INDEXED AT ALL. That is current behaviour
     *  across all three hosts and `longvalue.html` pins it, so a port cannot
     *  quietly "fix" it into divergence. */
    private val VALUE = Regex(""":"((?:[^"\\]|\\.){1,400})"""")

    /** Ids, hex colours, `12px` — anything without a run of three letters. */
    private val HAS_WORD = Regex("""[A-Za-z]{3,}""")

    private val TAG = Regex("""<[^>]{1,200}>""")
    private val ENTITY = Regex("""&[a-z]+;|&#\d+;""", RegexOption.IGNORE_CASE)

    /** JavaScript's `\s`, written out. */
    private val SPACE = Regex("[\\u0009-\\u000d\\u0020\\u00a0\\u1680\\u2000-\\u200a" +
        "\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+")

    private val TITLE = Regex(""""title"\s*:\s*"((?:[^"\\]|\\.){0,200})"""")
    private val FORMAT = Regex(""""format"\s*:\s*"bento/([a-z]+)"""")
    private val ENCRYPTED = Regex(""""format"\s*:\s*"bento/enc"""")

    // ------------------------------------------------------------------- API

    fun isDocument(head: String) = head.contains(MARKER)

    fun titleOf(head: String) = TITLE.find(head)?.groupValues?.get(1)

    /** Which Bento this is. A pristine shell has no document yet, so no format:
     *  that is not a failure, it is a document nobody has saved. */
    fun appOf(head: String) = FORMAT.find(head)?.groupValues?.get(1)

    /** An encrypted document gets NO text and NO preview. A privacy rule, not an
     *  optimisation: a plaintext title page beside the ciphertext is the leak
     *  the password exists to prevent. */
    fun isEncrypted(head: String) =
        ENCRYPTED.containsMatchIn(head) || head.contains("data-bento-enc")

    /** The still render of page one that every save writes into the shell
     *  (kernel/src/preview.ts) so file managers can thumbnail it. */
    fun previewOf(whole: String): String? {
        val start = whole.indexOf("<div data-bento-preview")
        if (start == -1) return null
        val end = whole.indexOf("<script data-bento-preview", start)
        return if (end > start) whole.substring(start, end) else null
    }

    /** The words a document actually contains. */
    fun extractText(html: String): String? {
        val start = html.indexOf(MARKER)
        if (start == -1) return null
        val end = html.indexOf("</script>", start)
        if (end == -1) return null

        val block = DATA_URI.replace(html.substring(start, end), " ")
        val out = StringBuilder()
        var size = 0
        for (m in VALUE.findAll(block)) {
            val v = m.groupValues[1]
            if (!HAS_WORD.containsMatchIn(v)) continue
            if (out.isNotEmpty()) out.append(' ')
            out.append(v)
            size += v.length
            // Appended THEN tested, matching the reference: the join may exceed
            // the budget and is truncated below.
            if (size > TEXT_BUDGET) break
        }

        var s = TAG.replace(out, " ")
        s = ENTITY.replace(s, " ")
        s = SPACE.replace(s, " ").trim()
        if (s.length > TEXT_BUDGET) s = s.substring(0, TEXT_BUDGET)
        return s.ifEmpty { null }
    }

    /** Everything a host needs about one file, from bytes it has already read. */
    data class Meta(
        val isDocument: Boolean,
        val title: String?,
        val app: String?,
        val encrypted: Boolean,
        val preview: String?,
        val text: String?,
    )

    fun describe(whole: String): Meta {
        if (!isDocument(whole.take(SNIFF_CHARS))) {
            return Meta(false, null, null, false, null, null)
        }
        val head = whole.take(HEAD_CHARS)
        val encrypted = isEncrypted(head)
        return Meta(
            isDocument = true,
            title = titleOf(head),
            app = appOf(head),
            encrypted = encrypted,
            preview = if (encrypted) null else previewOf(whole),
            text = if (encrypted) null else extractText(whole),
        )
    }
}
