// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The glyphs the shared chrome needs — Share, the Save-as list, the language
// menu, the phone fold. The DRAWINGS are slides' (slides/src/icons.ts), so the
// same command wears the same picture in every app; the box is dash's
// (`dx-i`, 15px), so they sit level with the bar's own icons in main.ts.

const svg = (body: string): string =>
  `<svg class="dx-i" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" ` +
  `fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`

export const ICONS = {
  comment: svg('<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>'),
  copy: svg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
  plus: svg('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
  template: svg('<rect x="4" y="4" width="16" height="16" rx="2" stroke-dasharray="3 2.4"/><line x1="12" y1="9" x2="12" y2="15"/><line x1="9" y1="12" x2="15" y2="12"/>'),
  lock: svg('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11 V8 a4 4 0 0 1 8 0 v3"/>'),
  history: svg('<circle cx="12" cy="12" r="8.5"/><polyline points="12 7 12 12 15.5 14"/>'),
  code: svg('<polyline points="8 6 4 12 8 18"/><polyline points="16 6 20 12 16 18"/>'),
  save: svg('<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>'),
  eye: svg('<path d="M2 12 C5 6.5 9 4.5 12 4.5 C15 4.5 19 6.5 22 12 C19 17.5 15 19.5 12 19.5 C9 19.5 5 17.5 2 12 Z"/><circle cx="12" cy="12" r="3"/>'),
  book: svg('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>'),
  people: svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
  share: svg('<circle cx="9" cy="8" r="3.2"/><path d="M3.5 20c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5"/><circle cx="17.5" cy="10.5" r="2.4"/><path d="M15.8 15.6c1.9.3 3.6 1.6 4.4 3.9"/>'),
  broadcast: svg('<path d="M12 20V4"/><path d="M4.5 8.5a11 11 0 0 1 15 0"/><path d="M7.5 12.5a7 7 0 0 1 9 0"/><circle cx="12" cy="20" r="2" fill="currentColor" stroke="none"/>'),
  stop: svg('<rect x="7" y="7" width="10" height="10" rx="1.5"/>'),
  globe: svg('<circle cx="12" cy="12" r="9"/><path d="M3 12 h18"/><ellipse cx="12" cy="12" rx="4.2" ry="9"/>'),
  panelRight: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="15" y1="4" x2="15" y2="20"/>'),
  blank: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><path d="M12 7.6h.01"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
} as const

let descSeq = 0

/**
 * A menu row's label and description (maintainer ruling D2, revised
 * 2026-09-26 — slides' menuLabel): the row is ONE line; the description is the
 * hover tooltip and, since a tooltip is neither announced reliably nor shown on
 * a phone, also the accessible description through a visually hidden node.
 */
export function menuLabel(label: string, desc: string, row: HTMLElement): HTMLSpanElement {
  const span = document.createElement('span')
  span.className = 'dx-mi'
  const name = document.createElement('span')
  name.className = 'dx-mi-name'
  name.textContent = label
  span.append(name)
  if (desc) {
    const note = document.createElement('span')
    note.className = 'dx-sr-only'
    note.textContent = desc
    note.id = `dx-mi-desc-${++descSeq}`
    span.append(note)
    row.title = desc
    row.setAttribute('aria-label', label)
    row.setAttribute('aria-describedby', note.id)
  }
  return span
}
