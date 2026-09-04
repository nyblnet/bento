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
import { tools, menuItems, panels, matchKey, readyFns, paginatedFns, selectionFns, text as labelText, type FeatureContext } from './features.ts';
import './registry.ts';   // side-effect: every feature module registers itself
import { i18nApi } from '../../kernel/src/i18n.ts';
import { openAbout } from './about.ts';
import { startTheme, setTheme, themeChoice, type ThemeChoice } from '../../kernel/src/theme.ts';
import { parseDoc, emptyDoc, uid, wordCount, type TypeDoc } from './model.ts';
import { Store } from './store.ts';
import { Editor } from './editor.ts';
import { paginate, drawPages, type Metrics } from './paginate.ts';
import { takeSnapshot, startReview } from './redlineview.ts';
import { printDocument, buildPrintDocument } from './print.ts';
import { sign as signDoc, verifyChain, newKey } from './canon.ts';

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
      <div class="t-group" id="gFormat"></div>
      <div class="t-group" id="gInsert"></div>
      <div class="t-group" id="gReview"></div>
      <div class="t-group">
        <button id="undo" class="t-btn" type="button"></button>
        <button id="redo" class="t-btn" type="button"></button>
      </div>
      <button id="props" class="t-btn" type="button"></button>
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
        <button data-tab="navigate" class="on"></button>
        <button data-tab="review"></button>
        <button data-tab="sources"></button>
      </div>
      <div class="t-panel on" data-panel="navigate">
        <div class="t-seg" id="navSeg">
          <button data-view="headings" class="on"></button>
          <button data-view="pages"></button>
          <button data-view="figures"></button>
          <button data-view="results"></button>
        </div>
        <div class="t-view on" data-view="headings"><div class="t-outline" id="outline"></div></div>
        <div class="t-view" data-view="pages"><div class="t-outline" id="pages"></div></div>
        <div class="t-view" data-view="figures"><div id="figuresHost"></div></div>
        <div class="t-view" data-view="results"><div id="findHost"></div></div>
      </div>
      <div class="t-panel" data-panel="review">
        <div class="t-sub" data-sub="comments"></div>
        <div id="commentsHost"></div>
        <div class="t-sub" data-sub="changes"></div>
        <div id="reviewPanel"></div>
        <div class="t-sub" data-sub="redline"></div>
        <div id="redlinePanel"></div>
        <div class="t-sub" data-sub="sigs"></div>
        <div id="sigsPanel"></div>
      </div>
      <div class="t-panel" data-panel="sources"><div id="citeHost"></div></div>
    </div>
    <div class="t-scroll"><div class="t-wrap">
      <div class="t-paper" id="paper"></div><div class="t-deco" id="deco"></div>
    </div></div>
    <aside class="t-props" id="propsPanel"></aside>
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

// LABEL RULE — every bar control gets a `title`, full stop (an icon with no
// tooltip names nothing). A VISIBLE text label is rarer, and earned only one
// of two ways: (1) the control's face reports STATE, not just an action — Save/
// Saved and the theme cycle both change what they say depending on what
// happens next, and an icon alone can't say that; or (2) the icon stands for a
// whole HIDDEN CATEGORY rather than one verb — Insert's "+" could mean a
// picture, a table, a citation… nothing short of a word says which. Every
// other control (sidebar, props, link, comment, find, undo, redo, ⋯) is one
// icon-legible verb with a universally-read glyph, so it stays icon-only and
// leans on its tooltip. Breaking this into "some buttons happen to have text"
// is how the bar drifted into its current mix with no rule at all.
label('sidebar', ICONS.panelLeft, t('Outline — show or hide the document map'));
label('props', ICONS.panelRight, t('Format — show or hide the properties panel'));
// Strikethrough and code leave the BAR for the ⋯ menu: of the five character
// formats they are the two nobody reaches for mid-sentence in the prose this
// app is for, and bar width is the scarcest thing in the app.
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

for (const [sub, text] of [['comments', t('Comments')], ['changes', t('Tracked changes')],
                           ['redline', t('Snapshot redline')], ['sigs', t('Signatures')]] as const) {
  const n = document.querySelector<HTMLElement>(`.t-sub[data-sub="${sub}"]`);
  if (n) n.textContent = text;
}
// An empty section under a heading explains nothing, and this one is empty
// until someone has taken a snapshot — which is exactly the step a person does
// not know about yet. So the empty state IS the instruction.
//
// The live tracked-changes list is review.ts's `trackedChanges` panel, mounted
// into `reviewPanel`; the on-demand snapshot comparison is redlineview.ts's
// `redline` panel, mounted into its OWN `redlinePanel` — two different hosts
// on purpose, so accepting a redline change can never erase the tracked-
// changes list sitting above it (or vice versa). Both through the feature
// registry — nothing to build here.
for (const [tab, text] of [['navigate', t('Navigate')], ['review', t('Review')], ['sources', t('Sources')]] as const) {
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

// The bar's measured fit (fitBar) is wired up much further down, right after
// every group and the ⋯ menu are actually mounted onto it — see the note
// there for why the ordering matters.

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

const toolButton = (spec: ReturnType<typeof tools>[number]) => {
  const b = document.createElement('button');
  b.className = 't-btn';
  b.type = 'button';
  b.id = `tool-${spec.id}`;
  const titleText = labelText(spec.title);
  // Icon-only buttons rely on `title` in the BAR, but a row folded into the ⋯
  // menu (see fitBar/setBarFolded below) has no hover to reveal that — a menu
  // row has to name itself. `.t-mlbl` costs nothing while the button lives in
  // the bar: styles.css only shows it inside `.t-menu`. The parenthetical
  // shortcut ("(⌘K)") is dropped — a shortcut hint is dead weight on a row you
  // reach precisely because a shortcut wasn't an option.
  b.innerHTML = spec.icon + (spec.label
    ? `<span class="t-lbl">${labelText(spec.label)}</span>`
    : `<span class="t-mlbl">${titleText.replace(/\s*\([^)]*\)\s*$/, '')}</span>`);
  b.title = titleText;
  // mousedown, not click: the caret must survive pressing a toolbar button
  b.addEventListener('mousedown', e => { e.preventDefault(); spec.run(featureCtx); });
  return b;
};

const mountTools = (hostId: string, group: 'format' | 'insert' | 'review' | 'right') => {
  const host = byId(hostId);
  for (const spec of tools(group)) host.appendChild(toolButton(spec));
  if (!host.children.length) host.remove();
};

/**
 * INSERT IS ONE BUTTON, not eight.
 *
 * Every feature that can put something in the document registered its own icon,
 * and the bar reached thirty-nine buttons needing 1253px inside a 1120px
 * window — accumulated a feature at a time, never designed. slides solved the
 * same problem the same way (shapeDropdown, mediaDropdown): related inserts
 * live behind one control, so adding the ninth thing costs no width at all.
 *
 * They are also the RARE actions. A picture or a citation is chosen
 * deliberately, once; bold is pressed mid-sentence without looking. Frequency
 * is what earns a place in the bar.
 */
const mountInsertMenu = () => {
  const host = byId('gInsert');
  const specs = tools('insert');
  if (!specs.length) { host.remove(); return; }
  const wrap = document.createElement('div');
  wrap.className = 't-menuwrap';
  const btn = document.createElement('button');
  btn.className = 't-btn';
  btn.type = 'button';
  btn.id = 'insertMenuBtn';
  btn.innerHTML = ICONS.plus + `<span class="t-lbl">${t('Insert')}</span>`;
  btn.title = t('Insert a picture, table, formula, citation…');
  const menu = document.createElement('div');
  menu.className = 't-menu';
  menu.hidden = true;
  for (const spec of specs) {
    const item = document.createElement('button');
    item.type = 'button';
    item.innerHTML = spec.icon + `<span>${labelText(spec.label ?? spec.title)}</span>`;
    item.addEventListener('mousedown', e => { e.preventDefault(); menu.hidden = true; spec.run(featureCtx); });
    menu.appendChild(item);
  }
  btn.addEventListener('click', e => { e.stopPropagation(); menu.hidden = !menu.hidden; });
  document.addEventListener('click', () => { menu.hidden = true; });
  wrap.append(btn, menu);
  host.appendChild(wrap);
};

mountTools('gFormat', 'format');
mountInsertMenu();
mountTools('gReview', 'review');

// Menu rows keep a reference to their spec so their labels can be RE-READ when
// the menu opens. A toggle's label is a function of state — "Hide comments"
// becomes "Show comments" — and rendering it once at mount left it permanently
// wrong after the first use, describing the action you had already taken.
const menuRows: Array<[HTMLElement, ReturnType<typeof menuItems>[number]]> = [];
for (const spec of menuItems()) {
  const b = document.createElement('button');
  b.type = 'button';
  b.innerHTML = (spec.icon ?? '') + `<span>${labelText(spec.label)}</span>`;
  b.addEventListener('click', () => spec.run(featureCtx));
  byId('moreMenu').insertBefore(b, byId('about'));
  menuRows.push([b, spec]);
}
const refreshMenuLabels = () => {
  for (const [b, spec] of menuRows) {
    const span = b.querySelector('span');
    if (span) span.textContent = labelText(spec.label);
  }
};

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
 *
 * THIS BLOCK MUST COME AFTER the groups and the ⋯ menu are mounted (above),
 * not before. Measured: with fitBar wired up where the "obvious" spot was —
 * right after the title input, before mountTools('gFormat', …) etc. ran — its
 * FIRST call and its ResizeObservers all saw a bar missing every format/
 * insert/review button. Nothing observed afterward ever re-triggered it (the
 * bar's own box size doesn't change just because overflowing children were
 * appended inside it), so a page loaded directly at a narrow width — no
 * interactive resize in between — stayed permanently untiered with real
 * buttons hanging off the end of the bar (measured: 118px past the edge at
 * 620px wide, forever, since nothing ever asked again).
 */
const bar = document.querySelector<HTMLElement>('.t-bar')!;
const TIERS = ['t-bar-compact', 't-bar-tight', 't-bar-fold'];
const ALL_BAR_CLASSES = [...TIERS, 't-bar-micro'];

// Groups whose buttons are plain, POPOVER-FREE actions — safe to reparent
// wholesale into the ⋯ menu when the fold tier engages. gInsert stays put: it
// is ITSELF a dropdown, and nesting one popover inside another gets silently
// clipped the moment the outer one scrolls (hard-won #10, CLAUDE.md — an
// `overflow-y` menu clips any floating child, so a folded control must render
// as a plain menu ROW, never a second floater). Reparenting the SAME button
// nodes (not clones) keeps every listener intact for free.
const FOLD_GROUPS = ['gFormat', 'gReview'];
const foldHome = new WeakMap<HTMLElement, HTMLElement>();
const foldSep = document.createElement('div');
foldSep.className = 't-menu-sep';
foldSep.hidden = true;
byId('moreMenu').insertBefore(foldSep, byId('snap'));
let barFolded = false;
function setBarFolded(next: boolean) {
  if (next === barFolded) return;
  barFolded = next;
  const menu = byId('moreMenu');
  if (next) {
    for (const gid of FOLD_GROUPS) {
      const host = document.getElementById(gid);
      if (!host) continue;
      for (const btn of [...host.children] as HTMLElement[]) {
        foldHome.set(btn, host);
        menu.insertBefore(btn, foldSep);
      }
    }
    foldSep.hidden = false;
  } else {
    // Walk the menu in DOM order so buttons land back in the same relative
    // order they left it, and only touch the ones THIS moved (foldHome is
    // empty for the menu's own static rows).
    for (const btn of [...menu.children] as HTMLElement[]) {
      const home = foldHome.get(btn);
      if (home) { home.appendChild(btn); foldHome.delete(btn); }
    }
    foldSep.hidden = true;
  }
}

function fitBar() {
  if (!bar.isConnected) return;
  bar.classList.remove(...ALL_BAR_CLASSES);
  setBarFolded(false);
  const title = bar.querySelector<HTMLElement>('.t-doctitle');
  const tooTight = () =>
    bar.scrollWidth - bar.clientWidth > 1 || (title ? title.clientWidth < 96 : false);
  for (const tier of TIERS) {
    if (!tooTight()) return;
    bar.classList.add(tier);
    if (tier === 't-bar-fold') setBarFolded(true);
  }
  // Folding the groups away is the last thing that can free width. If the bar
  // is STILL too tight — or the title still can't clear its floor — the title
  // has nowhere left to shrink to, so it drops out cleanly instead of being
  // crushed below one legible character (measured: 24px wide at ~560px before
  // this tier existed, narrower than a single glyph).
  if (tooTight()) bar.classList.add('t-bar-micro');
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

// And a MutationObserver, which is the third signal slides has always had
// (CLAUDE.md: "driven by a Resize- + MutationObserver on the bar") and this
// app was missing.
//
// It matters because the bar's own BOX does not change when its CONTENTS do.
// The document title is painted after this first fitBar() runs, and a longer
// title makes the bar too tight without resizing it — so no ResizeObserver
// fires and the bar stays one tier short. Measured: loaded directly at 480px
// the bar overflowed by 23px with a button hanging past its edge, and a single
// stray resize event was enough to fix it, which is the signature of a missing
// re-measure rather than a broken measurement.
//
// It DISCONNECTS around its own call: fitBar adds classes and reparents
// buttons into the ⋯ menu, which are themselves mutations, and an observer
// that watched its own work would never stop.
const barWatch = new MutationObserver(() => {
  barWatch.disconnect();
  fitBar();
  barWatch.observe(bar, { childList: true, characterData: true, subtree: true });
});
barWatch.observe(bar, { childList: true, characterData: true, subtree: true });

// LEFT — navigation and review: facts about the document as a whole.
//
// A panel that names a `host` becomes a SECTION of one of the three tabs
// declared above; only a panel without one still gets a tab of its own. That
// is what took the sidebar from eight tabs to three.
for (const spec of panels('left')) {
  let panel: HTMLElement;
  const host = spec.host ? document.getElementById(spec.host) : null;
  if (host) {
    panel = host;
  } else {
    const tab = document.createElement('button');
    tab.dataset.tab = spec.id;
    tab.textContent = labelText(spec.label);
    document.querySelector('.t-tabs')!.appendChild(tab);
    panel = document.createElement('div');
    panel.className = 't-panel';
    panel.dataset.panel = spec.id;
    document.querySelector('.t-side')!.appendChild(panel);
  }
  spec.mount(panel, featureCtx);
  // `update` was declared on PanelSpec and never called, so a panel that
  // implemented it was silently dead. Wired to the same signal everything else
  // repaints on.
  if (spec.update) store.on(() => spec.update!(panel, featureCtx));
}

// RIGHT — the properties of whatever is selected. Stacked rather than tabbed:
// a property panel answers "what is this thing", and hiding half the answer
// behind a tab is how a formatting panel becomes a place people stop looking.
for (const spec of panels('right')) {
  const panel = document.createElement('div');
  panel.className = 't-panel';
  panel.dataset.panel = spec.id;
  // a DIV, not an <h3>: these are chrome, and a real heading here joins the
  // document's own headings for anything that collects them
  byId('propsPanel').appendChild(panel);
  // NO header added here. A contextual panel owns its whole body and rebuilds
  // it with replaceChildren, which wiped a header the loop had just added — so
  // the label vanished the first time the panel refreshed. A panel that wants a
  // title writes its own section, which is also what lets ONE panel show
  // several (Text, Picture, Table) as the selection changes.
  spec.mount(panel, featureCtx);
  if (spec.update) store.on(() => spec.update!(panel, featureCtx));
}
if (!byId('propsPanel').children.length) {
  const empty = document.createElement('p');
  empty.className = 't-props-empty';
  empty.textContent = t('Select something to see its properties.');
  byId('propsPanel').appendChild(empty);
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
  if (moreMenu.hidden) refreshMenuLabels();
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
// The document's typeface, onto the paper. Set before pagination measures
// anything: a different face changes every line box, so measuring first would
// paginate the old type.
const applyDocType = () => {
  const ty = store.doc.type;
  paper.style.setProperty('--doc-family', ty?.family ?? '');
  paper.style.setProperty('--doc-size', ty?.size ? `${ty.size}px` : '');
};

const repaginate = () => {
  applyDocType();
  metrics = paginate(store.doc, paper);
  drawPages(store.doc, paper, deco, metrics);
  // page numbers are knowable only here, so anything that shows one is told now
  for (const f of paginatedFns()) f(featureCtx, metrics, paper);
  buildOutline();
  buildPages();
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

// Bold, italic and underline moved to the properties panel with the rest of the
// character formatting; strikethrough and code live in the ⋯ menu. Only the
// ones still in the chrome are wired here, and the lookup is GUARDED rather
// than asserted: `getElementById(id)!` on a button that had moved was a
// TypeError at boot that tsc could not see — the app rendered its paper and
// then stopped before it published `window.bento`, so it looked like it worked.
// Strikethrough and code USED to live here as two loose buttons, exiled into ⋯
// when the toolbar ran out of room. They have a proper home now — the
// selection toolbar, which appears over the words they act on — so they are
// gone from the overflow menu rather than being offered in two places at once.
editor.onSelection = (active) => {
  void active;
  paintToolStates();
  for (const f of selectionFns()) f(featureCtx);
};
// A list button TOGGLES: pressing Bulleted list on an item that is already
// bulleted returns it to a paragraph. Without that the button is a one-way door
// and the only way back is the style menu, which is not where anyone looks.

byId('sidebar').addEventListener('click', () => {
  document.querySelector('.t-main')!.classList.toggle('t-side-off');
});
byId('props').addEventListener('click', () => {
  document.querySelector('.t-main')!.classList.toggle('t-props-off');
});
// `[` and `]` collapse the panels, as they do in slides and dash
window.addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = (e.target as HTMLElement)?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return;
  if (e.key === '[') document.querySelector('.t-main')!.classList.toggle('t-side-off');
  if (e.key === ']') document.querySelector('.t-main')!.classList.toggle('t-props-off');
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

/**
 * The Navigate tab's four views — Headings, Pages, Figures, Results.
 *
 * A SEGMENTED CONTROL rather than four more tabs, because these are four
 * answers to one question ("where is it?") and tabs would say they are four
 * different tools. Word's navigation pane has worked this way since 2010.
 */
function showView(name: string) {
  document.querySelectorAll<HTMLElement>('#navSeg button')
    .forEach(b => b.classList.toggle('on', b.dataset.view === name));
  document.querySelectorAll<HTMLElement>('.t-view')
    .forEach(p => p.classList.toggle('on', p.dataset.view === name));
}
for (const [view, text] of [['headings', t('Headings')], ['pages', t('Pages')],
                            ['figures', t('Figures')], ['results', t('Results')]] as const) {
  const b = document.querySelector<HTMLElement>(`#navSeg [data-view="${view}"]`);
  if (b) { b.textContent = text; b.addEventListener('click', () => showView(view)); }
}

/** Pages, each with the first heading that lands on it. */
function buildPages() {
  const box = document.getElementById('pages');
  if (!box) return;
  box.replaceChildren();
  const paperTop = paper.getBoundingClientRect().top + store.doc.page.marginTop;
  // Where each heading sits, measured once rather than per page.
  const heads = store.doc.body
    .filter(b => b.kind === 'h1' || b.kind === 'h2' || b.kind === 'h3')
    .map(b => {
      const node = paper.querySelector<HTMLElement>(`[data-id="${CSS.escape(b.id)}"]`);
      return { text: b.text, y: node ? node.getBoundingClientRect().top - paperTop : 0 };
    });
  for (const pg of metrics.pages) {
    const first = heads.find(h => h.y >= pg.start - 1 && (!isFinite(pg.end) || h.y < pg.end));
    const a = el('a', 'pagerow') as HTMLAnchorElement;
    a.innerHTML = `<span class="pg">${pg.n}</span>${esc(first ? first.text : t('(no heading)'))}`;
    a.addEventListener('click', () => {
      // scroll to the page's own top, not to a heading it may not contain
      paper.scrollIntoView({ behavior: 'smooth', block: 'start' });
      const wrap = paper.closest('.t-scroll');
      if (wrap) wrap.scrollTop = Math.max(0, pg.start);
    });
    box.appendChild(a);
  }
}

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
//
// The actual snapshot-taking, diffing and card-painting live in
// redlineview.ts, registered through the feature registry with its own panel
// host (`redlinePanel`) — see that file's header for why this used to be a
// `buildReview` here that painted into review.ts's `reviewPanel` and erased
// review.ts's live tracked-changes list every time a redline change was
// resolved. This wiring is just the two static ⋯-menu buttons calling in.
document.getElementById('snap')!.addEventListener('click', () => takeSnapshot(featureCtx));
document.getElementById('review')!.addEventListener('click', () => startReview(featureCtx));

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
//
// Same recipe as icons.ts (24x24 box, 16px render, stroke currentColor at
// width 2, round caps/joins) kept local rather than added to that file:
// only this button needs it, and icons.ts is a different owner's file.
const themeSvg = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const THEME_ICON: Record<ThemeChoice, string> = {
  auto: themeSvg('<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18Z" fill="currentColor" stroke="none"/>'),
  light: themeSvg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.5 1.5M17.6 17.6l1.5 1.5M2 12h2M20 12h2M4.9 19.1l1.5-1.5M17.6 6.4l1.5-1.5"/>'),
  dark: themeSvg('<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z"/>'),
};
// A FUNCTION, not a const object. Built at import time these three froze in
// whatever locale was current before the viewer's own was resolved — the rule
// i18n.ts states and the reason every registered label here is lazy.
const themeText = (c: ThemeChoice): string =>
  ({ auto: t('Auto'), light: t('Light'), dark: t('Dark') })[c];
// This is control (1) of the label rule above: the face has to say what the
// NEXT click leaves the app in, not just "theme", so it keeps its text label
// like Save/Saved does.
const paintTheme = () => {
  const choice = themeChoice();
  label('theme', THEME_ICON[choice],
    t('Theme: {mode} — click to cycle auto/light/dark', { mode: themeText(choice) }),
    themeText(choice));
};
byId('theme').addEventListener('click', () => {
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
// The properties panel starts CLOSED, and this is arithmetic rather than taste:
// the page is 816px plus a 250px note gutter, so with both panels open the
// document needs 1566px before it stops being scrolled sideways. A laptop does
// not have that. It opens on ] or the toolbar button, and slides makes the same
// trade on a phone by booting with both panels collapsed.
if (window.innerWidth < 1566) document.querySelector('.t-main')!.classList.add('t-props-off');

for (const f of readyFns()) f(featureCtx);
// Live collaboration (bento-sync) — dormant unless the doc carries collab
// creds or the user opts in via the Share button; see src/collab.ts.
import { initCollab } from './collab.ts';
initCollab(store, editor);
