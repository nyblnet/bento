# bento/home

Thin native hosts that run **any self-contained HTML document** and let it
**save itself in place**, on platforms where a browser will not.

Three of them, under `home/<platform>/`:

| | what it hosts | why it exists |
|---|---|---|
| `ios/` | UIDocument + WKWebView | every iOS browser is WebKit, and none ship the File System Access API |
| `android/` | Storage Access Framework + WebView | Chrome on Android has no File System Access API either |
| `webext/` | a directory grant, in the browser | `file://` pages get no persistent handle |

Bento decks are the reason they exist, but nothing in the Swift or the Kotlin is
Bento-specific — neither ever parses the document, both are couriers. Any
single-file HTML app that saves itself through the File System Access API works
the same way.

**The web-side half is ONE file, `home/bridge.js`,** shared by iOS and Android.
It polyfills the single call Bento tests for, and the interesting part of it is
not the transport but the `FileSystemWritableFileStream` semantics — whose
comments record a bug that wrote users' documents out as zero bytes. A second
copy would be a second chance to reintroduce exactly that, so the per-platform
part is the ~15 lines of transport at the top and nothing else.

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
| `bento-backup` | the rollback copy a self-update leaves behind | write **beside the open document**, silently — see below |

Before this existed, ⌘S and "Save a copy…" reached the picker with
byte-identical arguments, so a host could not distinguish them. One that guessed
"in-place" overwrote the open deck with no dialog and no warning — measured in a
browser extension, 2026-08-02. The two failure directions are not symmetric:
guessing `copy` costs a prompt, guessing `in-place` costs the file. **When in
doubt, prompt.**

Pinned by `scripts/test-savepurpose.ts`.

So `home/bridge.js` polyfills that — over `UIDocument` on iOS, over the Storage
Access Framework on Android, from the one shared file. Two consequences:

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
  Files under bento/home) with a collision-safe name and a confirmation. A
  picker per save would punish an app that saves often, and a download cannot
  overwrite the user's original anyway — that is what the FSA path is for.

### Finding the sender's file: route, don't search

A `FileSystemDirectoryHandle` knows its own **name** but not its path, and no
API exposes one — so a grant and a `sender.url` cannot be compared directly.
The webext host used to resolve by walking the granted tree looking for a
matching filename, depth-capped at 4 and declining whenever two files shared a
name.

It no longer searches. **A directory's name must appear in the path of every
file inside it**, so the name locates the split point in the sender's path and
everything after it is the route: one `getDirectoryHandle` per segment, then
`getFileHandle`. O(path depth), nothing enumerated. Measured: a file inside a
500-entry grant resolves with **zero directory scans**.

Three things follow, and they are the reason for it:

- a grant can be **any size**. A home directory costs what a decks folder costs,
  which is what makes "grant everything" a reasonable thing to offer.
- **several grants** are cheap — each attempt is a few lookups, so the store
  holds a list (`dirs`), not one folder.
- **two documents sharing a filename stop being ambiguous.** The old walk found
  both and declined; only one route leads to one file. Anyone with per-client
  folders hit that on every save.

The split point is checked, not guessed: a wrong one fails at the first missing
segment, and `resolve()` re-verifies the file it lands on against the sender's
path regardless (the identity check that stopped a same-named file elsewhere
from being overwritten). A grant covering a whole home directory raises the cost
of a resolution bug, so that check matters more, not less.

`findByName` survives as a fallback for paths the route cannot place.

### The grant lapses on every browser restart

MEASURED 2026-08-14: a `showDirectoryPicker` grant survives service-worker
eviction — which is constant, and why nothing is cached between messages — but
Chrome drops it back to `prompt` when the extension restarts **and when the
browser restarts**. The HANDLE survives in IndexedDB; only the permission goes.

So the recovery is `requestPermission()` on the handle already held — one
confirmation, no folder to re-find — and it must happen on an **extension page**,
because it needs a user gesture and the service worker has none. That is what
the per-folder **Renew** button is. `background.js` only ever queries.

**But Chrome's permission dialog offers "Allow on every visit"**, alongside
"Allow this time", and it offers it to the EXTENSION origin — observed
2026-08-14 on `chrome-extension://…/src/options.html`. So persistent File System
Access permission is available here, and an earlier claim in this file that it
was scoped to installed web apps was simply wrong.

Whether "every visit" survives a full browser restart for an extension origin is
NOT yet measured. Until it is, the UI says which button to choose and does not
promise what follows. If it holds, the grant is once and for all. If it does
not, the ceiling is one **Renew** click per browser session, since
`chrome.downloads` can only write inside the downloads folder and durable access
would then need a native messaging host — a separate decision, because it
changes how the thing is distributed.

The choice is the browser's to offer and the user's to make; nothing in the
extension can pick it. All the code can do is point at the one that ends the
chore.

### Which file a save targets

Bento only reaches a picker when it holds **no handle**; afterwards ⌘S, autosave
and in-place update all reuse it. So the rule is deterministic:

- **first** `begin` → the document already open in the app, resolved with no UI
- **any later** `begin` → a genuine Save-As or export (read-only copy, invite,
  template), which gets a real picker and must never overwrite the open file

Do **not** infer this by comparing `suggestedName` to the open filename. Bento
derives that name from the deck TITLE, so it rarely matches — an early version
of this bridge did exactly that and prompted on every single save.

### Announcing what a host can do

A host that can do more than the bare contract says so on the page:

```js
window.__bentoHost = { name: 'home/webext', ops: ['claim', 'write', 'backup'] }
```

`kernel/src/save.ts hostCan(op)` reads it, and it is the ONLY thing the kernel
reads about a host. `showSaveFilePicker` existing proves nothing — Chrome has it
on `file://` anyway — and a host that declines a request is indistinguishable
from one that is not installed, because both end at the native dialog. So a path
that is only worth taking with help has to ask first.

Capabilities, not a version number, in both directions: a document can be years
older or newer than the host it meets. A host that announced only its presence
and then did not recognise `bento-backup` would pass the request through to the
native picker and produce a dialog **only** for people who installed the host,
which is the opposite of the point.

Set it non-writable. The document is untrusted content sharing that realm, and
it must not be able to claim a capability the host does not have.

### `bento-backup`, the only op that CREATES a file

Every other op writes a file that already exists and that the sender IS. This
one makes a new one, so the page contributes to a name — and that contribution
is kept from meaning anything:

- the name must be **visibly derived from the sender's own file**: same base,
  `.bento.html`, and nothing between but `[A-Za-z0-9._-]`. No separator can
  survive, so nothing escapes the directory.
- it may not equal the original. Without that check the "backup" is the file.
- **create-only**: an existing file is never replaced.
- the directory is the host's to determine, from the sender's own resolved
  path — never from the payload.

Worst case for a hostile document: one predictably-named copy of itself in a
folder the author granted, which is what the feature does when it works.

If a host cannot do this, it must not announce `backup`; the kernel then falls
back to downloading the rollback copy, which is where it used to go.

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
- **The host shows nothing while the page presents.** The floating exit fades out
  when nothing is happening and comes back on touch — a control sitting over a
  slideshow is exactly the chrome presenting is meant to shed. It is done by idle
  timer rather than by observing `fullscreenState`, because the host no longer
  takes element fullscreen at all: see "Element fullscreen is DECLINED" below,
  which is the authoritative account. (An earlier version of this list claimed
  the opt-in was enabled and credited #87 for finding the flag. The flag is real
  and the credit stands; the conclusion did not survive being measured.)
- **`bridge.js` is injected at document start.** Bento decides whether it can
  save during boot; injected later, the editor has already concluded it cannot.

## Getting documents in

Four routes, all landing on the same in-place editing:

1. **Files** — the app's folder appears under *On My iPhone → bento/home*, and
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
cd home/ios && xcodegen && open BentoTray.xcodeproj
```

Source lives under `home/<platform>/` — `home/ios/` and `home/webext/` today. The design below
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
creates files and appears to do nothing. `home/ios` therefore places new
documents itself and hands the browser `.none` ("already in its final
location"), which also puts collision naming under our control: the system
renames `Untitled.bento.html` to `Untitled.bento 2.html`, reading `.bento.html`
as a name plus one extension.

Still to do:

- App icon, launch screen, signing, an Apple Developer account ($99/yr).
- Decide whether a `.bento.html` UTI is worth declaring over plain `public.html`.

## Android

Same thesis as iOS, and for the same reason: Chrome on Android does not ship the
File System Access API either, so a deck opened in a browser there can only ever
hand back downloaded copies. `home/android/` is ~700 lines of Kotlin with one
dependency, and it keeps both of the decisions the iOS host is built on — the
document is served through an origin we control, and the app bundles no runtime
for rendering.

**Origin: [#87](https://github.com/nyblnet/bento/pull/87), by
[savrum](https://github.com/savrum)**, which asked for native wrapper apps
before either host existed and is the branch this landed on. The Gradle layout,
the `keystore.properties` pattern and the device-picker ergonomics come from
there; so did `isElementFullscreenEnabled`, which `home/ios` used until
measurement sent it the other way. The architecture changed — a host that
bundles a deck and updates itself over the air is the thing tray exists not to
be — but the question it asked was the right one, and it was asked first.

### Parity with the iOS host

The two hosts are meant to behave identically from inside the document. Where
they cannot, it is because the platform forces it — and that is written down
here rather than discovered later.

| behaviour | `home/ios` | `home/android` | |
|---|---|---|---|
| FSA polyfill | `home/bridge.js` | `home/bridge.js` | **one shared file** |
| per-document origin | `bento-tray://<sha24>` custom scheme | `https://<sha24>.bento-tray.invalid`, intercepted | same |
| document served from memory, never parsed | ✓ | ✓ | same |
| bridge injected at document start | `WKUserScript(.atDocumentStart)` | `addDocumentStartJavaScript` | same |
| bridge reachable only from the document | `forMainFrameOnly` | `allowedOriginRules` + `isMainFrame` | same |
| first `begin` = open document, later = export | ✓ | ✓ | same |
| an export can never address the open file | `exportName` + `targetsOpenDocument` | identical logic | same |
| page-supplied filenames sanitised | `safeFileName` | `safeFileName` | same |
| in-place write | `UIDocument.save(.forOverwriting)` | `openOutputStream(uri, "wt")` | same |
| export destination chosen by the author | `UIDocumentPickerViewController` | `ACTION_CREATE_DOCUMENT` | same |
| `alert` / `confirm` / `prompt` | `WKUIDelegate` | `WebChromeClient` | same |
| `<input type="file">` | native | `onShowFileChooser` | same |
| element fullscreen | declined | declined | same |
| safe-area insets, natively + `--tray-safe-*` | ✓ | ✓ | same |
| new document | fetched from the signed release channel | fetched from the signed release channel | same |
| starter deck bundled in the app | **no** | **no** | same |
| release manifest signature verified | `CryptoKit` P-256 | `SHA256withECDSA` + DER | same check |
| downloaded shell hash-checked | ✓ | ✓ | same |
| release is for the app we ASKED for | ✓ | — | **gap on Android** |
| rollback refused (per-app version floor) | ✓ | — | **gap on Android** |
| seed cached for offline "New" | Application Support | `filesDir` | same |
| way back out | floating exit, fades when idle | system back gesture | platform-forced |
| root screen | `UIDocumentBrowserViewController` | own recents list over SAF | platform-forced |
| `<a download>` lands | app's Documents folder, silently | wherever the author picks | platform-forced |
| write access to an opened document | always | **may be read-only** | platform-forced |
| status bar while editing | hidden on iPad | always shown | **known gap** |
| whole-folder grant | folder-mode `UIDocumentPickerViewController` | `ACTION_OPEN_DOCUMENT_TREE` | same capability |
| text extracted from a document | `BentoIndex.swift` | `DocumentIndex.kt` | ported per platform, one corpus |
| finding a document by its contents | ✓ search screen + Spotlight | ✓ search over a folder index | same |

One gap left, named rather than quietly left out. (Search was the other, on
whichever host you read this from — `home/ios` and `home/android` landed it a day
apart, from opposite directions, each believing the other still lacked it.)

**The status bar.** iOS hides it on iPad because nothing else keeps the page off
the whole screen there; the Android equivalent would be to hide it on tablets
(`smallestScreenWidthDp >= 600`). Not done, because it cannot be tested without a
tablet target, and shipping an untested behaviour is worse than naming an
untested one.

**Search.** All three hosts have it now. `home/webext` always did; `home/ios` and
`home/android` landed it a day apart, from opposite directions — which is why the
parity table above briefly claimed the gap in both directions at once.

A deck is findable by **a phrase on one of its slides** rather than only by what
somebody called the file. Each host does it the same way, and the sameness is
enforced rather than hoped for:

- a **whole-folder grant** — folder-mode `UIDocumentPickerViewController` on iOS
  persisted as a security-scoped bookmark, `ACTION_OPEN_DOCUMENT_TREE` on Android
  persisted as a URI permission. Both hosts could previously open one file at a
  time and enumerate nothing.
- **the extraction, ported per platform** — `BentoIndex.swift` and
  `DocumentIndex.kt`, both from the reference in `home/doc-index.mjs`: up to 40KB
  of prose per document pulled out of the `#bento-doc` block as string values,
  data URIs stripped first.
- **one shared corpus** — `home/fixtures/`, 11 cases, run from each host's own
  rig (`node scripts/test-doc-index.mjs`, `./gradlew :app:testDebugUnitTest`).
  The guarantee is deliberately "cannot diverge SILENTLY" rather than "cannot
  diverge", which is the weaker promise that fits string scanning — unlike
  `home/bridge.js`, shared outright because a divergence there wrote documents
  out as zero bytes.

The shape is settled in `docs/DECISIONS.md` (2026-08-16): **native list UI on
each host**, not the extension's HTML library screen in a WebView — measured at
~0.5s of extra cold start, and it would have cost iOS its system document
browser.

**One thing the extraction inherits from the reference**, visible in snippets: it
pulls string VALUES, so style values (`sans-serif`, `#EAF4FF`, `rgba(…)`) sit in
the prose alongside real words. That is what makes it format-agnostic, and it is
the extension's behaviour too — narrowing it is a change to all three ports and
belongs in `docs/DECISIONS.md`, not in one host.

Two properties the corpus pinned that reasoning had not: a single JSON string
value **over 400 characters is not indexed at all** (the value regex is capped
`{1,400}`), and **JS `\s` is Unicode-aware where Java's is not**. Both are held
in place so a port cannot quietly "fix" them into divergence.

### What is genuinely different

Three things, and none of them are stylistic.

**There is no document browser to host.** iOS hands over
`UIDocumentBrowserViewController` — a whole file browser, showing iCloud and
every File Provider on the device. Android's picker is a one-shot dialog that
returns a URI and closes. So the root screen is the app's own list of documents
it holds **persistable URI permissions** for, which is Android's analogue of a
security-scoped bookmark. On iOS the app is a lens onto the filesystem; on
Android it is a keyring. Both end at the same place.

**Write access is not implied by being handed a document.** A document opened
through the app's own picker (`ACTION_OPEN_DOCUMENT`) carries a persistable
read+write grant. A document arriving by `ACTION_VIEW` — tapped in a file
manager, opened from Drive or Gmail — usually carries **read only**, because
that is all the sender chose to grant, and no API lets the receiver ask for
more. So `canWriteInPlace` is checked rather than assumed, and when it is false
every save becomes a Save-As and the user is told once, up front. This follows
the rule stated above for the whole project: **when in doubt, prompt** — a
silently failing save is the worst outcome available.

`ACTION_GET_CONTENT` is never used. It hands back a *copy*, which is the entire
problem this app exists to solve.

**The origin is an `https://` host that never resolves.** iOS registers a custom
`bento-tray://` scheme; Android has no equivalent hook, so the document is served
from `https://<sha256-of-uri>.bento-tray.invalid/` and every request to it is
answered from memory in `shouldInterceptRequest`. `.invalid` is reserved by
RFC 6761 and can never resolve, so a missed intercept fails dead rather than
quietly reaching somebody's server. Per-document for the same reason as iOS: a
shared origin would let one document read another's `localStorage`.

### The one dependency

`androidx.webkit`, and it earns its place twice:

- **`addDocumentStartJavaScript`** is the exact equivalent of
  `WKUserScript(.atDocumentStart)`. Bento decides whether it can save *during
  boot*, so a bridge injected from `onPageStarted`/`onPageFinished` races the
  page — and the symptom is not a crash, it is an editor that quietly believes
  it cannot save.
- **`addWebMessageListener`** is **origin-scoped**. `addJavascriptInterface`, the
  dependency-free alternative that most WebView wrappers reach for, is injected
  into *every frame*, so a remote iframe inside an untrusted document would be
  handed a channel that writes the user's file.

It also removes a hazard the iOS host still carries: replies travel as JSON over
a message channel rather than as an evaluated JS call, so there is no
string-literal encoding step to get wrong. (On iOS a raw newline in a `read`
reply — which returns the *whole document* — is a syntax error that hangs the
page's promise forever. That is handled there; here it cannot arise.)

### Building

Needs a JDK 17 and the Android SDK; no Android Studio required.

```sh
brew install openjdk@17 && brew install --cask android-commandlinetools
sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0"
```

```sh
cd home/android && ./gradlew :app:assembleDebug
```

`ANDROID_HOME` must point at the SDK (`/opt/homebrew/share/android-commandlinetools`
for the cask above) and `JAVA_HOME` at the JDK. AGP 8.x **cannot run on Gradle
9.6+**, so the wrapper is pinned to 8.14.3 — use `./gradlew`, never a system
`gradle`.

The starter shell and `bridge.js` are staged into assets by the build
(`stageTrayAssets`), mirroring the iOS pre-build step. Neither is committed: a
587KB binary in git would churn on every release, and the seed ages harmlessly
because a new deck self-updates through the normal signed channel.

The launcher icon is **generated from the same mark as iOS**, not redrawn.
`home/assets/home-icon.svg` is the source for both; Android needs the rounded
rectangles re-expressed as path data because vector drawables have no `<rect>`,
and doing that by hand produces four opaque `M…A…V…Z` strings nobody will ever
diff against the SVG — so a change to the mark would land on iOS and silently
miss Android.

```sh
node home/assets/make-icons.mjs           # regenerate the Android drawables
node home/assets/make-icons.mjs --check   # fail if they drifted (for CI)
```

The tray is drawn at **56 units of the 108 canvas, not the full 72 safe zone**.
At 72 it exactly filled the visible area, so every launcher mask cut its corners
off and the navy frame that makes the mark read was never drawn at all.


### Document search

Grant a folder once and every Bento document inside it is indexed, so a deck is
findable by **a phrase on one of its slides**. This is what `home/webext` has
always had and what neither native host did.

- **The grant** is `ACTION_OPEN_DOCUMENT_TREE` plus a persistable permission —
  the analogue of the extension's `showDirectoryPicker`. Note that Android
  refuses to grant some directories outright (the root of shared storage, and
  `Download` on current versions): the picker says "Can't use this folder" and
  the user has to pick a subfolder. That is the platform's rule, not ours.
- **Nothing is copied.** The index holds extracted text and the first-page
  preview; the documents stay where the user put them.
- **A rescan is nearly free.** Rows are keyed by size and timestamp, so an
  unchanged folder costs one directory listing per folder and no reads at all —
  the expensive step was never the walk, it is pulling 40KB of prose out of a
  megabyte of document.
- **The name is not the test.** Any `.html` is opened and the marker inside it
  decides, so a deck renamed to `deck.html` to email it is still found — and a
  stray web page that merely contains the word you searched for is not.
- **SQLite, not a JSON file**, because the prose budget is 40KB *each*: a few
  hundred documents is megabytes, which is fine on disk and ruinous to parse
  into memory on every launch.
- **Encrypted documents are indexed as encrypted and nothing more** — no text,
  no preview. A privacy rule, not an optimisation.
- `MAX_FILES` (5000) bounds a scan, and hitting it is **reported**: a library
  that quietly stops at N is a library that lies about what it holds.

**Thumbnails**, rendered once and cached. The other two hosts get these free and
differently: iOS renders nothing at all — `UIDocumentBrowserViewController` asks
the SYSTEM to thumbnail the file, and the iOS thumbnailer draws the
`[data-bento-preview]` block because it runs no JavaScript, which is exactly what
that block exists for. `home/webext` sets `iframe.srcdoc`. Android has neither a
system HTML thumbnailer nor a browser for a list, so it renders the block itself:
**one offscreen WebView, at index time**, into a bitmap cached in `cacheDir`
(which Android empties under storage pressure — right for something
reconstructible). The list stays plain `ImageView`s, so nothing here touches cold
start or accessibility.

Three traps, all of which produced a *plausible-looking wrong picture* rather
than an error, and all worth knowing before touching `Thumbnails.kt`:

1. **A detached WebView draws the wrong thing, not nothing.** `measure`/`layout`
   on a view with no window never reaches the renderer, so the CSS viewport stays
   at WebView's default. It must be attached.
2. **The viewport has to be the capture box.** The preview's outer element is
   `position:fixed; width:100%; height:100%` — it covers the VIEWPORT by design,
   since a thumbnailer injects it into a real document. `width=device-width`
   means the SCREEN, not the view, so the block rendered far wider than the box
   and the capture was a magnified crop of its corner. `width=1280` — the width
   decks are authored at — plus `loadWithOverviewMode` scales the whole slide to
   fit, with no density arithmetic.
3. **WebView lays out in DP; the capture is in PIXELS.** Ignoring that renders
   everything `density` times too large and captures a crop — on a 2.75× device
   the slide's title filled the frame with three letters of it. The render box is
   sized in DP and the bitmap is downscaled after, which also gives crisper text
   than rendering at final size.

Because the preview is already stored in the index, adding this needed **no
rescan** — existing rows thumbnailed on the spot.

### New documents are fetched, never bundled

Starter decks change often, and there are three Bento apps with more coming — so
bundling one means picking arbitrarily, and bundling all of them means shipping
several copies of Bento inside the app, each stale from the moment it was built.

Measured on Android before this changed: the single bundled slides seed was
**517,161 bytes, 81% of a 630,851-byte release APK**. Removing it took the
release build to **117,940 bytes**, and the only asset left is `bridge.js`.

So "New" asks which app you want and fetches that app's current signed shell
(`Releases.kt`), the same channel a document uses to update itself — which also
means a document created here is the version everyone else has, the same day.
The shell is cached in `filesDir`, so only the first "New" of a given release
needs a connection. `home/webext` already worked this way in principle;
`home/ios` still bundles and should follow.

This is the **one** request the host makes on its own account — no launch check,
no telemetry. `docs/PLATFORM.md` §1 requires no network to open, edit, present or
save; creating from a template is none of those.

**Both halves are verified**, exactly as `kernel/src/update.ts` does it: the
manifest's ECDSA P-256 signature over the exact payload bytes, then the shell's
`sha256` as pinned by that signed payload. These bytes become an executable
document the user afterwards trusts, so an unverified download would let anyone
in the path choose what they create.

**Two more checks, and neither is optional** — both catch an attacker who can
re-serve but cannot forge, which is what an origin or CDN compromise looks like:

- **App identity.** A genuinely signed `bento-slides` manifest served on the
  dash channel passes the signature AND the digest: every byte authentic, just
  not what was asked for. Checked against the app the CALLER requested, never
  against what the payload says about itself — and an ABSENT field must not read
  as a match, which is the hole `home/webext` had before PR #318.
- **A rollback floor**, a per-app high-water mark. A stale but genuine manifest
  passes everything, because every byte of it really was signed and really does
  match; it just hands over an older release. `kernel/src/update.ts` refuses to
  go backwards using its own build version, but a host that CREATES documents
  has nothing to compare against except what it has seen.

  Two details that are easy to get backwards, and both turn a failed attack into
  a permanent one if you do. The floor is raised **only after the downloaded
  bytes pass their digest** — raising it on a merely-verified manifest would let
  one forged-but-unfetchable release naming 9.9.9 lock the device out of every
  real release below it. And an **equal version is accepted**: re-fetching the
  version already seen is the normal case, so treating equal as a downgrade
  breaks the + button on its second use, not at some edge.

  Accepted cost, taken deliberately: a maintainer's own rollback is refused too,
  so pulling a bad release needs a version bump rather than a re-point.

  An unreadable store reads as NO floor rather than a refusal — being unable to
  remember must not mean being unable to create a document — and an unparsable
  version component sorts as 0, so a strange version can fail to raise the floor
  but never blocks a release. That last one matches the kernel exactly, including
  the detail that `Number('1a')` is NaN and NaN is falsy, so `(pa[i] || 0)`
  coerces it to 0 rather than propagating.

Two traps worth keeping:

- **WebCrypto emits ECDSA signatures as raw `r‖s`; Java expects DER.** The
  manifest is signed through WebCrypto by `scripts/sign-release.mjs`, so handing
  its 64 bytes to `SHA256withECDSA` unconverted is simply a bad signature —
  silent, and indistinguishable from tampering.
- **Ask for bytes, not a page.** `HttpURLConnection` sends a browser-shaped
  `Accept` by default, and the release host rewrites responses it believes are
  pages — see the note below. `Accept: */*` avoids the rewrite; the hash check is
  what actually makes the bytes trustworthy, and stays regardless.

### Grid or list, and a theme you can override

The documents screen offers both, with the choice remembered. **Grid is the
default**, matching `home/webext`, whose home screen has always been a grid of
thumbnail cards — and it is what makes rendering thumbnails worth the trouble.
iOS gets the same choice free from the system document browser.

The **theme override** is offered only on API 31+, where
`UiModeManager.setApplicationNightMode` exists; below it there is no way to
override the system theme without AndroidX, so the control is not shown at all.
A button that silently does nothing is worse than no button. Both this and the
view mode are VIEWER preferences kept on the device — the same shape as the
runtime's own locale and reduce-motion settings, which default to the OS and
never enter a document.

### Typography and the mark

The system font, deliberately, because that is what `slides` and `home/webext`
both use (`-apple-system, …, Roboto, …`) — on Android the system font IS Roboto,
so the chrome already matches the apps. The brand faces (`Fraunces`,
`Instrument Sans`) belong to the marketing site, not to app chrome, and
bundling them would cost a few hundred KB on a 122 KB app.

What did transfer: the extension's `-.015em` heading tracking (Android's
`letterSpacing` is already in ems, so the number moves across unchanged) and its
`font-weight: 600` emphasis — real 600 from API 28, bold below it. The **mark**
in the header is generated from `home/assets/home-logo.svg` by the same script
as the launcher icon, so the two cannot drift.

### Material 3, dynamic colour, and adaptive layout

The documents screen is Material 3 now, and the reason is specific: **dynamic
colour** and **adaptive large-screen behaviour** are what Play's editorial
surfaces reward, and neither can be hand-rolled. Dynamic colour means the app
adopts the user's wallpaper palette on Android 12+ — so the Bento palette below
is the FALLBACK for older devices rather than the intent. The brand stays present
through the mark and the thumbnails, which is the right place for it.

Measured cost, since the earlier decision turned on it: **+1.26 MB**, dominated
by `resources.arsc` growing 24× — applying an M3 theme references the library's
whole style and attribute graph and resource shrinking cannot prove any of it
unused. That ratio was the argument against it while tray was positioned as a
thin courier; it is worth paying once the goal includes being featured.

`EditorActivity` stays OFF Material on its own plain theme. It hosts one
full-screen WebView, the document supplies its own chrome, and Material would
only add inflation requirements.

**Adaptive layout keys off `smallestScreenWidthDp >= 600`, not `screenWidthDp`,**
and the difference is the whole lesson. A Pixel in landscape reports 873dp wide
and passes a width test — but it is only ~390dp tall, so a two-pane layout left
the grid **299px high**: a worse phone layout wearing a tablet's clothes. The
smallest dimension is the one that means "room in both directions", which is why
`sw600dp` is the platform's own tablet qualifier. A foldable reports the folded
width closed and the unfolded width open, and unfolding recreates the activity,
so it lands on the right layout with no listener.

On a tablet the grid shares the window with a **detail pane**: a large
first-page render, title, app, folder and date, and Open. That render at 400px is
the whole argument for having thumbnails at all — at 64×36 in a list row it is a
hint; at this size it is the document.

Column count comes from the available width, and the card's thumbnail height is
measured from the GRID rather than the screen — the screen is wrong twice over,
once because a hardcoded column count sizes every card for a phone, and again
because with a detail pane the grid is only part of the width.

### What the hand-rolled theme established (superseded by Material, kept for the reasoning)

The documents screen is ours to design — unlike iOS, where the root screen is
the system document browser — so it carries the same tokens as `home/webext`
rather than framework defaults. Palette, radii and the button variants come
straight from `home/webext/src/ui.css`, including its dark set: `values/` and
`values-night/` define the same colour names twice and the `-night` resource
qualifier switches them, so **dark mode needs no library and no runtime branch**.

It stays dependency-free, and that is now true rather than an excuse. An earlier
version of this file justified framework defaults with "every dependency this
screen does not have is one that cannot drift out of step with the WebView
work" — an argument about dependency risk in the part of the app where risk
actually lives, misapplied to the cosmetic part.

Material Components was measured rather than argued about: **+1.26 MB**, taking
a 616 KB app to 1.83 MB. The largest single line was `resources.arsc` growing
24× (26 KB → 619 KB), because applying an M3 theme references the library's
whole style and attribute graph and resource shrinking cannot prove any of it
unused — styles and attrs resolve by name at runtime. For an app whose logic is
136 KB of dex that is roughly 7× the app to style one screen. It would be the
right call for a bigger app, and if tray grows settings or onboarding screens it
becomes one; today it is not.

What that costs: pressed/focus states, minimum touch targets and the dark
palette are hand-rolled here rather than inherited. `<ripple>` drawables and an
explicit `48dp` minimum cover the first two.

### State: the document cycle works, on an emulator only

Verified end to end on a Pixel 7 / Android 16 emulator, driven through the real
UI rather than a harness:

- **New** creates a document where the user chooses, seeds it from the bundled
  shell, and opens it — the full Bento editor renders in the WebView
- the document's own runtime is live: its update check reached the network and
  reported v1.0.18
- **a save lands in place, with no picker** — 686,232 → 908,246 bytes, the
  activity never left `EditorActivity`
- the written file is a valid deck: `id="bento-doc"` present, preview markers
  present, well-formed from `<!DOCTYPE html>` to `</body></html>`, `docId` minted
- the document reopens from the recents list on its persisted grant
- the adaptive icon renders correctly under a circular launcher mask
- **New document fetches and verifies**: manifest signature checked, shell
  sha256 checked, cached as `slides-1.0.18.html` at exactly the signed 689,316
  bytes, written and opened. A failed fetch removes the empty file that
  `ACTION_CREATE_DOCUMENT` had already created.
- **document search works end to end**: a granted folder indexed 2 decks and
  excluded a decoy `.html` that contains the search word but carries no
  `#bento-doc` marker; typing `software` — a word in no filename — returns both
  decks by their own title, `Notes` returns one by file name, and a nonsense
  query returns none

Not yet verified:

- **anything on real hardware**, and no signing keystore exists yet
- the `ACTION_VIEW` route in (opening from a file manager, Drive, Gmail) and the
  read-only path it usually implies — the branch is written, not exercised
- Save-As / export, and the `<a download>` + `blob:` readback path
- a third-party self-saving app (TiddlyWiki) through the polyfill's params branch
- presenting: element fullscreen is declined, as on iOS, but Android's
  `onShowCustomView` gives a host full control of the fullscreen chrome — unlike
  WebKit's un-hideable ✕ — so this is worth revisiting rather than settling
