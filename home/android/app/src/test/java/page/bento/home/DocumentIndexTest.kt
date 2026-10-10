// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

package page.bento.home

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.security.MessageDigest

/**
 * Holds the Kotlin indexer to the SHARED corpus in `home/fixtures/`.
 *
 * This is the whole mechanism that keeps three implementations of one algorithm
 * from drifting — see `home/fixtures/README.md`. The reference is
 * `home/doc-index.mjs`; `node scripts/test-doc-index.mjs` runs it against the
 * same cases and the same answer key. If this test and that rig disagree, one
 * of the two hosts has diverged and the corpus says which.
 *
 * A plain JVM test on purpose: it needs no emulator, so there is no excuse not
 * to run it, and `./gradlew :app:testDebugUnitTest` is cheap enough for CI.
 *
 * Gson rather than org.json, because Android's org.json is a STUB in unit tests
 * whose methods throw — the real one on the test classpath may or may not
 * shadow it, and a test that fails for that reason teaches nothing.
 */
class DocumentIndexTest {

    /** Walk up from wherever Gradle rooted us until the corpus appears; the
     *  working directory differs between an IDE run and a command-line one. */
    private val fixtures: File by lazy {
        var dir: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
        while (dir != null && !File(dir, "home/fixtures/expected.json").exists()) dir = dir.parentFile
        requireNotNull(dir) { "could not locate home/fixtures from ${System.getProperty("user.dir")}" }
        File(dir, "home/fixtures")
    }

    private val expected: JsonObject by lazy {
        JsonParser.parseString(File(fixtures, "expected.json").readText()).asJsonObject
    }

    private fun sha16(s: String): String =
        MessageDigest.getInstance("SHA-256").digest(s.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }.take(16)

    /** The constants are part of the contract. A port with a different budget
     *  passes every short case and diverges only on the large documents nobody
     *  checks by hand. */
    @Test
    fun constantsMatchTheContract() {
        assertEquals(expected["textBudget"].asInt, DocumentIndex.TEXT_BUDGET)
        assertEquals(expected["sniffBytes"].asInt, DocumentIndex.SNIFF_CHARS)
        assertEquals(expected["headBytes"].asInt, DocumentIndex.HEAD_CHARS)
    }

    @Test
    fun everyCaseInTheCorpusHasAnExpectation() {
        val cases = expected.getAsJsonObject("cases").keySet()
        val files = File(fixtures, "cases").listFiles()!!.map { it.name }.toSet()
        assertEquals("corpus and answer key disagree — regenerate expected.json", files, cases)
    }

    @Test
    fun matchesTheSharedCorpus() {
        val cases = expected.getAsJsonObject("cases")
        assertTrue("corpus is empty", cases.size() > 0)

        for ((name, raw) in cases.entrySet()) {
            val want = raw.asJsonObject
            val got = DocumentIndex.describe(File(fixtures, "cases/$name").readText())
            val why = { field: String -> "$name: $field" }

            assertEquals(why("isDocument"), want["isDocument"].asBoolean, got.isDocument)
            assertEquals(why("title"), want["title"].asStringOrNull(), got.title)
            assertEquals(why("app"), want["app"].asStringOrNull(), got.app)
            assertEquals(why("encrypted"), want["encrypted"].asBoolean, got.encrypted)
            assertEquals(why("hasPreview"), want["hasPreview"].asBoolean, got.preview != null)

            val wantLen = if (want["textLength"].isJsonNull) null else want["textLength"].asInt
            assertEquals(why("textLength"), wantLen, got.text?.length)

            val wantSha = want["textSha256_16"].asStringOrNull()
            assertEquals(why("text digest"), wantSha, got.text?.let { sha16(it) })

            // The short cases carry their text verbatim so a human can read the
            // answer key; check it too, or it rots unnoticed behind the digest.
            if (want.has("text")) assertEquals(why("text"), want["text"].asString, got.text)
        }
    }

    private fun com.google.gson.JsonElement.asStringOrNull(): String? =
        if (isJsonNull) null else asString
}
