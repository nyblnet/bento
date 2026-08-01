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

*Re-argued 2026-07-27 after three org-shaped capabilities surfaced that the
first pass did not have in view. The earlier answer — "build for the individual,
the organisation is the destination" — was reached before them and is restated
here at full strength on both sides rather than quietly amended.*

### The case for the organisation

Four of the five things vault does are worth little to one person and a great
deal to a company:

- **Live data access.** A chart bound to the company's warehouse. An individual
  has no warehouse.
- **Retention archive.** Regulated retention is a compliance obligation, not a
  preference. Individuals use Time Machine.
- **Private release channel.** Controlling which build your people run is
  meaningless at one seat.
- **Central AI credential and spend control.** One person can put a key in an
  environment variable.

Only **search** is genuinely individual, and even there the value grows with the
number of documents *other people* wrote.

What these have in common is that they are properties of a *deployment*, not of
a person: retention is a compliance obligation on an organisation, and a data
connector is a platform capability. Both tend to arise where the documents
cannot go into SaaS at all — the same constraint that makes self-hosting a
requirement rather than a preference.

### The case against

The people actually using Bento today are individuals and very small groups, and
every org-shaped pillar above implies the expensive part — **multi-user
identity**: per-user query authorisation, per-user spend attribution, roles,
audit. That, not the broker, is the real cost of serving organisations, and it
is a maintenance surface a single maintainer carries indefinitely.

And the org case is currently reasoning, not evidence: it was derived from the
shape of the capabilities, not from a stated requirement.

### The resolution

The segment question does not decide what to *build* — it decides what to
**promise**, what to **name**, and when to take on multi-user identity. On the
build order these agree: the broker, the index and the archive are foundational
and serve one user and fifty identically.

So:

1. **Ship single-user.** Promise nothing organisational.
2. **But design the identity model multi-user from commit one.** Per-user query
   authorisation and per-user spend attribution cannot be retrofitted — a
   service-account-shaped broker has to be rewritten to become a
   per-user-shaped one, and every deployed vault becomes a migration. This is
   cheap now and brutal later, and it is the one place where "we'll do it when
   someone asks" is the wrong answer.
3. **The gate for building organisational features is a real stated
   requirement**, not a count of pillars. One concrete retention or data
   requirement from an actual deployment settles in a week what this document
   cannot settle by argument.

## What vault is, stated as a pattern

Three capabilities arrived separately and turned out to be one shape. AI needed a
credential the file cannot carry. Live data needs a credential *and* network reach
the file cannot have. Key distribution needs an authority the file cannot be.

**Vault is the broker for capabilities a travelling file structurally cannot
hold.** That definition predicts rather than accumulates: it says what belongs in
vault (anything requiring a secret, a private network, or an authority) and what
does not (anything a file can do alone — which is everything else, and must stay
that way).

The mechanism is specified in `vault-broker.md`.

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

### 5. Live data access — the same pattern as the broker, and what makes dash real

A chart bound to the company's warehouse. The credential and the network reach
are both things a travelling file cannot have, so this is pillar 1 again with a
different secret.

**The invariant decides the design.** `PLATFORM.md` §1 forbids requiring a
network to open, edit or present — so a bound document **must always carry its
last fetched values as ordinary static data**. The connection only ever
*refreshes*; it never *supplies*. Otherwise the VPN drops mid-presentation and
the charts are empty.

The consequence is worth choosing rather than discovering: if the file caches the
values, emailing the deck emails the data. That is usually correct — it is a
document, and documents contain their content — and it is what lets a bound
dashboard render for a recipient with no login and no account. For genuinely
sensitive sources a refresh-only mode is possible, at the cost of rendering
nothing offline. Default to embedding; make the other mode explicit and visible.

The seam already exists: `ChartElement.source?: { tableId }` (`model.ts:228`) with
`syncLinkedChart` re-deriving on every `doc` event (`editor/editor.ts`). Give
`TableElement` a `source` naming a vault query and the refresh path is built.

Two things that bite if not decided up front — **named queries only** (a document
references a query an admin registered; it never carries query text, or any deck
anyone opens becomes an exfiltration tool), and **a vault refresh must be
committed by one actor** under collab rather than derived per-replica, because
two replicas fetching at different moments get different rows and diverge.
Details in `vault-broker.md`.

### 6. The private release channel — a consequence of minting shells

If a vault mints shells carrying its own configuration, it is already an update
channel, because `serializeWith(shell, doc)` (`kernel/src/save.ts`) re-splices
the document into a *freshly fetched* shell and discards everything else. Shell
configuration survives an update only if the update comes from the vault.

That falls out as a feature rather than a cost: controlling which build your
people run, staging rollouts, and not shipping an untested version on a Friday
are ordinary organisational requirements. The machinery exists — `update.ts`
already verifies a signed manifest and already supports being pointed elsewhere.
What is new is a second trust anchor and the dual-signature scheme in
`vault-broker.md`, which exists so a user can verify their employer shipped
genuine unmodified Bento.

### 7. Retention archive — reinstated, and distinguished from backup

*This was previously cut outright. That was right about backup and wrong about
archival, and the two are not the same product.*

**Backup stays cut.** Copying bytes is solved by restic, borg, ZFS and object
storage, and building it would be building a worse version of mature software.

**Archival is different, and Bento is structurally better at it than anything
else in this market.** The hard problem in regulated retention is not storing
bytes for ten years — it is *being able to open them* in ten years. Every
competitor's answer requires their software to still exist and still be licensed:
a Confluence dump needs Confluence, a SharePoint archive needs SharePoint, a
Notion export loses fidelity on the way out.

A Bento archive renders itself, and carries a second guarantee underneath: even
if browsers change beyond recognition, `#bento-doc` is plaintext JSON, so the
content stays machine-readable without the runtime. Human-readable *and*
machine-readable, with no vendor in the loop.

This is cheap precisely because it is not a backup product: make the library a
well-formed self-describing archive — one self-contained file per document,
append-only, content-addressed, with a plaintext manifest — and let existing
tools move the bytes. Shape in `vault-broker.md`.

Unresolved: an encrypted deck archives as ciphertext, so retention of encrypted
documents implies key escrow. That is an organisational decision with real
consequences and must not be defaulted silently.

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
7. **A bound document always carries its last known values.** A vault connection
   refreshes data; it never supplies it. A document whose charts are empty
   without a network has broken invariant 2 by another route.
8. **A document never carries query text, only a query name.** The vault decides
   what a name means. Anything else makes every deck an exfiltration tool.

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
4. **The broker**, off by default, framed as plumbing — **with the per-user
   authorisation model in place from the first commit** even though v1 has one
   user. See "Who it is for": this is the single thing that cannot be retrofitted
   without a migration on every deployed vault.
5. **Live data access** on top of the broker, named queries only.
6. **The archive shape** — append-only, content-addressed, self-describing. Cheap
   once the index exists, and the pillar most likely to attract a real requirement.
7. **Shell minting and the private release channel**, with dual signatures.
8. **Vault as an MCP server** over the library, so existing agents can search and
   edit decks with no bespoke integration on either side.

**Defer:** SSO, RBAC, audit export, the dead-drop, NAT traversal.
Note that *multi-user identity* moves from "defer" to "design now, ship later" —
deferring the feature is fine, deferring the shape is not.

**Never build:** a feature gate inside a document file, a cloud-only relay, a
general RAG product, backups, or a query path that accepts document-supplied SQL.
