// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

package page.bento.home

/**
 * One known answer, run on the device before an email is bound to a recovery code that
 * only THIS build can derive. It is the release-APK derivation check (phase-1 plan A1):
 * a minifier that mangled Bouncy Castle's Argon2id, or a platform whose EC code
 * disagrees, would otherwise print a recovery code that decrypts nothing, and nobody
 * would find out until the day the code was needed.
 *
 * The inputs and expected bytes are kernel/fixtures/recovery-v1.json's `derivations`
 * row (the same bytes RecoveryTest reproduces on the JVM); the key paths are the ones
 * setup uses — [SoftKeys], [Statements.sign]/[Statements.verifySig], [Recovery.scalarMatches].
 */
object SetupSelfCheck {
    private val CODE = Hex.bytes("009e01a578034a5304ef")
    private val SALT = Hex.bytes("101112131415161718191a1b1c1d1e1f")
    private const val WRAP_KEY = "7df96d5da988fce6c37079c05072e8c413c3157700780e251f17b792d3ad589f"

    /** Why the check failed, or null when it passed. Takes ~1 Argon2id run: call off the main thread. */
    fun failure(): String? = try {
        when {
            Hex.str(Recovery.wrapKey(CODE, SALT)) != WRAP_KEY -> "wrap-key"
            !(Recovery.parse(Recovery.format(CODE)).let { it is Recovery.Parsed.Ok && it.code.contentEquals(CODE) }) -> "code-round-trip"
            !keysAndSignatures() -> "signature"
            else -> null
        }
    } catch (e: Recovery.Unavailable) { "memory" } catch (e: Throwable) { "error:" + e.javaClass.simpleName }

    private fun keysAndSignatures(): Boolean {
        val k = SoftKeys.generate()
        val text = "cmp.selfcheck.K7Q3MZ2P"
        val sig = Statements.sign(k.scalar, text)
        val ok = Statements.isPoint(k.pub) && Statements.verifySig(k.pub, sig, text) &&
            !Statements.verifySig(k.pub, sig, text + "x") && Recovery.scalarMatches(k.scalar, k.pub)
        k.wipe()
        return ok
    }
}
