// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

package page.bento.home

/**
 * DEBUG BUILDS ONLY: the release key, plus a throwaway test key, so a history
 * signed for an emulator test can be installed before any real history exists.
 * src/release has its own HistoryKeys with the release key alone; this file is
 * never compiled into a release.
 */
internal object HistoryKeys {
    val trusted: List<Pair<String, String>> = listOf(
        Releases.KEY_X to Releases.KEY_Y,
        "UDNWDLyLVcxJZZ6Kyi0y-eTUEDMB5zB6jVX8NOSjNlk" to "YqKJ4y20DcNjMhnPQQj8NuFiI-suqB4eFCs-9n_G3eI",
    )
}
