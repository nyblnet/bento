// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * The bento/slides document schema, as JSON Schema (draft 2020-12), built
 * from the SAME tables that gate a document on the way in: untrusted.ts's
 * checks describe what they accept, modelkeys.generated.ts says which keys
 * each type has, and this file assembles the two. There is no hand-written
 * copy of the format to drift: scripts/build-schema.mjs prints this into
 * schema/slides.json (published at https://bento.page/schema/slides.json)
 * and CI fails when the file and the function disagree.
 *
 * Reachable four ways: the URL above (and a version-pinned twin), the
 * `$schema` key every saved deck carries (save.ts), `window.bento.schema()`
 * in a running file, and https://bento.page/llms.txt. The first, second and
 * fourth serve a model that READS the file; the third serves one driving a
 * browser — the shell is deflated, so a text reader never sees this code.
 *
 * What the schema says and what the gate does are the same thing by
 * construction, with one honest gap: the gate REPAIRS a numeric string
 * ("12" → 12) and DROPS a bad value rather than rejecting the document; a
 * validator following this schema reports the same values as errors. A deck
 * that validates here loads with nothing dropped.
 */

import { FORMAT, FORMAT_VERSION } from './model'
import { MODEL_KEYS } from './modelkeys.generated'
import { ELEMENT_CHECKS, SLIDE_CHECKS, REQUIRED_KEYS, LIMITS, objectSchema, type JsonSchema } from './untrusted'

export const SCHEMA_URL = 'https://bento.page/schema/slides.json'

/**
 * The saved JSON names its schema as its FIRST key, so a reader with only
 * the file in hand knows the format (50 bytes). A new object — the live
 * document is never touched — and parseDoc strips the key on load, so it
 * exists only in the bytes on disk: not in the store, the CRDT, a recovery
 * snapshot or a clip. Older shells keep the key and write it back; nothing
 * anywhere fetches it.
 */
export const stampSchema = <T extends object>(doc: T): T & { $schema: string } => ({ $schema: SCHEMA_URL, ...doc })

const str = (max: number, description?: string): JsonSchema =>
  description ? { type: 'string', maxLength: max, description } : { type: 'string', maxLength: max }
const color = (description: string): JsonSchema => ({ type: 'string', maxLength: LIMITS.color, description })
const obj = (keys: readonly string[], props: Record<string, JsonSchema>, required: string[] = []): JsonSchema => {
  const properties: Record<string, JsonSchema> = {}
  for (const k of keys) properties[k] = props[k] ?? {}
  const out: JsonSchema = { type: 'object', properties, additionalProperties: false }
  if (required.length) out.required = required
  return out
}

/**
 * Element properties whose schema is a structure (fx, gradients, shadows,
 * table rows…) are hoisted into $defs once and referenced from every element
 * type that carries them — the file is a third the size and a reader sees
 * one definition of `fx`, not eight.
 */
const HOISTED = ['fx', 'shadow', 'colorGradient', 'fillGradient', 'themeRefs', 'from', 'to', 'style', 'rows', 'columns', 'crop', 'textStroke', 'source', 'link', 'option', 'doc'] as const

/** The schema for one element type: exactly that type's keys, each as the gate checks it. */
function elementSchema(type: string, $defs: Record<string, JsonSchema>): JsonSchema {
  const keys = (MODEL_KEYS.element as Record<string, readonly string[]>)[type]
  const s = objectSchema(keys, ELEMENT_CHECKS, ['type', 'id', ...(REQUIRED_KEYS[type] ?? [])])
  const props = s.properties as Record<string, JsonSchema>
  props.type = { const: type }
  for (const key of HOISTED) {
    if (!(key in props)) continue
    const name = `prop-${key}`
    $defs[name] ??= props[key]
    props[key] = { $ref: `#/$defs/${name}` }
  }
  s.description = `${type} element; x/y/w/h in slide px (1280×720 default); a stable id pairs morphs`
  return s
}

/** Build the whole schema. `version` stamps which shell it describes. */
export function buildSchema(version: string): JsonSchema {
  const elementTypes = Object.keys(MODEL_KEYS.element)
  const $defs: Record<string, JsonSchema> = {}
  for (const type of elementTypes) $defs[type] = elementSchema(type, $defs)
  $defs.element = { oneOf: elementTypes.map((t) => ({ $ref: `#/$defs/${t}` })) }
  $defs.slide = objectSchema(MODEL_KEYS.slide, SLIDE_CHECKS, ['id'])
  $defs.slide.description = 'stateOf = hidden variant reached by a link; transition morph pairs same-id elements'
  $defs.tableStyle = ELEMENT_CHECKS.style.schema!
  $defs.theme = obj(MODEL_KEYS.theme, {
    background: color('slide background'), color: color('body text colour'), accent: color('accent colour'),
    fontFamily: { type: 'string', maxLength: LIMITS.fontStack, description: 'CSS font-family stack for body text' },
    headingFamily: { type: 'string', maxLength: LIMITS.fontStack, description: 'display face for headings; absent = fontFamily' },
    palette: obj(MODEL_KEYS.themePalette, Object.fromEntries(MODEL_KEYS.themePalette.map((k) => [k, color(`brand slot ${k}`)]))),
    chartPalette: { type: 'array', maxItems: 64, items: color('series colour') },
    table: { $ref: '#/$defs/tableStyle' },
    codePalette: obj(MODEL_KEYS.themeCodePalette, Object.fromEntries(MODEL_KEYS.themeCodePalette.map((k) => [k, color('token colour')]))),
  }, ['background', 'color', 'accent', 'fontFamily'])
  $defs.doc = obj(MODEL_KEYS.doc, {
    format: { const: FORMAT },
    version: { type: 'integer', minimum: 1, description: `format version; this shell writes ${FORMAT_VERSION}` },
    docId: str(LIMITS.scalar, 'runtime-minted uuid; omit'),
    title: str(LIMITS.prose),
    meta: obj(MODEL_KEYS.meta, Object.fromEntries(MODEL_KEYS.meta.map((k) => [k, str(LIMITS.prose)]))),
    size: obj(MODEL_KEYS.size, { width: { type: 'number', minimum: 1, maximum: 1e5 }, height: { type: 'number', minimum: 1, maximum: 1e5 } }, ['width', 'height']),
    theme: { $ref: '#/$defs/theme' },
    present: obj(MODEL_KEYS.present, {
      numberHidden: { type: 'boolean' }, slideNumber: { type: 'boolean' }, controls: { type: 'boolean' }, progress: { type: 'boolean' },
      morphSeconds: { type: 'number', minimum: 0, maximum: 60 },
    }),
    slides: { type: 'array', minItems: 1, maxItems: LIMITS.slides, items: { $ref: '#/$defs/slide' } },
    layouts: { type: 'array', maxItems: LIMITS.slides, items: { $ref: '#/$defs/slide' }, description: 'slide templates' },
    assets: { type: 'object', maxProperties: LIMITS.assets, additionalProperties: { type: 'string', maxLength: LIMITS.asset }, description: 'key → data: URI or svg, used as asset:<key>' },
    blobs: { type: 'object', description: 'runtime-written' },
    fonts: { type: 'array', maxItems: LIMITS.assets, items: obj(MODEL_KEYS.font, {
      family: { type: 'string', maxLength: LIMITS.fontStack }, asset: str(LIMITS.scalar, 'asset:<key> or builtin:<name>'),
      weight: str(64), style: str(64),
    }, ['family', 'asset']) },
    modified: str(LIMITS.scalar, 'runtime-written'),
    readonly: { type: 'boolean', description: 'presentation package' },
    template: { type: 'boolean' },
    collab: { type: 'object', description: 'runtime-written credentials; never author' },
  }, ['format', 'slides'])
  ;($defs.doc.properties as Record<string, JsonSchema>).$schema = { type: 'string' }
  ;($defs.doc.properties as Record<string, JsonSchema>).compact = { const: true, description: 'input only: omitted fields take editor defaults (AGENTS.md)' }
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: SCHEMA_URL,
    title: 'bento/slides document',
    description: `The #bento-doc JSON of a Bento Slides file, generated from the app's validation tables. Guide: https://bento.page/agents.md`,
    'x-bento-version': version,
    $ref: '#/$defs/doc',
    $defs,
  }
}
