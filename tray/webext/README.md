# bento/tray — WebExtension

A browser host for Bento documents. Grant your decks folder once; after that a
deck you opened by **double-clicking** saves back to its own file with no
destination prompt.

Status: **works end to end.** Chrome 150 / macOS, 2026-08-02, against a shell
built from #213:

| action | result |
|---|---|
| ⌘S | **no dialog** — `[bento-tray] wrote Tray_Test.bento.html (898775 bytes) in place` |
| Save a copy… | prompts, as it must |
| Save read-only copy… | prompts, as it must |
| the working file afterwards | 898,775 chars, 17 slides, script tags 5/5 balanced, `readonly` unset |

The last row is the one that matters: the copy and the export went elsewhere
rather than overwriting the document being edited. An earlier build got that
wrong and silently destroyed it.

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
[bento-tray] wrote <file> (<n> bytes) in place
[bento-tray] not saving in place: <reason> — falling back to the browser picker
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

Same three methods `tray/ios` implements over a `UIDocument` bridge. **No
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
| `src/options.html/js` | extension page | where the folder is granted (needs a gesture) |

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
   `tray/webext/`, then the same file-URL toggle.
2. Open its **options** and grant the folder your decks live in
3. Double-click a `.bento.html` in that folder, edit something, press ⌘S

Expected: it saves with no dialog. Today, without the extension, that first ⌘S
asks where to put the file.

## What is unverified

Everything below needs the extension actually loaded — none of it is testable
from a page, and permission-gated behaviour reports `denied` under automation
(`working/home-design.md` §3.2, a trap that already produced two wrong
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
macOS app anyway — so Safari's answer is `tray/macos`, not this.
