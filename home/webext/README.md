# bento/home — WebExtension

A browser host for Bento documents. Grant your decks folder once; after that a
deck you opened by **double-clicking** saves back to its own file with no
destination prompt.

Status: **works end to end.** Chrome 150 / macOS, 2026-08-02, against a shell
built from #213:

| action | result |
|---|---|
| ⌘S | **no dialog** — `[bento/home] wrote Tray_Test.bento.html (898775 bytes) in place` |
| Save a copy… | prompts, as it must |
| Save read-only copy… | prompts, as it must |
| the working file afterwards | 898,775 chars, 17 slides, script tags 5/5 balanced, `readonly` unset |

The last row is the one that matters: the copy and the export went elsewhere
rather than overwriting the document being edited. An earlier build got that
wrong and silently destroyed it.

## Packaging

```bash
node scripts/pack-webext.mjs          # → dist/bento-home-<version>.zip
node scripts/pack-webext.mjs --check  # validate only (CI runs this)
```

It is an allow-list, not a recursive zip: `probe/`, `README.md` and `STORE.md`
are in this directory and must not reach a listing — the probes especially,
being four pages that open local files and talk across origins, which is
harmless to us and alarming to a reviewer. It also checks every file the
manifest names exists, every icon is the size it claims, and no permission is
declared but unused. The output is byte-reproducible, so the uploaded package
can be shown to be the reviewed one.

Listing copy, permission justifications and the data-usage answers live in
`STORE.md`.

## Releasing, and keeping unpacked installs current

Two distribution routes, and only one of them updates itself.

**Chrome Web Store and Edge Add-ons** update silently. Nothing to do.

**GitHub, loaded unpacked** never updates. Chrome ignores `update_url` for a
development install — it is running from a directory on disk, and nothing will
rewrite that directory. Self-hosting a `.crx` is not a way round it either:
Chrome refuses off-store installs on Windows and macOS.

So the extension tells those users instead. `src/update.js` asks
`chrome.management.getSelf()` for `installType` — which needs **no permission** —
and only a non-`normal` install ever checks. Store users are never asked and
never see a notice they cannot act on. The check is a GET for a static JSON file
with no identifiers and no query string; it can report, link, and nothing else.

**On by default, and switchable.** On, because an unpacked install has no other
way to learn it is behind, and because the app itself checks at launch by
default (`kernel/src/update.ts`). Switchable, because this repo has form on the
other side — the v0.9.1 fix existed so an anonymous visitor never phones home —
and the audience that installs from GitHub is exactly the one entitled to say
no. The switch is in Settings, next to what it does, and OFF means no request is
made at all rather than a result quietly discarded. **Check now** still works
when it is off: pressing a button is the consent the preference stands in for.

### What an unpacked user has to do, and the way it goes wrong

An unpacked extension is identified by its **directory path**. So the obvious
upgrade — extract the new zip somewhere convenient, "Load unpacked" from there —
produces a DIFFERENT extension: different id, different origin, empty
IndexedDB. No granted folders, no learned paths, no preferences, and the old
copy still installed beside it. The user lands on the first-run screen having
done the natural thing.

The safe procedure, which the notice spells out as numbered steps:

1. Download the zip from the release.
2. Replace the files **in the folder it was originally loaded from**.
3. `chrome://extensions` → **Reload** on bento/home.

Same path, same id, so the grants and everything else survive. The first-run
screen also carries a note for anyone who already got it wrong, because "an
unpacked install with no folders" is exactly what a botched upgrade looks like
and nothing can detect it from inside the new copy — the data is intact under
the old id.

Note that extracting over an existing folder leaves files a release has since
DELETED. Harmless (the manifest does not name them) but untidy; emptying the
folder first is cleaner, and keeps the path, which is the part that matters.

### To cut a release

```bash
node scripts/pack-webext.mjs
```

That writes two things into `dist/`:

- `bento-home-<version>.zip` — upload to both stores.
- `tray-release.json` — publish at `https://bento.page/releases/home/manifest.json`.

The JSON carries the version, the release URL, and the **sha256 of the zip just
built**. It is emitted rather than hand-written because a copied hash goes stale
in silence, and it is publishable at all because the package is byte-reproducible
— anyone can rebuild from source and confirm the zip they downloaded is the one
that was reviewed.

Bump `manifest.json`'s `version` before packing; the store rejects a re-upload of
an existing version, and unpacked users compare against exactly that number.

## Creating a document, and why it is verified

The `+` button downloads the current release of the chosen app and writes it
into a granted folder. Nothing is bundled — a shell inside the extension would
drift from the real release and be re-reviewed on every update — and as of
2026-08-16 no tray host bundles one, so this is the only way a new document
comes into existence anywhere.

That makes it a path worth being careful on: the thing being written is
executable HTML, landing on the user's own disk, which they will then
double-click and trust. So `src/release.js` earns it rather than assuming it.

1. The manifest is fetched **as text**. It is a signed envelope —
   `{"payload": "<json string>", "sig": "<base64>"}` — and the fields live
   inside the payload string. There is no top-level `url`.
2. The ECDSA P-256 / SHA-256 signature is verified over the payload's exact
   bytes, against the release public key compiled into the extension.
3. The payload's `app` must match the channel it came from. The channels are
   sibling paths on one origin, so a genuine manifest served from the wrong one
   would otherwise hand somebody a different application.
4. The downloaded shell must hash to the `sha256` that signature covers.
5. Only then is a file handle opened. Any refusal writes **nothing** — a
   half-created document is a document somebody opens.

Signature over the pin, pin over the bytes. A signature with no pin verifies a
description of a build; a pin with no signature is a digest chosen by whoever
served the bytes.

`release.js` is a deliberate **mirror** of `kernel/src/update.ts`, not an
import: the kernel is TypeScript that Vite compiles into an app shell, and this
extension ships as unbundled ES modules Chrome loads from disk. Adding a bundler
to share forty lines would cost more trust than it buys, because the uploaded
package would stop being the reviewed source. The price is a maintenance rule —
**if the release key or the envelope format changes in the kernel, change it
here too** — and `scripts/test-webext-release.ts` enforces it: it asserts the
two keys are byte-identical and verifies a real manifest captured from
`bento.page`, with no test seam in the path.

That captured fixture is the point. The first version of this feature read
`manifest.url` off the envelope's top level and threw `the release server did
not offer a build` on every single invocation — the `+` button had never once
worked — and the rig passed throughout, because its fixture was written to the
shape the code expected instead of the shape the server sends.

## Two surfaces

- **Toolbar click → the library** (`src/home.html`): browsing and managing.
  An existing tab is focused rather than duplicated. This only works because the
  manifest declares NO `default_popup` — declaring one makes the click open it
  and `action.onClicked` never fires.
- **`Alt+B`, or right-click in a document → the panel** (`src/panel.html`):
  switching documents while working in one. It was a popup; a popup dies when it
  loses focus, which is exactly when you click into the document you switched
  to.

`sidePanel.open()` must be called **synchronously** inside the gesture that
triggered it (Chrome 116+, this extension's floor). An `await` before it loses
the gesture and Chrome refuses without saying so — which is why the lapsed-grant
notification opens the library instead: it is handled after an await.

## Icons

`icons/icon.svg` is the source of everything visual: the favicon for the
extension's own pages, and the four PNGs Chrome takes for the toolbar action
icon. It carries a corner radius, unlike `home/assets/home-icon.svg`, which is
square because iOS applies its own squircle mask.

The PNGs are exports of it and must be regenerated rather than edited:

```bash
cd home/webext/icons
for n in 16 32 48 128; do
  printf '<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent}svg{display:block;width:%dpx;height:%dpx}</style>' "$n" "$n" > /tmp/i.html
  sed -n '/<svg/,$p' icon.svg >> /tmp/i.html
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless \
    --disable-gpu --hide-scrollbars --default-background-color=00000000 \
    --window-size=$n,$n --screenshot=icon-$n.png /tmp/i.html
done
```

Two things `pack-webext.mjs` refuses, both of which have already happened:

- **A PNG with no alpha channel.** The originals were RGB, so opaque squares by
  construction, and no radius anywhere could round the toolbar.
- **An SVG that is not well-formed XML.** This command lives here rather than in
  a comment inside `icon.svg` because an XML comment may not contain a double
  hyphen, and every flag above has one. Pasting it in there made the file
  malformed, and the mark rendered as a broken image on every surface.

## Distribution

**The app stores are the main channel** — Chrome Web Store, Edge Add-ons, and
the others as they come. The unpacked folder here stays supported for anyone who
prefers it.

A store install needs **no Developer mode** and no unpacked folder. What it
still needs is **Allow access to file URLs**: a per-extension user toggle, off by
default, required for content scripts on `file://`, and grantable by no manifest
permission. It is detectable (`chrome.extension.isAllowedFileSchemeAccess()`),
so it should become a guided one-time setup step rather than a silent failure —
not yet built, and that API's MV3 behaviour is unverified.

## Operating it

**The folder grant lapses when the extension reloads.** A reload resets the
service worker and the directory permission commonly drops back to `prompt`.
`background.js` will not request it from there — a service worker has no user
gesture, so the request would be refused, and a save is the wrong moment to
discover that. Open the options page and press **Check**; renewing is one click,
which is what `probe/directory.html` measured.

Every save says which path it took:

```
[bento/home] wrote <file> (<n> bytes) in place
[bento/home] not saving in place: <reason> — falling back to the browser picker
```

Safe-by-default only helps if the safe path explains itself. Without that second
line, a lapsed grant is indistinguishable from the extension not being installed
— which cost a full diagnostic round trip.

## Why an extension and not a web page

`bento/home` was going to do this as an ordinary page. It cannot, and three
measurements in `docs/DECISIONS.md` (2026-08-02) say why:

- A `FileSystemFileHandle` **cannot be delegated across origins** — `postMessage`
  serialises it and the receiver fires `messageerror`. So the origin that
  acquires a handle is the only origin that can use it, and a launcher can never
  hand one to a document.
- Running every document on one shared origin would pool `bento-autosave`
  (plaintext doc JSON, version history) and `bento-member-<docId>` (collab
  private keys) into a store any document could read.
- A **directory** grant behaves differently, and that is the unlock: it survives
  a reload and covers files inside it that were never picked.

An extension changes the shape completely. The document stays on `file://`,
which the browser treats as a unique origin per file — so per-document isolation
is free, and no deck can read another's storage. The extension holds the folder
grant and does the writing.

## The contract is tray's, unchanged

`kernel/src/save.ts` tests one thing — `typeof window.showSaveFilePicker ===
'function'` — and needs only:

```
showSaveFilePicker({suggestedName}) -> { name, createWritable() }
createWritable() -> { write(Blob|string), close() }
```

Same three methods `home/ios` implements over a `UIDocument` bridge. **No
web-side changes**, and every deck ever saved works, including files whose
embedded runtime predates this extension.

One wrinkle that does not exist on iOS: on `file://` in Chrome,
`showSaveFilePicker` **already exists**. So here the bridge REPLACES a working
API rather than filling a gap, and it is deliberately conservative — it only
takes over when the suggested name is the file already on screen. "Save a
copy…", templates, read-only exports and invites all mean *a new file somewhere
you choose*, so they fall through to the native picker untouched.

## Shape

| file | world | job |
|---|---|---|
| `src/page-bridge.js` | MAIN | overrides `showSaveFilePicker`; decides in-place vs native |
| `src/relay.js` | ISOLATED | pure relay, no logic — the two worlds cannot reach each other |
| `src/background.js` | service worker | holds the grant; matches the file; writes |
| `src/status.js` | shared | the two preconditions, read by both surfaces below |
| `src/popup.html/js` | toolbar | says whether a save will land, before one is attempted |
| `src/options.html/js` | extension page | where the folder is granted (needs a gesture) |

The popup and the options page read the same `status.js`, so they cannot tell
the user different stories about whether the next ⌘S will prompt.

Both content-script halves are required: an isolated world can talk to the
extension but not touch page globals; a MAIN world can define
`showSaveFilePicker` but has no extension APIs.

## It depends on `openedFileName()`

The override only fires when `suggestedName` is the file on screen, so it rests
on what `save.ts` passes. For a double-clicked deck there is no handle, and
`openedFileName()` falls back to the URL:

```js
if (fileHandle?.name) return fileHandle.name
const base = decodeURIComponent(new URL(location.href).pathname.split('/').pop() ?? '')
return /\.bento\.html$/i.test(base) ? base : null
```

So `Q3.bento.html` on disk arrives as `suggestedName: "Q3.bento.html"` and the
comparison holds. That fallback shipped in 1.0.12 for an unrelated reason —
"Save offers the file you are looking at" — and this depends on it. If it ever
goes back to naming saves after the deck's TITLE, this extension silently stops
taking over and every save returns to a destination prompt.

Note the `.bento.html` test in that fallback: a deck saved as plain `.html`
returns null, the suggested name comes from the title instead, and the override
declines. Correct, but it means the extension only covers `.bento.html` files.

## The matching problem

A page gives us `/Users/…/Decks/Q3.bento.html`. A `FileSystemDirectoryHandle`
knows its own **name** but not its path, so the grant and the sender cannot be
compared directly. Resolution is two steps, and the second is the one that
matters:

1. find files in the granted tree with the sender's file **name**, and require
   exactly one — ambiguity is declined, never guessed at;
2. ask the directory to **`resolve()`** that candidate, which returns its path
   segments *relative to the grant*, and require the sender's own path to end
   with them.

**Step 1 alone was wrong, and shipped that way.** A name match is not an
identity match. With the grant at `~/Documents` holding
`~/Documents/Clients/Q3.bento.html`, opening a working copy at
`~/Desktop/Q3.bento.html` produced exactly one hit — the sender's own copy is
outside the grant, so it is not a second hit and the ambiguity guard cannot
fire. A save then wrote the Desktop document over the Clients one and never
wrote the file being edited. No attacker required.

**Residual, stated plainly because the API cannot close it.** Nothing exposes
the grant's absolute path, so step 2 verifies a relative *suffix*, not a full
path. A page deliberately placed at `<somewhere-else>/Clients/Q3.bento.html`
still matches a grant containing `Clients/Q3.bento.html`. That is far narrower
than a bare filename — it requires reproducing the victim's folder structure —
but it is not nothing, and it is why the content-script match stays limited
rather than covering every local HTML file.

## Trying it

1. **From a store:** install, then enable **Allow access to file URLs** on its
   card in `chrome://extensions`.
   **Unpacked:** `chrome://extensions` → Developer mode → **Load unpacked** →
   `home/webext/`, then the same file-URL toggle.
2. Open its **options** and grant the folder your decks live in
3. Double-click a `.bento.html` in that folder, edit something, press ⌘S

Expected: it saves with no dialog. Today, without the extension, that first ⌘S
asks where to put the file.

## What is unverified

Everything below needs the extension actually loaded — none of it is testable
from a page, and permission-gated behaviour reports `denied` under automation
(`working/design/home-design.md` §3.2, a trap that already produced two wrong
conclusions).

~~1. Can an MV3 service worker `createWritable()` on a stored directory
handle?~~ **YES** — measured 2026-08-02. No offscreen document needed.

~~2. Do MAIN-world content scripts run before the deck's runtime?~~ **YES** —
the override was in place before `save.ts` read it.

~~3. Does file-URL access work?~~ **YES**, with the per-extension toggle enabled
by hand.

4. ~~THE EXPORT PATHS~~ **BOTH BUGS FOUND, 2026-08-02.**

   **(a) "Save a copy…" overwrote the open deck.** Not a bad threshold — the
   discriminator does not exist. `saveFile(doc, forcePicker)` reaches the same
   call with the same arguments for both intents. Override disabled until
   `save.ts` makes intent explicit.

   **(b) View-only and present-only copies stopped saving.** Once a save
   returned one of our handles, `save.ts` kept it and later passed it back as
   `startIn`, where the native picker requires a real `FileSystemHandle` — it
   threw `TypeError`, and `pickHandle` rethrows anything that is not
   `AbortError`. Fixed: `forNative()` strips any `startIn` that is not a genuine
   handle before calling through. **A polyfilled handle must never escape into
   an API that needs the real thing** — the general lesson, and the reason to
   audit every other value this bridge hands back.

   The original text follows, because the reasoning it records was wrong in an
   instructive way:

   **THE EXPORT PATHS — untested, and the failure mode is destructive.** The
   override fires only when `suggestedName` is the file on screen. If that
   comparison is wrong in the other direction, "Save a copy…", presentation
   packages, read-only copies, templates and invites would **silently overwrite
   the open deck** instead of creating a new file: no dialog, no warning,
   original gone. `save.ts` passes `suffix` for those and `openedName` is
   nulled when a suffix is present, so it *should* decline — but "should" is
   what the first three probes in this arc each disproved.

5. Autosave write-back and self-update, which route through the same function.

## Not this

**Firefox** implements no File System Access API at all, and its extensions
cannot write arbitrary files either; that needs native messaging with a native
helper. Firefox stays download-a-copy.

**Safari** likewise has no FSA, and a Safari Web Extension ships inside a native
macOS app anyway — so Safari's answer is `home/macos`, not this.
