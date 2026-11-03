// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

package page.bento.home

import android.graphics.Bitmap
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter

/**
 * Link a device (link v1), either end. The engine is [LinkAgent]; this is only the screen.
 *
 *  - ROLE H ("Link a new device"): this device holds the account. The code and a QR are shown; the
 *    person types the six digits the NEW device shows (one attempt), looks at what is asking, and
 *    approves with a fingerprint or screen lock.
 *  - ROLE N ("Link this device to an account"): this device holds none. The person types the address
 *    and the code (or scans the QR with the Google code scanner), reads out the six digits, and the
 *    account arrives sealed by this device's own authentication.
 *
 * H starts ONLY from the in-app action: the activity is not exported and nothing in the manifest
 * routes a link to it ([LinkEntry] is the rule a link handler must call). The role is also checked
 * against this device's own state inside [LinkAgent]: an intent cannot make a device H. Like
 * [SetupActivity] it has NO entry point in a release build; a dev build exports it and reads
 *   --es role H|N   --es directory <url>   --es kid <dir kid>   --es pub <directory public key>
 * from the launching intent. With no pinned key a release build refuses.
 */
class LinkActivity : AppCompatActivity() {
    private val devBuild get() = packageManager.getActivityInfo(componentName, android.content.pm.PackageManager.GET_META_DATA)
        .metaData?.getBoolean("bento.setup.dev", false) == true

    private lateinit var status: TextView
    private lateinit var codeView: TextView
    private lateinit var sasView: TextView
    private lateinit var qr: ImageView
    private lateinit var input: EditText
    private lateinit var input2: EditText
    private lateinit var action: Button
    private lateinit var scan: Button
    private var agent: LinkAgent? = null
    private var role = Link.Role.N
    private var pins: Map<String, String> = emptyMap()
    private var done = false
    private var holder: LinkAgent.Holder? = null
    private var offer: Link.Offer? = null
    private var step = Step.START
    private enum class Step { START, H_WAIT, H_SAS, H_CONFIRM, N_INPUT, N_SAS, DONE }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        buildViews()
        role = if (devBuild && intent.getStringExtra("role") == "N") Link.Role.N
        else if (intent.getStringExtra("role") == "H") Link.Role.H else Link.Role.N
        pins = if (devBuild) { val k = intent.getStringExtra("kid"); val p = intent.getStringExtra("pub"); if (k != null && p != null) mapOf(k to p) else emptyMap() } else emptyMap()
        val url = if (devBuild) intent.getStringExtra("directory") else null
        if (pins.isEmpty() || url == null) { unavailable(); return }
        AgentKeys.ensure(this)
        agent = LinkAgent(role, HttpLinkDirectory(url, allowDevHttp = devBuild), holdsAccount = { AccountVault.exists(this) })
        if (role == Link.Role.H) startH() else { step = Step.N_INPUT; render() }
    }

    override fun onDestroy() { if (!done) agent?.abandon(); super.onDestroy() }

    private fun unavailable() { status.setText(R.string.link_unavailable_here); for (v in listOf(input, input2, action, scan, sasView, codeView, qr)) v.visibility = View.GONE }

    private fun buildViews() {
        val pad = (16 * resources.displayMetrics.density).toInt()
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(pad, pad * 2, pad, pad) }
        col.addView(TextView(this).apply { setText(R.string.link_title); textSize = 22f })
        status = TextView(this).apply { id = R.id.link_status; setPadding(0, pad, 0, pad) }
        codeView = TextView(this).apply { id = R.id.link_code; typeface = android.graphics.Typeface.MONOSPACE; textSize = 20f; visibility = View.GONE }
        sasView = TextView(this).apply { id = R.id.link_sas; typeface = android.graphics.Typeface.MONOSPACE; textSize = 36f; visibility = View.GONE }
        qr = ImageView(this).apply { id = R.id.link_qr; visibility = View.GONE; adjustViewBounds = true }
        input = EditText(this).apply { id = R.id.link_input; setSingleLine() }
        input2 = EditText(this).apply { id = R.id.link_input2; setSingleLine(); visibility = View.GONE }
        action = Button(this).apply { id = R.id.link_action; setOnClickListener { onAction() } }
        scan = Button(this).apply { id = R.id.link_scan; setText(R.string.link_scan); visibility = View.GONE; setOnClickListener { scanQr() } }
        for (v in listOf(status, codeView, qr, sasView, input, input2, scan, action)) col.addView(v, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        setContentView(col)
        window.setFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE, android.view.WindowManager.LayoutParams.FLAG_SECURE)
    }

    private fun render(message: Int? = null, vararg args: Any) {
        val text = message?.let { getString(it, *args) }
        input.visibility = View.GONE; input2.visibility = View.GONE; scan.visibility = View.GONE; action.visibility = View.VISIBLE; action.isEnabled = true
        codeView.visibility = View.GONE; qr.visibility = View.GONE; sasView.visibility = View.GONE
        when (step) {
            Step.START -> { status.text = text ?: getString(R.string.link_h_start); action.setText(R.string.link_h_begin) }
            Step.H_WAIT -> { status.text = text ?: getString(R.string.link_h_show); action.visibility = View.GONE; codeView.visibility = View.VISIBLE; qr.visibility = View.VISIBLE }
            Step.H_SAS -> { status.text = text ?: getString(R.string.link_h_type_sas); input.visibility = View.VISIBLE; input.text.clear(); input.hint = getString(R.string.link_sas_hint)
                input.inputType = InputType.TYPE_CLASS_NUMBER; action.setText(R.string.link_continue) }
            Step.H_CONFIRM -> {
                val o = offer!!
                val kind = Link.platformLabel(o.platform) ?: getString(R.string.link_platform_unknown)
                status.text = text ?: getString(R.string.link_h_confirm, kind)
                input.visibility = View.VISIBLE; input.setText(o.label ?: ""); input.hint = getString(R.string.link_label_hint); input.inputType = InputType.TYPE_CLASS_TEXT
                action.setText(R.string.link_h_approve)
            }
            Step.N_INPUT -> { status.text = text ?: getString(R.string.link_n_start); input.visibility = View.VISIBLE; input2.visibility = View.VISIBLE; scan.visibility = View.VISIBLE
                input.hint = getString(R.string.setup_email_hint); input.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS
                input2.hint = getString(R.string.link_code_hint); input2.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS
                action.setText(R.string.link_n_begin) }
            Step.N_SAS -> { status.text = text ?: getString(R.string.link_n_sas); sasView.visibility = View.VISIBLE; action.visibility = View.GONE }
            Step.DONE -> { status.text = text ?: ""; action.visibility = View.GONE }
        }
    }

    private fun background(work: () -> Unit) { action.isEnabled = false; Thread { work() }.start() }
    private fun ui(f: () -> Unit) = runOnUiThread { if (!isDestroyed) f() }

    private fun failure(f: LinkAgent.Step.Fail): Int {
        Log.i(TAG, "LINK FAIL ${f.why} ${f.detail}")
        return when (f.why) {
            LinkAgent.Why.ROLE -> R.string.link_err_role
            LinkAgent.Why.BAD_CODE -> R.string.link_err_code
            LinkAgent.Why.CONTENDED -> R.string.link_err_contended
            LinkAgent.Why.SAS -> R.string.link_err_sas
            LinkAgent.Why.OFFLINE -> R.string.setup_err_offline
            LinkAgent.Why.NO_CONSENT -> R.string.link_err_noconsent
            LinkAgent.Why.DECLINED -> R.string.link_err_declined
            LinkAgent.Why.UNVERIFIED -> R.string.link_err_unverified
            else -> R.string.link_err_gone
        }
    }

    /** A failed link is over: a retry is a NEW slot with a NEW code, never a second go on this one. */
    private fun ended(f: LinkAgent.Step.Fail) { step = Step.DONE; render(failure(f)) }

    private fun onAction() {
        val a = agent ?: return
        when (step) {
            Step.START -> startH()
            Step.H_SAS -> { val typed = input.text.toString(); background {
                when (val r = a.enterSas(typed)) {
                    is LinkAgent.Step.Fail -> ui { ended(r) }
                    is LinkAgent.Step.Ok -> when (val o = a.readOffer(120_000)) {
                        is LinkAgent.Step.Fail -> ui { ended(o) }
                        is LinkAgent.Step.Ok -> ui { offer = o.value; step = Step.H_CONFIRM; render() }
                    }
                } } }
            Step.H_CONFIRM -> { val label = input.text.toString().trim().ifEmpty { null }; background {
                val r = a.approve(holder!!, label) { cns -> consentSign(cns, R.string.link_h_prompt) }
                ui {
                    when (r) {
                        is LinkAgent.Step.Fail -> ended(r)
                        is LinkAgent.Step.Ok -> { done = true; step = Step.DONE; render(R.string.link_h_done); Log.i(TAG, "LINK DONE H") }
                    }
                    holder?.let { it.accountScalar.fill(0); it.recoveryKxScalar.fill(0) }; holder = null
                } } }
            Step.N_INPUT -> beginN(input.text.toString(), input2.text.toString())
            else -> {}
        }
    }

    // ---- H -----------------------------------------------------------------------------------------

    /** "Link a new device": unseal the account (a person-present authentication), show the code, wait. */
    private fun startH() {
        val cipher = try { AccountVault.openCipher(this) } catch (e: Exception) { null }
        if (cipher == null) { step = Step.DONE; render(R.string.link_err_role); return }
        authenticate(cipher, R.string.link_h_unseal, onFail = { step = Step.START; render(R.string.link_err_declined) }) { c ->
            val h = AccountVault.holder(this, c)
            if (h == null) { step = Step.DONE; render(R.string.link_err_role); return@authenticate }
            holder = h
            background {
                when (val s = agent!!.display()) {
                    is LinkAgent.Step.Fail -> ui { ended(s) }
                    is LinkAgent.Step.Ok -> {
                        ui { step = Step.H_WAIT; render(); codeView.text = s.value.code; qr.setImageBitmap(qrBitmap(s.value.qr)) }
                        when (val w = agent!!.awaitScanner(600_000)) {
                            is LinkAgent.Step.Fail -> ui { ended(w) }
                            is LinkAgent.Step.Ok -> ui { step = Step.H_SAS; render() }
                        }
                    }
                }
            }
        }
    }

    // ---- N -----------------------------------------------------------------------------------------

    private fun scanQr() {
        val options = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
        GmsBarcodeScanning.getClient(this, options).startScan()
            .addOnSuccessListener { b -> input2.setText(b.rawValue ?: "") }
            .addOnFailureListener { Log.i(TAG, "scanner: $it") }
    }

    private fun beginN(address: String, code: String) = background {
        val a = agent!!
        val addr = (Address.normalize(address) as? Address.Result.Ok)?.address
        if (addr == null) { ui { render(R.string.setup_err_address) }; return@background }
        when (val s = a.scan(code)) {
            is LinkAgent.Step.Fail -> ui { if (s.why == LinkAgent.Why.BAD_CODE) render(R.string.link_err_code) else ended(s) }
            is LinkAgent.Step.Ok -> {
                ui { step = Step.N_SAS; render(); sasView.text = a.sas() }
                val proofs = object : LinkAgent.Proofs {
                    override fun routinePub() = try { B64u.enc(AgentKeys.publicRaw(AgentKeys.ROUTINE)) } catch (e: Exception) { null }
                    override fun consentPub() = if (AgentKeys.hasConsentKey()) B64u.enc(AgentKeys.publicRaw(AgentKeys.CONSENT)) else null
                    override fun signRoutine(text: String) = try { B64u.enc(AgentKeys.signRoutine(text.toByteArray(Charsets.UTF_8))) } catch (e: Exception) { null }
                    override fun signConsent(text: String) = consentSign(text, R.string.link_n_prompt)
                }
                val label = android.os.Build.MODEL
                when (val o = a.sendOffer(proofs, label)) {
                    is LinkAgent.Step.Fail -> { ui { ended(o) }; return@background }
                    is LinkAgent.Step.Ok -> {}
                }
                when (val f = a.awaitFinal(addr, pins, 600_000)) {
                    is LinkAgent.Step.Fail -> ui { ended(f) }
                    is LinkAgent.Step.Ok -> ui { saveN(f.value) }
                }
            }
        }
    }

    /** The account is sealed only inside an authentication the person just gave. */
    private fun saveN(linked: LinkAgent.Linked) {
        val cipher = try { AccountVault.sealCipher() } catch (e: Exception) { step = Step.DONE; render(R.string.setup_err_nodevice); return }
        authenticate(cipher, R.string.setup_saving, onFail = { step = Step.DONE; render(R.string.setup_err_not_saved) }) { c ->
            val ok = try { AccountVault.vault(this, c).save(linked.record(), linked.secrets) } finally { linked.secrets.fill(0) }
            done = true; step = Step.DONE
            if (ok) { render(R.string.link_n_done, linked.address); Log.i(TAG, "LINK DONE N ACCOUNT SEALED label=${linked.label}") } else render(R.string.setup_err_not_saved)
        }
    }

    // ---- prompts -------------------------------------------------------------------------------------

    private fun promptInfo(subtitle: Int): BiometricPrompt.PromptInfo {
        val authenticators = if (Build.VERSION.SDK_INT >= 30)
            BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.DEVICE_CREDENTIAL
        else BiometricManager.Authenticators.BIOMETRIC_STRONG
        return BiometricPrompt.PromptInfo.Builder().setTitle(getString(R.string.link_title)).setSubtitle(getString(subtitle))
            .setAllowedAuthenticators(authenticators).apply { if (Build.VERSION.SDK_INT < 30) setNegativeButtonText(getString(android.R.string.cancel)) }.build()
    }

    private fun authenticate(cipher: javax.crypto.Cipher, subtitle: Int, onFail: () -> Unit, then: (javax.crypto.Cipher) -> Unit) {
        BiometricPrompt(this, ContextCompat.getMainExecutor(this), object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) { then(result.cryptoObject!!.cipher!!) }
            override fun onAuthenticationError(code: Int, msg: CharSequence) { onFail() }
        }).authenticate(promptInfo(subtitle), BiometricPrompt.CryptoObject(cipher))
    }

    /** A consent-key signature, bound to ONE person-present prompt (the enrolment gate first, §29b). */
    private fun consentSign(text: String, subtitle: Int): String? {
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
                        s.update(text.toByteArray(Charsets.UTF_8))
                        B64u.enc(Ecdsa.lowS(Ecdsa.derToRaw(s.sign())))
                    } catch (e: Exception) { null }
                    latch.countDown()
                }
                override fun onAuthenticationError(code: Int, msg: CharSequence) { latch.countDown() }
            }).authenticate(promptInfo(subtitle), BiometricPrompt.CryptoObject(sig))
        }
        latch.await()
        return out
    }

    private fun qrBitmap(text: String): Bitmap {
        val m = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 512, 512)
        val bmp = Bitmap.createBitmap(m.width, m.height, Bitmap.Config.ARGB_8888)
        for (x in 0 until m.width) for (y in 0 until m.height) bmp.setPixel(x, y, if (m.get(x, y)) Color.BLACK else Color.WHITE)
        return bmp
    }

    companion object { const val TAG = "BentoLink" }
}
