# home/fixtures — the document-indexing contract

Every bento/tray host answers the same questions about a file it did not write:
is this one of ours, what is it called, which app is it, is it encrypted, what
does its first page look like, and what words does it contain.

Three hosts answer them in three languages — `home/webext` in JavaScript,
`home/android` in Kotlin, `home/ios` in Swift — because their list UIs are
native and must stay that way (`docs/DECISIONS.md`, 2026-08-16: putting the
extension's HTML library in a WebView costs ~0.5s of cold start, iOS its system
document browser, and both their accessibility).

Three implementations of one algorithm is a drift problem. **This directory is
how they are held together.** `home/doc-index.mjs` is the reference,
`cases/` is the corpus, `expected.json` is the answer key, and every host runs
the same corpus from its own test rig:

| host | rig |
|---|---|
| reference (JS) | `node scripts/test-doc-index.mjs` |
| `home/android` | `./gradlew :app:testDebugUnitTest` (JVM, no device needed) |
| `home/ios` | not yet built |

The guarantee is deliberately **"cannot diverge silently"**, not "cannot
diverge". A divergence here makes search find less, which is visible and
recoverable — unlike the writable-stream semantics in `home/bridge.js`, which
are shared outright because a divergence there wrote users' documents out as
zero bytes.

## Changing the algorithm

Change `home/doc-index.mjs`, extend `cases/`, regenerate `expected.json`, then
re-run **every** rig. A host that cannot match the corpus is the one that is
wrong.

## What each case pins

| case | the rule it holds in place |
|---|---|
| `plain.html` | an ordinary document — title, app, prose from element html |
| `data-uri.html` | an embedded `data:` URI is stripped **before** extraction, so one image cannot swamp every word in the document |
| `escaped.html` | `\"` inside a value does not terminate it |
| `noise.html` | values with no run of 3+ letters are dropped: ids, hex colours, `12px` |
| `markup.html` | element markup and HTML entities are stripped from the joined text |
| `longvalue.html` | **a single string value over 400 characters is skipped entirely** |
| `budget.html` | the total is truncated at `TEXT_BUDGET` (40 KiB) |
| `encrypted.html` | an encrypted document yields **no text and no preview**, ever |
| `preview.html` | the first-page preview block is found and sliced |
| `nomarker.html` | a file without `id="bento-doc"` is not ours |

`longvalue.html` is the one worth reading twice. The value regex is capped at
`{1,400}`, so a paragraph longer than that — a long speaker note, a wordy text
element — **is not indexed at all**. That is current behaviour, pinned here so a
port cannot quietly "fix" it into divergence, and so a deliberate change to it
has to be a deliberate change to all three.
