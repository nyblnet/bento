// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

package page.bento.home

import java.security.SecureRandom

/** The directory's link slot routes (`/v1/link/` ... ) and the two reads N and H need around them. */
interface LinkDirectory {
    sealed class R {
        object Ok : R()
        object Contended : R()                          // a second device has the code: the slot is burned
        class Gone(val reason: String) : R()            // aborted or completed inside its window
        object NotFound : R()                           // no such slot, or it expired
        object Forbidden : R()
        class Refused(val status: Int, val reason: String) : R()
        object Unreachable : R()
    }
    sealed class Got { class Msg(val text: String) : Got(); object Pending : Got(); class Failed(val why: R) : Got() }
    class Lookup(val binding: String, val sig: String, val attestation: String, val attestationSig: String)

    fun open(slot: Link.Slot, msg: String): R
    fun put(slot: Link.Slot, n: Int, msg: String): R
    fun get(slot: Link.Slot, n: Int, waitMs: Long): Got
    fun abort(slot: Link.Slot)
    fun complete(slot: Link.Slot, email: String, challenge: String, msg3: String): R
    fun challenge(email: String): String?
    fun lookup(email: String): Lookup?
}

/**
 * One end of one link (security §39.1), in either role. An agent is used for ONE slot and then
 * thrown away: any failure kills it (a retry is a new slot with a new code, never a second message
 * under a key), and it refuses to seal a second message under either direction key.
 *
 * Who does what:
 *   - the DISPLAYER ([display] + [awaitScanner]) mints the code and opens the slot; the SCANNER
 *     ([scan]) reads it. Either H or N may display. Both then hold the same keys and the same SAS.
 *   - N SHOWS the SAS ([sas]) and sends its offer ([sendOffer]); H is TYPED the SAS ([enterSas],
 *     one attempt), reads the offer ([readOffer]) and approves with a person-present consent
 *     ([approve]); N receives the sealed account and checks it ([awaitFinal]).
 *
 * Every blocking call talks to the network or waits for the person: call from a worker thread.
 */
class LinkAgent(
    private val role: Link.Role,
    private val dir: LinkDirectory,
    /** Whether THIS device holds an account: read from the vault by the caller, never from an intent. */
    private val holdsAccount: () -> Boolean,
    private val now: () -> Long = System::currentTimeMillis,
    private val random: SecureRandom = SecureRandom(),
    private val pollMs: Long = 20_000,
) {
    enum class Why {
        ROLE,          // the roles do not add up for this device (or the other side claims ours)
        BAD_CODE,      // not a link code, or no slot for it
        CONTENDED,     // a second device used the code
        GONE,          // the slot was aborted, completed or expired
        OFFLINE, REFUSED, BAD_MESSAGE,
        SAS,           // the typed digits were not the SAS: one attempt, the slot is gone
        NO_CONSENT,    // this H has no consent key (the light tier is not a holder)
        DECLINED,      // the person cancelled
        UNVERIFIED,    // what N was given did not check out
        STATE,         // used out of order
    }
    sealed class Step<out T> { class Ok<T>(val value: T) : Step<T>(); class Fail(val why: Why, val detail: String = "") : Step<Nothing>() }

    private enum class S { NEW, DISPLAYING, PAIRED, SAS_OK, OFFERED, DONE, DEAD }
    private var state = S.NEW
    private var slot: Link.Slot? = null
    private var own: SoftKeys.Pair? = null
    private var roleD: Link.Role? = null
    private var t: String? = null
    private var keys: Link.Keys? = null
    private var sealedN2h = false
    private var sealedH2n = false
    private var offerSent: Link.Offer? = null
    private var dkx: SoftKeys.Pair? = null

    private fun fail(why: Why, detail: String = ""): Step.Fail { kill(abort = why != Why.OFFLINE && why != Why.STATE); return Step.Fail(why, detail) }
    private fun kill(abort: Boolean) {
        if (abort) slot?.let { try { dir.abort(it) } catch (_: Exception) {} }
        own?.wipe(); keys?.wipe(); dkx?.wipe()
        own = null; keys = null; dkx = null
        if (state != S.DONE) state = S.DEAD
    }
    /** Zero everything secret; safe at any point (the screen went away). Deletes the slot if it is live. */
    fun abandon() = kill(abort = state != S.NEW && state != S.DONE)

    private fun fromReply(r: LinkDirectory.R): Step.Fail = when (r) {
        LinkDirectory.R.Contended -> fail(Why.CONTENDED)
        is LinkDirectory.R.Gone, LinkDirectory.R.NotFound, LinkDirectory.R.Forbidden -> fail(Why.GONE)
        LinkDirectory.R.Unreachable -> fail(Why.OFFLINE)
        is LinkDirectory.R.Refused -> fail(Why.REFUSED, "${r.status} ${r.reason}")
        LinkDirectory.R.Ok -> fail(Why.STATE)
    }

    /** A role needs the matching state on THIS device: H holds an account, N holds none. */
    private fun roleFits() = if (role == Link.Role.H) holdsAccount() else !holdsAccount()

    // ---- pairing ----------------------------------------------------------------------------------

    class Shown(val code: String, val qr: String)

    /** Displayer, step 1: mint the code and the ephemeral key, open the slot, show the code. */
    fun display(): Step<Shown> {
        if (state != S.NEW) return Step.Fail(Why.STATE)
        if (!roleFits()) return fail(Why.ROLE)
        val code = ByteArray(Link.CODE_BYTES).also { random.nextBytes(it) }
        val s = Link.slot(code); val e = SoftKeys.generate()
        slot = s; own = e; roleD = role
        val r = dir.open(s, B64u.enc(Link.buildMsg0(e.pub, role).toByteArray()))
        if (r != LinkDirectory.R.Ok) return fromReply(r)
        state = S.DISPLAYING
        val printed = Link.formatCode(code); code.fill(0)
        return Step.Ok(Shown(printed, QR_PREFIX + printed))
    }

    /** Displayer, step 2: wait (up to [totalMs]) for the scanner's msg1, then derive the keys. */
    fun awaitScanner(totalMs: Long): Step<Unit> {
        if (state != S.DISPLAYING) return Step.Fail(Why.STATE)
        val s = slot!!; val deadline = now() + totalMs
        while (true) {
            when (val g = dir.get(s, 1, minOf(pollMs, maxOf(0, deadline - now())))) {
                is LinkDirectory.Got.Msg -> {
                    val text = decode(g.text) ?: return fail(Why.BAD_MESSAGE)
                    val eS = (Link.parseMsg1(text) as? Link.V.Ok)?.value ?: return fail(Why.BAD_MESSAGE)
                    return derive(eS)
                }
                LinkDirectory.Got.Pending -> if (now() >= deadline) return fail(Why.GONE, "timeout")
                is LinkDirectory.Got.Failed -> return fromReply(g.why)
            }
        }
    }

    /** Scanner: a code typed, or read from a QR (`https://id.bento.page/l#CODE`). */
    fun scan(input: String): Step<Unit> {
        if (state != S.NEW) return Step.Fail(Why.STATE)
        val p = Link.parseCode(input.substringAfter('#', input).trim())
        if (p !is Recovery.Parsed.Ok) return Step.Fail(Why.BAD_CODE, (p as Recovery.Parsed.No).reason)
        val s = Link.slot(p.code); p.code.fill(0)
        slot = s
        val msg0 = when (val g = dir.get(s, 0, 0)) {
            is LinkDirectory.Got.Msg -> decode(g.text)?.let { Link.parseMsg0(it) } ?: return fail(Why.BAD_MESSAGE)
            LinkDirectory.Got.Pending -> return Step.Fail(Why.BAD_CODE, "empty")
            is LinkDirectory.Got.Failed -> return if (g.why == LinkDirectory.R.NotFound) Step.Fail(Why.BAD_CODE, "no slot") else fromReply(g.why)
        }
        if (msg0 !is Link.V.Ok) return fail(Why.BAD_MESSAGE, (msg0 as Link.V.No).reason)
        // roles are CHECKED against this device's own state, never taken from the other side (§39.1 cond. 2)
        if (!Link.scannerMayProceed(msg0.value.roleD, holdsAccount()) || msg0.value.roleD == role || !roleFits()) return fail(Why.ROLE)
        roleD = msg0.value.roleD
        val e = SoftKeys.generate(); own = e
        val r = dir.put(s, 1, B64u.enc(Link.buildMsg1(e.pub).toByteArray()))
        if (r != LinkDirectory.R.Ok) return fromReply(r)
        return derive(msg0.value.eD)
    }

    private fun derive(eOther: String): Step<Unit> {
        val s = slot!!; val e = own!!
        val eD = if (roleD == role) e.pub else eOther
        val eS = if (roleD == role) eOther else e.pub
        val tt = Link.transcript(s.id, eD, eS, roleD!!) ?: return fail(Why.BAD_MESSAGE, "reflected")
        val k = Link.keys(e.scalar, eOther, s.salt, tt) ?: return fail(Why.BAD_MESSAGE, "key")
        t = tt; keys = k; state = S.PAIRED
        return Step.Ok(Unit)
    }

    // ---- N -----------------------------------------------------------------------------------------

    /** N's 6 digits: shown on N, TYPED on H. */
    fun sas(): String? = if (role == Link.Role.N && (state == S.PAIRED || state == S.OFFERED)) keys?.sas else null

    /** What N proves it holds: its routine key (always) and its consent key (where it has one). */
    interface Proofs { fun routinePub(): String?; fun consentPub(): String?; fun signRoutine(text: String): String?; fun signConsent(text: String): String? }

    /** N → H, message 2: sealed under n2h exactly once. */
    fun sendOffer(proofs: Proofs, label: String?, platform: String = "android"): Step<Unit> {
        if (role != Link.Role.N || state != S.PAIRED) return Step.Fail(Why.STATE)
        if (sealedN2h) return fail(Why.STATE, "n2h already sealed")
        val routine = proofs.routinePub() ?: return fail(Why.DECLINED, "no device key")
        val consent = proofs.consentPub()
        val k = SoftKeys.generate(); dkx = k
        val pop = Link.popText(t!!)
        val popD = proofs.signRoutine(pop) ?: return fail(Why.DECLINED)
        val popC = if (consent != null) proofs.signConsent(pop) ?: return fail(Why.DECLINED) else null
        val offer = Link.Offer(routine, consent, k.pub, label?.takeIf { DisplayText.parse(B64u.enc(it.toByteArray())) != null }, platform)
        val iv = ByteArray(12).also { random.nextBytes(it) }
        sealedN2h = true
        val wire = Link.seal(keys!!, 2, t!!, iv, Link.buildOffer(offer, popD, popC).toByteArray())
        val r = dir.put(slot!!, 2, wire)
        if (r != LinkDirectory.R.Ok) return fromReply(r)
        offerSent = offer; state = S.OFFERED
        return Step.Ok(Unit)
    }

    /** Everything N keeps once it is linked. [secrets] is account ‖ recovery kx ‖ device kx. */
    class Linked(val address: String, val bindText: String, val bindSig: String, val attText: String, val attSig: String,
                 val devText: String, val devSig: String, val label: String?, val secrets: ByteArray) {
        fun record() = IdentitySetup.Record(address, bindText, bindSig, attText, attSig, devText, devSig, recoveryEnrolled = false)
    }

    /**
     * N waits for message 3 and checks it before keeping anything: the dev. must name N's own keys, the
     * account must be the binding the directory serves for [address] under a PINNED key, and both
     * scalars must match it. On success N deletes the slot (it is done); on any failure it aborts.
     */
    fun awaitFinal(address: String, pins: Map<String, String>, totalMs: Long): Step<Linked> {
        if (role != Link.Role.N || state != S.OFFERED) return Step.Fail(Why.STATE)
        val s = slot!!; val deadline = now() + totalMs
        val msg3: String
        while (true) {
            when (val g = dir.get(s, 3, minOf(pollMs, maxOf(0, deadline - now())))) {
                is LinkDirectory.Got.Msg -> { msg3 = g.text; break }
                LinkDirectory.Got.Pending -> if (now() >= deadline) return fail(Why.GONE, "timeout")
                is LinkDirectory.Got.Failed -> return fromReply(g.why)
            }
        }
        if (pins.isEmpty()) return fail(Why.UNVERIFIED, "no-pinned-key")
        val addr = (Address.normalize(address) as? Address.Result.Ok)?.address ?: return fail(Why.UNVERIFIED, "address")
        val lk = dir.lookup(addr) ?: return fail(Why.OFFLINE)
        val bind = parseBind(lk.binding) ?: return fail(Why.UNVERIFIED, "bind")
        if (bind.address != addr) return fail(Why.UNVERIFIED, "bind-address")
        if (!Statements.verifySig(bind.accountPub, lk.sig, lk.binding)) return fail(Why.UNVERIFIED, "bind-signature")
        when (val v = Statements.verifyAtt(lk.attestation, lk.attestationSig, pins, lk.binding, now(), IdentitySetup.ATT_MAX_AGE_MS)) {
            is Statements.Verdict.No -> return fail(Why.UNVERIFIED, v.reason)
            is Statements.Verdict.Ok -> if (v.att.state != "active") return fail(Why.UNVERIFIED, "state-${v.att.state}")
        }
        val opened = when (val v = Link.openFinal(msg3, keys!!, t!!, offerSent!!, bind.accountPub, bind.kx, now())) {
            is Link.V.No -> return fail(Why.UNVERIFIED, v.reason)
            is Link.V.Ok -> v.value
        }
        val secrets = opened.keys.account + opened.keys.kx + dkx!!.scalar
        opened.keys.account.fill(0); opened.keys.kx.fill(0)
        try { dir.abort(s) } catch (_: Exception) {}
        val linked = Linked(addr, lk.binding, lk.sig, lk.attestation, lk.attestationSig, opened.dev, opened.devSig, opened.device.label, secrets)
        state = S.DONE; kill(abort = false)
        return Step.Ok(linked)
    }

    // ---- H -----------------------------------------------------------------------------------------

    private var sasTried = false

    /** H is TYPED the digits N shows. ONE attempt: a mismatch ends the slot. */
    fun enterSas(typed: String): Step<Unit> {
        if (role != Link.Role.H || state != S.PAIRED) return Step.Fail(Why.STATE)
        if (sasTried) return fail(Why.SAS, "second attempt")
        sasTried = true
        if (!Link.sasMatches(typed, keys!!.sas)) return fail(Why.SAS)
        state = S.SAS_OK
        return Step.Ok(Unit)
    }

    /** H reads N's offer (message 2), only after the SAS matched. */
    fun readOffer(totalMs: Long): Step<Link.Offer> {
        if (role != Link.Role.H || state != S.SAS_OK) return Step.Fail(Why.STATE)
        val deadline = now() + totalMs
        while (true) {
            when (val g = dir.get(slot!!, 2, minOf(pollMs, maxOf(0, deadline - now())))) {
                is LinkDirectory.Got.Msg -> return when (val o = Link.openOffer(keys!!, t!!, g.text)) {
                    is Link.V.No -> fail(Why.BAD_MESSAGE, o.reason)
                    is Link.V.Ok -> { offerSent = o.value; state = S.OFFERED; Step.Ok(o.value) }
                }
                LinkDirectory.Got.Pending -> if (now() >= deadline) return fail(Why.GONE, "timeout")
                is LinkDirectory.Got.Failed -> return fromReply(g.why)
            }
        }
    }

    /** What H holds: its address, the account and recovery kx scalars, and its own dev. */
    class Holder(val address: String, val bindText: String, val accountScalar: ByteArray, val recoveryKxScalar: ByteArray,
                 val devText: String, val devSig: String, val hasConsentKey: Boolean)

    /**
     * H approves: issues N's dev. (with the label H chose), asks the directory for a fresh challenge,
     * has the person consent (a `cns.` purpose `link` over that dev. text), seals the account blob
     * under h2n exactly once and sends the whole of message 3 to the directory, which checks it.
     */
    fun approve(holder: Holder, label: String?, signer: IdentitySetup.ConsentSigner): Step<Unit> {
        if (role != Link.Role.H || state != S.OFFERED) return Step.Fail(Why.STATE)
        if (!holder.hasConsentKey) return fail(Why.NO_CONSENT)
        if (sealedH2n) return fail(Why.STATE, "h2n already sealed")
        val o = offerSent!!
        val t0 = now()
        val chosen = label?.takeIf { DisplayText.parse(B64u.enc(it.toByteArray())) != null }
        val nDev = Statements.buildDev(Statements.DeviceCert(o.devicePub, o.consentPub, accountPubOf(holder), o.kx, t0,
            t0 + IdentitySetup.DEV_LIFE_MS, chosen))
        val nDevSig = Statements.sign(holder.accountScalar, nDev)
        val iv = ByteArray(12).also { random.nextBytes(it) }
        sealedH2n = true
        val sealed = Link.seal(keys!!, 3, t!!, iv, Recovery.pack(Recovery.Keys(holder.accountScalar, holder.recoveryKxScalar)))
        // the challenge lives 60 s: fetch it LAST, then ask the person
        val challenge = dir.challenge(holder.address) ?: return fail(Why.OFFLINE)
        val cns = Consent.stamp(Consent.Purpose.LINK, null, challenge, nDev, now()) ?: return fail(Why.REFUSED, "consent")
        val cnsSig = signer.sign(cns) ?: return fail(Why.DECLINED)
        val msg3 = Link.buildFinal(Link.Final(holder.devText, holder.devSig, cns, cnsSig, nDev, nDevSig, sealed))
        val r = dir.complete(slot!!, holder.address, challenge, msg3)
        if (r != LinkDirectory.R.Ok) return fromReply(r)
        state = S.DONE; kill(abort = false)
        return Step.Ok(Unit)
    }

    private fun accountPubOf(h: Holder): String = parseBind(h.bindText)!!.accountPub

    // ---- helpers ----------------------------------------------------------------------------------------

    private fun decode(wire: String): String? = B64u.dec(wire)?.let { String(it, Charsets.UTF_8) }

    class Bind(val address: String, val accountPub: String, val kx: String)

    /** `bind.<b64u(address)>.<accountPub>.<kx>.<name|empty>.<seq>.<prev|empty>.<created>.<expires>`: the three fields N needs. */
    fun parseBind(text: String): Bind? {
        val p = text.split('.')
        if (p.size != 9 || p[0] != "bind" || text.any { it.code !in 0x21..0x7e }) return null
        val addr = B64u.dec(p[1])?.toString(Charsets.UTF_8) ?: return null
        if (!Statements.isPoint(p[2]) || !Statements.isPoint(p[3]) || p[2] == p[3]) return null
        return Bind(addr, p[2], p[3])
    }

    companion object {
        /** What the QR carries. A universal link may start the N side only (§39.1 condition 1). */
        const val QR_PREFIX = "https://id.bento.page/l#"
    }
}
