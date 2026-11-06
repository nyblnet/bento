// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

package page.bento.home

import org.junit.Assert.assertTrue
import org.junit.Test

/** Run-it row (e) of security §39.1: a link on a device that holds an account starts no H flow, and no flow at all. */
class LinkEntryTest {
    private val code = "24H3-6H2N-CSVR-H6DA-9"
    private val link = "https://id.bento.page/l#$code"

    @Test fun `a link starts the N side on a device with no account`() {
        val e = LinkEntry.fromLink(link, holdsAccount = false)
        assertTrue(e is LinkEntry.Entry.NewDevice && Link.parseCode(e.code) is Recovery.Parsed.Ok)
    }

    @Test fun `the same link on a device that holds an account starts nothing`() {
        assertTrue(LinkEntry.fromLink(link, holdsAccount = true) === LinkEntry.Entry.OpenTheAppInstead)
    }

    @Test fun `no link ever yields the H side - there is no such entry`() {
        // every shape of link, on both kinds of device: the only outcomes are N, nothing, or not-a-link
        for (l in listOf(link, "$link ", "http://id.bento.page/l#$code", "https://id.bento.page/l?x=1#$code", "https://evil.example/l#$code",
            "https://id.bento.page.evil.example/l#$code", "https://id.bento.page/l", "https://id.bento.page/l#BAD", "https://user@id.bento.page/l#$code", "")) {
            for (holds in listOf(false, true)) {
                val e = LinkEntry.fromLink(l, holds)
                assertTrue("$l $holds", e is LinkEntry.Entry.NewDevice && !holds || e === LinkEntry.Entry.OpenTheAppInstead && holds || e === LinkEntry.Entry.NotALink)
            }
        }
    }

    @Test fun `lookalike hosts and malformed codes are not links`() {
        for (l in listOf("http://id.bento.page/l#$code", "https://id.bento.page.evil.example/l#$code", "https://evil.example/l#$code",
            "https://id.bento.page/l?x=1#$code", "https://id.bento.page/l#BAD")) assertTrue(l, LinkEntry.fromLink(l, false) === LinkEntry.Entry.NotALink)
    }
}
