# bento/dash — what is left before a first release

Status as of 2026-08-10, branch `worktree-bento-dash` (35 commits ahead of main,
no PR open). This is the working backlog, ordered by what it costs the person
using the file. It is not a wish list: everything here is either something that
loses or misstates data, something that blocks shipping at all, or something a
spreadsheet is simply expected to do.

Each item says what happens **today**, because a backlog whose entries describe
intentions rather than observations rots quietly.

---

## 0 · Blocks shipping at all

These are not features. Until they are done there is no such thing as a dash
release, only a build.

- ~~**dash has no release path.**~~ **Done.** `node scripts/release.mjs --app
  dash` builds, gates and signs; `publish-site.mjs` is app-aware and creates
  the `dash-vX.Y.Z` GitHub release with `Bento_Dash.bento.html` attached and
  notes from `dash/CHANGELOG.md`. It used to read slides' manifest for the
  version, which meant a dash publish looked up slides' tag, found the release
  already there and exited 0 having created nothing. `docs/RELEASING.md` now
  covers all three apps, and `scripts/test-release-channel.mjs` rehearses a
  whole release — signature, hash pin, app id, monotonicity, and every refusal
  — against `kernel/src/update.ts` itself with a throwaway key. CI runs it.
- ~~**The update manifest does not exist.**~~ **Done, at the point of
  release.** The manifest is not a site source: `release.mjs` signs it from the
  shell it just staged, so the pinned sha256 is always the bytes being served.
  A dash release writes `site/releases/dash/manifest.json` and it goes live
  with the publish. Until the first dash release is actually cut, that URL 404s
  — which the launch check treats as "could not check", not as an update.
- ~~**No launch-time update check.**~~ **Done.** `about.ts` exports
  `checkAtLaunch`, called once from `main.ts`. It badges the ⓘ button and the
  version chip (both open About) rather than interrupting, and About says what
  the launch check found. It is gated on `shouldCheckAtLaunch` — a saved
  workbook, the launch check not opted out, and Offline mode off. **A workbook
  nobody has saved never checks**: the shipped shell's `#bento-doc` is empty,
  so the demo at bento.page/dash and every fresh download boot the starter
  through that path, and a fresh document phoning home is the §5 failure the
  dormancy rule exists to prevent.
- ~~**No Offline toggle.**~~ **Done.** Both switches are in About now — "check
  automatically at launch" and "Offline mode". Offline HANGS UP an open relay
  socket rather than only refusing the next connection (`disconnectOnline`);
  turning it back off re-joins if the workbook is shared.
- ~~**`docs/DECISIONS.md` entries are owed.**~~ **Done** — the view vector as
  the single source, the chart pinned to its sheet, tabs at the bottom with
  reorder as a patch, and Find's displayed-vs-stored matching rule.

Version: `dash-v0.2.0` is ALREADY TAGGED at a commit from 2026-08-03, so this
work ships as **0.3.0** — bumped, with the changelog written. The notes go
inside the signed envelope and cannot be re-signed for a version, so they had
to be written before cutting, not after.

Still true, and worth knowing before cutting `dash-v0.3.0`:

- **No pack channel** (`packs: false` in the registry) — the seven core
  catalogs are compiled in and complete; extra languages would need the
  `save.ts`/`update.ts` pack hooks slides has. Deferring the catalog is fine;
  deferring the channel would not be.
- **The first release cannot exercise the update path.** There is nothing
  published to update FROM. Prove it on the second release, from a copy of the
  first.

## 1 · Loses or misstates data

- ~~**OFFLINE MODE DOES NOT FULLY HOLD**~~ — dash's share of the privately
  reported advisory GHSA-5c3x-xqp6-g94r. **Done**, by merging slides PR #305
  (`759fb93`) rather than by fixing anything here: the fix is one chokepoint,
  `kernel/src/net.ts`, with a CI rig that bans `fetch`/`WebSocket`/
  `XMLHttpRequest`/`sendBeacon`/`EventSource` outside it. dash was CONVERTED in
  that PR rather than exempted from the scan, which is the right scope — a ban
  list dash is exempt from is a ban list dash will violate. dash's whole
  exposure was ONE call, `new WebSocket` in `sync/online.ts`, now `netWebSocket`.

  Three of the six claims applied to dash and all three are closed by the
  chokepoint: nothing listened for `storage` (a second tab kept its relay socket
  after the first went offline), there was no `AbortController` anywhere, and
  the switch lied when storage was unavailable. Two did NOT apply, structurally:
  no media element (no remote `src`) and no pack channel (`packs: false`).

  Worth keeping, because it is the part a chokepoint could not have fixed. The
  old gate read `try { lsGet('bento-offline') === 'on' } catch { return false }`
  and **the catch was DEAD CODE**: `lsGet` (kernel/src/storage.ts) has its own
  try/catch returning `null`, so it never threw. It answered *online* because
  `null === 'on'` is false. A fix aimed at the catch would have done nothing,
  and `net.ts` would then have faithfully consulted a gate that was lying. #305
  replaced the gate's SOURCE OF TRUTH instead — `sessionOffline ?? lsGet(…)` —
  which is what actually closes it.

  dash's own half was the UI, and it was on this branch, so #305 did not fix it
  for us. Measured with every `localStorage` call throwing as Safari private
  browsing does: ticking Offline left the checkbox **TICKED** while the note
  directly beneath it read **"Network features are available"** — the checkbox
  showing its own DOM state, the write swallowed, the note re-reading the gate.
  `setOffline` now returns whether the preference PERSISTED and `about.ts` takes
  that return, so the dialog says the switch holds for this tab and will be
  forgotten on reload. Re-measured after, with a POSITIVE CONTROL because "no
  request" proves nothing on its own: switch off → one request to
  `bento.page/releases/dash/manifest.json`; switch on → none. Gate holds.


- ~~**No file write-back.**~~ **Done** (`92c34b6`) — writeback.ts rides the existing 2.5s debounce; a failed write is never recorded as a baseline, so a permanent failure cannot be reported once and then silently skipped.
- ~~**`Grid.setSheet` clears `filters`/`sorts` but not `store.order[id]`.**~~
  **Done**, as a side effect of the status line — a truthful description of the
  view made the phantom view impossible to leave in.
- ~~**A DROPPED workbook's read-only flag is not applied.**~~ **Done** (`1da3263`) — adoptOpenedDoc split into forkTemplate + applyDocLock, applied on opposite sides of the swap.
- **`releaseFileHandle()` is missing from the kernel.** Three dash call sites
  now cast `null as never` into `adoptFileHandle` to let go of a handle. The
  cast is the same one `dropopen.ts` already documents. It belongs in
  `kernel/src/save.ts`, and the kernel zone is serialised, so it is a separate
  change rather than a drive-by.
- ~~**`dashboard.ts:741` spreads one argument per row.**~~ **Done** — seriesExtent walks in one pass; the sweep found three more sites (MIN/MAX, MINIFS/MAXIFS, the xlsx totals row).
- ~~**THE GRID ENDS AT THE DATA.**~~ **Done** — one appender row, and the ruled lattice now stops at the data instead of impersonating empty cells. The unbounded answer is the spreadsheet kind.
- ~~**The totals row cannot be clicked.**~~ **Done.** The footer cell IS the
  control: click it for sum/avg/count/min/max/No total, written through the
  existing `totalsPatch` so there is still one path to `sheet.totals`. An empty
  cell under a numeric column shows a dim invite rather than sitting dead, and
  the menu flips above the cell because the footer is sticky at the window's
  bottom edge. Two display bugs surfaced by making it reachable: `count` was
  borrowing the column's money format (`count £8.00`), and a custom-formula
  total rendered as `[object Object]`.
- ~~**No print, no PDF.**~~ **Done** (`6dadf71`) — a real page builder over the view vector. Measured in a browser: 3,001 rows printed from a grid holding 46.
- ~~**No cell formatting on the DATASET kind.**~~ **Done** — one appearance vocabulary shared by both kinds, plus italic/underline/borders/wrap which neither had.
- ~~**Stale readouts.**~~ **Done.** `applyView()` — which every sort, filter,
  clear, sheet switch and structural edit funnels through — now announces, and
  the status text lives in `grid.ts` (`viewStatusText`) because the grid owns
  the view. The filter menu delegates to it instead of keeping a second copy
  that knew nothing about sorts. Says rows only when some are hidden, since
  "8 of 8 rows" was noise.

## 3 · Correctness debt with a known shape

- ~~**`exportCsv` exports the wrong sheet.**~~ **Done** — it takes the sheet on
  screen, and refuses with a reason on a spreadsheet rather than silently
  exporting a different sheet.

- ~~**Pivot and canvas sheets cannot be renamed.**~~ **Done** — the narrowing was in three places, including crdt.ts committable, where it would have shipped as "rename works, except on a shared workbook".
- ~~**A sheet reorder's undo entry stringifies the whole sheet.**~~ **Done** — a dedicated reorderSheets op: 132,813 bytes per drag at 20k rows became 44.
- ~~**About's version restore is not undoable.**~~ **Done** — both paths call offerUndoRestore; Replace-from-JSON keeps its confirm, because a paste has no earlier state worth naming back.
- ~~**The grid is invisible to assistive technology.**~~ **Done** — role/aria throughout, indices describing the FULL view rather than the ~46-row window, and focus that lands on the cell instead of BODY.
- `panels.css` carries ~90 dead rules (`.dp-left`, `.dp-sheet*`, `.dp-add`, the
  phone-drawer rules) left by the sheet list moving to the tab strip.
- No i18n language **packs** — the seven catalogs are bundled core only. slides
  has the pack mechanism (`docs/i18n-packs.md`); dash would need the `save.ts` /
  `update.ts` hooks.
- The starter workbook is still a sales pipeline with eight rows. It should show
  what dash does that a spreadsheet does not.

---

## Done this week, for the record

Footer totals now follow the filter · chart agrees with the table and is pinned
to its own sheet · Find (the grid is virtualised, so the browser's own find
reports absent values as missing) · sheet tabs along the bottom, reorder as an
undoable patch · `window.prompt` gone from all four call sites · every ⌘S
outcome reported, including the download-instead-of-save case · Redo button ·
eight UI languages with numbers that follow the reader's locale · boot 952ms →
93ms with a no-JS backstop for a truncated download · read-only workbooks that
actually refuse writes · validator, comment threads, crash recovery, drag-and-
drop open · 29 rigs in CI, up from 2 a fortnight ago.
