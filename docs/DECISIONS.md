# Decision log

Append-only. Newest first. One entry per settled decision that a parallel
agent (or future session) might otherwise re-open or contradict. Keep entries
to a few lines: **what** was decided, **why**, and where the details live.
Reversing a decision = a new entry that supersedes the old one, not an edit.

Format:

```
## YYYY-MM-DD — Title
Decision. Why. Pointers.
```

---

## 2026-08-02 — dash budgets BYTES with consent, not rows with a refusal

**Supersedes the hard stop proposed in the dash design doc §3.2** (refuse at
1,000,000 rows or 25 MB, on the importer and every other write path). The two
guards it sat on top of are unchanged and are not optional.

**What stands, because the failure past the budget is SILENT.** Measured at a
539 MB file: the `#bento-doc` element still holds exactly one child text node,
of length **zero**. `textContent` returns `''` — a string, no throw — so the
workbook opens EMPTY, and self-save then re-splices whatever is in memory over
the user's file. Unrecoverable loss caused by a successful parse of nothing. So,
from the first commit that can save:

1. `parseDoc` returns a tagged result, never `null`. Only an **absent or empty**
   block boots the starter document.
2. **Refuse to serialize if the boot parse did not succeed** — a hard error
   surface offering "Save an untouched copy" and "Copy document JSON", with the
   editor and autosave disabled.

Those two are what prevent the data loss. The row cap was belt-and-braces on
top of them, and it costs precisely the users who know what they are doing.

**What changes:**

- **Budget in BYTES, not rows.** 1M × 12 is 65 MB; 1M × 2 is ~10 MB and
  comfortable. A row cap refuses workable files and admits unworkable ones.
  Excel's 1,048,576 is a *structural* limit users have learned; ours would be a
  proxy for a quantity we can measure directly.
- **Warn, then take informed consent — never refuse.** Past the ceiling, say
  what will actually break, in this browser, with numbers.
- **The threshold scales with `canWriteInPlace()`** (`kernel/src/save.ts:470`).
  With the File System Access API a save is an in-place write; without it —
  Safari, Firefox, every iOS browser — every ⌘S downloads the whole file to
  `~/Downloads`, so the practical ceiling is far lower. One global constant
  cannot express that.
- **Import offers an alternative, not a no**: the first N rows, an aggregate, or
  the whole thing with the warning accepted.

**The target is unchanged at 100,000 rows × ~12 columns (~6 MB)** — where the
file emails under attachment limits, downloads in a second, round-trips as JSON
per PLATFORM §7, and the 2.5 s autosave rewrites it imperceptibly. It is a
target, not a cap.

Compute is not the constraint and is not close: hand-written columnar JS over
typed arrays, zero dependencies, single-threaded, measured on **10,000,000
rows** — scan-sum 5.9 ms, filter+sum 10.6 ms, two-dimension group-by 11.5 ms.

## 2026-08-02 — `bento/dash` is settled, and it stands for DAta SHeets

**Keep `bento/dash`.** The name contracts **DA**ta **SH**eets — the two halves
of the app, the typed data model and the grid. It is not short for "dashboard";
a dashboard is something the app can produce, not what it is.

Recorded because the 2026-07-24 naming entry justifies it as "spreadsheet +
tables + dashboards", which leads with the output surface and reads as
mis-scoped. That framing is what caused the name to be re-opened and argued at
length today. Don't re-open it without a new argument.

This blocked the first commit that writes a `FORMAT` constant — PLATFORM §3
puts the string into every saved file and there is no server to migrate
anything — and it is now unblocked.

**Weighed and set aside** (collisions verified live, not recalled):

- `cells` — best suite fit, but it sounds like Ex**cel**. A replacement that
  echoes the incumbent's name reads as derivative of it.
- `views` — genuinely dual (a SQL view *and* a visual view), but it names
  *looking* when the app's own boundary rule is *reckoning* ("does it
  recalculate → dash").
- `measures` — the BI term of art, and the convergent pick of two independent
  root analyses, but "bento measures" parses as a verb clause.
- `base` — its retirement reason above has **inverted**: it was dropped partly
  for reading as "database, which this platform does not have", and dash now
  is one. Set aside as flat rather than wrong; reconsider only if `dash` ever
  proves to mis-signal in the field.
- `figures` parses as a verb clause; `grid` collides with "bento grid", an
  established UI design-trend phrase; `rows` is rows.com, a live "AI Data
  Analyst" product; `calc` is LibreOffice Calc, and is clipped besides.

**Namespace was deliberately down-weighted.** PyPI `dash` is Plotly's dataviz
framework and npm `dash` is the cryptocurrency, but the app never ships as a
bare word — it is `bento/dash`, at `bento.page/dash`, in
`Bento_Dash.bento.html`. That is the mitigation the 2026-07-24 entry already
prescribes for the crowded Bento namespace: always carry the `bento/<app>`
form and the descriptor.

## 2026-07-28 — Vault is a capability broker; identity is multi-user from commit one

**Refines the 2026-07-27 vault entry rather than superseding it.** Three
capabilities arrived separately — AI, live data, key distribution — and are one
shape: **vault brokers what a travelling file structurally cannot hold** (a
secret, a private network, an authority). That definition is the test for what
belongs in vault and what does not.

Settled:

- **Vault configuration lives in the SHELL, never the document** — a second
  plaintext `#bento-vault` block under the same splice contract. In the document
  it would travel with the content and leak an internal hostname to anyone
  emailed a deck. "Export for outside" strips it, visibly.
- **A minted shell points its update channel at the vault.** Not a choice:
  `serializeWith(shell, doc)` (`kernel/src/save.ts:322`) re-splices into a
  freshly fetched shell and discards everything else, so shell config survives an
  update only if the update comes from the vault. Needs a visible "return to
  upstream" escape so a defunct vault cannot freeze former employees' files.
- **Dual signatures.** Canonical runtime = the file minus `#bento-doc` and
  `#bento-vault`; its sha256 must match upstream's signed manifest, and the vault
  signs its config BOUND to that hash. A compromised vault can then redirect
  endpoints but cannot ship modified editor code. Build in v1 — unaddable later.
- **Documents carry a query NAME, never query text.** The vault maps names to
  parameterised statements defined by an admin. Otherwise every deck anyone opens
  is an exfiltration tool against the database.
- **A bound document always carries its last known values.** A vault connection
  refreshes data, never supplies it, or "works with no network" falls by another
  route.
- **A vault refresh is a COMMIT, not a derivation.** Linked charts derive
  identically on every replica today; a fetch does not (two replicas fetching at
  different moments get different rows). Extend `scripts/test-sync.ts` first.
- **Archival is reinstated; backup stays cut.** Different products. Copying bytes
  is solved; being able to OPEN them in ten years is not, and a Bento archive
  renders itself and stays machine-readable as plaintext JSON with no vendor in
  the loop. Vault produces the archive shape; restic moves it.

**Who it serves, re-argued and resolved.** Three of the capabilities (live data,
retention archive, private release channel) are properties of a DEPLOYMENT rather
than a person, so the org case got stronger; the case against did not weaken,
because it rests on maintenance surface — every org-shaped pillar implies
multi-user identity, and that is what a single maintainer carries indefinitely.
Resolution: this decides what we PROMISE, not what we build — broker, index and
archive serve one user and fifty identically. Ship single-user and promise
nothing organisational, **but design the identity model multi-user from the first
commit**: per-user query authorisation and spend attribution cannot be retrofitted
without migrating every deployed vault. The gate for building organisational
features is a real stated requirement, not a count of pillars.

## 2026-07-27 — Thumbnails: plain markup plus a parser-blocking remover, NOT `<noscript>`

**Supersedes the 2026-07-26 entry below** on the one point of where the preview
lives. Everything else in it still stands: written at save time, replaced never
appended, `PREVIEW_BUDGET` tiers, and above all **encrypted decks get no
preview**.

`<noscript>` renders only where scripting is DISABLED, and iOS satisfies
neither half of that. Probed with a page that is red by default, turns green
from an inline script, and carries a blue `<noscript>`, the iOS thumbnailer
renders **RED** — it runs no script AND does not render `<noscript>`. So the
feature worked in Finder and macOS QuickLook and did nothing on the platform it
was built for; every deck in Bento Tray stayed a dark box.

That same gap is the fix. A renderer that runs no script still renders ordinary
markup, and every real reader does run script — so the preview ships as a plain
`[data-bento-preview]` element with a **parser-blocking inline remover**
immediately after it. The thumbnailer keeps the preview (it never runs the
remover); the reader never sees it (the script executes before the browser
paints). Measured: at removal `document.readyState` is `"loading"` and
`performance.getEntriesByType('paint')` is EMPTY — zero frames containing the
preview were ever presented. Not a fast flash; no flash.

The 2026-07-26 entry chose `<noscript>` to avoid exactly that flash, and
accepted "a thumbnailer that does run scripts sees no preview" as the trade.
Both halves turned out to be wrong about iOS, and the replacement costs neither.

**A QLThumbnailProvider extension does not work and should not be retried.** It
registers correctly (`pluginkit` shows `SDK = com.apple.quicklook.thumbnail`)
but its process never launches: iOS uses its own generator for `public.html`
and does not consult third-party extensions for types it already handles.
Likewise `NSURLThumbnailDictionaryKey` via `UIDocument.fileAttributesToWrite`,
which is accepted and then silently dropped for local files — inspecting the
xattrs afterwards finds only `com.apple.lastuseddate`.

`previewIsSafe` is now MORE load-bearing, not less: the preview lands in the
live DOM rather than sitting inert inside `<noscript>`, so the refusal that
keeps a script tag out of it protects the page and not just the file structure.
`shell-gate.mjs` gained two source assertions — that the remover is emitted at
all, and that it sits immediately after the preview, since anything between
them is markup a browser could paint first.

---

## 2026-07-27 — bento/vault is the ORG service point, and the AI broker is what forces it

**Supersedes the 2026-07-25 "personal server" entry.** Vault is not a personal
document library. It is the **service point for a group of people and their
documents**, self-hosted on hardware that group owns.

The reframe came from subtraction. Of the five promises in the old entry, four
were met or taken while it sat unbuilt: mobile reach went to `bento/tray` plus
any existing File Provider (iCloud Drive, Dropbox), sharing went to the collab
relay (the file IS the capability), per-device version history went to
`kernel/src/autosave.ts`, and plain file sync was never ours. What survived
personally was **search alone**, and it has since been narrowed by measurement:
Spotlight indexes rendered HTML text, so the `#bento-doc` script block is
invisible to it — but the save-time preview is ORDINARY MARKUP now (the
thumbnails entry above), and markup indexes. Measured 2026-07-28 with
`mdimport -d2 -t` on a deck saved from the current shell: the whole title slide
comes back in `kMDItemTextContent`, and a token planted on slide two does not.
**Page one is already searchable for free; the unmet need is FULL TEXT.** One
real problem — now a smaller one — does not need a personal server.

**The AI broker is the pillar that makes vault necessary rather than nice.** A
self-contained document travels, so it can never carry a model credential — that
is emailing your API key to everyone you share the deck with. `localStorage` is
per-device, and under tray it is per-DOCUMENT (the origin is
`bento-tray://<sha256 of path>`, `EditorViewController.swift`), so it degenerates
into configuring a key per deck. The only place a credential can live once and
serve a whole library is a server the group runs. **In-app AI is architecturally
impossible without something vault-shaped**, and the same index serves both
search and retrieval. Points a local model (Ollama on the same box) at the
library without anything leaving the network, which is the existing README claim
made real.

**SSO gates distribution, never the file.** Once someone holds the bytes they
open them forever, offline, with no server — that is the product, not a bug. SSO
can gate access to the vault and the distribution of decryption keys (the
`bento/enc` envelope and the owner→invite→member chain already exist for this).
Revocation is therefore FORWARD-ONLY: a revoked member keeps what they already
downloaded, exactly as `collab-design.md` already documents for devices. Say this
before an enterprise security review discovers it.

**The org profile deletes most of the hard design.** NAT traversal,
hole-punching, WebRTC, the dead-drop and the portable relay twin all exist to
serve one case: a personal laptop asleep behind a home NAT. A company vault is a
box on a network with a hostname and a certificate, reached directly. So
`relay-design.md` steps 2–5 are NOT v1, and neither are the equivalent vault
steps.

Corollary worth stating plainly: the org vault **is** a custody service, and that
is correct — central custody is the point of centralising. The personal vault
explicitly was not. Those were two products wearing one name; we are building the
org one.

**New invariant — AI is additive, never load-bearing.** Every app stays fully
functional with no vault and no model, the same rule as "vault is optional". If
an AI feature ever becomes required to edit, `PLATFORM.md` §1 is gone.

**Sequencing: the org deployment is the DESTINATION, not the first build.**
Architecturally this costs nothing — a single-user vault IS the org vault with
one user: same index, same key chain, same broker. Build that, design toward
multi-user, promise neither.

**Licence:** the runtime stays MIT (`THIRD_PARTY_NOTICES.md` is embedded in every
saved file, so copyleft on the shell would attach to every document a user
emails). Vault is a separate repo with its licence chosen at commit #1. Never
relicense slides.

## 2026-07-26 — File-manager thumbnails: a `<noscript>` render of page one, written at save time

**Decided:** 2026-07-26. Kernel zone (`kernel/src/save.ts`), so it binds every
Bento app; the drawing is per-app (`slides/src/preview.ts`).

**The problem.** Thumbnailers render a document's HTML but do not run its
JavaScript, so every Bento file thumbnailed as the same dark box — correctly,
because before the runtime boots every deck *is* the same bytes plus the boot
splash. Confirmed on iOS, and confirmed that the iOS-side escape hatch does not
exist: an image attached via `UIDocument.fileAttributesToWrite` under
`NSURLThumbnailDictionaryKey` is accepted and then silently dropped for local
files (only `com.apple.lastuseddate` survives on disk). **The fix has to live
in the file.** So `serializeBody` now writes a static rendering of page one
into the shell on every save, and it fixes every platform at once with no
native extension anywhere.

**`<noscript>`, not "render it and let JS remove it".** The obvious design —
always paint the preview, have the runtime delete it at boot — flashes page one
in front of every reader on every open, for as long as the 600 KB payload takes
to inflate. `<noscript>` has exactly the semantics wanted: its contents are
rendered only when scripting is off, which is precisely the audience.
Empirically the DOM proves it, not just the spec — with scripting on the host
node has **zero element children** (its content is one raw text node) and a
bounding box of 0×0, so there is nothing to flash, nothing in layout, nothing
for print or present to exclude. The cost is that a thumbnailer which *does*
run scripts sees no preview — i.e. today's behaviour. A regression is not
possible, only an improvement.

**Scaling: `transform: scale(calc(min(100vw, <aspect>vh) / <width>px))`.**
CSS Values 4 length-over-length division yields the plain `<number>` `scale()`
needs, so the whole page scales as one unit and every inline px the renderer
emitted is left alone. **`<svg viewBox><foreignObject>` was tried first and does
not work**: Chrome renders it correctly, QuickLook's WebKit does not
(absolutely-positioned children disappeared, content scaled non-uniformly), and
QuickLook is the renderer this feature exists to serve. Verify changes here
against `qlmanage -t -s 640 -o <dir> <file>` — the real macOS thumbnailer, and
the only honest test. Chrome's `--blink-settings=scriptEnabled=false` suppresses
`--screenshot` entirely in Chrome 150; drive `Emulation.setScriptExecutionDisabled`
over CDP instead.

**Encrypted decks get NO preview — the load-bearing rule.** A plaintext
rendering of page one beside a `bento/enc` envelope hands over the title slide,
usually the most disclosive page, and does it invisibly. `previewAllowed()`
checks the in-memory password flag AND re-parses the body as an envelope,
because those fail independently. Removal of any existing preview is
UNCONDITIONAL and happens before that decision, so a deck that gains a password
loses its preview on the next save.

**Shell furniture, not format.** Nothing enters `#bento-doc`; no format field
is added; old files open unchanged; an app that registers no provider (spaces)
saves as before. The preview is replaced, never appended — `capturePristine()`
snapshots the file as loaded, so the clone already carries the previous save's
copy.

**Budget: 64 KB** (`PREVIEW_BUDGET`, slides/src/model.ts), ~10% of the shipped
shell. Measured: starter deck 25 KB (2.6% of the file); a page-one chart 11 KB;
a table 16 KB; a page with a 2.5 MB photograph degrades to 1.7 KB. Over budget,
page one re-renders with raster payloads replaced by tinted boxes; over it
again, a title card. Downscaling a hero photo instead would be
better and was NOT done: image decode is async and `serializeWith`/
`serializeFile` are synchronous (update.ts, `window.bento.serialize()`), so an
async provider is a kernel API change of its own.

Guards: `scripts/test-preview.ts` (encryption veto + the refusal to emit markup
carrying a script tag or `</noscript>`), and `scripts/shell-gate.mjs`, which
now also proves a preview-carrying file satisfies the splice contract and
asserts both rules are still wired into the save path.

## 2026-07-26 — A language pack lives in the FILE and nowhere else

No browser-local install. A "keep it on this computer" option (localStorage)
was **built and then removed**, because `localStorage` is scoped per ORIGIN
and that is fatally misaligned with how Bento is used: the download comes from
`bento.page` (an https origin) and the file is then opened from disk (a
`file://` origin). A language added on the website was therefore GONE the
moment the user saved the deck and reopened it locally — the exact journey the
product encourages, and "I added Korean and it vanished" is not a bug a user
can diagnose.

One home also matches the platform: the file *is* the software, so a language
belongs to the deck. The trade — adding a language requires saving the file —
is stated plainly in the UI ("Added when you next save") rather than hidden.
Adding is staged on click and written on the next save because on browsers
without File System Access, writing on click means silently downloading a
second copy of the user's deck.

Corollary: anything that remembers pack *content* outside the file
reintroduces this. Viewer *preferences* (locale, reduce-motion) stay
browser-local on purpose; that asymmetry is deliberate. Details:
`docs/i18n-packs.md`, `slides/src/packs.ts`.

## 2026-07-26 — The pack carrier is generic; pack POLICY is not. This is not a plugin system.

The kernel mechanism is already extension-agnostic and should stay that way:
`registerShellBlocks` / `readShellBlocks` (`kernel/src/save.ts`) carry
arbitrary typed blocks in the shell and know nothing about languages, and
`registerUpdatePrepare` (`kernel/src/update.ts`) is a generic "refresh
version-bound extras" hook. Signature verification and hash pinning are being
made generic in the kernel too (branch `claude/i18n-pack-verify`). Reuse all
of that freely.

**Do not generalize the policy.** Language packs are DATA and their worst case
is bounded — a tampered or stale pack shows wrong or English words. That bound
is why degrade-per-string, keep-on-refresh-failure, and auto-refresh on update
are the right rules *for packs*.

Anything carrying CODE is categorically different: unbounded failure (it would
hold the document, the file handle, and the collab keys), and it breaks the
property that makes self-update trustworthy — that the shell only ever runs
bytes from a signed release. Such a thing would need its own policy (pinned at
install, never auto-refreshed) and must not inherit the pack rules by reusing
the pack machinery.

So: reuse the carrier and the crypto; do not treat "we have packs" as evidence
that a plugin system is designed or wanted. It is not.

## 2026-07-26 — Side-loaded artifacts: sign the index, pin the bytes, fail closed

Language packs are fetched over the network, so they get the **same two-step
the app shell's own update already gets**: an envelope signed with the release
key (`{payload, sig}`, ECDSA P-256 / SHA-256) whose payload pins each
artifact's `sha256`, and a download that is accepted only if its bytes hash to
that pin. Signature over the pin, pin over the bytes. **No second key and no
second trust root** — `PUBLIC_KEY_JWK` in `kernel/src/update.ts` is it.

The mechanism lives in the kernel (`verifySigned`, `fetchPinned`) because it is
the same for anything side-loaded; the *policy* stays in the app
(`slides/src/packs.ts`). Keep that boundary: the kernel helpers verify BYTES,
they do not decide what is safe to use. Packs are DATA with a bounded failure
mode (wrong words on screen), which is why a pack that fails a refresh is kept
at its existing version rather than dropped. Anything side-loaded that ever
carries CODE needs stricter policy — pinned at install, never auto-refreshed —
and must not inherit the pack rules by reusing the same fetch.

**Fail closed, no legacy path.** An unsigned or unpinned index yields no
listings at all. Nothing is published yet, so there is no permissive fallback
to keep — and one added later would mean whoever answers for the channel picks
the strings in the UI.

**A pack already inside a file is NOT re-verified** (`readPacksFromShell`). It
was verified at the door, and once spliced it carries exactly the trust the
document does — anyone who can rewrite that block can rewrite the checking
code too. Re-verifying would need the network at boot, which breaks offline
use. Proof rig: `node scripts/test-packs.ts` (throwaway key, real crypto).

## 2026-07-26 — Language packs are published under a SIGNED INDEX, separate from the manifest

Amends the "Signing and release" paragraph of `docs/i18n-packs.md`, which said
the update manifest would gain a `packs` array. It does not.

`release.mjs` emits the packs and signs **one index** over all of them at
`releases/slides/packs.json` — the same `{payload, sig}` envelope, the same
offline key, and literally the same signing code as the manifest (extracted to
`scripts/sign-payload.mjs`). Each listing pins its pack's `sha256`; individual
packs are not separately signed. Clients verify the index once, then hash each
download against its signed hash.

Why not inside the manifest: shipped files ignore a manifest that is not
strictly newer than themselves (downgrade-replay protection), so pack hashes
carried there could never be corrected **between** app releases — and a fixed
translation is not a new app version. A separate index is re-issuable any day,
and `manifest.json` keeps meaning exactly one thing: here is the app shell.
Signed code and signed data stay two artifacts.

Still one key, still local-only signing, and `publish-site.mjs` now gates the
index the way it already gates the shell (indexed pack missing, hash drifted,
or packs staged with no index = refuse to publish). Details and the exact
payload shape: `docs/i18n-packs.md` §"Signing and release"; `scripts/sign-packs.mjs`.

## 2026-07-25 — i18n: a bundled core of 9 languages, everything else a signed pack

The 7 non-English catalogs cost **115,572 B** of the shell even after key-once
packing — more than any dependency, and an English-only shell is 28.8%
smaller. But we want *more* languages, not fewer. So: **bundle a core, ship
everything else as signed downloadable packs.**

- **Bundled (9):** the existing 8 (en, ja, zh-Hans, zh-Hant, es, fr, de, it)
  plus **Portuguese**. Nothing regresses for current users; Portuguese is
  added because Brazil has a real English-proficiency gap and it is in the
  cheapest cost tier.
- **Everything else:** a pack, signed with the existing release key and
  released centrally alongside each app release, fetched only on explicit user
  action and spliced into the file.

**No further languages get bundled by default** — demand declares itself
through contributions (#17 offers Korean), and a pack can be revised without
cutting an app release.

Measured facts worth not re-deriving: cost is **~14 KB per language regardless
of script** (CJK is the *cheapest* — 2.6× the bytes per character but a third
of the characters). Simplified↔Traditional conversion on the fly does **not**
pay: only 43.3% of characters match, because the difference is vocabulary
(软件/軟體) not glyph form, and deflate already recovers the genuine redundancy.
Rank candidate languages by the **English-proficiency gap in the segment that
uses this tool**, not by speaker counts — which is why Hindi is not in the core
despite 610M speakers.

Full design, risks and status: **`docs/i18n-packs.md`**. The risk that will
ship broken if ignored: **self-update must carry packs forward** — `update.ts`
re-splices the document into a *new shell*, and packs live in the shell.

## 2026-07-25 — Every PR gets human review before merging to main (for now)

At this stage of development the maintainer reviews **every** PR before it
lands on `main`, including agent-authored ones. No auto-merge. The point is
visibility into what the agents are actually producing while the multi-agent
workflow is still being shaken out — the cost is throughput, and that is
currently the right trade.

Supporting config, already in place: `main` is branch-protected with one
required approval, and CI (`validate`) is a **required status check**, so a red
build cannot merge. Admin bypass stays enabled for the maintainer.

### FUTURE ACTION — revisit when review becomes the bottleneck

When PR volume outgrows one reviewer, consider auto-merging **app-zone** PRs on
green CI. If that happens, these paths must **always** require human review
regardless, because a bad merge is either silent or catastrophic:

- **`kernel/src/`** — every app depends on it.
- **`slides/src/sync/`, above all `crdt.ts`** — convergence bugs are silent and
  corrupt documents. The rig is necessary but not sufficient: it only generates
  short strings, which is why it missed the large-text stack overflow (#47).
- **`server/`** — one bad deploy breaks live collaboration for everyone at
  once, and there is no per-user rollback.
- **`scripts/release.mjs` / `sign-release.mjs` / `keygen.mjs`** — the signing
  and release path.
- **Anything touching the `#bento-doc` splice contract or the update-manifest
  shape** (`PLATFORM.md` §2, §6) — these brick files already on users' disks.

Do not enable auto-merge without that exclusion list encoded somewhere
enforceable, not just written down here.

## 2026-07-24 — Naming: the platform is `bento`, the mark is `bento/.`, all lowercase
Settled after working through the whole namespace. **Do not reopen these** —
each rejected candidate was rejected for a specific reason, recorded below.

- **Platform: `bento`** (lowercase). Not "Bento Box", not "Bento Suite" — the
  bare word is the family, and `bento/<app>` reads as members of it.
- **Wordmark: `bento/.`** — the trailing dot stands for the platform (the apps
  complete the slash). This is a MARK, not a name: `/` is a path separator and
  is illegal in filenames, URLs, package names and social handles, and
  punctuation is disregarded for trademark purposes. Anywhere a name must be
  stored or typed, it is `bento`.
- **Casing: lowercase everywhere**, brand and machine alike. This deliberately
  collapses the usual split (`Docker` the brand / `docker` the command)
  because the lowercase form is already the file's own identity — `doc.type`
  is `bento/slides`, the MIME type is `application/bento+json`.
- **Apps:** `bento/slides` (shipped), `bento/spaces` (Notion/notes-like),
  `bento/dash` (spreadsheet + tables + dashboards — absorbs what would have
  been a separate database app), `bento/vault` (document library / personal
  storage). A word-processor app is planned; **`bento/folio` is the proposed
  name, NOT yet confirmed** (alternatives considered: draft, prose, write —
  `pages` and `docs` are unusable, being Apple's and Google's).

**Rejected, with reasons:** `box` — the natural collective noun, and Box, Inc.
is a cloud-storage company; keep it as an informal collective at most.
`base` — retired once dash absorbed tables; also reads as "database", which
this platform does not have. `bits` — generic, tonally wrong for an editorial
brand, and pushes search toward snack food. `page`/`pages` — reserved: it is
the best name for a future web-publishing app, and Apple Pages owns the
word-processor association. `shelf`/`library` — weaker than vault, and library
reads as "code library" to this audience.

**Note on the crowded namespace:** several unrelated SaaS products are called
Bento (email automation, link-in-bio, analytics, a dead FileMaker database).
The field is crowded, which weakens everyone's claim — including ours. The
practical cost is discoverability, not legal exposure. Mitigation is the
`bento/<app>` form, the `bento.page` domain, and always carrying the
descriptor. Get real clearance before commercialising; a bare wordmark would
be hard to register, a composite (mark + logo) much less so.

## 2026-07-25 — bento/vault is a personal server; the relay is a separate product
**Supersedes the "map, not the keys" entry below.** Vault is not an index and
not a sync service — it is "cloud services without a cloud": your documents
live on hardware you own (desktop / NAS / homelab) and it provides
reachability, search, cross-document references and version history without
any of it running on someone else's computer. The closer reference is
Tailscale, not Dropbox.

Vault and the **relay** are separate products with separate release trains.
The relay is dumb infrastructure — rendezvous, an optional encrypted
dead-drop, presence, nothing else — hosted on Cloudflare for the masses and
self-hosted by serious users. Every actual service runs on the personal
server; if the hosted relay ever accretes features, self-hosting becomes
second-class and we lose the audience this is for.

Consequences: the relay needs a portable
(Docker) implementation because the current Worker+DO+hibernation stack is not
realistically self-hostable; independent release trains require a versioned
capability handshake (we can no longer control deploy order); background
execution is unreliable on every platform so the protocol must be correct
after unbounded offline periods; mobile uses iOS File Provider /
Android DocumentsProvider rather than a background daemon; and the agent syncs
a FOLDER, so no Bento app needs any changes. Retained from the superseded
entry: the relay only ever sees ciphertext, and **export-to-standalone-file
always works** — that invariant is what keeps "your data is a file you own"
true while vault holds it.

## 2026-07-24 — [SUPERSEDED] bento/vault holds the map, not the keys
The document library must not become a custody service. It stores an encrypted
index of what documents exist and how they reference each other; each document
keeps its own encryption password and collab credentials. Compromising the
vault reveals *what you have*, not what is in it, and losing the vault loses an
index, not your work. This preserves the property that makes the relay
defensible — files stay authoritative, server loss is survivable — and keeps
the name an honest promise. Any sync tier is E2EE and optional (DO for
coordination + R2 for encrypted blobs; never D1/plaintext), and self-hostable.

## 2026-07-24 — Suite expansion: bento/spaces and bento/dash
Two new apps begin: **bento/spaces** (Notion/notes-like) and **bento/dash**
(spreadsheet + tables). Development fans out across parallel
agents and multiple tools (Claude Code, Codex, Antigravity) — coordination
rules in `docs/PARALLEL-WORK.md`, platform contract in `docs/PLATFORM.md`.
Planned pre-fan-out groundwork: extract the shared kernel (monorepo layout,
apps beside `slides/`), add per-PR CI validation gates (typecheck +
build:single + splice conformance + test-sync). Releases stay local/signed
regardless of CI.

## 2026-07-24 — Hold marketing-surface i18n
Don't localize the bento.page landing page or README yet: the landing page
will be rebuilt around the multi-app suite, so translations now would only
drift. App UI i18n (7 locales) is the localization that matters and already
ships. Revisit once the new landing page is stable.

## 2026-07-24 — No bot/AI-agent identities in git history
External PRs get provenance review before merge (`gh api users/<login>`);
scatter-bot/AI-agent contributions are declined. A bot's merged PR was
scrubbed from history via filter-repo + force-push, and `main` is now
branch-protected (1 required review, no force-pushes). Human contributors'
authorship is preserved normally.

## 2026-07-22 — v1.0.7 launch (Show HN) and post-launch fixes
Launched publicly (#1 on HN, ~1000 pts). Post-launch priorities were driven
by thread feedback: collab focus-steal fix, chart zero-baseline for negative
values, mobile-Safari pinch, reduce-motion mode — all shipped in v1.0.8
alongside panel UI for community format features (text gradient, text-stroke,
blur/blend, backdrop-filter). Community format features are accepted when
additive + composable (unknown fields preserved; effects compose).

## v1.0.7 — Morph identity decoupled from element id
Elements carry optional `morphId` overriding the morph pairing;
`data-flip-id = morphId || id`. `id` stays the stable identity (selection,
anchors, CRDT). Chosen over mutating ids, which would have broken comment
anchors and collab node identity. Details: CLAUDE.md (render.ts section).

## v0.9.x — Charts are in-house (ECharts removed)
ECharts was 630KB (~47% of the shell); replaced with charts-lite interpreting
the same option SHAPE (pure JSON, no functions). Exotic configs degrade
gracefully rather than crash. Don't re-add a chart dependency; extend
charts-lite instead. Details: CLAUDE.md (charts section).

## v0.9.x — Collab credentials mint-at-creation, dormant until shared
Decks are born collab-capable but never auto-connect unless the doc arrived
carrying collab or the user opted in — fresh templates/demos must never phone
home. Read-only and writer roles are enforced cryptographically at the blind
relay, not honour-system. Spec: docs/collab-design.md.

## v0.x — Releases are cut locally, never in CI
The signing key never leaves the maintainer's machine; the signed bytes are
the served bytes. CI may validate (typecheck/build/gates) but never signs,
publishes, or deploys. Runbook: docs/RELEASING.md.

## v0.x — Single-file architecture is the product
One HTML file = document + viewer + editor, working offline from file://.
The splice contract on `#bento-doc` is frozen forever (shipped updaters
depend on it). Everything else is negotiable; this isn't. See
docs/PLATFORM.md §1–2.

## 2026-07-25 — Large assets travel out-of-band; the relay stays blind

Assets over 64KB (`BLOB_INLINE_MAX`) no longer ride inside CRDT ops. They are
encrypted client-side, uploaded once to the relay's R2 bucket, and referenced
from the document by a content-addressed key; peers fetch and decrypt on
receipt. This was forced by measurement, not preference: Durable Object storage
values cap at ~2MB, so the previous inline path produced frames the relay
accepted-then-dropped, and the client re-sent forever. Details and threat model
in `docs/blob-offload.md`.

Three properties are load-bearing and must not be traded away:

- **The relay cannot read a blob.** It pipes ciphertext without buffering. The
  key is `HMAC(roomKey, sha256(plaintext))`, so identical bytes dedupe *within*
  a room and are unlinkable *across* rooms — a plain content hash would have
  let the relay confirm two rooms hold the same file.
- **R2 is optional.** Absent binding = `/b/` answers 501, clients inline small
  assets and same-origin tabs still resolve from the local cache. A
  self-hoster without a bucket degrades; they are not broken. This follows
  from the relay being dumb infrastructure (see the vault entry).
- **Failures are visible, never silent-but-wrong.** An unresolved blob leaves
  the asset absent and renders empty rather than blank-looking-fine. The whole
  change set exists because the old failure mode was invisible.

Operational consequence: the relay must be deployed **before** a client that
depends on the blob endpoints — the standing rule for this split, same as the
keepalive and access-verification changes.

## 2026-07-25 — Solo review model: PR + green CI, zero required approvals

**Amends the entry below** ("Every PR gets human review before merging"). The
intent stands — every change lands via PR and the maintainer reads it — but the
*mechanism* was wrong and was quietly defeating the CI gate.

`main` required 1 approving review. GitHub forbids approving your own PR, so on
a one-person project that requirement is unsatisfiable and **every** merge had
to use `--admin`. Admin bypass skips *all* branch protection, including the
required `validate` status check. Net effect: the CI gate was decorative, and a
red build could land on `main` with nothing to stop it.

Now: `required_approving_review_count: 0`, PRs still required, `validate` still
a required status check, force-pushes and deletions still blocked. A normal
`gh pr merge` works and genuinely cannot merge a red build. Admin bypass stays
*available* (`enforce_admins: false`) but is now an exception rather than the
daily path — if you find yourself reaching for `--admin`, that is a signal
something is actually failing.

Human review is a practice, not a GitHub setting, for as long as the team is
one person. Restore a real approval count the moment a second reviewer exists;
the future-action exclusion list in the amended entry still applies.

## RTL is two separable problems; only one of them is the document's

**Decided:** 2026-07-26. Supersedes nothing; establishes the split.

Content bidi and chrome mirroring get confused constantly, and treating them
as one feature produces the wrong answer to both.

*Content* direction is a correctness bug and belongs to the document: an
Arabic sentence puts its full stop in the wrong place without `dir="auto"`,
and it is wrong for everyone who opens the file. Cheap, uncontroversial, do it.

*Chrome* mirroring is a UI convention. Nothing is incorrect without it; the
editor merely feels foreign to an RTL reader. It was deliberately sequenced
AFTER an RTL language pack existed, because mirroring a UI whose every label
is still English is worse than not mirroring — and because the point of
shipping a pack first is to learn whether RTL users actually turn up.

The invariant that falls out of the split — **the document never mirrors** —
is recorded in `PLATFORM.md` §8 and binds every Bento app. A document that
looks different depending on the viewer's locale is a format-level bug.

Cost, measured rather than guessed: ~430 bytes in the shipped shell for the
whole chrome conversion, and **zero** for the languages themselves, because
every RTL language is a pack. Size was never the constraint here. The real
constraint is that 32 of the editor's ~36 direction-adjacent coordinate sites
live in `canvas.ts` (Moveable/Selecto), which cannot be verified by an agent —
synthetic drags on Moveable handles do not register at all. Pinning the
document surfaces LTR was sufficient to leave that math untouched, and that is
the outcome to preserve: if a future change makes chrome direction reach
`canvas.ts`, stop and reconsider rather than refactoring the coordinate code.

**No plural system.** Hebrew (and later Arabic) ship without one. Of 15
count-bearing strings only 6 take a real count; the rest are index labels
(`Axis {n}`, `slide {n}`) or abbreviated times. Six strings do not justify
changing the catalog format, the build script, the CI gate and every catalog.
Translators phrase them count-agnostically instead (`מחוברים: {n}`), which is
standard practice when a framework lacks plurals and costs nothing at runtime.
Revisit only if a language arrives where the workaround genuinely fails.

## One English word, two meanings = two keys

**Decided:** 2026-07-26. Consequence of English-string-as-key; binds every
Bento app that uses `kernel/src/i18n.ts`.

Gettext-style catalogs key on the English source string, which quietly assumes
that one English word means one thing. It often doesn't. `Loop` was the
animation loop AND the media playback toggle; `solid` was a fill style AND a
line style. Every language had to pick one word and be wrong in the other
place — Swedish wants *enfärgad* for a solid colour and *heldragen* for a
solid line, and no amount of translator care fixes that from inside the
catalog. Both were found independently by pack authors, which is the signal:
if a translator has to ask "which one is this?", the key is broken, not them.

**The rule.** When one English string reaches `t()` from two call sites that
mean different things, the more specific site takes a QUALIFIED key
(`Loop animation`, `solid colour`) and the plainer one keeps the bare word.
Do not add a context-prefix convention — the key is also what English users
read, so it has to be a sentence, not `fill.solid`.

**Model words never move.** Values like `solid`/`gradient` are format words
stored in the document. Disambiguate the LABEL only: `labeledSelect()` takes
`[value, label]` pairs precisely so the displayed string and the stored string
can diverge. A "fix" that changes what is written to `doc` is a format change
wearing an i18n costume.

**The cost, so it is paid deliberately.** Re-keying invalidates that entry in
every bundled catalog AND in every pack, silently — the string simply falls
back to English. So it happens BEFORE packs are published, in one PR, with
the affected keys listed for pack authors to pick up. After packs ship,
re-keying is a coordinated break across every language and should be weighed
against living with a slightly wrong word.

**Interpolated values are strings too.** `t('This {kind} is…', { kind })` with
a model word for `kind` puts an English noun inside a translated sentence.
Localise at the call site (`{ kind: t(kind) }`) — and check the sentence still
agrees grammatically, since a substituted noun carries gender in half the
languages we ship (French needed "Ce fichier {kind}" once `vidéo` could land
in it).

## 2026-07-26 — bento/tray: the iOS host is a suite member, and it is generic

The native iOS app is named **bento/tray** — "Bento Tray" on the App Store,
bundle id `page.bento.tray`, source in `tray/` beside `slides/` and `spaces/`.

**It runs ANY self-contained HTML document, not only Bento's.** That is not
scope creep bolted on; the Swift never parses the document and never did — it
is a courier that serves bytes into a WKWebView and polyfills the one File
System Access call the page needs to save itself. Bento decks are simply the
first documents it carries. Any single-file HTML app that saves itself works
identically, which on iOS is otherwise impossible: every browser there is
WebKit and none ship that API.

Naming notes, so this is not relitigated:

- **`bento/host` was rejected.** It names the mechanism, not the thing, and the
  suite convention is `bento/<what you get>`. "tray" keeps the food metaphor and
  says what it does — a tray carries any bento, whoever made it.
- **Plain "Bento" is unavailable** on the App Store: an unrelated Food & Drink
  app holds the exact name, and App Store names are globally unique. "Bento
  Tray" and "BentoTray" were both free at time of checking. That check reads
  published listings only — reservations in App Store Connect are invisible to
  it, so confirm there before submitting.
- The App Store name carries no slash. Per the 2026-07-24 naming entry, `/` is
  a mark, never a stored name.

**One app, not two.** A separate "generic HTML runner" listing would risk
guideline 4.3 (duplicate apps from one developer) and doubles the listing
overhead — screenshots, privacy labels, review cycles — for no gain. The
Developer Program is $99/yr per ACCOUNT, so a second app costs nothing in fees;
the cost is entirely in maintenance.

Consequence already implemented: each document gets its OWN origin
(`bento-tray://<sha256 of path>`), because a shared origin would let one
document read another's localStorage and IndexedDB — tolerable when every file
is yours, a real leak between unrelated third-party apps.

## 2026-08-02 — Agents get tools to measure and check, not a layout engine

Issue #160 was an agent authoring a deck from `agents.md` alone; #194 split out
its largest finding — that an agent cannot measure text, so every card, caption
and two-line heading is a guess, and overflow and collisions all follow from
that. The proposed remedies were `h: "auto"`, declarative layout containers,
and a `validate()` call. We shipped the checking tools and deliberately did NOT
build the layout engine.

**`h: "auto"` is impossible, not merely unwise.** `h` is a required `number`
that morph does arithmetic on — `a.h + (b.h - a.h) * p`, then `scale(h / b.h)`.
A string there yields `height: "autopx"` (invalid CSS, silently dropped) and
`scale(NaN)` in every SHIPPED copy of Bento, which is frozen code we can never
fix. Any future auto-height must be an ADDITIVE flag (`autoHeight: true`) with
`h` still holding the last resolved number, so old shells read a valid box.

**Layout containers are declined for now.** A `layout: {type, gap, cols}`
container resolved to concrete pixels would work — the file would stay
absolute-pixel, so morph, the drag handles and old shells are untouched. It is
declined because the hole it was proposed to fill is now filled: with
`window.bento.measure()` an agent can compute a row or grid directly, and
`agents.md` carries the column arithmetic pre-computed. Containers would make
correct layout DECLARATIVE, not POSSIBLE — convenience, not capability.

The cost is not the arithmetic, it is the semantics. Every element is draggable
today and the model says where it is; inside a container, dragging a child must
either be disabled (confusing, the handles are right there) or break it out
(needs UI and a rule for what "out" means). That is more design work than
`measure()` and `validate()` together were.

If containers are ever built, note the constraint that makes them safe:
resolution must be PURE GEOMETRY (gaps, weights, counts) so every replica
derives the same answer, which is what lets `syncLinkedCharts` and
`syncConnectors` derive-not-commit. The moment resolution measures text it
becomes environment-dependent — a webfont that has loaded on one replica and
not another gives different heights — and replicas LWW-fight over the geometry.
That, not the layout maths, is the reason auto-height children are the hard case.

**What shipped instead** (#193, #195, #197, #198): `measure()` sizes text from
a spec, before the element exists; `validate()` reports what the runtime
silently swallows; both go through the real renderer, and through ONE module,
so they cannot disagree about whether a box fits. The unknown-key tables are
generated from `model.ts` via the TypeScript AST and pinned in CI, because a
validator that reports a real property as unknown is worse than none — an agent
acting on that deletes working configuration.

Also settled while here: on a morph arrival the rule is PER ELEMENT and turns
on whether the element has a morph partner. With a partner it is already in
motion, so `fx.enter` and `fx.countUp` are both skipped. With no partner it is
new to the slide, has no tween to fight, and both run. Do not "simplify" this
back into a blanket morph-vs-entrance branch; that blanket rule is what made
count-ups silently dead and `slide-left` silently mean "rise 14px".

## 2026-08-02 — Publishing one app may never delete another's artifacts

`site/` is assembled for ONE app and mirrored into `bento-site` with
`rsync -a --delete`, so anything that build did not write is removed from
bento.page. Measured, not theorised: a cloned `release.mjs --app spaces`
staged a spaces site, and a publish against a copy of the real published tree
removed **47 live files** — `releases/slides/Bento_Slides.bento.html`,
`releases/slides/manifest.json`, `packs.json`, all 22 signed language packs,
`slides/index.html`, all four gallery decks, `guestbook/index.html` — with
every existing gate reporting green.

Shipped slides files check `releases/slides/manifest.json` at launch
(`slides/src/main.ts`) and their pack channel at `releases/slides/packs.json`
(`slides/src/packs.ts`). Both are frozen URLs in files already on disks, so a
deletion takes those channels offline permanently, for every copy in the
world, with no client-side repair. It is the one publish mistake with no way
back.

**Why nothing caught it: the existing gates are fail-OPEN.** The
shell-consistency gate and the pack-index gate are both
`if (existsSync(<path in site/>))` — an artifact that is *missing* skips the
check instead of tripping it, and missing is exactly the dangerous case.
PR #192's `--exclude guestbook.bento.html` is one hardcoded filename, not a
mechanism; it must not be read as evidence that protection exists.

**The gate is a deletion inventory of the DESTINATION, and it is fail-closed.**
Before mirroring, walk the published tree and refuse if any path would
disappear. If the destination cannot be inventoried at all, refuse — that is
the case where we know least about what we are about to overwrite.
Deliberate removal is `--allow-deletions`, which lists what it would drop.

Deletions are singled out from changes on purpose. A changed file is a release
doing its job; the one byte-change nobody can repair, a manifest going
backwards, already has its own monotonicity gate.

Gate on the published INVENTORY, not on `releases/*/manifest.json`. The
deletion set included `slides/index.html`, the gallery, `agents.md`,
`skills/`, `LICENSE`, `404.html`, `help/`, `q/`, `og.png`, `robots.txt` and
`sitemap.xml` — none of which a manifest-shaped gate would have seen.

Rig: `scripts/test-publish-gate.mjs`; shared logic `scripts/site-inventory.mjs`.
This is the first half of the multi-app release work
(`working/spaces-design.md` §6.1); per-app assembly — build one app, restore
the others byte-identically from the published tree — is the second, and
spaces cannot be released until both exist.

## 2026-08-02 — bento/home runs documents in a per-document origin, or not at all

`bento/home` is a launcher (`home/`, `working/home-design.md`): it holds no
document content, only `FileSystemFileHandle`s in IndexedDB, so a deck you were
working on reopens with write access after one permission click. That part is
measured and built. **How a document is actually OPENED is the hard part, and
this entry records why the obvious answers are wrong.**

**The constraint.** Opening a deck with silent save means running that file's
own code somewhere AND getting the handle to it. A blob URL inherits the
creating page's origin, so `window.open(URL.createObjectURL(file))` runs the
document on *home's* origin — with full access to home's store of writable
handles to every other deck. A file someone emailed you could rewrite all of
them. That is a real escalation over double-clicking it, where the file gets an
opaque origin and reaches nothing.

**A shared runner origin (`run.bento.page`) was considered and REJECTED.** It
fixes the wrong half. Documents could no longer read home's handles, but they
would all share one origin with each other, and a Bento document persists:

- `bento-autosave` IndexedDB — `recovery` (PLAINTEXT doc JSON, keyed by docId)
  and `versions` (a timeline of the same)
- `localStorage` `bento-member-<docId>` — the device's collab member PRIVATE KEY

So one runner origin creates a pooled store, which does not exist today, holding
the full plaintext content and version history of every document opened through
it plus the keys that authorise writing to their collab rooms. Any document on
that origin can read all of it. This is the same conclusion the 2026-07-24 tray
entry reached from the other direction ("a shared origin would let one document
read another's localStorage and IndexedDB"), and it is not a coincidence: it is
the same threat with a different host.

**`file_handlers` + `launchQueue` is NOT an isolation approach.** It delivers a
double-clicked file to the *installed PWA* — home's own origin. It answers "how
does the OS reach us", not "where does the document execute". It composes with
per-document isolation; it does not substitute for it.

**Ruled: per-document origin, or home does not open documents.** Home may
acquire a handle any way it can (picker, drop, `launchQueue` when installed) and
must hand off to an origin derived from the document's identity. Until that
exists, `home/src/launch.ts` REFUSES and says so in the UI, rather than quietly
taking the blob route. A launcher that silently widened the blast radius of
every deck you open would be worse than one that does not open them yet.

Also considered: a shared runner with storage deliberately neutered (no
autosave, no member keys, `Clear-Site-Data` per load). It removes the pool by
breaking recovery, version history and collab identity, and stays safe only for
as long as every future feature remembers not to persist anything. Per-document
origins get the same property structurally. Not adopted.

**Hosting consequence, measured 2026-08-02.** `bento.page` is GitHub Pages
behind Cloudflare (`x-github-request-id` on the apex); `sync.bento.page` is
Cloudflare-only. GitHub Pages serves one custom domain per repo and no
wildcards, so per-document origins cannot be hosted the way the rest of the site
is — the runner belongs on Cloudflare beside the relay, with its own deploy
cadence and the deploy-order care that implies (`docs/PLATFORM.md` §5).

**To confirm before building** (none of it testable in an automated browser —
permission-gated APIs report `denied` there without prompting,
`working/home-design.md` §3.2, a trap that already produced two wrong
conclusions):

1. Does a `FileSystemFileHandle` survive a cross-origin `postMessage` and stay
   usable? Permissions are per-origin, so the receiving origin re-prompting once
   is expected and acceptable; being unusable is not, and would sink this shape.
2. Cloudflare Universal SSL covers one label (`x.bento.page`), not two
   (`x.run.bento.page`). If so, a single hyphenated label — `<hash>-run.bento.page`
   — avoids paying for Advanced Certificate Manager. Worth checking before
   committing to a naming scheme, because it is baked into every stored origin.

**Naming.** `run`, not `slides` or `deck`. The runner never parses the format —
it executes a self-contained file that may be slides, spaces or sheets. An
app-named origin would isolate nothing extra (every deck would still share an
origin with every other deck) and app names should stay free for the apps' own
pages. The precedent is `sync.bento.page`: a subdomain marks a TRUST BOUNDARY,
not a product. An origin that executes files strangers sent your users is the
last one that should share a name with anything you want trusted.

## 2026-08-02 — MEASURED: a file handle cannot be delegated across origins

Follow-up to the entry above, which ruled that bento/home must run documents in
a per-document origin. **That is not reachable, and the measurement says so
unambiguously.**

`tray/webext/probe/` (run it with `node scripts/probe-origins.mjs`) picks a file on one
origin, grants write access there, and `postMessage`s the handle to another
origin. Chrome 150, macOS, 2026-08-02:

```
SENT     control ping → http://localhost:5302
SENT     handle       → http://localhost:5302
  [runner] CONTROL  plain object arrived — the channel works.
  [runner] MESSAGEERROR — a message arrived but could not be deserialised
```

The control object lands; the handle does not. `postMessage` **succeeds on the
sending side** — the handle serialises fine — and the receiving origin fires
`messageerror` instead of `message`, meaning deserialisation was refused. This
is why the first run of the probe looked like silence: nothing was listening for
`messageerror`, and a refusal is indistinguishable from a lost message without
it.

**The consequence is larger than "option B needs a different transport".** The
origin that acquires a handle is the only origin that can ever use it. So:

- Home cannot be a broker. It cannot hold handles for an isolated runner.
- Per-document origins cannot be reached the other way either, by having the
  document's own origin do the picking: the origin name depends on which
  document it is, and you cannot know that before reading the file, and you
  cannot move the handle after. The circularity is not incidental.

**What that leaves**, none free:

1. **Home and documents share one origin.** Rejected in the entry above and the
   reasons are unchanged: `bento-autosave` (plaintext doc JSON, version
   history) and `bento-member-<docId>` (collab private keys) pool into one
   store any document can read.
2. **Home never opens documents** — a drop target and a list, with opening left
   to the OS. Safe, and much less useful.
3. **Sandboxed iframe + save proxy.** Run the document in
   `<iframe sandbox="allow-scripts">` WITHOUT `allow-same-origin`, so it gets an
   opaque origin and can reach no storage at all — not home's, not another
   document's. Home keeps the handle and performs the write itself, with the
   document asking through a postMessage protocol.

Option 3 is the tray shape, and tray already proves the protocol half:
`tray/bridge.js` polyfills `showSaveFilePicker`, so `save.ts` needs no
host-specific code and the app does not know it is hosted. Reusing that contract
rather than inventing a second one is the point of the 2026-08-01 entry on
`tray/android/`.

**To measure before committing to option 3** (again: not testable in an
automated browser): an opaque-origin document has NO localStorage and NO
IndexedDB, so `bento-autosave`, version history, `bento-member-<docId>`,
language choice and reduce-motion all fail or degrade. Whether the runtime
survives that gracefully, and whether the degradation is acceptable, decides
whether home can open documents at all.

## 2026-08-02 — MEASURED: an opaque origin is blocked by unguarded storage, not by incapability

Third measurement in the bento/home sequence (`tray/webext/probe/sandbox.html`, Chrome
150, macOS). Same deck loaded twice from a blob: once in a plain iframe, once in
`<iframe sandbox="allow-scripts">` with no `allow-same-origin`, so the second
gets an opaque origin. The control is what makes the result readable — it
separates what the sandbox breaks from what breaks anyway.

| capability | control | sandboxed (opaque) |
|---|---|---|
| `localStorage` read/write | ok | **SecurityError** — sandboxed, lacks `allow-same-origin` |
| `indexedDB` present | object | object |
| `indexedDB.open` | ok | **SecurityError** — access denied in this context |
| `caches` | object | **SecurityError** |
| `crypto.randomUUID` / `subtle` | ok | **ok** — secure context survives |
| app boot | ✓ 17 slides | ✗ nothing |

**The interesting part is the failure mode.** Nothing reached `window.onerror`
and no promise rejected, so from outside it looked like a silent death. The
shell's own loader had caught it and printed to the page:

> This file could not start: Failed to read the 'localStorage' property from
> 'Window': The document is sandboxed and lacks the 'allow-same-origin' flag.

So the runtime does not fail because it NEEDS storage. It fails on the first
unguarded `localStorage` touch during boot — `kernel/src/i18n.ts` `resolve()`
reading `bento-lang`, which runs at module scope and therefore before anything
else. There are 39 `localStorage` call sites across `kernel/src` and
`slides/src` and no safe accessor.

**That is bounded and mechanical, not architectural.** A guarded accessor
(returns null / no-ops when storage throws) would let a document boot in an
opaque origin.

> **RESOLVED, same day (#205, `c1e8902`).** `kernel/src/storage.ts` now guards
> every one of those call sites, and the table above is out of date in its last
> row: the built shell boots in an opaque origin with **17 slides and 19
> surfaces, identical to the unsandboxed control, zero errors**. Do not re-run
> the sandbox probe expecting a failure — it passes now. What the table still
> reports correctly is the *storage* rows: `localStorage`, `indexedDB.open` and
> `caches` all throw there, and always will. Worth doing on its own merits regardless of home: the same
unguarded reads mean a deck opened with cookies-and-site-data blocked, or in
some embedded webviews, shows "this file could not start" rather than working
with default preferences.

**What it does NOT fix**, and this is the actual product decision: an opaque
origin has no persistent storage at all, so a document hosted this way loses
auto-save and crash recovery, local version history, and its collab member
identity (`bento-member-<docId>` is re-minted per session). Whether a launcher
may open documents that quietly cannot autosave is a question about what Bento
promises, not about what the browser permits.

Sequence so far: handles cannot be delegated across origins (entry above), so
the only isolation left is an opaque-origin frame with home proxying saves; an
opaque-origin frame is reachable once storage access is guarded; and what
remains is deciding whether a document with no persistence is one we are willing
to serve. Not settled here.

## 2026-08-02 — bento/home is closed; the host is a WebExtension (`tray/webext/`)

Home was a web page that would remember your decks and reopen them with write
access. Three measurements in one session closed it, and the same three point at
the successor.

**What killed it.** A `FileSystemFileHandle` cannot be delegated across origins
(entry above): `postMessage` serialises it and the receiving origin fires
`messageerror`. So the origin that ACQUIRES a handle is the only origin that can
use it — home cannot be a broker. Per-document origins are unreachable from the
other side too, because the origin name depends on which document it is, which
is unknowable before reading the file, and the handle cannot move after. What
remained was: run every document on one shared origin, where `bento-autosave`
(plaintext doc JSON, version history) and `bento-member-<docId>` (collab private
keys) pool into a store any document can read. Rejected.

A launcher that can list decks but not open them is not worth building.

**MEASURED, and it is the unlock** (Chrome 150, macOS,
`tray/webext/probe/directory.html`): a DIRECTORY grant is not per-file.

```
GRANTED  <folder>                       queryPermission: granted
  ── reload ──
RESTORED <folder>  kind=directory       queryPermission, no gesture: granted
[file 1] getFileHandle('bento-probe.txt', {create:true})
[file 1] the FILE's permission, unprompted: granted   ← never picked
[file 2] the FILE's permission, unprompted: granted
```

One folder grant survived a reload — still `granted` with no gesture, and
re-grantable with one click when it does lapse — and covered files inside it
that were never picked. So a host holding a directory handle can write ANY deck
in that folder, including one the user opened by double-clicking, which no web
page can do for itself.

**The shape.** The document stays on `file://`, which the browser treats as a
unique origin per file — per-document isolation for free, the thing three probes
failed to construct. A content script is the bridge transport; the extension
holds the directory handle and performs the write.

That is `tray`, in a browser. `tray/README.md`'s contract —
`showSaveFilePicker({suggestedName}) → { name, createWritable() }` — is
explicitly "platform-neutral; only the transport lookup and the native file
layer are not". `save.ts` needs no host-specific code and the app never learns
it is hosted.

**`tray/webext/`, not `tray/chrome/`.** Chrome, Edge, Firefox and Safari
extensions are one format with different manifests, so a browser name would be
wrong at the second target. Same reasoning as the `tray/android` entry: sharing
the name makes sharing the bridge contract the default rather than a convention
someone must remember. Note it is a PARTIAL tray — it supplies the file layer
and the transport, not the document browser or thumbnails `tray/ios` provides.

**Firefox gets nothing from this.** It implements no File System Access API at
all, and its extensions cannot write arbitrary files either; that needs native
messaging with a native helper. Firefox stays download-a-copy. Safari likewise
has no FSA, and a Safari Web Extension ships inside a native macOS app anyway —
so Safari's answer is `tray/macos`, not an extension.

**Still unverified, and the next thing to measure:** whether an MV3 service
worker can use a stored directory handle to `createWritable()` at all, or
whether the write must happen in an offscreen document or extension page. Keep
the write behind one function so the answer can move without touching the
contract.

**Kept from home:** `tray/webext/probe/` (four probes, all reusable) and
`home/src/deckmeta.ts`, which reads a deck's title without executing it — the
extension needs exactly that to label what it is about to save. The launcher UI
and the recents store are superseded by the directory grant.
## 2026-08-02 — One autosave database per app, migrated once

`kernel/src/autosave.ts` used a single `DB_NAME = 'bento-autosave'` and a single
`DB_VERSION` for every app. Two problems, and the second is the dangerous one.

Snapshots from different apps piled into one store wherever they share an
origin — `bento.page`, or any local server. bento/spaces has been writing into
bento/slides' database since its scaffold landed (`spaces/src/main.ts` calls
`putRecovery` on a 2.5s debounce).

`DB_VERSION` was shared too, and that breaks in one direction only: a new app
bumping it to 2 makes every ALREADY-SHIPPED shell of every other app throw
`VersionError` on open and lose autosave entirely. Shipped shells are frozen
code — 1.0.11 files are in the world and will go on opening version 1 forever.
There is no way to reach them.

**The name is `${appId}-autosave`.** `appId` is already `bento-slides` /
`bento-spaces`, so this reads `bento-slides-autosave` with no doubled prefix
and — deliberately — **no special case for the app that happened to be
first**. An earlier draft grandfathered `bento-autosave` for slides to avoid
orphaning data; carrying the data over is a better answer than a permanent
exception, and each app now owns its own version line.

**Migration copies, once, and never moves.** Renaming alone would silently drop
every user's recovery snapshot and their whole version timeline — a visible
feature emptying itself, which is a bug report, not a migration. It runs only
into an empty target, so a second pass cannot duplicate the timeline or
resurrect a snapshot the user deleted. The legacy database is left intact
because shells already shipped keep writing to it, and the copy of the app the
user opens next must still work; `pruneOld` ages its contents out on its own.

Everything is copied, not just the running app's rows. Nothing in a snapshot
records which app wrote it, and it does not need to: `docId` is a uuid, so
another app's rows can never match a lookup. Filtering would mean guessing.

`appConfig()` is read LAZILY inside `openDb()`. It throws before
`configureApp()` runs, and a kernel module that explodes at import time
depending on evaluation order is the trap `app.ts` exists to avoid — its header
comment named autosave as config-free and is corrected in the same change.

Rig: `scripts/test-autosave.ts`, run for both apps in CI. It fails against the
old shared-name code (7/8), which is the property that makes it a gate.

## 2026-08-02 — A release seeds from what is published, and builds one app

Second half of the multi-app release work (`working/spaces-design.md` §6.1).
The first half made a destructive publish impossible; this one makes a
non-destructive one possible.

`release.mjs` was slides-shaped end to end: `rmSync(site)` then stage slides.
One release builds ONE app, and `site/` is mirrored with `rsync --delete`, so
every other app's signed shell, manifest and packs — fetched by shipped files
at frozen URLs — were simply absent and would be deleted.

**A release now SEEDS `site/` from the published tree and overwrites only what
it built.** "Restore every untouched app byte-identically" becomes the default
rather than a step someone remembers. It composes with the publish-time
deletion gate: this fills the gap, that one refuses if a gap remains.

Verified in both directions against a copy of the live tree: a spaces release
leaves all 47 published files byte-identical and adds only `releases/spaces/`
and `spaces/` (`diff -r` reports nothing but "Only in"); a slides release with
spaces already published rebuilds slides and leaves spaces intact. Both report
`deletion gate: none would be removed`.

**Without a published tree, a release REFUSES** (`--allow-missing-published`
for a genuinely first release). Continuing would stage a partial site whose
publish deletes every other app; the gate would catch it, but failing here says
what to do about it.

**Site content has exactly one owner.** Landing, gallery, agent guide, skills,
`/help`, `/q`, 404 and the guestbook are slides-derived — the gallery and 404
decks literally embed the slides shell — so only a slides release rebuilds
them. A spaces release must not regenerate them from a shell it did not build.
`ownsSiteContent` says so, and the rig asserts exactly one app claims it.

**Packs stay slides-only.** `build-i18n.mjs` and `sign-packs.mjs` are
slides-hardcoded (§6.5) and spaces has no catalog, so a spaces release stages
NO packs rather than unsigned ones — `publish-site.mjs` refuses unsigned packs,
correctly.

`sign-release.mjs` gains `--app`; it hardcoded `bento-slides`. This is the
silent failure of the set: a shipped shell verifies the manifest's `app`
against its own `configureApp()` id (`kernel/src/update.ts`), so a wrong value
signs and publishes a channel every file quietly declines — nothing errors,
updates just stop.

The registry lives in `scripts/apps.mjs` with a rig, `test-release-apps.mjs`,
because a release signs and the key never reaches CI: the pipeline is not
CI-testable, but the registry drifting from the tree is. It pins `appId`
against each app's own `configureApp()` call and the manifest URL against the
path the release publishes to.

## 2026-08-03 — One bento/spaces file is one SPACE, and the reason is a save primitive

Spaces is a tree of pages in ONE `.bento.html`, with links as same-document
fragments (`#p/<pageId>`) resolved against a map built from the file's own
`#bento-doc` block. Not one file per page with a folder as the workspace —
the Obsidian shape — and not cross-file links.

Five shapes were developed and each adversarially attacked. This records why
the folder shape is **unbuildable on this platform**, rather than merely more
expensive, because that is the part nobody should have to rediscover.

**The write primitive does not exist.** Without the File System Access API —
Chrome and Edge only — a save is a *download*. The page lands in the browser's
download directory, outside the folder its relative links resolve against. So
on Safari, Firefox and every iOS browser, the FIRST save of any page ejects it
from its own workspace. No design gets around this; it is not a link problem.

**On iOS a relative link returns the wrong answer, not an error.**
`tray/ios/EditorViewController.swift` answers every request on a document's
origin with that document's own bytes, so `href="./other.bento.html"` does not
404 — it re-serves the space you are already in at a different URL. Silently
wrong is worse than broken. Filed as a tray-zone request: 404 anything but
`/index.html`.

**Fragment routing is legal exactly where path routing is illegal.** Measured
from an origin-null document: `history.pushState(s,'','#p/<id>')` succeeds,
while `history.pushState(s,'','other.bento.html')` throws `SecurityError`. The
grammar the one-file shape needs is the one the platform permits.

**The folder shape buys no free OS search here.** `mdimport` on a shipped shell
returns `kMDItemTextContent = "<<< Text content of 75 characters >>>"` —
document text lives inside a `<script>` block and Spotlight cannot see it. True
of slides today too. Cross-file discovery needs an index either way.

**Prose is not the scale ceiling.** 2,000 pages / 26,000 blocks is a 5.2 MB
file that parses in 3.4 ms. Images are the ceiling, which is a product-shaped
limit, not a format one.

What the file boundary also becomes, and this is the design rather than a side
effect: the id scope, the link scope, the sharing boundary, the `docId` scope
(hence autosave and version history), the undo scope, the encryption scope, and
the save scope — every save rewrites the whole file.

Accepted costs, unchanged: sharing is per-file so there is no per-page
permission, and two people editing offline get two files and no merge until the
CRDT is generic. The pressure valves are first-class — export a page as its own
space, export a space as a markdown folder, import either.

The library tier — many spaces, searched together — attaches at a named seam
and is `bento/vault`'s job, which is optional by its own invariants 2 and 3.
One space needs nothing installed, ever; a library is software you run, on a
laptop or a 24/7 box or a cluster, the same artifact either way.

## 2026-08-03 — tray/webext ships through the stores; unpacked stays available

Settled with the maintainer. The **app stores are the main distribution
channel** for `tray/webext` — Chrome Web Store, Edge Add-ons, and the others as
they come — with the unpacked folder in this repo remaining a supported option
for people who want it.

Two corrections to earlier reasoning in this thread, both of which had made the
extension look less viable than it is:

**Developer mode is not required.** It is needed only for "Load unpacked". A
store-installed extension needs no Developer mode, no unpacked folder and no
warning banner. An earlier note in this session treated that as an inherent
cost of the whole approach; it is a cost of one distribution method.

**Store distribution does not conflict with the signed-release model.**
`docs/RELEASING.md`'s "signed locally, the signed bytes are the served bytes"
governs the DOCUMENT SHELL and its self-update channel. The extension is not a
document, carries none, and never touches that path, so a store-distributed
extension and a locally-signed shell coexist. What a store actually costs is
review latency and a second release cadence — ordinary, not philosophical.

**What does survive a store listing** is `Allow access to file URLs`: a
per-extension user toggle, off by default, required for content scripts on
`file://`. No manifest permission grants it. It is, however, DETECTABLE via
`chrome.extension.isAllowedFileSchemeAccess()`, so the extension can turn silent
failure into a guided one-time setup step rather than a mystery. That API's MV3
behaviour is unverified — measure before building on it.

Consequences already implemented: `permissions` trimmed to `storage` (an unused
`offscreen` would draw review questions it cannot answer), and content scripts
narrowed from every `file:///*.html` to `file:///*.bento.html`, which is both
correct and far easier to justify to a reviewer.
## 2026-08-02 — No extension system: compact per-app runtimes instead

The recurring proposal is an extension mechanism — sealed, separately signed
units that bake into a file like language packs do, so a heavy optional feature
ships on its own clock instead of riding the shell release. The immediate case
was a PowerPoint exporter carrying a large vendored dependency. The wider case
was that a mechanism built once would serve `bento/spaces` and `bento/dash` too.

**Declined, for every app.** Bento ships small, self-contained runtimes per app.
A feature is either core or it is a separate artifact — not a plug-in tier in
between.

This CONFIRMS rather than supersedes *"The pack carrier is generic; pack POLICY
is not. This is not a plugin system."* (2026-07-26). That entry stands exactly
as written: the carrier stays generic and reusable, and the reason to keep it
that way is engineering hygiene, not a plugin system waiting to be finished.

**The multi-app argument is the strongest evidence against, not for.** Bytes do
not amortize across apps, they multiply: every app pays the host, the container
and the per-app i18n for the machinery. Measured against real builds, the
cheapest extension host costs more than the entire `bento/spaces` shell as it
stands (10,052 B). Only review effort and one browser matrix amortize, and that
was never the expensive half. Worse, neither unbuilt app wants it: their designs
contain no extension-shaped feature, one of them independently ruled out
shell-block work and forbids carried user code outright, and both solved their
heaviest import/export payloads with browser primitives (`CompressionStream`,
`DOMParser`) and no dependency at all. An abstraction with zero confirmed
consumers, designed against two apps that do not exist yet, is the textbook case
for not building it.

**The economics invert once you follow the bytes.** An extension bakes into the
FILE, so the user who exports pays the dependency *and* the machinery, while the
user who never exports still pays the host. For the exporter that is worse than
merging the dependency into core unchanged. The break-even against a first-party
in-shell writer needs fewer than ~13% of users to ever use the feature — and for
a PowerPoint replacement, PowerPoint interop is the adoption path, not a fringe.
The same money buys far more as core: a first-party writer prototype targeting
the same format came in roughly 35x smaller than the vendored library it would
replace, using the same `CompressionStream` technique.

**Three extension mechanisms already exist, and they are better.** The Claude
Code plugin/skill channel extends Bento by RECIPE (`plugins/bento-slides/`) at
zero shell bytes and on its own clock. The native host bridge
(`tray/ios/Resources/bridge.js`) extends capability at the host, and reaches
every file ever saved — including ones that predate it. The kernel facade
pattern (`slides/src/charts.ts`, six lines over `kernel/src/charts.ts`) shares
implementation by structural typing with no frozen surface at all. Each costs
zero platform invariants. Reach for these before inventing a fourth.

**What this does NOT decide.** Kernelizing the language-pack channel
(`packs.ts` parameterised per app) is still wanted — both future apps list it as
blocking, and it is unrelated to extensions. So are the defects found while
looking: the offline switch does not gate pack fetches although `docs/security.md`
says it does; the shell-block registry is single-slot, so a second registrant
clobbers the first; and a block that fails to parse is skipped on read and then
removed by the clear pass, which deletes it permanently on the next save. Fix
those on their own merits.

**What would reopen this.** A confirmed second consumer in a shipped app, a
feature that genuinely cannot be core (a licence that forbids bundling, or bytes
that dwarf the shell even after a first-party rewrite), or a demonstrated need
for third-party authorship. Absent those, the answer to "should this be an
extension?" is "should this be core, a separate artifact, or a skill?"
