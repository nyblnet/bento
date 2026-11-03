// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

package page.bento.home

import java.security.SecureRandom

/**
 * bento/connect setup on Android (phase-1 plan A1, minus the passkey half): create an
 * account, verify the email by code, set up the recovery code, and mint the `bind.` and
 * this device's `dev.` under kx placement mode C. The order is the person's:
 *
 *  1. [begin]   — keys are made, `bind.` is signed and sent; the directory mails a code
 *  2. [complete] — the person types it; the account key signs `cmp.`; the directory's
 *                  `att.` is checked against a PINNED key before anything is believed
 *  3. [startRecovery] / [confirmRecovery] — an 80-bit code is shown; the person types it
 *                  back (checked against what was shown); the blob is sealed, then the wrap
 *                  key is derived AGAIN, independently, and must open it
 *  4. [enrolRecovery] — the verifier and the code-wrapped blob go to the directory in an
 *                  account-signed `dreq.rc-enrol.`, with the consent key's `cns.` over it
 *  5. [finish]  — the three private scalars are sealed by a [Vault], and the in-memory
 *                  copies are zeroed
 *
 * Nothing secret reaches disk before step 5, and a process death in between simply
 * restarts setup (the old code expires; nothing was bound without it).
 *
 * Everything here that can fail closed does: a managed device (security §39.4: while ANY
 * identity managed-config key is present, no identity operation), a device without the
 * memory Argon2id needs (checked BEFORE an email is bound, never confused with a wrong
 * code), and an attestation that does not verify.
 */
class IdentitySetup(
    private val directory: Directory,
    private val pins: Map<String, String>,
    private val device: DeviceKeys,
    private val managed: () -> Boolean,
    private val memoryOk: () -> Boolean = { Recovery.heapAvailable() >= Recovery.heapNeeded(Recovery.MEMORY_KIB) },
    /** Null = this build derives the recovery key correctly (SetupSelfCheck); anything else stops setup. */
    private val selfCheck: () -> String? = SetupSelfCheck::failure,
    private val now: () -> Long = System::currentTimeMillis,
    private val random: SecureRandom = SecureRandom(),
) {
    /** This device's own keys: the Keystore routine key, and the consent key where there is one. */
    interface DeviceKeys { fun routinePub(): String?; fun consentPub(): String? }

    /** Where the sealed scalars and the record go. [secrets] is account ‖ recovery kx ‖ device kx (96 bytes). */
    fun interface Vault { fun save(record: Record, secrets: ByteArray): Boolean }

    /** Signs a `cns.` with this device's CONSENT key — a person-present signature (a BiometricPrompt
     *  CryptoObject on Android). Blocks until the person answers, so call off the main thread;
     *  null if they decline or the key cannot be used. Returns raw low-S r‖s, base64url. */
    fun interface ConsentSigner { fun sign(cnsText: String): String? }

    /** Everything public the device keeps. */
    class Record(val address: String, val bindText: String, val bindSig: String, val attText: String, val attSig: String,
                 val devText: String, val devSig: String, val recoveryEnrolled: Boolean) {
        fun serialize(): String = listOf("address" to address, "bind" to bindText, "bindSig" to bindSig, "att" to attText,
            "attSig" to attSig, "dev" to devText, "devSig" to devSig, "recoveryEnrolled" to recoveryEnrolled.toString())
            .joinToString("\n") { "${it.first}\t${it.second}" }
        companion object {
            fun parse(text: String): Record? {
                val m = text.lines().filter { it.contains('\t') }.associate { it.substringBefore('\t') to it.substringAfter('\t') }
                fun g(k: String): String { return m[k] ?: "\u0000" }
                if (listOf("address", "bind", "bindSig", "att", "attSig", "dev", "devSig").any { it !in m }) return null
                return Record(g("address"), g("bind"), g("bindSig"), g("att"), g("attSig"), g("dev"), g("devSig"), g("recoveryEnrolled") == "true")
            }
        }
    }

    /** What the directory needs to hold for a recovery (identity-directory §9.4): the code-wrapped
     *  blob and the verifier, with the two salts. The directory adds its pepper layer. */
    class RecoveryEnrolment(val saltW: ByteArray, val saltV: ByteArray, val iv: ByteArray, val blob: ByteArray, val verifier: ByteArray)

    enum class Why { MANAGED, MEMORY, SELF_CHECK, ADDRESS, NO_DEVICE_KEY, DIRECTORY_REFUSED, OFFLINE, STATE }
    sealed class Begin { class Sent(val address: String) : Begin(); class Refused(val why: Why, val detail: String = "") : Begin() }
    sealed class Complete {
        object Ok : Complete()
        object BadFormat : Complete()                       // not 8 characters of the code alphabet; nothing was sent
        object Rejected : Complete()                        // wrong, expired or spent — the directory does not say which
        object Offline : Complete()
        class Unverified(val reason: String) : Complete()   // the reply did not verify; setup stops
        object WrongStep : Complete()
    }
    sealed class Confirm {
        object Ok : Confirm()
        class Mistyped(val reason: String) : Confirm()      // length | character | check | mismatch
        class Unavailable(val reason: String) : Confirm()   // memory: NEVER reported as a wrong code
        class Failed(val reason: String) : Confirm()        // our own derivation did not round-trip
        object WrongStep : Confirm()
    }
    sealed class Enrolled {
        object Yes : Enrolled()
        object NoConsentKey : Enrolled()               // API 26–29 with no enrolled biometric: this device cannot consent
        object Declined : Enrolled()                   // the person cancelled, or the key could not sign
        object NotAvailable : Enrolled()               // the directory's route is off
        class Refused(val reason: String) : Enrolled()
        object Offline : Enrolled()
        object WrongStep : Enrolled()
    }
    sealed class Finish { class Done(val recoveryEnrolled: Boolean) : Finish(); object NotSaved : Finish(); object WrongStep : Finish() }

    private enum class State { IDLE, SENT, BOUND, CODE_SHOWN, RECOVERY_DONE, FINISHED, DEAD }
    private var state = State.IDLE
    private var address = ""
    private var account: SoftKeys.Pair? = null
    private var rkx: SoftKeys.Pair? = null
    private var dkx: SoftKeys.Pair? = null
    private var bindText = ""; private var bindSig = ""
    private var attText = ""; private var attSig = ""
    private var code: ByteArray? = null
    private var enrolment: RecoveryEnrolment? = null
    private var devText = ""; private var devSig = ""
    private var recoveryEnrolled = false

    // ---- 1. begin ------------------------------------------------------------------------------

    fun begin(input: String): Begin {
        if (state != State.IDLE) return Begin.Refused(Why.STATE)
        if (managed()) return Begin.Refused(Why.MANAGED)
        if (!memoryOk()) return Begin.Refused(Why.MEMORY)
        val broken = selfCheck()
        if (broken != null) return Begin.Refused(if (broken == "memory") Why.MEMORY else Why.SELF_CHECK, broken)
        val addr = when (val a = Address.normalize(input)) { is Address.Result.Ok -> a.address; is Address.Result.No -> return Begin.Refused(Why.ADDRESS, a.reason) }
        if (device.routinePub() == null) return Begin.Refused(Why.NO_DEVICE_KEY)
        val acct = SoftKeys.generate(); val recov = SoftKeys.generate(); val dev = SoftKeys.generate()
        val t = now()
        val text = Statements.buildBind(Statements.BindCert(addr, acct.pub, recov.pub, 1, null, t, t + BIND_LIFE_MS))
        val sig = Statements.sign(acct.scalar, text)
        return when (val r = directory.bindStart(text, sig)) {
            is Directory.Started.Accepted -> {
                account = acct; rkx = recov; dkx = dev; address = addr; bindText = text; bindSig = sig; state = State.SENT
                Begin.Sent(addr)
            }
            is Directory.Started.Refused -> { acct.wipe(); recov.wipe(); dev.wipe(); Begin.Refused(Why.DIRECTORY_REFUSED, r.status.toString()) }
            Directory.Started.Unreachable -> { acct.wipe(); recov.wipe(); dev.wipe(); Begin.Refused(Why.OFFLINE) }
        }
    }

    // ---- 2. the emailed code ---------------------------------------------------------------------

    fun complete(typed: String): Complete {
        if (state != State.SENT) return Complete.WrongStep
        val hash = Statements.sha256b64u(bindText)
        val cmp = Statements.buildCmp(hash, typed) ?: return Complete.BadFormat
        val sig = Statements.sign(account!!.scalar, cmp)
        val ok = when (val r = directory.bindComplete(address, cmp.substringAfterLast('.'), sig)) {
            Directory.Complete.Rejected -> return Complete.Rejected
            Directory.Complete.Unreachable -> return Complete.Offline
            is Directory.Complete.Ok -> r.value
        }
        fun stop(reason: String): Complete { die(); return Complete.Unverified(reason) }
        // The directory must hand back exactly what we signed, attested under a key we pinned.
        if (ok.binding != bindText || ok.sig != bindSig) return stop("binding-differs")
        if (pins.isEmpty()) return stop("no-pinned-key")
        return when (val v = Statements.verifyAtt(ok.attestation, ok.attestationSig, pins, bindText, now(), ATT_MAX_AGE_MS)) {
            is Statements.Verdict.No -> stop(v.reason)
            is Statements.Verdict.Ok -> if (v.att.state != "active") stop("state-${v.att.state}") else {
                attText = ok.attestation; attSig = ok.attestationSig; state = State.BOUND; Complete.Ok
            }
        }
    }

    // ---- 3. the recovery code -----------------------------------------------------------------------

    /** The printed form. Minted once per setup; asking again shows the same code. */
    fun startRecovery(): String? {
        if (state != State.BOUND && state != State.CODE_SHOWN) return null
        if (code == null) code = ByteArray(Recovery.CODE_BYTES).also { random.nextBytes(it) }
        state = State.CODE_SHOWN
        return Recovery.format(code!!)
    }

    /**
     * The person has typed the code back. Cheap checks first (nothing is derived for a typo or a
     * code other than the one shown). Then, off the main thread: the blob is sealed under the wrap
     * key, the wrap key is derived a SECOND time from the code as typed, and that must open the
     * blob and return the same scalars — so what is stored is what the printed code decrypts.
     * [Confirm.Unavailable] is a device that cannot hold Argon2id's memory, never a wrong code.
     */
    fun confirmRecovery(typed: String): Confirm {
        if (state != State.CODE_SHOWN) return Confirm.WrongStep
        val minted = code!!
        val parsed = Recovery.parse(typed)
        if (parsed is Recovery.Parsed.No) return Confirm.Mistyped(parsed.reason)
        val typedBytes = (parsed as Recovery.Parsed.Ok).code
        if (!typedBytes.contentEquals(minted)) return Confirm.Mistyped("mismatch")
        if (!memoryOk()) return Confirm.Unavailable("memory")
        val saltW = ByteArray(Recovery.SALT_LEN).also { random.nextBytes(it) }
        val saltV = ByteArray(Recovery.SALT_LEN).also { random.nextBytes(it) }
        val iv = ByteArray(12).also { random.nextBytes(it) }
        val acct = account!!; val recov = rkx!!
        try {
            val keys = Recovery.Keys(acct.scalar, recov.scalar)
            val blob = Recovery.sealRecoveryInner(Recovery.wrapKey(minted, saltW), iv, acct.pub, keys)
            val back = Recovery.openRecoveryInner(blob, Recovery.wrapKey(typedBytes, saltW), iv, acct.pub, recov.pub)
            if (back !is Recovery.Opened.Ok || !back.keys.account.contentEquals(acct.scalar) || !back.keys.kx.contentEquals(recov.scalar))
                return Confirm.Failed("round-trip")
            val verifier = Recovery.verifier(typedBytes, saltV)
            enrolment = RecoveryEnrolment(saltW, saltV, iv, blob, verifier)
        } catch (e: Recovery.Unavailable) { return Confirm.Unavailable("memory") }
        code?.fill(0); code = null
        state = State.RECOVERY_DONE
        return Confirm.Ok
    }

    // ---- 4. the recovery code, registered ------------------------------------------------------------

    /** This device's certificate, signed by the account key: built once, used by the consent proof and kept. */
    private fun deviceCert(): Boolean {
        if (devText.isNotEmpty()) return true
        val routine = device.routinePub() ?: return false
        val t = now()
        devText = Statements.buildDev(Statements.DeviceCert(routine, device.consentPub(), account!!.pub, dkx!!.pub, t, t + DEV_LIFE_MS))
        devSig = Statements.sign(account!!.scalar, devText)
        return true
    }

    /**
     * Register the recovery verifier and the code-wrapped blob (identity-directory §9.4, §9.6c).
     * Changing who can recover the account needs the key AND the person: the account key signs a
     * `dreq.rc-enrol.` over the EXACT enrolment body, and the consent key signs a `cns.` over that
     * dreq, bound to a single-use challenge the directory just issued (it lives 60 seconds, so the
     * challenge is fetched last, just before [signer] asks the person). Safe to call again after
     * anything but [Enrolled.Yes].
     */
    fun enrolRecovery(signer: ConsentSigner): Enrolled {
        if (state != State.RECOVERY_DONE) return Enrolled.WrongStep
        val e = enrolment ?: return Enrolled.WrongStep
        if (recoveryEnrolled) return Enrolled.Yes
        if (device.consentPub() == null) return Enrolled.NoConsentKey
        if (!deviceCert()) return Enrolled.Declined
        val body = ("{\"v\":1,\"saltV\":\"${B64u.enc(e.saltV)}\",\"verifier\":\"${B64u.enc(e.verifier)}\",\"saltW\":\"${B64u.enc(e.saltW)}\"," +
            "\"iv\":\"${B64u.enc(e.iv)}\",\"ct\":\"${B64u.enc(e.blob)}\"}").toByteArray(Charsets.UTF_8)
        val challenge = directory.challenge(address) ?: return Enrolled.Offline
        val req = Statements.buildDreq("rc-enrol", address, Statements.sha256b64u(bindText), challenge, Statements.sha256b64u(body))
        val reqSig = Statements.sign(account!!.scalar, req)
        val cns = Consent.stamp(Consent.Purpose.RC_ENROL, null, challenge, req, now()) ?: return Enrolled.Declined
        val cnsSig = signer.sign(cns) ?: return Enrolled.Declined
        return when (val r = directory.recoveryEnrol(address, body, req, reqSig, challenge, Directory.ConsentProof(devText, devSig, cns, cnsSig))) {
            Directory.Enrol.Enrolled -> { recoveryEnrolled = true; Enrolled.Yes }
            Directory.Enrol.NotAvailable -> Enrolled.NotAvailable
            Directory.Enrol.Unreachable -> Enrolled.Offline
            is Directory.Enrol.Refused -> Enrolled.Refused(r.reason)
        }
    }

    // ---- 5. this device ---------------------------------------------------------------------------------

    fun finish(vault: Vault): Finish {
        if (state != State.RECOVERY_DONE) return Finish.WrongStep
        val acct = account!!
        if (!deviceCert()) return Finish.NotSaved
        val secrets = acct.scalar + rkx!!.scalar + dkx!!.scalar
        val saved = try {
            vault.save(Record(address, bindText, bindSig, attText, attSig, devText, devSig, recoveryEnrolled), secrets)
        } finally { secrets.fill(0) }
        if (!saved) return Finish.NotSaved
        die(); state = State.FINISHED
        return Finish.Done(recoveryEnrolled)
    }

    /** Zero everything secret. Safe to call at any point (Activity gone, person backed out). */
    fun abandon() = die()

    private fun die() {
        account?.wipe(); rkx?.wipe(); dkx?.wipe(); code?.fill(0)
        account = null; rkx = null; dkx = null; code = null; enrolment = null; devText = ""; devSig = ""
        if (state != State.FINISHED) state = State.DEAD
    }

    /** The recovery material for the directory, available between [confirmRecovery] and [finish]. */
    fun pendingEnrolment(): RecoveryEnrolment? = enrolment

    companion object {
        const val DAY_MS = 86_400_000L
        /** Both certificates live a year: inside kernel's 13-month ceiling, with room to renew. */
        const val BIND_LIFE_MS = 365 * DAY_MS
        const val DEV_LIFE_MS = 365 * DAY_MS
        /** An attestation older than this is a replay, not an answer to the call just made. */
        const val ATT_MAX_AGE_MS = 10 * 60_000L
    }
}
