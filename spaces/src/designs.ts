// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Page designs: the author's choice of how the reading surface looks.
//
// THE RULING THIS IMPLEMENTS (docs/DECISIONS.md, 2026-09-26). The author picks
// the design; the reader's light/dark setting picks between the design's two
// palettes; the app chrome stays the reader's. That reverses the 2026-08-22
// entry that made the reading surface chrome, and puts spaces where slides
// already was — a slide's background has always been document data.
//
// A DESIGN IS DATA, NOT A STYLESHEET. Every design, built in or carried by a
// document, is the same shape: two palettes, four font roles and a closed set
// of switches. ONE base stylesheet (designs.css) reads the custom properties
// and data attributes this module writes, so adding a built-in is a data entry
// here and never new CSS. When a look needs structure the tokens cannot
// express, the answer is a new SWITCH that every design can use — not a
// bespoke sheet for one of them.
//
// VALIDATED, NOT SANITIZED. A document can carry its own designs
// (`doc.designs`), and every value in one is checked against a closed rule
// before it goes anywhere near a style: a colour must be a hex colour, a
// number must sit in its range, a switch must be one of its words, a font must
// be a name from FONT_STACKS or an embedded font asset. Anything else is
// DROPPED to the base design's value and named by validate(). No author text
// ever becomes CSS — the stacks are this file's own strings, the numbers are
// numbers, and the words are attribute values the stylesheet matches exactly.
//
// RAW AUTHOR CSS DOES NOT SHIP. The security review of 2026-09-26 kept custom
// designs token-only: a stylesheet in a mailed file can fetch (tracking) and
// can overlay Save or the password gate. If that is ever revisited it arrives
// as its own field with its own sanitizer and review — never through this
// module, whose whole guarantee is that nothing here is free text.
//
// PURE AT MODULE LEVEL, DOM ONLY IN FUNCTIONS. scripts/test-spaces-model.ts
// imports this in node, so nothing here may touch `document` at import time,
// and imports carry `.ts` extensions.

import type { SpacesDoc } from './model.ts'

// ---- the shape ---------------------------------------------------------------

/** Colour roles. Every palette names all of them. */
export const PALETTE_KEYS = [
  'paper', 'ink', 'muted', 'rule', 'soft',
  'accent', 'accentInk', 'onAccent',
  'tile', 'tileInk', 'cell1', 'cell2', 'cell3',
  'toneNote', 'toneTip', 'toneImportant', 'toneWarning', 'toneCaution',
] as const
export type PaletteKey = (typeof PALETTE_KEYS)[number]
export type Palette = Record<PaletteKey, string>

/**
 * The five callout tones are PALETTE ROLES, one colour each, per mode.
 *
 * TONE IS MEANING: a warning must not look like a tip. The first cut had a
 * `tones: accent` switch that gave all five the design's one colour — and
 * Studio, Almanac and Typescript drew five identical boxes, the Note reading
 * "the blue one" in coral. So each design now names five hues of its own
 * character, and the validator holds them pairwise apart (TONE_MIN_DISTANCE).
 */
export const TONE_KEYS = ['toneNote', 'toneTip', 'toneImportant', 'toneWarning', 'toneCaution'] as const
type ToneKey = (typeof TONE_KEYS)[number]
/** styles.css's own tone hues — the default a design inherits unless it names its own */
const APP_TONES: Record<ToneKey, string> = {
  toneNote: '#7d9cbd', toneTip: '#4f9e79', toneImportant: '#8a72cc', toneWarning: '#d9a326', toneCaution: '#cd6a63',
}
type PaletteIn = Omit<Palette, ToneKey> & Partial<Pick<Palette, ToneKey>>
const pal = (p: PaletteIn): Palette => ({ ...APP_TONES, ...p })

/** Where a face is used: titles and headings, prose, labels, code/numerals. */
export const FONT_ROLES = ['display', 'body', 'label', 'mono'] as const
export type FontRole = (typeof FONT_ROLES)[number]

/**
 * The font NAME LIST. A design names one of these, or an embedded font asset.
 *
 * SYSTEM STACKS ONLY: nothing can be fetched at runtime (PLATFORM §1), and a
 * real face would travel inside every file. Whether the built-ins ever ship
 * their intended faces is the maintainer's call (DECISIONS, 2026-09-26); until
 * then each stack reaches for the closest face a reader's machine already has.
 */
export const FONT_STACKS: Readonly<Record<string, string>> = {
  system: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  grotesk: "'Helvetica Neue', Helvetica, Arial, 'Liberation Sans', sans-serif",
  humanist: "'Avenir Next', Avenir, 'Segoe UI', 'Trebuchet MS', system-ui, sans-serif",
  condensed: "'Avenir Next Condensed', 'DIN Condensed', 'Arial Narrow', 'Roboto Condensed', sans-serif",
  transitional: "Charter, 'Bitstream Charter', 'Sitka Text', Cambria, Georgia, serif",
  oldstyle: "'Iowan Old Style', 'Palatino Linotype', Palatino, 'Book Antiqua', Georgia, serif",
  news: "Georgia, 'Times New Roman', Times, 'Liberation Serif', serif",
  mono: "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
  typewriter: "'American Typewriter', 'Courier Prime', 'Courier New', Courier, monospace",
  rounded: "ui-rounded, 'SF Pro Rounded', 'Arial Rounded MT Bold', system-ui, sans-serif",
}

type NumRule = { kind: 'num'; min: number; max: number; unit: string }
type EnumRule = { kind: 'enum'; values: readonly string[] }
const num = (min: number, max: number, unit = ''): NumRule => ({ kind: 'num', min, max, unit })
const oneOf = (...values: string[]): EnumRule => ({ kind: 'enum', values })

/**
 * Every switch and metric a design may set, with the ONLY values it may take.
 *
 * Numbers become custom properties (`--d-<name>`); words become data
 * attributes (`data-sd-<name>`) that designs.css matches exactly. Adding a
 * switch = a row here + the rules that read it in designs.css + its labels in
 * designpanel.ts. Nothing else.
 */
export const PROPS = {
  size: num(0.85, 1.25),
  leading: num(1.3, 2),
  titleSize: num(1.4, 4, 'em'),
  titleWeight: num(300, 900),
  titleTracking: num(-0.06, 0.04, 'em'),
  titleLeading: num(0.85, 1.4),
  headWeight: num(300, 900),
  radius: num(0, 24, 'px'),
  rule: num(1, 4, 'px'),
  headStyle: oneOf('normal', 'italic'),
  headCase: oneOf('none', 'upper'),
  label: oneOf('plain', 'caps', 'smallcaps', 'italic'),
  labelInk: oneOf('ink', 'accent'),
  h2: oneOf('none', 'above', 'double', 'bar', 'under'),
  dropCap: oneOf('off', 'on'),
  callout: oneOf('tint', 'outline', 'rules', 'fill', 'shadow'),
  quote: oneOf('plain', 'bar', 'display', 'pull', 'tile', 'indent'),
  table: oneOf('grid', 'rules', 'bands'),
  numerals: oneOf('lining', 'mono', 'oldstyle'),
  check: oneOf('native', 'square', 'round'),
  tile: oneOf('off', 'on'),
  shadow: oneOf('none', 'hard'),
  justify: oneOf('off', 'on'),
  divider: oneOf('rule', 'ink', 'double', 'asterism', 'short'),
  bullet: oneOf('disc', 'dash', 'square'),
} as const satisfies Record<string, NumRule | EnumRule>

export type PropKey = keyof typeof PROPS
export const PROP_KEYS = Object.keys(PROPS) as PropKey[]
type PropValue<K extends PropKey> = (typeof PROPS)[K] extends NumRule ? number
  : (typeof PROPS)[K] extends { values: readonly (infer V)[] } ? V : never
export type Props = { [K in PropKey]: PropValue<K> }

/** A fully resolved design: every value present and valid. */
export interface Design {
  light: Palette
  dark: Palette
  /** a FONT_STACKS name, or `asset:<key>` for a face embedded in the file */
  fonts: Record<FontRole, string>
  props: Props
}

/**
 * What a document carries in `doc.designs[name]`: overrides on a base.
 *
 * Only what differs from the base is stored, so a document stays small and a
 * built-in's later refinements still reach a fork of it. Unknown keys survive
 * untouched (format additivity) and are ignored here.
 */
export interface DesignData {
  label?: string
  /** a built-in name; absent = the default look expressed as a design */
  base?: string
  light?: Partial<Palette>
  dark?: Partial<Palette>
  fonts?: Partial<Record<FontRole, string>>
  props?: Partial<Props>
  [extra: string]: unknown
}

// ---- the built-ins -----------------------------------------------------------

/**
 * The default look, expressed as a design.
 *
 * NOT SELECTABLE and never written as `design:` — the default is the ABSENCE
 * of the key, which renders the untouched stylesheet byte for byte. This is
 * only the base a custom design starts from when it names no built-in, so a
 * fork of "no design" begins where the reader already was. Its values are
 * styles.css's own light and dark tokens.
 */
export const PLAIN: Design = {
  light: pal({
    paper: '#ffffff', ink: '#1e2a3a', muted: '#5b6472', rule: '#e3e8ef', soft: '#f5f7fa',
    accent: '#f7a600', accentInk: '#7a5200', onAccent: '#1e2a3a',
    tile: '#1e2a3a', tileInk: '#ffffff', cell1: '#3b6fd4', cell2: '#f7a600', cell3: '#eceff4',
  }),
  dark: pal({
    paper: '#14181e', ink: '#e7eaf0', muted: '#8b95a4', rule: '#2e353f', soft: '#1e232b',
    accent: '#f7a600', accentInk: '#f0b74e', onAccent: '#1e2a3a',
    tile: '#0d1015', tileInk: '#e7eaf0', cell1: '#3b6fd4', cell2: '#f7a600', cell3: '#272d36',
  }),
  fonts: { display: 'system', body: 'system', label: 'system', mono: 'mono' },
  props: {
    size: 1, leading: 1.65, titleSize: 2.06, titleWeight: 700, titleTracking: -0.02, titleLeading: 1.18,
    headWeight: 700, radius: 10, rule: 1,
    headStyle: 'normal', headCase: 'none', label: 'plain', labelInk: 'ink', h2: 'none', dropCap: 'off',
    callout: 'tint', quote: 'plain', table: 'grid', numerals: 'lining', check: 'native', tile: 'off',
    shadow: 'none', justify: 'off', divider: 'rule', bullet: 'disc',
  },
}

const make = (over: { light: PaletteIn; dark: PaletteIn; fonts: Design['fonts']; props: Partial<Props> }): Design =>
  ({ ...over, light: pal(over.light), dark: pal(over.dark), props: { ...PLAIN.props, ...over.props } })

/**
 * The built-in designs. Each is defensible from a real publishing tradition,
 * and each differs in STRUCTURE, not only in palette.
 *
 * ORDER IS THE PICKER'S ORDER. Names are permanent once a file says them.
 */
export const BUILT_INS: Readonly<Record<string, Design>> = {
  // LEDGER — the financial report and the Swiss grid: a grotesque, numbers as
  // first-class citizens in a monospace, heavy rules above sections, cobalt as
  // the single signal colour, square corners everywhere.
  ledger: make({
    light: {
      paper: '#f7f8fa', ink: '#111418', muted: '#5a616c', rule: '#d5d9e0', soft: '#eceef3',
      accent: '#2743d6', accentInk: '#2743d6', onAccent: '#ffffff',
      tile: '#111418', tileInk: '#f7f8fa', cell1: '#2743d6', cell2: '#d5d9e0', cell3: '#eceef3',
    },
    dark: {
      paper: '#0e1116', ink: '#e8eaee', muted: '#9199a6', rule: '#262c36', soft: '#171b22',
      accent: '#8492ff', accentInk: '#9aa6ff', onAccent: '#0e1116',
      tile: '#050608', tileInk: '#e8eaee', cell1: '#8492ff', cell2: '#262c36', cell3: '#171b22',
    },
    fonts: { display: 'grotesk', body: 'grotesk', label: 'mono', mono: 'mono' },
    props: {
      titleSize: 3.1, titleWeight: 800, titleTracking: -0.035, titleLeading: 0.98, headWeight: 750,
      radius: 0, rule: 2, label: 'caps', labelInk: 'accent', h2: 'above', callout: 'outline',
      quote: 'bar', table: 'rules', numerals: 'mono', check: 'square', divider: 'ink', bullet: 'square',
    },
  }),
  // ALMANAC — the literary quarterly and the seed catalogue: an old-style
  // serif set large, italic heads with a short rule under them, a drop cap on
  // the opening paragraph, and marigold as the one accent. The callout tones
  // keep five hues of their own, in the same earthy register.
  almanac: make({
    light: {
      paper: '#edf0e7', ink: '#1c2a21', muted: '#56645a', rule: '#cdd4c4', soft: '#e2e7da',
      // #b07800, not the specimen's #c98a0b: the drop cap and a done box are
      // marks that carry meaning, and #c98a0b was 2.56:1 on this paper
      accent: '#b07800', accentInk: '#7f5600', onAccent: '#0f1510',
      tile: '#1c2a21', tileInk: '#edf0e7', cell1: '#b07800', cell2: '#cdd4c4', cell3: '#e2e7da',
      // an editorial set around the marigold: slate, sage, plum, marigold, rust
      toneNote: '#5f7f8c', toneTip: '#6b8f4e', toneImportant: '#8a6a9a', toneWarning: '#b07800', toneCaution: '#b0503a',
    },
    dark: {
      paper: '#141a16', ink: '#e3e8dd', muted: '#a1ad9f', rule: '#2c3730', soft: '#1b231e',
      accent: '#e4b04a', accentInk: '#edc574', onAccent: '#141a16',
      tile: '#0b0f0c', tileInk: '#e3e8dd', cell1: '#e4b04a', cell2: '#2c3730', cell3: '#1b231e',
      toneNote: '#8fb0bc', toneTip: '#9cc07c', toneImportant: '#b89ac8', toneWarning: '#e4b04a', toneCaution: '#e0806a',
    },
    fonts: { display: 'oldstyle', body: 'transitional', label: 'transitional', mono: 'mono' },
    props: {
      size: 1.09, leading: 1.6, titleSize: 3.2, titleWeight: 500, titleTracking: -0.02, titleLeading: 1,
      headWeight: 500, radius: 2, headStyle: 'italic', label: 'caps', labelInk: 'accent', h2: 'bar',
      dropCap: 'on', callout: 'rules', quote: 'display', table: 'rules', numerals: 'oldstyle',
      check: 'round', divider: 'short',
    },
  }),
  // STUDIO — the Bento mark as layout grammar: a navy tile holding slate,
  // coral and cream compartments. A canvas and a gallery become that tile;
  // a quote is a navy card; a callout is a filled compartment.
  studio: make({
    light: {
      paper: '#ffffff', ink: '#16273e', muted: '#566781', rule: '#dde3ec', soft: '#f0ebe0',
      accent: '#ff9e8a', accentInk: '#b84a34', onAccent: '#16273e',
      tile: '#16273e', tileInk: '#f0ebe0', cell1: '#5e7699', cell2: '#ff9e8a', cell3: '#f0ebe0',
      // filled boxes, so the five hues are saturated enough to stay five
      // things at a 40% fill (closest pair 42 apart)
      toneNote: '#3f7fd0', toneTip: '#2fae6f', toneImportant: '#a45ee0', toneWarning: '#f5c542', toneCaution: '#ff5f4f',
    },
    dark: {
      paper: '#0b1320', ink: '#eef1f6', muted: '#9aa8be', rule: '#223149', soft: '#16273e',
      accent: '#ff9e8a', accentInk: '#ffb5a5', onAccent: '#16273e',
      tile: '#1b3050', tileInk: '#f0ebe0', cell1: '#5e7699', cell2: '#ff9e8a', cell3: '#f0ebe0',
      toneNote: '#3f7fd0', toneTip: '#2fae6f', toneImportant: '#a45ee0', toneWarning: '#f5c542', toneCaution: '#ff5f4f',
    },
    fonts: { display: 'humanist', body: 'humanist', label: 'humanist', mono: 'mono' },
    props: {
      size: 1.03, titleSize: 3.4, titleWeight: 800, titleTracking: -0.04, titleLeading: 0.95,
      headWeight: 780, radius: 14, callout: 'fill', quote: 'tile', table: 'bands', check: 'round',
      tile: 'on',
    },
  }),
  // BROADSHEET — the newspaper: a bold news serif under thick-and-thin
  // double rules, justified columns, small-caps section labels in the
  // masthead red, and a pull quote set between rules.
  broadsheet: make({
    light: {
      paper: '#f7f5ee', ink: '#141414', muted: '#57534b', rule: '#d6d1c4', soft: '#edeade',
      accent: '#b3261e', accentInk: '#a3231b', onAccent: '#ffffff',
      tile: '#141414', tileInk: '#f7f5ee', cell1: '#b3261e', cell2: '#d6d1c4', cell3: '#edeade',
    },
    dark: {
      paper: '#161513', ink: '#ece8de', muted: '#a7a196', rule: '#35322c', soft: '#1f1d1a',
      accent: '#ef6a5f', accentInk: '#f4877d', onAccent: '#161513',
      tile: '#0b0b0a', tileInk: '#ece8de', cell1: '#ef6a5f', cell2: '#35322c', cell3: '#1f1d1a',
    },
    fonts: { display: 'news', body: 'news', label: 'grotesk', mono: 'mono' },
    props: {
      size: 1.03, leading: 1.55, titleSize: 2.9, titleWeight: 800, titleTracking: -0.015, titleLeading: 1.04,
      headWeight: 800, radius: 0, rule: 1, label: 'caps', labelInk: 'accent', h2: 'double',
      callout: 'outline', quote: 'pull', table: 'rules', check: 'square', justify: 'on',
      divider: 'double', bullet: 'square',
    },
  }),
  // TYPESCRIPT — the manuscript and the RFC: every face a typewriter, double
  // spacing, headings in capitals and underlined as a typist would, a
  // two-colour ribbon (black and red), asterisms between sections.
  typescript: make({
    light: {
      paper: '#faf8f2', ink: '#1c1b19', muted: '#5e5b54', rule: '#cbc6ba', soft: '#f0ece2',
      accent: '#c0392b', accentInk: '#a5301f', onAccent: '#ffffff',
      tile: '#1c1b19', tileInk: '#faf8f2', cell1: '#c0392b', cell2: '#cbc6ba', cell3: '#f0ece2',
      // the ribbon's red for caution; the other four as typed inks
      toneNote: '#6b6760', toneTip: '#4f7a5c', toneImportant: '#5a5a9e', toneWarning: '#b8862b', toneCaution: '#c0392b',
    },
    dark: {
      paper: '#121212', ink: '#e4e1d8', muted: '#9d998f', rule: '#33312d', soft: '#1c1b19',
      accent: '#ff7a6b', accentInk: '#ff9285', onAccent: '#121212',
      tile: '#050505', tileInk: '#e4e1d8', cell1: '#ff7a6b', cell2: '#33312d', cell3: '#1c1b19',
      toneNote: '#a8a399', toneTip: '#7fb08d', toneImportant: '#9c9ce0', toneWarning: '#e0b25a', toneCaution: '#ff7a6b',
    },
    fonts: { display: 'typewriter', body: 'typewriter', label: 'typewriter', mono: 'typewriter' },
    props: {
      size: 0.95, leading: 1.85, titleSize: 1.6, titleWeight: 700, titleTracking: 0.02, titleLeading: 1.3,
      headWeight: 700, radius: 0, rule: 1, headCase: 'upper', h2: 'under', callout: 'outline',
      quote: 'indent', table: 'grid', check: 'square', divider: 'asterism', bullet: 'dash',
    },
  }),
  // RISO — the risograph zine: two spot inks (federal blue and fluorescent
  // pink) on cream stock, heavy capital headlines, hard offset shadows where
  // the second drum mis-registers, and cards that tile in spot colours.
  riso: make({
    light: {
      paper: '#f5f0e6', ink: '#1e2b6e', muted: '#4e5584', rule: '#cec7dc', soft: '#f6e1ea',
      accent: '#ff48b0', accentInk: '#b8157d', onAccent: '#101848',
      tile: '#1e2b6e', tileInk: '#f5f0e6', cell1: '#ff48b0', cell2: '#ffe800', cell3: '#00a95c',
    },
    dark: {
      paper: '#15172e', ink: '#f3eee4', muted: '#a7a9cc', rule: '#2e3160', soft: '#1f2244',
      accent: '#ff6bc1', accentInk: '#ff94d2', onAccent: '#15172e',
      tile: '#232766', tileInk: '#f3eee4', cell1: '#ff48b0', cell2: '#ffe800', cell3: '#00a95c',
    },
    fonts: { display: 'condensed', body: 'grotesk', label: 'grotesk', mono: 'mono' },
    props: {
      titleSize: 3.3, titleWeight: 900, titleTracking: -0.01, titleLeading: 0.95, headWeight: 900,
      radius: 0, rule: 2, headCase: 'upper', label: 'caps', h2: 'none', callout: 'shadow',
      quote: 'tile', table: 'grid', check: 'square', tile: 'on', shadow: 'hard', bullet: 'square',
    },
  }),
}

export const BUILT_IN_NAMES: readonly string[] = Object.keys(BUILT_INS)
export const isBuiltIn = (name: unknown): name is string =>
  typeof name === 'string' && Object.hasOwn(BUILT_INS, name)

/** A doc-local design name: short, lowercase, and safe as an attribute value. */
export const DESIGN_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/

// ---- validation ---------------------------------------------------------------

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i
const ASSET_FONT = /^asset:[A-Za-z0-9_~.-]{1,80}$/

/** A hex colour, normalised to #rrggbb lowercase, or null. */
export function parseColour(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (!HEX.test(s)) return null
  const h = s.slice(1).toLowerCase()
  return `#${h.length === 3 ? h.split('').map((c) => c + c).join('') : h}`
}

/** The data: URI an `asset:<key>` font resolves to in this document, or null. */
export function fontAssetUri(doc: SpacesDoc, ref: string): string | null {
  if (!ASSET_FONT.test(ref)) return null
  const key = ref.slice(6)
  const assets = doc.assets
  if (!assets || !Object.hasOwn(assets, key)) return null
  const v = assets[key]
  // a font, and only a font: an image or a clip under a font role is a mistake
  // the reader would see as a silent fallback, so it is refused here and named
  return typeof v === 'string' && /^data:(?:font\/|application\/(?:x-)?font-|application\/vnd\.ms-fontobject)/i.test(v) ? v : null
}

/** Whether `v` is a font value this document can honour. */
export function validFont(doc: SpacesDoc, v: unknown): v is string {
  if (typeof v !== 'string') return false
  if (Object.hasOwn(FONT_STACKS, v)) return true
  return fontAssetUri(doc, v) !== null
}

export function validProp(key: PropKey, v: unknown): boolean {
  const rule: NumRule | EnumRule = PROPS[key]
  if (rule.kind === 'num') return typeof v === 'number' && Number.isFinite(v) && v >= rule.min && v <= rule.max
  return typeof v === 'string' && rule.values.includes(v)
}

/** One thing wrong with a document's design data, for validate(). */
export interface DesignProblem {
  code: string
  path: string
  message: string
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/** The doc-local designs, as an object (absent or malformed = none). */
export function localDesigns(doc: SpacesDoc): Record<string, unknown> {
  const d = (doc as { designs?: unknown }).designs
  return isObj(d) ? d : {}
}

/**
 * A custom design's data over its base, with every invalid value dropped.
 *
 * `problems` collects what was dropped, so validate() can name each one — the
 * renderer never needs to, because a dropped value simply falls to the base.
 */
export function resolveData(doc: SpacesDoc, name: string, data: unknown, problems: DesignProblem[] = []): Design {
  const at = `designs.${name}`
  if (!isObj(data)) {
    problems.push({ code: 'bad-design', path: at, message: `designs.${name} is not an object, so it resolves to the default look.` })
    return PLAIN
  }
  let base = PLAIN
  if (data.base !== undefined) {
    if (isBuiltIn(data.base)) base = BUILT_INS[data.base]
    else problems.push({ code: 'unknown-design-base', path: `${at}.base`,
      message: `base "${String(data.base)}" is not a built-in design (${BUILT_IN_NAMES.join(', ')}); the default look is used as the base.` })
  }
  const out: Design = {
    light: { ...base.light }, dark: { ...base.dark },
    fonts: { ...base.fonts }, props: { ...base.props },
  }
  for (const mode of ['light', 'dark'] as const) {
    const pal = data[mode]
    if (pal === undefined) continue
    if (!isObj(pal)) { problems.push({ code: 'bad-design-value', path: `${at}.${mode}`, message: `${at}.${mode} is not an object and was ignored.` }); continue }
    for (const [k, v] of Object.entries(pal)) {
      if (!(PALETTE_KEYS as readonly string[]).includes(k)) {
        problems.push({ code: 'unknown-design-key', path: `${at}.${mode}.${k}`, message: `"${k}" is not a colour role (${PALETTE_KEYS.join(', ')}); it is kept in the file and ignored.` })
        continue
      }
      const c = parseColour(v)
      if (c) out[mode][k as PaletteKey] = c
      else problems.push({ code: 'bad-design-value', path: `${at}.${mode}.${k}`,
        message: `${at}.${mode}.${k} = ${JSON.stringify(v)} is not a #rgb or #rrggbb colour; the base design's ${base[mode][k as PaletteKey]} is used.` })
    }
  }
  if (data.fonts !== undefined) {
    if (!isObj(data.fonts)) problems.push({ code: 'bad-design-value', path: `${at}.fonts`, message: `${at}.fonts is not an object and was ignored.` })
    else for (const [k, v] of Object.entries(data.fonts)) {
      if (!(FONT_ROLES as readonly string[]).includes(k)) {
        problems.push({ code: 'unknown-design-key', path: `${at}.fonts.${k}`, message: `"${k}" is not a font role (${FONT_ROLES.join(', ')}); it is kept in the file and ignored.` })
        continue
      }
      if (validFont(doc, v)) out.fonts[k as FontRole] = v
      else problems.push({ code: 'bad-design-value', path: `${at}.fonts.${k}`,
        message: `${at}.fonts.${k} = ${JSON.stringify(v)} is neither a font name (${Object.keys(FONT_STACKS).join(', ')}) nor an embedded font asset; the base design's "${base.fonts[k as FontRole]}" is used.` })
    }
  }
  if (data.props !== undefined) {
    if (!isObj(data.props)) problems.push({ code: 'bad-design-value', path: `${at}.props`, message: `${at}.props is not an object and was ignored.` })
    else for (const [k, v] of Object.entries(data.props)) {
      if (!Object.hasOwn(PROPS, k)) {
        problems.push({ code: 'unknown-design-key', path: `${at}.props.${k}`, message: `"${k}" is not a design switch this build knows; it is kept in the file and ignored.` })
        continue
      }
      const key = k as PropKey
      if (validProp(key, v)) (out.props as Record<string, unknown>)[key] = v
      else {
        const rule: NumRule | EnumRule = PROPS[key]
        const allowed = rule.kind === 'num' ? `a number from ${rule.min} to ${rule.max}` : `one of ${rule.values.join(', ')}`
        problems.push({ code: 'bad-design-value', path: `${at}.props.${k}`,
          message: `${at}.props.${k} = ${JSON.stringify(v)} is not ${allowed}; the base design's ${JSON.stringify(base.props[key])} is used.` })
      }
    }
  }
  // A NEW GROUND BRINGS ITS OWN INK. Picking a dark teal accent over a base
  // whose text-on-accent is near-black would otherwise fail the floor and
  // throw the accent away — the author's one choice, discarded for the
  // sake of a value they never touched. So an ink the data did NOT set is
  // re-chosen for the ground it did.
  for (const mode of ['light', 'dark'] as const) {
    const set = isObj(data[mode]) ? data[mode] as Record<string, unknown> : {}
    const pal = out[mode]
    const best = (bg: string, ...cands: string[]) => cands.reduce((a, c) => (contrast(bg, c) > contrast(bg, a) ? c : a))
    if (set.accent !== undefined && set.onAccent === undefined) pal.onAccent = best(pal.accent, base[mode].onAccent, pal.ink, pal.paper, '#ffffff', '#000000')
    if (set.tile !== undefined && set.tileInk === undefined) pal.tileInk = best(pal.tile, base[mode].tileInk, pal.ink, pal.paper, '#ffffff')
  }
  enforceFloors(out, base, at, problems)
  return out
}

/**
 * THE FLOORS: no design may hide text.
 *
 * `design`/`designs` are ordinary collaborative registers, so any writer in a
 * live space can restyle every reader's page as they type. That is accepted —
 * a writer can already edit the words — but a design must never make words
 * DISAPPEAR, which a palette can do with nothing but colours (ink = paper).
 * So every text-on-ground pair a design paints is held to a contrast floor,
 * and a pair under it falls back to the base design's colours:
 *
 *   text, secondary text and accent text on paper ......... 4.5:1
 *   text on wells (code, table heads, board columns) ....... 4.5:1
 *   text on the accent fill, text on the tile .............. 4.5:1
 *   each tile cell against the ink chosen for it ........... 4.5:1
 *
 * The OTHER floors are in PROPS: text size never under 0.85 of the reading
 * size (13.6px at the smallest), line spacing never under 1.3, the title
 * never under 1.4em. And there is deliberately NO switch for display,
 * visibility, opacity or generated text — the only `content` in designs.css
 * is decoration on a divider, a checkbox tick and a heading bar, all constant.
 */
export const CONTRAST_FLOORS: ReadonlyArray<readonly [fg: PaletteKey, bg: PaletteKey, min: number]> = [
  ['ink', 'paper', 4.5], ['muted', 'paper', 4.5], ['accentInk', 'paper', 4.5],
  ['ink', 'soft', 4.5], ['onAccent', 'accent', 4.5], ['tileInk', 'tile', 4.5],
]

function enforceFloors(out: Design, base: Design, at: string, problems: DesignProblem[]): void {
  for (const mode of ['light', 'dark'] as const) {
    const pal = out[mode]
    const was = { ...pal }
    const failing = (): Array<readonly [PaletteKey, PaletteKey, number]> =>
      CONTRAST_FLOORS.filter(([fg, bg, min]) => contrast(pal[fg], pal[bg]) < min)
    // Fall back the CUSTOM member of a failing pair — foreground first, then
    // its ground — and re-check everything, because restoring a ground can
    // break a pair that was passing against the custom one.
    for (let pass = 0; pass < 4 && failing().length; pass++) {
      for (const [fg, bg, min] of failing()) {
        if (contrast(pal[fg], pal[bg]) >= min) continue
        if (pal[fg] !== base[mode][fg]) pal[fg] = base[mode][fg]
        if (contrast(pal[fg], pal[bg]) < min && pal[bg] !== base[mode][bg]) pal[bg] = base[mode][bg]
      }
    }
    // the base passes every floor (the model rig asserts it), so this is the
    // end of the line: a palette that still fails is the base's, whole
    if (failing().length) Object.assign(pal, base[mode])
    for (const c of ['cell1', 'cell2', 'cell3'] as const) {
      if (contrast(pal[c], cellInk(pal[c], out)) < 4.5) pal[c] = base[mode][c]
    }
    // A FILLED callout puts the design's ink on a mix of the tone and the
    // paper (designs.css, FILL_MIX). A custom accent can make that mix too
    // dark for the ink — measured: 4.27:1 on a teal fork in dark — so the
    // mix is checked here, where the numbers are, and the accent falls back.
    if (out.props.callout === 'fill' && !fillReadable(pal)) for (const k of TONE_KEYS) pal[k] = base[mode][k]
    // TONE IS MEANING: five tones a reader cannot tell apart are one tone
    if (!tonesDistinct(pal, out.props.callout)) for (const k of TONE_KEYS) pal[k] = base[mode][k]
    for (const k of PALETTE_KEYS) {
      if (pal[k] === was[k]) continue
      problems.push({ code: 'design-contrast', path: `${at}.${mode}.${k}`,
        message: `${at}.${mode}.${k} = ${was[k]} would leave text under its contrast floor (${CONTRAST_FLOORS.filter(([f, b]) => f === k || b === k).map(([f, b, m]) => `${f} on ${b} ${m}:1`).join(', ') || 'callout fill or tile cell 4.5:1, or five tones a reader must tell apart'}); the base design's ${pal[k]} is used.` })
    }
  }
  // …and if the base's own colours cannot carry a fill either, the SWITCH
  // falls back instead: a design never gets to put text on a ground it fails.
  if (out.props.callout === 'fill' && !(fillReadable(out.light) && fillReadable(out.dark))) {
    const to = base.props.callout === 'fill' ? 'tint' : base.props.callout
    problems.push({ code: 'design-contrast', path: `${at}.props.callout`,
      message: `${at}.props.callout = "fill" puts text under 4.5:1 with these colours; "${to}" is used.` })
    out.props.callout = to
  }
}

/** How much of the tone a FILLED callout's ground is. designs.css says the same number. */
export const FILL_MIX = 0.4
/**
 * The app's five callout tone hues (styles.css --tone-*, identical in both
 * themes). Restated because a fill's legibility is decided HERE; the model rig
 * asserts the two lists agree.
 */
export const TONE_HUES = ['#7d9cbd', '#4f9e79', '#8a72cc', '#d9a326', '#cd6a63'] as const

/** color-mix(in srgb, a p, b) — the same arithmetic the browser does. */
export function mixHex(a: string, b: string, p: number): string {
  const [x, y] = [channels(a), channels(b)]
  return '#' + x.map((c, i) => Math.round((c * p + y[i] * (1 - p)) * 255).toString(16).padStart(2, '0')).join('')
}

function fillReadable(pal: Palette): boolean {
  return TONE_KEYS.every((k) => contrast(pal.ink, mixHex(pal[k], pal.paper, FILL_MIX)) >= 4.5)
}

/**
 * What tells one tone from another ON THE PAGE, per callout style: a filled
 * box is told by its fill; every other style draws the tone's own hue as a
 * rule, a start bar or a shadow, and colours its label from it.
 */
export function toneSignature(pal: Palette, callout: Props['callout']): string[] {
  return TONE_KEYS.map((k) => (callout === 'fill' ? mixHex(pal[k], pal.paper, FILL_MIX) : pal[k]))
}
/** Smallest sRGB distance (0–441) two tones' signatures may sit apart. */
export const TONE_MIN_DISTANCE = 24
export function rgbDistance(a: string, b: string): number {
  const [x, y] = [channels(a), channels(b)]
  return Math.hypot(...x.map((c, i) => (c - y[i]) * 255))
}
export function tonesDistinct(pal: Palette, callout: Props['callout']): boolean {
  const s = toneSignature(pal, callout)
  for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) if (rgbDistance(s[i], s[j]) < TONE_MIN_DISTANCE) return false
  return true
}

export interface Resolved {
  /** the name as the document says it */
  name: string
  design: Design
  /** carried by this document rather than built in */
  custom: boolean
}

/**
 * The design this document asks for, or null for the default look.
 *
 * NULL covers three cases and all three render the untouched stylesheet: no
 * `design` key, a design name this build does not know (a newer built-in, or a
 * typo — the key round-trips and validate() names it), and a non-string.
 *
 * A doc-local design SHADOWS NOTHING: a `doc.designs.ledger` is ignored because
 * `ledger` means the built-in in every file, and validate() says so.
 *
 * `name` may be passed to resolve something other than `doc.design` — the
 * picker's hover preview, and (later) a per-page `design`, which is why this
 * takes a name rather than reading a fixed field.
 */
export function resolveDesign(doc: SpacesDoc, name: unknown = (doc as { design?: unknown }).design): Resolved | null {
  if (typeof name !== 'string' || !name) return null
  if (isBuiltIn(name)) return { name, design: BUILT_INS[name], custom: false }
  if (!DESIGN_NAME.test(name)) return null
  const local = localDesigns(doc)
  if (!Object.hasOwn(local, name)) return null
  return { name, design: resolveData(doc, name, local[name]), custom: true }
}

/** Everything validate() should say about `design` and `designs`. */
export function designProblems(doc: SpacesDoc): DesignProblem[] {
  const out: DesignProblem[] = []
  const raw = doc as { design?: unknown; designs?: unknown }
  if (raw.designs !== undefined && !isObj(raw.designs)) {
    out.push({ code: 'bad-design', path: 'designs', message: 'designs is not an object of named designs; it is kept in the file and ignored.' })
  }
  const local = localDesigns(doc)
  for (const [name, data] of Object.entries(local)) {
    if (isBuiltIn(name)) {
      out.push({ code: 'design-shadows-builtin', path: `designs.${name}`,
        message: `designs.${name} has a built-in design's name, so it is never used — "${name}" always means the built-in.` })
      continue
    }
    if (!DESIGN_NAME.test(name)) {
      out.push({ code: 'bad-design-name', path: `designs.${name}`,
        message: `"${name}" is not a usable design name (lowercase letters, digits and hyphens, up to 32), so it can never be selected.` })
      continue
    }
    if (isObj(data) && data.label !== undefined && (typeof data.label !== 'string' || !data.label.trim() || data.label.length > 60)) {
      out.push({ code: 'bad-design-value', path: `designs.${name}.label`, message: `designs.${name}.label must be a short string; the name is shown instead.` })
    }
    resolveData(doc, name, data, out)
  }
  if (raw.design !== undefined) {
    if (typeof raw.design !== 'string' || !raw.design) {
      out.push({ code: 'bad-design', path: 'design', message: `design = ${JSON.stringify(raw.design)} is not a design name, so the default look is shown.` })
    } else if (!resolveDesign(doc)) {
      out.push({ code: 'unknown-design', path: 'design',
        message: `design "${raw.design}" is neither a built-in (${BUILT_IN_NAMES.join(', ')}) nor defined in designs, so the default look is shown. The value is kept.` })
    }
  }
  return out
}

/** Asset keys the designs reference, so an embedded face never reads as an orphan. */
export function designAssetKeys(doc: SpacesDoc): string[] {
  const keys: string[] = []
  for (const data of Object.values(localDesigns(doc))) {
    if (!isObj(data) || !isObj(data.fonts)) continue
    for (const v of Object.values(data.fonts)) if (typeof v === 'string' && ASSET_FONT.test(v)) keys.push(v.slice(6))
  }
  return keys
}

/** What the picker calls a doc-local design. */
export function localLabel(doc: SpacesDoc, name: string): string {
  const data = localDesigns(doc)[name]
  const l = isObj(data) && typeof data.label === 'string' ? data.label.trim() : ''
  return l && l.length <= 60 ? l : name
}

/** A fresh doc-local name that collides with nothing. */
export function freshDesignName(doc: SpacesDoc): string {
  const local = localDesigns(doc)
  for (let n = 1; ; n++) {
    const name = n === 1 ? 'custom' : `custom-${n}`
    if (!Object.hasOwn(local, name) && !isBuiltIn(name)) return name
  }
}

// ---- writing it down ---------------------------------------------------------

/**
 * Set or clear the document's design.
 *
 * RETURNING TO THE DEFAULT DELETES THE KEY — never `design: ''` or `null` —
 * so a document that tried a design and went back is byte-identical to one
 * that never did, and an older build sees nothing it has to preserve.
 */
export function setDesign(doc: SpacesDoc, name: string | null): void {
  const d = doc as { design?: unknown }
  if (name) d.design = name
  else delete d.design
}

// ---- Markdown front matter -----------------------------------------------------

/**
 * The front matter an export opens with, or [] when there is no design.
 *
 * THE SMALLEST CORRECT FRONT MATTER: `design:` names it, and when the design
 * is one this document carries, `designs:` holds that one entry as a single
 * line of JSON — which is YAML flow syntax, so any YAML reader accepts it and
 * no YAML parser is needed to read it back. A space with no design exports
 * with no front matter at all, exactly as before.
 */
export function designFrontMatter(doc: SpacesDoc): string[] {
  const name = (doc as { design?: unknown }).design
  if (typeof name !== 'string' || !name) return []
  const lines = ['---', `design: ${/^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name)}`]
  const local = localDesigns(doc)
  if (!isBuiltIn(name) && Object.hasOwn(local, name)) {
    lines.push(`designs: ${JSON.stringify({ [name]: local[name] })}`)
  }
  lines.push('---', '')
  return lines
}

export interface FrontMatterDesign {
  design?: string
  designs?: Record<string, unknown>
  /** every line was ours, so the front matter is consumed rather than kept */
  onlyOurs: boolean
}

/** Read `design:` and `designs:` out of front matter text (the lines between the fences). */
export function readDesignFrontMatter(yaml: string): FrontMatterDesign {
  const out: FrontMatterDesign = { onlyOurs: true }
  for (const line of yaml.split('\n')) {
    if (!line.trim()) continue
    const d = /^design:\s*(.*?)\s*$/.exec(line)
    if (d) {
      let v = d[1]
      if (v.startsWith('"')) { try { v = String(JSON.parse(v)) } catch { v = '' } }
      else if (v.startsWith("'") && v.endsWith("'") && v.length > 1) v = v.slice(1, -1)
      if (v) out.design = v
      continue
    }
    const ds = /^designs:\s*(\{.*\})\s*$/.exec(line)
    if (ds) {
      try {
        const parsed: unknown = JSON.parse(ds[1])
        if (isObj(parsed)) out.designs = parsed
      } catch { out.onlyOurs = false }
      continue
    }
    out.onlyOurs = false
  }
  return out
}

/**
 * Adopt a design that arrived with imported notes. Mutates `doc`; call it
 * inside the import's one commit.
 *
 * CONSERVATIVE BY DESIGN: a doc-local entry is added only under a name this
 * space does not already use, and `design` is set only when the space has
 * none and the name resolves — an import adds pages, it does not restyle a
 * space somebody already designed. Returns the name adopted, if any.
 */
export function adoptDesign(doc: SpacesDoc, design: string | undefined, designs: Record<string, unknown> | undefined): string | null {
  const d = doc as { design?: unknown; designs?: Record<string, unknown> }
  for (const [name, data] of Object.entries(designs ?? {})) {
    if (isBuiltIn(name) || !DESIGN_NAME.test(name) || !isObj(data)) continue
    if (Object.hasOwn(localDesigns(doc), name)) continue
    d.designs = { ...localDesigns(doc), [name]: data }
  }
  if (!design || d.design !== undefined) return null
  if (!resolveDesign(doc, design)) return null
  d.design = design
  return design
}

// ---- colour arithmetic (for readable ink on tile cells) -----------------------

function channels(hex: string): [number, number, number] {
  const h = (parseColour(hex) ?? '#000000').slice(1)
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number]
}
export function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}
/**
 * The ink for a tile cell: whichever of the design's own dark inks, or white,
 * reads best on it. Chosen, not stored, so a custom palette that darkens a
 * cell does not need a second edit — and the cells are brand colours that do
 * not flip with the reader's theme, so the LIGHT inks are the candidates in
 * both palettes.
 */
export function cellInk(bg: string, d: Pick<Design, 'light'>): string {
  let best = '#ffffff'
  for (const c of [d.light.ink, d.light.onAccent]) if (contrast(bg, c) > contrast(bg, best)) best = c
  return best
}

// ---- to CSS values -------------------------------------------------------------

const kebab = (k: string): string => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)

/** A family name for an embedded face: derived from its key, never from author text. */
export function assetFamily(ref: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < ref.length; i++) { h ^= ref.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return `bento-face-${h.toString(36)}`
}

/** The fallback stack a role falls to when its embedded face is missing. */
const ROLE_FALLBACK: Record<FontRole, string> = { display: 'system', body: 'system', label: 'system', mono: 'mono' }

export function fontStack(value: string, role: FontRole): string {
  if (Object.hasOwn(FONT_STACKS, value)) return FONT_STACKS[value]
  return `'${assetFamily(value)}', ${FONT_STACKS[ROLE_FALLBACK[role]]}`
}

/**
 * The attributes and custom properties that put a design on a surface.
 *
 * EVERY VALUE HERE IS ONE THIS MODULE CHOSE OR CHECKED: palette values passed
 * parseColour, numbers passed their range, words are PROPS entries, stacks are
 * FONT_STACKS strings or a family name derived from an asset key. That is the
 * whole of the injection argument, and the model rig asserts each part.
 */
export function designStyle(r: Resolved): { attrs: Record<string, string>; vars: Record<string, string> } {
  const d = r.design
  const attrs: Record<string, string> = { 'data-sp-design': r.name }
  const vars: Record<string, string> = {}
  for (const [mode, pre] of [['light', '--dl-'], ['dark', '--dd-']] as const) {
    const pal = d[mode]
    for (const k of PALETTE_KEYS) vars[`${pre}${kebab(k)}`] = pal[k]
    // tile cells get their own ink, chosen for contrast rather than stored:
    // a custom palette that makes a cell dark should not need a second edit
    for (const c of ['cell1', 'cell2', 'cell3'] as const) vars[`${pre}${c}-ink`] = cellInk(pal[c], d)
    // THE MARK: the accent wherever a mark carries meaning (a done box, a
    // drop cap, a bar), unless the accent is too pale to be read as one on
    // this paper — then its ink twin. Studio's coral is 2.0:1 on white: fine
    // as a fill under navy text, not fine as the only sign a task is done.
    vars[`${pre}mark`] = contrast(pal.accent, pal.paper) >= 3 ? pal.accent : pal.accentInk
  }
  for (const role of FONT_ROLES) vars[`--d-${role}`] = fontStack(d.fonts[role], role)
  for (const k of PROP_KEYS) {
    const rule: NumRule | EnumRule = PROPS[k]
    const v = d.props[k]
    if (rule.kind === 'num') vars[`--d-${kebab(k)}`] = `${v}${rule.unit}`
    else attrs[`data-sd-${k.toLowerCase()}`] = String(v)
  }
  return { attrs, vars }
}

/** Every attribute a design can put on a surface, so clearing one is complete. */
const ALL_ATTRS = ['data-sp-design', ...PROP_KEYS.filter((k) => PROPS[k].kind === 'enum').map((k) => `data-sd-${k.toLowerCase()}`)]

// ---- the DOM side -----------------------------------------------------------

/** Faces already handed to document.fonts, by family. */
const registered = new Set<string>()

/**
 * Load a design's embedded faces through the FontFace API.
 *
 * NO STYLESHEET TEXT: the bytes go to `new FontFace(family, buffer)`, so an
 * embedded face never produces an @font-face rule that author data could
 * shape, and nothing is fetched — the bytes are already in the file.
 */
function loadFaces(doc: SpacesDoc, d: Design): void {
  const fonts = (globalThis as { document?: Document }).document?.fonts
  if (!fonts || typeof FontFace === 'undefined') return
  for (const role of FONT_ROLES) {
    const ref = d.fonts[role]
    if (Object.hasOwn(FONT_STACKS, ref)) continue
    const family = assetFamily(ref)
    if (registered.has(family)) continue
    const uri = fontAssetUri(doc, ref)
    if (!uri) continue
    registered.add(family)
    try {
      const b64 = uri.slice(uri.indexOf(',') + 1)
      const bin = atob(b64)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      const face = new FontFace(family, bytes)
      fonts.add(face)
      void face.load().catch(() => { /* a broken file falls back to the stack */ })
    } catch { /* not base64 — the stack's fallback is what shows */ }
  }
}

/**
 * Put the document's design on a surface — or take every trace of one off.
 *
 * With no design the surface carries NO attribute and NO custom property,
 * which is what makes "no design" the untouched stylesheet byte for byte:
 * every rule in designs.css is keyed under `[data-sp-design]`.
 */
export function applyDesign(el: HTMLElement, doc: SpacesDoc, override?: Resolved | null): void {
  const r = override === undefined ? resolveDesign(doc) : override
  for (const a of ALL_ATTRS) el.removeAttribute(a)
  for (const p of Array.from(el.style)) if (p.startsWith('--dl-') || p.startsWith('--dd-') || p.startsWith('--d-')) el.style.removeProperty(p)
  if (!r) return
  const { attrs, vars } = designStyle(r)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v)
  loadFaces(doc, r.design)
}

// ---- the still preview ---------------------------------------------------------

/** One preview rule: elements under the preview box, and the declarations for them. */
export type PreviewRule = [selector: string, decls: Record<string, string>]

/**
 * The design, for preview.ts, in its LIGHT palette — as INLINE STYLES, never
 * as a <style> element.
 *
 * The preview is written into every saved shell, and a design's values in a
 * <style> block there would be author data inside raw text that the HTML
 * parser ends at the first `</style>`. Validation already makes that string
 * impossible (a hex colour, a number, a word from PROPS, a stack from
 * FONT_STACKS) — and this does not lean on it: preview.ts writes each
 * declaration through `style.setProperty`, so the CSSOM parses the value,
 * drops anything that is not one value of that property, and the serializer
 * escapes what is left as an attribute. Two independent guards.
 *
 * Light, because a thumbnail has no reader to ask and is the document's face.
 * No custom properties or color-mix(): QuickLook's conservative WebKit is who
 * reads this. Embedded faces are not drawn (their bytes would blow the
 * preview's budget); the role's fallback stack stands in.
 */
export function previewRules(r: Resolved): PreviewRule[] {
  const d = r.design
  const p = d.light
  const P = d.props
  const f = (role: FontRole) => fontStack(d.fonts[role], role)
  const label: Record<string, string> = P.label === 'caps' ? { 'text-transform': 'uppercase', 'letter-spacing': '.08em' }
    : P.label === 'smallcaps' ? { 'font-variant-caps': 'all-small-caps', 'letter-spacing': '.05em' }
    : P.label === 'italic' ? { 'font-style': 'italic' } : {}
  const rules: PreviewRule[] = [
    ['', { background: p.paper, color: p.ink, 'font-family': f('body') }],
    ['.bp-col', { 'font-size': `${16 * P.size}px`, 'line-height': String(P.leading) }],
    ['h1, h2, h3', { 'font-family': f('display'), 'font-weight': String(P.headWeight),
      ...(P.headStyle === 'italic' ? { 'font-style': 'italic' } : {}),
      ...(P.headCase === 'upper' ? { 'text-transform': 'uppercase' } : {}) }],
    ['h1.sp-title', { 'font-size': `${((33 * P.titleSize) / 2.06).toFixed(1)}px`, 'font-weight': String(P.titleWeight),
      'letter-spacing': `${P.titleTracking}em`, 'line-height': String(P.titleLeading), 'font-style': 'normal' }],
    ['h3, th', { 'font-family': f('label'), color: P.labelInk === 'accent' ? p.accentInk : p.ink, ...label }],
    ['pre, code', { 'font-family': f('mono') }],
    ['blockquote', { 'border-inline-start-color': p.accent, color: p.ink }],
    ['aside', { background: p.soft, 'border-color': p.rule, 'border-inline-start-color': p.accent, 'border-radius': `${P.radius}px` }],
    ['pre', { background: p.soft, 'border-radius': `${P.radius}px` }],
    ['hr', { 'border-top': `${P.rule}px solid ${P.divider === 'rule' ? p.rule : p.ink}` }],
    ['th', { background: p.soft }],
    ['th, td', { 'border-color': p.rule }],
    ['a', { 'border-bottom-color': p.accent }],
    ['li.sp-done, figcaption, .sp-media-badge', { color: p.muted }],
  ]
  if (P.h2 === 'above' || P.h2 === 'double') {
    rules.push(['h2', { 'border-top': `${P.h2 === 'double' ? `${P.rule * 3 + 1}px double` : `${P.rule}px solid`} ${p.ink}`, 'padding-top': '8px' }])
  } else if (P.h2 === 'under') {
    rules.push(['h2', { 'text-decoration': 'underline' }])
  }
  if (P.callout === 'outline') rules.push(['aside', { background: 'none', border: `${Math.max(1, P.rule)}px solid ${p.ink}` }])
  else if (P.callout === 'rules') rules.push(['aside', { background: 'none', border: '0', 'border-top': `1px solid ${p.accent}`, 'border-bottom': `1px solid ${p.accent}`, 'border-radius': '0', 'padding-left': '0', 'padding-right': '0' }])
  else if (P.callout === 'fill') rules.push(['aside', { background: p.accent, color: p.onAccent, border: '0' }])
  else if (P.callout === 'shadow') rules.push(['aside', { background: p.paper, border: `2px solid ${p.ink}`, 'box-shadow': `5px 5px 0 ${p.accent}` }])
  if (P.quote === 'tile') rules.push(['blockquote', { background: p.tile, color: p.tileInk, border: '0', padding: '16px 20px', 'border-radius': `${P.radius + 6}px` }])
  else if (P.quote === 'display' || P.quote === 'pull') rules.push(['blockquote', { border: '0', padding: '0', 'font-family': f('display'), 'font-style': 'italic', 'font-size': '1.3em' }])
  if (P.justify === 'on') rules.push(['p', { 'text-align': 'justify' }])
  return rules
}

/** Apply previewRules under `box` (a selector of '' means the box itself). */
export function applyPreviewRules(box: HTMLElement, rules: PreviewRule[]): void {
  for (const [sel, decls] of rules) {
    const els = sel ? Array.from(box.querySelectorAll<HTMLElement>(sel)) : [box]
    for (const el of els) for (const [k, v] of Object.entries(decls)) el.style.setProperty(k, v)
  }
}
