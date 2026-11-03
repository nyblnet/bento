// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

package page.bento.home

import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.content.RestrictionsManager
import java.io.File
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature

/**
 * The process-wide pieces behind [IdentityHost]: ONE session for the whole app (the idle
 * and overall clocks belong to the person on this device, not to a document), the
 * per-document consent file, and the real Keystore key. The editor builds an
 * [IdentityHost] over these for each open document.
 */
object IdentityRuntime {
    /** The host's own limits. A debug build may shorten them for the rig; a release build never can. */
    val gate: RoutineGate by lazy { RoutineGate() }

    private var consent: DocConsentStore? = null
    @Synchronized fun consent(c: Context): DocConsentStore =
        consent ?: DocConsentStore(File(File(c.noBackupFilesDir, "identity"), "doc-consent")).also { consent = it }

    /** The same predicate setup and linking refuse on: ANY managed-configuration key (security §39.4, O1 deferred). */
    fun managed(c: Context): Boolean = try {
        (c.getSystemService(Context.RESTRICTIONS_SERVICE) as RestrictionsManager).applicationRestrictions.size() > 0
    } catch (e: Exception) { true }   // unreadable: fail closed

    fun host(c: Context, gate: RoutineGate = this.gate, managed: () -> Boolean = { managed(c) }): IdentityHost = IdentityHost(
        record = { AccountVault.recordText(c)?.let(::parseRecord) },
        managed = managed,
        consent = consent(c),
        gate = gate,
        signRoutine = ::signWithRoutineKey,
    )

    /** Raw low-S r‖s over [message] with the routine key; the Keystore's own floor lapsing is [IdentityHost.AuthLapsed]. */
    fun signWithRoutineKey(message: ByteArray): ByteArray = try {
        AgentKeys.signRoutine(message)
    } catch (e: android.security.keystore.UserNotAuthenticatedException) {
        throw IdentityHost.AuthLapsed()
    }

    /** The device-credential screen that re-authenticates the person (all API levels). Null when no secure lock screen exists. */
    fun reauthIntent(c: Context): Intent? =
        (c.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager).createConfirmDeviceCredentialIntent(null, null)
}
