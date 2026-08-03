# bento/tray — iOS

A thin native host that runs **any self-contained HTML document** and lets it
**save itself in place** on iOS.

Bento decks are the reason it exists, but nothing in the Swift is Bento-specific
— it never parses the document, it is a courier. Any single-file HTML app that
saves itself through the File System Access API works the same way, which on iOS
is otherwise impossible: every browser there is WebKit and none of them ship
that API.

## Why this exists

Every browser on iOS is WebKit, so the File System Access API does not exist
there — not in Safari, not in Chrome or Firefox, which are WKWebView underneath.
Without it Bento can only hand back downloaded copies: no in-place save, no
silent autosave write-back, no in-place self-update. `UIDocument` is the only
way to write back to the user's actual file, and only a native app can use it.

## What it is, and what it deliberately is not

The app supplies **file access and nothing else**. It bundles no runtime for
rendering and has no opinion about which version of Bento a deck carries.

That is the decision everything else follows from. The deck runs **its own
embedded runtime**, exactly as it would in Safari, so it self-updates through
Bento's normal signed channel — iOS users get the same release as everyone else,
the same day, with no App Store submission per release and no second release
train to keep in step.

The alternative (bundling a shell and rendering every deck with it) would have
put iOS behind an App Store review queue forever and made the bundled copy drift
from the current release. It is not needed: Apple's rule is about downloading
code that changes the features **of the app**, and the app here behaves
identically whatever a document contains. What updates is user content, the same
as any page a browser renders.

## How saving works — no changes to Bento

`kernel/src/save.ts` tests exactly one thing: `typeof
window.showSaveFilePicker === 'function'`, and needs only

```
showSaveFilePicker({suggestedName, id}) -> { name, createWritable() }
createWritable() -> { write(Blob|string), close() }
```

`id` tells a host WHAT IT IS BEING ASKED TO DO, and a host that ignores it can
destroy a file:

| `id` | meaning | a host may |
|---|---|---|
| `bento-doc` | ⌘S — overwrite the document being edited | write in place, silently |
| `bento-copy` | "Save a copy…" — a second file the author chooses | **must** let the author choose |
| `bento-share` | a suffixed export: view-only, presentation package, invite, template | **must** let the author choose |

Before this existed, ⌘S and "Save a copy…" reached the picker with
byte-identical arguments, so a host could not distinguish them. One that guessed
"in-place" overwrote the open deck with no dialog and no warning — measured in a
browser extension, 2026-08-02. The two failure directions are not symmetric:
guessing `copy` costs a prompt, guessing `in-place` costs the file. **When in
doubt, prompt.**

Pinned by `scripts/test-savepurpose.ts`.

So `Resources/bridge.js` polyfills that over a `UIDocument` bridge — three
methods. Two consequences:

- **No web-side changes at all.** Every in-place path (⌘S, autosave write-back,
  self-update, the capability-aware messaging) already routes through that one
  function.
- **Every deck ever saved works**, including files whose embedded runtime
  predates this app. A bespoke `window.__bentoHost` bridge would only have helped
  decks re-saved after it shipped — which is to say, none of the existing ones.

### Saving from apps that are not Bento

Two idioms, both supported, because "any self-contained HTML document" has to
mean more than "any document that saves the way Bento does":

- **File System Access.** The handle implements `kind`, `name`, `isSameEntry`,
  `queryPermission`, `requestPermission`, `getFile` and `createWritable`; the
  writable implements `write` (raw data AND the `{type:'write'|'seek'|'truncate'}`
  params form), `seek`, `truncate`, `abort` and `close`. Bento only ever calls
  `createWritable`/`write`/`close`, but a third-party page may reasonably call
  `queryPermission()` before saving or `truncate()` to overwrite in place — a
  live probe page reported those as `undefined` before this existed.
  `getFile()` and `keepExistingData` need the bytes on disk, so the bridge has a
  `read` op; only the OPEN document is readable, since an export target is
  somewhere we were handed once and do not hold.

- **`<a download>`.** The older and commoner idiom — TiddlyWiki, and most
  "export this page" tools. WKWebView DROPS these silently without a download
  delegate, so the button appears to do nothing, which is the worst possible
  failure for a save. Downloads land in the app's Documents folder (visible in
  Files under Bento Tray) with a collision-safe name and a confirmation. A
  picker per save would punish an app that saves often, and a download cannot
  overwrite the user's original anyway — that is what the FSA path is for.

### Which file a save targets

Bento only reaches a picker when it holds **no handle**; afterwards ⌘S, autosave
and in-place update all reuse it. So the rule is deterministic:

- **first** `begin` → the document already open in the app, resolved with no UI
- **any later** `begin` → a genuine Save-As or export (read-only copy, invite,
  template), which gets a real picker and must never overwrite the open file

Do **not** infer this by comparing `suggestedName` to the open filename. Bento
derives that name from the deck TITLE, so it rarely matches — an early version
of this bridge did exactly that and prompted on every single save.

## Two implementation details that carry weight

- **The document is served through a custom scheme** (`bento-tray://`), never
  `loadFileURL`. A `file://` page in WKWebView gets an opaque, unstable origin,
  which makes `localStorage` and IndexedDB unreliable — silently breaking the
  autosave backstop, the per-device collab member key, and language/motion
  preferences. It also keeps relay fetches from arriving as `Origin: null`.
- **Portrait insets the web view NATIVELY; landscape is full bleed.** In
  portrait the page starts below the status bar and camera pill, so a
  document's own toolbar is reachable. This is done by moving the web view, not
  by asking the page to pad itself — `env(safe-area-inset-*)` is dead in this
  WKWebView (measured: native 62/0/34/0, CSS 0px on all four sides, with
  viewport-fit=cover and with either inset behaviour), and `--tray-safe-*` only
  helps a page that has heard of this host. A third-party HTML file has no way
  to know, so its top controls sat under the pill and could not be tapped.
  Insetting the view works for every document with no cooperation at all.
  Landscape stays edge to edge deliberately: there the unsafe strip is a thin
  side gutter, not a band across the controls, and a maximised page is what you
  want when presenting.
- **The host is PER DOCUMENT**, a truncated SHA-256 of the file's path, not a
  shared `deck`. Since this app opens any HTML document, a shared origin would
  let one document read another's `localStorage` and IndexedDB — fine when every
  file is yours, a real leak between unrelated third-party apps. Derived rather
  than random because the origin IS the storage boundary: a random host per
  launch would wipe that storage on every open. The trade is that moving or
  renaming a file gives it a new origin and orphans its local state — which is a
  cache and a backstop, never the document itself.
- **The page reaches every physical edge.** `contentInsetAdjustmentBehavior` is
  set to `.never`; left at its default UIKit insets the scroll view by the safe
  area, which in landscape left visible bands down the left, right and bottom of
  a slideshow. The document owns its margins; the host adds none.
- **The host shows nothing while the page presents.** `webView.fullscreenState`
  is observed, and entering fullscreen hides both the nav bar and the floating
  exit — a control sitting over a slideshow is exactly the chrome presenting is
  meant to shed. (Contrary to one analysis, `fullscreenState` IS usable here,
  because element fullscreen genuinely works — see below.)
- **Element fullscreen is enabled** (`preferences.isElementFullscreenEnabled`).
  iPhone Safari has never offered element fullscreen to web pages, which is why
  Bento's present mode falls back to filling its view in a browser — but
  WKWebView exposes it as an opt-in. So a hosted document presents properly
  where the very same file in Safari cannot: verified on an iPhone 17 Pro Max,
  the status bar, the nav bar and Bento's own toolbar all disappear, the deck
  letterboxes on black with a native ✕, and swiping advances slides. This is a
  case where the wrapper is not merely restoring parity with desktop but doing
  something the browser cannot. Credit to #87 for finding the flag.
- **`bridge.js` is injected `.atDocumentStart`.** Bento decides whether it can
  save during boot; injected later, the editor has already concluded it cannot.

## Getting documents in

Four routes, all landing on the same in-place editing:

1. **Files** — the app's folder appears under *On My iPhone → Bento Tray*, and
   the Browse tab navigates the whole Files hierarchy: iCloud Drive, Dropbox,
   Google Drive, anything with a File Provider. Tap a document to open it where
   it lives; edits go back to that file.
2. **Share sheet / "Open in"** — from Safari, Mail, Messages. The app declares
   itself an `Editor` for `public.html` with `LSSupportsOpeningDocumentsInPlace`,
   so it is offered for any HTML file.
3. **AirDrop**, same mechanism.
4. **"+"** for a new document from the bundled seed.

Routes 2 and 3 need `scene(_:openURLContexts:)` — declaring the document type
only makes the app *offered*, it does not deliver the file. Both cold launch
(`options.urlContexts`) and warm delivery are handled, and the URL is wrapped in
a security-scoped accessor: without it the read fails silently and the document
opens blank.

`LSHandlerRank` is `Alternate`, so Safari stays the default for HTML and Bento
Tray appears as a choice rather than hijacking every `.html` on the device.

## Building

Needs **full Xcode** (Command Line Tools alone is not enough) and XcodeGen:

```sh
brew install xcodegen
cd tray/ios && xcodegen && open BentoTray.xcodeproj
```

Source lives under `tray/<platform>/` — `tray/ios/` and `tray/webext/` today. The design below
(the polyfill and its protocol) is platform-neutral; only the transport lookup
and the native file layer are not.

`BentoTray.xcodeproj` is generated, never committed — a `.pbxproj` in git is a
merge-conflict magnet.

### Signing

The **simulator needs none** — it signs ad-hoc, which is why a plain `xcodegen
&& xcodebuild` has always just worked. A **real device needs a team**:

```sh
BENTO_TEAM_ID=ABCDE12345 xcodegen     # then build to the device
```

The ID comes from the environment at generation time and is never written to a
tracked file. A Team ID identifies a person or company, and the `.xcodeproj`
that carries it is generated and gitignored, so nothing personal is committed.
Leave it unset and `DEVELOPMENT_TEAM` is simply absent — simulator builds are
unaffected.

Find it in **Xcode ▸ Settings ▸ Accounts**, or developer.apple.com ▸ Membership.
A free Apple ID signs for your own devices on a **7-day** profile that must then
be re-signed; TestFlight and the App Store need the paid programme.

## State: runs, unsigned, untested on hardware

Verified — the save contract, exercised against the **real** Bento build in a
browser with the native side emulated (`begin`/`write` over the same protocol):

- ⌘S writes the open document, no export prompt, 899KB of valid HTML with the
  `#bento-doc` block intact and no stray script-close
- autosave write-back reuses the handle and writes again silently
- "Save a copy…" prompts for a destination and leaves the open document
  untouched

Since then it has been **built, installed and driven** on the iPhone 17 Pro Max
and iPad Pro 11" simulators: documents create, open, edit and save; the scheme
handler serves bytes; the exit returns to the browser; the app icon renders on
the home screen. Presentation geometry was measured from the framebuffer rather
than eyeballed — 16:9 to four decimal places, symmetric letterboxing, on both
devices and both orientations.

Still not verified — **anything on real hardware.** Everything above is the
simulator, which does not exercise signing, provisioning, device performance, or
the file providers (iCloud Drive, Dropbox) that make open-in-place interesting.
Also untested: the share-sheet and AirDrop routes into the app.

### Getting back out

A document opens full screen with **no native bar at all**, and the way back is
a small floating chevron in the bottom-left corner. Something has to be there:
full-screen modals have no interactive dismiss, so with no chrome a document
was a ONE-WAY TRIP and force-quitting the app was the only exit.

The nav bar it replaced is gone in BOTH orientations. The document already has
its own toolbar, so a native bar above it was a second row of chrome competing
with the first, spending 44pt of a screen that has none to spare. (Its
`hidesBarsWhenVerticallyCompact` auto-hide was tried first and simply does not
fire for a modally-presented navigation controller.)

The chevron fades to near-transparent after a few seconds and returns on any
touch — including a swipe, which is the gesture that matters, since a presenter
advancing slides never taps. Once element fullscreen was declined (below) the
host lost its only signal for "a show is running", and guessing what the
document is doing is the one thing this app refuses to do; getting out of the
way when unused is right for presenting and harmless while editing.

The host has to supply this itself. It cannot ask the page for a close button
without assuming what the page is, which is the one thing this app does not do.

Leaving also does the teardown that had no home before: `UIDocument.close()`
(flushes and relinquishes file coordination — the document previously stayed
open for the life of the app) and the security-scoped release, which ran only
on the failure path and leaked once per document opened. The scope is dropped
only after close completes; dropping it earlier can fail the final write for a
file outside the container.

### Element fullscreen is DECLINED, on every device

`WKWebView` offers it as an opt-in that mobile Safari never gives a page, so it
looked like free capability. It is not. WebKit's fullscreen view brings its own
close button that no public API can hide, restyle or move, and it insets the
content — so a 16:9 deck letterboxed asymmetrically and the foreign ✕ spilled
off the band onto the slide. On iPad it did not even hide the status bar, which
is the one thing fullscreen is for.

Declining costs nothing, because the host hands the page the whole screen
anyway: the status bar is hidden on iPad (where nothing else keeps the page off
the screen — there is no sensor housing to reserve a band for) and the web view
is inset by exactly `view.safeAreaInsets.top`, which reports the housing on
iPhone portrait and 0 everywhere else. The deck then fills the view edge to
edge, letterboxes evenly, and wears its OWN chrome. A page refused fullscreen
is not broken — that is the path it takes in mobile Safari.

Measured from the framebuffer, presenting the starter deck:

| | bands | result |
|---|---|---|
| iPhone landscape | 261 / 261 | aspect 1.7773 |
| iPad portrait | 741 / 741 | aspect 1.7783 |
| iPad landscape | 153 / 153 | 1362px = 1210pt × 9/16 |

Orientation testing note: `simctl` cannot rotate a device, and driving the
Simulator's own rotate command is unreliable when more than one simulator is
open (the keystroke goes to whichever window has focus). Forcing
`supportedInterfaceOrientations` on the presented controller is the dependable
way to land a specific orientation for a measurement.

### Platform notes worth keeping

`didImportDocumentAt` is **never called for the creation flow** on iOS 26. The
creation handler fires and the file lands correctly, but the delegate callback
does not arrive — so an app that opens the editor from that callback silently
creates files and appears to do nothing. `tray/ios` therefore places new
documents itself and hands the browser `.none` ("already in its final
location"), which also puts collision naming under our control: the system
renames `Untitled.bento.html` to `Untitled.bento 2.html`, reading `.bento.html`
as a name plus one extension.

Still to do:

- App icon, launch screen, signing, an Apple Developer account ($99/yr).
- Decide whether a `.bento.html` UTI is worth declaring over plain `public.html`.
