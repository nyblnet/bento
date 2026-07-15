// Minimal inline icon set (lucide-style, stroke = currentColor). No deps.

const svg = (body: string, viewBox = '0 0 24 24') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`

export const ICONS = {
  text: svg('<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/>'),
  shapes: svg('<rect x="3" y="3" width="10" height="10" rx="1.5"/><circle cx="16.5" cy="16.5" r="4.5"/>'),
  image: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.5-3.5L6 23"/>'),
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
  // shape menu entries
  rect: svg('<rect x="3" y="5" width="18" height="14" rx="2"/>'),
  ellipse: svg('<ellipse cx="12" cy="12" rx="9" ry="7"/>'),
  triangle: svg('<path d="M12 4 21 20H3z"/>'),
  arrow: svg('<line x1="3" y1="12" x2="19" y2="12"/><polyline points="13 6 19 12 13 18"/>'),
  line: svg('<line x1="4" y1="19" x2="20" y2="5"/>'),
} as const

export type IconName = keyof typeof ICONS
