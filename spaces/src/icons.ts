// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Minimal inline icon set (lucide-style, stroke = currentColor). No deps.
//
// Same construction and stroke weight as slides/src/icons.ts, deliberately:
// two apps in one suite that draw their chrome differently read as two
// products. Not imported from slides — PLATFORM §9 keeps the renderer and
// editor UX per-app, and a shared icon set would drag one app's additions into
// the other's bundle.

const svg = (body: string, viewBox = '0 0 24 24') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`

export const ICONS = {
  search: svg('<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
  save: svg('<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>'),
  info: svg('<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>'),
  help: svg('<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>'),
  menu: svg('<line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/>'),
  plus: svg('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
  grip: svg('<circle cx="9" cy="6" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.4" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="9" cy="18" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="18" r="1.4" fill="currentColor" stroke="none"/>'),
  chevron: svg('<polyline points="9 18 15 12 9 6"/>'),
  page: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>'),
  link: svg('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
  // the OUTWARD link. `link` (the chain) is the page card's mark, and a card
  // that leaves the space has to be told apart from one that stays inside it at
  // a glance in the same menu.
  globe: svg('<circle cx="12" cy="12" r="9"/><path d="M3.2 9h17.6M3.2 15h17.6"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18z"/>'),
  trash: svg('<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'),
  archive: svg('<rect x="2" y="4" width="20" height="5" rx="1"/><path d="M4 9v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9"/><line x1="10" y1="14" x2="14" y2="14"/>'),

  // topbar
  // The suite's undo/redo, character for character from slides. The circular
  // arrows that were here read as "reload", which is a different promise.
  undo: svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
  redo: svg('<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>'),
  print: svg('<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>'),
  panelLeft: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/>'),
  // the same frame with the divider on the other side — the properties panel is
  // the page list's mirror image and its mark says so
  panelRight: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="15" y1="3" x2="15" y2="21"/>'),
  copy: svg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
  markdown: svg('<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 15V9l3 3 3-3v6"/><path d="M16 9v4"/><polyline points="14.5 12.5 16 14 17.5 12.5"/>'),
  lock: svg('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
  chevronDown: svg('<polyline points="6 9 12 15 18 9"/>'),
  eye: svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>'),
  edit: svg('<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/>'),
  canvas: svg('<rect x="2.5" y="4" width="19" height="16" rx="2"/><rect x="5.5" y="7" width="6" height="4.5" rx="1"/><rect x="14" y="12.5" width="5" height="4.5" rx="1"/>'),
  board: svg('<rect x="3" y="4" width="5" height="16" rx="1.5"/><rect x="10" y="4" width="5" height="11" rx="1.5"/><rect x="17" y="4" width="4" height="7" rx="1.5"/>'),
  up: svg('<path d="m18 15-6-6-6 6"/>'),
  down: svg('<path d="m6 9 6 6 6-6"/>'),
  chevronLeft: svg('<path d="m15 18-6-6 6-6"/>'),
  chevronRight: svg('<path d="m9 18 6-6-6-6"/>'),
  widthNarrow: svg('<rect x="8" y="4" width="8" height="16" rx="1.5"/><line x1="3" y1="8" x2="3" y2="16"/><line x1="21" y1="8" x2="21" y2="16"/>'),
  widthWide: svg('<rect x="5" y="4" width="14" height="16" rx="1.5"/><line x1="2" y1="9" x2="2" y2="15"/><line x1="22" y1="9" x2="22" y2="15"/>'),
  widthFull: svg('<rect x="2" y="4" width="20" height="16" rx="1.5"/>'),
  people: svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
  more: svg('<circle cx="12" cy="5" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.6" fill="currentColor" stroke="none"/>'),
  unarchive: svg('<rect x="2" y="4" width="20" height="5" rx="1"/><path d="M4 9v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9"/><polyline points="9 15 12 12 15 15"/><line x1="12" y1="12" x2="12" y2="18"/>'),
  replace: svg('<path d="M14 4h5v5"/><path d="M19 4 5 18"/><path d="M9 4H5v4"/><path d="m15 15 4 4-4 4"/>'),
  arrowUp: svg('<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>'),
  arrowDown: svg('<line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/>'),
  close: svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
  sync: svg('<path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/>'),
  comment: svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),

  // PAGE ICONS — stylised, not colour emoji, so a sidebar of twelve pages
  // reads as one interface rather than a row of stickers.
  book: svg('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>'),
  note: svg('<path d="M15 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9z"/><polyline points="15 3 15 9 21 9"/>'),
  inbox: svg('<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>'),
  star: svg('<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26"/>'),
  folder: svg('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>'),
  tag: svg('<path d="M20.59 13.41 12 22l-9-9V3h10l7.59 7.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>'),
  scale: svg('<path d="M12 3v18"/><path d="M5 7h14"/><path d="M5 7 2 14h6z"/><path d="M19 7l-3 7h6z"/><path d="M8 21h8"/>'),
  pen: svg('<path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><line x1="2" y1="2" x2="9.5" y2="9.5"/>'),
  graph: svg('<circle cx="5" cy="18" r="2.5"/><circle cx="12" cy="5.5" r="2.5"/><circle cx="19" cy="16" r="2.5"/><line x1="6.6" y1="16.1" x2="10.4" y2="7.4"/><line x1="14.2" y1="7.3" x2="17.6" y2="13.6"/><line x1="7.5" y1="17.6" x2="16.5" y2="16.3"/>'),
  compass: svg('<circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88"/>'),
  hash: svg('<line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/>'),

  // block-menu glyphs
  text: svg('<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/>'),
  h1: svg('<path d="M4 4v16M12 4v16M4 12h8"/><path d="M17 9l3-2v13"/>'),
  h2: svg('<path d="M4 4v16M12 4v16M4 12h8"/><path d="M17 8a2.5 2.5 0 1 1 4 2l-4 5h4"/>'),
  h3: svg('<path d="M4 4v16M12 4v16M4 12h8"/><path d="M17 8a2.2 2.2 0 1 1 3 2 2.2 2.2 0 1 1-3 2"/>'),
  bullet: svg('<line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><circle cx="4.5" cy="6" r="1.4" fill="currentColor" stroke="none"/><circle cx="4.5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="4.5" cy="18" r="1.4" fill="currentColor" stroke="none"/>'),
  number: svg('<line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><path d="M4 6h1V3.5"/><path d="M3.5 12.5h2L3.5 15h2"/>'),
  todo: svg('<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>'),
  toggle: svg('<polyline points="9 6 15 12 9 18"/><line x1="19" y1="12" x2="21" y2="12"/>'),
  quote: svg('<path d="M6 17h3l2-4V7H5v6h3zM16 17h3l2-4V7h-6v6h3z"/>'),
  code: svg('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>'),
  divider: svg('<line x1="3" y1="12" x2="21" y2="12"/>'),
  callout: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><line x1="7" y1="5" x2="7" y2="19"/><line x1="11" y1="10" x2="17" y2="10"/><line x1="11" y1="14" x2="15" y2="14"/>'),

  // CALLOUT TONE MARKS — one distinct SILHOUETTE each (circle, bulb, square,
  // triangle, octagon), because the tone must be readable without colour
  // vision and on a black-and-white printout. Hue is decoration here; shape and
  // the spelled-out tone name are what carry the meaning.
  toneNote: svg('<circle cx="12" cy="12" r="9"/><line x1="12" y1="16" x2="12" y2="11"/><line x1="12" y1="8" x2="12.01" y2="8"/>'),
  toneTip: svg('<path d="M9 18h6"/><path d="M10 21.5h4"/><path d="M15.1 14c.2-1 .7-1.7 1.4-2.5A4.7 4.7 0 0 0 18 8a6 6 0 0 0-12 0c0 1 .2 2.2 1.5 3.5.7.8 1.2 1.5 1.4 2.5"/>'),
  toneImportant: svg('<rect x="3" y="3" width="18" height="18" rx="3"/><line x1="12" y1="7.5" x2="12" y2="13"/><line x1="12" y1="16.5" x2="12.01" y2="16.5"/>'),
  toneWarning: svg('<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9.5" x2="12" y2="14"/><line x1="12" y1="17" x2="12.01" y2="17"/>'),
  toneCaution: svg('<polygon points="7.9 2.5 16.1 2.5 21.5 7.9 21.5 16.1 16.1 21.5 7.9 21.5 2.5 16.1 2.5 7.9"/><line x1="12" y1="7.5" x2="12" y2="12.5"/><line x1="12" y1="16" x2="12.01" y2="16"/>'),
  image: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.5-3.5L6 23"/>'),
  table: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="14.5" x2="21" y2="14.5"/><line x1="9.5" y1="9" x2="9.5" y2="20"/>'),
  // ONE glyph for both kinds, because `media` is one block type with a kind.
  // A play triangle in a frame reads as "a thing that plays" for audio as
  // readily as for video; a film reel and a speaker would be two menu entries
  // for one entry's worth of block.
  play: svg('<rect x="2" y="4" width="20" height="16" rx="2.5"/><path d="M10.5 9.2 15 12l-4.5 2.8z" fill="currentColor"/>'),
} as const

export type IconName = keyof typeof ICONS
