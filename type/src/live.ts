// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// LIVE CELLS — a number in the prose that is the number in the table.
//
// "Revenue grew to 1,240" and a table three paragraphs down saying 1,310 is the
// oldest defect in business writing, and it is not a typo: the sentence was
// right when it was typed. A live cell is a FIELD (fields.ts) whose value comes
// from a sheet this document already embeds, so the sentence cannot drift from
// the table because it is not a separate copy of the number.
//
// ────────────────────────────────────────────────────────────────────────────
// ADDRESSING BY LABEL, NOT BY CELL
//
// The obvious spelling is `{{sheet:B4}}`, and it is the wrong one. A row
// inserted above B4 silently re-points the sentence at a different number —
// which is the EXACT failure this feature exists to prevent, reintroduced with
// a nicer syntax. Worse, it fails silently and plausibly: the sentence still
// reads as a sentence.
//
// So a live cell is addressed the way a person reads a table: by the row's
// label and the column's heading.
//
//     {{Q3!Revenue}}            row "Q3", column "Revenue"
//     {{Budget!Q3!Revenue}}     ...in the sheet named "Budget"
//
// Insert a row, sort the sheet, add a column — the address still means what it
// meant. It breaks only when the label or heading it names is actually gone,
// which is a real change that SHOULD break, and which surfaces as fields.ts's
// unbound chip rather than as a wrong number.
//
// The row label is the first column's value, which is already this suite's
// convention: merge.ts, and dash's own table→chart bridge, both read column one
// as labels.
//
// `!` is the separator because `:` cannot be one — fields.ts's TOKEN grammar
// spends `:` on zero-padding (`{{page:2}}`) and excludes it from names, so
// `{{sheet:B4}}` does not parse as a field at all. `!` is also what a
// spreadsheet user already reads as "sheet over there".
//
// ────────────────────────────────────────────────────────────────────────────
// WHAT "LIVE" HONESTLY MEANS
//
// It re-resolves from the COPY of the sheet inside this file, not from a
// spreadsheet on anybody's disk. That is not a shortcut, it is the format: a
// Bento document is one self-contained file, an `embed` block carries the whole
// source document with it (embed.ts), and a file that phoned home for a number
// would stop being a document you can email.
//
// The consequence is worth stating plainly wherever this is offered, because
// the wrong belief is the plausible one: the sentence tracks the table IN THIS
// FILE, and updates when the embed is refreshed.
//
// NOT YET SAID ANYWHERE IN THE UI. This module is the resolution layer; a field
// typed as `{{Q3!Revenue}}` works today through fields.ts's ordinary token
// binding, but nothing yet OFFERS live cells or explains that limit. A picker
// that lists the embedded sheets' rows and columns — and carries that sentence
// — is the missing half, and it is deliberately not faked here with a comment
// claiming a function that does not exist.
//
// NOT FORMATTED, deliberately, and for merge.ts's stated reason: the value is
// what the cell holds, never dash's display format. Carrying that formatter
// here would be a second implementation of someone else's rules, wrong the
// first time they change one. A document that needs "$1,200" rather than "1200"
// formats it in the sheet, where the format lives.

import { sourceOfDoc, cellText, type MergeSheet } from './merge.ts';
import { fieldKey, registerCells } from './fields.ts';
import type { Block, TypeDoc } from './model.ts';

/** The separator. See this file's header for why it is not `:`. */
export const SEP = '!';

export interface CellAddress { sheet: string | null; row: string; column: string }

/**
 * Parse a field name as a cell address, or null if it is not one.
 *
 * Two parts mean (row, column) and rely on the document embedding exactly one
 * sheet; three name the sheet as well. Anything else is not an address — and
 * returning null rather than guessing matters, because a plain `{{Name}}` must
 * keep reaching the merge row.
 */
export function parseAddress(name: string): CellAddress | null {
  if (!name.includes(SEP)) return null;
  const parts = name.split(SEP).map(p => p.trim());
  if (parts.some(p => p === '')) return null;
  if (parts.length === 2) return { sheet: null, row: parts[0], column: parts[1] };
  if (parts.length === 3) return { sheet: parts[0], row: parts[1], column: parts[2] };
  return null;
}

/** Every dash sheet this document embeds, in document order. */
export function embeddedSheets(doc: TypeDoc): MergeSheet[] {
  const out: MergeSheet[] = [];
  for (const b of (doc.body ?? []) as Block[]) {
    if (b.kind !== 'embed') continue;
    const e = (b as { embed?: { app?: string; doc?: unknown } }).embed;
    if (!e || e.app !== 'bento/dash') continue;
    const src = sourceOfDoc(e.doc);
    if (src) out.push(...src.sheets);
  }
  return out;
}

/**
 * The value at an address, or null when nothing supplies it.
 *
 * null covers every miss — no such sheet, no such row, no such column, an
 * ambiguous unqualified address — on purpose: fields.ts renders a null as the
 * unbound chip, and one honest "this does not resolve" beats four ways of being
 * subtly wrong. `why` is for the UI to explain WHICH miss, without inventing a
 * second unbound convention.
 */
export function resolveCell(addr: CellAddress, sheets: readonly MergeSheet[]):
  { value: string | null; why: string | null } {
  if (!sheets.length) return { value: null, why: 'no-sheet' };

  let scope = sheets;
  if (addr.sheet !== null) {
    const k = fieldKey(addr.sheet);
    scope = sheets.filter(s => fieldKey(s.name) === k);
    if (!scope.length) return { value: null, why: 'no-sheet' };
  } else if (sheets.length > 1) {
    // An unqualified address with several sheets present is AMBIGUOUS, and
    // silently taking the first would be the same class of bug as a raw cell
    // reference: right until somebody embeds a second sheet, then quietly wrong.
    const hits = sheets.filter(s => findRow(s, addr) !== null);
    if (hits.length > 1) return { value: null, why: 'ambiguous' };
    if (!hits.length) return { value: null, why: 'no-row' };
    scope = hits;
  }

  for (const s of scope) {
    const row = findRow(s, addr);
    if (row === null) continue;
    const ck = fieldKey(addr.column);
    if (!s.columns.some(c => fieldKey(c) === ck)) return { value: null, why: 'no-column' };
    const raw = row[ck];
    return { value: raw === undefined ? null : cellText(raw), why: raw === undefined ? 'no-column' : null };
  }
  return { value: null, why: 'no-row' };
}

/** The row whose FIRST column matches the address's label. */
function findRow(s: MergeSheet, addr: CellAddress): Record<string, string> | null {
  if (!s.columns.length) return null;
  const first = fieldKey(s.columns[0]);
  const want = fieldKey(addr.row);
  for (const r of s.rows) if (fieldKey(r[first] ?? '') === want) return r;
  return null;
}

/** The `cell` resolver fields.ts asks for. */
export function cellResolver(doc: TypeDoc): (name: string) => string | null {
  let sheets: MergeSheet[] | null = null;      // read once per resolution pass
  return (name: string): string | null => {
    const addr = parseAddress(name);
    if (!addr) return null;
    if (sheets === null) sheets = embeddedSheets(doc);
    return resolveCell(addr, sheets).value;
  };
}

// Mounted by registry.ts. See fields.ts registerCells for why this is a
// registration and not an import.
registerCells(cellResolver);
