# Language packs — design

*Design document, July 2026. Companion to `PLATFORM.md` §6 (signed
self-update) and §8 (i18n). The bundled core, the pack format and the in-app
"Add language…" flow are **built**; release-side publishing and client-side
signature verification are landing on their own branches — see
[Status](#status), which says per item what is shipped and what is not.*

## The problem

Translations are the largest single thing in the shell — larger than any
dependency. Measured on v1.0.10, after the key-once packing landed:

| | stored in shell |
|---|---|
| all 7 non-English catalogs | **115,572 B** |
| Moveable stack (croact-moveable + ~12 satellites) | ~240 KB minified |
| Reveal.js | ~109 KB minified |

An English-only shell is **426,358 B against 598,457 B — 28.8% smaller.**

So every language we bundle is paid for by every user, in every saved file,
forever — including the ~99% of readers who will never switch to it. But the
languages we *don't* bundle are simply unavailable, and the format's whole
premise is that a file works offline with no server. That tension is what
packs resolve.

### Cost per language (measured, not estimated)

Marginal cost of each catalog, deflated then base64'd as the shell stores
payloads:

| language | chars | bytes/char | stored |
|---|---|---|---|
| zh-Hant | 8,436 | 2.60 | 11.4 KB |
| zh-Hans | 8,432 | 2.60 | 11.6 KB |
| Italian | 25,810 | 1.03 | 13.8 KB |
| Spanish | 26,142 | 1.03 | 14.3 KB |
| French | 27,004 | 1.05 | 15.3 KB |
| German | 25,954 | 1.04 | 16.4 KB |
| Japanese | 12,090 | 2.71 | 16.7 KB |

Counter-intuitively **CJK is the cheapest**: 2.6× the bytes per character, but
a third of the characters. The practical rule is that cost is flat —
**~14 KB per language regardless of script** — so budget per language and
don't agonise over which.

Two consequences worth recording, because both look like free wins and aren't:

- **Simplified↔Traditional conversion on the fly does not pay.** Only **43.3%**
  of characters are identical between the two catalogs, because the difference
  is largely *vocabulary*, not glyph form (软件/軟體, 鼠标/滑鼠, 网络/網路,
  打印/列印). Conversion is also not a bijection (发 → 發 or 髮; 干 → 乾/幹/干),
  so it needs word segmentation — which is why OpenCC's dictionaries run to
  hundreds of KB. Meanwhile deflate **already** recovers 2.2 KB of the genuine
  redundancy for free, because key-once packing puts each string's two variants
  adjacent, inside the 32 KB window. A conversion table would cost ~8–12 KB to
  replace an 11.4 KB catalog and produce text that reads as machine-converted
  to precisely the audience most sensitive to it.
- **Speaker counts are the wrong ranking metric.** What matters is the
  *English-proficiency gap in the segment that uses this tool* — professionals,
  students, educators. Bento's users in India, the Netherlands or Scandinavia
  are largely served by English already and often prefer an English UI, since
  the technical vocabulary is English. Brazil, Russia and Indonesia are the
  opposite. Hindi's 610M headline overstates its value here more than any other
  language's; it is also not politically neutral within India, where English is
  often the preferred link language in the south.

## The decision

**A bundled core, plus downloadable packs for everything else.**

- **Bundled (9):** English, Japanese, Simplified Chinese, Traditional Chinese,
  Spanish, French, German, Italian, **Portuguese**. The existing eight stay so
  that nothing regresses for current users; Portuguese is added because Brazil
  has a genuine English-proficiency gap and it is in the cheapest cost tier.
- **Packs (everything else):** signed, released centrally alongside each app
  release, fetched on demand and spliced into the file.

The bundled core is what makes this safe. It preserves the property in
`kernel/src/i18n.ts` — *"a deck authored in Tokyo opens with French chrome in
Paris"* — for the languages most likely to be encountered, and it keeps
bento.page's live demo working in those languages on first contact. Packs are
purely additive: a file that has never fetched one behaves exactly as today.

**No new languages get bundled by default.** Demand declares itself through
contributions (issue #17 is a volunteer offering Korean); a pack can ship and
be revised without cutting an app release.

## Design

### Pack format

A pack is one language for one app at one app version:

```
bento-slides-1.0.11-ko.pack.json
{ "app": "slides", "version": "1.0.11", "lang": "ko",
  "label": "한국어", "strings": { "<english key>": "<translation>", … } }
```

Per-language maps, not the bundled positional-array shape: a pack is edited
and reviewed as one language, and positional arrays would couple every pack to
a column order.

### Signing and release — the signed pack index

Packs reuse the existing release machinery **exactly** — ECDSA P-256 /
SHA-256, verified against the `PUBLIC_KEY_JWK` already embedded in every shell
(`PLATFORM.md` §6). The private key stays offline and `release.mjs` runs
locally. No new trust root, no second key.

**The INDEX is signed; individual packs are not.** `release.mjs` emits the
packs and then signs one index over all of them:

```
https://bento.page/releases/slides/
  manifest.json                          signed — the app shell
  packs.json                             signed — the pack index
  packs/bento-slides-1.0.11-ko.pack.json  the packs themselves
```

`packs.json` is the same envelope as the manifest, produced by the same code
(`scripts/sign-payload.mjs`, shared by `sign-release.mjs` and `sign-packs.mjs`):

```json
{ "payload": "<the exact json string that was signed>", "sig": "<base64>" }
```

and the payload is

```json
{ "app": "bento-slides", "version": "1.0.11", "at": "<iso>",
  "packs": [ { "lang": "ko", "label": "한국어", "version": "1.0.11",
               "url": "packs/bento-slides-1.0.11-ko.pack.json",
               "sha256": "<hex, lowercase>", "bytes": 60114 } ] }
```

`sig` is ECDSA P-256 / SHA-256 over `payload`'s **UTF-8 string bytes**, IEEE
P1363 (raw r‖s), base64 — byte-identical in construction to the manifest, so
the client verifies both with the same handful of lines.

The client's job is therefore the same two-step the shell already performs for
its own update: **verify the index signature once, then hash each downloaded
pack against its signed `sha256`.** A pack that does not match its pinned hash
is refused. `url` is relative to the channel unless absolute — so a dev
channel (`localStorage 'bento-packs-url'`) serves its own packs rather than
silently reaching back to bento.page.

Two reasons this is a separate artifact from `manifest.json` rather than a
`packs` array inside it:

- **Packs publish on their own clock.** A corrected translation is not a new
  app version — but shipped files ignore a manifest that is not strictly
  *newer* than themselves (downgrade-replay protection), so a hash carried in
  the manifest could never be corrected *between* releases. A separate index is
  re-issuable any day.
- **The manifest keeps meaning one thing:** here is the app shell. The update
  channel ships signed *code*; the pack channel ships signed *data*.

`publish-site.mjs` gates on this before pushing: every indexed pack must exist
and match its signed hash, no published pack may be missing from the index, and
staged packs without an index refuse to publish at all. Signed bytes are served
bytes — for the index exactly as for the shell.

### Verification: what is checked, and what deliberately is not

> **Landing separately.** The design below is settled; the client-side
> implementation is on branch `claude/i18n-pack-verify`. Until that merges,
> `fetchPack` validates *shape* only (`lang`, `strings`, matching `app`) — do
> not read this section as describing shipped behaviour.

Two rules, and the asymmetry between them is the point.

- **A pack fetched from the network is verified.** The pack *index* is signed
  with the release key; each entry pins its pack by sha256. So a client
  verifies the index signature once, then checks the bytes it downloaded
  against the signed hash — the same two-step the shell itself goes through on
  self-update. You cannot substitute a pack without breaking its hash, and you
  cannot fix the hash without breaking the signature. A pack that fails is
  refused, not degraded: a *wrong* pack is worse than no pack, and there is a
  working English fallback right there.
- **A pack already embedded in a file is NOT re-verified.** It carries exactly
  the same trust as the document it travels with: someone who can rewrite a
  block in your `.bento.html` can rewrite the document, the CRDT state and the
  collab keys in the same file, so re-checking one block buys nothing.
  Re-verification would also mean a *network round trip to open a deck*, which
  breaks the property the whole format exists for — a file that works offline,
  forever, from `file://`. The blast radius is bounded in a way that makes
  this an easy trade: a pack is DATA, and its worst case is wrong words on
  screen.

That bound is load-bearing and does not transfer. See `docs/DECISIONS.md` —
the carrier is generic, the policy is not, and nothing carrying **code** may
inherit these rules.

### Loading

`registerI18n` already accepts a packed table (kernel). Pack loading adds a
merge step: a pack's strings layer over the bundled core for its language.
Lookup misses fall back per string to the English key, which is what makes a
partial or stale pack degrade gracefully rather than break.

### What the client checks (implemented)

```
embedded release key  ->  signs the index
index                 ->  pins each pack's sha256
pinned sha256         ->  the bytes we accept
```

You cannot substitute a pack without breaking its hash, and you cannot fix the
hash without breaking the signature. Two kernel helpers do it, and nothing
else in the codebase does release-channel crypto:

- `verifySigned(raw, what?)` — envelope + signature, returns the payload.
- `fetchPinned(url, sha256)` — fetch, hash, compare; `null` on any mismatch.

They verify BYTES. They do not decide what is safe to use — that policy is the
caller's, and packs are DATA (see the decision log entry, 2026-07-26). Anything
side-loaded that ever carries CODE needs stricter policy — pinned at install,
never auto-refreshed — and must not inherit the pack rules by reusing this
fetch.

`slides/src/packs.ts` composes them and **fails closed**. It expects the index
payload specified above: an object whose `app` is this app's id (the signing
key is platform-wide, so the id is what stops a validly signed index for
another app) carrying a `packs` array. An unsigned index, an index for another
app, a listing with no pin, or bytes that don't match all yield nothing to add
and a `'unverified'` error in the UI. There is no permissive fallback for an
unsigned index — nothing is published yet, so there is nothing to be
compatible with, and a fallback shipped now would be permanent.

Two things deliberately NOT checked:

- **Packs already inside a file** (`readPacksFromShell`). Verified at the
  door; once spliced, a pack carries the trust the document does, and
  re-verifying would require the network at boot — the opposite of the
  product's promise.
- **A refresh that fails.** `refreshPacksForVersion` keeps the pack the file
  already holds rather than dropping it. The unverified bytes are refused; the
  previously verified ones stay. Degraded beats absent.

Rig: `node scripts/test-packs.ts` (in CI) — tampered pack, tampered index,
unsigned index, index signed for another app, missing pin, and the good path,
against real WebCrypto with a throwaway key standing in for the release key.

### Incorporation into the file

A pack is fetched **only on explicit user action** ("Add language…"), verified,
then written into the shell as an additional plaintext data block. Nothing
phones home by default; a file that never adds a language never talks to the
network. Once written, the pack travels with the file and works offline
forever, like everything else.

Mechanically the block is a `<script type="application/bento+lang"
id="bento-lang-<lang>">` in `<head>`, holding the pack JSON with `<` escaped as
`\u003c` — exactly the treatment `#bento-doc` gets. The kernel side is
deliberately ignorant: `registerShellBlocks` / `readShellBlocks`
(`kernel/src/save.ts`) carry *typed blocks*, and know nothing about languages.
The app registers `shellBlocksForPacks()` once, at boot — together with the
block types it owns — and every serialize re-declares the whole set.

## Where a pack lives

### A pack lives in the FILE and nowhere else

This was decided the hard way: a second home — "install for this browser",
backed by `localStorage` — was **built and then removed**. The reasoning must
survive, because the idea looks obviously good and will otherwise be proposed
again.

`localStorage` is scoped per **origin**. Bento's actual journey crosses
origins: the download comes from `bento.page` (an `https` origin), and the
file is then opened from disk (a `file://` origin, where every file is
effectively its own storage bucket anyway). So a language added on the website
was **gone** the moment the user saved the deck and reopened it locally — the
exact journey the product encourages. "I added Korean and it vanished" is not
something a user can diagnose, and no wording fixes it.

It also matches everything else here: the file *is* the software, so a
language belongs to the deck. The trade is that adding a language requires
saving the file, which the UI states plainly instead of hiding.

Corollary for future work: anything that "remembers" a pack outside the file
reintroduces this bug. Viewer *preferences* (chosen locale, reduce-motion) are
browser-local on purpose; pack *content* never is.

### Adding is staged on click, written on the next save

Clicking Add registers the pack immediately — the editor switches language
right away — and marks it pending. The row says **"Added when you next save"**,
and the file gains it on the next save (`markFileSaved()` clears the pending
flags once the bytes are out).

It is staged rather than written-on-click because on every browser without the
File System Access API, "write" means **silently downloading a second copy of
the user's deck**. Handing someone an unexpected `deck (1).bento.html` because
they asked for Korean is a worse surprise than asking them to save.

Removal is symmetric and needs no deletion path: `serializeBody` drops every
block of a managed type and rewrites the current set, so "remove from this
file" is just *stop listing it*. The managed types are the ones the provider
DECLARED at registration, not the ones it is about to write — so an empty set
still clears, which is exactly what removing the file's last pack looks like.

### Staying current

Two mechanisms, because a pack is frozen at the version it was built for while
the app around it keeps gaining strings — so a translated deck otherwise
drifts back toward English one release at a time, silently, per string.

- **Update refreshes packs.** `registerUpdatePrepare` (`kernel/src/update.ts`)
  gives the app a moment after a release is verified and before the document
  is serialized into the new shell; slides uses it to run
  `refreshPacksForVersion(version)`, re-fetching each carried language at the
  incoming version. It is **best effort and never fatal**: any pack that
  cannot be re-fetched — offline, not published yet, anything — is kept as it
  is. Degraded beats absent; losing a language the author baked in is far
  worse than one that is a release out of date.
- **The Languages dialog says when a pack is stale.** `packCoverage(pack)`
  counts how many of the *running app's* strings the pack does not cover
  (`PACKED`'s keys are exactly the strings the app asks for), and the row
  reads "Built for v1.0.11 — 23 phrases still show in English. Updating Bento
  refreshes it." Measured, not inferred from the version number: a pack built
  against an older release may still cover everything, and a same-version pack
  can be incomplete. Naming the number turns "why is some of this English?"
  into a fact, and saying it fixes itself stops anyone hunting for a button.

## Risks

**Self-update must carry packs forward — this is the one that will ship broken
if it isn't designed in.** `update.ts` fetches a *new shell* and re-splices the
current *document* into it. Packs live in the shell, not the document, so the
naive path hands a Korean user back an English file after an update, silently
and with no error to describe. Pack migration is part of the update path, not
a follow-up. *Handled:* the registered block provider is consulted on every
serialize, including the update one, so packs ride across by construction —
and `registerUpdatePrepare` refreshes them to the incoming version first (see
[Staying current](#staying-current)).

**Pack/app version coupling.** Every release adds strings. A 1.0.10 pack in a
1.1.0 shell must degrade per string to English, never fail to load. The
manifest is versioned per pack; the policy for "pack older than app" is
load-and-degrade.

**Splice contract.** Packs are additional plaintext blocks beside `#bento-doc`,
and a pack body is arbitrary translated text — it can contain `<`, quotes, and
the literal sequence that closes a script tag. Unescaped, a single pack string
could terminate its own block, or forge a second `#bento-doc` opening tag that
an old updater (which splices into the FIRST regex match) would write into
instead of the real one. Both would brick files already in the wild.

*Handled:* `serializeBody` applies the same `<`→`\u003c` escape to registered
blocks as to the document, and `scripts/shell-gate.mjs` now proves it. Because
a fresh build carries no packs, the gate synthesises an adversarial one — a
script-close sequence, a forged `#bento-doc` opening tag, an HTML comment
opener, CJK/RTL/emoji, U+2028/U+2029 — inserts it both above and below the doc
block, and re-runs the whole contract plus a lossless JSON round-trip and a
v0.1.0-style text splice. A negative control (the same pack written unescaped)
must fail, so the check cannot quietly become vacuous, and one source
assertion keeps `kernel/src/save.ts` applying the escape on both write paths.
The gate covers the splice contract only; it says nothing about whether a
pack's *contents* are right.

**RTL is not a pack.** Arabic, Urdu, Persian and Hebrew are among the largest
gaps by population, but they need bidi and mirroring work in the CSS. Ranking
them by catalog bytes flatters them badly. Treat RTL as its own project; a pack
alone will not make the UI usable. *Handled:* content bidi and chrome
mirroring shipped first (#92, #99, #101) and `RTL_LANGS` in `slides/src/i18n.ts`
matches on the BASE language, so all four arrived as ordinary packs and got
mirrored chrome with no code change. Sequencing it that way is the reason —
see `docs/DECISIONS.md`, *"RTL is two separable problems"*. What a pack still
cannot fix by itself is directional glyphs inside the strings: Hebrew shipped
with four `→` arrows pointing the wrong way and needed #111.

**Translation quality is the real constraint, not size.** The catalogs are
machine-drafted with "native review welcome" in their headers. Packs improve
this: a pack can be corrected and re-released without an app release, which
turns native review into a continuous process instead of a release blocker.

## Open questions

- Does bento.page's download page pre-splice the visitor's likely locale
  (client-side, since Pages is static)? Optional given the bundled core, but it
  would help first contact for pack-only languages.
- Do packs cover kernel strings shared across apps, or is each app's pack
  self-contained? Slides, Spaces and Dash have overlapping but distinct string
  sets.
- Should a saved deck record which packs it carries, for the People/About UI?
  (Partly answered: the Languages dialog reads them straight out of the shell,
  so nothing needs recording in the *document*.)
- Should a spliced pack be compressed? It is written as plaintext JSON today,
  which is simple and keeps the splice contract trivially checkable; the shell
  already has deflate+base64 payload blocks that would roughly halve it, at
  the cost of a second block shape for the gate to reason about.

## Splicing a pack into a file — compress it

Measured on the Korean pack: **56.8 KB raw JSON, 26.4 KB** through the
deflate+base64 pipeline the shell already uses for its runtime payloads.

Leave the artifact on the CDN **uncompressed** — GitHub Pages gzips it in
transit anyway (17–20 KB on the wire), and a readable `.json` is worth keeping
for translators. But the splice step MUST compress, because a spliced pack
lives in every saved copy of that file forever: **30 KB per file, per
language, permanently**, and unfixable once files are in the wild. Reuse
`postbuild-compress.mjs`'s existing block format rather than inventing a
second one.

## Status

Answered: **is this shipped?** Anything marked *branch* is written and green
but not yet on `main` — do not describe it as shipped.

- [x] Key-once packing of the bundled catalogs — #75. The prerequisite: it
      shrank the core, and its kernel change (`registerI18n` accepting a packed
      table) is the loading path packs reuse.
- [x] Portuguese catalog, bundled — #79
- [x] Pack format + `build-i18n.mjs --packs` emission, Korean first — #81
- [x] Kernel loading path: `addPack`/`removePack`, per-string fallback — #81
- [x] `release.mjs` emits packs at release time — #91
- [x] **Signed pack index** (`packs.json`) published to the channel, pinning
      each pack's sha256 — same envelope, same offline key, no second trust
      root; gated at publish time — #93
- [x] In-app "Add language…" / "Remove", staged and written on the next save
      — #86
- [x] Update carries packs forward (`refreshPacksForVersion`) — #86
- [x] Per-pack staleness note from `packCoverage` — #86
- [x] Client verifies the index signature and each pack's pinned hash, fails
      closed; proof rig `scripts/test-packs.ts` — #94
- [x] `shell-gate.mjs` covers a pack-carrying shell, including an adversarial
      block both below AND above `#bento-doc`; mutation-tested — #95
- [x] Removing a file's LAST pack now actually sticks — #96
- [x] Hebrew (he) — the first RTL language — #100, completed and its four
      directional arrows flipped for RTL in #111
- [x] **22 packs — 21 on `main`, `tk` on *branch* `turkmen-lang-translation`**
      — #102–#120 added nineteen in one batch (`id` and `ms` share #109),
      joining `he` and the original `ko`; Turkmen followed. With the 9 bundled
      catalogs that is 31 languages:

      ar bn da fa fi he hi id ko ms nb nl pl ru sv th tk tl tr uk ur vi

      Four are RTL (ar, fa, he, ur) and every one of them is a pack — the
      chrome-direction work landed before any of them, so each got mirrored
      chrome with no code change, which was the point of doing it that way.
      Turkmen needed no code either, for the mirror-image reason: Latin-script
      and LTR, so `RTL_LANGS` is untouched and base-language matching already
      resolves `tk-TM` → `tk`. It is also the first pack with a named
      translator: Mekan Soltanov (github.com/msoltanov).

      The 21 were complete at 693/693 when they landed. The source has grown
      since, so today they sit at 703/706, and `tk` — written against the
      current source — is the only one at **706/706**. See the open item below.
- [x] Korean completed — 662 → 693 in #129. It was first (#81) and therefore
      predated the Languages dialog, so 22 of its 32 gaps were that dialog
      entire: a Korean user opening "Manage languages…" read it in English.
      Worth remembering for the next pack that lands before a feature does.
- [x] Duplicated catalog keys disambiguated before publication — #121. `Loop`
      meant both the animation loop and media playback; `solid` meant both a
      fill and a line style; every language had to be wrong in one of the two
      places. Source strings went 684 → 693 and every pack was topped up in
      step (#122). Cheap now, a coordinated break across 21 languages once
      packs are published — see `docs/DECISIONS.md`, *"One English word, two
      meanings = two keys"*.
- [ ] A pack index live on the channel in the wild — needs an actual release
      cut, so "Available to add" stays empty until then.
- [ ] **Top the 21 older packs up, 703 → 706.** `Slide number`, `Progress bar`
      and `Corner arrows` — the deck-wide presenting toggles — were added after
      the #122 top-up, so every pack except `tk` shows those three in English.
      Exactly the drift `packCoverage` exists to report, and the reason a pack
      degrades per string rather than failing to load.
- [ ] **Native-speaker review of any pack but `tk`.** The other 21 are
      machine-drafted and unreviewed; each file says so in its own header.
      `tk` names a translator who owns its wording instead. Merging a
      pack has never been a claim about its wording, and a pack can be
      corrected and re-released without cutting an app release, so review is
      continuous rather than a release blocker. #17 is a standing volunteer
      offer for Korean.
