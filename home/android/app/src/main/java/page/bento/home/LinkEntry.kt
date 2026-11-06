// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

package page.bento.home

import java.net.URI

/**
 * What an `https://id.bento.page/l#CODE` link may start (security §39.1 condition 1).
 *
 * The H side hands out the account, so it starts ONLY from the in-app "Link a new device" action. A
 * link or a camera intent can start the N side, and only on a device that holds no account; on a
 * device that does, it starts nothing and says where to go instead. Nothing in the manifest handles
 * such a link yet; this is the rule that a handler must call, with the device's own state.
 */
object LinkEntry {
    sealed class Entry {
        /** Start the N side with this code. */
        class NewDevice(val code: String) : Entry()
        /** This device holds an account: start nothing; show "open Bento ID, then Link a new device". */
        object OpenTheAppInstead : Entry()
        object NotALink : Entry()
    }

    fun fromLink(link: String, holdsAccount: Boolean): Entry {
        val u = try { URI(link) } catch (e: Exception) { return Entry.NotALink }
        if (u.scheme != "https" || u.host != "id.bento.page" || u.path != "/l" || u.rawFragment == null) return Entry.NotALink
        if (u.rawQuery != null || u.rawUserInfo != null || u.port != -1) return Entry.NotALink
        if (Link.parseCode(u.rawFragment) !is Recovery.Parsed.Ok) return Entry.NotALink
        return if (holdsAccount) Entry.OpenTheAppInstead else Entry.NewDevice(u.rawFragment)
    }
}
