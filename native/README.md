# native — iOS and Android wrapper apps for bento/slides

Minimal native shells that make a bento deck a first-class document on iPhone,
iPad, and Android. No framework: plain Swift + WKWebView and plain Kotlin +
WebView, zero third-party dependencies, ~500 KB installed per platform.

Why a wrapper at all, when the file already runs in any browser: mobile
browsers cap exactly the things that make bento bento.

| Capability | Mobile browser | Wrapper |
|---|---|---|
| File System Access API ("it saves itself") | absent — every save is a new download | in-place saves via native file APIs |
| Fullscreen presenting on iPhone | not available to web pages | native element fullscreen |
| Opening a `.bento.html` from Files/Mail | sandboxed preview at best | registered editor, open-in-place |
| Offline | needs a service worker + a hosted origin | bundled deck + OTA updates |

## Layout

```
native/ios/        Swift app (Xcode project, no dependencies)
native/android/    Kotlin app (Gradle, no AndroidX, no dependencies)
native/scripts/    fetch-deck.sh (build input), gen_icons.py (iOS icon set)
```

The bundled `bento.html` is a **build input, not source** — `make` fetches it
via `scripts/fetch-deck.sh`, which prefers a locally built
`slides/dist-single/Bento_Slides.bento.html` and falls back to the latest
GitHub release.

## Build & run

Via npm (from `native/`):

```sh
npm run run:android          # build debug APK, pick a device, install, launch
npm run run:ios              # same for a simulator / iPhone / iPad
npm run build:apk            # release APK
npm run build:aab            # Play Store bundle (needs keystore.properties)
TEAM=<teamid> npm run build:ipa   # App Store .ipa → ios/build/Bento.ipa
```

Device pickers prompt when more than one target is connected; skip the prompt
with `device=<udid|serial> npm run run:ios` (or `run:android`). The npm
scripts are a facade over per-platform Makefiles — `make -C native/ios run`
and friends work identically, and `npm run deck` / `npm run icons` refresh the
bundled deck and the icon set.

## How the shells work

Both are one screen: a WebView rendering the deck, plus an injected shim.
Bento's own UI drives everything — there is no native chrome.

1. **Bundled deck + OTA.** The app ships a copy of the single-file build and
   checks the GitHub releases feed on launch; a newer deck is swapped in
   atomically and used from the next launch.
2. **File System Access shim** (`showSaveFilePicker`), injected at document
   start. Bento's retained-handle save flow works unchanged: the handle's
   `createWritable()` round-trips content to native code.
3. **The document cycle (iOS).** A deck opened from Files/Mail (registered
   `public.html` editor, `LSSupportsOpeningDocumentsInPlace`) or the document
   picker becomes the *backing document*, held as a security-scoped bookmark.
   Saves are written back in place under `NSFileCoordinator` — same behavior as
   desktop Chrome with a retained handle. With no backing file, the first save
   creates one in the app's Documents (visible in the Files app); a changed
   suggested name falls back to an export sheet (save-as).
4. **Native dialogs.** `alert`/`confirm`/`prompt` map to native alerts; the
   logo tap opens a native menu (save / save as / open / settings — settings
   passes through to bento's own project settings).
5. **Touch affordances (iOS).** A floating ✎ edit pill appears when a text
   element is selected and dispatches the `dblclick` bento expects;
   double-tap-to-zoom is disabled natively; a WebKit focus workaround lets
   bento's programmatic focus raise the keyboard (see
   `allowProgrammaticKeyboard()` — the long-standing Ionic/Cordova approach,
   no-op if WebKit renames the internal selector).
6. **localStorage bridge (iOS).** WKWebView storage for `file://` documents is
   unreliable, and several runtime `localStorage` reads are unguarded — the
   shim replaces it with a UserDefaults-backed store seeded before each load.

## The soft DOM contract

The integration points reference runtime markup. Everything degrades
gracefully — if a selector stops matching, the feature silently detaches and
stock behavior remains — but renaming these will detach features until the
wrapper is updated:

| Selector / behavior | Used for |
|---|---|
| `.ed-topbar .ed-logo` | logo-tap → native document menu |
| save button tooltip containing `⌘S` | native "Save" menu action |
| `.ed-topbar .ed-split-caret` | native "Save As…" menu action |
| `.bento-el-text` + stage `dblclick` → `startTextEdit` | ✎ edit pill |
| `showSaveFilePicker` capability check at save time | the whole save bridge |

A stable, documented `window.bento` hook (or `data-bento-*` attributes on
these controls) would let the wrappers drop every selector above — happy to do
that refactor if wanted.

## Status & known gaps

- **iOS is the mature shell** (document cycle, keyboard, gestures, storage
  bridge — tested on iPad Pro / iPhone simulators and tablet-first by design).
  **Android is the minimal shell** (WebView + save/open via SAF + OTA); it
  needs the same document-cycle treatment with persistable URI grants.
- **OTA updates are not yet signature-verified.** The updater trusts
  HTTPS + GitHub. It should verify the release signature (or hand verification
  to the runtime's own signed-update path, or a future bento/vault channel)
  before swapping the deck.
- Store metadata (listing copy, screenshots, privacy policy) is deliberately
  not included — distribution identity is a maintainer decision, as are the
  bundle ids (`slides.bento.app` used as a placeholder throughout).
