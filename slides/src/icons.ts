// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Minimal inline icon set (lucide-style, stroke = currentColor). No deps.

const svg = (body: string, viewBox = '0 0 24 24') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`

export const ICONS = {
  text: svg('<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/>'),
  shapes: svg('<rect x="3" y="3" width="10" height="10" rx="1.5"/><circle cx="16.5" cy="16.5" r="4.5"/>'),
  image: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.5-3.5L6 23"/>'),
  media: svg('<rect x="2" y="4" width="20" height="16" rx="2"/><polygon points="10 9 15 12 10 15" fill="currentColor" stroke="none"/>'),
  cursor: svg('<path d="M4 3l7 17 2.5-7.5L21 10z"/>'),
  /** the Select-only tool: a dashed box with a pointer at its corner */
  marquee: svg('<path d="M3 7V4.5A1.5 1.5 0 0 1 4.5 3H7M11 3h3M3 11v3M18 3.5V7"/><path d="M3 18v1.5A1.5 1.5 0 0 0 4.5 21H7"/><path d="M12 12l3.2 8.4 1.4-3.8 3.8-1.4z"/>'),
  pen: svg('<path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.6 7.6"/><circle cx="11" cy="11" r="2"/>'),
  comment: svg('<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>'),
  chart: svg('<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>'),
  undo: svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
  redo: svg('<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>'),
  play: svg('<polygon points="6 3 20 12 6 21 6 3" fill="currentColor" stroke="none"/>'),
  save: svg('<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>'),
  download: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'),
  minus: svg('<line x1="5" y1="12" x2="19" y2="12"/>'),
  more: svg('<circle cx="6" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18" cy="12" r="1.2"/>'),
  rotate: svg('<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>'),
  radius: svg('<path d="M4 20V10a6 6 0 0 1 6-6h10"/>'),
  lineHeight: svg('<path d="M3 4h18"/><path d="M3 20h18"/><path d="M12 8v8"/><path d="m9 11 3-3 3 3"/><path d="m9 13 3 3 3-3"/>'),
  letterSpacing: svg('<path d="M3 4v16"/><path d="M21 4v16"/><path d="m8 15 4-9 4 9"/><path d="M9.5 12h5"/>'),
  fitHeight: svg('<path d="M12 3v18"/><path d="m8 7 4-4 4 4"/><path d="m8 17 4 4 4-4"/><path d="M4 12h16"/>'),
  fontAdd: svg('<path d="M4 20 9.5 5h1L16 20"/><path d="M6.5 14h7"/><path d="M19 3v6"/><path d="M16 6h6"/>'),
  braces: svg('<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1"/><path d="M16 21h1a2 2 0 0 0 2-2v-5a2 2 0 0 1 2-2 2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"/>'),
  palette: svg('<circle cx="13.5" cy="6.5" r="1.5"/><circle cx="17.5" cy="10.5" r="1.5"/><circle cx="8.5" cy="7.5" r="1.5"/><circle cx="6.5" cy="12.5" r="1.5"/><path d="M12 2a10 10 0 0 0 0 20c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1.1.9-2 2-2h2.3A5.6 5.6 0 0 0 22 9.8C22 5.5 17.5 2 12 2z"/>'),
  eyedropper: svg('<path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z"/>'),
  unlink: svg('<path d="m18.84 12.25 1.72-1.71a4.8 4.8 0 0 0-6.79-6.79l-1.72 1.71"/><path d="m5.17 11.75-1.71 1.71a4.8 4.8 0 0 0 6.79 6.79l1.71-1.71"/><line x1="8" y1="2" x2="8" y2="5"/><line x1="2" y1="8" x2="5" y2="8"/><line x1="16" y1="19" x2="16" y2="22"/><line x1="19" y1="16" x2="22" y2="16"/>'),
  blur: svg('<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="7" stroke-dasharray="2 3"/><circle cx="12" cy="12" r="10.5" stroke-dasharray="1 4" opacity=".6"/>'),
  plus: svg('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
  trash: svg('<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'),
  copy: svg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
  front: svg('<rect x="8" y="8" width="12" height="12" rx="2" fill="currentColor" stroke="none" opacity="0.35"/><rect x="4" y="4" width="12" height="12" rx="2"/>'),
  back: svg('<rect x="4" y="4" width="12" height="12" rx="2" fill="currentColor" stroke="none" opacity="0.35"/><rect x="8" y="8" width="12" height="12" rx="2"/>'),
  panelLeft: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="9" y1="4" x2="9" y2="20"/>'),
  panelRight: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="15" y1="4" x2="15" y2="20"/>'),
  pdf: svg('<polyline points="6 9 6 3 18 3 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>'),
  sync: svg('<path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/>'),
  window: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/>'),
  presenter: svg('<rect x="3" y="4" width="18" height="14" rx="2"/><line x1="14" y1="4" x2="14" y2="18"/><line x1="16.5" y1="8" x2="18.5" y2="8"/><line x1="16.5" y1="11" x2="18.5" y2="11"/><line x1="16.5" y1="14" x2="18" y2="14"/><line x1="9" y1="21" x2="15" y2="21"/>'),
  curve: svg('<path d="M3 18 C 7 6, 17 6, 21 18"/>'),
  connector: svg('<circle cx="5" cy="19" r="2.4"/><circle cx="19" cy="5" r="2.4"/><path d="M7 17 L 17 7"/>'),
  curveConnector: svg('<circle cx="5" cy="19" r="2.4"/><circle cx="19" cy="5" r="2.4"/><path d="M7 17 C 9 9, 11 7, 17 7"/>'),
  freeform: svg('<path d="M3 17 C 6 7, 9 21, 12 12 S 18 4, 21 9"/>'),
  polygon: svg('<polygon points="12 3 21 10 17 20 7 20 3 10"/>'),
  slideshow: svg('<rect x="3" y="4" width="18" height="12" rx="2"/><polygon points="10 7.5 15 10 10 12.5" fill="currentColor" stroke="none"/><line x1="12" y1="16" x2="12" y2="20"/><line x1="8" y1="20" x2="16" y2="20"/>'),
  eye: svg('<path d="M2 12 C5 6.5 9 4.5 12 4.5 C15 4.5 19 6.5 22 12 C19 17.5 15 19.5 12 19.5 C9 19.5 5 17.5 2 12 Z"/><circle cx="12" cy="12" r="3"/>'),
  template: svg('<rect x="4" y="4" width="16" height="16" rx="2" stroke-dasharray="3 2.4"/><line x1="12" y1="9" x2="12" y2="15"/><line x1="9" y1="12" x2="15" y2="12"/>'),
  lock: svg('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11 V8 a4 4 0 0 1 8 0 v3"/>'),
  unlock: svg('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11 V8 a4 4 0 0 1 7.5 -2"/>'),
  key: svg('<circle cx="8" cy="16" r="4"/><path d="M11 13 L20 4"/><path d="M15 9 l3 3"/>'),
  live: svg('<circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none"/><path d="M7.5 16.5 a6.4 6.4 0 0 1 0-9"/><path d="M16.5 7.5 a6.4 6.4 0 0 1 0 9"/><path d="M5 19 a10 10 0 0 1 0-14"/><path d="M19 5 a10 10 0 0 1 0 14"/>'),
  broadcast: svg('<path d="M12 20V4"/><path d="M4.5 8.5a11 11 0 0 1 15 0"/><path d="M7.5 12.5a7 7 0 0 1 9 0"/><circle cx="12" cy="20" r="2" fill="currentColor" stroke="none"/>'),
  stop: svg('<rect x="7" y="7" width="10" height="10" rx="1.5"/>'),
  laser: svg('<circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none"/><path d="M12 6V2.5"/><path d="M12 21.5V18"/><path d="M6 12H2.5"/><path d="M21.5 12H18"/><path d="m8.2 8.2-4-4"/><path d="m15.8 15.8 4 4"/><path d="m15.8 8.2 4-4"/><path d="m8.2 15.8-4 4"/>'),
  globe: svg('<circle cx="12" cy="12" r="9"/><path d="M3 12 h18"/><ellipse cx="12" cy="12" rx="4.2" ry="9"/>'),
  code: svg('<polyline points="8 6 4 12 8 18"/><polyline points="16 6 20 12 16 18"/>'),
  history: svg('<circle cx="12" cy="12" r="8.5"/><polyline points="12 7 12 12 15.5 14"/>'),
  exportDoc: svg('<path d="M19 13V8l-5-5H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h7"/><path d="M14 3v5h5"/><path d="M13 17h9"/><path d="m19 14 3 3-3 3"/>'),
  importDoc: svg('<path d="M5 9V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-4"/><path d="M14 3v5h5"/><path d="M2 12h9"/><path d="m8 9 3 3-3 3"/>'),
  share: svg('<circle cx="9" cy="8" r="3.2"/><path d="M3.5 20c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5"/><circle cx="17.5" cy="10.5" r="2.4"/><path d="M15.8 15.6c1.9.3 3.6 1.6 4.4 3.9"/>'),
  table: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="14.5" x2="21" y2="14.5"/><line x1="9" y1="4" x2="9" y2="20"/><line x1="15" y1="4" x2="15" y2="20"/>'),
  // shape menu entries
  rect: svg('<rect x="3" y="5" width="18" height="14" rx="2"/>'),
  ellipse: svg('<ellipse cx="12" cy="12" rx="9" ry="7"/>'),
  triangle: svg('<path d="M12 4 21 20H3z"/>'),
  arrow: svg('<line x1="3" y1="12" x2="19" y2="12"/><polyline points="13 6 19 12 13 18"/>'),
  arrow2: svg('<line x1="5" y1="12" x2="19" y2="12"/><polyline points="13 6 19 12 13 18"/><polyline points="11 6 5 12 11 18"/>'),
  line: svg('<line x1="4" y1="19" x2="20" y2="5"/>'),
  // a group in the layer list: two shapes inside a dashed frame
  group: svg('<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><rect width="7" height="5" x="7" y="7" rx="1"/><rect width="7" height="5" x="10" y="12" rx="1"/>'),
  // the Arrange kit (panels.ts arrangeRows): an edge or axis, and the blocks against it
  ungroup: svg('<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><rect width="5" height="5" x="6" y="6" rx="1"/><rect width="5" height="5" x="13" y="13" rx="1"/>'),
  // vector booleans: two overlapping squares, what each operation keeps filled
  nodeCorner: svg('<path d="M4 20L12 6l8 14"/><rect x="10" y="4" width="4" height="4" fill="currentColor"/>'),
  nodeSmooth: svg('<path d="M3 18c4-12 14-12 18 0"/><circle cx="12" cy="9" r="2" fill="currentColor"/><path d="M5 9h14"/>'),
  nodeSymmetric: svg('<path d="M3 18c4-12 14-12 18 0"/><circle cx="12" cy="9" r="2" fill="currentColor"/><path d="M6 9h12"/><circle cx="6" cy="9" r="1.2"/><circle cx="18" cy="9" r="1.2"/>'),
  closePath: svg('<path d="M5 18L5 6l14 0"/><path d="M19 6L5 18" stroke-dasharray="2 3"/>'),
  boolUnion: svg('<path d="M3 3h12v6h6v12H9v-6H3z" fill="currentColor" stroke-width="1.5"/>'),
  boolSubtract: svg('<path d="M3 3h12v6H9v6H3z" fill="currentColor" stroke-width="1.5"/><rect x="9" y="9" width="12" height="12" stroke-width="1.5" stroke-dasharray="2 2"/>'),
  boolIntersect: svg('<rect x="3" y="3" width="12" height="12" stroke-width="1.5"/><rect x="9" y="9" width="12" height="12" stroke-width="1.5"/><rect x="9" y="9" width="6" height="6" fill="currentColor" stroke="none"/>'),
  boolExclude: svg('<path d="M3 3h12v12H3z M9 9h12v12H9z" fill="currentColor" fill-rule="evenodd" stroke-width="1.5"/>'),
  arrLeft: svg('<path d="M4 3v18"/><rect x="7" y="6" width="12" height="4" rx="1"/><rect x="7" y="14" width="7" height="4" rx="1"/>'),
  arrCenterX: svg('<path d="M12 3v18"/><rect x="5" y="6" width="14" height="4" rx="1"/><rect x="8" y="14" width="8" height="4" rx="1"/>'),
  arrRight: svg('<path d="M20 3v18"/><rect x="5" y="6" width="12" height="4" rx="1"/><rect x="10" y="14" width="7" height="4" rx="1"/>'),
  arrTop: svg('<path d="M3 4h18"/><rect x="6" y="7" width="4" height="12" rx="1"/><rect x="14" y="7" width="4" height="7" rx="1"/>'),
  arrMiddleY: svg('<path d="M3 12h18"/><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="8" width="4" height="8" rx="1"/>'),
  arrBottom: svg('<path d="M3 20h18"/><rect x="6" y="5" width="4" height="12" rx="1"/><rect x="14" y="10" width="4" height="7" rx="1"/>'),
  distX: svg('<path d="M3 4v16"/><path d="M21 4v16"/><rect x="9" y="7" width="6" height="10" rx="1"/>'),
  distY: svg('<path d="M4 3h16"/><path d="M4 21h16"/><rect x="7" y="9" width="10" height="6" rx="1"/>'),
  matchW: svg('<path d="M4 8h16"/><path d="M7 5 4 8l3 3"/><path d="m17 5 3 3-3 3"/><rect x="5" y="14" width="14" height="6" rx="1"/>'),
  matchH: svg('<path d="M8 4v16"/><path d="M5 7l3-3 3 3"/><path d="m5 17 3 3 3-3"/><rect x="14" y="5" width="6" height="14" rx="1"/>'),
  flipH: svg('<path d="M12 3v18"/><path d="M8 7 3 12l5 5z"/><path d="m16 7 5 5-5 5z"/>'),
  flipV: svg('<path d="M3 12h18"/><path d="M7 8l5-5 5 5z"/><path d="m7 16 5 5 5-5z"/>'),
  corners: svg('<path d="M3 9V5a2 2 0 0 1 2-2h4"/><path d="M15 3h4a2 2 0 0 1 2 2v4"/><path d="M21 15v4a2 2 0 0 1-2 2h-4"/><path d="M9 21H5a2 2 0 0 1-2-2v-4"/>'),
  toFront: svg('<rect x="8" y="8" width="12" height="12" rx="1.5" fill="currentColor" fill-opacity=".25"/><path d="M4 16V5a1 1 0 0 1 1-1h11"/>'),
  forward: svg('<path d="M12 19V5"/><path d="m6 11 6-6 6 6"/>'),
  backward: svg('<path d="M12 5v14"/><path d="m6 13 6 6 6-6"/>'),
  toBack: svg('<rect x="4" y="4" width="12" height="12" rx="1.5"/><path d="M20 8v11a1 1 0 0 1-1 1H8" stroke-opacity=".55"/>'),
  indent: svg('<path d="M21 6H11"/><path d="M21 12H11"/><path d="M21 18H11"/><path d="m3 8 4 4-4 4"/>'),
  outdent: svg('<path d="M21 6H11"/><path d="M21 12H11"/><path d="M21 18H11"/><path d="m7 8-4 4 4 4"/>'),
  // text alignment in its box (inspector segmented controls)
  alignLeft: svg('<path d="M21 6H3"/><path d="M15 12H3"/><path d="M17 18H3"/>'),
  alignCenter: svg('<path d="M21 6H3"/><path d="M17 12H7"/><path d="M19 18H5"/>'),
  alignRight: svg('<path d="M21 6H3"/><path d="M21 12H9"/><path d="M21 18H7"/>'),
  valignTop: svg('<path d="M3 3h18"/><rect x="6" y="7" width="12" height="6" rx="1.5"/>'),
  valignMiddle: svg('<path d="M3 12h3"/><path d="M18 12h3"/><rect x="6" y="9" width="12" height="6" rx="1.5"/>'),
  // auto layout frames (layout.ts): row, column, grid
  frameRow: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M9 5v14"/><path d="M15 5v14"/>'),
  frameCol: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/>'),
  frameGrid: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 3v18"/><path d="M3 12h18"/>'),
  gap: svg('<rect x="3" y="6" width="6" height="12" rx="1"/><rect x="15" y="6" width="6" height="12" rx="1"/><path d="M12 9v6"/>'),
  padding: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><rect x="8" y="8" width="8" height="8" rx="1"/>'),
  valignBottom: svg('<path d="M3 21h18"/><rect x="6" y="11" width="12" height="6" rx="1.5"/>'),
  // stroke position: the dashed square is the shape's edge
  strokeInside: svg('<rect x="3" y="3" width="18" height="18" rx="1" stroke-dasharray="2 2" stroke-width="1.5"/><rect x="6.5" y="6.5" width="11" height="11" rx="1" stroke-width="3"/>'),
  strokeCenter: svg('<rect x="3" y="3" width="18" height="18" rx="1" stroke-dasharray="2 2" stroke-width="1.5"/><rect x="3" y="3" width="18" height="18" rx="1" stroke-width="3" stroke-opacity=".55"/>'),
  strokeOutside: svg('<rect x="6.5" y="6.5" width="11" height="11" rx="1" stroke-dasharray="2 2" stroke-width="1.5"/><rect x="2.5" y="2.5" width="19" height="19" rx="2" stroke-width="3"/>'),
  // line style
  lineSolid: svg('<path d="M3 12h18" stroke-width="2.5"/>'),
  lineDashed: svg('<path d="M3 12h18" stroke-width="2.5" stroke-dasharray="5 3" stroke-linecap="butt"/>'),
  lineDotted: svg('<path d="M4 12h17" stroke-width="2.5" stroke-dasharray="0.1 4.4"/>'),
  lineCustom: svg('<path d="M3 12h18" stroke-width="2.5" stroke-dasharray="7 2 1.5 2" stroke-linecap="butt"/>'),
  // chart types (bar is ICONS.chart)
  chartLine: svg('<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="m7 15 4-5 3 3 5-6"/>'),
  chartPie: svg('<path d="M21 12a9 9 0 1 1-9-9v9z"/><path d="M15 3.5A9 9 0 0 1 20.5 9H15z"/>'),
  chartScatter: svg('<path d="M3 3v16a2 2 0 0 0 2 2h16"/><circle cx="9" cy="14" r="1.2" fill="currentColor"/><circle cx="13" cy="9" r="1.2" fill="currentColor"/><circle cx="17" cy="12" r="1.2" fill="currentColor"/><circle cx="18" cy="6" r="1.2" fill="currentColor"/>'),
  // picture fit: the frame, and the picture inside it
  fitContain: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><rect x="3" y="8" width="18" height="8" fill="currentColor" stroke="none" opacity=".45"/>'),
  fitCover: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><rect x="0" y="3" width="24" height="18" fill="currentColor" stroke="none" opacity=".45"/>'),
  fitFill: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><rect x="3" y="3" width="18" height="18" fill="currentColor" stroke="none" opacity=".45"/><path d="m7 7 3 3m7-3-3 3m-7 7 3-3m7 3-3-3"/>'),
  // slide transitions
  transNone: svg('<rect x="2" y="6" width="9" height="12" rx="1"/><rect x="13" y="6" width="9" height="12" rx="1"/>'),
  transFade: svg('<rect x="2" y="6" width="9" height="12" rx="1"/><rect x="13" y="6" width="9" height="12" rx="1" stroke-dasharray="2 2"/>'),
  transPush: svg('<rect x="2" y="6" width="9" height="12" rx="1"/><rect x="13" y="6" width="9" height="12" rx="1"/><path d="m6 12h11m-3-3 3 3-3 3"/>'),
  transZoom: svg('<rect x="3" y="5" width="18" height="14" rx="1"/><rect x="8" y="9" width="8" height="6" rx="1"/><path d="m3 5 5 4m13-4-5 4M3 19l5-4m13 4-5-4"/>'),
  transMorph: svg('<rect x="2" y="13" width="7" height="7" rx="1"/><rect x="13" y="4" width="9" height="9" rx="1"/><path d="M6 11c0-5 3-7 6-7" stroke-dasharray="2 2"/>'),
  // easing curves (time →, progress ↑)
  easeLinear: svg('<path d="M4 20 20 4"/>'),
  easeInOut: svg('<path d="M4 20C12 20 12 4 20 4"/>'),
  easeIn: svg('<path d="M4 20C14 20 20 12 20 4"/>'),
  easeOut: svg('<path d="M4 20C4 12 10 4 20 4"/>'),
  // pan & zoom motion
  kenDrift: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M8 12h8m-2-2 2 2-2 2m-6-4-2 2 2 2"/>'),
  kenOut: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><rect x="8" y="9" width="8" height="6" rx="1"/><path d="m8 9-3-2m11 2 3-2"/>'),
  kenIn: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><rect x="8" y="9" width="8" height="6" rx="1"/><path d="m5 7 3 2m11-2-3 2"/>'),
  // appearance
  sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  moon: svg('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'),
  // entrance effects and directions
  fxNone: svg('<circle cx="12" cy="12" r="8"/><path d="m6.5 17.5 11-11"/>'),
  fxFade: svg('<rect x="4" y="4" width="16" height="16" rx="2" stroke-dasharray="2.5 2.5"/>'),
  fxFly: svg('<rect x="11" y="6" width="10" height="12" rx="1.5"/><path d="M3 9h5M2 12h6M3 15h5"/>'),
  /** auto-layout resizing on an axis (CSS turns them for height): hug the
   *  content, a fixed size, fill the frame */
  sizeHug: svg('<path d="M4 12h5m-2.5-2.5L9 12l-2.5 2.5M20 12h-5m2.5-2.5L15 12l2.5 2.5"/><path d="M12 7v10"/>'),
  sizeFixed: svg('<path d="M5 7v10M19 7v10M5 12h14"/>'),
  sizeFill: svg('<path d="M3 12h18M6 9l-3 3 3 3M18 9l3 3-3 3"/>'),
  /** a panel handle's chevron, pointing right; CSS turns it by data-dir */
  chevron: svg('<path d="m9 6 6 6-6 6"/>'),
  /** Compress pictures: a picture with arrows pressing in */
  compress: svg('<rect x="6" y="6" width="12" height="12" rx="1.5"/><path d="M3 3l3 3M21 3l-3 3M3 21l3-3M21 21l-3-3"/><path d="m9 15 2-2 1.5 1.5L15 12"/>'),
  /** Compact JSON: braces drawn close */
  codeCompact: svg('<path d="M9 5H8a2 2 0 0 0-2 2v3l-2 2 2 2v3a2 2 0 0 0 2 2h1"/><path d="M15 5h1a2 2 0 0 1 2 2v3l2 2-2 2v3a2 2 0 0 1-2 2h-1"/>'),
  /** About: an i in a circle */
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><path d="M12 7.5h.01"/>'),
  /** Preferences: a gear */
  settings: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  /** Keyboard shortcuts */
  keyboard: svg('<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>'),
  /** Help: a question in a circle */
  helpCircle: svg('<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 4.9.8c0 1.7-2.4 2.2-2.4 3.7"/><path d="M12 17h.01"/>'),
  /** Document properties: a page with lines */
  docInfo: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>'),
  dirUp: svg('<path d="M12 19V5m-6 6 6-6 6 6"/>'),
  dirDown: svg('<path d="M12 5v14m-6-6 6 6 6-6"/>'),
  dirLeft: svg('<path d="M19 12H5m6-6-6 6 6 6"/>'),
  dirRight: svg('<path d="M5 12h14m-6-6 6 6-6 6"/>'),
  dirNone: svg('<circle cx="12" cy="12" r="2.5" fill="currentColor"/>'),
  // side column views
  viewSlides: svg('<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8"/><path d="M12 16v4"/>'),
  viewLayers: svg('<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>'),
  // the inspector's tabs: how it looks (sliders), how it moves (a path with
  // its trail), what it does when pointed at (a pointer with a tap ring)
  tabFormat: svg('<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>'),
  tabAnimate: svg('<path d="M3 18c4 0 6-12 11-12"/><circle cx="17.5" cy="6" r="3"/><path d="M3 13h2M3 8h4" opacity=".55"/>'),
  tabInteract: svg('<path d="M9 9l4.5 11 1.6-4.4L20 14z"/><path d="M6.2 6.2a4 4 0 0 1 5.6 0M4.1 4.1a7 7 0 0 1 9.8 0" opacity=".55"/>'),
  viewTokens: svg('<circle cx="7.5" cy="7.5" r="3.5"/><circle cx="16.5" cy="16.5" r="3.5"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/>'),
  swap: svg('<path d="M7 7h13m-3-3 3 3-3 3"/><path d="M17 17H4m3-3-3 3 3 3"/>'),
} as const

export type IconName = keyof typeof ICONS
