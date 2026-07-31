# bento/vault — design

*Rewritten 2026-07-27. Status: **proposed** — nothing built. Supersedes the
2026-07-25 "personal server" framing; see the decision log entry of the same
date. Companion to `relay-design.md` (the rendezvous plumbing),
`collab-design.md` (live multiplayer on one document) and `PLATFORM.md` (the
invariants every Bento app honours).*

> **"vault" is a working title.** Settle the name before anything ships under
> it.

## What it is, in one sentence

**The box that remembers your documents after they leave.**

A Bento file is complete on its own — it opens, edits and presents with nothing
installed, and that is not changing. But a file that travels has no home
address. It cannot be searched alongside its siblings, cannot hold a credential,
and cannot call a model. Vault is a small server you run that holds the index of
the documents you own, holds the keys, and brokers the calls a portable file
structurally cannot make — while any document remains exportable as a standalone
`.bento.html` at any moment.

## What it is not

- **Not a sync service.** Dropbox, iCloud Drive and Syncthing already do this,
  and for most people they already deliver "my documents on every device" —
  combined with `bento/tray` on iOS, that promise is met today with no Bento
  infrastructure at all.
- **Not a place documents live inside.** That is what Nextcloud is for.
- **Not an access-control system.** It cannot recall a file already sent. Ever.
  Any claim implying otherwise fails the first security review it meets.
- **Not a RAG product.** Onyx CE is MIT-licensed, self-hostable and already
  ships an MCP server; that ground is covered.
- **Not required.** Every Bento app works fully, forever, with no vault.

## Who it is for

The individual and the organisation are the same software at different scales —
same index, same owner→invite→member key chain, same broker — but they are not
the same problem, and solving one does not deliver the other.

**Build for the individual first.** One person, several devices, a machine that
is usually awake, who already runs Ollama and resents that their decks are
scattered across three laptops. That is the smallest deployment that exercises
every part of the design, and it is buildable by one maintainer.

**The organisation is the destination, not the first release.** Architecturally
this costs nothing: a single-user vault *is* the org vault with one user — same
index, same key chain, same broker. Build that, design toward multi-user,
promise neither.

## The pillars, ranked on evidence

### 1. The AI broker — the pillar that makes vault necessary

Everything else on this list is a convenience. This one is structural.

A self-contained document travels, so **it can never carry a model credential** —
that is emailing your API key to everyone you share the deck with. `localStorage`
is per-device, and under tray it is per-*document* (the origin is
`bento-tray://<sha256 of path>`, `EditorViewController.swift:55-58`), so it
degenerates into configuring a key per deck. The only place a credential can live
once and serve a whole library is a server the user runs.

**In-app AI is architecturally impossible without something vault-shaped.** That
is the argument, and it rests on credentials alone.

There is a second, weaker argument about browser origins that should be stated
carefully because it is easy to get wrong. A page opened from `file://` sends
`Origin: null`. Ollama's default allow-list *does* include `file://*`
(`envconfig/config.go:100-106`) — so the common claim that Ollama simply refuses
local files is **false as usually stated**. But `gin-contrib/cors` matches
origins by exact string or regex (`config.go:128-140`), and `null` does not match
`file://*`, so a real browser request from a saved deck is likely still refused.
**This is reasoned, not measured** — verify it against a running Ollama before
relying on it. Under tray the question does not arise: `bento-tray://…` is not in
any default allow-list.

Keep the broker, build it off by default, and treat it as plumbing rather than a
headline. Pointing an editor at a local model is commodity work: Collabora
Online 26.04 added exactly this in July 2026, Nextcloud ships local-LLM
integration out of the box, and LiteLLM already provides virtual keys, budgets
and spend attribution as stock behaviour, not an add-on. "Configure a model
once" is a base-URL field. What is ours is the format around it — a document
that stays portable while something else holds the credential.

### 2. Search over the library — narrowed to full text, and measured end to end

**Page one is already findable; everything after it is not.** This was measured
on a real deck saved from `main`, not reasoned about.

The document itself is invisible: content lives in `#bento-doc`, and text inside
a `<script>` block is not indexed (control: the same phrase in `<body>` is found,
in `<script>` it is not, while `grep` finds it instantly either way). What
changed is that the save-time first-page preview is now ORDINARY MARKUP rather
than a `<noscript>` (see the thumbnails entry of 2026-07-27 in `DECISIONS.md`,
`kernel/src/save.ts`), and ordinary markup indexes.

Measured with `mdimport -d2 -t` on a deck saved from the current shell:
`kMDItemTextContent` is 330 characters, and the extracted title is the whole
title slide — headline, body copy and all. A token planted on **slide two** does
not appear at all. Probing the three structures in isolation confirms the switch
cost nothing: plain markup, markup-plus-remover and `<noscript>` are all indexed.

So the avenue that was flagged as untested is now answered, and it answers
**smaller than hoped**. A deck is findable by its title slide today, for free,
with no vault. What remains unserved is FULL-TEXT search — "find the deck where I
showed Q3 churn" when Q3 churn is on slide fourteen. That is the real unmet need,
it is narrower than "OS search does not see Bento files", and it is the need an
index actually serves.

Extending the preview to carry every slide's text is the obvious cheap answer and
is bounded: `PREVIEW_BUDGET` is 64KB, the preview tiers down under it, and
anything written into a document is additive forever (`PLATFORM.md` §3). Whether
a whole-deck text block belongs in a file whose preview exists for THUMBNAILS is
a separate question from whether it would work — it would.

### 3. Centralisation without SaaS — true, but a consequence, not a reason

Docmost, AFFiNE, AppFlowy and Nextcloud all say "your data never leaves your
servers" in those words, so self-hosting is table stakes rather than a
distinguishing property. The first question on every thread will be "why not
Nextcloud?", and the answer has to be about the **format** — a file that is its
own application — not about whose hardware it sits on.

### 4. SSO — demote

**SSO gates distribution, never the file.** Once someone holds the bytes they
open them forever, offline, with no server — that is the product, not a bug.
What SSO can gate is access to the vault and the distribution of decryption keys
(the `bento/enc` envelope and the owner→invite→member chain already exist for
this). **Revocation is forward-only**: a revoked member keeps what they already
downloaded, exactly as `collab-design.md` documents for devices. Say this in the
first conversation, not the fifth.

If identity ever ships, call it what it is: *key distribution and forward
revocation*.

### 5. Backup and version history — cut it

The audience runs restic, borg, ZFS and git, and `kernel/src/autosave.ts`
already ships version history. The one genuine gap — autosave's history is
per-device IndexedDB and dies with the browser profile — is a feature of the
vault, not a reason for it.

## Licence

The runtime stays MIT, non-negotiable — `THIRD_PARTY_NOTICES.md` is embedded in
every saved file, so copyleft on the shell would attach to every document a user
emails. Vault is a **separate repo with its licence chosen at commit #1**. Never
relicense slides.

## Invariants

1. **Export always works.** Any document is exportable as a standalone
   `.bento.html` from any client at any time. Without this we have built Notion
   with extra steps.
2. **Vault is optional.** Every Bento app works fully with no vault, forever.
3. **AI is additive, never load-bearing.** No app may require a vault or a model
   to edit. If it ever does, `PLATFORM.md` §1 is gone.
4. **No document makes an outbound call by default.** Opt-in per document, a
   visible endpoint indicator, and a readable log of what was sent where.
5. **The relay only ever sees ciphertext**, in every deployment.
6. **Never remove a capability a release has already shipped.**

## Sequencing

1. **Make the self-hosting claim true.** The r/selfhosted copy already says the
   collab relay is self-hostable; that is untested under standalone `workerd`.
   Fix it or soften it — a false self-hosting claim is the fastest way to lose
   this audience.
2. ~~Test the `<noscript>` search avenue before building any indexer.~~
   **Done** (2026-07-28, §2): the preview left `<noscript>` for plain markup and
   is indexed, so page one is already searchable with no server. The indexer's
   job is therefore slides 2..n, not the library.
3. **The index**, local and rebuildable from the files.
4. **The broker**, off by default, framed as plumbing.
5. **Vault as an MCP server** over the library, so existing agents can search and
   edit decks with no bespoke integration on either side.

**Defer:** multi-user, SSO, RBAC, audit, the dead-drop, NAT traversal.
**Never build:** a feature gate inside a document file, a cloud-only relay, a
general RAG product, backups.
