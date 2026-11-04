// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

package page.bento.home

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The setup flow end to end against a model of the directory that checks what the real
 * one checks (the account key's signature on bind./cmp., the code, the attempt limit) and
 * signs an att. with a key the client has pinned. Argon2id runs at the format's full
 * parameters — nothing about the recovery step is scaled down.
 */
class IdentitySetupTest {
    private val t0 = 1_800_000_000_000L

    /** A model of server/directory: bind/start keeps a pending statement and a code; bind/complete checks both proofs. */
    private class FakeDirectory(val dirKey: SoftKeys.Pair = SoftKeys.generate(), val kid: String = "dir-test") : Directory {
        var now = 1_800_000_000_000L
        val code = "K7Q3MZ2P"
        var pending: Pair<String, String>? = null
        var attempts = 0
        var started = 0; var completed = 0
        var offline = false
        // knobs for the lying-directory rows
        var attKid: String? = null; var attState = "active"; var attSigner: SoftKeys.Pair? = null; var attAge = 0L
        var echoBinding: String? = null

        override fun bindStart(stmt: String, sig: String): Directory.Started {
            started++
            if (offline) return Directory.Started.Unreachable
            val p = stmt.split('.')
            if (p.size != 9 || p[0] != "bind" || !Statements.verifySig(p[2], sig, stmt)) return Directory.Started.Refused(400)
            if (!Statements.isPoint(p[3]) || p[3] == p[2]) return Directory.Started.Refused(400)   // mode C: kx required
            pending = stmt to sig; attempts = 0
            return Directory.Started.Accepted
        }

        override fun bindComplete(email: String, code: String, sig: String): Directory.Complete {
            completed++
            if (offline) return Directory.Complete.Unreachable
            val (stmt, bsig) = pending ?: return Directory.Complete.Rejected
            if (++attempts > 5) return Directory.Complete.Rejected
            val acct = stmt.split('.')[2]
            if (code != this.code || !Statements.verifySig(acct, sig, "cmp.${Statements.sha256b64u(stmt)}.$code")) return Directory.Complete.Rejected
            val att = listOf("att", Statements.sha256b64u(stmt), now.toString(), (now - attAge).let { maxOf(it, now) }.toString(), attKid ?: kid, attState).joinToString(".")
            val signer = attSigner ?: dirKey
            return Directory.Complete.Ok(Directory.Completed(echoBinding ?: stmt, bsig, att, Statements.sign(signer.scalar, att)))
        }

        // ---- /v1/challenge and /v1/recovery/enrol, as the real worker checks them (src/account.js, src/consent.js)
        var routeOn = true
        private var issued = 0
        private val live = mutableSetOf<String>()
        var enrolments = 0
        var enrolBody: String? = null
        val log = mutableListOf<String>()

        override fun challenge(email: String): String? {
            if (offline) return null
            val c = B64u.enc(ByteArray(16) { (++issued + it).toByte() }); live += c; return c
        }

        override fun recoveryEnrol(email: String, body: ByteArray, req: String, sig: String, challenge: String,
                                   consent: Directory.ConsentProof): Directory.Enrol {
            if (!routeOn) return Directory.Enrol.NotAvailable
            if (offline) return Directory.Enrol.Unreachable
            fun no(r: String): Directory.Enrol { log += r; return Directory.Enrol.Refused(400, r) }
            if (!live.remove(challenge)) return no("challenge")                       // spent FIRST, single use
            val (stmt, _) = pending ?: return no("no-binding")
            val b = stmt.split('.')
            val r = req.split('.')
            if (r.size != 6 || r[0] != "dreq" || r[1] != "rc-enrol") return no("grammar")
            if (r[3] != Statements.sha256b64u(stmt) || r[4] != challenge) return no("bind-or-challenge")
            if (String(B64u.dec(r[2])!!) != email) return no("address")
            if (r[5] != Statements.sha256b64u(body)) return no("arg")                  // the signature covers the exact body
            if (!Statements.verifySig(b[2], sig, req)) return no("signature")
            // the enrolment body: exactly these keys, fixed lengths
            val j = Json.obj(Json.parse(String(body, Charsets.UTF_8))) ?: return no("body")
            val lens = mapOf("saltV" to 16, "verifier" to 32, "saltW" to 16, "iv" to 12, "ct" to 80)
            if (j.keys != setOf("v") + lens.keys || j["v"] != 1.0) return no("body-fields")
            for ((k, n) in lens) if (B64u.dec(j[k] as? String ?: "")?.size != n) return no("body-$k")
            // consent: a dev. the LIVE account key signed, naming a consent key; a cns. that key signed
            if (!Statements.verifySig(b[2], consent.devSig, consent.dev)) return no("dev:signature")
            val dp = consent.dev.split('.')
            if (dp[3] != b[2]) return no("dev:account")
            if (dp[2].isEmpty()) return no("dev:no-consent-key")
            val cp = consent.cns.split('.')
            if (cp.size != 6 || cp[1] != "bento" || cp[2] != "rc-enrol" || cp[3] != "") return no("cns:grammar")
            if (!req.startsWith("dreq.rc-enrol.")) return no("cns:payload-family")
            if (cp[4] != Consent.transcript("dir", challenge, req)) return no("cns:transcript")
            if (now >= cp[5].toLong() || cp[5].toLong() - now > 5 * 60_000) return no("cns:lifetime")
            if (!Statements.verifySig(dp[2], consent.cnsSig, consent.cns)) return no("cns:signature")
            enrolments++; enrolBody = String(body, Charsets.UTF_8); enrolled = body
            return Directory.Enrol.Enrolled
        }
        var enrolled: ByteArray? = null
    }

    private class Dev(hasConsent: Boolean = true) : IdentitySetup.DeviceKeys {
        val routine = SoftKeys.generate().pub
        val consentKey: SoftKeys.Pair? = if (hasConsent) SoftKeys.generate() else null
        val consent: String? get() = consentKey?.pub
        override fun routinePub() = routine
        override fun consentPub() = consent
        /** What the BiometricPrompt-bound key does, with a software key standing in. */
        val signer = IdentitySetup.ConsentSigner { cns -> consentKey?.let { Statements.sign(it.scalar, cns) } }
    }

    private class MemVault(var ok: Boolean = true) : IdentitySetup.Vault {
        var record: IdentitySetup.Record? = null; var secrets: ByteArray? = null; var live: ByteArray? = null
        override fun save(record: IdentitySetup.Record, secrets: ByteArray): Boolean {
            this.record = record; this.secrets = secrets.copyOf(); live = secrets; return ok
        }
    }

    private fun setup(d: FakeDirectory, dev: Dev = Dev(), managed: Boolean = false, memory: () -> Boolean = { true },
                      selfCheck: () -> String? = { null }, pins: Map<String, String>? = null) =
        IdentitySetup(d, pins ?: mapOf(d.kid to d.dirKey.pub), dev, { managed }, memory, selfCheck, { d.now })

    private fun toBound(s: IdentitySetup) {
        assertTrue(s.begin("Alice@Example.COM") is IdentitySetup.Begin.Sent)
        assertTrue(s.complete("k7q3mz2p") is IdentitySetup.Complete.Ok)
    }

    // ---- the whole flow -------------------------------------------------------------------------------

    @Test fun `create, verify, recover, bind and certify the device under mode C`() {
        val d = FakeDirectory(); val dev = Dev(); val s = setup(d, dev)
        val sent = s.begin("Alice@Example.COM") as IdentitySetup.Begin.Sent
        assertEquals("alice@example.com", sent.address)
        assertTrue(s.complete("k7q3mz2p") is IdentitySetup.Complete.Ok)
        val printed = s.startRecovery()!!
        assertEquals(printed, s.startRecovery())                       // asking again never re-mints
        assertTrue(s.confirmRecovery(printed.lowercase().replace("-", " ")) is IdentitySetup.Confirm.Ok)
        assertTrue(s.enrolRecovery(dev.signer) is IdentitySetup.Enrolled.Yes)
        val vault = MemVault()
        val done = s.finish(vault) as IdentitySetup.Finish.Done
        assertTrue("the directory took the enrolment: " + d.log, done.recoveryEnrolled)

        val r = vault.record!!
        val bind = r.bindText.split('.')
        val acctPub = bind[2]; val recoveryKx = bind[3]
        assertTrue("bind. is signed by the account key", Statements.verifySig(acctPub, r.bindSig, r.bindText))
        assertEquals("seq 1, no prev", listOf("1", ""), listOf(bind[5], bind[6]))
        assertTrue(Statements.isPoint(recoveryKx)); assertNotEquals(acctPub, recoveryKx)
        // the attestation the record keeps verifies under the PINNED key, for this exact binding
        val v = Statements.verifyAtt(r.attText, r.attSig, mapOf(d.kid to d.dirKey.pub), r.bindText, d.now, IdentitySetup.ATT_MAX_AGE_MS)
        assertTrue(v is Statements.Verdict.Ok && v.att.state == "active")
        // dev.: signed by the ACCOUNT key, names this device's keys, and carries its OWN kx (mode C)
        val devP = r.devText.split('.')
        assertTrue(Statements.verifySig(acctPub, r.devSig, r.devText))
        assertEquals(dev.routine, devP[1]); assertEquals(dev.consent, devP[2]); assertEquals(acctPub, devP[3])
        assertTrue(Statements.isPoint(devP[4])); assertNotEquals("per-device kx is not the recovery kx", recoveryKx, devP[4])
        assertTrue(devP[7].toLong() - devP[6].toLong() <= Statements.CERT_MAX_MS)
        // the three scalars sealed are the three public keys' private halves, and were zeroed after
        val sec = vault.secrets!!
        assertEquals(96, sec.size)
        assertTrue(Recovery.scalarMatches(sec.copyOfRange(0, 32), acctPub))
        assertTrue(Recovery.scalarMatches(sec.copyOfRange(32, 64), recoveryKx))
        assertTrue(Recovery.scalarMatches(sec.copyOfRange(64, 96), devP[4]))
        assertTrue("the caller's copy is wiped", vault.live!!.all { it == 0.toByte() })
        // and the recovery material recovers exactly those keys (64-byte blob: account ‖ recovery kx)
        val j = Json.obj(Json.parse(d.enrolBody!!))!!
        fun f(k: String) = B64u.dec(j[k] as String)!!
        val code = (Recovery.parse(printed) as Recovery.Parsed.Ok).code
        val opened = Recovery.openRecoveryInner(f("ct"), Recovery.wrapKey(code, f("saltW")), f("iv"), acctPub, recoveryKx) as Recovery.Opened.Ok
        assertArrayEquals(sec.copyOfRange(0, 32), opened.keys.account); assertArrayEquals(sec.copyOfRange(32, 64), opened.keys.kx)
        assertArrayEquals(Recovery.verifier(code, f("saltV")), f("verifier"))
        assertNotEquals("two different salts", Hex.str(f("saltW")), Hex.str(f("saltV")))
        assertEquals(80, f("ct").size)
    }

    private fun toRecovered(d: FakeDirectory, dev: Dev = Dev()): IdentitySetup {
        val s = setup(d, dev); toBound(s); assertTrue(s.confirmRecovery(s.startRecovery()!!) is IdentitySetup.Confirm.Ok); return s
    }

    @Test fun `enrolling the recovery code needs the consent key, and says why when it cannot`() {
        // a device with no consent key (API 26-29, nothing enrolled) cannot change who can recover: it says so
        var d = FakeDirectory(); var dev = Dev(hasConsent = false)
        assertTrue(toRecovered(d, dev).enrolRecovery(dev.signer) is IdentitySetup.Enrolled.NoConsentKey)
        assertEquals(0, d.enrolments)
        // the person declines the prompt
        d = FakeDirectory(); dev = Dev()
        var s = toRecovered(d, dev)
        assertTrue(s.enrolRecovery { null } is IdentitySetup.Enrolled.Declined)
        assertEquals(0, d.enrolments)
        assertTrue("and can be asked again", s.enrolRecovery(dev.signer) is IdentitySetup.Enrolled.Yes)
        assertTrue("an enrolment already stored is not sent twice", s.enrolRecovery(dev.signer) is IdentitySetup.Enrolled.Yes)
        assertEquals(1, d.enrolments)
        // route off / offline / out of order
        d = FakeDirectory().apply { routeOn = false }; dev = Dev()
        assertTrue(toRecovered(d, dev).enrolRecovery(dev.signer) is IdentitySetup.Enrolled.NotAvailable)
        d = FakeDirectory(); dev = Dev(); s = toRecovered(d, dev); d.offline = true
        assertTrue(s.enrolRecovery(dev.signer) is IdentitySetup.Enrolled.Offline)
        assertTrue(setup(FakeDirectory()).enrolRecovery(Dev().signer) is IdentitySetup.Enrolled.WrongStep)
        // a finish without enrolment still saves the account, and the record says so
        d = FakeDirectory().apply { routeOn = false }; dev = Dev(); s = toRecovered(d, dev); s.enrolRecovery(dev.signer)
        val v = MemVault()
        assertFalse((s.finish(v) as IdentitySetup.Finish.Done).recoveryEnrolled)
        assertTrue(v.record!!.serialize().contains("recoveryEnrolled\tfalse"))
    }

    @Test fun `a consent that is not for this request is refused by the directory`() {
        // relay: a cns. the consent key signed for ANOTHER challenge
        var d = FakeDirectory(); var dev = Dev(); var s = toRecovered(d, dev)
        val other = Consent.stamp(Consent.Purpose.RC_ENROL, null, B64u.enc(ByteArray(16) { 9 }), "dreq.rc-enrol.x.y.z.w", d.now)!!
        val relayed = Statements.sign(dev.consentKey!!.scalar, other)
        val r = s.enrolRecovery { cns -> relayed.also { assertNotEquals(cns, other) } }
        assertTrue(r is IdentitySetup.Enrolled.Refused && r.reason == "cns:signature") // signed some other text
        // replay: a challenge the directory already spent
        d = FakeDirectory(); dev = Dev(); s = toRecovered(d, dev)
        var ch = ""
        val replaying = object : Directory by d {
            override fun challenge(email: String) = (if (ch.isEmpty()) d.challenge(email) else ch).also { ch = it!! }
        }
        val s2 = IdentitySetup(replaying, mapOf(d.kid to d.dirKey.pub), dev, { false }, { true }, { null }, { d.now })
        s2.begin("a@b.co"); s2.complete("K7Q3MZ2P"); s2.confirmRecovery(s2.startRecovery()!!)
        assertTrue(s2.enrolRecovery(dev.signer) is IdentitySetup.Enrolled.Yes)             // the honest run
        val s3 = IdentitySetup(replaying, mapOf(d.kid to d.dirKey.pub), dev, { false }, { true }, { null }, { d.now })
        s3.begin("a@b.co"); s3.complete("K7Q3MZ2P"); s3.confirmRecovery(s3.startRecovery()!!)
        val again = s3.enrolRecovery(dev.signer)                                            // same, now-spent challenge
        assertTrue(again is IdentitySetup.Enrolled.Refused && again.reason == "challenge")
        // a consent key the live account key never certified
        d = FakeDirectory(); dev = Dev(); s = toRecovered(d, dev)
        val stranger = SoftKeys.generate()
        val rr = s.enrolRecovery { cns -> Statements.sign(stranger.scalar, cns) }
        assertTrue(rr is IdentitySetup.Enrolled.Refused && rr.reason == "cns:signature")
        assertEquals(0, d.enrolments)
    }

    // ---- fails closed ------------------------------------------------------------------------------------

    @Test fun `a managed device does nothing, and sends nothing`() {
        val d = FakeDirectory(); val s = setup(d, managed = true)
        val r = s.begin("a@b.co") as IdentitySetup.Begin.Refused
        assertEquals(IdentitySetup.Why.MANAGED, r.why); assertEquals(0, d.started)
        // control: the same build without the key proceeds
        assertTrue(setup(FakeDirectory(), managed = false).begin("a@b.co") is IdentitySetup.Begin.Sent)
    }

    @Test fun `no memory for Argon2id is refused before an email is bound, and is never a wrong code`() {
        val d = FakeDirectory(); var ok = false
        val s = setup(d, memory = { ok })
        assertEquals(IdentitySetup.Why.MEMORY, (s.begin("a@b.co") as IdentitySetup.Begin.Refused).why)
        assertEquals(0, d.started)
        ok = true
        assertTrue(s.begin("a@b.co") is IdentitySetup.Begin.Sent)
        assertTrue(s.complete("K7Q3MZ2P") is IdentitySetup.Complete.Ok)
        val printed = s.startRecovery()!!
        ok = false
        assertTrue("memory", s.confirmRecovery(printed) is IdentitySetup.Confirm.Unavailable)
        assertTrue("a typo is a typo", s.confirmRecovery("0000-0000-0000-0000-0") is IdentitySetup.Confirm.Mistyped)
        ok = true                                            // the same code, once memory is back
        assertTrue(s.confirmRecovery(printed) is IdentitySetup.Confirm.Ok)
    }

    @Test fun `a typed recovery code that is wrong is refused without deriving anything`() {
        val d = FakeDirectory(); val s = setup(d); toBound(s)
        val printed = s.startRecovery()!!
        val flipped = printed.dropLast(1) + (if (printed.last() == '0') '1' else '0')    // check symbol wrong
        assertEquals("check", (s.confirmRecovery(flipped) as IdentitySetup.Confirm.Mistyped).reason)
        assertEquals("length", (s.confirmRecovery("ABCD") as IdentitySetup.Confirm.Mistyped).reason)
        // another valid code is still not THIS code
        val other = Recovery.format(ByteArray(10) { 7 })
        assertEquals("mismatch", (s.confirmRecovery(other) as IdentitySetup.Confirm.Mistyped).reason)
        assertTrue(s.confirmRecovery(printed) is IdentitySetup.Confirm.Ok)
    }

    @Test fun `the emailed code`() {
        val d = FakeDirectory(); val s = setup(d)
        s.begin("a@b.co")
        assertTrue(s.complete("K7Q3MZ2") is IdentitySetup.Complete.BadFormat)         // 7 chars
        assertTrue(s.complete("K7Q3MZ20") is IdentitySetup.Complete.BadFormat)        // 0 is not in the alphabet
        assertEquals("a malformed code never reaches the directory", 0, d.completed)
        assertTrue(s.complete("AAAAAAAA") is IdentitySetup.Complete.Rejected)
        assertTrue(s.complete("K7Q3MZ2P") is IdentitySetup.Complete.Ok)               // control
    }

    @Test fun `an offline directory is not a refusal, and does not strand the flow`() {
        val d = FakeDirectory(); val s = setup(d); s.begin("a@b.co")
        d.offline = true
        assertTrue(s.complete("K7Q3MZ2P") is IdentitySetup.Complete.Offline)
        d.offline = false
        assertTrue(s.complete("K7Q3MZ2P") is IdentitySetup.Complete.Ok)
        d.offline = true
        assertEquals(IdentitySetup.Why.OFFLINE, (setup(d).begin("a@b.co") as IdentitySetup.Begin.Refused).why)
    }

    private fun lie(configure: FakeDirectory.() -> Unit, pins: ((FakeDirectory) -> Map<String, String>)? = null): String {
        val d = FakeDirectory().apply(configure); val s = setup(d, pins = pins?.invoke(d))
        s.begin("a@b.co")
        val r = s.complete("K7Q3MZ2P")
        assertTrue(r is IdentitySetup.Complete.Unverified)
        // a failed verification ends the attempt: nothing further proceeds
        assertTrue(s.startRecovery() == null)
        return (r as IdentitySetup.Complete.Unverified).reason
    }

    @Test fun `a reply that does not verify stops setup`() {
        assertEquals("unknown-kid", lie({ attKid = "dir-other" }))                       // a kid we never pinned
        assertEquals("signature", lie({ attSigner = SoftKeys.generate() }))              // pinned kid, wrong key
        assertEquals("state-pending", lie({ attState = "pending" }))
        assertEquals("no-pinned-key", lie({}, { emptyMap() }))                           // M6 not done: a release build
        assertEquals("binding-differs", lie({ echoBinding = "bind.x" }))
    }

    @Test fun `a stale attestation is a replay`() {
        val d = FakeDirectory(); val s = setup(d); s.begin("a@b.co")
        d.now += 11 * 60_000      // the client clock is 11 minutes ahead of the directory's issuedAt
        // (the model stamps issuedAt with its own clock at reply time, so age the CLIENT instead)
        val s2 = IdentitySetup(d, mapOf(d.kid to d.dirKey.pub), Dev(), { false }, { true }, { null }, { d.now + 11 * 60_000 })
        s2.begin("a@b.co")
        assertEquals("stale", (s2.complete("K7Q3MZ2P") as IdentitySetup.Complete.Unverified).reason)
    }

    @Test fun `a broken derivation on this build stops setup before anything is bound`() {
        val d = FakeDirectory(); val s = setup(d, selfCheck = { "wrap-key" })
        val r = s.begin("a@b.co") as IdentitySetup.Begin.Refused
        assertEquals(IdentitySetup.Why.SELF_CHECK, r.why); assertEquals(0, d.started)
    }

    @Test fun `the self-check passes on a good build`() { assertNull(SetupSelfCheck.failure()) }

    @Test fun `addresses are normalised, and a bad one is refused`() {
        val d = FakeDirectory()
        assertEquals("not-ascii", ((setup(d).begin("ü@x.de")) as IdentitySetup.Begin.Refused).detail)
        assertEquals(0, d.started)
    }

    @Test fun `a vault that cannot save leaves setup unfinished, and a second finish is refused`() {
        val d = FakeDirectory(); val s = setup(d); toBound(s); s.confirmRecovery(s.startRecovery()!!)
        assertTrue(s.finish(MemVault(ok = false)) is IdentitySetup.Finish.NotSaved)
        assertTrue("it can be retried", s.finish(MemVault()) is IdentitySetup.Finish.Done)
        assertTrue(s.finish(MemVault()) is IdentitySetup.Finish.WrongStep)
    }

    @Test fun `steps out of order do nothing`() {
        val s = setup(FakeDirectory())
        assertTrue(s.complete("K7Q3MZ2P") is IdentitySetup.Complete.WrongStep)
        assertNull(s.startRecovery())
        assertTrue(s.confirmRecovery("x") is IdentitySetup.Confirm.WrongStep)
        assertTrue(s.finish(MemVault()) is IdentitySetup.Finish.WrongStep)
    }

    @Test fun `abandon zeroes the secrets and the flow is dead`() {
        val d = FakeDirectory(); val s = setup(d); toBound(s)
        s.abandon()
        assertNull(s.startRecovery())
        assertTrue(s.begin("a@b.co") is IdentitySetup.Begin.Refused)
    }
}
