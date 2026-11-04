// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

package page.bento.home

import android.content.RestrictionsManager
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat

/**
 * Bento ID setup: create an account, verify the email by code, set up the recovery code
 * (identity-android §3, phase-1 plan A1 without the passkey half). The engine is
 * [IdentitySetup]; this is only the screen.
 *
 * It has NO entry point in a release build: it is not exported and nothing launches it,
 * because the directory is not live and the strings are placeholders. A dev build
 * exports it, and reads its test inputs from the launching intent:
 *   --es directory <url>   --es kid <dir kid>   --es pub <directory public key, raw b64u>
 *   --ez selfcheck true    (just run [SetupSelfCheck] and log the verdict)
 * A release build ignores those extras, and with no pinned directory key setup refuses.
 */
class SetupActivity : AppCompatActivity() {
    /** The manifest's dev switch (true in debug and releaseCheck builds, never in release). */
    private val devBuild get() = packageManager.getActivityInfo(componentName, android.content.pm.PackageManager.GET_META_DATA)
        .metaData?.getBoolean("bento.setup.dev", false) == true
    private lateinit var status: TextView
    private lateinit var codeView: TextView
    private lateinit var input: EditText
    private lateinit var action: Button
    private var setup: IdentitySetup? = null
    private var step = Step.EMAIL
    private var address = ""

    private enum class Step { EMAIL, CODE, RECOVERY_SHOWN, RECOVERY_TYPE, ENROLLING, SAVING, DONE }
    private var enrolledResult: IdentitySetup.Enrolled? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val intent = intent
        if (devBuild && intent.getBooleanExtra("selfcheck", false)) {
            Thread {
                val f = SetupSelfCheck.failure()
                Log.i(TAG, if (f == null) "SELFCHECK OK" else "SELFCHECK FAIL $f")
                runOnUiThread { finish() }
            }.start()
            return
        }
        buildViews()
        val pins: Map<String, String> = if (devBuild) {
            val kid = intent.getStringExtra("kid"); val pub = intent.getStringExtra("pub")
            if (kid != null && pub != null) mapOf(kid to pub) else emptyMap()
        } else emptyMap()   // M6 (the maintainer mints dir-1/dir-2) has not happened: a release build pins nothing
        val url = if (devBuild) intent.getStringExtra("directory") else null
        if (pins.isEmpty() || url == null) { status.setText(R.string.setup_unavailable_here); input.visibility = View.GONE; action.visibility = View.GONE; return }
        AgentKeys.ensure(this)
        setup = IdentitySetup(
            HttpDirectory(url, allowDevHttp = devBuild), pins,
            object : IdentitySetup.DeviceKeys {
                override fun routinePub() = try { B64u.enc(AgentKeys.publicRaw(AgentKeys.ROUTINE)) } catch (e: Exception) { null }
                override fun consentPub() = if (AgentKeys.hasConsentKey()) B64u.enc(AgentKeys.publicRaw(AgentKeys.CONSENT)) else null
            },
            managed = { (getSystemService(RESTRICTIONS_SERVICE) as RestrictionsManager).applicationRestrictions.size() > 0 },
        )
        render()
    }

    override fun onDestroy() { if (step != Step.DONE) setup?.abandon(); super.onDestroy() }

    private fun buildViews() {
        val pad = (16 * resources.displayMetrics.density).toInt()
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(pad, pad * 2, pad, pad) }
        col.addView(TextView(this).apply { setText(R.string.setup_title); textSize = 22f })
        status = TextView(this).apply { id = R.id.setup_status; setPadding(0, pad, 0, pad) }
        codeView = TextView(this).apply { id = R.id.setup_code; typeface = android.graphics.Typeface.MONOSPACE; textSize = 20f; setTextIsSelectable(false); visibility = View.GONE }
        input = EditText(this).apply { id = R.id.setup_input; setSingleLine(); inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS }
        action = Button(this).apply { id = R.id.setup_action; setOnClickListener { onAction() } }
        for (v in listOf(status, codeView, input, action)) col.addView(v, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        setContentView(col)
        // No screenshots or recents thumbnail of a screen that shows a recovery code.
        window.setFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE, android.view.WindowManager.LayoutParams.FLAG_SECURE)
    }

    private fun render(error: Int? = null) {
        codeView.visibility = View.GONE
        input.visibility = View.VISIBLE; input.text.clear(); action.isEnabled = true
        when (step) {
            Step.EMAIL -> { status.setText(error ?: R.string.setup_email_hint); input.setHint(R.string.setup_email_hint); input.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS; action.setText(R.string.setup_send) }
            Step.CODE -> { status.text = if (error != null) getString(error) else getString(R.string.setup_sent, address); input.setHint(R.string.setup_code_hint); input.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS; action.setText(R.string.setup_verify) }
            Step.RECOVERY_SHOWN -> { status.setText(R.string.setup_recovery_title); input.visibility = View.GONE; codeView.visibility = View.VISIBLE; action.setText(R.string.setup_recovery_written) }
            Step.RECOVERY_TYPE -> { status.setText(error ?: R.string.setup_recovery_type); input.setHint(R.string.setup_recovery_hint); input.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS; action.setText(R.string.setup_confirm) }
            Step.ENROLLING -> { status.setText(error ?: R.string.setup_enrolling); input.visibility = View.GONE; action.setText(R.string.setup_confirm) }
            Step.SAVING -> { status.setText(error ?: R.string.setup_saving); input.visibility = View.GONE; action.setText(R.string.setup_confirm) }
            Step.DONE -> {}
        }
    }

    /** Network and Argon2id both block: never on the main thread. */
    private fun background(work: () -> Unit) {
        action.isEnabled = false
        Thread { work() }.start()
    }

    private fun onAction() {
        val s = setup ?: return
        val text = input.text.toString()
        when (step) {
            Step.EMAIL -> background {
                val r = s.begin(text)
                runOnUiThread {
                    when (r) {
                        is IdentitySetup.Begin.Sent -> { address = r.address; step = Step.CODE; render() }
                        is IdentitySetup.Begin.Refused -> render(when (r.why) {
                            IdentitySetup.Why.MANAGED -> R.string.setup_err_managed
                            IdentitySetup.Why.MEMORY -> R.string.setup_err_memory
                            IdentitySetup.Why.ADDRESS -> R.string.setup_err_address
                            IdentitySetup.Why.OFFLINE -> R.string.setup_err_offline
                            IdentitySetup.Why.NO_DEVICE_KEY -> R.string.setup_err_nodevice
                            IdentitySetup.Why.DIRECTORY_REFUSED -> R.string.setup_err_refused
                            else -> R.string.setup_err_unverified
                        }.also { if (r.why == IdentitySetup.Why.SELF_CHECK) Log.e(TAG, "self-check failed: ${r.detail}") })
                    }
                }
            }
            Step.CODE -> background {
                val r = s.complete(text)
                runOnUiThread {
                    when (r) {
                        IdentitySetup.Complete.Ok -> { step = Step.RECOVERY_SHOWN; codeView.text = s.startRecovery(); render() }
                        IdentitySetup.Complete.BadFormat -> render(R.string.setup_err_code_format)
                        IdentitySetup.Complete.Rejected -> render(R.string.setup_err_code_wrong)
                        IdentitySetup.Complete.Offline -> render(R.string.setup_err_offline)
                        is IdentitySetup.Complete.Unverified, IdentitySetup.Complete.WrongStep -> { step = Step.EMAIL; render(R.string.setup_err_unverified) }
                    }
                    if (step == Step.RECOVERY_SHOWN) { status.setText(R.string.setup_recovery_title); codeView.visibility = View.VISIBLE }
                }
            }
            Step.RECOVERY_SHOWN -> { step = Step.RECOVERY_TYPE; codeView.text = ""; render() }
            Step.RECOVERY_TYPE -> background {
                val r = s.confirmRecovery(text)
                runOnUiThread {
                    when (r) {
                        IdentitySetup.Confirm.Ok -> { step = Step.ENROLLING; render(); enrol(s) }
                        is IdentitySetup.Confirm.Mistyped -> render(R.string.setup_err_mistyped)
                        is IdentitySetup.Confirm.Unavailable -> render(R.string.setup_err_memory)
                        else -> render(R.string.setup_err_unverified)
                    }
                }
            }
            Step.ENROLLING -> enrol(s)
            Step.SAVING -> save(s)
            Step.DONE -> {}
        }
    }

    /**
     * Registering the recovery code changes who can recover the account, so the consent key signs it
     * — inside a BiometricPrompt this very signature is bound to (a CryptoObject). The engine calls the
     * signer on this worker thread; the prompt runs on the main one.
     */
    private fun enrol(s: IdentitySetup) = background {
        val r = s.enrolRecovery { cns -> consentSign(cns) }
        runOnUiThread {
            enrolledResult = r
            Log.i(TAG, "ENROL " + r.javaClass.simpleName + (if (r is IdentitySetup.Enrolled.Refused) " ${r.reason}" else ""))
            step = Step.SAVING; render(); save(s)
        }
    }

    private fun consentSign(cns: String): String? {
        // The enrolment gate (§29b) comes before every consent: a changed biometric set is reported, not signed over.
        val device = B64u.enc(java.security.MessageDigest.getInstance("SHA-256").digest(AgentKeys.publicRaw(AgentKeys.ROUTINE))).take(16)
        if (AgentKeys.enrolmentGate(this, device, setOf(device), System.currentTimeMillis()) != Notices.Gate.PROCEED) return null
        val sig = try { AgentKeys.consentSignature() } catch (e: Exception) { Log.e(TAG, "consent key: $e"); return null }
        val latch = java.util.concurrent.CountDownLatch(1)
        var out: String? = null
        runOnUiThread {
            BiometricPrompt(this, ContextCompat.getMainExecutor(this), object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    out = try {
                        val s = result.cryptoObject!!.signature!!
                        s.update(cns.toByteArray(Charsets.UTF_8))
                        B64u.enc(Ecdsa.lowS(Ecdsa.derToRaw(s.sign()))).also { Log.i(TAG, "CONSENT SIGNED") }
                    } catch (e: Exception) { null }
                    latch.countDown()
                }
                override fun onAuthenticationError(code: Int, msg: CharSequence) { latch.countDown() }
            }).authenticate(promptInfo(R.string.setup_enrolling), BiometricPrompt.CryptoObject(sig))
        }
        latch.await()
        return out
    }

    private fun promptInfo(subtitle: Int): BiometricPrompt.PromptInfo {
        val authenticators = if (Build.VERSION.SDK_INT >= 30)
            BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.DEVICE_CREDENTIAL
        else BiometricManager.Authenticators.BIOMETRIC_STRONG
        return BiometricPrompt.PromptInfo.Builder().setTitle(getString(R.string.setup_title))
            .setSubtitle(getString(subtitle)).setAllowedAuthenticators(authenticators)
            .apply { if (Build.VERSION.SDK_INT < 30) setNegativeButtonText(getString(android.R.string.cancel)) }.build()
    }

    /** The account is sealed only inside an authentication the person just gave. */
    private fun save(s: IdentitySetup) {
        val cipher = try { AccountVault.sealCipher() } catch (e: Exception) { Log.e(TAG, "seal key: $e"); render(R.string.setup_err_nodevice); return }
        val info = promptInfo(R.string.setup_saving)
        BiometricPrompt(this, ContextCompat.getMainExecutor(this), object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                val c = result.cryptoObject?.cipher ?: return render(R.string.setup_err_not_saved)
                when (val f = s.finish(AccountVault.vault(this@SetupActivity, c))) {
                    is IdentitySetup.Finish.Done -> {
                        Log.i(TAG, "ACCOUNT SEALED")
                        step = Step.DONE; input.visibility = View.GONE; action.visibility = View.GONE
                        status.text = getString(R.string.setup_done, address) + "\n" +
                            getString(if (f.recoveryEnrolled) R.string.setup_done_recovery_ok else R.string.setup_done_recovery_pending)
                        Log.i(TAG, "SETUP DONE recoveryEnrolled=${f.recoveryEnrolled}")
                    }
                    else -> render(R.string.setup_err_not_saved)
                }
            }
            override fun onAuthenticationError(code: Int, msg: CharSequence) { render(R.string.setup_saving); action.isEnabled = true }
        }).authenticate(info, BiometricPrompt.CryptoObject(cipher))
    }

    companion object { const val TAG = "BentoSetup" }
}
