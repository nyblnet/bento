// The Bento Slides document model. This JSON is what lives inside the
// <script type="application/bento+json"> block of a .bento.html file.

export const FORMAT = 'bento/slides'
export const FORMAT_VERSION = 1

export type TransitionKind = 'none' | 'fade' | 'slide' | 'zoom' | 'morph'

export interface ElementBase {
  /** Stable id. Elements sharing an id across adjacent slides morph into each other. */
  id: string
  x: number
  y: number
  w: number
  h: number
  /** degrees, clockwise */
  rotation: number
  opacity: number
  /** presentation effects, run in present mode only */
  fx?: {
    /** entrance animation when the slide is shown */
    enter?: 'fade-up' | 'fade'
    /** stagger position within the slide's entrance sequence */
    order?: number
    /** animate numeric parts of the text from 0 to their final value */
    countUp?: boolean
    /** continuous ambient motion (slow zoom, for full-bleed photos) */
    ambient?: 'kenburns'
  }
  /** while presenting, clicking this element jumps to the slide with this id */
  link?: string
}

export interface TextElement extends ElementBase {
  type: 'text'
  /** Rich text as sanitized inline HTML (b/i/u/br/span only). */
  html: string
  fontSize: number
  fontFamily: string
  fontWeight: number
  color: string
  align: 'left' | 'center' | 'right'
  valign: 'top' | 'middle' | 'bottom'
  lineHeight: number
  /** px; optional tracking for letter-spaced caps labels */
  letterSpacing?: number
}

export type ShapeKind = 'rect' | 'ellipse' | 'triangle' | 'arrow' | 'line'

export interface ShapeElement extends ElementBase {
  type: 'shape'
  shape: ShapeKind
  fill: string
  stroke: string
  strokeWidth: number
  /** corner radius, rect only */
  radius: number
  /** dash length in px; 0/undefined = solid stroke */
  strokeDash?: number
}

export interface ImageElement extends ElementBase {
  type: 'image'
  /** data: URI — Bento files embed all assets */
  src: string
  fit: 'contain' | 'cover' | 'fill'
  radius: number
}

export type SlideElement = TextElement | ShapeElement | ImageElement

export interface Slide {
  id: string
  background: string
  transition: TransitionKind
  elements: SlideElement[]
  notes: string
}

export interface BentoDoc {
  format: typeof FORMAT
  version: number
  title: string
  /** slide coordinate space, px */
  size: { width: number; height: number }
  theme: {
    background: string
    color: string
    accent: string
    fontFamily: string
  }
  /** present-mode chrome; decks with built-in chrome can turn Reveal's off */
  present?: {
    slideNumber?: boolean
    controls?: boolean
    progress?: boolean
  }
  slides: Slide[]
  modified: string
}

let counter = 0
export const uid = (prefix = 'el') =>
  `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`

export const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"

export function defaultText(partial: Partial<TextElement> = {}): TextElement {
  return {
    id: uid('t'),
    type: 'text',
    x: 340, y: 300, w: 600, h: 120,
    rotation: 0, opacity: 1,
    html: 'Double-click to edit',
    fontSize: 32,
    fontFamily: FONT_STACK,
    fontWeight: 400,
    color: '#1E2A3A',
    align: 'center',
    valign: 'middle',
    lineHeight: 1.25,
    ...partial,
  }
}

export function defaultShape(shape: ShapeKind, partial: Partial<ShapeElement> = {}): ShapeElement {
  return {
    id: uid('s'),
    type: 'shape',
    shape,
    x: 490, y: 260, w: 300, h: 200,
    rotation: 0, opacity: 1,
    fill: '#F7A600',
    stroke: 'transparent',
    strokeWidth: 0,
    radius: shape === 'rect' ? 12 : 0,
    ...partial,
  }
}

export function defaultImage(src: string, partial: Partial<ImageElement> = {}): ImageElement {
  return {
    id: uid('i'),
    type: 'image',
    x: 440, y: 210, w: 400, h: 300,
    rotation: 0, opacity: 1,
    src,
    fit: 'contain',
    radius: 0,
    ...partial,
  }
}

export function emptySlide(partial: Partial<Slide> = {}): Slide {
  return {
    id: uid('slide'),
    background: '#FFFFFF',
    transition: 'fade',
    elements: [],
    notes: '',
    ...partial,
  }
}

export function newDoc(): BentoDoc {
  return {
    format: FORMAT,
    version: FORMAT_VERSION,
    title: 'Untitled',
    size: { width: 1280, height: 720 },
    theme: {
      background: '#FFFFFF',
      color: '#1E2A3A',
      accent: '#F7A600',
      fontFamily: FONT_STACK,
    },
    slides: [emptySlide()],
    modified: new Date().toISOString(),
  }
}

export function parseDoc(json: string): BentoDoc | null {
  try {
    const doc = JSON.parse(json)
    if (doc && doc.format === FORMAT && Array.isArray(doc.slides) && doc.slides.length > 0) {
      return doc as BentoDoc
    }
  } catch {
    /* fall through */
  }
  return null
}

// ---------------------------------------------------------------------------
// Starter deck — what a freshly built Bento Slides file opens with. It doubles
// as the feature demo: the amber circle and the title share ids across slides,
// so 'morph' transitions animate them PowerPoint-Morph style.
// ---------------------------------------------------------------------------

export function starterDoc(): BentoDoc {
  const ink = '#1E2A3A'
  const amber = '#F7A600'
  const blue = '#5B8DEF'
  const doc = newDoc()
  doc.title = 'Welcome to Bento Slides'

  const heroCircle = 'demo-circle'
  const heroTitle = 'demo-title'
  const chipBlue = 'demo-chip'

  doc.slides = [
    {
      id: uid('slide'),
      background: ink,
      transition: 'fade',
      notes:
        'This whole deck lives inside one HTML file — data, viewer and editor together. Press Escape to go back to editing.',
      elements: [
        {
          ...defaultShape('ellipse'),
          id: heroCircle,
          x: 1020, y: 480, w: 180, h: 180,
          fill: amber,
        },
        {
          ...defaultShape('rect'),
          id: chipBlue,
          x: 80, y: 520, w: 56, h: 120, radius: 14, fill: blue,
        },
        {
          ...defaultText({}),
          id: heroTitle,
          x: 140, y: 240, w: 1000, h: 130,
          html: 'Bento Slides',
          fontSize: 88, fontWeight: 700, color: '#FFFFFF', align: 'left',
        },
        {
          ...defaultText({}),
          x: 144, y: 380, w: 820, h: 60,
          html: 'A presentation that <b>is</b> its own app — one file, opens anywhere.',
          fontSize: 26, color: '#B9C4D4', align: 'left',
        },
      ],
    },
    {
      id: uid('slide'),
      background: '#FFFFFF',
      transition: 'morph',
      notes:
        'Morph in action: the circle, title and blue chip carry the same element ids as slide 1, so GSAP Flip animates them between slides.',
      elements: [
        {
          ...defaultShape('ellipse'),
          id: heroCircle,
          x: -160, y: -200, w: 560, h: 560,
          fill: amber, opacity: 0.92,
        },
        {
          ...defaultShape('rect'),
          id: chipBlue,
          x: 80, y: 588, w: 340, h: 52, radius: 26, fill: blue,
        },
        {
          ...defaultText({}),
          id: heroTitle,
          x: 460, y: 90, w: 740, h: 80,
          html: 'One file. Everything inside.',
          fontSize: 52, fontWeight: 700, color: ink, align: 'left',
        },
        {
          ...defaultText({}),
          x: 460, y: 210, w: 720, h: 300,
          html:
            '• The document data is embedded as JSON<br>• Viewer, presenter and editor ship in the same file<br>• Saving rewrites the file itself — no server, no install<br>• Images embed as data URIs, fonts stay local',
          fontSize: 28, color: ink, align: 'left', valign: 'top', lineHeight: 1.7,
        },
        {
          ...defaultText({}),
          x: 96, y: 598, w: 310, h: 36,
          html: 'try pressing ← to morph back',
          fontSize: 17, color: '#FFFFFF', fontWeight: 600,
        },
      ],
    },
    {
      id: uid('slide'),
      background: '#F5F7FA',
      transition: 'morph',
      notes: 'Everything on this slide was made with the built-in editor: drag, resize, rotate, snap.',
      elements: [
        {
          ...defaultShape('ellipse'),
          id: heroCircle,
          x: 1100, y: -70, w: 140, h: 140, fill: amber,
        },
        {
          ...defaultText({}),
          id: heroTitle,
          x: 80, y: 70, w: 900, h: 70,
          html: 'Edit like a native app',
          fontSize: 44, fontWeight: 700, color: ink, align: 'left',
        },
        {
          ...defaultShape('rect'),
          x: 80, y: 200, w: 350, h: 330, fill: '#FFFFFF', stroke: '#E3E8EF', strokeWidth: 1.5, radius: 16,
        },
        {
          ...defaultText({}),
          x: 104, y: 230, w: 300, h: 260,
          html: '<b>Direct manipulation</b><br><br>Drag, resize and rotate with snap guides. Double-click any text to type.',
          fontSize: 22, color: ink, align: 'left', valign: 'top', lineHeight: 1.5,
        },
        {
          ...defaultShape('rect'),
          x: 465, y: 200, w: 350, h: 330, fill: '#FFFFFF', stroke: '#E3E8EF', strokeWidth: 1.5, radius: 16,
        },
        {
          ...defaultText({}),
          x: 489, y: 230, w: 300, h: 260,
          html: '<b>Shapes, text, images</b><br><br>Insert from the toolbar. Images are embedded into the file, so it never breaks.',
          fontSize: 22, color: ink, align: 'left', valign: 'top', lineHeight: 1.5,
        },
        {
          ...defaultShape('rect'),
          x: 850, y: 200, w: 350, h: 330, fill: ink, radius: 16,
        },
        {
          ...defaultText({}),
          x: 874, y: 230, w: 300, h: 260,
          html: '<b>Undo everything</b><br><br>Full undo/redo history, keyboard shortcuts, and ⌘S saves the file itself.',
          fontSize: 22, color: '#FFFFFF', align: 'left', valign: 'top', lineHeight: 1.5,
        },
        {
          ...defaultShape('arrow'),
          x: 80, y: 580, w: 220, h: 60, fill: amber,
        },
        {
          ...defaultText({}),
          x: 320, y: 590, w: 500, h: 40,
          html: 'This deck is editable — press Esc and try it',
          fontSize: 20, color: '#5B6472', align: 'left',
        },
      ],
    },
    {
      id: uid('slide'),
      background: ink,
      transition: 'morph',
      notes:
        'Reveal.js drives presentation: keyboard and swipe navigation, overview mode, speaker notes. GSAP Flip powers the morphs.',
      elements: [
        {
          ...defaultShape('ellipse'),
          id: heroCircle,
          x: 550, y: 470, w: 190, h: 190, fill: blue,
        },
        {
          ...defaultText({}),
          id: heroTitle,
          x: 140, y: 120, w: 1000, h: 150,
          html: 'Present with Reveal.js,<br>morph with GSAP Flip',
          fontSize: 54, fontWeight: 700, color: '#FFFFFF', align: 'center', lineHeight: 1.2,
        },
        {
          ...defaultText({}),
          x: 240, y: 330, w: 800, h: 90,
          html: 'Elements that share an id morph between slides —<br>position, size, colour and rotation animate automatically.',
          fontSize: 24, color: '#B9C4D4', lineHeight: 1.5,
        },
      ],
    },
    {
      id: uid('slide'),
      background: '#FFFFFF',
      transition: 'zoom',
      notes: 'Docs and Sheets follow the same recipe: one self-contained HTML file per document, built on best-of-breed open-source libraries.',
      elements: [
        {
          ...defaultText({}),
          x: 140, y: 150, w: 1000, h: 80,
          html: 'Where this goes next',
          fontSize: 48, fontWeight: 700, color: ink,
        },
        {
          ...defaultShape('rect'),
          x: 200, y: 300, w: 260, h: 180, fill: '#FDF1DC', radius: 16,
        },
        {
          ...defaultText({}),
          x: 200, y: 350, w: 260, h: 80,
          html: '<b>Slides</b><br>you are here',
          fontSize: 24, color: ink, lineHeight: 1.4,
        },
        {
          ...defaultShape('rect'),
          x: 510, y: 300, w: 260, h: 180, fill: '#EDF2FD', radius: 16,
        },
        {
          ...defaultText({}),
          x: 510, y: 350, w: 260, h: 80,
          html: '<b>Docs</b><br>next up',
          fontSize: 24, color: ink, lineHeight: 1.4,
        },
        {
          ...defaultShape('rect'),
          x: 820, y: 300, w: 260, h: 180, fill: '#EAF7EF', radius: 16,
        },
        {
          ...defaultText({}),
          x: 820, y: 350, w: 260, h: 80,
          html: '<b>Sheets</b><br>after that',
          fontSize: 24, color: ink, lineHeight: 1.4,
        },
        {
          ...defaultText({}),
          x: 240, y: 560, w: 800, h: 50,
          html: 'One format idea, three apps: <b>the file is the software.</b>',
          fontSize: 26, color: '#5B6472',
        },
      ],
    },
  ]
  return doc
}
