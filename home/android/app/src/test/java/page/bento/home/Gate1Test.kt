// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

package page.bento.home

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Gate1.kt against home/fixtures/gate1: every served row, the ambiguous row,
 * the signed history (verified with the corpus's TEST key, as the host verifies
 * the release key), and anti-rollback. The strict file:// rows are not Android's:
 * this host always serves the bytes it verified. The CSP is compared byte for
 * byte with kernel/src/gate1.ts's own, run under Node.
 */
class Gate1Test {
    private val dir = File("../../../home/fixtures/gate1")
    private fun read(p: String) = File(dir, p).readText()
    private val expected = Json.read(read("expected.json")) as Map<*, *>
    private val key = Json.read(read("test-public-key.json")) as Map<*, *>
    private val payload by lazy {
        Gate1.verifyEnvelope(read("history.json"), key["x"] as String, key["y"] as String)
            ?: error("history.json must verify under the test key")
    }
    private val history by lazy { Gate1.historyOf(payload)!! }
    @Suppress("UNCHECKED_CAST") private fun rows(k: String) = expected[k] as List<Map<String, Any?>>

    @Test fun `the signed history verifies, and a tampered payload does not`() {
        val app = expected["app"] as String
        assertEquals(app, history.app)
        assertTrue(Gate1.historyProblems(payload).isEmpty())
        val env = Json.read(read("history.json")) as Map<*, *>
        val tampered = Json.write(mapOf("payload" to (env["payload"] as String).replaceFirst("1.0.0", "1.0.1"), "sig" to env["sig"]))
        assertNull(Gate1.verifyEnvelope(tampered, key["x"] as String, key["y"] as String))
        assertNull("another key refuses it", Gate1.verifyEnvelope(read("history.json"),
            "GMHSKwWcAoJVq-Dz1ZxWZM6TXATWIKbaQBpjoTystH8", "flFNzbdXCmJN8RQYCeG71rBZnnbN-MCEnp1EbCLFrj0"))
    }

    @Test fun `every served row reaches its verdict, genuine ones under their own pins`() {
        val served = rows("served")
        assertTrue("the corpus has its served rows", served.size >= 51)
        var genuine = 0
        for (row in served) {
            val v = Gate1.verifyServed(read(row["case"] as String), history)
            val got = if (v is Gate1.Verdict.Genuine) "genuine ${v.release.version}" else "unknown"
            val want = if (row["verdict"] == "genuine") "genuine ${row["release"]}" else "unknown"
            assertEquals("${row["case"]} (${row["why"]})" + if (v is Gate1.Verdict.Unknown) " — ${v.reason}" else "", want, got)
            if (v is Gate1.Verdict.Genuine) {
                genuine++
                assertTrue(v.csp.startsWith("default-src 'none'"))
                assertTrue(v.csp.contains("'${v.release.pins.scriptSrc[0]}'"))
                assertFalse(v.csp.contains("unsafe-eval"))
            }
        }
        assertTrue("the corpus has genuine rows", genuine >= 4)
    }

    @Test fun `two entries matching every block is UNKNOWN, never the first`() {
        for (row in rows("ambiguous")) {
            val h = Gate1.historyOf(row["history"])!!
            val v = Gate1.verifyServed(read(row["case"] as String), h)
            assertEquals(row["case"] as String, row["verdict"], if (v is Gate1.Verdict.Genuine) "genuine" else "unknown")
        }
    }

    @Test fun `anti-rollback`() {
        val app = expected["app"] as String
        val hist = rows("history")
        assertEquals(8, hist.size)
        for (row in hist)
            assertEquals("${row["name"]}: ${row["why"]}", row["ok"], Gate1.acceptHistory(row["held"], row["incoming"], app) is Gate1.Accept.Ok)
    }

    @Test fun `the CSP is byte-identical to the reference's hostPolicy`() {
        val script = """
            const { hostPolicy } = await import(process.argv[1])
            const env = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'))
            process.stdout.write(hostPolicy(JSON.parse(env.payload).releases[0].pins))
        """.trimIndent()
        val proc = ProcessBuilder("node", "--input-type=commonjs", "-e",
            "(async () => { $script })().catch(e => { console.error(e); process.exit(1) })",
            File("../../../kernel/src/gate1.ts").absolutePath, File(dir, "history.json").absolutePath)
            .redirectError(ProcessBuilder.Redirect.INHERIT).start()
        val ref = proc.inputStream.bufferedReader().readText()
        assertEquals("node must run (this check never skips)", 0, proc.waitFor())
        assertEquals(ref, Gate1.hostPolicy(history.releases[0].pins))
    }

    @Test fun `hashes use the right encoding for each field`() {
        assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", Gate1.sha256hex(""))
        assertEquals("sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=", Gate1.cspHash(""))
    }

    @Test fun `the JSON writer matches JSON_stringify on key order and numbers`() {
        val s = """{"b":1,"a":[true,null,"x\"y"],"c":{"z":2.5,"y":-3}}"""
        assertEquals(s, Json.write(Json.read(s)))
        assertTrue(Json.write(Json.read("""{"a":1,"b":2}""")) != Json.write(Json.read("""{"b":2,"a":1}""")))
    }

    @Test fun `every oracle failure is UNKNOWN against the oracle's own history`() {
        // home/fixtures/gate1/oracle-failures/: files a browser oracle caught a
        // port calling GENUINE while running foreign code, with the unsigned
        // bento-oracle history beside them (kernel). Every one must be UNKNOWN.
        val d = File(dir, "oracle-failures")
        val h = File(d, "history.json")
        if (!h.isFile) return
        val history = Gate1.historyOf(Json.read(h.readText()))!!
        val files = d.listFiles { f -> f.name.endsWith(".html") }!!.sortedBy { it.name }
        for (f in files) assertTrue("${f.name} must be UNKNOWN", Gate1.verifyServed(f.readText(), history) is Gate1.Verdict.Unknown)
    }

    // ---- #842: every held history, and the frozen REAL 1.2.10 release ----

    @Suppress("UNCHECKED_CAST")
    private val histories: Map<String, Gate1.History> by lazy {
        (expected["histories"] as Map<String, Map<String, String>>).mapValues { (name, h) ->
            val k = Json.read(read(h["key"]!!)) as Map<*, *>
            val payload = Gate1.verifyEnvelope(read(h["history"]!!), k["x"] as String, k["y"] as String)
                ?: error("the $name history must verify under its own key")
            Gate1.historyOf(payload) ?: error("the $name history must be well formed")
        }
    }

    @Test fun `the real 1_2_10 history verifies under the key Android pins, and names bento-slides`() {
        val k = Json.read(read("real/slides-1.2.10/release-public-key.json")) as Map<*, *>
        assertEquals("Releases.kt pins the real release key", Releases.KEY_X, k["x"])
        assertEquals(Releases.KEY_Y, k["y"])
        val real = histories["real"]!!
        assertEquals("the app id is bento-slides, never the directory name", "bento-slides", real.app)
        assertNull("and the test key does not verify it", Gate1.verifyEnvelope(read("real/slides-1.2.10/history.json"),
            "UDNWDLyLVcxJZZ6Kyi0y-eTUEDMB5zB6jVX8NOSjNlk", "YqKJ4y20DcNjMhnPQQj8NuFiI-suqB4eFCs-9n_G3eI"))
    }

    @Test fun `every held row - try every held history, exactly one must match`() {
        val rows = rows("held")
        assertTrue(rows.size >= 6)
        for (row in rows) {
            @Suppress("UNCHECKED_CAST")
            val held = (row["held"] as List<String>).map { histories[it]!! }
            val v = Gate1.verifyServedHeld(read(row["case"] as String), held)
            val got = if (v is Gate1.Verdict.Genuine) "genuine ${v.app} ${v.release.version}" else "unknown"
            val want = if (row["verdict"] == "genuine") "genuine ${row["app"]} ${row["release"]}" else "unknown"
            assertEquals("${row["name"]}: ${row["why"]}" + if (v is Gate1.Verdict.Unknown) " — ${v.reason}" else "", want, got)
        }
    }

    @Test fun `a one-byte change to the real 1_2_10 shell is UNKNOWN (positive control)`() {
        val real = read("real/slides-1.2.10/Bento_Slides.bento.html")
        assertTrue(Gate1.verifyServedHeld(real, listOf(histories["real"]!!)) is Gate1.Verdict.Genuine)
        val at = real.indexOf("<script>") + "<script>".length
        val flipped = real.substring(0, at) + (if (real[at] == ' ') '\t' else ' ') + real.substring(at + 1)
        assertTrue(Gate1.verifyServedHeld(flipped, listOf(histories["real"]!!)) is Gate1.Verdict.Unknown)
    }
}
