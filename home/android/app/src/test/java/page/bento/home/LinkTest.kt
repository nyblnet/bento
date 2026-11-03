// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

package page.bento.home

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Link.kt and DisplayText against the `link` section (and `displayForbidden`) of
 * kernel/fixtures/identity-v1.json. Every row of codes, sessions, sas, sasMatch, roles, msgs,
 * reflected, msg2, offers, offerWire, msg3 and final is run; the counts are asserted so a row
 * silently skipped fails the build. The `release` rows are the DIRECTORY's verifier and are not
 * ported (see Link): this test says so by counting them rather than ignoring them.
 */
class LinkTest {
    private val fx: JsonObject = JsonParser.parseString(File("../../../kernel/fixtures/identity-v1.json").readText()).asJsonObject
    private val link get() = fx.getAsJsonObject("link")
    private val now = fx.get("now").asLong
    private fun rows(k: String) = link.getAsJsonArray(k).map { it.asJsonObject }
    private fun JsonObject.s(k: String) = get(k).asString
    private fun JsonObject.str(k: String): String? = get(k)?.takeIf { !it.isJsonNull }?.asString
    private fun hex(s: String) = Hex.bytes(s)
    private fun keysOf(r: JsonObject) = Link.Keys(hex(r.s("h2n")), hex(r.s("n2h")), ByteArray(32), "000000")
    private fun V(v: Link.V<*>) = if (v is Link.V.No) v.reason else "accept"
    private fun JsonObject.offerOf(): Link.Offer = getAsJsonObject("offer").let {
        Link.Offer(it.s("devicePub"), it.str("consentPub"), it.s("kx"), it.str("label"), it.s("platform"))
    }

    @Test fun `display table equals the fixture's and labels are filtered`() {
        val d = fx.getAsJsonObject("displayForbidden")
        assertEquals("17.0", d.s("unicode"))
        val want = d.getAsJsonArray("ranges").joinToString(",") { val a = it.asJsonArray; "%x-%x".format(a[0].asInt, a[1].asInt) }
        assertEquals(want, DisplayText.RANGES)
        assertEquals("Pixel 9", DisplayText.parse(B64u.enc("Pixel 9".toByteArray())))
        assertNull(DisplayText.parse(B64u.enc("a‮b".toByteArray())))      // bidi override
        assertNull(DisplayText.parse(B64u.enc("‍ab".toByteArray())))      // ZWJ at the start
        assertNull(DisplayText.parse(B64u.enc("é".toByteArray())))       // not NFC
        assertNull(DisplayText.parse(B64u.enc("x".repeat(65).toByteArray())))  // too long
        assertNull(DisplayText.parse(""))
    }

    @Test fun `codes derive the slot`() {
        val r = rows("codes"); assertTrue(r.size >= 3)
        for (c in r) {
            val code = hex(c.s("codeHex"))
            assertEquals(c.s("printed"), Link.formatCode(code))
            val p = Link.parseCode(c.s("printed")) as Recovery.Parsed.Ok
            assertArrayEquals(code, p.code)
            val s = Link.slot(code)
            assertEquals(c.s("id"), s.id); assertEquals(c.s("tok"), s.tok)
            assertEquals(c.s("saltHex"), Hex.str(s.salt)); assertEquals(c.s("tokHash"), Link.tokHash(s.tok))
        }
    }

    @Test fun `both honest sessions agree on every byte`() {
        val r = rows("sessions"); assertEquals(2, r.size)
        for (s in r) {
            val code = hex(s.s("codeHex")); val slot = Link.slot(code)
            val role = if (s.s("roleD") == "H") Link.Role.H else Link.Role.N
            assertEquals(s.s("msg0"), Link.buildMsg0(s.s("eD"), role)); assertEquals(s.s("msg1"), Link.buildMsg1(s.s("eS")))
            val m0 = Link.parseMsg0(s.s("msg0")) as Link.V.Ok; assertEquals(role, m0.value.roleD)
            assertEquals(s.s("eS"), (Link.parseMsg1(s.s("msg1")) as Link.V.Ok).value)
            val t = Link.transcript(slot.id, s.s("eD"), s.s("eS"), role); assertEquals(s.s("t"), t)
            assertEquals(s.s("zHex"), Hex.str(Link.sharedSecret(hex(s.s("eDScalarHex")), s.s("eS"))!!))
            assertEquals(s.s("zHex"), Hex.str(Link.sharedSecret(hex(s.s("eSScalarHex")), s.s("eD"))!!))
            for (k in listOf(Link.keys(hex(s.s("eDScalarHex")), s.s("eS"), slot.salt, t!!)!!, Link.keys(hex(s.s("eSScalarHex")), s.s("eD"), slot.salt, t)!!)) {
                assertEquals(s.s("h2n"), Hex.str(k.h2n)); assertEquals(s.s("n2h"), Hex.str(k.n2h))
                assertEquals(s.s("sasKeyHex"), Hex.str(k.sasKey)); assertEquals(s.s("sas"), k.sas)
            }
        }
    }

    @Test fun `sas digits and what a person may type`() {
        val a = rows("sas"); val b = rows("sasMatch"); assertTrue(a.size >= 6 && b.size >= 7)
        for (r in a) assertEquals(r.s("sas"), Link.sasDigits(hex(r.s("sasKeyHex"))))
        for (r in b) assertEquals(r.s("typed") + " vs " + r.s("sas"), r.get("match").asBoolean, Link.sasMatches(r.s("typed"), r.s("sas")))
    }

    @Test fun `roles are checked against the scanner's own state`() {
        val r = rows("roles"); assertEquals(4, r.size)
        for (x in r) assertEquals(x.s("note"), x.get("proceed").asBoolean,
            Link.scannerMayProceed(if (x.s("roleD") == "H") Link.Role.H else Link.Role.N, x.get("scannerHoldsAccount").asBoolean))
    }

    @Test fun `msg0 and msg1 grammar`() {
        val r = rows("msgs"); assertEquals(12, r.size)
        for (x in r) {
            val v = if (x.s("kind") == "msg0") Link.parseMsg0(x.s("msg")) else Link.parseMsg1(x.s("msg"))
            if (x.s("expect") == "accept") assertTrue(x.s("name"), v is Link.V.Ok)
            else assertEquals(x.s("name"), x.s("reason"), V(v))
        }
    }

    @Test fun `a reflected ephemeral gets no transcript`() {
        val r = link.getAsJsonObject("reflected")
        assertNull(Link.transcript(r.s("id"), r.s("eD"), r.s("eS"), Link.Role.H))
    }

    @Test fun `msg2 and msg3 seal to the exact vector`() {
        val m2 = link.getAsJsonObject("msg2"); val k2 = keysOf(m2)
        assertEquals(m2.s("aad"), Link.aad(m2.s("t"), 2))
        assertEquals(m2.s("wire"), Link.seal(k2, 2, m2.s("t"), hex(m2.s("ivHex")), m2.s("plaintext").toByteArray()))
        assertArrayEquals(m2.s("plaintext").toByteArray(), Link.open(k2, 2, m2.s("t"), m2.s("wire")))
        val m3 = link.getAsJsonObject("msg3"); val k3 = keysOf(m3)
        assertEquals(m3.s("aad"), Link.aad(m3.s("t"), 3))
        assertEquals(m3.s("sealed"), Link.seal(k3, 3, m3.s("t"), hex(m3.s("ivHex")), hex(m3.s("sealedPlaintextHex"))))
        assertArrayEquals(hex(m3.s("sealedPlaintextHex")), Link.open(k3, 3, m3.s("t"), m3.s("sealed")))
        // the msg3 text's last line is that sealed field
        assertEquals(m3.s("sealed"), m3.s("text").split('\n').last())
    }

    @Test fun `offers reach the stated verdict`() {
        val r = rows("offers"); assertEquals(17, r.size)
        var ok = 0; var no = 0
        for (x in r) {
            val v = Link.verifyOffer(x.s("text"), x.s("t"))
            if (x.s("expect") == "accept") { assertTrue(x.s("name"), v is Link.V.Ok); ok++ }
            else { assertEquals(x.s("name"), x.s("reason"), V(v)); no++ }
        }
        assertTrue(ok >= 2 && no >= 10)
    }

    @Test fun `an accepted offer carries what N wrote, and rebuilds`() {
        val x = rows("offers").first()
        val o = (Link.verifyOffer(x.s("text"), x.s("t")) as Link.V.Ok).value
        assertEquals("Pixel 9", o.label); assertEquals("android", o.platform)
        val p = x.s("text").split('.')
        assertEquals(x.s("text"), Link.buildOffer(o, p[6], p[7]))
    }

    @Test fun `msg2 under the wrong direction, number, transcript or bit fails to open`() {
        val r = rows("offerWire"); assertEquals(5, r.size)
        for (x in r) {
            val v = Link.openOffer(keysOf(x), x.s("t"), x.s("wire"))
            if (x.s("expect") == "accept") assertTrue(x.s("name"), v is Link.V.Ok) else assertEquals(x.s("name"), x.s("reason"), V(v))
        }
    }

    @Test fun `N's check of msg3 reaches the stated verdict, and looks the address up only when the fixture says it does`() {
        val r = rows("final"); assertEquals(43, r.size)
        val pins = link.getAsJsonObject("directoryKeys").entrySet().associate { it.key to it.value.asString }
        var ok = 0; var no = 0; var looked = 0; var notLooked = 0
        for (x in r) {
            var called = false
            val table = x.getAsJsonObject("lookup")
            val lookup = { address: String ->
                called = true
                table.getAsJsonObject(address)?.let { Link.Lookup(it.s("bindText"), it.s("bindSig"), it.s("attText"), it.s("attSig")) }
            }
            val v = Link.openFinal(x.s("text"), keysOf(x), x.s("t"), x.offerOf(), lookup, pins, x.get("now")?.asLong ?: now)
            assertEquals(x.s("name") + " lookupCalled", x.get("lookupCalled").asBoolean, called)
            if (called) looked++ else notLooked++
            if (x.s("expect") == "accept") {
                assertTrue(x.s("name") + " " + V(v), v is Link.V.Ok); ok++
                val o = (v as Link.V.Ok).value
                assertEquals(x.offerOf().devicePub, o.device.devicePub)
                assertEquals(x.s("address"), o.address)
                assertEquals(x.str("displayName"), o.name)
                assertEquals(32, o.account.size)
            } else { assertEquals(x.s("name"), x.s("reason"), V(v)); no++ }
        }
        assertEquals(3, ok); assertEquals(40, no)
        assertEquals(19, looked); assertEquals(24, notLooked)   // grammar/address/decrypt/dev refusals never reach the directory
    }

    @Test fun `H seals the account scalar and the address, and nothing else`() {
        val b = link.getAsJsonObject("bind"); val m3 = link.getAsJsonObject("msg3")
        assertEquals(m3.s("sealedPlaintextHex"), Hex.str(Link.sealedPlaintext(hex(b.s("accountScalarHex")), b.s("address"))))
        assertEquals(32 + b.s("address").length, hex(m3.s("sealedPlaintextHex")).size)
        for (bad in listOf("Alice@example.com", " alice@example.com", "alice@example.com\n", "a", "alice@EXAMPLE.com"))
            assertTrue(bad, runCatching { Link.sealedPlaintext(ByteArray(32) { 1 }, bad) }.isFailure)
        assertTrue(runCatching { Link.sealedPlaintext(ByteArray(64) { 1 }, "alice@example.com") }.isFailure)   // the old blob length
    }

    @Test fun `the slot wire is byte for byte the fixture's, both ways`() {
        val r = rows("wire"); assertEquals(30, r.size)
        var ok = 0; var no = 0
        for (x in r) {
            val n = x.get("n").asInt
            val decoded = Link.decodeSlotMsg(n, x.s("wire"))
            if (x.s("expect") == "accept") {
                assertEquals(x.s("name"), x.s("text"), decoded)
                assertEquals(x.s("name") + " (encode)", x.s("wire"), Link.encodeSlotMsg(n, x.s("text"))); ok++
            } else { assertNull(x.s("name"), decoded); no++ }
        }
        assertEquals(9, ok); assertEquals(21, no)
    }

    @Test fun `encodeSlotMsg refuses what no peer would decode`() {
        assertTrue(runCatching { Link.encodeSlotMsg(0, "lnk1.x") }.isFailure)
        assertTrue(runCatching { Link.encodeSlotMsg(3, "lnk3.x") }.isFailure)
        assertTrue(runCatching { Link.encodeSlotMsg(1, "lnk1." + "a".repeat(5000)) }.isFailure)
    }

    @Test fun `the release rows belong to the directory, and are all counted`() {
        assertEquals(32, rows("release").size)   // not ported: Link has no verifyLinkRelease
    }

    @Test fun `an unknown platform token is not shown as a known device`() {
        assertEquals("an Android device", Link.platformLabel("android"))
        assertNull(Link.platformLabel("beos")); assertNull(Link.platformLabel("android2")); assertNull(Link.platformLabel(""))
        assertFalse(Link.platformLabel("Android") != null)
    }
}
