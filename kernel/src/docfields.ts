// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Fields a COPY of a document treats specially — the two sides of "not ordinary
// content." Every Bento app shares these lists, so a field added in one place is
// handled everywhere and a new secret fails CLOSED instead of leaking.
//
//   1. Identity/capability kept LIVE across undo/redo and every whole-document
//      restore (FROM_LIVE) — never resurrected from a snapshot.
//   2. Capabilities/secrets STRIPPED when a copy is exported or shared
//      (CAP_FIELDS at the top level; COLLAB_READER_KEEP — an ALLOWLIST — within
//      a kept collab block).
//
// The helpers operate on plain objects: each app's doc/collab shape is a
// superset of the kernel's, so this module stays app-agnostic and imports
// nothing.

type Obj = Record<string, unknown>

// --- identity (kept live on undo/redo + whole-doc restore) ------------------

/** Top-level fields that are identity or capability, never undoable content.
 *  undo/redo and every whole-document restore keep the LIVE value, not the
 *  snapshot's — so nothing can resurrect an old docId, a stale sharing flag, a
 *  dropped read-only mode or a cleared template flag. SUPERSET across apps: a
 *  field absent from a given app's doc makes keeping it live a no-op. */
export const FROM_LIVE = ['docId', 'collab', 'readonly', 'template'] as const

/** After a restore has replaced `doc` with a snapshot, put identity back from
 *  the LIVE doc — or delete it where live lacks it, so the snapshot's value can
 *  never leak through. Mutates `restored` in place. */
export function keepLiveIdentity(restored: Obj, live: Obj): void {
  for (const k of FROM_LIVE) {
    if (Object.hasOwn(live, k) && live[k] !== undefined) restored[k] = live[k]
    else delete restored[k]
  }
}

// --- capabilities / secrets (stripped on export) ----------------------------

/** Top-level fields that carry a write/owner capability or secret. A copy that
 *  does NOT keep the live room drops these entirely. A new top-level secret is
 *  closed by adding it here, beside where capabilities are minted. (Top level is
 *  a denylist: most top-level fields are content and cannot be allowlisted.) */
export const CAP_FIELDS = ['collab'] as const

/** A shallow copy of `doc` with every capability field removed. */
export function withoutCaps<T extends object>(doc: T): T {
  const out = { ...(doc as Obj) }
  for (const k of CAP_FIELDS) delete out[k]
  return out as T
}

/** Within a KEPT collab block, the fields a reader/viewer copy may carry. This
 *  is an ALLOWLIST: anything not listed — writerPriv, ownerPriv, invite,
 *  audience, the CRDT `sync` stamp, any link records, and any field added later —
 *  is dropped, so a new secret fails CLOSED. `sync` is deliberately excluded: a
 *  reader does not contribute, so it adopts fresh and converges from the room,
 *  and carrying no stamp removes stale-stamp risk (writer/invite copies keep sync
 *  through their own builders). `key` (the symmetric READ cap) and `room` stay —
 *  a reader needs them to decrypt and join. `role` is NOT copied from the source
 *  (a writer's collab must never project as a writer — the #588 class);
 *  collabForReader sets it to 'reader' itself. */
export const COLLAB_READER_KEEP =
  ['room', 'key', 'owner', 'writerPub', 'on', 'v'] as const

/** Project a collab block down to what a reader/viewer copy may hold: a new
 *  object with only the allowlisted fields that are present, and role forced to
 *  'reader' — never the source's role. */
export function collabForReader(collab: object): Obj {
  const src = collab as Obj
  const out: Obj = {}
  for (const k of COLLAB_READER_KEEP) if (Object.hasOwn(src, k) && src[k] !== undefined) out[k] = src[k]
  out.role = 'reader'
  return out
}

/** Within a kept collab, the fields an INVITE (edit/comment) copy may carry: the
 *  reader allowlist PLUS the CRDT `sync` stamp (an invite copy contributes, so it
 *  forks from the stamp) and the owner-signed `invite` delegation. Still an
 *  ALLOWLIST — ownerPriv, writerPriv, audience, any link records, and any field
 *  added later are dropped. The role rides inside `invite` (invite.role), not the
 *  top level, so collabForInvite sets no top-level role. */
export const COLLAB_INVITE_KEEP = [...COLLAB_READER_KEEP, 'sync'] as const

/** Project a collab block to what an invite copy may hold, then attach the
 *  FRESHLY-MINTED `invite` and set the top-level role FROM it. The source's own
 *  invite, links and role are never carried (they are not in the allowlist, and
 *  invite + role come only from the parameter), so a commenter invite opens
 *  locked (role:'commenter') and a writer invite editable — never the source's
 *  chrome. */
export function collabForInvite(collab: object, invite: { role: string }): Obj {
  const src = collab as Obj
  const out: Obj = {}
  for (const k of COLLAB_INVITE_KEEP) if (Object.hasOwn(src, k) && src[k] !== undefined) out[k] = src[k]
  out.invite = invite
  out.role = invite.role
  return out
}

/** On a key rotation ("Reset access…") the collab is rebuilt with FRESH keys —
 *  that is the revocation. These sub-fields are carried from the old block onto
 *  the fresh one: the CRDT `sync` stamp (so the document's collab history
 *  survives the reset) and `links` (published-link records survive a reset — the
 *  maintainer's ruling). To make Reset REVOKE links instead, drop 'links' here —
 *  a one-line change. */
export const COLLAB_ROTATE_KEEP = ['sync', 'links'] as const

/** Build the rotated collab: the freshly-minted block with the rotate-survivor
 *  sub-fields carried over from `old`. Returns a new object; `fresh`'s type is
 *  preserved. */
export function carryThroughRotation<T extends object>(fresh: T, old: object | undefined): T {
  if (!old) return fresh
  const out = { ...(fresh as Obj) }
  const src = old as Obj
  for (const k of COLLAB_ROTATE_KEEP) if (Object.hasOwn(src, k) && src[k] !== undefined) out[k] = src[k]
  return out as T
}

// ============================================================================
// Field classification v2 — the single typed source for how each document field
// is COPIED. Every app declares an EXHAUSTIVE Record<keyof Doc, FieldClass>
// (tsc fails on a new field), and projectForCopy builds a copy FROM EMPTY using
// only the rule tables below — so a field is carried only if a table cell says
// so, and a new field fails CLOSED (dropped from every outward copy) until it is
// classified. This generalizes the identity/capability lists above; those
// helpers remain and implement the capability projection.
// ============================================================================

/** The five classes. See CLASS_RULES for what each does per copy tier.
 *  - content:    ordinary document data. Kept in every copy.
 *  - identity:   docId. Kept; RESET (re-minted at load) on a new-identity copy.
 *  - mode:       readonly/template file modes. The builder SETS them per tier
 *                (MODE_FIELD_RULES) — never stripped, which would turn a
 *                read-only copy editable (the fail-open this class exists to stop).
 *  - capability: collab — the ONLY stripped/projected class (via the allowlists).
 *  - history:    revisions/trail. File-local; dropped from reader-tier copies,
 *                kept in the file, duplicates and invites. */
export type FieldClass = 'content' | 'identity' | 'mode' | 'capability' | 'history'

/** The copy tiers. `file` is the full saved document (the owner's round-trip);
 *  `duplicate` is "Duplicate as new deck" (new identity, still the owner's own
 *  copy). The rest are copies handed to someone else. */
export type Tier =
  | 'file' | 'duplicate' | 'invite' | 'reader' | 'audience'
  | 'package' | 'link' | 'template' | 'copyJSON'

export const TIERS: readonly Tier[] =
  ['file', 'duplicate', 'invite', 'reader', 'audience', 'package', 'link', 'template', 'copyJSON']

/** What a copy does with one field in one tier.
 *  - keep:   copy the live value as-is.
 *  - drop:   omit the field.
 *  - reset:  omit it so it is re-minted at load (a fresh docId) / re-minted fresh
 *            (new collab creds on a duplicate). The caller mints; projectForCopy
 *            only omits — builders never post-edit identity/capability.
 *  - {set}:  force a fixed value (reader copy -> readonly=true).
 *  - {allowlist}: project a capability block through a tier allowlist.
 *  NOTE: 'per-field' is DELIBERATELY not a Rule — it is allowed ONLY in the mode
 *  row of CLASS_RULES (see its type), so no other class can defer to a per-field
 *  table and the mode row can hold nothing else. */
export type Rule =
  | 'keep'
  | 'drop'
  | 'reset'
  | { readonly set: unknown }
  | { readonly allowlist: 'reader' | 'invite' | 'audience' }

/** The deferral literal — only the mode row of CLASS_RULES may hold it. */
type PerField = 'per-field'

/** Per-class x per-tier rules. The `mode` row is EXACTLY PerField in every tier
 *  (it can only defer to MODE_FIELD_RULES); every other row is Rule and cannot
 *  hold 'per-field'. The object type is written out (no index signature, no
 *  default) so adding a FieldClass or a Tier fails tsc until every cell exists. */
export const CLASS_RULES: {
  readonly content: Record<Tier, Rule>
  readonly identity: Record<Tier, Rule>
  readonly mode: Record<Tier, PerField>
  readonly capability: Record<Tier, Rule>
  readonly history: Record<Tier, Rule>
} = {
  content: {
    file: 'keep', duplicate: 'keep', invite: 'keep', reader: 'keep', audience: 'keep',
    package: 'keep', link: 'keep', template: 'keep', copyJSON: 'keep',
  },
  identity: {
    file: 'keep', duplicate: 'reset', invite: 'keep', reader: 'keep', audience: 'keep',
    package: 'keep', link: 'keep', template: 'keep', copyJSON: 'keep',
  },
  mode: {
    file: 'per-field', duplicate: 'per-field', invite: 'per-field', reader: 'per-field',
    audience: 'per-field', package: 'per-field', link: 'per-field', template: 'per-field',
    copyJSON: 'per-field',
  },
  capability: {
    file: 'keep', duplicate: 'reset', invite: { allowlist: 'invite' }, reader: { allowlist: 'reader' },
    audience: { allowlist: 'audience' }, package: 'drop', link: { allowlist: 'reader' },
    template: 'drop', copyJSON: 'drop',
  },
  history: {
    file: 'keep', duplicate: 'keep', invite: 'keep', reader: 'drop', audience: 'drop',
    package: 'drop', link: 'drop', template: 'drop', copyJSON: 'drop',
  },
}

/** Per-mode-FIELD x per-tier rules — the only place the mode row defers to. The
 *  two mode fields diverge within a tier (a reader copy SETS readonly=true but
 *  keeps template; a template copy is the reverse), which a single mode cell
 *  cannot express. ModeField is DERIVED from these keys (below), so classifying a
 *  third field 'mode' without adding its rules here fails tsc. */
export const MODE_FIELD_RULES = {
  readonly: {
    file: 'keep', duplicate: 'keep', invite: 'drop', reader: { set: true }, audience: { set: true },
    package: { set: true }, link: { set: true }, template: 'keep', copyJSON: 'drop',
  },
  template: {
    file: 'keep', duplicate: 'keep', invite: 'keep', reader: 'keep', audience: 'keep',
    package: 'keep', link: 'keep', template: { set: true }, copyJSON: 'drop',
  },
} satisfies Record<string, Record<Tier, Rule>>

/** The fields that may be classed 'mode' — derived from MODE_FIELD_RULES, not a
 *  hand-written union, so a rule must exist before a field can be a mode field. */
export type ModeField = keyof typeof MODE_FIELD_RULES

/** Unknown / unclassified top-level key: kept only in the file itself and in the
 *  owner's own duplicate; dropped from every outward copy INCLUDING invite (an
 *  invite is a file for another person — a future secret/history-like field must
 *  not ride it). This is the fail-closed default for anything not in the map. */
const UNKNOWN_RULE: Record<Tier, Rule> = {
  file: 'keep', duplicate: 'keep', invite: 'drop', reader: 'drop', audience: 'drop',
  package: 'drop', link: 'drop', template: 'drop', copyJSON: 'drop',
}

/** Extract the field names an app's class map assigns to class C. */
export type FieldsOfClass<M, C extends FieldClass> =
  { [K in keyof M]: M[K] extends C ? K : never }[keyof M]

/** A per-app guard: the fields classed 'mode' must be EXACTLY the kernel's mode
 *  fields (readonly, template). Assign `true` to a value of this type in the app
 *  (const _ok: ModeFieldsOk<AppMap> = true); a third field classed mode, or a
 *  missing one, makes the type a diagnostic string and the assignment fails tsc. */
export type ModeFieldsOk<M> =
  [FieldsOfClass<M, 'mode'>] extends [ModeField]
    ? ([ModeField] extends [FieldsOfClass<M, 'mode'>] ? true
        : 'a kernel mode field is missing from this map')
    : 'a field is classed mode but has no MODE_FIELD_RULES entry'

export interface ProjectOpts {
  /** A freshly-minted invite keypair, required for the invite tier's collab projection. */
  readonly invite?: { role: string }
  /** App projection of a collab block for the audience tier (slides' audience.ts). */
  readonly projectAudience?: (collab: Obj) => Obj
}

/** Build a copy of `doc` for `tier`, FROM EMPTY, using only the rule tables and
 *  the app's class map. A field is carried only if its cell says so; anything not
 *  in `classes` follows UNKNOWN_RULE (fail-closed). Builders must NOT post-edit
 *  identity/mode afterwards — the tables are the single source. */
export function projectForCopy<T extends object>(
  doc: T, classes: Record<string, FieldClass>, tier: Tier, opts: ProjectOpts = {},
): T {
  const src = doc as Obj
  const out: Obj = {}
  for (const key of Object.keys(src)) {
    const v = src[key]
    if (v === undefined) continue
    const cls = classes[key]
    const rule: Rule =
      cls === undefined ? UNKNOWN_RULE[tier]
        : cls === 'mode' ? ((MODE_FIELD_RULES[key as ModeField]?.[tier] as Rule | undefined) ?? UNKNOWN_RULE[tier])
          : (CLASS_RULES[cls][tier] as Rule)
    applyRule(out, key, v, rule, opts)
  }
  return out as T
}

function applyRule(out: Obj, key: string, v: unknown, rule: Rule, opts: ProjectOpts): void {
  if (rule === 'keep') { out[key] = v; return }
  if (rule === 'drop' || rule === 'reset') return // omit; a reset field is re-minted at load / by the builder
  if ('set' in rule) { out[key] = rule.set; return }
  // capability projection via a tier allowlist
  const block = v as Obj
  const projected =
    rule.allowlist === 'reader' ? collabForReader(block)
      : rule.allowlist === 'invite' ? (opts.invite ? collabForInvite(block, opts.invite) : undefined)
        : opts.projectAudience ? opts.projectAudience(block) : undefined
  if (projected !== undefined) out[key] = projected
}

/** Fields that do NOT count as unsaved work (excluded from docContentKey), kept
 *  SEPARATE from any signing-exclusion set: conflating the two silently drops a
 *  field (e.g. a signature) from crash recovery. Apps extend this with their own
 *  bookkeeping fields. Capability fields are already excluded (a key/secret is
 *  not a content edit); everything else — content, history, mode, identity, AND
 *  an unknown field — counts, so recovery is conservative and never loses data. */
export const DEFAULT_NOT_EDIT: ReadonlySet<string> = new Set(['modified', 'preview', 'autosave'])

/** A stable key over the fields that count as unsaved work, for crash-recovery
 *  comparison. ABSENT fields never change the key (skipped, never null-padded),
 *  so a document without a newer field keys identically on an older build. */
export function docContentKey(
  doc: object, classes: Record<string, FieldClass>, notEdit: ReadonlySet<string> = DEFAULT_NOT_EDIT,
): string {
  const src = doc as Obj
  const picked: Obj = {}
  for (const key of Object.keys(src).sort()) {
    if (src[key] === undefined) continue
    if (notEdit.has(key)) continue
    if (classes[key] === 'capability') continue // secrets/keys are not a content edit
    picked[key] = src[key]
  }
  return JSON.stringify(picked)
}

/** The shared version-history entry. `body` is APP-DEFINED (a whole snapshot for
 *  type, a structural patch for spaces); the kernel treats it as opaque. `label`
 *  is OPTIONAL — an app-minted label is frozen in the saver's UI language, so a
 *  summary is DERIVED from the body at render when absent. Lives under
 *  doc.revisions. */
export interface Revision<Body = unknown> {
  readonly id: string
  readonly at: string
  readonly label?: string
  readonly body: Body
}

/** Envelope-only validation (id/at/label?/body present). Body validation is the
 *  app's hook. Call this instead of a bare cast so a malformed entry can't crash
 *  a reader. */
export function validateRevision(x: unknown): x is Revision {
  if (typeof x !== 'object' || x === null) return false
  const r = x as Obj
  return typeof r.id === 'string'
    && typeof r.at === 'string'
    && (r.label === undefined || typeof r.label === 'string')
    && 'body' in r
}
