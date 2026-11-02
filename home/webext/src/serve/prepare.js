// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// bento/connect W2 — deciding whether a file may be served with identity, and
// what the sandbox may turn into running script.
//
// THE RULE (security §16–§18, §2c): identity only where the host SERVES the
// bytes it verified. So the host reads the file itself, gate 1 decides
// (kernel's verifyServed against the held signed histories), and:
//   · GENUINE → served into the extension's sandbox page, where ONLY the
//     executable blocks gate 1's own scanner reported become blob: scripts,
//     spliced by the scanner's own element offsets (Block.tagStart..end) —
//     never a second regex, never a re-serialisation;
//   · UNKNOWN (no single release matches every block, a markup problem, no
//     history held) → never enters the sandbox; the file opens as itself, in
//     a plain file:// tab, without identity.
// The sandbox's FIXED CSP (script-src 'self' blob:, no inline) is the second
// wall: anything the scanner did NOT report stays inline and does not run.

import { verifyServedHeld, scanBlocks, executableScripts } from '../id/gen/gate1.js'

/**
 * `histories` is { appId: history } (serve/history.js heldHistories). Returns
 * { verdict: 'genuine', appId, release, plan } — plan = the executable
 * elements in document order: { tagStart, end, text, module } — or
 * { verdict: 'unknown', reason }.
 */
export async function prepare(html, histories) {
  // kernel's verifyServedHeld: EVERY held history is tried (never one the
  // document names — a fresh shell's document block names no app), and the
  // file is genuine only if exactly one matches
  const held = Object.values(histories ?? {})
  if (!held.length) return { verdict: 'unknown', reason: 'no release history held' }
  const v = await verifyServedHeld(html, held)
  if (v.verdict !== 'genuine') return { verdict: 'unknown', reason: v.reason }
  const plan = executableScripts(scanBlocks(html)).map((b) => ({
    tagStart: b.tagStart, end: b.end, text: b.text, module: (b.type ?? '').toLowerCase() === 'module',
  }))
  return { verdict: 'genuine', appId: v.app, release: v.release, plan }
}

/**
 * The sandbox's splice: each planned element, and ONLY those, replaced by a
 * script loading `urlFor(text, module)` (a blob: URL in the sandbox). Pure.
 * Refuses a plan that isn't in document order, overlaps, or doesn't line up
 * with the html it came with — the plan and the bytes must be the verified pair.
 */
export function splice(html, plan, urlFor) {
  let out = ''
  let at = 0
  for (const p of plan) {
    if (!(Number.isInteger(p.tagStart) && Number.isInteger(p.end) && p.tagStart >= at && p.end > p.tagStart && p.end <= html.length)) throw new Error('the plan does not line up with the file')
    if (!html.slice(p.tagStart, p.end).includes(p.text)) throw new Error('the plan does not line up with the file')
    out += html.slice(at, p.tagStart)
    out += `<script${p.module ? ' type="module"' : ''} src="${urlFor(p.text, p.module)}"></` + 'script>'
    at = p.end
  }
  return out + html.slice(at)
}
