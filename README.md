# Bento — the office suite that fits in a file

**This PowerPoint alternative is a single HTML file.** A Bento deck carries
its own viewer, presenter, and editor inside the document — open it in any
browser, edit it, present it, send it. The person you send it to needs
nothing: the file *is* the software.

**Try it in 10 seconds:** open [bento.page/slides](https://bento.page/slides)
— that's the entire app, running on a starter deck that doubles as the
feature tour. Or grab a designed template from the
[gallery](https://bento.page/) and make it yours.

## Why this exists

Office documents used to be things you *had*. Now they're things you rent —
locked in someone's cloud, behind someone's login, readable only while a
company keeps its servers on. Bento takes the other path:

- **One file, forever.** Deck, fonts, images, charts, animations, and the
  full editor travel together. A copy from 2026 will open in 2036.
- **View-source honest.** Your data sits in a plain, readable JSON block at
  the top of the file. No binary formats, no lock-in, no archaeology.
- **It saves itself.** The file rewrites its own data block on save (File
  System Access API, with a download fallback). No app to install, ever.
- **Local-first, provably.** Flip on Offline mode and nothing leaves your
  machine — updates and collaboration are hard-blocked, and the app says so.

## What's inside

| | |
|---|---|
| **Morph presenting** | Elements that share an id animate between slides — position, size, color, even gradients. Duplicate a slide, rearrange, and the motion designs itself. |
| **Live collaboration** | E2EE (AES-GCM) with keys that live in your file, never on a server. The file itself is the invitation: anyone who opens a copy joins. Offline edits merge back precisely — our own CRDT, character-level text merging included. |
| **A blind relay** | The optional sync relay ([`server/sync-worker/`](server/sync-worker/)) stores ciphertext and learns nothing. Read the source; it's about one file. |
| **Charts, built in** | Bar / line / pie / scatter drawn by our own dependency-free engine, live during presentations: tooltips, zoom, and data that morphs when a bar chart becomes a pie. |
| **Designed for AI** | The document is plain JSON in the file, so agents edit `.bento.html` files in place and chatbots round-trip the JSON (`window.bento.loadDoc`). See [docs/agents.md](docs/agents.md). |
| **Signed self-updates** | Releases are ECDSA-signed and offered in-app. Updating writes a *new* file — the old one stays as your rollback. No server ever touches your documents. |
| **Everything else** | Speaker view, comments, layouts, hidden interactive states, hover reveals, motion paths, PDF export, page sizes, 8 UI languages — in a ~400 KB shell. |

## Architecture in one paragraph

`slides/src/model.ts` defines the JSON document model; one renderer
(`render.ts`) draws it for the editor canvas, thumbnails, and present mode
(Reveal.js drives navigation; morphs are computed from the model, not the
DOM). Animation is an in-house engine (`anim.ts`), charts are in-house
(`charts.ts`), collaboration is an in-house CRDT (`sync/crdt.ts` — pure
data, fuzz-tested by `scripts/test-sync.ts` across hundreds of thousands of
convergence checks). The shell compresses to ~400 KB with the document block
left as plaintext so old files and outside tools can always splice it. The
deep dive: [docs/architecture.md](docs/architecture.md).

## Security model, honestly

- Collab keys are minted client-side at document creation and live only in
  the file. Possession of the file = membership; "Rotate keys" = revocation.
- The relay sees: ciphertext, connection timing, and a hash of the room key.
  It cannot read content, names, or structure.
- Presence names are claims, not proofs — fine within a shared-key room;
  enterprise identity would need signed frames (designed, not built).
- Update checks fetch a static manifest and send nothing about you or your
  document. Signature + hash + version monotonicity are verified in-app.
- Known trade-offs: undo during live collab is snapshot-based and can revert
  a collaborator's concurrent edit to the same property; editing is
  desktop-first (phones view and present well).

## Building

```bash
cd slides
npm install
npm run dev            # dev server
npm run build:single   # → dist-single/Bento_Slides.bento.html (the product)
```

`node scripts/test-sync.ts` runs the CRDT convergence rig. Releases are cut
locally so the signing key never leaves the maintainer's machine — see
[docs/RELEASING.md](docs/RELEASING.md).

## Status

**Bento/Slides** is the first app of Bento/Suite — Docs and Sheets are
coming. The current release lives on [bento.page](https://bento.page) and
reaches every existing file through the signed update channel.

## License

Bento is open source under the [MIT License](LICENSE) — all software here is
MIT, © 2026 The Bento/Suite authors. Bundled runtime components (reveal.js,
Moveable, Selecto) are MIT; the embedded typefaces (Fraunces, Instrument Sans)
are OFL; gallery imagery is public-domain (see
`scripts/gallery-photos/SOURCES.md`). Each component keeps its own license.
