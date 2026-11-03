// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

package page.bento.home

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The host's identity calls (bento/connect B1) on a controlled clock and a real P-256 key.
 * This is the Android row of security's sign gate: idle and overall limits inside and past,
 * the purpose lock, an unverified document gets no agent, and controls that prove each
 * refusal is the rule's and not an accident (qa-home-android-identity-mutants.mjs breaks them).
 */
class IdentityHostTest {
    private val dev = SoftKeys.generate()
    private val acct = SoftKeys.generate()
    private val T0 = 1_800_000_000_000L
    private var clock = T0
    private var signed = 0
    private var managed = false
    private var lapse = false
    private val consent = DocConsentStore(null)
    private val FRAME = B64u.enc(ByteArray(12) { 1 }) + "." + B64u.enc(ByteArray(24) { 2 })
    private val PROVE = "prove." + B64u.enc(ByteArray(16) { 3 }) + ".w" + "A".repeat(43)
    private val OK = IdentityHost.Caller(genuine = true, doc = "doc-one")

    private fun record(): IdentitySetup.Record {
        val bind = Statements.buildBind(Statements.BindCert("ada@example.org", acct.pub, acct.pub, 1, null, T0 - 5, T0 + 99))
        val devText = Statements.buildDev(Statements.DeviceCert(dev.pub, null, acct.pub, acct.pub, T0, T0 + 99))
        return IdentitySetup.Record("ada@example.org", bind, "s", "a", "s", devText, "s", true)
    }

    private fun host(idleMs: Long = 3_600_000L, overallMs: Long = 86_400_000L, rec: IdentitySetup.Record? = record(),
                     grant: Boolean = true): IdentityHost {
        if (grant) consent.grant(OK.doc)
        return IdentityHost(
            record = { rec }, managed = { managed }, consent = consent,
            gate = RoutineGate(idleMs, overallMs),
            signRoutine = { m ->
                signed++
                if (lapse) throw IdentityHost.AuthLapsed()
                B64u.dec(Statements.sign(dev.scalar, String(m, Charsets.UTF_8)))!!
            },
            now = { clock })
    }

    private fun refused(o: IdentityHost.Out) = (o as? IdentityHost.Out.Refuse)?.word
    @Suppress("UNCHECKED_CAST") private fun ok(o: IdentityHost.Out) = (o as IdentityHost.Out.Ok).value!!

    // ---- an unverified document has no agent -------------------------------------------------

    @Test fun `a load that did not pass gate 1 gets nothing from any call`() {
        val h = host(); h.reauthenticated()
        val unknown = IdentityHost.Caller(genuine = false, doc = OK.doc)
        assertEquals("unavailable", refused(h.whoami(unknown)))
        assertEquals("unavailable", refused(h.sign(unknown, "frame", FRAME)))
        assertNull((h.resolve(unknown, acct.pub) as IdentityHost.Out.Ok).value)
        assertEquals("no signature was made", 0, signed)
        // control: the same host and document, verified, is served
        assertEquals("ada@example.org", ok(h.whoami(OK))["email"])
        assertTrue(h.sign(OK, "frame", FRAME) is IdentityHost.Out.Ok)
    }

    @Test fun `the bridge declares identity only for a genuine load on an unmanaged device`() {
        assertEquals(listOf("store", "seal", "identity"), IdentityHost.capabilities(genuine = true, managed = false))
        assertEquals(listOf("store", "seal"), IdentityHost.capabilities(genuine = false, managed = false))
        assertEquals(listOf("store", "seal"), IdentityHost.capabilities(genuine = true, managed = true))
        assertEquals(listOf("store", "seal"), IdentityHost.capabilities(genuine = false, managed = true))
    }

    @Test fun `a managed-configuration key stops every identity call, even for a granted genuine document`() {
        val h = host(); h.reauthenticated()
        managed = true
        assertEquals("unavailable", refused(h.whoami(OK)))
        assertEquals("unavailable", refused(h.sign(OK, "frame", FRAME)))
        assertNull((h.resolve(OK, acct.pub) as IdentityHost.Out.Ok).value)
        managed = false
        assertTrue("control: the key removed, it works again", h.sign(OK, "frame", FRAME) is IdentityHost.Out.Ok)
    }

    // ---- consent is per document -------------------------------------------------------------

    @Test fun `whoami asks first, a no is remembered for the session, and sign never runs without a yes`() {
        val h = host(grant = false); h.reauthenticated()
        assertTrue(h.whoami(OK) is IdentityHost.Out.NeedConsent)
        assertEquals("declined", refused(h.sign(OK, "frame", FRAME)))
        consent.decline(OK.doc)
        assertEquals("declined", refused(h.whoami(OK)))
        assertEquals("declined", refused(h.sign(OK, "frame", FRAME)))
        assertNull((h.resolve(OK, acct.pub) as IdentityHost.Out.Ok).value)
        assertEquals(0, signed)
        // another document is its own question
        assertTrue(h.whoami(IdentityHost.Caller(true, "doc-two")) is IdentityHost.Out.NeedConsent)
        consent.grant(OK.doc)
        assertEquals(dev.pub, ok(h.whoami(OK))["devicePub"])
    }

    @Test fun `whoami answers with the public identity and nothing secret`() {
        val w = ok(host().whoami(OK))
        assertEquals(setOf("name", "email", "vouchedBy", "accountPub", "devicePub"), w.keys)
        assertEquals("id.bento.page", w["vouchedBy"]); assertEquals(acct.pub, w["accountPub"]); assertEquals(dev.pub, w["devicePub"])
    }

    @Test fun `no account on this device is no-identity, not a guess`() {
        val h = host(rec = null)
        assertEquals("no-identity", refused(h.whoami(OK)))
        assertEquals("no-identity", refused(h.sign(OK, "frame", FRAME)))
    }

    // ---- sign: purpose lock ------------------------------------------------------------------

    @Test fun `a signature verifies under the device key for the exact payload`() {
        val h = host(); h.reauthenticated()
        for ((p, text) in listOf("frame" to FRAME, "prove" to PROVE)) {
            val r = ok(h.sign(OK, p, text))
            assertEquals(dev.pub, r["pub"])
            assertTrue(p, Statements.verifySig(dev.pub, r["sig"] as String, text))
            assertFalse("not the same signature for other bytes", Statements.verifySig(dev.pub, r["sig"] as String, text + "x"))
        }
    }

    @Test fun `the payload must have the shape the purpose names`() {
        val h = host(); h.reauthenticated()
        assertEquals("purpose", refused(h.sign(OK, "prove", FRAME)))
        assertEquals("purpose", refused(h.sign(OK, "frame", PROVE)))
        assertEquals("purpose", refused(h.sign(OK, "show", "anything")))
        assertEquals("purpose", refused(h.sign(OK, "own-everything", FRAME)))
        assertEquals("purpose", refused(h.sign(OK, "frame", "")))
        assertEquals("no signature was made for any of them", 0, signed)
        assertTrue("control: the right pair signs", h.sign(OK, "show", "live") is IdentityHost.Out.Ok)
    }

    @Test fun `invite and revoke need an owner key this agent does not hold`() {
        val h = host(); h.reauthenticated()
        val pub = B64u.enc(byteArrayOf(4) + ByteArray(64) { 7 })
        assertEquals("unavailable", refused(h.sign(OK, "invite", "inv.$pub.writer.1900000000000")))
        assertEquals("unavailable", refused(h.sign(OK, "revoke", "rev.$pub")))
        assertEquals(0, signed)
    }

    // ---- sign: the host's own session --------------------------------------------------------

    @Test fun `no session means reauth, and re-authenticating opens one`() {
        val h = host()
        assertEquals("reauth", refused(h.sign(OK, "frame", FRAME)))
        assertEquals(0, signed)
        h.reauthenticated()
        assertTrue(h.sign(OK, "frame", FRAME) is IdentityHost.Out.Ok)
    }

    @Test fun `idle limit 1 s - inside signs, at and past it refuses until re-authentication`() {
        val h = host(idleMs = 1000); h.reauthenticated()
        clock += 999
        assertTrue("999 ms idle is inside", h.sign(OK, "frame", FRAME) is IdentityHost.Out.Ok)
        clock += 999
        assertTrue("idle counts from the last use, not from authentication", h.sign(OK, "frame", FRAME) is IdentityHost.Out.Ok)
        clock += 1000
        assertEquals("reauth", refused(h.sign(OK, "frame", FRAME)))
        clock += 1
        assertEquals("a refusal is not a use: it does not reopen the session", "reauth", refused(h.sign(OK, "frame", FRAME)))
        clock += 5; h.reauthenticated()
        assertTrue(h.sign(OK, "frame", FRAME) is IdentityHost.Out.Ok)
    }

    @Test fun `overall limit - steady use is cut at the boundary, and only re-authentication reopens`() {
        val h = host(idleMs = 1000, overallMs = 5000); h.reauthenticated()
        for (i in 1..9) { clock += 500; assertTrue("t=${i * 500}", h.sign(OK, "frame", FRAME) is IdentityHost.Out.Ok) }
        clock += 500   // t = 5000: the overall period has elapsed although the session was never idle
        assertEquals("reauth", refused(h.sign(OK, "frame", FRAME)))
        clock += 1
        assertEquals("reauth", refused(h.sign(OK, "frame", FRAME)))
        h.reauthenticated()
        assertTrue(h.sign(OK, "frame", FRAME) is IdentityHost.Out.Ok)
    }

    @Test fun `the real limits are one hour idle and twenty-four hours overall`() {
        val h = host(); h.reauthenticated()
        clock += 3_599_999
        assertTrue(h.sign(OK, "frame", FRAME) is IdentityHost.Out.Ok)
        clock += 3_600_000
        assertEquals("reauth", refused(h.sign(OK, "frame", FRAME)))
        h.reauthenticated()
        repeat(47) { clock += 1_800_000; assertTrue(h.sign(OK, "frame", FRAME) is IdentityHost.Out.Ok) }
        clock += 1_800_000
        assertEquals("24 h after authenticating", "reauth", refused(h.sign(OK, "frame", FRAME)))
    }

    @Test fun `a clock that goes backwards fails closed`() {
        val h = host(); h.reauthenticated()
        clock -= 10_000
        assertEquals("reauth", refused(h.sign(OK, "frame", FRAME)))
    }

    @Test fun `the Keystore floor lapsing is reauth and locks the session`() {
        val h = host(); h.reauthenticated()
        lapse = true
        assertEquals("reauth", refused(h.sign(OK, "frame", FRAME)))
        lapse = false
        assertEquals("the app-side session was closed too", "reauth", refused(h.sign(OK, "frame", FRAME)))
        h.reauthenticated()
        assertTrue(h.sign(OK, "frame", FRAME) is IdentityHost.Out.Ok)
    }

    // ---- resolve -----------------------------------------------------------------------------

    @Test fun `resolve knows only keys already held and takes no address`() {
        val h = host()
        val me = ok(h.resolve(OK, acct.pub))
        assertEquals("ada@example.org", me["email"]); assertEquals(false, me["changed"]); assertEquals(T0 - 5, me["firstSeen"])
        assertEquals(acct.pub, ok(h.resolve(OK, dev.pub))["accountPub"])
        assertNull((h.resolve(OK, SoftKeys.generate().pub) as IdentityHost.Out.Ok).value)
        assertNull((h.resolve(OK, "ada@example.org") as IdentityHost.Out.Ok).value)
        assertEquals(0, signed)
    }

    // ---- records and consent files -----------------------------------------------------------

    @Test fun `a stored record reads back whole, and a partial one reads as none`() {
        val r = record()
        val back = parseRecord(r.serialize())!!
        assertEquals(r.address, back.address); assertEquals(r.bindText, back.bindText); assertEquals(r.devText, back.devText)
        assertNull(parseRecord(r.serialize().lines().filterNot { it.startsWith("dev\t") }.joinToString("\n")))
        assertNull(parseRecord(""))
    }

    @Test fun `a grant outlives the process and a decline does not`() {
        val f = java.io.File.createTempFile("consent", "").apply { delete(); deleteOnExit() }
        val a = DocConsentStore(f)
        a.grant("doc-one"); a.decline("doc-two"); a.grant("not valid!")
        val b = DocConsentStore(f)
        assertEquals(IdentityHost.State.GRANTED, b.state("doc-one"))
        assertEquals(IdentityHost.State.UNASKED, b.state("doc-two"))
        assertEquals("an id that is not a valid key is session-only", IdentityHost.State.UNASKED, b.state("not valid!"))
        assertEquals(IdentityHost.State.DECLINED, a.state("doc-two"))
        a.decline("doc-one")
        assertEquals("a decline this session beats a stored grant", IdentityHost.State.DECLINED, a.state("doc-one"))
    }
}
