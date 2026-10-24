// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

package page.bento.home

import android.content.Context
import android.util.Log
import java.io.File

/**
 * Each app's signed release history (K4), as this device holds it: fetched
 * from bento.page, accepted only past the release-key signature and gate 1's
 * ANTI-ROLLBACK (a history that lacks or changes an entry already held, or
 * rolls the newest back, is refused). Kept in no-backup storage as the signed
 * envelope and re-verified on every read, so nothing on disk is trusted
 * because it is there.
 */
object ReleaseHistory {
    private const val TAG = "BentoTray"

    fun url(app: Releases.App) = "https://bento.page/releases/${app.id}/history.json"
    private fun file(c: Context, app: Releases.App) = File(File(c.noBackupFilesDir, "history"), "${app.id}.json")

    /** Verify an envelope under any trusted key; the parsed payload, or null. */
    internal fun verified(raw: String): Any? =
        HistoryKeys.trusted.firstNotNullOfOrNull { (x, y) -> Gate1.verifyEnvelope(raw, x, y) }

    /** The history this device holds for [app], verified again on read; null if none. */
    fun held(c: Context, app: Releases.App): Gate1.History? = heldPayload(c, app)?.let { Gate1.historyOf(it) }

    /**
     * The held history: the stored copy, or the one BUNDLED in the APK (vault),
     * which is the floor. Both are verified under the trusted keys on every read.
     * A bundle newer than the stored copy is adopted only as a forward move that
     * acceptHistory allows (an app update), so anti-rollback holds across both.
     */
    private fun heldPayload(c: Context, app: Releases.App): Any? {
        val stored = try {
            val f = file(c, app)
            if (!f.exists()) null else verified(f.readText())?.takeIf { (it as? Map<*, *>)?.get("app") == app.appId }
        } catch (e: Exception) { null }
        val bundledRaw = bundled(c, app) ?: return stored
        val bundle = verified(bundledRaw)?.takeIf { (it as? Map<*, *>)?.get("app") == app.appId } ?: return stored
        if (stored == null || Gate1.acceptHistory(stored, bundle, app.appId) is Gate1.Accept.Ok) return bundle
        return stored
    }

    /** The signed envelope the APK was built with (assets/history/<app>.json), or null. */
    private fun bundled(c: Context, app: Releases.App): String? = try {
        c.assets.open("history/${app.id}.json").use { String(it.readBytes(), Charsets.UTF_8) }
    } catch (e: Exception) { null }

    /**
     * Take an incoming envelope if its signature verifies and anti-rollback
     * accepts it over what is held. Returns null on success, else why not.
     */
    fun offer(c: Context, app: Releases.App, raw: String): String? {
        val incoming = verified(raw) ?: return "the history's signature does not verify"
        val verdict = Gate1.acceptHistory(heldPayload(c, app), incoming, app.appId)
        if (verdict is Gate1.Accept.No) return verdict.reason
        val f = file(c, app)
        f.parentFile?.mkdirs()
        val tmp = File(f.parentFile, f.name + ".tmp")
        tmp.writeText(raw)
        if (!tmp.renameTo(f)) return "could not store the history"
        return null
    }

    /**
     * Fetch and offer the newest published history. Network: call off the main
     * thread. Called ONLY on a contact the person starts: a New document (for
     * [app]) or "Check for updates". Opening a document never phones home.
     */
    /** Returns false only when bento.page could not be reached; a refused or unpublished history is a reached server. */
    fun refresh(c: Context, app: Releases.App): Boolean {
        val raw = try { String(Releases.get(url(app)), Charsets.UTF_8) } catch (e: Releases.Failed) {
            // reached, but nothing published for this app yet (or refused): the held one stands
            Log.i(TAG, "release history for ${app.id} unavailable: ${e.message}"); return true
        } catch (e: Exception) {
            Log.i(TAG, "release history for ${app.id}: offline (${e.message})"); return false
        }
        val why = offer(c, app, raw)
        if (why != null) Log.w(TAG, "release history for ${app.id} not taken: $why")
        return true
    }

    /**
     * Gate 1 for the bytes this host is about to serve: GENUINE with a CSP only
     * when one release in a held, verified history matches every block. Tried
     * against EVERY app's history, never chosen from the document's format: a
     * sealed document says "bento/enc" and a never-saved shell says nothing, and
     * gate 1 is about the runtime, not the content. Apps' runtimes differ, so at
     * most one can match; two would be UNKNOWN.
     */
    fun verdict(c: Context, bytes: ByteArray): Gate1.Verdict {
        val held = Releases.APPS.mapNotNull { held(c, it) }
        if (held.isEmpty()) return Gate1.Verdict.Unknown("no release history held")
        return Gate1.verifyServedHeld(String(bytes, Charsets.UTF_8), held)
    }
}
