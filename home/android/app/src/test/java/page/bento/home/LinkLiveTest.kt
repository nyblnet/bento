// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

package page.bento.home

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/**
 * Two LinkAgents linking through the REAL directory worker (`wrangler dev` with LINKING=1), so the
 * release checks run are kernel's verifyLinkRelease itself, not a model of it. Skipped unless
 * BENTO_LINK_DIRECTORY is set; scripts/qa-home-android-link-live.mjs starts the worker and sets
 * BENTO_LINK_DIRECTORY, BENTO_LINK_MAILLOG (the worker's output, where the local mailer prints) and
 * BENTO_LINK_PIN ("kid=publicKey"). Rows: the honest link in both displayer shapes, a wrong SAS
 * (aborted, no second try), a second scanner (CONTENDED), and a replayed consent (the directory refuses
 * and releases nothing).
 */
class LinkLiveTest {
    private val url = System.getenv("BENTO_LINK_DIRECTORY")
    private val log = System.getenv("BENTO_LINK_MAILLOG")
    private val pins: Map<String, String> = System.getenv("BENTO_LINK_PIN")?.split('=', limit = 2)?.let { mapOf(it[0] to it[1]) } ?: emptyMap()
    private val dir by lazy { HttpLinkDirectory(url, allowDevHttp = true) }
    private val plain by lazy { HttpDirectory(url, allowDevHttp = true) }

    private class Holder(val address: String, val acct: SoftKeys.Pair, val rkx: SoftKeys.Pair, val bindText: String,
                          val consent: SoftKeys.Pair, val devText: String, val devSig: String)

    private fun mailedCode(address: String): String {
        repeat(50) {
            val m = File(log).readLines().filter { it.contains("\"devmail\"") && it.contains(address) }.lastOrNull()
            Regex("Your code: ([A-Z0-9]{8})").find(m ?: "")?.let { return it.groupValues[1] }
            Thread.sleep(200)
        }
        error("no mail for $address")
    }

    /** A real account on the live directory: bind + the mailed code, then H's own dev.  */
    private fun account(address: String): Holder {
        val acct = SoftKeys.generate(); val rkx = SoftKeys.generate(); val t = System.currentTimeMillis()
        val text = Statements.buildBind(Statements.BindCert(address, acct.pub, rkx.pub, 1, null, t, t + IdentitySetup.BIND_LIFE_MS))
        val sig = Statements.sign(acct.scalar, text)
        assertTrue(plain.bindStart(text, sig) is Directory.Started.Accepted)
        val code = mailedCode(address)
        val cmp = Statements.buildCmp(Statements.sha256b64u(text), code)!!
        val done = plain.bindComplete(address, code, Statements.sign(acct.scalar, cmp))
        assertTrue("bind complete", done is Directory.Complete.Ok)
        val consent = SoftKeys.generate(); val routine = SoftKeys.generate(); val kx = SoftKeys.generate()
        val dev = Statements.buildDev(Statements.DeviceCert(routine.pub, consent.pub, acct.pub, kx.pub, t, t + IdentitySetup.DEV_LIFE_MS))
        return Holder(address, acct, rkx, text, consent, dev, Statements.sign(acct.scalar, dev))
    }

    private class NProofs : LinkAgent.Proofs {
        val routine = SoftKeys.generate(); val consent = SoftKeys.generate()
        override fun routinePub() = routine.pub
        override fun consentPub() = consent.pub
        override fun signRoutine(text: String) = Statements.sign(routine.scalar, text)
        override fun signConsent(text: String) = Statements.sign(consent.scalar, text)
    }
    private fun h() = LinkAgent(Link.Role.H, dir, { true })
    private fun n() = LinkAgent(Link.Role.N, dir, { false })
    private fun <T> LinkAgent.Step<T>.ok(): T { assertTrue("got " + (this as? LinkAgent.Step.Fail)?.let { "${it.why} ${it.detail}" }, this is LinkAgent.Step.Ok); return (this as LinkAgent.Step.Ok).value }
    private fun LinkAgent.Step<*>.failed(w: LinkAgent.Why) { assertTrue("expected $w, got " + if (this is LinkAgent.Step.Fail) "${this.why} ${this.detail}" else "ok", this is LinkAgent.Step.Fail && this.why == w) }
    private fun holder(a: Holder) = LinkAgent.Holder(a.address, a.bindText, a.acct.scalar, a.rkx.scalar, a.devText, a.devSig, true)
    private fun signer(a: Holder) = IdentitySetup.ConsentSigner { Statements.sign(a.consent.scalar, it) }

    private fun pair(hA: LinkAgent, nA: LinkAgent, hDisplays: Boolean) {
        val (d, s) = if (hDisplays) hA to nA else nA to hA
        s.scan(d.display().ok().qr).ok(); d.awaitScanner(20_000).ok()
    }

    @Test fun `live directory - honest links, wrong SAS, a second scanner, a replayed consent`() {
        assumeTrue("BENTO_LINK_DIRECTORY not set", url != null && log != null && pins.isNotEmpty())
        for (displays in listOf(true, false)) {
            val a = account("live-${if (displays) "h" else "n"}-${System.nanoTime()}@example.com")
            val hA = h(); val nA = n(); pair(hA, nA, displays)
            nA.sendOffer(NProofs(), "Pixel 9").ok(); hA.enterSas(nA.sas()!!).ok(); hA.readOffer(20_000).ok()
            hA.approve(holder(a), "Alice's phone", signer(a)).ok()
            val l = nA.awaitFinal(a.address, pins, 20_000).ok()
            assertArrayEquals(a.acct.scalar + a.rkx.scalar, l.secrets.copyOfRange(0, 64))
            assertEquals("Alice's phone", l.label)
        }
        val a = account("live-sas-${System.nanoTime()}@example.com")
        run { // wrong SAS: aborted, and the right digits afterwards do nothing
            val hA = h(); val nA = n(); pair(hA, nA, true); nA.sendOffer(NProofs(), "x").ok()
            hA.enterSas((nA.sas()!!.toInt() + 1).toString().padStart(6, '0').takeLast(6)).failed(LinkAgent.Why.SAS)
            hA.enterSas(nA.sas()!!).failed(LinkAgent.Why.STATE)
            nA.awaitFinal(a.address, pins, 5_000).failed(LinkAgent.Why.GONE)
        }
        run { // a second scanner
            val hA = h(); val nA = n(); val shown = hA.display().ok(); nA.scan(shown.code).ok()
            n().scan(shown.code).failed(LinkAgent.Why.CONTENDED)
            hA.awaitScanner(5_000).failed(LinkAgent.Why.CONTENDED)
            nA.sendOffer(NProofs(), "x").failed(LinkAgent.Why.CONTENDED)
        }
        run { // a replayed challenge: H's complete uses a challenge it already spent
            val hA = h(); val nA = n(); pair(hA, nA, true); nA.sendOffer(NProofs(), "x").ok(); hA.enterSas(nA.sas()!!).ok(); hA.readOffer(20_000).ok()
            val stale = plain.challenge(a.address)!!
            val spent = object : LinkDirectory by dir { override fun challenge(email: String) = stale }
            // spend it once on a throwaway slot so the second use is a replay
            val h2 = LinkAgent(Link.Role.H, spent, { true }); val n2 = n(); pair(h2, n2, true)
            n2.sendOffer(NProofs(), "x").ok(); h2.enterSas(n2.sas()!!).ok(); h2.readOffer(20_000).ok()
            h2.approve(holder(a), null, signer(a)).ok()
            val h3 = LinkAgent(Link.Role.H, spent, { true }); val n3 = n(); pair(h3, n3, true)
            n3.sendOffer(NProofs(), "x").ok(); h3.enterSas(n3.sas()!!).ok(); h3.readOffer(20_000).ok()
            h3.approve(holder(a), null, signer(a)).failed(LinkAgent.Why.REFUSED)
            n3.awaitFinal(a.address, pins, 5_000).failed(LinkAgent.Why.GONE)
            hA.abandon(); nA.abandon()
        }
    }
}
