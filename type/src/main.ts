// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Boot. Read the embedded document, build the store and the editor, wire the
// chrome. Kernel integration (save splice, autosave, encryption, signed
// updates, i18n) comes next — PLATFORM §10.

import './styles.css';
import { configureApp } from '../../kernel/src/app.ts';
import {
  capturePristine, readEmbeddedDoc, saveFile, currentFileName, canWriteInPlace,
} from '../../kernel/src/save.ts';
import { ICONS } from './icons.ts';
import { t } from './i18n.ts';
import { tools, menuItems, panels, matchKey, readyFns, paginatedFns, text as labelText, type FeatureContext } from './features.ts';
import './registry.ts';   // side-effect: every feature module registers itself
import { i18nApi } from '../../kernel/src/i18n.ts';
import { openAbout } from './about.ts';
import { startTheme, setTheme, themeChoice, type ThemeChoice } from '../../kernel/src/theme.ts';
import { parseDoc, emptyDoc, uid, wordCount, type TypeDoc } from './model.ts';
import { Store } from './store.ts';
import { Editor } from './editor.ts';
import { paginate, drawPages, type Metrics } from './paginate.ts';
import { redline, apply as applyRedline, describe, type ChangeSet } from './redline.ts';
import { printDocument, buildPrintDocument } from './print.ts';
import { sign as signDoc, verifyChain, newKey } from './canon.ts';
import { uid as newId } from './model.ts';
import type { MarkType } from './inline.ts';

// Tell the kernel who this app is — must precede any kernel module use
// (window title suffix, save-picker label, update manifest).
configureApp({
  appId: 'bento-type',
  appName: 'bento/type',
  manifestUrl: 'https://bento.page/releases/type/manifest.json',
});

// The pristine capture must happen BEFORE any DOM mutation: saves re-serialize
// the captured clone, so anything the app injects afterwards (theme attributes,
// the editor's rendered blocks, measuring probes) never reaches a saved file.
capturePristine();

// Theme after the capture, for exactly that reason — `data-theme` is a viewer
// preference and must not travel in the document.
startTheme();

// ───────────────────────────────────────────────────────────── the document

const SAMPLE: Array<[string, string]> = [
  ['h1', 'Master Services Agreement'],
  ['h2', '1. Scope of Work'],
  ['para', 'The Supplier shall provide the services described in Schedule A, exercising the degree of skill and care reasonably expected of a professional supplier of comparable services. Where Schedule A conflicts with this agreement, this agreement governs.'],
  ['para', 'The Supplier may not subcontract any part of the services without the prior written consent of the Customer, such consent not to be unreasonably withheld or delayed.'],
  ['h2', '2. Fees and Payment'],
  ['para', 'Payment is due within 30 days of invoice, without set-off. Invoices shall be issued monthly in arrears and shall itemise the services performed during the period to which they relate.'],
  ['quote', 'Time for payment is of the essence.'],
  ['h2', '3. Limitation of Liability'],
  ['para', 'Subject to the foregoing, the total aggregate liability of each party under this agreement shall not exceed the total fees paid in the twelve months preceding the event giving rise to the claim.'],
];

function sampleDoc(): TypeDoc {
  const d = emptyDoc();
  d.title = 'Master Services Agreement';
  d.meta = { author: 'A. Nyblom', company: 'Example Ltd' };
  d.body = SAMPLE.map(([kind, text]) => ({ id: uid(), kind: kind as never, text }));
  // one bold run and one footnote, so both mechanisms are visible on open
  const pay = d.body.find(b => b.text.includes('30 days'))!;
  const at = pay.text.indexOf('30 days');
  pay.marks = [{ t: 'b', from: at, to: at + '30 days'.length }];
  const nid = uid('n');
  d.footnotes[nid] = 'Time runs from receipt of a valid invoice at the address in Schedule B.';
  pay.notes = [{ id: nid, at: pay.text.indexOf('without set-off.') + 'without set-off.'.length }];
  return d;
}

const embedded = readEmbeddedDoc() ?? '';
const parsed = parseDoc(embedded);
let doc: TypeDoc;
let loadNote = '';
if (parsed.ok) {
  doc = parsed.doc;
  if (parsed.repaired.length) loadNote = `repaired: ${parsed.repaired.join('; ')}`;
} else if (parsed.err === 'empty') {
  doc = sampleDoc();
} else {
  // NEVER silently start a new document over a file we could not read — the
  // spaces load contract (model.ts). Say what happened and stop.
  document.body.innerHTML =
    `<div style="max-width:44rem;margin:12vh auto;padding:0 2rem;font:15px/1.6 system-ui;color:#e6e9ef">
       <h1 style="font-size:20px">This file could not be opened</h1>
       <p>${parsed.detail}</p>
       <p style="color:#8d95a3">Nothing has been changed. Close this tab rather than saving over it.</p>
     </div>`;
  throw new Error(`bento/type: ${parsed.detail}`);
}

// ───────────────────────────────────────────────────────────────── chrome

const app = document.getElementById('app')!;
app.innerHTML = `
  <header class="t-bar">
    <button id="mark" class="t-mark" type="button">
      <svg class="t-mark-svg" viewBox="0 0 32 32" width="20" height="20" aria-hidden="true">
        <rect width="32" height="32" rx="7" fill="#16273E"/>
        <rect x="5" y="5" width="7" height="22" rx="2.5" fill="#5E7699"/>
        <rect x="14" y="5" width="13" height="10" rx="2.5" fill="#FF9E8A"/>
        <rect x="14" y="17" width="13" height="10" rx="2.5" fill="#F0EBE0"/>
      </svg><b class="t-mark-word">bento<span>/</span>type</b>
    </button>
    <button id="sidebar" class="t-btn" type="button"></button>
    <input id="doctitle" class="t-doctitle" spellcheck="false">
    <span class="t-status" id="status"></span>

    <div class="t-right">
      <select id="kind" class="t-select"></select>
      <div class="t-group" id="gFormat"></div>
      <div class="t-group">
        <button id="mb" class="t-btn" type="button"></button>
        <button id="mi" class="t-btn" type="button"></button>
        <button id="mu" class="t-btn" type="button"></button>
        <button id="ms" class="t-btn" type="button"></button>
        <button id="mc" class="t-btn" type="button"></button>
      </div>
      <div class="t-group">
        <button id="lul" class="t-btn" type="button"></button>
        <button id="lol" class="t-btn" type="button"></button>
        <button id="lin" class="t-btn" type="button"></button>
        <button id="lout" class="t-btn" type="button"></button>
        <button id="tbl" class="t-btn" type="button"></button>
      </div>
      <div class="t-group" id="gInsert"></div>
      <div class="t-group" id="gReview"></div>
      <div class="t-group">
        <button id="undo" class="t-btn" type="button"></button>
        <button id="redo" class="t-btn" type="button"></button>
      </div>
      <button id="theme" class="t-btn" type="button"></button>
      <button id="save" class="t-btn t-primary" type="button"></button>
      <div class="t-menuwrap">
        <button id="more" class="t-btn" type="button"></button>
        <div class="t-menu" id="moreMenu" hidden>
          <button id="snap" type="button"></button>
          <button id="review" type="button"></button>
          <button id="sign" type="button"></button>
          <div class="t-menu-sep"></div>
          <button id="print" type="button"></button>
          <button id="about" type="button"></button>
        </div>
      </div>
    </div>
  </header>
  <div class="t-main">
    <div class="t-side">
      <div class="t-tabs">
        <button data-tab="outline" class="on"></button>
        <button data-tab="review"></button>
        <button data-tab="sigs"></button>
      </div>
      <div class="t-panel on" data-panel="outline"><div class="t-outline" id="outline"></div></div>
      <div class="t-panel" data-panel="review"><div id="reviewPanel"></div></div>
      <div class="t-panel" data-panel="sigs"><div id="sigsPanel"></div></div>
    </div>
    <div class="t-scroll"><div class="t-wrap">
      <div class="t-paper" id="paper"></div><div class="t-deco" id="deco"></div>
    </div></div>
  </div>`;

const paper = document.getElementById('paper')!;
const deco = document.getElementById('deco')!;
const statEl = document.getElementById('status')!;

const store = new Store(doc);
const editor = new Editor(paper, store);

// ───────────────────────────────────────────────────── chrome: labels & icons
//
// Set from script rather than written into the markup so every user-visible
// string passes through one place — which is what makes the i18n sweep a sweep
// rather than an archaeology dig through a template literal.
const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const label = (id: string, html: string, tip: string, text = '') => {
  const b = byId(id);
  b.innerHTML = html + (text ? `<span class="t-lbl">${text}</span>` : '');
  b.title = tip;
};

label('sidebar', ICONS.panelLeft, t('Outline — show or hide the document map'));
label('mb', ICONS.bold, t('Bold (⌘B)'));
label('mi', ICONS.italic, t('Italic (⌘I)'));
label('mu', ICONS.underline, t('Underline (⌘U)'));
label('ms', ICONS.strike, t('Strikethrough'));
label('mc', ICONS.code, t('Code'));
label('lul', ICONS.bullets, t('Bulleted list'));
label('lol', ICONS.numbers, t('Numbered list'));
label('lin', ICONS.indent, t('Indent (Tab)'));
label('lout', ICONS.outdent, t('Outdent (⇧Tab)'));
label('tbl', ICONS.table, t('Insert a table'));
label('undo', ICONS.undo, t('Undo (⌘Z)'));
label('redo', ICONS.redo, t('Redo (⇧⌘Z)'));
label('save', ICONS.save, t('Save (⌘S)'), t('Save'));
label('more', ICONS.more, t('More — revisions, signing, print'));
label('snap', ICONS.history, '', t('Snapshot'));
label('review', ICONS.review, '', t('Review changes…'));
label('sign', ICONS.sign, '', t('Sign…'));
label('print', ICONS.print, '', t('Print or PDF…'));
label('about', ICONS.sync, '', t('About bento/type'));
byId('mark').title = t('About bento/type — version, updates, language');
const showAbout = () => openAbout({
  store,
  pages: metrics.pages.length,
  onReplaceDoc: json => {
    try {
      const parsed = parseDoc(json);
      if (!parsed.ok) {
        // `empty` carries no detail — the tagged union says so, and reading
        // `.detail` off it would have printed "undefined" to the one person
        // who most needs to know what went wrong.
        alert(parsed.err === 'empty'
          ? t('That JSON was empty.')
          : t('That is not a bento/type document: {detail}', { detail: parsed.detail }));
        return;
      }
      store.replace(parsed.doc);
      // store.replace swaps the model; only this rebuilds the paper from it.
      // Without it the document changed and the screen did not — which is what
      // "Replace from JSON…" did on the day it was added.
      editor.render();
      schedule();
    } catch { alert(t('That JSON could not be read.')); }
  },
});
byId('mark').addEventListener('click', showAbout);
byId('about').addEventListener('click', showAbout);

for (const [val, text] of [
  ['para', t('Body')], ['h1', t('Title')], ['h2', t('Heading')],
  ['h3', t('Subheading')], ['quote', t('Quote')],
  ['ul', t('Bulleted list')], ['ol', t('Numbered list')],
] as const) {
  const o = document.createElement('option');
  o.value = val; o.textContent = text;
  byId<HTMLSelectElement>('kind').append(o);
}

for (const [tab, text] of [['outline', t('Outline')], ['review', t('Review')], ['sigs', t('Signatures')]] as const) {
  const b = document.querySelector<HTMLElement>(`.t-tabs [data-tab="${tab}"]`);
  if (b) b.textContent = text;
}

// The DOCUMENT TITLE, in the bar — the one thing every other app in the suite
// puts there and this one only had buried in the page. It is what the window
// title, the save-picker filename and `{{title}}` all read.
const titleInput = byId<HTMLInputElement>('doctitle');
titleInput.value = store.doc.title;
titleInput.setAttribute('aria-label', t('Document title'));
titleInput.addEventListener('input', () => {
  store.commit(d => { d.title = titleInput.value || 'Untitled'; }, { run: '__title' });
});
store.on(() => {
  if (document.activeElement !== titleInput && titleInput.value !== store.doc.title) {
    titleInput.value = store.doc.title;
  }
});

/**
 * Size the bar by MEASURING it, not by width breakpoints.
 *
 * The same reasoning as slides' fitTopbar, and the same tiers: start at the
 * widest layout and step down while the bar overflows its own box. Breakpoints
 * were wrong here for the reason they are wrong there — zoom, OS text scaling
 * and longer translations all change how much room the same buttons need at
 * one viewport width.
 *
 * The title is the only shrinkable item, so flexbox crushes it toward its floor
 * before anything technically overflows: stepping down only on hard overflow
 * would leave full labels beside an unusably narrow title. So squeeze counts
 * as overflow too.
 */
const bar = document.querySelector<HTMLElement>('.t-bar')!;
const TIERS = ['t-bar-compact', 't-bar-tight', 't-bar-fold'];
function fitBar() {
  if (!bar.isConnected) return;
  bar.classList.remove(...TIERS);
  const title = bar.querySelector<HTMLElement>('.t-doctitle');
  const tooTight = () =>
    bar.scrollWidth - bar.clientWidth > 1 || (title ? title.clientWidth < 96 : false);
  for (const tier of TIERS) {
    if (!tooTight()) return;
    bar.classList.add(tier);
  }
}
// BOTH signals, deliberately. ResizeObserver catches content-driven changes
// (a longer title, a translated label) that no resize event reports; the
// resize event catches viewport changes when RO callbacks are being throttled,
// which happens whenever the page is not painting — a background tab, or a
// hidden preview pane. Measured: with only the observer, the bar stayed
// untiered and overflowed at 700px because the callback never ran.
fitBar();
new ResizeObserver(() => fitBar()).observe(bar);
new ResizeObserver(() => fitBar()).observe(document.documentElement);
window.addEventListener('resize', fitBar);

// ─────────────────────────────────────────────── the feature registry, rendered
//
// Everything a feature module registered at import time becomes chrome here.
// A feature is one file plus one line in registry.ts; nothing below knows what
// any particular feature is.
const featureCtx: FeatureContext = {
  store, editor,
  refresh: () => { editor.render(); schedule(); },
  toast: (m: string) => toast(m),
  showPanel: (id: string) => {
    document.querySelector('.t-main')!.classList.remove('t-side-off');
    showTab(id);
  },
};

const mountTools = (hostId: string, group: 'format' | 'insert' | 'review' | 'right') => {
  const host = byId(hostId);
  for (const spec of tools(group)) {
    const b = document.createElement('button');
    b.className = 't-btn';
    b.type = 'button';
    b.id = `tool-${spec.id}`;
    b.innerHTML = spec.icon + (spec.label ? `<span class="t-lbl">${labelText(spec.label)}</span>` : '');
    b.title = labelText(spec.title);
    // mousedown, not click: the caret must survive pressing a toolbar button
    b.addEventListener('mousedown', e => { e.preventDefault(); spec.run(featureCtx); });
    host.appendChild(b);
  }
  if (!host.children.length) host.remove();
};
mountTools('gFormat', 'format');
mountTools('gInsert', 'insert');
mountTools('gReview', 'review');

for (const spec of menuItems()) {
  const b = document.createElement('button');
  b.type = 'button';
  b.innerHTML = (spec.icon ?? '') + `<span>${labelText(spec.label)}</span>`;
  b.addEventListener('click', () => spec.run(featureCtx));
  byId('moreMenu').insertBefore(b, byId('about'));
}

for (const spec of panels()) {
  const tab = document.createElement('button');
  tab.dataset.tab = spec.id;
  tab.textContent = labelText(spec.label);
  document.querySelector('.t-tabs')!.appendChild(tab);
  const panel = document.createElement('div');
  panel.className = 't-panel';
  panel.dataset.panel = spec.id;
  document.querySelector('.t-side')!.appendChild(panel);
  spec.mount(panel, featureCtx);
  // `update` was declared on PanelSpec and never called, so a panel that
  // implemented it was silently dead. Wired to the same signal everything else
  // repaints on.
  if (spec.update) store.on(() => spec.update!(panel, featureCtx));
}

// feature shortcuts, ahead of the editor's own so a feature can claim one
window.addEventListener('keydown', e => {
  const hit = matchKey(e);
  if (hit) { e.preventDefault(); hit.run(featureCtx); }
}, true);

// active-state highlighting, on the same signal the mark buttons use
const paintToolStates = () => {
  for (const group of ['format', 'insert', 'review'] as const) {
    for (const spec of tools(group)) {
      if (!spec.active) continue;
      document.getElementById(`tool-${spec.id}`)?.classList.toggle('on', spec.active(featureCtx));
    }
  }
};

// the ⋯ menu — secondary actions, off the bar but one click away
const moreMenu = byId('moreMenu');
byId('more').addEventListener('click', e => {
  e.stopPropagation();
  moreMenu.hidden = !moreMenu.hidden;
});
document.addEventListener('click', () => { moreMenu.hidden = true; });
moreMenu.addEventListener('click', () => { moreMenu.hidden = true; });


let metrics: Metrics = { pages: [], ms: 0 };

/**
 * Re-measure and redraw. Deliberately NOT on every keystroke: pagination reads
 * layout, so calling it per character would force a synchronous reflow on each
 * one. It runs on an idle beat instead, which is what makes typing feel free.
 */
let idle: number | undefined;
const repaginate = () => {
  metrics = paginate(store.doc, paper);
  drawPages(store.doc, paper, deco, metrics);
  // page numbers are knowable only here, so anything that shows one is told now
  for (const f of paginatedFns()) f(featureCtx, metrics, paper);
  buildOutline();
  paint();
  void paintSigs();
};
const schedule = () => {
  clearTimeout(idle);
  idle = setTimeout(repaginate, 180) as unknown as number;
};

// A picture that finishes decoding changes the flow's height, so the pages have
// to be recomputed — see renderImage. Listening on the paper rather than per
// image keeps this to one handler however many pictures a document has.
paper.addEventListener('t-relayout', () => schedule());

const paint = () => {
  const d = store.doc;
  const notes = Object.keys(d.footnotes).length;
  statEl.textContent =
    `${metrics.pages.length || 1} ${metrics.pages.length === 1 ? 'page' : 'pages'}` +
    ` · ${wordCount(d).toLocaleString()} words` +
    (notes ? ` · ${notes} note${notes > 1 ? 's' : ''}` : '') +
    ` · ${metrics.ms.toFixed(0)}ms` +
    (loadNote ? ` · ${loadNote}` : '');
};

const refresh = () => { markDirty(); paint(); schedule(); };
editor.onChange = refresh;
store.on(refresh);

const MARK_BTN: Array<[string, MarkType]> = [['mb', 'b'], ['mi', 'i'], ['mu', 'u'], ['ms', 's'], ['mc', 'code']];
for (const [id, t] of MARK_BTN) {
  document.getElementById(id)!.addEventListener('mousedown', (e) => {
    e.preventDefault();                      // keep the selection alive
    editor.toggle(t);
  });
}
editor.onSelection = (active) => {
  paintToolStates();
  for (const [id, t] of MARK_BTN) document.getElementById(id)!.classList.toggle('on', active.has(t));
};
// A list button TOGGLES: pressing Bulleted list on an item that is already
// bulleted returns it to a paragraph. Without that the button is a one-way door
// and the only way back is the style menu, which is not where anyone looks.
for (const [id, kind] of [['lul', 'ul'], ['lol', 'ol']] as const) {
  byId(id).addEventListener('mousedown', e => {
    e.preventDefault();                        // keep the caret
    const c = editor.caret();
    const cur = c && store.block(c.id)?.kind;
    editor.setKind(cur === kind ? 'para' : kind);
  });
}
byId('tbl').addEventListener('mousedown', e => { e.preventDefault(); editor.insertTable(); });
byId('lin').addEventListener('mousedown', e => { e.preventDefault(); editor.indent(1); });
byId('lout').addEventListener('mousedown', e => { e.preventDefault(); editor.indent(-1); });

byId('sidebar').addEventListener('click', () => {
  document.querySelector('.t-main')!.classList.toggle('t-side-off');
});

document.getElementById('kind')!.addEventListener('change', (e) => {
  editor.setKind((e.target as HTMLSelectElement).value as never);
});
document.getElementById('undo')!.addEventListener('mousedown', (e) => {
  e.preventDefault(); store.undo(); editor.render(); refresh();
});
document.getElementById('redo')!.addEventListener('mousedown', (e) => {
  e.preventDefault(); store.redo(); editor.render(); refresh();
});

// ────────────────────────────────────────────────────────── sidebar

const esc = (t: string) => t.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
const el = (tag: string, cls?: string) => {
  const n = document.createElement(tag); if (cls) n.className = cls; return n;
};
function showTab(name: string) {
  document.querySelectorAll<HTMLElement>('.t-tabs button')
    .forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  document.querySelectorAll<HTMLElement>('.t-panel')
    .forEach(p => p.classList.toggle('on', p.dataset.panel === name));
}
document.querySelectorAll<HTMLElement>('.t-tabs button')
  .forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab!)));

/** The outline, with the page each heading lands on. */
function buildOutline() {
  const box = document.getElementById('outline')!;
  const heads = store.doc.body.filter(b => b.kind === 'h2' || b.kind === 'h3');
  box.replaceChildren();
  if (!heads.length) {
    const h = el('div', 't-hint'); h.textContent = t('Headings appear here.');
    box.appendChild(h); return;
  }
  const paperTop = paper.getBoundingClientRect().top + store.doc.page.marginTop;
  for (const b of heads) {
    const node = paper.querySelector<HTMLElement>(`[data-id="${CSS.escape(b.id)}"]`);
    const y = node ? node.getBoundingClientRect().top - paperTop : 0;
    const pg = metrics.pages.find(p => y >= p.start - 1 && (!isFinite(p.end) || y < p.end));
    const a = el('a', b.kind) as HTMLAnchorElement;
    a.innerHTML = `<span class="pg">${pg ? pg.n : ''}</span>${esc(b.text)}`;
    a.addEventListener('click', () =>
      paper.querySelector(`[data-id="${CSS.escape(b.id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    box.appendChild(a);
  }
}

// ───────────────────────────────────────────── revisions and redlining

let currentSet: ChangeSet | null = null;
const decided = new Map<string, boolean>();

document.getElementById('snap')!.addEventListener('click', () => {
  const label = `Revision ${store.doc.revisions.length + 1}`;
  store.commit(d => {
    d.revisions.push({ id: newId('rev'), at: new Date().toISOString(), label,
                       body: JSON.parse(JSON.stringify(d.body)) });
  });
  markDirty(); paint();
  toast(`${label} recorded — edit, then Review`);
});

document.getElementById('review')!.addEventListener('click', () => {
  if (!store.doc.revisions.length) { toast('Take a Snapshot first, then edit, then Review'); return; }
  const base = store.doc.revisions[store.doc.revisions.length - 1];
  currentSet = redline({ docId: store.doc.docId, body: base.body },
                       { docId: store.doc.docId, body: store.doc.body },
                       { author: store.doc.meta?.author || 'you' });
  decided.clear();
  showTab('review');
  buildReview(base.label, base.body);
});

function buildReview(label: string, baseBody: typeof store.doc.body) {
  const box = document.getElementById('reviewPanel')!;
  box.replaceChildren();
  const head = el('div', 't-hint');
  head.textContent = currentSet!.changes.length
    ? `${currentSet!.changes.length} change${currentSet!.changes.length > 1 ? 's' : ''} since ${label}`
    : `No changes since ${label}. Edit the document, then press Review again.`;
  head.style.marginBottom = '9px';
  box.appendChild(head);
  if (!currentSet!.changes.length) return;

  const bar = el('div'); bar.style.cssText = 'display:flex;gap:6px;margin-bottom:9px';
  for (const [text, val] of [['Accept all', true], ['Reject all', false]] as const) {
    const b = el('button') as HTMLButtonElement;
    b.textContent = text; b.style.flex = '1';
    b.addEventListener('click', () => {
      for (const c of currentSet!.changes) decided.set(c.id, val);
      applyDecisions(label, baseBody);
    });
    bar.appendChild(b);
  }
  box.appendChild(bar);

  for (const c of currentSet!.changes) {
    const card = el('div', 't-card');
    const what = c.kind === 'text'
      ? `${c.removed ? `<del>${esc(c.removed)}</del>` : ''}${c.added ? `<ins>${esc(c.added)}</ins>` : ''}`
      : esc(describe(c));
    card.innerHTML = `<div class="who">${esc(c.author)} · ${c.kind}</div><div class="what">${what}</div>`;
    const btns = el('div', 'btns');
    for (const [text, val] of [['Accept', true], ['Reject', false]] as const) {
      const b = el('button') as HTMLButtonElement;
      b.textContent = text;
      b.addEventListener('click', () => {
        decided.set(c.id, val);
        card.classList.add('done');
        card.querySelectorAll('button').forEach(x => (x as HTMLButtonElement).disabled = true);
        applyDecisions(label, baseBody);
      });
      btns.appendChild(b);
    }
    card.appendChild(btns);
    box.appendChild(card);
  }
}

/**
 * Rebuild from the BASE plus the accepted changes.
 *
 * Rebuilding from the base rather than patching the live document is what makes
 * "reject" mean anything — the rejected text has to come back. Undecided
 * changes stay as the author left them, so nothing vanishes while you think.
 */
function applyDecisions(_label: string, baseBody: typeof store.doc.body) {
  const accepted = new Set([...decided].filter(([, v]) => v).map(([k]) => k));
  const undecided = currentSet!.changes.filter(c => !decided.has(c.id)).map(c => c.id);
  const take = new Set([...accepted, ...undecided]);
  try {
    const next = applyRedline({ docId: store.doc.docId, body: baseBody }, currentSet!, take);
    store.commit(d => { d.body = next.body; });
    editor.render(); markDirty(); repaginate();
    toast(decided.size === currentSet!.changes.length
      ? 'All changes resolved' : `${decided.size}/${currentSet!.changes.length} resolved`);
  } catch (e) { toast(`Could not apply: ${(e as Error).message}`); }
}

// ─────────────────────────────────────────────────────────── signatures

const KEYSTORE = 'bento-type-key';
let deviceKey: CryptoKeyPair | null = null;
async function getKey(): Promise<CryptoKeyPair> {
  if (deviceKey) return deviceKey;
  let saved: string | null = null;
  try { saved = localStorage.getItem(KEYSTORE); } catch { /* storage blocked */ }
  const EC = { name: 'ECDSA', namedCurve: 'P-256' } as const;
  if (saved) {
    const j = JSON.parse(saved);
    deviceKey = {
      privateKey: await crypto.subtle.importKey('jwk', j.priv, EC, true, ['sign']),
      publicKey: await crypto.subtle.importKey('jwk', j.pub, EC, true, ['verify']),
    };
    return deviceKey;
  }
  const k = await newKey();
  try {
    localStorage.setItem(KEYSTORE, JSON.stringify({
      priv: await crypto.subtle.exportKey('jwk', k.privateKey),
      pub: await crypto.subtle.exportKey('jwk', k.publicKey),
    }));
  } catch { /* an unsaved key still signs this session */ }
  deviceKey = k;
  return k;
}
const fingerprint = (pub: string) =>
  pub.replace(/[^a-zA-Z0-9]/g, '').slice(0, 24).match(/.{1,4}/g)!.join(' ').toUpperCase();

document.getElementById('sign')!.addEventListener('click', async () => {
  let who = '';
  try { who = localStorage.getItem('bento-type-name') ?? ''; } catch { /* ignore */ }
  const name = window.prompt('Your name, shown beside the signature', who);
  if (!name) return;
  try { localStorage.setItem('bento-type-name', name); } catch { /* ignore */ }
  const key = await getKey();
  const prev = store.doc.signatures[store.doc.signatures.length - 1] ?? null;
  const entry = await signDoc(store.doc, key, { name, prev });
  entry.at = new Date().toISOString();
  store.commit(d => { d.signatures.push(entry); });
  markDirty(); showTab('sigs'); await paintSigs();
  toast('Signed');
});

async function paintSigs() {
  const box = document.getElementById('sigsPanel')!;
  const sigs = store.doc.signatures;
  box.replaceChildren();
  if (!sigs.length) {
    const h = el('div', 't-hint');
    h.innerHTML = `Nothing signed yet.<br><br>A signature covers the document's <b>content</b> —
      not its timestamp, not which theme you are using — so re-saving never breaks one, but
      changing a word, or even a bold run, always does.<br><br>Each signature also commits to the
      one before it, which proves the <b>order</b> people signed in without trusting anyone's clock.`;
    box.appendChild(h);
    return;
  }
  const res = await verifyChain(store.doc, sigs);
  sigs.forEach((s, i) => {
    const r = res.entries[i];
    const card = el('div', 't-card');
    const state = r.ok && r.linked ? `<span class="t-ok">✓ valid</span>`
      : (!r.ok && r.why === 'content-changed'
        ? `<span class="t-bad">✕ the document has changed since this was signed</span>`
        : !r.linked ? `<span class="t-warn">⚠ not linked to the previous signature</span>`
        : `<span class="t-bad">✕ invalid signature</span>`);
    card.innerHTML =
      `<div class="what" style="font-weight:600">${esc(s.name || 'unnamed')}</div>` +
      `<div class="t-fp">${fingerprint(s.pub)}</div>` +
      `<div class="who" style="margin:5px 0 0">${state}` +
      `${i > 0 ? ` · after ${esc(sigs[i - 1].name || 'previous')}` : ''}</div>`;
    box.appendChild(card);
  });
  // two names on one key is exactly what a signature cannot prove
  const byKey = new Map<string, Set<string>>();
  for (const s of sigs) {
    if (!byKey.has(s.pub)) byKey.set(s.pub, new Set());
    byKey.get(s.pub)!.add(s.name || 'unnamed');
  }
  const shared = [...byKey.values()].find(n => n.size > 1);
  if (shared) {
    const w = el('div', 't-hint');
    w.style.cssText = 'margin-top:10px;border-inline-start:2px solid var(--warnc);padding-inline-start:9px';
    w.innerHTML = `<span class="t-warn">Two names, one key.</span> ${[...shared].map(esc).join(' and ')}
      signed with the <b>same</b> key — on this device that is simply you signing twice. Between real
      parties it would mean one of the names is a claim the signature does not support.`;
    box.appendChild(w);
  }
  const foot = el('div', 't-hint');
  foot.style.marginTop = '10px';
  foot.innerHTML = res.ok
    ? `The chain is intact. Verify a signer by reading their fingerprint aloud — nothing here proves
       <i>who</i> holds a key, only that the same key signed these exact words, in this order.`
    : `<span class="t-bad">This chain no longer verifies.</span> Either the text changed after
       signing, or a signature was altered or removed.`;
  box.appendChild(foot);
}

// ─────────────────────────────────────────────────────────── a small toast
let toastEl: HTMLElement | null = null, toastT: number | undefined;
function toast(msg: string) {
  if (!toastEl) {
    toastEl = el('div');
    toastEl.style.cssText = 'position:fixed;left:50%;bottom:26px;transform:translateX(-50%);' +
      'background:var(--ink);color:var(--chrome);padding:9px 15px;border-radius:8px;font-size:12.5px;' +
      'box-shadow:0 10px 34px rgb(0 0 0 / .35);opacity:0;transition:opacity .18s;pointer-events:none;z-index:99';
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.style.opacity = '1';
  clearTimeout(toastT);
  toastT = setTimeout(() => { toastEl!.style.opacity = '0'; }, 2200) as unknown as number;
}

// ─────────────────────────────────────────────────────────────── saving
//
// The whole platform promise in one button: this file rewrites ITSELF. The
// kernel owns the splice, the File System Access path and the download
// fallback, so the app only has to say when and with what.
let dirty = false;
const markDirty = () => { dirty = true; paintTitle(); };

function paintTitle() {
  const name = currentFileName();
  const docTitle = store.doc.title || t('Untitled');
  document.title = `${dirty ? '• ' : ''}${docTitle} — bento/type`;
  const btn = document.getElementById('save')!;
  // Update the LABEL only. Setting textContent here wiped the icon that
  // label() had just installed, so the button silently lost its glyph the
  // first time the dirty flag moved — which is every document, immediately.
  const lbl = btn.querySelector('.t-lbl');
  if (lbl) lbl.textContent = dirty ? t('Save') : t('Saved');
  btn.classList.toggle('t-primary', dirty);
  // These two were the ONLY strings the pseudo-locale audit caught, and the
  // reason is worth keeping: this function had a local `const t` holding the
  // document title, which shadowed the imported t(). The sweep could not have
  // wrapped them without renaming it first.
  btn.title = name
    ? (dirty
        ? t('Save to {file}', { file: name })
        : t('Saved to {file}', { file: name })) +
      (canWriteInPlace() ? '' : t(' (downloads a copy)'))
    : t('Save (⌘S)');
}

async function save(forcePicker = false) {
  const result = await saveFile(store.doc, forcePicker);
  if (result === 'cancelled') return;
  dirty = false;
  paintTitle();
}

document.getElementById('save')!.addEventListener('click', () => void save());
addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    void save(e.shiftKey);          // ⇧⌘S = save as
  }
});
// Leaving with unsaved work should cost a prompt. A document that edits itself
// has no server-side copy to fall back on.
addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

// ─────────────────────────────────────────────────────────────── printing
//
// Print uses the SAME page breaks the editor computed, so the printed
// pagination is the one the outline and the page numbers already showed. It
// repaginates first rather than trusting a stale measurement — the alternative
// is a document that prints differently from the one on screen, which is the
// exact failure the deterministic-pagination promise exists to prevent.
function doPrint() {
  repaginate();
  printDocument(store.doc, metrics, { pageNumbers: true, bareFirstPage: false });
}
document.getElementById('print')!.addEventListener('click', doPrint);
addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'p') { e.preventDefault(); doPrint(); }
});

// theme picker — cycles auto → light → dark, and says which it is
const themeBtn = document.getElementById('theme')!;
const THEME_LABEL: Record<ThemeChoice, string> = { auto: '◐ Auto', light: '☀ Light', dark: '☾ Dark' };
const paintTheme = () => { themeBtn.textContent = THEME_LABEL[themeChoice()]; };
themeBtn.addEventListener('click', () => {
  const order: ThemeChoice[] = ['auto', 'light', 'dark'];
  const next = order[(order.indexOf(themeChoice()) + 1) % order.length];
  setTheme(next);
  paintTheme();
  // the page shadow and grid change with the theme, so re-measure
  repaginate();
});
paintTheme();

repaginate();
dirty = false; paintTitle();

// scripting surface, per PLATFORM §7
(window as unknown as Record<string, unknown>).bento = {
  format: store.doc.format,
  get doc() { return store.doc; },
  store, editor,
  save: (picker = false) => save(picker),
  print: () => doPrint(),
  printHtml: () => { repaginate(); return buildPrintDocument(store.doc, metrics, { pageNumbers: true }); },
  paginate: () => { repaginate(); return metrics; },
  get pages() { return metrics.pages; },
  // PLATFORM §7: the AI round-trip surface. `loadDoc` is the scripted twin of
  // About's "Replace from JSON…", and `serialize` is what a tool reads back.
  serialize: () => JSON.stringify(store.doc),
  loadDoc: (json: string) => {
    const parsed = parseDoc(json);
    if (!parsed.ok) throw new Error(`bento/type: ${parsed.err === 'empty' ? 'empty document' : parsed.detail}`);
    store.replace(parsed.doc);
    editor.render();
    schedule();
    return true;
  },
  // The language engine, so `bento.i18n.setLocale('x-pseudo')` can audit for
  // unswept strings — which is the only way to find one that is cheap enough
  // to actually do.
  i18n: i18nApi,
};

// ─────────────────────────────────────────────────────────────────── ready
//
// LAST LINE ON PURPOSE. Called from beside the panels() loop, where it visually
// belongs, featureCtx.refresh() reaches `schedule` inside its temporal dead
// zone — "Cannot access 'schedule' before initialization" — and the editor
// boots blank. The agent that needed this hook found that by applying the patch
// and loading the app, not by reading, and said so in its note; this comment is
// here so the next person does not move it back.
for (const f of readyFns()) f(featureCtx);
