// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The properties panel — what the thing under the caret IS, and how to change it.
//
// THE SUITE'S DIVISION, and it is not a matter of taste: the top bar holds
// ACTIONS, the right panel holds PROPERTIES. slides does exactly this — its bar
// inserts and its panel describes, with Typography, Fill & stroke and Position
// & size all panel sections that change with the selection
// (slides/src/editor/panels.ts). type had drifted into putting properties in
// the bar, one control at a time, until the bar was permanently folded.
//
// CONTEXTUAL means the panel answers a question about the current block. Put the
// caret in a paragraph and it offers the paragraph's style and its character
// formatting; put it in a table cell and a Table section appears; select a
// picture and its width, alignment and alt text appear. Nothing is shown for a
// thing that is not there — a panel of permanently disabled controls teaches
// people to stop reading it.
//
// It rebuilds on the SELECTION signal as well as the document one, because
// moving the caret from a paragraph into a cell changes what should be shown
// without changing a byte of the document.

import { registerPanel, registerSelection, type FeatureContext } from './features.ts';
import { MARK_TOOLS } from './marks.ts';
import { t } from './i18n.ts';
import { MAX_TABLE_COLS, type Block, type BlockKind } from './model.ts';
import { PAPER, openPageSetup, withSize, withOrientation, type SizeId } from './layout.ts';
import { isHeading, EXCLUDE_ROLE, sectionSettings, setNumbered, toggleExclude } from './toc.ts';
import { ensureAuthor } from './comments.ts';
import { stylesSection } from './docstyles.ts';
// docstyles.ts's own panel styling — imported here rather than there so the
// node test rigs, which load model.ts → comments.ts → render.ts → docstyles.ts
// with no bundler in front of them, never meet a bare `.css` import. props.ts
// is UI-only and reached only through features.ts, which no rig imports.
import './docstyles.css';

// ─────────────────────────────────────────────────────────────── small parts

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
};

/** A titled group. Sections are the panel's grammar — one per kind of thing. */
function section(host: HTMLElement, title: string): HTMLElement {
  const h = el('div', 't-section');
  h.textContent = title;
  const body = el('div', 't-sec-body');
  host.append(h, body);
  return body;
}

/** A labelled row: the name on the left, the control right-aligned. */
function row(host: HTMLElement, label: string, control: HTMLElement): HTMLElement {
  const r = el('div', 't-row');
  const s = el('span');
  s.textContent = label;
  r.append(s, control);
  host.appendChild(r);
  return r;
}

/** A cluster of toggle buttons, e.g. bold / italic / underline. */
function toggles(
  host: HTMLElement,
  items: Array<{ icon: string; title: string; on: boolean; run: () => void }>,
): void {
  const g = el('div', 't-toggles');
  for (const it of items) {
    const b = el('button', 't-btn' + (it.on ? ' on' : ''));
    b.type = 'button';
    b.innerHTML = it.icon;
    b.title = it.title;
    // mousedown, not click: the caret must survive pressing a formatting button
    b.addEventListener('mousedown', e => { e.preventDefault(); it.run(); });
    g.appendChild(b);
  }
  host.appendChild(g);
}

function select(
  options: Array<[string, string]>, value: string, onChange: (v: string) => void,
): HTMLSelectElement {
  const s = el('select', 't-select');
  for (const [v, label] of options) {
    const o = el('option');
    o.value = v; o.textContent = label; o.selected = v === value;
    s.appendChild(o);
  }
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

function numberField(value: number | undefined, placeholder: string,
                     onCommit: (v: number | undefined) => void): HTMLInputElement {
  const i = el('input', 't-field');
  i.type = 'number';
  i.value = value === undefined ? '' : String(value);
  i.placeholder = placeholder;
  i.addEventListener('change', () => {
    const raw = i.value.trim();
    onCommit(raw === '' ? undefined : Number(raw));
  });
  return i;
}

// ────────────────────────────────────────────────────────────────── sections

/** The block under the caret, or undefined. */
function current(ctx: FeatureContext): Block | undefined {
  const c = ctx.editor.caret();
  return c ? ctx.store.block(c.id) : undefined;
}

/**
 * Faces that resolve everywhere without shipping a font file. Exported so
 * docstyles.ts's typeface picker offers the SAME list rather than a second
 * hand-copied one that drifts from this the first time someone edits either.
 */
export const FACES: Array<[string, string]> = [
  ['"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif', 'Palatino (serif)'],
  ['Georgia, "Times New Roman", Times, serif', 'Georgia (serif)'],
  ['"Times New Roman", Times, serif', 'Times New Roman'],
  ['Charter, "Bitstream Charter", Cambria, Georgia, serif', 'Charter (serif)'],
  ['-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif', 'System (sans)'],
  ['Helvetica, Arial, sans-serif', 'Helvetica'],
  ['Verdana, Geneva, sans-serif', 'Verdana'],
  ['ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', 'Monospace'],
];

const STYLE_OPTIONS: Array<[BlockKind, string]> = [
  ['para', 'Body'], ['h1', 'Title'], ['h2', 'Heading'], ['h3', 'Subheading'],
  ['quote', 'Quote'], ['ul', 'Bulleted list'], ['ol', 'Numbered list'],
];

function textSection(host: HTMLElement, ctx: FeatureContext, b: Block): void {
  const body = section(host, t('Text'));
  row(body, t('Style'), select(
    STYLE_OPTIONS.map(([v, l]) => [v, t(l)] as [string, string]),
    b.kind,
    v => onSelection(ctx, () => ctx.editor.setKind(v as BlockKind)),
  ));

  // ONE list, in marks.ts, rendered here and in the selection toolbar. It was
  // written out twice before, and a third copy was about to be written.
  const active = ctx.editor.activeMarks() as Set<string>;
  toggles(body, MARK_TOOLS.map(m => ({
    icon: m.icon, title: m.title(), on: active.has(m.t), run: () => ctx.editor.toggle(m.t),
  })));

  // ---- typeface and size, for the SELECTION.
  //
  // A font is a character property: "make these three words Verdana" is the
  // request, and the Document section's typeface is the DEFAULT these fall
  // back to — the same relationship the paragraph controls already have with
  // "Use document defaults" beneath them.
  //
  // Both controls are disabled without a selection, because there is nothing
  // for them to act on: applying a font at a bare caret would either do
  // nothing or silently restyle the whole paragraph, and a control that looks
  // available and does nothing is worse than one that says it cannot.
  const sel = ctx.editor.fontOfSelection();
  const hasRange = (() => { const c = ctx.editor.caret(); return !!c && c.to !== undefined && c.to !== c.at; })();

  const MIXED = '\u0000mixed';
  const DEFAULT = '';
  const faceOptions: Array<[string, string]> = [
    [DEFAULT, t('Document default')],
    ...FACES.map(([v, l]) => [v, l] as [string, string]),
  ];
  if (sel.family === 'mixed') faceOptions.unshift([MIXED, t('— mixed —')]);
  // A family the document uses but this build does not list — from another
  // editor, or a later version — is shown rather than silently relabelled as
  // the default, which would rewrite it on the next click.
  if (typeof sel.family === 'string' && sel.family !== 'mixed'
      && !FACES.some(([v]) => v === sel.family)) faceOptions.push([sel.family, sel.family]);

  const faceSel = select(faceOptions,
    sel.family === 'mixed' ? MIXED : (sel.family ?? DEFAULT),
    v => {
      if (v === MIXED) return;
      onSelection(ctx, () => ctx.editor.setFontOn({ family: v === DEFAULT ? null : v }));
    });
  (faceSel as HTMLSelectElement).disabled = !hasRange;
  row(body, t('Typeface'), faceSel);

  const sizeField = numberField(
    typeof sel.size === 'number' ? sel.size : undefined,
    sel.size === 'mixed' ? t('mixed') : t('default'),
    v => onSelection(ctx, () => ctx.editor.setFontOn({ size: v === undefined ? null : v })));
  (sizeField as HTMLInputElement).disabled = !hasRange;
  row(body, t('Size (px)'), sizeField);

  // A disabled control that does not say why it is disabled is indistinguishable
  // from a broken one — and this pair sits at the TOP of the panel, so it is the
  // first thing reached for after clicking into a paragraph. Reported as "the
  // dropdowns are not working", which is exactly right from the outside.
  if (!hasRange) {
    const why = el('p', 't-note');
    why.textContent = t('Select some text to change its typeface or size. The document default is below.');
    body.appendChild(why);
  }

  // Whether THIS heading is numbered is a property of the heading, so it is a
  // checkbox here rather than the ⋯ entry it used to be — an action named "Do
  // not number this heading" gave no way to see the current state, only a way
  // to flip it, and no way at all to tell which heading it would act on.
  //
  // Shown only when the document numbers its sections: with numbering off there
  // is nothing to exclude a heading from, and a control that cannot do anything
  // is worse than an absent one.
  if (isHeading(b) && sectionSettings(ctx.store.doc).numbered) {
    const box = el('input') as HTMLInputElement;
    box.type = 'checkbox';
    box.checked = (b.role ?? '') !== EXCLUDE_ROLE;
    box.addEventListener('change', () => toggleExclude(ctx));
    row(body, t('Number this heading'), box);
  }
}

function imageSection(host: HTMLElement, ctx: FeatureContext, b: Block): void {
  const body = section(host, t('Picture'));
  const im = b.image;
  if (!im) return;

  // WIDTH IS A PERCENTAGE of the text measure, because that is what the model
  // stores — a fraction, not pixels, so the picture still fits when the page
  // size changes. Showing pixels here would invite a value that stops being
  // right the moment somebody switches to A4.
  const w = numberField(im.w === undefined ? undefined : Math.round(im.w * 100), '100', v => {
    ctx.store.commit(d => {
      const t2 = d.body.find(x => x.id === b.id);
      if (!t2?.image) return;
      if (v === undefined || !(v > 0) || v > 100) delete t2.image.w;
      else t2.image.w = v / 100;
    }, { scope: { block: b.id } });
    ctx.refresh();
  });
  row(body, t('Width (%)'), w);

  row(body, t('Align'), select(
    [['left', t('Left')], ['center', t('Centre')], ['right', t('Right')]],
    im.align ?? 'center',
    v => {
      ctx.store.commit(d => {
        const t2 = d.body.find(x => x.id === b.id);
        if (t2?.image) t2.image.align = v as 'left' | 'center' | 'right';
      }, { scope: { block: b.id } });
      ctx.refresh();
    },
  ));

  const alt = el('input', 't-field t-field-wide');
  alt.value = im.alt ?? '';
  alt.placeholder = t('What the picture shows');
  alt.addEventListener('change', () => {
    ctx.store.commit(d => {
      const t2 = d.body.find(x => x.id === b.id);
      if (t2?.image) t2.image.alt = alt.value;
    }, { scope: { block: b.id } });
  });
  row(body, t('Alt text'), alt);
  const note = el('p', 't-note');
  // Alt text is not decoration: it is what a screen reader says, what search
  // finds, and what survives when the picture does not (parseDoc keeps it as
  // the paragraph text when a source is unusable).
  note.textContent = t('Read aloud by screen readers, and kept as the text if the picture is ever lost.');
  body.appendChild(note);
}

/** Every cell of the table the caret is in, in document order. */
function tableCells(ctx: FeatureContext, b: Block): Block[] {
  const id = b.cell?.table;
  if (!id) return [];
  return ctx.store.doc.body.filter(x => x.kind === 'cell' && x.cell?.table === id);
}

function tableSection(host: HTMLElement, ctx: FeatureContext, b: Block): void {
  const body = section(host, t('Table'));
  const cells = tableCells(ctx, b);
  const cols = b.cell?.cols ?? 1;
  const rows = Math.ceil(cells.length / cols);

  const info = el('p', 't-note');
  info.textContent = t('{rows} rows × {cols} columns', { rows, cols });
  body.appendChild(info);

  const headOn = !!cells[0]?.cell?.head;
  const head = el('input');
  head.type = 'checkbox';
  head.checked = headOn;
  head.addEventListener('change', () => {
    ctx.store.commit(d => {
      const all = d.body.filter(x => x.kind === 'cell' && x.cell?.table === b.cell!.table);
      all.slice(0, cols).forEach(c => {
        if (!c.cell) return;
        if (head.checked) c.cell.head = true; else delete c.cell.head;
      });
    });
    ctx.refresh();
  });
  row(body, t('Header row'), head);

  const addRow = el('button', 't-btn');
  addRow.type = 'button';
  addRow.textContent = t('Add row');
  addRow.addEventListener('click', () => {
    ctx.store.commit(d => {
      const all = d.body.filter(x => x.kind === 'cell' && x.cell?.table === b.cell!.table);
      const last = d.body.indexOf(all[all.length - 1]);
      const fresh: Block[] = Array.from({ length: cols }, (_, i) => ({
        id: `${b.cell!.table}-r${Date.now().toString(36)}-${i}`,
        kind: 'cell' as const, text: '', cell: { table: b.cell!.table, cols },
      }));
      d.body.splice(last + 1, 0, ...fresh);
    });
    ctx.refresh();
  });

  const addCol = el('button', 't-btn');
  addCol.type = 'button';
  addCol.textContent = t('Add column');
  addCol.disabled = cols >= MAX_TABLE_COLS;
  addCol.addEventListener('click', () => {
    // Adding a column means inserting one cell per ROW and re-stamping `cols`
    // on every cell — the count is repeated on each one deliberately, so a run
    // of cells can always rebuild its own grid.
    ctx.store.commit(d => {
      const all = d.body.filter(x => x.kind === 'cell' && x.cell?.table === b.cell!.table);
      const next = cols + 1;
      for (let r = rows - 1; r >= 0; r--) {
        const lastOfRow = all[r * cols + cols - 1];
        const at = d.body.indexOf(lastOfRow);
        d.body.splice(at + 1, 0, {
          id: `${b.cell!.table}-c${Date.now().toString(36)}-${r}`,
          kind: 'cell', text: '',
          cell: { table: b.cell!.table, cols: next, ...(r === 0 && all[0]?.cell?.head ? { head: true } : {}) },
        });
      }
      for (const c of d.body) if (c.kind === 'cell' && c.cell?.table === b.cell!.table) c.cell.cols = next;
    });
    ctx.refresh();
  });

  const btns = el('div', 't-toggles');
  btns.append(addRow, addCol);
  body.appendChild(btns);
}

function captionSection(host: HTMLElement, ctx: FeatureContext, b: Block): void {
  const body = section(host, t('Caption'));
  row(body, t('Numbered as'), select(
    [['table', t('Table')], ['figure', t('Figure')]],
    b.caption?.kind ?? 'table',
    v => {
      ctx.store.commit(d => {
        const t2 = d.body.find(x => x.id === b.id);
        if (t2?.caption) t2.caption.kind = v as 'table' | 'figure';
      }, { scope: { block: b.id } });
      ctx.refresh();
    },
  ));
  const note = el('p', 't-note');
  note.textContent = t('Tables and figures are numbered separately, in document order.');
  body.appendChild(note);
}

/**
 * Faces that resolve everywhere without shipping a font file.
 *
 * A self-contained document cannot fetch a webfont — the whole promise is that
 * the file works from a memory stick in 2036 — so these are STACKS chosen so
 * that every platform lands on something close. Embedding a real face is the
 * separate `doc.fonts` field, which is how a house typeface would travel.
 */


function documentSection(host: HTMLElement, ctx: FeatureContext): void {
  const body = section(host, t('Document'));
  const doc = ctx.store.doc;

  // ---- typeface. A DOCUMENT property: a contract is typeset, and the person
  // who wrote it chose how it reads. The theme follows the reader; type does not.
  // "Default typeface", not "Typeface". The Text section above has a Typeface
  // row too, and two identically-labelled controls — one of them inert unless
  // text is selected — is how a working panel reads as a broken one.
  row(body, t('Default typeface'), select(
    FACES.map(([v, l]) => [v, l] as [string, string]),
    doc.type?.family ?? FACES[0][0],
    v => {
      ctx.store.commit(d => { d.type = { ...d.type, family: v }; });
      ctx.refresh();
    },
  ));
  row(body, t('Default size (px)'), numberField(doc.type?.size ?? 17, '17', v => {
    ctx.store.commit(d => {
      if (v === undefined || !(v >= 6 && v <= 96)) delete d.type?.size;
      else d.type = { ...d.type, size: v };
    });
    ctx.refresh();
  }));

  // ---- page
  const sizeId = (Object.keys(PAPER) as SizeId[])
    .find(id => PAPER[id].width === doc.page.width && PAPER[id].height === doc.page.height)
    ?? (Object.keys(PAPER) as SizeId[])
      .find(id => PAPER[id].height === doc.page.width && PAPER[id].width === doc.page.height);
  row(body, t('Page size'), select(
    (Object.keys(PAPER) as SizeId[]).map(id => [id, id] as [string, string]),
    sizeId ?? '',
    v => { ctx.store.commit(d => { d.page = withSize(d.page, v as SizeId); }); ctx.refresh(); },
  ));
  row(body, t('Orientation'), select(
    [['portrait', t('Portrait')], ['landscape', t('Landscape')]],
    doc.page.width > doc.page.height ? 'landscape' : 'portrait',
    v => {
      ctx.store.commit(d => { d.page = withOrientation(d.page, v as 'portrait' | 'landscape'); });
      ctx.refresh();
    },
  ));

  // Margins stay behind the dialog: four numbers with live validation is more
  // than a panel row, and it is the one thing here nobody sets twice.
  const more = el('button', 't-btn');
  more.type = 'button';
  more.textContent = t('Margins…');
  more.addEventListener('click', () => openPageSetup(ctx));
  const wrap = el('div', 't-toggles');
  wrap.appendChild(more);
  body.appendChild(wrap);

  // ---- numbering
  const num = el('input');
  num.type = 'checkbox';
  num.checked = sectionSettings(doc).numbered;
  num.addEventListener('change', () => {
    ctx.store.commit(d => setNumbered(d, num.checked));
    ctx.refresh();
  });
  row(body, t('Number sections'), num);

  // ---- tracked changes. A DOCUMENT property, so it sits here beside the other
  // document properties rather than in ⋯: it has a state, everyone working on
  // the file shares it, and an action could only offer to flip it.
  const trk = el('input') as HTMLInputElement;
  trk.type = 'checkbox';
  trk.checked = doc.track === true;
  trk.addEventListener('change', () => {
    // Ask for a name at the moment tracking is switched ON — the one place a
    // prompt is expected. Every keystroke afterwards is attributed silently.
    if (trk.checked) ensureAuthor();
    ctx.store.commit(d => { if (trk.checked) d.track = true; else delete d.track; });
    ctx.refresh();
  });
  row(body, t('Track changes'), trk);
  const note = el('p', 't-note');
  note.textContent = t('Off by default: most documents already carry their numbers in the heading text.');
  body.appendChild(note);
}

// ──────────────────────────────────────────────────────────────── the panel

function build(host: HTMLElement, ctx: FeatureContext): void {
  host.replaceChildren();
  const b = current(ctx);
  if (!b) {
    // No caret: the document's own properties are still worth showing, and are
    // the ones you reach for before you start typing.
    documentSection(host, ctx);
    return;
  }
  // Order is stability, not importance: Text is always there, so it is always
  // first, and the contextual sections appear beneath it rather than pushing it
  // around as the caret moves.
  textSection(host, ctx, b);
  // Named styles — a SEPARATE section from Text's "Style" dropdown above: that
  // one picks the block's KIND (which tag it is); this one picks how that kind
  // LOOKS, which used to be a build constant (styles.css) and is now a
  // document property. docstyles.ts no-ops for kinds with no default style.
  stylesSection(host, ctx, b);
  if (b.kind === 'image') imageSection(host, ctx, b);
  if (b.kind === 'cell') tableSection(host, ctx, b);
  if (b.kind === 'caption') captionSection(host, ctx, b);
  // The document's own properties last: they are the ones you set once, so
  // they should not push what you are working on down the panel.
  documentSection(host, ctx);
}

/**
 * The last selection the user made IN THE DOCUMENT, and the way panel controls
 * act on it.
 *
 * The formatting buttons in this panel preventDefault on mousedown, so focus
 * never leaves the paper and the selection survives being clicked. A native
 * <select> cannot do that — it has to take focus to open its list, and the
 * document selection goes with it. The result was that choosing a typeface
 * worked once and then left you with nothing selected, so a second property
 * could not be applied to the same words without re-selecting them.
 *
 * So the panel remembers the range while the caret is still in the document,
 * restores it around the action, and restores it again afterwards — the user
 * keeps the words they selected and can keep working on them.
 */
type Remembered = { id: string; at: number; to?: number };
let lastRange: Remembered | null = null;

function rememberSelection(host: HTMLElement, ctx: FeatureContext): void {
  // While the panel holds focus the live selection is gone, and reading it
  // would overwrite the very thing being preserved.
  if (host.contains(document.activeElement)) return;
  const c = ctx.editor.caret();
  if (c) lastRange = { id: c.id, at: c.at, to: c.to };
}

function onSelection(ctx: FeatureContext, run: () => void): void {
  if (lastRange) ctx.editor.setCaret(lastRange);
  run();
  // The REFRESH happens here, inside, and that ordering is the whole point:
  // ctx.refresh() re-renders the body, which wipes any selection set before
  // it. Restoring first and refreshing afterwards — which is what the call
  // sites used to do — put the range back and then threw it away a
  // millisecond later, so the action worked and the words still looked
  // unselected.
  ctx.refresh();
  if (!lastRange) return;
  // A DOM selection set while a form control holds focus does not stick: the
  // action worked, but the words stopped LOOKING selected, which reads as the
  // selection having been lost even though the next property still applies to
  // it. So a <select> that has just committed hands focus back to the
  // document, where the highlight is visible again.
  //
  // Only a <select>: picking an option IS the end of that interaction. A text
  // field fires `change` on blur too, and yanking focus there would eject
  // someone who is still typing.
  const active = document.activeElement as HTMLElement | null;
  if (active?.tagName === 'SELECT') {
    // FOCUS FIRST, then set the range. setCaret only calls addRange, and a
    // selection placed inside a contenteditable that does not have focus is
    // not kept by the browser — the range went in and getSelection() came back
    // empty, so the words still did not look selected.
    active.blur();
    ctx.editor.host.focus();
  }
  ctx.editor.setCaret(lastRange);
}

/**
 * What the panel actually depends on: the block under the caret, the range,
 * and the marks over it. Anything else changing is not a reason to rebuild.
 */
function signature(ctx: FeatureContext): string {
  const c = ctx.editor.caret();
  if (!c) return 'none';
  const b = ctx.store.block(c.id);
  const marks = [...(ctx.editor.activeMarks() as Set<string>)].sort().join(',');
  return `${c.id}:${c.at}:${c.to ?? ''}:${b?.kind ?? ''}:${b?.styleId ?? ''}:${marks}`;
}
let last = '';

/**
 * Rebuild only when it would show something different — and never while the
 * pointer or keyboard is inside the panel.
 *
 * REBUILDING FED ITSELF. `build()` calls host.replaceChildren(), which destroys
 * and recreates this panel's inputs and selects; destroying a form control
 * fires `selectionchange` on the document, which is the very signal that
 * triggered the rebuild. With a text selection present the loop ran at ~179
 * selection events and ~4,900 panel mutations PER SECOND, forever, burning CPU
 * the whole time.
 *
 * The visible symptom was that no dropdown in this panel could be opened while
 * text was selected: the <select> the user clicked was destroyed and replaced
 * within milliseconds, so the native popup closed instantly. Reported exactly
 * that way, and the loop is why.
 *
 * The activeElement guard is the second half and matters on its own: even one
 * legitimate rebuild, arriving while a dropdown is open, would close it.
 */
function rebuild(host: HTMLElement, ctx: FeatureContext): void {
  if (host.contains(document.activeElement)) return;
  const sig = signature(ctx);
  if (sig === last) return;
  last = sig;
  build(host, ctx);
}

registerPanel({
  id: 'props',
  label: () => t('Properties'),
  side: 'right',
  order: 10,
  mount(host, ctx) {
    build(host, ctx);
    registerSelection(() => { rememberSelection(host, ctx); rebuild(host, ctx); });
  },
  update(host, ctx) { last = ''; rebuild(host, ctx); },
});
