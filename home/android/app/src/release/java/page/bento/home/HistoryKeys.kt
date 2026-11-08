// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

package page.bento.home

/** RELEASE builds: the signed release history is trusted under the release key only. */
internal object HistoryKeys {
    val trusted: List<Pair<String, String>> = listOf(Releases.KEY_X to Releases.KEY_Y)
}
