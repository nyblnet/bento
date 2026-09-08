// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Named paragraph styles — the format piece described in DocStyle (model.ts)
// and the panel that edits it.
//
// THE GAP THIS CLOSES. Before this, the panel's "Style" dropdown
// (props.ts STYLE_OPTIONS) only set a block's `kind` — which picks a TAG
// (h1, p, blockquote…) and nothing about how that tag looks. Every heading's
// size, weight and spacing was hardcoded in styles.css, so "make every
// heading 18px Palatino" was not a setting; it was a code change. This module
// makes the LOOK of a kind a document property instead of a build constant.
//
// THE PRECEDENCE STACK, block wins over style wins over document:
//
//   block's own align/sb/sa/lh/ind  (Block, model.ts — set via the Layout panel)
//         │  (present ⇒ wins outright — "Direct per-block formatting must
//         │   still win over the style")
//         ▼
//   the block's STYLE  (explicit b.styleId, or the kind's default — resolveStyle)
//         ▼
//   the document's OWN defaults  (doc.layout — layout.ts docEffective)
//         ▼
//   the built-in fallback  (layout.ts DOC_DEFAULTS)
//
// `family`/`size`/`weight`/`italic`/`color` have no per-block equivalent —
// character-level formatting is already a MARK over a text range (inline.ts
// t:'font', plus b/i toggle marks), and an inline `<span style="…">` always
// wins the cascade over an ancestor's inline style, so nothing new is needed
// there: a bold word inside a re-styled heading stays bold with no extra code.
//
// ADDITIVITY (docs/PLATFORM.md §3). `doc.styles` is optional and a block's
// `styleId` is optional; BUILT_IN_STYLES below is chosen to compute to the
// EMPTY string for every kind it covers when nothing has been edited — see
// the comment on each entry. So a document that never opens the Styles
// section renders through the same styles.css rules it always has, and
// scripts/test-type-styles.ts asserts exactly that against a fixture with no
// `doc.styles` at all.

import { fontAcross, safeFamily, safeSize } from './inline.ts';
import type { Block, BlockKind, DocStyle, TypeDoc } from './model.ts';
import { docEffective, propsOf, type ParaLayout } from './layout.ts';
import { t } from './i18n.ts';
import type { FeatureContext } from './features.ts';
// NOT `import './docstyles.css'` here: render.ts imports this module for
// docStyleCss, and render.ts is reachable from model.ts (via comments.ts) —
// which the node test rigs (scripts/test-type-*.ts) load directly with no
// bundler in front of them, and plain node has no loader for a bare `.css`
// import. props.ts pulls the stylesheet in instead: it is UI-only, reached
// only through features.ts, which no rig imports.

// ═══════════════════════════════════════════════════════════ resolution (pure)

/** Which kinds carry a default style, and that style's built-in id. */
export const DEFAULT_STYLE_ID: Partial<Record<BlockKind, string>> = {
  para: 'default-body', h1: 'default-h1', h2: 'default-h2', h3: 'default-h3',
  quote: 'default-quote', ul: 'default-ul', ol: 'default-ol',
};

/**
 * The built-in styles, numbers copied from styles.css's `.t-paper` rules —
 * see the file header. `default-body` is intentionally EMPTY: body text's
 * appearance already comes entirely from the unconditional `.t-paper p` rule
 * plus, when the document sets its own defaults, the `--lay-*` custom
 * properties layout.ts already writes — this module adds nothing on top of
 * either until the style is actually edited.
 */
export const BUILT_IN_STYLES: Record<string, DocStyle> = {
  'default-body': { id: 'default-body', kind: 'para', name: 'Body' },
  'default-h1': { id: 'default-h1', kind: 'h1', name: 'Heading 1', size: 26, weight: 600, lh: 1.24, sa: 14 },
  'default-h2': { id: 'default-h2', kind: 'h2', name: 'Heading 2', size: 15.5, weight: 600, sb: 24, sa: 8 },
  'default-h3': { id: 'default-h3', kind: 'h3', name: 'Heading 3', size: 14, weight: 600, color: '#3a3d44', sb: 16, sa: 6 },
  'default-quote': { id: 'default-quote', kind: 'quote', name: 'Quote', italic: true, color: '#3a3d44', sb: 12, sa: 12 },
  'default-ul': { id: 'default-ul', kind: 'ul', name: 'Bulleted list', sa: 3 },
  'default-ol': { id: 'default-ol', kind: 'ol', name: 'Numbered list', sa: 3 },
};

/** Fixed display order for the built-ins; anything else sorts after, by name. */
const BUILT_IN_ORDER = ['default-body', 'default-h1', 'default-h2', 'default-h3',
                         'default-quote', 'default-ul', 'default-ol'];

/** The style a block currently carries, EXPLICIT only — no kind fallback. */
export function ownStyleId(b: Block): string | undefined {
  return typeof b.styleId === 'string' && b.styleId ? b.styleId : undefined;
}

/**
 * The id actually in force for this block: its own `styleId` WHEN IT
 * RESOLVES, else its kind's default. Needs `doc` for that first check — a
 * `styleId` naming a style that does not exist (deleted since, or a typo
 * from hand-edited JSON) is not "in force"; falling through to the kind
 * default is what keeps that paragraph looking like a heading instead of
 * silently going plain the moment its style disappears. Undefined only for a
 * kind with no default (image, cell, caption, toc, math, embed) that also
 * carries no *resolvable* explicit `styleId`.
 */
export function activeStyleId(doc: TypeDoc, b: Block): string | undefined {
  const own = ownStyleId(b);
  if (own && lookupStyle(doc, own)) return own;
  return DEFAULT_STYLE_ID[b.kind];
}

/**
 * Look up a style by id: the document's own copy if it has materialized one
 * (edited at least once), else the built-in of that id, else undefined for an
 * id that resolves to neither — a dangling `styleId` from hand-edited JSON,
 * or a style that has since been removed. That case is not an error: the
 * caller falls back to rendering nothing extra, exactly as an unstyled block
 * always has.
 */
export function lookupStyle(doc: TypeDoc, id: string): DocStyle | undefined {
  return doc.styles?.[id] ?? BUILT_IN_STYLES[id];
}

/** The style actually painting this block, following `activeStyleId`. */
export function resolveStyle(doc: TypeDoc, b: Block): DocStyle | undefined {
  const id = activeStyleId(doc, b);
  return id ? lookupStyle(doc, id) : undefined;
}

/**
 * Every style offered in the panel's picker: the seven built-ins in a fixed
 * order, then any custom ids the document defines that are not one of them —
 * so a hand-authored or future-tooling-written extra style is still reachable
 * even though nothing in this build creates one.
 */
export function listStyles(doc: TypeDoc): DocStyle[] {
  const ids = new Set<string>(BUILT_IN_ORDER);
  for (const id of Object.keys(doc.styles ?? {})) ids.add(id);
  const extra = [...ids].filter(id => !BUILT_IN_ORDER.includes(id)).sort();
  return [...BUILT_IN_ORDER, ...extra]
    .map(id => lookupStyle(doc, id))
    .filter((s): s is DocStyle => !!s);
}

/**
 * A CSS `color` value safe to interpolate into a `style` attribute.
 *
 * Defence in depth: parseDoc (model.ts) already validated every `doc.styles`
 * entry against the same allow-list, but this module also RENDERS, and a
 * renderer that trusts its own parser's promise instead of checking again is
 * how inline.ts's font marks stayed safe through a refactor that almost
 * dropped the parse-time check — sanitize again at the point of injection.
 */
const SAFE_STYLE_COLOR = /^(#[0-9a-fA-F]{3,8}|rgba?\([\d.,%\s]+\)|hsla?\([\d.,%\s]+\)|[a-zA-Z]{1,30})$/;
export const safeStyleColor = (raw: string | undefined): string | null => {
  const c = (raw ?? '').trim();
  return c && SAFE_STYLE_COLOR.test(c) ? c : null;
};

/**
 * A style's own typography, as CSS declarations — the STYLE alone, no
 * document defaults folded in (those already reach the paper through
 * styles.css's unconditional rules and layout.ts's `--lay-*` variables) and
 * no block-level overrides folded in either (those are layout.ts's
 * `blockStyle`, a separate mechanism — see the module header's precedence
 * diagram and `docStyleCss`/`styleSheetCss` below for the two ways this gets
 * composed with it).
 */
function styleDeclarations(s: DocStyle): string {
  const out: string[] = [];
  const fam = s.family ? safeFamily(s.family) : null;
  if (fam) out.push(`font-family:${fam}`);
  const size = s.size !== undefined ? safeSize(s.size) : null;
  if (size !== null) out.push(`font-size:${size}px`);
  if (s.weight !== undefined && Number.isFinite(s.weight)) {
    out.push(`font-weight:${Math.max(100, Math.min(900, Math.round(s.weight / 100) * 100))}`);
  }
  if (s.italic) out.push('font-style:italic');
  const color = safeStyleColor(s.color);
  if (color) out.push(`color:${color}`);
  if (s.align) out.push(`text-align:${s.align}`);
  if (s.lh !== undefined) out.push(`line-height:${s.lh}`);
  // `padding-top:0` rides with `sb`, mirroring layout.ts's blockStyle: the
  // stylesheet spaces consecutive paragraphs with a
  // `margin-top:-10px; padding-top:10px` pair (the `p + p` first-line-indent
  // trick), and setting only margin-top would leave that padding behind and
  // add 10px on top of whatever the style asked for.
  if (s.sb !== undefined) out.push(`margin-top:${s.sb}px`, 'padding-top:0');
  if (s.sa !== undefined) out.push(`margin-bottom:${s.sa}px`);
  if (s.ind !== undefined) out.push(`text-indent:${s.ind}px`);
  return out.join(';');
}

/**
 * The named style's own typography, as inline CSS — the BLOCK's resolved
 * style alone. Composed with `blockStyle(b)` from layout.ts by the caller,
 * AFTER it in the declaration order, so a property both set resolves to the
 * BLOCK's own value: later declarations win in one `style` attribute.
 *
 * USED BY PRINT ONLY (print.ts bodyHtml builds one static HTML string, once —
 * there is nothing there to clobber it afterward). The LIVE editor does NOT
 * use this — see `styleSheetCss`/`ensureStyleSheet` for why, and render.ts
 * for where the split happens. Kept exported and pure for
 * scripts/test-type-styles.ts, which is the most direct way to pin the
 * composition rule this whole module leans on.
 */
export function docStyleCss(doc: TypeDoc, b: Block): string {
  const s = resolveStyle(doc, b);
  return s ? styleDeclarations(s) : '';
}

/** A style's escaped id, safe inside a double-quoted CSS attribute selector. */
const cssAttrId = (id: string): string => id.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/**
 * Every style the document could paint, as ONE stylesheet — `[data-style-id]`
 * attribute rules, one per style that has anything to say.
 *
 * THIS is how the LIVE editor applies named styles, and the reason is a real
 * bug an earlier version of this module had: layout.ts's `applyToDom` runs on
 * its OWN MutationObserver (any childList change under the paper) and
 * unconditionally rewrites every block's `style` ATTRIBUTE from
 * `blockStyle(b)` alone — right, since that attribute is where a block's
 * OWN direct overrides live and layout.ts owns painting them. But a version
 * of this module that also wrote into that same attribute got its
 * contribution silently erased microtasks after render, the moment ANYTHING
 * re-triggered that observer (which a fresh render always does — it replaces
 * the paper's children). A stylesheet keyed by a `data-` attribute lives
 * outside the attribute layout.ts repaints and outside the subtree its
 * observer watches (the tag is a HEAD sibling, not a paper descendant), so
 * the two mechanisms can never collide — and CSS SPECIFICITY still gives the
 * right precedence for free: an inline `style` (blockStyle's) always beats
 * ANY selector from a `<style>` sheet, so a block's own formatting keeps
 * winning over its style with no coordination needed at all.
 *
 * Selectors are prefixed `.t-paper ` — not decoration, load-bearing. A bare
 * `[data-style-id="…"]` is specificity (0,1,0), and styles.css's own
 * `.t-paper h1` is (0,1,1): a class AND a type beats a lone attribute, so the
 * built-in CSS would have silently kept winning over an edited style forever.
 * `.t-paper [data-style-id="…"]` is (0,2,0), which beats `.t-paper h1` (and
 * every other single-class-plus-type rule in styles.css) while still losing,
 * correctly, to an inline `style` attribute.
 */
export function styleSheetCss(doc: TypeDoc): string {
  const parts: string[] = [];
  for (const s of listStyles(doc)) {
    const decls = styleDeclarations(s);
    if (decls) parts.push(`.t-paper [data-style-id="${cssAttrId(s.id)}"]{${decls}}`);
  }
  return parts.join('\n');
}

const STYLE_TAG_ID = 't-style-rules';

/**
 * Keep the injected stylesheet in step with the document. Idempotent (only
 * touches the DOM when the text actually changed) and safe to call on every
 * render — render.ts's `renderBody` does.
 *
 * The tag is marked `data-bento-transient`: it is runtime-injected DOM, not
 * authored content, so a save must never write it back into the file (the
 * same rule the compressed shell's own injected `<style>` follows —
 * PLATFORM.md §4).
 */
export function ensureStyleSheet(doc: TypeDoc): void {
  if (typeof document === 'undefined') return;
  let tag = document.getElementById(STYLE_TAG_ID) as HTMLStyleElement | null;
  if (!tag) {
    tag = document.createElement('style');
    tag.id = STYLE_TAG_ID;
    tag.setAttribute('data-bento-transient', '');
    document.head.appendChild(tag);
  }
  const css = styleSheetCss(doc);
  if (tag.textContent !== css) tag.textContent = css;
}

/**
 * What this paragraph looks like RIGHT NOW, block over style over document —
 * the layout.ts vocabulary alone (align/sb/sa/lh/ind), used by "Update style
 * to match this paragraph" to capture the paragraph's current appearance
 * before folding it into the style.
 */
export function effectiveLayout(doc: TypeDoc, b: Block): Required<ParaLayout> {
  const out = { ...docEffective(doc) };
  const style = resolveStyle(doc, b);
  const p = propsOf(b);
  for (const layer of [style, p]) {
    if (!layer) continue;
    for (const k of ['align', 'sb', 'sa', 'lh', 'ind'] as const) {
      const v = (layer as Partial<ParaLayout>)[k];
      if (v !== undefined) (out as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}

/**
 * Has this paragraph got DIRECT formatting of its own — the properties the
 * Layout panel (layout.ts) writes straight onto the block — regardless of
 * which style is in force? That is what makes a paragraph diverge from its
 * style, and is what the panel badges "Modified".
 */
export const hasDirectFormatting = (b: Block): boolean =>
  (['align', 'sb', 'sa', 'lh', 'ind'] as const).some(k => propsOf(b)[k] !== undefined);

// ═══════════════════════════════════════════════════════════════════ the UI

const FACE_STACKS: Array<[string, string]> = [
  ['"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif', 'Palatino (serif)'],
  ['Georgia, "Times New Roman", Times, serif', 'Georgia (serif)'],
  ['"Times New Roman", Times, serif', 'Times New Roman'],
  ['Charter, "Bitstream Charter", Cambria, Georgia, serif', 'Charter (serif)'],
  ['-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif', 'System (sans)'],
  ['Helvetica, Arial, sans-serif', 'Helvetica'],
  ['Verdana, Geneva, sans-serif', 'Verdana'],
  ['ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', 'Monospace'],
];

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
};
const row = (host: HTMLElement, label: string, control: HTMLElement): void => {
  const r = el('div', 't-sty-row');
  const s = el('span'); s.textContent = label;
  r.append(s, control);
  host.appendChild(r);
};
const select = (options: Array<[string, string]>, value: string, onChange: (v: string) => void): HTMLSelectElement => {
  const s = el('select', 't-select');
  for (const [v, label] of options) {
    const o = el('option'); o.value = v; o.textContent = label; o.selected = v === value;
    s.appendChild(o);
  }
  s.addEventListener('change', () => onChange(s.value));
  return s;
};

const styleLabel = (s: DocStyle): string => {
  switch (s.id) {
    case 'default-body': return t('Body');
    case 'default-h1': return t('Heading 1');
    case 'default-h2': return t('Heading 2');
    case 'default-h3': return t('Heading 3');
    case 'default-quote': return t('Quote');
    case 'default-ul': return t('Bulleted list');
    case 'default-ol': return t('Numbered list');
    default: return s.name;
  }
};

/**
 * Materialize a style for editing: the document's own copy if it has one,
 * else a fresh copy of the built-in (or a bare shell for an id that is
 * neither — a custom id someone applied but never defined). Never mutates;
 * the caller decides whether the result gets written back. Exported so
 * scripts/test-type-styles.ts can drive the "first edit copies the built-in"
 * behaviour without a Store or a DOM.
 */
export function materialize(doc: TypeDoc, id: string, kind: BlockKind): DocStyle {
  const found = lookupStyle(doc, id);
  return found ? { ...found } : { id, kind, name: id };
}

/** `materialize`, then a patch on top — the pure half of every style edit. */
export function mergeStyle(doc: TypeDoc, id: string, kind: BlockKind, patch: Partial<DocStyle>): DocStyle {
  return { ...materialize(doc, id, kind), ...patch };
}

/** Write a patch onto a style, creating (materializing) it if needed. ONE commit. */
function patchStyle(ctx: FeatureContext, id: string, kind: BlockKind, patch: Partial<DocStyle>): void {
  ctx.store.commit(d => { d.styles = { ...(d.styles ?? {}), [id]: mergeStyle(d, id, kind, patch) }; });
  ctx.refresh();
}

/**
 * The patch "Update style to match this paragraph" would write, captured
 * PURELY from the model — no store, no DOM, so scripts/test-type-styles.ts
 * can assert it directly.
 *
 * Takes the paragraph's CURRENT effective align/sb/sa/lh/ind (block over
 * style over document — effectiveLayout) and, when every character agrees on
 * one, its family/size. Undefined (no active style at all — a kind with no
 * default, and no explicit styleId) returns null.
 */
export function captureStyleFromBlock(doc: TypeDoc, b: Block): Partial<DocStyle> | null {
  const id = activeStyleId(doc, b);
  if (!id) return null;
  const eff = effectiveLayout(doc, b);
  const font = fontAcross(b.marks ?? [], 0, b.text.length);
  const patch: Partial<DocStyle> = { align: eff.align, sb: eff.sb, sa: eff.sa, lh: eff.lh, ind: eff.ind };
  // fontAcross's 'mixed' IS a string (and not a number), so a plain
  // typeof-check would wrongly capture the literal word "mixed" as a font
  // family the moment a block held more than one font — exclude it explicitly.
  if (typeof font.family === 'string' && font.family !== 'mixed') patch.family = font.family;
  if (typeof font.size === 'number') patch.size = font.size;
  return patch;
}

/**
 * "Update style to match this paragraph" — the workflow that makes a styles
 * system worth having: nobody opens a typography dialog first, they format
 * one paragraph until it looks right and then say "make this the style".
 * The patch itself is `captureStyleFromBlock`; this is only the commit —
 * write it into the active style, then clear the block's own direct
 * overrides, since they now equal the style exactly and the paragraph should
 * stop reading as "modified".
 */
function updateStyleToMatch(ctx: FeatureContext, b: Block): void {
  const id = activeStyleId(ctx.store.doc, b);
  const patch = captureStyleFromBlock(ctx.store.doc, b);
  if (!id || !patch) return;
  ctx.store.commit(d => {
    d.styles = { ...(d.styles ?? {}), [id]: mergeStyle(d, id, b.kind, patch) };
    const blk = d.body.find(x => x.id === b.id);
    if (blk) for (const k of ['align', 'sb', 'sa', 'lh', 'ind'] as const) delete blk[k];
  });
  ctx.refresh();
  ctx.toast(t('Style updated from this paragraph'));
}

// t() at call time, never frozen into a module-level const — the codebase's
// one repeated i18n rule (see CLAUDE.md): a const built at import time is
// built before the viewer's locale resolves.
const weightOptions = (): Array<[string, string]> => [
  ['', t('Default')], ['400', t('Regular')], ['500', t('Medium')],
  ['600', t('Semibold')], ['700', t('Bold')],
];

/**
 * The "Styles" section of the properties panel — mounted by props.ts, which
 * owns the panel's overall assembly and calls this for any block whose kind
 * has a default style (`DEFAULT_STYLE_ID`). A kind with no default (a
 * picture, a table cell, a caption…) gets no section: there is nothing here
 * for it to apply.
 */
export function stylesSection(host: HTMLElement, ctx: FeatureContext, b: Block): void {
  if (!DEFAULT_STYLE_ID[b.kind]) return;
  const doc = ctx.store.doc;
  const activeId = activeStyleId(doc, b)!;
  const active = lookupStyle(doc, activeId);

  const h = el('div', 't-section');
  h.textContent = t('Style');
  if (hasDirectFormatting(b)) {
    const badge = el('span', 't-sty-badge');
    badge.textContent = t('Modified');
    badge.title = t('This paragraph has direct formatting of its own, on top of its style.');
    h.appendChild(badge);
  }
  const body = el('div', 't-sec-body');
  host.append(h, body);

  // ---- which style this block uses
  const defaultId = DEFAULT_STYLE_ID[b.kind]!;
  const options: Array<[string, string]> = listStyles(doc).map(s => [s.id, styleLabel(s)]);
  row(body, t('Applied style'), select(options, activeId, v => {
    ctx.store.commit(d => {
      const blk = d.body.find(x => x.id === b.id);
      if (!blk) return;
      // "absent means the default" — the same rule the paragraph properties
      // already follow (layout.ts): choosing the kind's own default deletes
      // `styleId` rather than writing it, so an untouched document keeps
      // writing nothing extra.
      if (v === defaultId) delete blk.styleId; else blk.styleId = v;
    }, { scope: { block: b.id } });
    ctx.refresh();
  }));

  if (hasDirectFormatting(b)) {
    const clear = el('button', 't-btn') as HTMLButtonElement;
    clear.type = 'button';
    clear.textContent = t('Clear direct formatting');
    clear.addEventListener('click', () => {
      ctx.store.commit(d => {
        const blk = d.body.find(x => x.id === b.id);
        if (!blk) return;
        for (const k of ['align', 'sb', 'sa', 'lh', 'ind'] as const) delete blk[k];
      }, { scope: { block: b.id } });
      ctx.refresh();
    });
    const wrap = el('div', 't-toggles');
    wrap.appendChild(clear);
    body.appendChild(wrap);
  }

  // ---- the active style's own typography — editing it repaints EVERY block
  // that uses this style, explicitly or as its kind's default.
  const editHead = el('div', 't-section');
  editHead.textContent = t('Edit “{name}”', { name: styleLabel(active ?? { id: activeId, kind: b.kind, name: activeId }) });
  const edit = el('div', 't-sec-body');
  host.append(editHead, edit);

  const faceOptions: Array<[string, string]> = [['', t('Document default')], ...FACE_STACKS];
  row(edit, t('Typeface'), select(faceOptions, active?.family ?? '', v =>
    patchStyle(ctx, activeId, b.kind, { family: v || undefined })));

  const sizeIn = el('input', 't-field') as HTMLInputElement;
  sizeIn.type = 'number';
  sizeIn.value = active?.size === undefined ? '' : String(active.size);
  sizeIn.placeholder = t('default');
  sizeIn.addEventListener('change', () => {
    const raw = sizeIn.value.trim();
    const v = raw === '' ? undefined : Number(raw);
    patchStyle(ctx, activeId, b.kind, { size: v !== undefined && Number.isFinite(v) ? v : undefined });
  });
  row(edit, t('Size (px)'), sizeIn);

  row(edit, t('Weight'), select(weightOptions(), active?.weight === undefined ? '' : String(active.weight), v =>
    patchStyle(ctx, activeId, b.kind, { weight: v === '' ? undefined : Number(v) })));

  const italicBox = el('input') as HTMLInputElement;
  italicBox.type = 'checkbox';
  italicBox.checked = active?.italic === true;
  italicBox.addEventListener('change', () =>
    patchStyle(ctx, activeId, b.kind, { italic: italicBox.checked ? true : undefined }));
  row(edit, t('Italic'), italicBox);

  const colorRow = el('div', 't-sty-row');
  const colorLabel = el('span'); colorLabel.textContent = t('Colour');
  const colorIn = el('input', 't-sty-color') as HTMLInputElement;
  colorIn.type = 'color';
  colorIn.value = /^#[0-9a-fA-F]{6}$/.test(active?.color ?? '') ? active!.color! : '#1a1a1a';
  colorIn.addEventListener('change', () => patchStyle(ctx, activeId, b.kind, { color: colorIn.value }));
  const colorClear = el('button', 't-btn') as HTMLButtonElement;
  colorClear.type = 'button';
  colorClear.textContent = t('Default');
  colorClear.addEventListener('click', () => patchStyle(ctx, activeId, b.kind, { color: undefined }));
  colorRow.append(colorLabel, colorIn, colorClear);
  edit.appendChild(colorRow);

  const ALIGN_OPTS: Array<[string, string]> = [
    ['', t('Document default')], ['left', t('Left')], ['center', t('Centre')],
    ['right', t('Right')], ['justify', t('Justified')],
  ];
  row(edit, t('Alignment'), select(ALIGN_OPTS, active?.align ?? '', v =>
    patchStyle(ctx, activeId, b.kind, { align: (v || undefined) as DocStyle['align'] })));

  const px = (label: string, key: 'sb' | 'sa' | 'ind') => {
    const i = el('input', 't-field') as HTMLInputElement;
    i.type = 'number';
    i.value = active?.[key] === undefined ? '' : String(active[key]);
    i.placeholder = t('default');
    i.addEventListener('change', () => {
      const raw = i.value.trim();
      const v = raw === '' ? undefined : Number(raw);
      patchStyle(ctx, activeId, b.kind, { [key]: v !== undefined && Number.isFinite(v) ? v : undefined });
    });
    row(edit, label, i);
  };
  px(t('Space before (px)'), 'sb');
  px(t('Space after (px)'), 'sa');
  px(t('First-line indent (px)'), 'ind');

  const lhIn = el('input', 't-field') as HTMLInputElement;
  lhIn.type = 'number';
  lhIn.step = '0.01';
  lhIn.value = active?.lh === undefined ? '' : String(active.lh);
  lhIn.placeholder = t('default');
  lhIn.addEventListener('change', () => {
    const raw = lhIn.value.trim();
    const v = raw === '' ? undefined : Number(raw);
    patchStyle(ctx, activeId, b.kind, { lh: v !== undefined && Number.isFinite(v) ? v : undefined });
  });
  row(edit, t('Line spacing'), lhIn);

  const actions = el('div', 't-sty-actions');
  const updateBtn = el('button', 't-btn') as HTMLButtonElement;
  updateBtn.type = 'button';
  updateBtn.textContent = t('Update style to match this paragraph');
  updateBtn.title = t('Take this paragraph’s current formatting and make it the style — every paragraph using this style follows.');
  updateBtn.addEventListener('click', () => updateStyleToMatch(ctx, b));
  actions.appendChild(updateBtn);
  edit.appendChild(actions);

  const note = el('p', 't-note');
  note.textContent = t('Editing a style changes every paragraph that uses it — including ones that never set a style explicitly and are just using their kind’s default.');
  edit.appendChild(note);
}
