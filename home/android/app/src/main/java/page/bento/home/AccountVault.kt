// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

package page.bento.home

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

/**
 * Where the account's private scalars rest on this device (identity-android §1): sealed
 * under an AES-256-GCM Keystore key that needs the person for EVERY use — a
 * BiometricPrompt CryptoObject, with the device PIN as the fallback from API 30 — and
 * that, like the consent key, survives a new fingerprint (§29b). The portable copy is the
 * recovery blob, never this file.
 *
 * The record (public statements) and the sealed scalars sit in no-backup storage. Both are
 * written to a temporary name first and renamed, so a half-written account is never read.
 */
object AccountVault {
    private const val WRAP = "bento-account-wrap"
    private fun dir(c: Context) = File(c.noBackupFilesDir, "identity")
    private fun keystore() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    fun exists(c: Context): Boolean = File(dir(c), "account.sealed").exists() && File(dir(c), "account.record").exists()

    /** An encrypt Cipher the caller hands to a BiometricPrompt. Creates the key on first use. */
    fun sealCipher(): Cipher {
        val ks = keystore()
        if (!ks.containsAlias(WRAP)) {
            val b = KeyGenParameterSpec.Builder(WRAP, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setUserAuthenticationRequired(true)
                .setInvalidatedByBiometricEnrollment(false)
            if (Build.VERSION.SDK_INT >= 30) b.setUserAuthenticationParameters(0,
                KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL)
            else @Suppress("DEPRECATION") b.setUserAuthenticationValidityDurationSeconds(-1)
            KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply { init(b.build()) }.generateKey()
        }
        return Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, ks.getKey(WRAP, null) as SecretKey) }
    }

    /** A vault that seals with [cipher] — already authorised by the person's prompt. One use. */
    fun vault(c: Context, cipher: Cipher): IdentitySetup.Vault = IdentitySetup.Vault { record, secrets ->
        try {
            val d = dir(c).apply { mkdirs() }
            cipher.updateAAD(AAD)
            val ct = cipher.doFinal(secrets)
            write(File(d, "account.sealed"), B64u.enc(cipher.iv) + "." + B64u.enc(ct))
            write(File(d, "account.record"), record.serialize())
            true
        } catch (e: Exception) { false }
    }

    private val AAD = "bento/id/account-seal/v1".toByteArray(Charsets.UTF_8)

    private fun write(f: File, text: String) {
        val tmp = File(f.parentFile, f.name + ".tmp")
        tmp.writeText(text); if (!tmp.renameTo(f)) throw java.io.IOException("rename")
    }

    /** The public record, for the rig and the UI. */
    fun recordText(c: Context): String? = File(dir(c), "account.record").takeIf { it.exists() }?.readText()
    fun sealedText(c: Context): String? = File(dir(c), "account.sealed").takeIf { it.exists() }?.readText()
}
