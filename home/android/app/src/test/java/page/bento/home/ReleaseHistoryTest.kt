// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

package page.bento.home

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.File
import java.io.IOException

/**
 * "Check for updates" outcomes: what one contact with bento.page came to, and
 * what the person is told across every app. The UNVERIFIED rows run the real
 * signature check (ReleaseHistory.verified, under the pinned keys) over the
 * frozen real slides history, untouched and with one payload byte changed.
 */
class ReleaseHistoryTest {
    private val real = File("../../../home/fixtures/gate1/real/slides-1.2.10/history.json").readText()
    private val tampered = run {
        val env = HistoryJson.read(real) as Map<*, *>
        val p = env["payload"] as String
        val i = p.indexOf("1.2.10")
        check(i >= 0) { "the real history names 1.2.10" }
        HistoryJson.write(mapOf("payload" to p.replaceRange(i, i + 6, "1.2.19"), "sig" to env["sig"]))
    }
    /** offer()'s first step: a reply whose signature does not verify is UNVERIFIED. */
    private val verifyOnly: (String) -> String? = { if (ReleaseHistory.verified(it) == null) ReleaseHistory.UNVERIFIED else null }
    private fun classify(fetch: () -> ByteArray, take: (String) -> String? = verifyOnly) =
        ReleaseHistory.classify("slides", fetch, take)

    @Test fun `the real history verifies under the pinned keys and a one-byte change does not`() {
        assertNotNull(ReleaseHistory.verified(real))
        assertNull(ReleaseHistory.verified(tampered))
    }

    @Test fun `a reply that verifies is a reached server`() {
        assertEquals(ReleaseHistory.Outcome.REACHED, classify({ real.toByteArray() }))
    }

    @Test fun `a reply whose signature does not verify is UNVERIFIED, never reached`() {
        assertEquals(ReleaseHistory.Outcome.UNVERIFIED, classify({ tampered.toByteArray() }))
        assertEquals(ReleaseHistory.Outcome.UNVERIFIED, classify({ "not json".toByteArray() }))
    }

    @Test fun `a refused or unpublished history is reached, not unverified`() {
        assertEquals(ReleaseHistory.Outcome.REACHED, classify({ throw Releases.Failed("the release server answered 404") }))
        // verified, but anti-rollback refused it: the held one stands, the server was reached
        assertEquals(ReleaseHistory.Outcome.REACHED, classify({ real.toByteArray() }, { "it rolls the newest back" }))
    }

    @Test fun `an unreachable server is OFFLINE`() {
        assertEquals(ReleaseHistory.Outcome.OFFLINE, classify({ throw IOException("Unable to resolve host") }))
    }

    @Test fun `across apps the worst outcome is what the person is told`() {
        val (r, o, u) = Triple(ReleaseHistory.Outcome.REACHED, ReleaseHistory.Outcome.OFFLINE, ReleaseHistory.Outcome.UNVERIFIED)
        assertEquals(r, ReleaseHistory.summary(listOf(r, r, r)))
        assertEquals(o, ReleaseHistory.summary(listOf(r, o, r)))
        assertEquals(u, ReleaseHistory.summary(listOf(r, u, r)))
        assertEquals(u, ReleaseHistory.summary(listOf(o, u, r)))
        assertEquals(u, ReleaseHistory.summary(listOf(u, o)))
    }

    @Test fun `the person is told the maintainer's words, worst outcome first`() {
        val xml = File("src/main/res/values/strings.xml").readText()
        fun text(name: String) = Regex("""<string name="$name">(.*?)</string>""").find(xml)!!.groupValues[1].replace("\\'", "'")
        val words = mapOf(
            R.string.check_updates to ("check_updates" to "Check for updates"),
            R.string.updates_up_to_date to ("updates_up_to_date" to "Up to date"),
            R.string.updates_offline to ("updates_offline" to "Couldn't reach bento.page"),
            R.string.updates_unverified to ("updates_unverified" to "The reply from bento.page couldn't be verified"),
        )
        for ((name, want) in words.values) assertEquals(name, want, text(name))
        val (r, o, u) = Triple(ReleaseHistory.Outcome.REACHED, ReleaseHistory.Outcome.OFFLINE, ReleaseHistory.Outcome.UNVERIFIED)
        assertEquals(R.string.updates_up_to_date, ReleaseHistory.message(listOf(r, r, r)))
        assertEquals(R.string.updates_offline, ReleaseHistory.message(listOf(r, o, r)))
        assertEquals(R.string.updates_unverified, ReleaseHistory.message(listOf(o, u, r)))
        assertEquals(R.string.updates_unverified, ReleaseHistory.message(listOf(u, r)))
        assertEquals("no outcome is never up to date", R.string.updates_offline, ReleaseHistory.message(emptyList()))
        assertEquals(o, ReleaseHistory.summary(emptyList()))
    }
}
