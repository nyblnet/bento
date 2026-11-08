// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// POINT MODE: the text half of "click a cell to put its address in a formula".
//
// Typing `=` and clicking B4 inserts `B4` in Excel, Sheets and Numbers. It is
// the most basic formula gesture there is, and dash committed a literal "="
// instead and moved the cursor (UX review 2.4). The grid owns the gesture —
// which cell was clicked, the range highlight, keeping the editor open — and
// this module owns the two questions that are pure text, so a node rig can
// pin them without a browser:
//
//   acceptsRef   is the caret at a place a reference can go?
//   refText      what does the reference to this rectangle spell?
//
// A REFERENCE CAN GO where the formula is waiting for an operand: straight
// after the leading `=`, an operator, an opening bracket or an argument
// separator. Excel's rule, and the reason it is safe: after `=A1` the caret
// sits after an operand, so a click there must END the edit (commit and move)
// rather than splice a second address onto the first.

import { colToLetters, qualify } from './a1.ts'

/** The characters after which a formula is waiting for an operand. */
const OPERAND_NEXT = new Set(['=', '+', '-', '*', '/', '^', '&', '<', '>', '(', ',', ';', ':'])

/**
 * `before` is the editor's text up to the caret. True when it is a formula
 * (leading `=`) whose last non-blank character asks for an operand, and the
 * caret is not inside a string literal.
 */
export function acceptsRef(before: string): boolean {
  const s = before.replace(/^\s+/, '')
  if (!s.startsWith('=')) return false
  // An odd number of quotes means the caret is inside "a string", where a
  // comma is text, not an argument separator.
  if (((s.match(/"/g) ?? []).length & 1) === 1) return false
  const tail = s.replace(/\s+$/, '')
  return OPERAND_NEXT.has(tail[tail.length - 1])
}

export interface Pos { row: number; col: number }

/** `B4`, or `B4:D9` for a rectangle (normalised top-left first), qualified
 *  with a sheet name when the reference points off the editing sheet. */
export function refText(a: Pos, b: Pos, sheet?: string): string {
  const top = Math.min(a.row, b.row), bottom = Math.max(a.row, b.row)
  const left = Math.min(a.col, b.col), right = Math.max(a.col, b.col)
  const one = (r: number, c: number): string => `${colToLetters(c)}${r + 1}`
  const ref = top === bottom && left === right
    ? one(top, left)
    : `${one(top, left)}:${one(bottom, right)}`
  return qualify(sheet, ref)
}
