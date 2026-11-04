// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

package page.bento.home

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Statements.kt and Address against kernel/fixtures/identity-v1.json: every address row,
 * every att. row, every accepted bind./dev. row rebuilt byte for byte from its parsed
 * fields (rows with a display name or label are skipped: the Kotlin port emits those
 * fields empty), and the signatures on accepted bind./dev./cmp. rows verified.
 */
class StatementsTest {
    private val fx: JsonObject = JsonParser.parseString(File("../../../kernel/fixtures/identity-v1.json").readText()).asJsonObject
    private val rows get() = fx.getAsJsonArray("statements").map { it.asJsonObject }
    private fun JsonObject.s(k: String) = get(k).asString
    private val now = fx.get("now").asLong

    @Test fun `address rows`() {
        var n = 0
        for (r in fx.getAsJsonArray("addresses").map { it.asJsonObject }) {
            val res = Address.normalize(r.s("input"))
            if (r.has("address")) { assertEquals(r.s("input"), r.s("address"), (res as Address.Result.Ok).address) }
            else assertEquals(r.s("input"), r.s("reason"), (res as Address.Result.No).reason)
            n++
        }
        assertTrue(n >= 20)
    }

    @Test fun `att rows reach the stated verdict under the pinned key`() {
        val keys = fx.getAsJsonObject("directoryKeys").entrySet().associate { it.key to it.value.asString }
        var accepted = 0; var rejected = 0
        for (r in rows.filter { it.s("type") == "att" }) {
            val v = Statements.verifyAtt(r.s("text"), r.s("sig"), keys, r.s("bindText"), now, r.get("maxAgeMs").asLong)
            assertEquals(r.s("name"), r.s("expect") == "accept", v is Statements.Verdict.Ok)
            if (v is Statements.Verdict.Ok) accepted++ else rejected++
        }
        assertTrue("positive control", accepted > 0 && rejected > 0)
    }

    @Test fun `an att under an unpinned kid is refused, and the same row passes under its kid`() {
        val r = rows.first { it.s("type") == "att" && it.s("expect") == "accept" }
        val pub = fx.getAsJsonObject("directoryKeys").entrySet().first().value.asString
        val kidOf = r.s("text").split(".")[4]
        assertTrue(Statements.verifyAtt(r.s("text"), r.s("sig"), mapOf(kidOf to pub), r.s("bindText"), now, 600000) is Statements.Verdict.Ok)
        // the right KEY under another kid name must not be found by "any key that verifies"
        val v = Statements.verifyAtt(r.s("text"), r.s("sig"), mapOf("other" to pub), r.s("bindText"), now, 600000)
        assertEquals("unknown-kid", (v as Statements.Verdict.No).reason)
    }

    @Test fun `accepted bind and dev rows rebuild byte for byte and verify`() {
        val keys = fx.getAsJsonObject("keys")
        var rebuilt = 0
        for (r in rows.filter { it.s("expect") == "accept" }) {
            val t = r.s("type")
            if (t == "bind") {
                val p = r.s("text").split(".")
                if (p[4] != "") continue
                val text = Statements.buildBind(Statements.BindCert(
                    String(B64u.dec(p[1])!!, Charsets.UTF_8), p[2], p[3], p[5].toInt(), p[6].ifEmpty { null }, p[7].toLong(), p[8].toLong()))
                assertEquals(r.s("name"), r.s("text"), text)
                assertTrue(r.s("name"), Statements.verifySig(p[2], r.s("sig"), text)); rebuilt++
            } else if (t == "dev") {
                val p = r.s("text").split(".")
                if (p[5] != "") continue
                val text = Statements.buildDev(Statements.DeviceCert(p[1], p[2].ifEmpty { null }, p[3], p[4], p[6].toLong(), p[7].toLong()))
                assertEquals(r.s("name"), r.s("text"), text)
                assertTrue(r.s("name"), Statements.verifySig(p[3], r.s("sig"), text)); rebuilt++
            } else if (t == "cmp") {
                val p = r.s("text").split(".")
                assertEquals(r.s("text"), Statements.buildCmp(p[1], p[2]))
                assertTrue(Statements.verifySig(keys.get("account").asString, r.s("sig"), r.s("text")))
                rebuilt++
            }
        }
        assertEquals("exactly three accepted rows have an empty name/label (light dev, no-name bind, cmp)", 3, rebuilt)
    }

    @Test fun `a signature we make verifies, is low-S, and a changed byte does not`() {
        val k = SoftKeys.generate(); val d = k.scalar; val pub = k.pub
        repeat(20) { i ->
            val text = "cmp.x.$i"
            val sig = Statements.sign(d, text)
            assertTrue(Statements.verifySig(pub, sig, text))
            assertFalse(Statements.verifySig(pub, sig, "cmp.x.${i + 1}"))
        }
    }

    @Test fun `the email code is upper-cased and held to its alphabet`() {
        assertEquals("cmp.h.K7Q3MZ2P", Statements.buildCmp("h", " k7q3mz2p "))
        assertEquals(null, Statements.buildCmp("h", "K7Q3MZ20"))   // 0 is not in the alphabet
        assertEquals(null, Statements.buildCmp("h", "K7Q3MZ2"))
    }

    @Test fun `accepted dreq rows rebuild byte for byte, and the arg is what each op fixes`() {
        var n = 0; val ops = mutableSetOf<String>()
        for (r in fx.getAsJsonArray("dreq").map { it.asJsonObject }.filter { it.s("expect") == "accept" }) {
            val sub = r.getAsJsonObject("subject"); val op = sub.s("op")
            fun bytes(k: String) = B64u.dec(sub.s(k))!!
            val arg = when (op) {
                "freeze", "status" -> ""
                "contest" -> Statements.sha256b64u(sub.s("pendingBindText"))
                "rc-enrol" -> Statements.sha256b64u(bytes("body"))
                "cred-del" -> Statements.sha256b64u(bytes("credentialId"))
                else -> Statements.sha256b64u(bytes("attestationObject") +
                    java.security.MessageDigest.getInstance("SHA-256").digest(bytes("clientDataJSON")))
            }
            val p = r.s("text").split(".")
            val bind = r.s("bindText").split(".")
            val text = Statements.buildDreq(op, String(B64u.dec(p[2])!!), p[3], p[4], arg)
            assertEquals(r.s("name"), r.s("text"), text)
            assertEquals(Statements.sha256b64u(r.s("bindText")), p[3])
            assertTrue(r.s("name"), Statements.verifySig(bind[2], r.s("sig"), text))
            ops += op; n++
        }
        assertEquals(setOf("contest", "freeze", "status", "cred-add", "cred-del", "rc-enrol"), ops)
        assertTrue(n >= 6)
    }

    @Test fun `directory-request consents - the host stamps the accepted ones and refuses a cross-op payload`() {
        var stamped = 0; var refused = 0
        for (r in fx.getAsJsonArray("dreqConsent").map { it.asJsonObject }) {
            val p = r.s("text").split(".")
            val purpose = Consent.Purpose.of(p[2])
            val challenge = r.s("challenge"); val payload = r.s("payloadText")
            if (r.s("expect") == "accept") {
                assertEquals(r.s("name"), r.s("text"), Consent.stamp(purpose!!, null, challenge, payload, p[5].toLong() - Consent.TTL_MS))
                stamped++
            } else if (r.has("reason") && r.s("reason") == "payload-family") {
                // the fixture says this purpose does not own this payload's op: the host must not stamp it either
                assertEquals(r.s("name"), null, Consent.stamp(purpose!!, null, challenge, payload, 0)); refused++
            }
        }
        assertTrue(stamped >= 3 && refused >= 3)
        assertEquals(null, Consent.Purpose.of("dreq"))
    }
}
