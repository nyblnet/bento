// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

package page.bento.probe.origin

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.os.CancellationSignal
import android.text.InputType
import android.util.Log
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.view.WindowInsets
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.credentials.CreateCredentialResponse
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.CredentialManager
import androidx.credentials.CredentialManagerCallback
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetCredentialResponse
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.CreateCredentialException
import androidx.credentials.exceptions.GetCredentialException
import java.security.SecureRandom
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * One screen: the relying party (editable), Create, Sign in, Copy results, and
 * the running report. Everything shown is also in the copied text, and every
 * line goes to logcat under "OriginProbe" for an adb session.
 */
class ProbeActivity : Activity() {
    private val random = SecureRandom()
    private lateinit var rpField: EditText
    private lateinit var report: TextView
    private lateinit var scroll: ScrollView
    private val lines = ArrayList<String>()
    private var credentialId: String? = null
    private val certs: List<ByteArray> by lazy { signingCerts() }
    private val expectedOrigins: List<String> by lazy { certs.map { Probe.apkKeyHashOrigin(it) } }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val pad = (16 * resources.displayMetrics.density).toInt()
        val column = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(pad, pad, pad, pad) }
        column.addView(TextView(this).apply { text = "Relying party id"; textSize = 14f })
        rpField = EditText(this).apply {
            setText(DEFAULT_RP); isSingleLine = true
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
        }
        column.addView(rpField, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        fun button(label: String, onClick: () -> Unit) = Button(this).apply { text = label; isAllCaps = false; setOnClickListener { onClick() } }
            .also { row.addView(it, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f)) }
        button("Create") { create() }
        button("Sign in") { signIn() }
        button("Copy results") { copy() }
        column.addView(row, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        report = TextView(this).apply { typeface = Typeface.MONOSPACE; textSize = 12f; setTextIsSelectable(true) }
        column.addView(report, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        scroll = ScrollView(this).apply { addView(column) }
        // targetSdk 35+ draws edge to edge: keep the controls out of the status and navigation bars.
        scroll.setOnApplyWindowInsetsListener { v, insets ->
            val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom); insets
        }
        setContentView(scroll)
        header()
    }

    private fun header() {
        add("== passkey origin probe ${appVersion()} · ${SimpleDateFormat("yyyy-MM-dd HH:mm:ss Z", Locale.ROOT).format(Date())}")
        add("device: ${Build.MANUFACTURER} ${Build.MODEL} · Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})")
        add("package: $packageName")
        certs.forEachIndexed { i, c -> add("signing cert ${i + 1} SHA-256: ${Probe.colonHex(Probe.sha256(c))}") }
        expectedOrigins.forEach { add("expected origin: $it") }
        add("")
        add("https://${rp()}/.well-known/assetlinks.json must contain:")
        add(Probe.assetlinks(packageName, certs.map { Probe.sha256(it) }))
        add("check what Google sees: ${Probe.assetlinksCheckUrl(rp())}")
    }

    private fun rp(): String = rpField.text.toString().trim().ifEmpty { DEFAULT_RP }

    private fun create() {
        val rp = rp()
        val challenge = ByteArray(32).also { random.nextBytes(it) }
        val user = ByteArray(16).also { random.nextBytes(it) }
        val name = "origin-probe-" + SimpleDateFormat("MMdd-HHmmss", Locale.ROOT).format(Date())
        val json = Probe.createRequestJson(rp, challenge, user, name)
        add(""); add("== Create, rp $rp, user $name")
        add("request: $json")
        CredentialManager.create(this).createCredentialAsync(this, CreatePublicKeyCredentialRequest(json), CancellationSignal(), mainExecutor,
            object : CredentialManagerCallback<CreateCredentialResponse, CreateCredentialException> {
                override fun onResult(result: CreateCredentialResponse) {
                    val r = result as? CreatePublicKeyCredentialResponse
                    if (r == null) { add("unexpected response type ${result.type}"); return }
                    val rep = Probe.registration(r.registrationResponseJson, rp, challenge, expectedOrigins)
                    rep.lines.forEach { add(it) }
                    rep.credentialId?.let { credentialId = it }
                    add("response (raw): ${r.registrationResponseJson}")
                }
                override fun onError(e: CreateCredentialException) {
                    add("FAILED ${e.type}: ${e.errorMessage}")
                    if (!e.type.contains("CANCELED"))
                        add("(an error naming the rp, the origin or the association usually means assetlinks.json above is missing or different)")
                }
            })
    }

    private fun signIn() {
        val rp = rp()
        val challenge = ByteArray(32).also { random.nextBytes(it) }
        val json = Probe.getRequestJson(rp, challenge, credentialId)
        add(""); add("== Sign in, rp $rp" + if (credentialId == null) " (any passkey for this rp)" else " (the passkey just created)")
        add("request: $json")
        CredentialManager.create(this).getCredentialAsync(this, GetCredentialRequest(listOf(GetPublicKeyCredentialOption(json))), CancellationSignal(), mainExecutor,
            object : CredentialManagerCallback<GetCredentialResponse, GetCredentialException> {
                override fun onResult(result: GetCredentialResponse) {
                    val c = result.credential as? PublicKeyCredential
                    if (c == null) { add("unexpected credential type ${result.credential.type}"); return }
                    Probe.assertion(c.authenticationResponseJson, rp, challenge, expectedOrigins).lines.forEach { add(it) }
                    add("response (raw): ${c.authenticationResponseJson}")
                }
                override fun onError(e: GetCredentialException) {
                    add("FAILED ${e.type}: ${e.errorMessage}")
                }
            })
    }

    private fun copy() {
        getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("origin probe results", lines.joinToString("\n")))
        Toast.makeText(this, "Results copied", Toast.LENGTH_SHORT).show()
    }

    private fun add(line: String) {
        lines += line
        Log.i(TAG, line)
        report.text = lines.joinToString("\n")
        report.post { scroll.scrollTo(0, report.bottom) }
    }

    private fun appVersion(): String = packageManager.getPackageInfo(packageName, 0).versionName ?: "?"

    private fun signingCerts(): List<ByteArray> {
        val info = packageManager.getPackageInfo(packageName, PackageManager.GET_SIGNING_CERTIFICATES).signingInfo ?: return emptyList()
        val signers = if (info.hasMultipleSigners()) info.apkContentsSigners else info.signingCertificateHistory
        return signers.map { it.toByteArray() }
    }

    companion object {
        const val TAG = "OriginProbe"
        const val DEFAULT_RP = "id.bento.page"
    }
}
