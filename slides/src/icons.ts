// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento/Suite authors
// Minimal inline icon set (lucide-style, stroke = currentColor). No deps.

const svg = (body: string, viewBox = '0 0 24 24') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`

export const ICONS = {
  text: svg('<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/>'),
  shapes: svg('<rect x="3" y="3" width="10" height="10" rx="1.5"/><circle cx="16.5" cy="16.5" r="4.5"/>'),
  image: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.5-3.5L6 23"/>'),
  media: svg('<rect x="2" y="4" width="20" height="16" rx="2"/><polygon points="10 9 15 12 10 15" fill="currentColor" stroke="none"/>'),
  comment: svg('<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>'),
  chart: svg('<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>'),
  undo: svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
  redo: svg('<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>'),
  play: svg('<polygon points="6 3 20 12 6 21 6 3" fill="currentColor" stroke="none"/>'),
  save: svg('<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>'),
  download: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'),
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
  freeform: svg('<path d="M3 17 C 6 7, 9 21, 12 12 S 18 4, 21 9"/>'),
  polygon: svg('<polygon points="12 3 21 10 17 20 7 20 3 10"/>'),
  slideshow: svg('<rect x="3" y="4" width="18" height="12" rx="2"/><polygon points="10 7.5 15 10 10 12.5" fill="currentColor" stroke="none"/><line x1="12" y1="16" x2="12" y2="20"/><line x1="8" y1="20" x2="16" y2="20"/>'),
  eye: svg('<path d="M2 12 C5 6.5 9 4.5 12 4.5 C15 4.5 19 6.5 22 12 C19 17.5 15 19.5 12 19.5 C9 19.5 5 17.5 2 12 Z"/><circle cx="12" cy="12" r="3"/>'),
  template: svg('<rect x="4" y="4" width="16" height="16" rx="2" stroke-dasharray="3 2.4"/><line x1="12" y1="9" x2="12" y2="15"/><line x1="9" y1="12" x2="15" y2="12"/>'),
  lock: svg('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11 V8 a4 4 0 0 1 8 0 v3"/>'),
  key: svg('<circle cx="8" cy="16" r="4"/><path d="M11 13 L20 4"/><path d="M15 9 l3 3"/>'),
  live: svg('<circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none"/><path d="M7.5 16.5 a6.4 6.4 0 0 1 0-9"/><path d="M16.5 7.5 a6.4 6.4 0 0 1 0 9"/><path d="M5 19 a10 10 0 0 1 0-14"/><path d="M19 5 a10 10 0 0 1 0 14"/>'),
  stop: svg('<rect x="7" y="7" width="10" height="10" rx="1.5"/>'),
  globe: svg('<circle cx="12" cy="12" r="9"/><path d="M3 12 h18"/><ellipse cx="12" cy="12" rx="4.2" ry="9"/>'),
  code: svg('<polyline points="8 6 4 12 8 18"/><polyline points="16 6 20 12 16 18"/>'),
  history: svg('<circle cx="12" cy="12" r="8.5"/><polyline points="12 7 12 12 15.5 14"/>'),
  share: svg('<circle cx="9" cy="8" r="3.2"/><path d="M3.5 20c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5"/><circle cx="17.5" cy="10.5" r="2.4"/><path d="M15.8 15.6c1.9.3 3.6 1.6 4.4 3.9"/>'),
  table: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="14.5" x2="21" y2="14.5"/><line x1="9" y1="4" x2="9" y2="20"/><line x1="15" y1="4" x2="15" y2="20"/>'),
  // shape menu entries
  rect: svg('<rect x="3" y="5" width="18" height="14" rx="2"/>'),
  ellipse: svg('<ellipse cx="12" cy="12" rx="9" ry="7"/>'),
  triangle: svg('<path d="M12 4 21 20H3z"/>'),
  arrow: svg('<line x1="3" y1="12" x2="19" y2="12"/><polyline points="13 6 19 12 13 18"/>'),
  line: svg('<line x1="4" y1="19" x2="20" y2="5"/>'),
} as const

export type IconName = keyof typeof ICONS
