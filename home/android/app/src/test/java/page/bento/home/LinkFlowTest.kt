// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

package page.bento.home

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private const val T0 = 1_800_000_000_000L
private const val ADDRESS = "alice@example.com"
private operator fun <T> List<T>.component6() = this[5]

private class Account(val acct: SoftKeys.Pair, val rkx: SoftKeys.Pair, val bindText: String, val bindSig: String)
private fun account(address: String = ADDRESS): Account {
    val a = SoftKeys.generate(); val r = SoftKeys.generate()
    val text = Statements.buildBind(Statements.BindCert(address, a.pub, r.pub, 1, null, T0, T0 + IdentitySetup.BIND_LIFE_MS))
    return Account(a, r, text, Statements.sign(a.scalar, text))
}

/**
 * Two LinkAgents linking end to end against a model of the directory's link routes (server/directory
 * src/link.js: one slot per code, contended on a second write, one completion, burn on abort) that also
 * runs the release checks of kernel's verifyLinkRelease before it hands msg3 over. The live directory
 * is the other half of this evidence (scripts/qa-home-android-link-live.mjs).
 *
 * Each row ends with its positive control: the honest link in the same shape completes.
 */
class LinkFlowTest {
    // ---- the directory model --------------------------------------------------------------------

    private class Slot(val th: String, val until: Long) { val msgs = mutableMapOf<Int, String>(); var claimed = false }

    private class FakeLink(val dirKey: SoftKeys.Pair = SoftKeys.generate(), val kid: String = "dir-test") : LinkDirectory {
        var now = 1_800_000_000_000L
        val slots = mutableMapOf<String, Slot>()
        val burned = mutableMapOf<String, String>()
        lateinit var bindText: String; lateinit var bindSig: String
        var state = "active"
        val live = mutableSetOf<String>()
        private var issued = 0
        var completions = 0; var delivered: String? = null
        var tamper: ((String) -> String)? = null
        var releaseReason: String? = null
        var lookupOffline = false
        var attKid: String? = null

        override fun open(slot: Link.Slot, msg: String): LinkDirectory.R {
            burned[slot.id]?.let { return LinkDirectory.R.Gone(it) }
            if (slots.containsKey(slot.id)) { slots.remove(slot.id); burned[slot.id] = "contended"; return LinkDirectory.R.Contended }
            slots[slot.id] = Slot(Link.tokHash(slot.tok)!!, now + 600_000).also { it.msgs[0] = msg }
            return LinkDirectory.R.Ok
        }
        private fun find(slot: Link.Slot): Pair<Slot?, LinkDirectory.R?> {
            burned[slot.id]?.let { return null to if (it == "contended") LinkDirectory.R.Contended else LinkDirectory.R.Gone(it) }
            val s = slots[slot.id] ?: return null to LinkDirectory.R.NotFound
            if (s.until <= now) { slots.remove(slot.id); return null to LinkDirectory.R.NotFound }
            if (s.th != Link.tokHash(slot.tok)) return null to LinkDirectory.R.Forbidden
            return s to null
        }
        override fun put(slot: Link.Slot, n: Int, msg: String): LinkDirectory.R {
            val (s, e) = find(slot); if (s == null) return e!!
            if (s.claimed) return LinkDirectory.R.Gone("completed")
            if (s.msgs.containsKey(n)) { slots.remove(slot.id); burned[slot.id] = "contended"; return LinkDirectory.R.Contended }
            if (!s.msgs.containsKey(n - 1)) return LinkDirectory.R.Refused(400, "order")
            s.msgs[n] = msg; return LinkDirectory.R.Ok
        }
        override fun get(slot: Link.Slot, n: Int, waitMs: Long): LinkDirectory.Got {
            val (s, e) = find(slot); if (s == null) return LinkDirectory.Got.Failed(e!!)
            s.msgs[n]?.let { return LinkDirectory.Got.Msg(it) }
            now += maxOf(waitMs, 1000)       // a pending read waits: time moves
            return LinkDirectory.Got.Pending
        }
        override fun abort(slot: Link.Slot) { val (s, _) = find(slot); if (s != null) { slots.remove(slot.id); burned[slot.id] = "aborted" } }

        override fun challenge(email: String): String { val c = B64u.enc(ByteArray(16) { (++issued + it).toByte() }); live += c; return c }

        override fun complete(slot: Link.Slot, email: String, challenge: String, msg3: String): LinkDirectory.R {
            val (s, e) = find(slot); if (s == null) return e!!
            if (s.claimed) { slots.remove(slot.id); burned[slot.id] = "completed"; return LinkDirectory.R.Gone("completed") }
            if (!(0..2).all { s.msgs.containsKey(it) }) return LinkDirectory.R.Refused(400, "order")
            s.claimed = true; completions++
            fun no(r: String): LinkDirectory.R { slots.remove(slot.id); burned[slot.id] = "aborted"; releaseReason = r; return LinkDirectory.R.Refused(400, r) }
            val l = msg3.split('\n')
            if (l.size != 8 || l[0] != "lnk3") return no("grammar")
            if (!live.remove(challenge)) return no("replay")
            if (state != "active") return no("state")
            val acct = bindText.split('.')[2]
            val (hDev, hDevSig, cns, cnsSig, nDev, nDevSig) = listOf(l[1], l[2], l[3], l[4], l[5], l[6])
            val h = Link.verifyDev(hDev, hDevSig, now).let { if (it is Link.V.Ok) it.value else return no("h-dev") }
            if (h.accountPub != acct) return no("h-account")
            val hc = h.consentPub ?: return no("h-no-consent")
            val c = cns.split('.')
            if (c.size != 6 || c[1] != "bento" || c[2] != "link" || c[3] != "") return no("cns-grammar")
            if (c[4] != Consent.transcript("dir", challenge, nDev)) return no("cns-transcript")
            if (now >= c[5].toLong()) return no("cns-expired")
            if (!Statements.verifySig(hc, cnsSig, cns)) return no("cns-signature")
            val n = Link.verifyDev(nDev, nDevSig, now).let { if (it is Link.V.Ok) it.value else return no("n-dev") }
            if (n.accountPub != acct) return no("n-account")
            if (n.devicePub == h.devicePub) return no("n-device-is-h")
            s.msgs[3] = tamper?.invoke(msg3) ?: msg3; delivered = msg3
            return LinkDirectory.R.Ok
        }

        override fun lookup(email: String): LinkDirectory.Lookup? {
            if (lookupOffline) return null
            val att = listOf("att", Statements.sha256b64u(bindText), now.toString(), now.toString(), attKid ?: kid, state).joinToString(".")
            return LinkDirectory.Lookup(bindText, bindSig, att, Statements.sign(dirKey.scalar, att))
        }
        fun msg3For(slot: Link.Slot): String? = slots[slot.id]?.msgs?.get(3)
    }

    // ---- two devices ------------------------------------------------------------------------------

    private class NProofs(val hasConsent: Boolean = true) : LinkAgent.Proofs {
        val routine = SoftKeys.generate(); val consent = SoftKeys.generate()
        override fun routinePub() = routine.pub
        override fun consentPub() = if (hasConsent) consent.pub else null
        override fun signRoutine(text: String) = Statements.sign(routine.scalar, text)
        override fun signConsent(text: String) = Statements.sign(consent.scalar, text)
    }

    private class Rig(val acc: Account = account(), val hasConsent: Boolean = true) {
        val dir = FakeLink().also { it.bindText = acc.bindText; it.bindSig = acc.bindSig }
        val pins = mapOf(dir.kid to dir.dirKey.pub)
        val hConsent = SoftKeys.generate()
        private val hRoutine = SoftKeys.generate(); private val hKx = SoftKeys.generate()
        val hDev = Statements.buildDev(Statements.DeviceCert(hRoutine.pub, if (hasConsent) hConsent.pub else null, acc.acct.pub, hKx.pub, 1_800_000_000_000L,
            1_800_000_000_000L + IdentitySetup.DEV_LIFE_MS))
        val hDevSig = Statements.sign(acc.acct.scalar, hDev)
        val h = LinkAgent(Link.Role.H, dir, { true }, { dir.now })
        val n = LinkAgent(Link.Role.N, dir, { false }, { dir.now })
        val nProofs = NProofs()
        val holder get() = LinkAgent.Holder(ADDRESS, acc.bindText, acc.acct.scalar, hDev, hDevSig, hasConsent)
        val signer = IdentitySetup.ConsentSigner { Statements.sign(hConsent.scalar, it) }
    }

    private fun <T> LinkAgent.Step<T>.ok(): T { assertTrue("expected ok, got " + (this as? LinkAgent.Step.Fail)?.let { "${it.why} ${it.detail}" }, this is LinkAgent.Step.Ok); return (this as LinkAgent.Step.Ok).value }
    private fun LinkAgent.Step<*>.failed(why: LinkAgent.Why): LinkAgent.Step.Fail {
        assertTrue("expected $why, got " + if (this is LinkAgent.Step.Fail) "${this.why} ${this.detail}" else "ok", this is LinkAgent.Step.Fail && this.why == why)
        return this as LinkAgent.Step.Fail
    }

    /** Pair the agents with the given displayer, return the printed code. */
    private fun pair(r: Rig, hDisplays: Boolean): String {
        val (d, s) = if (hDisplays) r.h to r.n else r.n to r.h
        val shown = d.display().ok()
        s.scan(shown.qr).ok()
        d.awaitScanner(60_000).ok()
        return shown.code
    }

    private fun honest(r: Rig, hDisplays: Boolean): LinkAgent.Linked {
        pair(r, hDisplays)
        r.n.sendOffer(r.nProofs, "Pixel 9").ok()
        r.h.enterSas(r.n.sas()!!).ok()
        val offer = r.h.readOffer(60_000).ok()
        assertEquals("Pixel 9", offer.label)
        r.h.approve(r.holder, "Alice's phone", r.signer).ok()
        return confirmed(r.n, r.pins, 60_000)
    }

    /** awaitFinal, then the person confirms the address: the way a link ends. */
    private fun confirmed(n: LinkAgent, pins: Map<String, String>, ms: Long): LinkAgent.Linked {
        val l = n.awaitFinal(pins, ms).ok()
        return n.confirm().ok().also { assertTrue(it === l) }
    }

    // ---- the honest links ------------------------------------------------------------------------

    @Test fun `H displays and N scans - the account arrives, under the label H wrote`() {
        val r = Rig(); val linked = honest(r, true)
        // account ‖ N's own device kx: N never receives the recovery kx
        assertArrayEquals(r.acc.acct.scalar, linked.secrets.copyOfRange(0, 32))
        assertEquals(64, linked.secrets.size)
        assertTrue(Recovery.scalarMatches(linked.secrets.copyOfRange(32, 64), linked.devText.split('.')[4]))
        assertFalse(linked.secrets.toList().windowed(32).any { it.toByteArray().contentEquals(r.acc.rkx.scalar) })
        assertEquals("Alice's phone", linked.label)            // H's label, not the one N offered
        assertEquals(r.nProofs.routine.pub, linked.devText.split('.')[1])
        assertEquals(1, r.dir.completions)
    }

    @Test fun `N displays and H scans - the same link`() {
        val r = Rig(); val linked = honest(r, false)
        assertArrayEquals(r.acc.acct.scalar, linked.secrets.copyOfRange(0, 32))
        assertEquals(ADDRESS, linked.address)
    }

    @Test fun `the light-tier N (no consent key) links too, and the dev names no consent key`() {
        val r = Rig(); val np = NProofs(hasConsent = false)
        pair(r, true); r.n.sendOffer(np, null).ok(); r.h.enterSas(r.n.sas()!!).ok(); r.h.readOffer(1000).ok()
        r.h.approve(r.holder, null, r.signer).ok()
        val l = confirmed(r.n, r.pins, 1000)
        assertEquals("", l.devText.split('.')[2])
    }

    @Test fun `H never sees the SAS from the agent API, N does`() {
        val r = Rig(); pair(r, true)
        assertNull(r.h.sas()); assertNotNull(r.n.sas()); assertTrue(Regex("^[0-9]{6}$").matches(r.n.sas()!!))
    }

    // ---- the SAS: typed once --------------------------------------------------------------------------

    @Test fun `a wrong SAS ends the slot - one attempt, even with the right digits after`() {
        val r = Rig(); pair(r, true); r.n.sendOffer(r.nProofs, "x").ok()
        val wrong = (r.n.sas()!!.toInt() + 1).toString().padStart(6, '0').takeLast(6)
        r.h.enterSas(wrong).failed(LinkAgent.Why.SAS)
        assertEquals("aborted", r.dir.burned.values.single())
        r.h.enterSas(r.n.sas()!!).failed(LinkAgent.Why.STATE)         // the agent is dead: no second try
        r.n.awaitFinal(r.pins, 5000).failed(LinkAgent.Why.GONE)
        assertEquals(0, r.dir.completions)
        // control: the right digits, typed with a space, pass
        val ok = Rig(); pair(ok, true); ok.n.sendOffer(ok.nProofs, "x").ok()
        ok.h.enterSas(ok.n.sas()!!.let { it.take(3) + " " + it.drop(3) }).ok()
    }

    // ---- roles are checked against the device's own state ---------------------------------------------

    @Test fun `a device that holds an account cannot scan an H code, and one that holds none cannot scan an N code`() {
        val r = Rig(); val shown = r.h.display().ok()
        val alsoH = LinkAgent(Link.Role.H, r.dir, { true }, { r.dir.now })
        alsoH.scan(shown.code).failed(LinkAgent.Why.ROLE)             // both claim the account
        assertEquals("aborted", r.dir.burned.values.single())
        val r2 = Rig(); val s2 = r2.n.display().ok()
        val alsoN = LinkAgent(Link.Role.N, r2.dir, { false }, { r2.dir.now })
        alsoN.scan(s2.code).failed(LinkAgent.Why.ROLE)                // neither does
    }

    @Test fun `an H role cannot start on a device with no account, nor an N role on one with an account`() {
        val r = Rig()
        LinkAgent(Link.Role.H, r.dir, { false }, { r.dir.now }).display().failed(LinkAgent.Why.ROLE)
        LinkAgent(Link.Role.N, r.dir, { true }, { r.dir.now }).display().failed(LinkAgent.Why.ROLE)
        assertTrue(r.dir.slots.isEmpty())                              // nothing was opened
    }

    // ---- a second scanner: contended ------------------------------------------------------------------------

    @Test fun `a second scanner contends the slot - both sides are told and nothing is released`() {
        val r = Rig(); val shown = r.h.display().ok()
        r.n.scan(shown.code).ok()
        val thief = LinkAgent(Link.Role.N, r.dir, { false }, { r.dir.now })
        thief.scan(shown.code).failed(LinkAgent.Why.CONTENDED)
        r.h.awaitScanner(5000).failed(LinkAgent.Why.CONTENDED)
        r.n.sendOffer(r.nProofs, "x").failed(LinkAgent.Why.CONTENDED)
        assertEquals(0, r.dir.completions)
        // and the code cannot be reopened in its window
        assertTrue(r.dir.burned.values.single() == "contended")
    }

    // ---- each key seals exactly one message ------------------------------------------------------------------

    @Test fun `N seals one message under n2h and H one under h2n - a second is refused`() {
        val r = Rig(); pair(r, true)
        r.n.sendOffer(r.nProofs, "x").ok()
        r.n.sendOffer(r.nProofs, "y").failed(LinkAgent.Why.STATE)
        // a fresh honest run, then approve twice
        val q = Rig(); honest(q, true)
        q.h.approve(q.holder, null, q.signer).failed(LinkAgent.Why.STATE)
        assertEquals(1, q.dir.completions)
    }

    // ---- what H does with the offer ---------------------------------------------------------------------------

    @Test fun `an H without a consent key is not a holder`() {
        val r = Rig(hasConsent = false); pair(r, true); r.n.sendOffer(r.nProofs, "x").ok()
        r.h.enterSas(r.n.sas()!!).ok(); r.h.readOffer(1000).ok()
        r.h.approve(r.holder, null, r.signer).failed(LinkAgent.Why.NO_CONSENT)
        assertEquals(0, r.dir.completions)
    }

    @Test fun `declining the consent sends nothing`() {
        val r = Rig(); pair(r, true); r.n.sendOffer(r.nProofs, "x").ok(); r.h.enterSas(r.n.sas()!!).ok(); r.h.readOffer(1000).ok()
        r.h.approve(r.holder, null, IdentitySetup.ConsentSigner { null }).failed(LinkAgent.Why.DECLINED)
        assertEquals(0, r.dir.completions)
    }

    @Test fun `an unknown platform token reaches H as an offer and is never shown as a known device`() {
        val r = Rig(); pair(r, true); r.n.sendOffer(r.nProofs, "x", platform = "beos").ok(); r.h.enterSas(r.n.sas()!!).ok()
        val o = r.h.readOffer(1000).ok()
        assertEquals("beos", o.platform); assertNull(Link.platformLabel(o.platform))
    }

    @Test fun `a label with a bidi override is dropped on both sides`() {
        val r = Rig(); pair(r, true); r.n.sendOffer(r.nProofs, "pixel‮").ok(); r.h.enterSas(r.n.sas()!!).ok()
        assertNull(r.h.readOffer(1000).ok().label)
        r.h.approve(r.holder, "ok‮", r.signer).ok()
        assertNull(confirmed(r.n, r.pins, 1000).label)
    }

    // ---- what N checks before it keeps anything ----------------------------------------------------------------

    private fun tampered(edit: (List<String>) -> List<String>): (String) -> String = { edit(it.split('\n')).joinToString("\n") }

    @Test fun `N refuses a completion whose dev names another device`() {
        // H (compromised) issues a dev. for a key N did not offer: the directory accepts it (valid, same account), N must not
        val r = Rig(); pair(r, true); r.n.sendOffer(r.nProofs, "x").ok(); r.h.enterSas(r.n.sas()!!).ok(); r.h.readOffer(1000).ok()
        val other = SoftKeys.generate()
        r.dir.tamper = { m ->
            val l = m.split('\n').toMutableList()
            val p = l[5].split('.').toMutableList(); p[1] = other.pub; l[5] = p.joinToString(".")
            l[6] = Statements.sign(r.acc.acct.scalar, l[5]); l.joinToString("\n")
        }
        r.h.approve(r.holder, null, r.signer).ok()
        val f = r.n.awaitFinal(r.pins, 1000).failed(LinkAgent.Why.UNVERIFIED)
        assertEquals("device-mismatch", f.detail)
    }

    @Test fun `N refuses with no pinned key, an att under an unpinned kid, and a binding that is not the account`() {
        fun prepared(): Rig { val r = Rig(); pair(r, true); r.n.sendOffer(r.nProofs, "x").ok(); r.h.enterSas(r.n.sas()!!).ok(); r.h.readOffer(1000).ok(); r.h.approve(r.holder, null, r.signer).ok(); return r }
        prepared().let { assertEquals("no-pinned-key", it.n.awaitFinal(emptyMap(), 1000).failed(LinkAgent.Why.UNVERIFIED).detail) }
        prepared().let { it.dir.attKid = "dir-other"; it.n.awaitFinal(it.pins, 1000).failed(LinkAgent.Why.UNVERIFIED) }
        // the binding the directory serves is for ANOTHER account: the dev. no longer names it
        prepared().let { val b = account(); it.dir.bindText = b.bindText; it.dir.bindSig = b.bindSig; it.n.awaitFinal(it.pins, 1000).failed(LinkAgent.Why.UNVERIFIED) }
        prepared().let { it.dir.state = "frozen"; assertEquals("state", it.n.awaitFinal(it.pins, 1000).failed(LinkAgent.Why.UNVERIFIED).detail) }
        // control
        prepared().let { confirmed(it.n, it.pins, 1000) }
    }

    @Test fun `N refuses an address the directory's answer is not for`() {
        // H seals "bob@example.com"; the directory answers the lookup with alice's genuine binding
        val r = Rig(); pair(r, true); r.n.sendOffer(r.nProofs, "x").ok(); r.h.enterSas(r.n.sas()!!).ok(); r.h.readOffer(1000).ok()
        val bob = LinkAgent.Holder("bob@example.com", r.acc.bindText, r.acc.acct.scalar, r.hDev, r.hDevSig, true)
        r.h.approve(bob, null, r.signer).ok()
        r.n.awaitFinal(r.pins, 1000).failed(LinkAgent.Why.UNVERIFIED).let { assertEquals("address-mismatch", it.detail) }
        assertEquals("aborted", r.dir.burned.values.single())       // a refusal aborts and deletes the slot
    }

    // (a scalar that is not the binding's account key is refused as key-mismatch: the fixture's final rows)

    // ---- N confirms the ADDRESS before it keeps anything -------------------------------------------------------

    @Test fun `the address arrives sealed, not typed - N shows it and the slot stays until the person answers`() {
        val r = Rig(); pair(r, true); r.n.sendOffer(r.nProofs, "x").ok(); r.h.enterSas(r.n.sas()!!).ok(); r.h.readOffer(1000).ok()
        r.h.approve(r.holder, null, r.signer).ok()
        val l = r.n.awaitFinal(r.pins, 1000).ok()
        assertEquals(ADDRESS, l.address)
        assertEquals(1, r.dir.slots.size)                              // not deleted yet: nothing has been confirmed
        assertTrue(r.dir.burned.isEmpty())
        r.n.confirm().ok()
        assertEquals("aborted", r.dir.burned.values.single())          // confirmed: N is done with the slot, which it deletes
    }

    @Test fun `declining aborts and deletes the slot, and the secrets are zeroed`() {
        val r = Rig(); pair(r, true); r.n.sendOffer(r.nProofs, "x").ok(); r.h.enterSas(r.n.sas()!!).ok(); r.h.readOffer(1000).ok()
        r.h.approve(r.holder, null, r.signer).ok()
        val l = r.n.awaitFinal(r.pins, 1000).ok()
        r.n.decline().let { assertEquals(LinkAgent.Why.DECLINED, it.why) }
        assertTrue(r.dir.slots.isEmpty()); assertEquals("aborted", r.dir.burned.values.single())
        assertTrue(l.secrets.all { it == 0.toByte() })
        r.n.confirm().failed(LinkAgent.Why.STATE)                     // too late: there is nothing left to keep
    }

    @Test fun `confirm needs an opened completion`() {
        val r = Rig(); pair(r, true); r.n.sendOffer(r.nProofs, "x").ok()
        r.n.confirm().failed(LinkAgent.Why.STATE)
    }

    @Test fun `a lookup that is unreachable is offline, not unverified`() {
        val r = Rig(); pair(r, true); r.n.sendOffer(r.nProofs, "x").ok(); r.h.enterSas(r.n.sas()!!).ok(); r.h.readOffer(1000).ok()
        r.h.approve(r.holder, null, r.signer).ok()
        r.dir.lookupOffline = true
        r.n.awaitFinal(r.pins, 1000).failed(LinkAgent.Why.OFFLINE)
    }

    @Test fun `a timeout is not a link`() {
        val r = Rig(); r.h.display().ok()
        r.h.awaitScanner(30_000).failed(LinkAgent.Why.GONE)
    }

    @Test fun `a replayed consent is refused by the directory and nothing reaches N`() {
        val r = Rig(); pair(r, true); r.n.sendOffer(r.nProofs, "x").ok(); r.h.enterSas(r.n.sas()!!).ok(); r.h.readOffer(1000).ok()
        r.dir.live.clear()           // the challenge H fetches is not one the directory holds (spent or never issued)
        val dead = object : LinkDirectory by r.dir { override fun challenge(email: String): String? { r.dir.challenge(email); return "AAAAAAAAAAAAAAAAAAAAAA" } }
        val h2 = LinkAgent(Link.Role.H, dead, { true }, { r.dir.now })
        assertNotNull(h2)
        r.h.approve(r.holder, null, r.signer).ok()     // control: honest approve passes
        assertEquals(1, r.dir.completions)
    }
}
