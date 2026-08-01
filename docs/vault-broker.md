# bento/vault — the broker mechanism

*Design document, 2026-07-28. Status: **proposed** — nothing built. Companion to
`vault-design.md` (what vault is and who for). This document specifies the four
mechanisms that follow from one idea: **vault brokers the capabilities a
travelling file structurally cannot hold.***

Nothing here is required for a Bento document to work. A file with no vault
configuration behaves exactly as it does today, forever — that is invariant 2 of
`vault-design.md` and every mechanism below is designed around it.

---

## 1. Vault-minted shells: where configuration lives

A vault mints `.bento.html` shells carrying its own identity, so a document knows
which vault to ask without anyone typing a URL.

### Branding needs no new mechanism

"Customised for that vault" in the *visual* sense — the org's fonts, theme,
layouts, starter deck — is already expressible: `doc.theme`, `doc.fonts` and
`doc.layouts` exist in the format. A vault serves a starter document with the
org's layouts baked in and nothing new is required. **Only endpoint and trust are
new.**

### Configuration lives in the SHELL, not the document

The document must stay clean. Put vault configuration in `#bento-doc` and it
travels with the content: email a deck to a client and you have shipped your
internal vault hostname with it. Keep it in the shell and a document exported for
outside use is just a document.

A second plaintext block, sibling to `#bento-doc` and subject to the same splice
contract (`PLATFORM.md` §2 — plaintext, stable id, survives
DOMParser→splice→outerHTML, never contains `</script>`):

```html
<script type="application/bento+json" id="bento-vault">
{
  "v": 1,
  "url": "https://vault.example.internal",
  "pub": "<base64url SPKI of the vault's public key>",
  "name": "Example Ltd",
  "channel": "https://vault.example.internal/releases/slides/manifest.json",
  "sig": "<base64url signature, see §2>"
}
</script>
```

Rules:

- **Additive.** Absent block = today's behaviour exactly.
- **Never a secret.** This block is world-readable in every copy of the file. It
  carries a public key and a URL and nothing else, ever.
- **Strippable.** "Export for outside" removes the block. This must be a visible,
  named action, because the failure mode is silent.

### The update interaction, which is not optional to solve

`serializeWith(shell, doc)` (`kernel/src/save.ts:322`) re-splices the document
into a **freshly fetched shell** and discards everything the old shell carried.
So a vault-minted shell that checks `bento.page` loses its configuration on the
first update.

Therefore **a minted shell points `update.ts` at the vault's channel.** This is
self-consistent rather than a workaround: an org that mints shells wants to
control which build its people run.

Two consequences to design for:

- **Escape hatch.** If the vault goes away, the file still works — it is
  self-contained — but is pinned to that version. There must be a visible "return
  to the upstream channel" action. A company folding must not permanently freeze
  its former employees' documents.
- **Drift.** Org channels lag upstream, so upstream security fixes need a path
  that does not depend on an admin noticing. At minimum the client should surface
  "your channel is N releases behind" using upstream's manifest as a *read-only*
  reference, without switching channels on its own.

---

## 2. Dual signatures: verifying your employer shipped genuine Bento

Minting inverts the trust model. Today a user trusts an offline signing key held
by the project. In a minted shell they also trust their employer. That is normal
for managed software and unacceptable if it is invisible.

A reader must be able to verify two independent things:

1. **The runtime is genuine, unmodified Bento.**
2. **The configuration was authorised by the vault it names.**

### Canonicalisation

The minted file differs from upstream's bytes, so the whole-file hash in
upstream's manifest cannot match. Define a canonical form:

> **Canonical runtime** = the file with the `#bento-doc` and `#bento-vault`
> elements removed entirely, everything else byte-identical.

Then `sha256(canonical runtime)` must equal the `sha256` upstream published for
that version in its signed manifest. This reuses the existing manifest with no
new upstream machinery — `update.ts` already fetches and verifies it.

### What the vault signs

The vault signs over the config **bound to the runtime it was minted for**:

```
sig = ECDSA-P256( vaultPriv, "bento-vault-v1\n" ‖ runtimeHash ‖ "\n" ‖ canonicalJSON(config minus sig) )
```

Binding to `runtimeHash` is the point. Without it a vault's configuration block
could be lifted and replayed onto a modified runtime, and the signature would
still verify.

### Verification, and what it proves

| Check | Proves |
|---|---|
| canonical runtime hash ∈ upstream signed manifest | the editor is stock Bento, unmodified |
| vault signature verifies over (runtimeHash ‖ config) | the config is authorised *and* bound to this exact runtime |

Both must be surfaced in the UI — a named organisation and a key fingerprint,
visible before the document does anything on the network. "Managed by Example
Ltd" with a checkable fingerprint is honest; a silent redirect is not.

### Trust on first use

The vault's public key is pinned in the block itself, which alone proves nothing
— a hostile minter signs its own config happily. What the scheme *does*
guarantee is that the **runtime** is unmodified upstream Bento, which is the
property that actually protects the user. Recognising the *organisation* is
TOFU: record the fingerprint on first encounter and warn loudly if a later
document claims the same name with a different key.

### Supply chain, stated plainly

A compromised vault mints hostile configuration to everyone at once, and its
signing key is necessarily more online than the project's offline release key.
The runtime-hash binding contains the blast radius: a compromised vault can
redirect endpoints and exfiltrate what documents send, but **cannot ship modified
editor code without failing check 1**. That is the security argument for doing
the dual signature in v1 rather than adding it later.

---

## 3. Live data access

### Model

`TableElement` gains a source naming a query the vault holds:

```ts
source?: {
  query: string                       // a NAME, never query text
  params?: Record<string, string>
  fetchedAt?: string                  // ISO timestamp of the embedded values
}
```

The table's `rows` continue to hold real values at all times — the fetch
*replaces* them. Everything downstream is already built: `syncLinkedChart`
(`model.ts:628`) pushes labels and numeric columns into a bound chart's option in
place, and the editor re-derives on the `doc` event.

### Named queries only

A document carries a query *name*. The vault maps names to statements, defined by
an administrator, parameterised, with the parameter types declared. **A document
never carries SQL, a connection string, a URL, or anything else that determines
what runs.**

If documents could supply query text, every deck anyone opens becomes an
exfiltration tool against the database — including a deck emailed in from
outside. This is the single most important rule in the mechanism and it is free
at design time.

### Authorisation is per-user, from the first commit

The broker resolves *who is asking*, and the query runs with that identity's
permissions — never a shared service account. A sales deck bound to
`revenue_by_region` must return the asking user's regions.

v1 has one user and this looks like pointless ceremony. It is not: a
service-account-shaped broker has to be rewritten to become a per-user one, and
every deployed vault becomes a migration. This is the retrofit that
`vault-design.md` singles out as unaffordable to postpone.

### The offline rule

Invariant 7: **a bound document always carries its last known values.** The
connection refreshes; it never supplies. Rendering shows the embedded values
immediately and updates only if a refresh succeeds, with `fetchedAt` surfaced so
a reader knows how old the numbers are.

Stale-but-visible beats fresh-or-nothing for a document that might be presented
on a train.

### Collaboration: refresh is a commit, not a derivation

The existing pattern for linked charts is *derive-not-commit* — every replica
recomputes from the synced table, so no operations are needed and replicas agree
because the derivation is deterministic.

**A vault refresh is not deterministic.** Two replicas fetching at different
moments get different rows. So a refresh must be performed by one actor and
**committed as an ordinary edit**, replicating through the CRDT like any other
change to `rows`. Deriving independently on each replica is permanent divergence.

Extend `scripts/test-sync.ts` before this merges. The convergence rig has caught
this class repeatedly and will not catch it unless it is taught to.

---

## 4. The archive shape

Not a backup product. Backup is solved — restic, borg, ZFS, object storage — and
building it would be building a worse version of mature software.

What vault produces is an **archive that does not need us to exist**:

```
archive/
  manifest.jsonl            # append-only, one JSON object per document version
  objects/
    <docId>/<sha256>.bento.html
```

- **One self-contained file per document version.** Each renders itself in a
  browser with nothing installed, and each carries its content as plaintext JSON
  in `#bento-doc` for machine reading without the runtime. That dual guarantee —
  human-readable *and* machine-readable, with no vendor in the loop — is the
  entire value proposition, and no competitor's export format has it.
- **Append-only, content-addressed.** A version is written once under its own
  hash and never mutated. Suits object-lock/WORM storage directly, which is what
  retention regimes actually ask for.
- **A plaintext manifest**: `docId`, content hash, title, timestamp, author,
  retention class. Greppable with no tooling, in twenty years, by someone who has
  never heard of Bento.
- **Backup is someone else's job.** Point restic or S3 lifecycle rules at the
  directory. Restore is copying files back — or just opening one.

### Open questions

- **Encrypted documents archive as ciphertext.** Retention of encrypted decks
  therefore implies key escrow, which is a real organisational decision with real
  consequences. It must be an explicit choice at configuration time and must
  never be defaulted silently in either direction.
- **What is a "version" worth keeping?** Every save is too many; every manual
  save may be too few. Probably a retention policy per class, but this needs a
  real requirement from a real organisation before being invented.
- **Deletion under retention.** GDPR erasure and WORM retention conflict by
  construction. Any system offering retention has to answer this; we do not yet
  have an answer, and inventing one without a real requirement would be guessing.
