# Hosted Broadcast Client — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A broadcast copy that can be hosted once on a server and re-pointed at any presenter's room via `?room=&tok=` URL params, with live slide-content sync from the deck's collab room.

**Architecture:** The hosted copy is a broadcast copy (deck snapshot + `broadcast:{room,tok,relay}`) that ALSO carries the collab read cap (`collab.role:'reader'` + symmetric `key` + sync state) — the exact mechanism of the existing "read-only live viewer" export (v0.9.18). It boots into `broadcastMode` (present-follow overlay) and in the background runs a reader SyncSession joining the deck's collab room, re-rendering the current slide on remote doc changes. The presenter's deck mints `<hostUrl>?room=<roomName>&tok=<tok>` links; the hosted copy parses those params to override its embedded broadcast creds.

**Tech Stack:** TypeScript, Vite, vanilla DOM, existing Reveal.js present overlay, existing bento-sync collab machinery. No relay/worker changes.

## Global Constraints

- No changes to `server/sync-worker/` (relay) or `src/sync/crdt.ts`.
- `doc.meta` is additive and backward-compatible — old files lack `hostClient` and everything degrades.
- New UI strings must be added to ALL catalogs: `src/i18n/de.ts, es.ts, fr.ts, it.ts, ja.ts, pt.ts, zh-Hans.ts, zh-Hant.ts` + English fallback (the `t()` key itself).
- Conventional commits only, no AI attribution.
- Build check: `cd slides && npm run build:single` (tsc type-checks the whole app).
- The broadcast copy must NEVER carry `writerPriv`/`ownerPriv`/`invite` (read cap only).

---

### Task 1: `doc.meta.hostClient` field

**Files:**
- Modify: `slides/src/model.ts:368-374` (the `meta?` type)

**Interfaces:**
- Produces: `BentoDoc['meta']['hostClient']?: string` — the hosting URL of the broadcast copy, set at export, inherited by every collaborator's copy of the deck.

- [ ] **Step 1: Add the field**

```ts
  meta?: {
    author?: string
    company?: string
    subject?: string
    event?: string
    keywords?: string
    /** Hosting URL of this deck's broadcast copy — lets any collaborator mint
     *  hosted broadcast links (docs/hosted-broadcast-design.md). */
    hostClient?: string
  }
```

- [ ] **Step 2: Build to verify**

Run: `cd slides && npm run build:single`
Expected: build succeeds (type-only change).

- [ ] **Step 3: Commit**

```bash
git add slides/src/model.ts
git commit -m "feat: doc.meta.hostClient — hosted broadcast copy URL"
```

---

### Task 2: `hostedLink()` helper in online.ts

**Files:**
- Modify: `slides/src/sync/online.ts` (after `broadcastLink`, line ~861)

**Interfaces:**
- Consumes: `BroadcastCreds` (already defined in this file: `{ room, roomName, tok, relay, signerPub, signerPriv, isOwner }`), `viewerUrl` (line 854).
- Produces: `export function hostedLink(creds: BroadcastCreds, hostClient: string): string` — `<hostUrl>?room=<roomName>&tok=<tok>`.

- [ ] **Step 1: Add the helper**

```ts
/** Full URL of a hosted broadcast client pointed at these credentials. The
 *  hosted copy lives at `hostClient`; the query params select the room. */
export function hostedLink(creds: BroadcastCreds, hostClient: string): string {
  return `${hostClient.replace(/\/+$/, '')}?room=${creds.roomName}&tok=${creds.tok}`
}
```

- [ ] **Step 2: Build to verify**

Run: `cd slides && npm run build:single`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add slides/src/sync/online.ts
git commit -m "feat: hostedLink() — mint hosted broadcast client URLs"
```

---

### Task 3: Export flow — Hosting URL prompt + reader-creds hosted copy

**Files:**
- Modify: `slides/src/editor/editor.ts:816-828` (`saveBroadcastCopy`)

**Interfaces:**
- Consumes: `resolveBroadcastCreds` (online.ts:892), `hostedLink` (Task 2), `serializeAuto` (save.ts, already imported in editor.ts), `newDocId` (already imported).
- Produces: a hosted copy whose `collab` is `{ ...c, role:'reader', on:true, sync:undefined, broadcast:{room,tok,relay} }` with `writerPriv`/`ownerPriv`/`invite` deleted — boots in `broadcastMode` (main.ts checks `doc.collab?.broadcast` first) and live-syncs content via `joinFromDoc` (Task 5).

- [ ] **Step 1: Rewrite `saveBroadcastCopy`**

```ts
  /** A live broadcast hand-out: opens straight into the show and follows the
   *  presenter's slide changes in real time. When a hosting URL is set
   *  (doc.meta.hostClient) the copy ALSO carries the collab read cap — it
   *  live-syncs slide content from the deck's collab room, so a copy hosted
   *  once stays current as the deck is edited (docs/hosted-broadcast-design.md). */
  private async saveBroadcastCopy() {
    const creds = await resolveBroadcastCreds(this.store.doc, this.store.doc.docId)
    const host = window.prompt(t('Hosting URL (optional)'), this.store.doc.meta?.hostClient ?? '')
    if (host !== null) {
      const h = host.trim()
      if (h) this.store.doc.meta = { ...(this.store.doc.meta ?? {}), hostClient: h }
      else if (this.store.doc.meta) delete this.store.doc.meta.hostClient
    }
    const clone = JSON.parse(JSON.stringify(this.store.doc)) as import('../model').BentoDoc
    clone.docId = newDocId()
    delete clone.readonly
    const c = this.store.doc.collab
    clone.collab = {
      ...(c ?? {}),
      role: 'reader',
      on: true,
      sync: undefined,
      broadcast: { room: creds.roomName, tok: creds.tok, relay: creds.relay },
    }
    delete clone.collab.writerPriv // the muzzle — no write capability travels
    delete clone.collab.ownerPriv // v2: neither the owner key…
    delete clone.collab.invite //    …nor any invite (delegation) material
    try {
      const ok = await writeUpdatedFileAs(await serializeAuto(clone), clone, { suffix: 'broadcast', keepHandle: false })
      if (ok) this.toast(t('Broadcast copy saved — viewers open it and their slides follow yours'))
    } catch {
      this.toast(t('Saving failed'))
    }
  }
```

Note: `serializeAuto` (not `serializeFile`) so the copy carries sync state and rejoins the collab room as a true fork. A deck with no live session (`c` undefined) degrades to snapshot broadcast — `role:'reader'` with no room/key never connects.

- [ ] **Step 2: Build to verify**

Run: `cd slides && npm run build:single`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add slides/src/editor/editor.ts
git commit -m "feat: hosted broadcast export — reader creds + hosting URL prompt"
```

---

### Task 4: Speaker popup — "Hosted link" row

**Files:**
- Modify: `slides/src/present.ts` — `postBroadcastLink` (line 745), `toggleBroadcast` (line 769, the `postBroadcastLink(broadcastLink(creds))` call at line 813), the popup markup (lines 919-924), the popup script (lines 946-970), and the popup styles (lines 935-942).

**Interfaces:**
- Consumes: `hostedLink` (Task 2), `doc.meta?.hostClient` (Task 1).
- Produces: `postBroadcastLink(link: string | null, hosted?: string | null)` — the popup message now carries `{ bento:'broadcast', link, hosted }`; the popup shows a second row when `hosted` is present.

- [ ] **Step 1: Extend `postBroadcastLink` and the arm call**

```ts
  const postBroadcastLink = (link: string | null, hosted?: string | null) => {
    if (!speaker || speaker.closed) return
    try { speaker.postMessage({ bento: 'broadcast', link, hosted }, '*') } catch { /* gone */ }
  }
```

In `toggleBroadcast`, replace line 813:

```ts
      postBroadcastLink(broadcastLink(creds), doc.meta?.hostClient ? hostedLink(creds, doc.meta.hostClient) : null)
```

- [ ] **Step 2: Add the hosted row to the popup markup** (after the `.sv-bcast-link` div, line 924)

```ts
      `<div class="sv-bcast-link sv-bcast-hosted" hidden>` +
        `<span class="sv-bcast-label">${t('Hosted link')}</span>` +
        `<input type="text" class="sv-bcast-input" readonly>` +
        `<button class="sv-bcast-copy">${t('Copy')}</button>` +
        `<span class="sv-bcast-copied" hidden>${t('Copied')}</span>` +
      `</div>` +
```

- [ ] **Step 3: Extend the popup script** (inside the existing `bcastScript` IIFE, after the `linkBox` block)

```ts
  const hostedBox = document.querySelector('.sv-bcast-hosted')
  const hostedInput = hostedBox ? hostedBox.querySelector('.sv-bcast-input') : null
  const hostedCopy = hostedBox ? hostedBox.querySelector('.sv-bcast-copy') : null
  const hostedCopied = hostedBox ? hostedBox.querySelector('.sv-bcast-copied') : null
  if (hostedBox && hostedInput && hostedCopy) {
    if (data.hosted) {
      hostedBox.hidden = false
      hostedInput.value = data.hosted
      if (hostedCopied) hostedCopied.hidden = true
    } else {
      hostedBox.hidden = true
      hostedInput.value = ''
    }
    hostedCopy.addEventListener('click', () => {
      navigator.clipboard.writeText(hostedInput.value).then(() => {
        if (hostedCopied) hostedCopied.hidden = false
        setTimeout(() => { if (hostedCopied) hostedCopied.hidden = true }, 1200)
      })
    })
  }
```

Note: the existing `if (data.link) {…} else {…}` block must stay FIRST and unchanged — the hosted block reads `data.hosted` from the same message.

- [ ] **Step 4: Build to verify**

Run: `cd slides && npm run build:single`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add slides/src/present.ts
git commit -m "feat: speaker view hosted-link row"
```

---

### Task 5: `broadcastMode` — `?room=&tok=` parsing + live reader replica

**Files:**
- Modify: `slides/src/main.ts` — `broadcastMode` (lines 114-242), imports (line 26).

**Interfaces:**
- Consumes: `Store` (already imported, line 22), `SyncSession` (line 25), `joinFromDoc` (online.ts:967 — ADD to the import at line 26), `renderSlide` (already imported), `applyRevealSet` (present.ts export — verify it is exported; it is used inside present.ts, check the export list), `deck.sync()` (Reveal API).
- Produces: `broadcastMode` handles `?room=<name>&tok=<tok>` (hosted-client flow) after the existing `?b=` override; when the doc carries reader collab creds it runs a background reader replica and re-renders the current slide on remote doc changes, rebuilding the section list when the slide count changes.

- [ ] **Step 1: Add `joinFromDoc` to the online import** (line 26)

```ts
import { onlineTransport, startSharing, stopSharing, BroadcastSocket, syncHost, joinFromDoc } from './sync/online'
```

- [ ] **Step 2: Add `?room=&tok=` parsing** — after the `?b=` block (line 137) and after `relay` is computed (line 138), before `const roomUrl`:

```ts
  // ?room=<name>&tok=<tok> re-points this copy at another broadcaster's room on
  // the SAME relay — the hosted-client flow: any presenter's deck mints this
  // link (hostedLink), the client opens it, same copy, new driver. ?b= (full
  // viewer URL, own relay) takes precedence when both are present.
  if (b < 0) {
    const q = new URLSearchParams(location.search)
    const r = q.get('room')
    const t = q.get('tok')
    if (r && t) creds = { room: `${relay}/d/${r}`, tok: t, relay }
  }
```

- [ ] **Step 3: Extract section building** — replace the `doc.slides.forEach(...)` block (lines 53-69) with a `buildSection` helper used by both init and the live-rebuild path:

```ts
  const buildSection = (slide: BentoDoc['slides'][number]) => {
    const section = document.createElement('section')
    // Morph slides swap instantly; the Flip animation supplies the motion.
    section.dataset.transition = slide.transition === 'morph' ? 'none' : slide.transition
    if (slide.stateOf) section.dataset.bentoState = '1' // dimmed in overview
    const surface = renderSlide(slide, doc, { hidePlaceholders: true, liveMedia: true })
    // reveal slides start with only the default hover set visible
    if (slide.hover?.type === 'reveal') applyRevealSet(surface, slide.hover.default ?? null, slide.hover.default)
    section.appendChild(surface)
    if (slide.notes) {
      const aside = document.createElement('aside')
      aside.className = 'notes'
      aside.textContent = slide.notes
      section.appendChild(aside)
    }
    return section
  }
  doc.slides.forEach((slide) => slidesEl.appendChild(buildSection(slide)))
```

- [ ] **Step 4: Add the live reader replica**

`slidesEl`, `deck` and `buildSection` live inside `startPresentation`'s closure (present.ts) — `broadcastMode` only has the `session` object. So the hook is an `opts` callback that `startPresentation` invokes ONCE at init with the pieces, and `broadcastMode` registers its doc-change handler inside it.

In `present.ts`, `startPresentation`'s opts type (it already takes `opts` — `opts.fullscreen` exists), add:

```ts
  /** hosted-client live sync: invoked once at init with the pieces needed to
   *  re-render the deck on remote doc changes (slidesEl, deck, buildSection) */
  onDocChange?: (ctx: {
    slidesEl: HTMLElement
    deck: Reveal
    buildSection: (s: BentoDoc['slides'][number]) => HTMLElement
  }) => void
```

and after the section-building + Reveal init (after `deckReady` is set), register:

```ts
  if (opts?.onDocChange) {
    opts.onDocChange({ slidesEl, deck, buildSection })
  }
```

In `main.ts` `broadcastMode`, create the live replica BEFORE `startPresentation` and pass the hook (the store's `doc` events only fire after remote ops arrive, so ordering is safe):

```ts
  // Live content (hosted client): the copy carries reader collab creds — join
  // the deck's collab room as a reader replica so slide content updates in
  // real time as the deck is edited. Navigation still rides the broadcast
  // socket above; the session ignores ctl frames (onFrame has no default).
  const c = doc.collab
  let liveStore: Store | null = null
  if (c?.room && c.key && c.on !== false) {
    liveStore = new Store(doc)
    const liveSession = new SyncSession(liveStore)
    joinFromDoc(liveSession, liveStore)
  }
  const session = startPresentation(doc, 0, exitCard, {
    onDocChange: ({ slidesEl, deck, buildSection }) => {
      const visibleIndexOf = (i: number) => doc.slides.slice(0, i + 1).filter((s) => !s.stateOf).length
      liveStore?.on('doc', () => {
        if (doc.slides.length !== slidesEl.children.length) {
          // structural change: rebuild the section list and re-settle on the
          // same visible slide (the presenter's nav is 1-based visible numbers)
          const cur = deck.getIndices().h
          slidesEl.replaceChildren(...doc.slides.map(buildSection))
          deck.sync()
          session.goTo(slideIndexFromVisible(visibleIndexOf(cur)))
        } else {
          // content change: re-render the current slide in place (no fx replay —
          // the slide is already shown; entrance fx run on slidechange only)
          const cur = deck.getIndices().h
          const section = slidesEl.children[cur] as HTMLElement | undefined
          const slide = doc.slides[cur]
          if (section && slide) section.replaceChildren(buildSection(slide))
        }
      })
    },
  })
```

Note: `startPresentation`'s existing call sites (`playerMode`, `editorMode`'s `editor.present`) pass no `opts` or pass `{ fullscreen }` — the new field is optional, no call-site changes needed.

- [ ] **Step 5: Build to verify**

Run: `cd slides && npm run build:single`
Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add slides/src/main.ts slides/src/present.ts
git commit -m "feat: hosted broadcast client — ?room=&tok= re-point + live reader replica"
```

---

### Task 6: i18n — new strings in all catalogs

**Files:**
- Modify: `slides/src/i18n/de.ts, es.ts, fr.ts, it.ts, ja.ts, pt.ts, zh-Hans.ts, zh-Hant.ts` (English is the `t()` key itself — no catalog file).

**Interfaces:**
- Consumes: the strings used in Tasks 3-4.
- Produces: every new key present in all 8 catalogs.

- [ ] **Step 1: Add the keys to each catalog**

New keys (exact source strings, in the same position style as the other broadcast keys in each file):

```ts
'Hosting URL (optional)': '…',
'Hosted link': '…',
```

(Translations: de/es/fr/it/ja/pt/zh-Hans/zh-Hant — follow each catalog's existing broadcast-key translations for tone; the keys must match the source EXACTLY.)

- [ ] **Step 2: Verify key coverage**

Run: `cd slides && grep -rn "'Hosting URL (optional)'\|'Hosted link'" src/i18n/ | wc -l`
Expected: 16 (2 keys × 8 catalogs).

- [ ] **Step 3: Build to verify**

Run: `cd slides && npm run build:single`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add slides/src/i18n/
git commit -m "feat: i18n — hosted broadcast strings in all catalogs"
```

---

### Task 7: End-to-end verification

**Files:**
- Use: `scripts/build-broadcast-example.mjs` (fixture builder), `server/sync-worker` (wrangler dev), the built `dist-single/Bento_Slides.bento.html`.

- [ ] **Step 1: Build the fixture**

Run (from REPO ROOT — the script resolves paths relative to the repo root):

```bash
cd /Users/niemes/Code/bento && node scripts/build-broadcast-example.mjs --relay ws://localhost:8787
```

Expected: `working/broadcast-demo/` contains owner + copy decks.

- [ ] **Step 2: Start the relay**

Run (from `server/sync-worker`, background, log to /tmp/wrangler-relay.log — NEVER pipe through `head`):

```bash
cd /Users/niemes/Code/bento/server/sync-worker && npx wrangler dev --port 8787 --ip 127.0.0.1 > /tmp/wrangler-relay.log 2>&1 &
```

- [ ] **Step 3: Manual browser verification**

Open the owner deck in a browser tab (editor), the broadcast copy in a second tab. In the owner's speaker view, arm 📡. Verify:
1. The copy follows nav/laser/black (regression — unchanged behavior).
2. The speaker popup shows the "Broadcast link" row AND the "Hosted link" row (when `doc.meta.hostClient` is set — set it via the export prompt or `window.bento.doc.meta.hostClient = 'https://example.com/deck.bento.html'` then re-arm).
3. The hosted link has the shape `https://example.com/deck.bento.html?room=<name>&tok=<tok>`.
4. Open the hosted link in a third tab (append `?room=<name>&tok=<tok>` to the copy's URL) — it follows the same presenter.
5. Live content: with the copy open, edit a text element on the current slide in the owner's editor — the copy's current slide re-renders within ~1s.
6. Structural change: add a slide in the owner's editor — the copy rebuilds and stays on the same visible slide.

- [ ] **Step 4: Commit any verification fixes**

```bash
git add -A
git commit -m "fix: hosted broadcast verification fixes"
```

---

### Task 8: Docs — DECISIONS.md entry

**Files:**
- Modify: `docs/DECISIONS.md` (append-only log)

- [ ] **Step 1: Append the entry**

```markdown
## 2026-08-09 — Hosted broadcast client

The broadcast copy can be hosted once and re-pointed at any presenter's room:
`<hostUrl>?room=<roomName>&tok=<tok>` (minted by the presenter's deck from
`doc.meta.hostClient`, set at export). The hosted copy also carries the collab
read cap (`role:'reader'` + key — the v0.9.18 read-only-copy mechanism) so slide
content live-syncs from the deck's collab room; nav still rides the broadcast
socket. No relay changes; the URL carries only the nav token (same trust as the
broadcast link), the file carries the deck key (same trust as the read-only
copy). Design: docs/hosted-broadcast-design.md.
```

- [ ] **Step 2: Commit**

```bash
git add docs/DECISIONS.md
git commit -m "docs: hosted broadcast client decision"
```
