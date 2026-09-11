// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// What Tab MEANS, and why it sometimes says no.
//
// THE DECISION, so nobody has to re-derive it from the silence.
//
// A space expresses nesting with ONE field: `Block.parent`, pointing at a
// block that precedes it. That is structural — the nested block is a child of
// a real block, and everything downstream reads it as one: the renderer's
// indent, the markdown export's list levels, the outline, the graph, `sync`'s
// per-node diff, "merge back" re-homing orphans. There is no second
// representation and never has been.
//
// So "indent the first item of a list" is not a hard case, it is a case with
// no answer: there is nothing preceding it at the same level to be its parent.
// `editor.ts indent()` walked backwards looking for one, found nothing, and
// returned — correct, and completely silent, which is the bug the maintainer
// hit. A control that does nothing and says nothing is worse than a control
// that is missing, because the reader concludes the app is broken rather than
// that the gesture does not apply.
//
// TWO WAYS OUT, and only one of them is free.
//
//  (a) ALLOW IT, by storing an indent LEVEL — what Google Docs does. This is a
//      format addition, and the format here is additive and PERMANENT: every
//      version from now on opens what this one wrote. It would also be a
//      SECOND way to express nesting, so every reader in the paragraph above
//      has to reconcile two systems and answer questions that currently cannot
//      be asked — what a `level: 2` block with a `parent` means, which wins,
//      what the markdown export emits for an orphan at level 2, what two
//      replicas do when one sets `parent` and the other sets `level`. The cost
//      is not writing the field; it is that it can never be taken back.
//
//  (b) REFUSE, VISIBLY — what Notion, Workflowy, Bear and Logseq all do,
//      because they all nest by parenthood too. The gesture keeps one meaning,
//      the format does not grow, and the fix for the actual complaint is that
//      the refusal now SAYS SO: the editor puts the rule in the status line
//      ("A block nests under the one above it…") and nudges the block, and the
//      indent control in the block menu is disabled with the same reason as
//      its title, so the answer is visible before the key is pressed as well
//      as after.
//
// (b) is what this ships. The deciding argument is the permanence in (a): a
// silent Tab is a bug worth an afternoon, and a duplicate nesting model is a
// bug worth every future version of the reader.
//
// Shift+Tab is unaffected and still outdents by the EFFECTIVE parent.
//
// These functions are pure so the refusal is testable — the failing case is
// the first item, and a happy-path test that indents the SECOND item passes
// against the broken code as readily as against this one.

/** The only two fields nesting is about. */
export interface Nestable { id: string; parent?: string }

export type IndentResult =
  /** Tab applies: `parent` is the block that becomes the owner. */
  | { ok: true; parent: string }
  /** Tab does not apply, and this is what to tell the reader. */
  | { ok: false; why: 'first' | 'gone' }

/**
 * What Tab resolves to for `id` — the nearest PRECEDING block at the same
 * level, which becomes its parent.
 *
 * `why: 'first'` means there is no such block: `id` is the first at its level,
 * so there is nothing to nest under. `why: 'gone'` means `id` is not in the
 * page at all, which is a caller bug rather than a refusal a reader should see.
 */
export function indentTarget(blocks: readonly Nestable[], id: string): IndentResult {
  const i = blocks.findIndex((b) => b.id === id)
  if (i < 0) return { ok: false, why: 'gone' }
  const me = blocks[i]
  for (let j = i - 1; j >= 0; j--) {
    if (blocks[j].parent === me.parent) return { ok: true, parent: blocks[j].id }
  }
  return { ok: false, why: 'first' }
}

/**
 * Can `id` be outdented?
 *
 * By the EFFECTIVE parent map (model.ts `effectiveParents`), never by whatever
 * `parent` names: on a merged document `parent` can point at a block that is
 * absent or that sits later, and the renderer does not nest by those either.
 * Passed in rather than computed so this stays pure and so the editor computes
 * the map once.
 */
export function canOutdent(effective: ReadonlyMap<string, string | undefined>, id: string): boolean {
  return effective.get(id) !== undefined
}
