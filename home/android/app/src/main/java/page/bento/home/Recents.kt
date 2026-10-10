// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

package page.bento.home

import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.net.Uri
import org.json.JSONArray
import org.json.JSONObject

/**
 * The documents this app has been given durable access to.
 *
 * iOS gets a system document browser for free — `UIDocumentBrowserViewController`
 * shows the whole Files hierarchy and hands back security-scoped URLs. Android
 * has no hostable equivalent: the system picker is a one-shot dialog, not a
 * surface an app can live in. So the app keeps its own list, and each entry is
 * backed by a **persistable URI permission** — the Android analogue of a
 * security-scoped bookmark, and the thing that makes reopening a document
 * tomorrow work without asking again.
 *
 * The list is a CACHE OF GRANTS, never a store of documents. Nothing here is
 * authoritative: the grant lives in the system, the bytes live wherever the user
 * put them, and [prune] drops any entry whose grant the system no longer holds.
 */
object Recents {
    private const val PREFS = "recents"
    private const val KEY = "documents"
    private const val LIMIT = 40

    data class Entry(val uri: Uri, val name: String, val openedAt: Long)

    private fun prefs(c: Context) = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun list(c: Context): List<Entry> {
        val raw = prefs(c).getString(KEY, null) ?: return emptyList()
        val out = ArrayList<Entry>()
        try {
            val arr = JSONArray(raw)
            for (i in 0 until arr.length()) {
                val o = arr.getJSONObject(i)
                out += Entry(Uri.parse(o.getString("uri")), o.getString("name"), o.optLong("at"))
            }
        } catch (_: Exception) {
            return emptyList()
        }
        return out.sortedByDescending { it.openedAt }
    }

    /** Record a document as opened, moving an existing entry to the top. */
    fun touch(c: Context, uri: Uri, name: String) {
        val kept = list(c).filter { it.uri != uri }
        val next = (listOf(Entry(uri, name, System.currentTimeMillis())) + kept).take(LIMIT)
        save(c, next)
    }

    fun forget(c: Context, uri: Uri) {
        save(c, list(c).filter { it.uri != uri })
        // Hand the grant back. Keeping it would spend one of the system's
        // per-app persisted-permission slots on a document the user has said
        // they are done with.
        try {
            c.contentResolver.releasePersistableUriPermission(
                uri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            )
        } catch (_: SecurityException) {
            // Already gone — the grant is the system's to hold, not ours.
        }
    }

    /**
     * Drop entries whose grant no longer exists.
     *
     * Grants die for ordinary reasons — the user cleared app storage, revoked
     * access, deleted the file, or the provider was uninstalled — and a dead
     * entry that still looks alive is worse than no entry: it opens to an error
     * instead of a document.
     */
    fun prune(c: Context): List<Entry> {
        val held = c.contentResolver.persistedUriPermissions.map { it.uri }.toHashSet()
        val alive = list(c).filter { it.uri in held }
        if (alive.size != list(c).size) save(c, alive)
        return alive
    }

    /**
     * Take a durable grant on a URI the user has just picked.
     *
     * Returns whether WRITE survived. Read is assumed — an incoming URI we
     * cannot read is not a document — but write is the interesting half, since
     * it decides whether this document can be saved in place at all.
     */
    fun persist(resolver: ContentResolver, uri: Uri, flags: Int): Boolean {
        val wanted = flags and
            (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        return try {
            resolver.takePersistableUriPermission(uri, wanted)
            wanted and Intent.FLAG_GRANT_WRITE_URI_PERMISSION != 0
        } catch (_: SecurityException) {
            // Not every provider offers persistable grants, and an ACTION_VIEW
            // sender usually does not flag them persistable at all. The document
            // still opens for this session; it just will not be in recents.
            false
        }
    }

    private fun save(c: Context, entries: List<Entry>) {
        val arr = JSONArray()
        entries.forEach {
            arr.put(JSONObject().put("uri", it.uri.toString()).put("name", it.name).put("at", it.openedAt))
        }
        prefs(c).edit().putString(KEY, arr.toString()).apply()
    }
}
