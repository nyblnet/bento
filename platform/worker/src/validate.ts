// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Ingest validation for a doc arriving at POST/PATCH /api/decks — the
// boundary where this platform stops trusting the caller. slides/src/render.ts
// already sanitizes text/table `html` at RENDER time (sanitizeHtml: strict tag
// allowlist, every attribute stripped), so that path is defended regardless of
// what we store. Two paths are NOT defended by the renderer and are handled
// here instead:
//
//   - `svg` elements carry raw author markup with no allowlist at all. A
//     proper sanitizer for arbitrary SVG (nested foreignObject, xlink:href
//     javascript: URIs, embedded <script>, event handler attributes, …) is a
//     real undertaking — Workers' HTMLRewriter could do it, but a half-built
//     version is worse than an honest refusal. v1 REJECTS svg elements on
//     ingest; see platform/README.md "Known gaps" for the follow-up.
//   - `image`/`media` `src` and `doc.assets[*]` are used directly as a `src`
//     attribute, never sanitized. Restricted to schemes a browser cannot turn
//     into script execution: `data:`, `https:`, or an in-doc `asset:` ref.
//
// Also strips collab entirely (a doc arriving with collab.on would auto-join
// a live session per docs/PLATFORM.md §5 — never appropriate for something
// freshly posted through an HTTP API) and enforces a size ceiling generous
// enough for a media-light deck but well short of anything that would make a
// single R2 object or D1 row awkward.

export const MAX_DOC_BYTES = 6 * 1024 * 1024 // 6MB — see platform/README.md

export interface ValidationError {
  field: string
  message: string
}

export interface ValidationResult {
  ok: boolean
  errors: ValidationError[]
  /** Present only when ok. The doc with collab stripped — callers still need
   *  to mint docId themselves (validation doesn't know whether this is a
   *  create or an update). */
  doc?: Record<string, unknown>
}

const ALLOWED_SRC_PREFIXES = ['data:', 'https://', 'asset:']

function isAllowedSrc(src: unknown): boolean {
  return typeof src === 'string' && ALLOWED_SRC_PREFIXES.some((p) => src.startsWith(p))
}

function isAsset(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

export function validateIncomingDoc(input: unknown): ValidationResult {
  const errors: ValidationError[] = []

  const raw = JSON.stringify(input)
  if (raw.length > MAX_DOC_BYTES) {
    errors.push({ field: 'doc', message: `document is ${raw.length} bytes, over the ${MAX_DOC_BYTES} limit` })
    return { ok: false, errors }
  }

  if (!isAsset(input)) {
    errors.push({ field: 'doc', message: 'not a JSON object' })
    return { ok: false, errors }
  }

  if (input.format !== 'bento/slides') {
    errors.push({ field: 'format', message: `expected "bento/slides", got ${JSON.stringify(input.format)}` })
  }
  if (typeof input.title !== 'string') {
    errors.push({ field: 'title', message: 'must be a string' })
  }
  if (!Array.isArray(input.slides)) {
    errors.push({ field: 'slides', message: 'must be an array' })
  }

  if (isAsset(input.assets)) {
    for (const [key, value] of Object.entries(input.assets)) {
      if (typeof value !== 'string' || !value.startsWith('data:')) {
        errors.push({ field: `assets.${key}`, message: 'asset values must be data: URIs' })
      }
    }
  }

  if (Array.isArray(input.slides)) {
    for (const [si, slide] of input.slides.entries()) {
      if (!isAsset(slide) || !Array.isArray(slide.elements)) continue
      for (const [ei, el] of slide.elements.entries()) {
        if (!isAsset(el)) continue
        const where = `slides[${si}].elements[${ei}]`
        if (el.type === 'svg') {
          errors.push({ field: where, message: 'svg elements are not accepted yet (see platform/README.md)' })
        }
        if (el.type === 'image' || el.type === 'media') {
          if (!isAllowedSrc(el.src)) {
            errors.push({ field: `${where}.src`, message: 'src must start with data:, https://, or asset:' })
          }
        }
      }
    }
  }

  if (errors.length) return { ok: false, errors }

  // Strip collab unconditionally — see file header. Everything else passes
  // through untouched; the caller (store.ts) mints docId/readonly as needed.
  const { collab: _collab, ...doc } = input
  return { ok: true, errors: [], doc }
}
