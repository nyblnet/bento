# slides/probe

Manual browser rigs. Not run by CI — these exist for defects that only a
human eye, on a specific engine and platform, can judge.

## radical-join.html

The square root's hook not meeting its overbar. Open it directly (no server
needed) on each platform you care about.

One row per candidate font, each applying the fix in its real shape — the
font on `msqrt` only, contents put back to `math`. Every row reports whether
that font ACTUALLY resolved, by measuring `√` against a font name that cannot
exist: a named font that silently fell back is not a test of that font, and
believing otherwise cost this investigation nine "all fine" test matrices.

Judge the point where the diagonal meets the bar. Check 150% and 200% zoom
too — the mismatch is sub-pixel, so zoom can change the verdict.

Known results (2026-08-28): macOS/Chrome picks STIX Two Math and breaks;
Windows/Chrome picks Cambria Math and breaks the same way; forcing serif is
clean on macOS and still broken (smaller) on Windows as Times New Roman.
Background in docs/DECISIONS.md, 2026-08-25.
