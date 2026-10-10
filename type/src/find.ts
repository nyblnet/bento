// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Find and replace.
//
// NEEDS FROM THE CORE:
//   1. `PanelSpec.update` is declared in features.ts ("called whenever the
//      document changes") and main.ts NEVER CALLS IT — the panel loop at
//      main.ts:342 only calls `spec.mount`. So a feature that implements
//      `update` is silently dead. This module works around it by subscribing to
//      `ctx.store.on(...)` itself, which is correct but means every panel will
//      grow its own subscription and its own de-duplication. Fix: in the panel
//      loop, `if (spec.update) store.on(() => spec.update!(panel, featureCtx))`
//      — or drop `update` from the interface so it cannot be believed.
//   2. There is no way for a feature to SHOW its own panel. `showTab` is a
//      local function in main.ts, and ⌘F must raise the Find panel (and undo a
//      collapsed sidebar) to be worth anything. This module therefore clicks
//      the registered tab button and clears `.t-side-off` through the DOM,
//      which works but reaches into chrome the registry is supposed to hide.
//      Fix: add `showPanel(id: string): void` to FeatureContext.
//
// WHAT THIS FILE IS CAREFUL ABOUT.
//
// A. A REPLACE IS A SPLICE, and the splice already exists. `model.spliceText`
//    moves marks AND footnote anchors together, because they are offsets into
//    the same string and a version that moved only one of them is a bug this
//    project has already paid for. So replace does no offset arithmetic of its
//    own — it computes WHERE, and spliceText does the rest.
//
// B. HIGHLIGHTS ARE NOT IN THE DOCUMENT. A match is a decoration: ranges handed
//    to the CSS Custom Highlight API, which paints without touching the DOM at
//    all. That matters for three separate reasons — a mark would be saved to
//    disk and signed, a wrapper element inside contentEditable would move the
//    caret and be read back into the model by `readBlock`, and either one would
//    make searching an undoable edit. Where the API is missing, the current
//    match is shown by SELECTING it, which is a decoration the browser owns.
//
// C. SEARCH IS INDEX-EXACT. Case folding is done per character and only when
//    the fold is one character long (see `fold`), because `'İ'.toLowerCase()`
//    is TWO characters: a lowercased haystack can be longer than the text it
//    came from, and then every offset after it addresses the wrong place — a
//    replace would splice into the middle of a word. Being slightly less clever
//    about Turkish dotted capitals is the right trade against corrupting marks.
//
// Every block is searched, and that is free: list items and table cells ARE
// blocks (model.ts), so `doc.body` already is every searchable character.

import { registerKey, registerPanel, registerTool, type FeatureContext } from './features.ts';
import { t } from './i18n.ts';
import { spliceText, type Block } from './model.ts';
import { isNoteAtom } from './render.ts';

// ───────────────────────────────────────────────────────────── the search

export interface FindOpts {
  matchCase?: boolean;
  wholeWord?: boolean;
}

/** One hit: which block, and the half-open character range inside its text. */
export interface Match {
  /** index into doc.body — the document order matches are stepped through in */
  block: number;
  /** the block's id, so a match survives a re-render */
  id: string;
  from: number;
  /** exclusive */
  to: number;
}

/** What counts as being inside a word, for the whole-word option. */
const WORD = /[\p{L}\p{N}_]/u;

/**
 * Length-preserving case fold. A character whose lowercase form is not exactly
 * one character is left alone rather than expanded — see note C above. The
 * cost is that 'İ' does not match 'i̇' case-insensitively; the alternative is
 * offsets that drift by one for the rest of the paragraph.
 */
const fold = (s: string): string => {
  let out = '';
  for (const ch of s) {
    const low = ch.toLowerCase();
    out += [...low].length === [...ch].length ? low : ch;
  }
  return out;
};

/** Every occurrence of `query` in `text`, as [from, to) pairs, in order. */
export function matchesInText(text: string, query: string, opts: FindOpts = {}): Array<[number, number]> {
  if (!query) return [];
  const hay = opts.matchCase ? text : fold(text);
  const needle = opts.matchCase ? query : fold(query);
  // The fold is per character, so this can only fail on a lone surrogate or a
  // fold that is legitimately shorter; either way, matching the raw text is
  // safer than matching a string whose indices no longer address `text`.
  const subject = hay.length === text.length ? hay : text;
  const want = hay.length === text.length ? needle : query;
  const out: Array<[number, number]> = [];
  let at = 0;
  for (;;) {
    const i = subject.indexOf(want, at);
    if (i < 0) break;
    const end = i + want.length;
    // Matches never overlap: after a hit, resume at its end. Without that,
    // searching "aa" in "aaaa" reports three hits, two of which share
    // characters — and replacing them in turn would splice text that the
    // previous replacement already removed.
    at = end;
    if (opts.wholeWord) {
      const before = i > 0 ? text[i - 1] : '';
      const after = end < text.length ? text[end] : '';
      if ((before && WORD.test(before)) || (after && WORD.test(after))) continue;
    }
    out.push([i, end]);
  }
  return out;
}

/** Every match in the document, in document order. */
export function findMatches(body: readonly Block[], query: string, opts: FindOpts = {}): Match[] {
  const out: Match[] = [];
  body.forEach((b, block) => {
    for (const [from, to] of matchesInText(b.text, query, opts)) {
      out.push({ block, id: b.id, from, to });
    }
  });
  return out;
}

/**
 * Replace one match, through `spliceText` so marks and footnote anchors follow.
 * Returns a NEW block; the caller decides where to put it.
 */
export function replaceMatch(block: Block, m: Match, replacement: string): Block {
  return spliceText(block, m.from, m.to - m.from, replacement);
}

/**
 * Replace every match in the body. Pure: returns a new array, and the blocks
 * that had no match are the SAME objects, so the store's snapshot of the
 * document stays cheap.
 *
 * Within a block the matches are applied BACK TO FRONT, so that each splice
 * happens at an offset the earlier splices have not moved. Doing it forwards
 * and adding a running delta is the same computation with one more place to be
 * wrong, and it silently breaks whenever the replacement changes length.
 */
export function replaceAll(body: readonly Block[], query: string, replacement: string,
                           opts: FindOpts = {}): { body: Block[]; count: number } {
  let count = 0;
  const out = body.map(b => {
    const hits = matchesInText(b.text, query, opts);
    if (!hits.length) return b;
    count += hits.length;
    let next = b;
    for (let i = hits.length - 1; i >= 0; i--) {
      next = spliceText(next, hits[i][0], hits[i][1] - hits[i][0], replacement);
    }
    return next;
  });
  return { body: out, count };
}

/**
 * The first match at or after a position — where the cursor lands once a
 * replacement has shifted everything after it.
 *
 * It steps PAST the text just inserted rather than back to index 0, because a
 * replacement that contains the query ("cat" → "cats") would otherwise put the
 * cursor on the match it just made and Replace would never advance.
 */
export function nextFrom(matches: readonly Match[], block: number, at: number): number {
  const i = matches.findIndex(m => m.block > block || (m.block === block && m.from >= at));
  return i < 0 ? (matches.length ? 0 : -1) : i;
}

// ─────────────────────────────────────────────────────────── decoration

const HL_OTHER = 't-find';
const HL_CURRENT = 't-find-cur';

/** The highlight registry, when the browser has one. Never assume it does. */
const registry = (): HighlightRegistry | null =>
  typeof CSS !== 'undefined' && 'highlights' in CSS ? CSS.highlights : null;

/**
 * The DOM point `at` characters into a rendered block.
 *
 * Footnote markers are skipped: they are atoms that occupy a position and no
 * characters (render.ts), which is the same rule the caret uses. Counting them
 * would make every highlight after a note land one character late.
 */
function pointAt(root: HTMLElement, at: number): { node: Node; offset: number } | null {
  let count = 0;
  let last: { node: Node; offset: number } | null = null;
  const walk = (n: Node): { node: Node; offset: number } | null => {
    if (n.nodeType === 3) {
      const len = n.nodeValue!.length;
      if (count + len >= at) return { node: n, offset: at - count };
      count += len;
      last = { node: n, offset: len };
      return null;
    }
    if (n.nodeType === 1 && isNoteAtom(n as Element)) return null;
    for (const c of Array.from(n.childNodes)) { const r = walk(c); if (r) return r; }
    return null;
  };
  for (const c of Array.from(root.childNodes)) { const r = walk(c); if (r) return r; }
  return last;
}

function rangeFor(host: HTMLElement, m: Match): Range | null {
  const el = host.querySelector<HTMLElement>(`[data-id="${CSS.escape(m.id)}"]`);
  if (!el) return null;
  const a = pointAt(el, m.from), b = pointAt(el, m.to);
  if (!a || !b) return null;
  const r = document.createRange();
  r.setStart(a.node, a.offset);
  r.setEnd(b.node, b.offset);
  return r;
}

// ────────────────────────────────────────────────────────────── the panel

/** Everything the panel needs to remember between keystrokes. */
interface State {
  query: string;
  replacement: string;
  opts: FindOpts;
  matches: Match[];
  cur: number;
}

class FindPanel {
  readonly #ctx: FeatureContext;
  readonly #state: State = { query: '', replacement: '', opts: {}, matches: [], cur: -1 };
  #q!: HTMLInputElement;
  #r!: HTMLInputElement;
  #count!: HTMLElement;
  #buttons: HTMLButtonElement[] = [];

  constructor(host: HTMLElement, ctx: FeatureContext) {
    this.#ctx = ctx;
    this.#build(host);
    // See NEEDS FROM THE CORE (1): the registry's own `update` hook is never
    // called, so the panel watches the document itself. Re-running the search
    // on every commit is what keeps the count honest while somebody types.
    ctx.store.on(() => this.#rerun());
  }

  // ─────────────────────────────────────────────────────────── chrome

  #build(host: HTMLElement): void {
    const box = document.createElement('div');
    box.className = 't-find';

    this.#q = document.createElement('input');
    this.#q.type = 'text';
    this.#q.className = 't-find-q';
    this.#q.placeholder = t('Find in document');
    this.#q.setAttribute('aria-label', t('Find in document'));

    this.#r = document.createElement('input');
    this.#r.type = 'text';
    this.#r.className = 't-find-r';
    this.#r.placeholder = t('Replace with');
    this.#r.setAttribute('aria-label', t('Replace with'));

    const opts = document.createElement('div');
    opts.className = 't-find-opts';
    const option = (label: string, set: (on: boolean) => void) => {
      const l = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.addEventListener('change', () => { set(cb.checked); this.#search(true); });
      l.append(cb, document.createTextNode(label));
      opts.appendChild(l);
    };
    option(t('Match case'), on => { this.#state.opts.matchCase = on; });
    option(t('Whole word'), on => { this.#state.opts.wholeWord = on; });

    const bar = document.createElement('div');
    bar.className = 't-find-bar';
    this.#count = document.createElement('span');
    this.#count.className = 't-find-count';
    const prev = this.#button(t('Previous match (⇧Enter)'), '↑', () => this.step(-1));
    const next = this.#button(t('Next match (Enter)'), '↓', () => this.step(1));
    bar.append(this.#count, prev, next);

    const actions = document.createElement('div');
    actions.className = 't-find-actions';
    actions.append(
      this.#button(t('Replace this match'), t('Replace'), () => this.#replaceCurrent()),
      this.#button(t('Replace every match, as one undo step'), t('Replace all'), () => this.#replaceAll()),
    );

    this.#q.addEventListener('input', () => this.#search(true));
    this.#q.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      this.step(e.shiftKey ? -1 : 1);
    });
    this.#r.addEventListener('input', () => { this.#state.replacement = this.#r.value; });
    this.#r.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); this.#replaceCurrent(); }
    });
    for (const el of [this.#q, this.#r]) {
      el.addEventListener('keydown', e => { if (e.key === 'Escape') this.close(); });
    }

    box.append(this.#q, this.#r, opts, bar, actions);
    host.appendChild(box);
    this.#paint();
  }

  #button(title: string, label: string, run: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.title = title;
    b.textContent = label;
    // mousedown, not click: pressing a button must not cost the caret, which is
    // the same reason the toolbar in main.ts binds mousedown.
    b.addEventListener('mousedown', e => { e.preventDefault(); run(); });
    this.#buttons.push(b);
    return b;
  }

  // ───────────────────────────────────────────────────────── searching

  /** Re-run the search. `reset` re-picks the current match from the top. */
  #search(reset: boolean): void {
    const s = this.#state;
    s.query = this.#q.value;
    const before = s.matches[s.cur];
    s.matches = findMatches(this.#ctx.store.doc.body, s.query, s.opts);
    if (reset || !before) {
      s.cur = s.matches.length ? 0 : -1;
    } else {
      const i = nextFrom(s.matches, before.block, before.from);
      s.cur = s.matches.length ? Math.max(0, i) : -1;
    }
    this.#paint();
    this.#repaint();
  }

  /** The document changed under us — keep the count and the cursor sane. */
  #rerun(): void {
    if (!this.#state.query) return;
    this.#search(false);
  }

  step(by: 1 | -1): void {
    const s = this.#state;
    if (!s.matches.length) return;
    // wraps, in both directions: a find that stops at the end of the document
    // makes people scroll back to the top by hand
    s.cur = (s.cur + by + s.matches.length) % s.matches.length;
    this.#paint();
    this.#repaint();
    this.#reveal();
  }

  #paint(): void {
    const s = this.#state;
    this.#count.textContent = !s.query ? ''
      : !s.matches.length ? t('No matches')
      : t('{n} of {total}', { n: s.cur + 1, total: s.matches.length });
    for (const b of this.#buttons) b.disabled = !s.matches.length;
  }

  // ─────────────────────────────────────────────────────── highlighting

  #frame: number | null = null;

  /**
   * Paint on the NEXT frame, never in this one.
   *
   * A document change re-renders the body, and the re-render happens AFTER the
   * store has told its listeners — so decorating straight from the listener
   * builds ranges over nodes that are about to be thrown away, and the
   * highlights vanish while the count stays right. Measured exactly that way:
   * ⌘Z after a Replace all left "1 of 3" on screen with nothing painted.
   */
  #repaint(): void {
    if (this.#frame !== null) cancelAnimationFrame(this.#frame);
    this.#frame = requestAnimationFrame(() => { this.#frame = null; this.#decorate(); });
  }

  #decorate(): void {
    const s = this.#state;
    const reg = registry();
    if (!reg) return;
    reg.delete(HL_OTHER);
    reg.delete(HL_CURRENT);
    if (!s.matches.length) return;
    const host = this.#ctx.editor.host;
    const others = s.matches
      .filter((_, i) => i !== s.cur)
      .map(m => rangeFor(host, m))
      .filter((r): r is Range => r !== null);
    const current = s.matches[s.cur] ? rangeFor(host, s.matches[s.cur]) : null;
    if (others.length) reg.set(HL_OTHER, new Highlight(...others));
    if (current) {
      const hl = new Highlight(current);
      // the current match must win where the two overlap, which they cannot
      // today — but they will the moment a match is ever painted twice
      hl.priority = 1;
      reg.set(HL_CURRENT, hl);
    }
  }

  /** Bring the current match on screen — and, with no highlight API, show it. */
  #reveal(): void {
    const s = this.#state;
    const m = s.matches[s.cur];
    if (!m) return;
    const host = this.#ctx.editor.host;
    const el = host.querySelector<HTMLElement>(`[data-id="${CSS.escape(m.id)}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (registry()) return;
    // Fallback: the browser's own selection is a decoration too, and it is the
    // one every browser has. It costs the focus of the find field, so it is
    // never done when the highlight API is available.
    const r = rangeFor(host, m);
    if (!r) return;
    const sel = getSelection();
    sel?.removeAllRanges();
    sel?.addRange(r);
  }

  // ───────────────────────────────────────────────────────── replacing

  #replaceCurrent(): void {
    const s = this.#state;
    const m = s.matches[s.cur];
    if (!m) return;
    const { store } = this.#ctx;
    store.breakRun();
    store.commit(d => {
      const i = d.body.findIndex(b => b.id === m.id);
      if (i < 0) return;
      d.body[i] = replaceMatch(d.body[i], m, s.replacement);
    }, { scope: { block: m.id } });
    this.#ctx.refresh();
    // Re-find, then land on the first match PAST the text just written, so a
    // replacement containing the query does not re-match itself for ever.
    s.matches = findMatches(store.doc.body, s.query, s.opts);
    s.cur = s.matches.length ? Math.max(0, nextFrom(s.matches, m.block, m.from + s.replacement.length)) : -1;
    this.#paint();
    this.#repaint();
    this.#reveal();
  }

  #replaceAll(): void {
    const s = this.#state;
    if (!s.query || !s.matches.length) return;
    const { store } = this.#ctx;
    store.breakRun();
    let count = 0;
    // ONE commit, so the whole sweep is ONE ⌘Z. A per-match commit would make
    // undoing a 400-match replace a physical exercise.
    store.commit(d => {
      const r = replaceAll(d.body, s.query, s.replacement, s.opts);
      d.body = r.body;
      count = r.count;
    });
    store.breakRun();
    this.#ctx.refresh();
    this.#search(true);
    this.#ctx.toast(count === 1 ? t('Replaced 1 match') : t('Replaced {n} matches', { n: count }));
  }

  // ──────────────────────────────────────────────────────────── opening

  /** ⌘F: raise the panel, seed it from the selection, take the focus. */
  focus(): void {
    const c = this.#ctx.editor.caret();
    if (c && c.to !== undefined && c.to !== c.at) {
      const blk = this.#ctx.store.block(c.id);
      const word = blk?.text.slice(Math.min(c.at, c.to), Math.max(c.at, c.to)) ?? '';
      if (word && !word.includes('\n')) this.#q.value = word;
    }
    this.#q.focus();
    this.#q.select();
    this.#search(true);
    if (this.#state.cur >= 0) this.#reveal();
  }

  /** Escape: stop painting matches, and give the document back its focus. */
  close(): void {
    const reg = registry();
    reg?.delete(HL_OTHER);
    reg?.delete(HL_CURRENT);
    this.#state.matches = [];
    this.#state.cur = -1;
    this.#paint();
    this.#ctx.editor.host.focus();
  }
}

// ────────────────────────────────────────────────────────── registration

let panel: FindPanel | null = null;

/**
 * Show the Find panel. See NEEDS FROM THE CORE (2): with no `showPanel` on the
 * context, the tab the registry itself created is clicked, and a sidebar the
 * reader collapsed is re-opened first — ⌘F that reveals nothing is a bug
 * report, not a shortcut.
 */
function showPanel(): void {
  document.querySelector('.t-main')?.classList.remove('t-side-off');
  document.querySelector<HTMLElement>('.t-tabs button[data-tab="find"]')?.click();
}

// The house icon recipe, from icons.ts: 24 box, 16 render, currentColor,
// width 2, round caps and joins. Declared here rather than added to icons.ts so
// that everything belonging to this feature stays in this file.
const SEARCH_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<circle cx="11" cy="11" r="7"/><line x1="16.2" y1="16.2" x2="21" y2="21"/></svg>';

registerPanel({
  id: 'find',
  // A GETTER, not a value: a label computed at registration time would freeze
  // before the viewer's locale is resolved (i18n.ts). The registry reads it
  // when it builds the tab, which is late enough.
  get label() { return t('Find'); },
  // the Results view of the Navigate tab — Word's navigation pane has held
  // headings, pages and search results together for twenty years, and search
  // results ARE navigation: a list of places to go
  host: 'findHost',
  order: 40,
  mount(host, ctx) { panel = new FindPanel(host, ctx); },
});

registerTool({
  id: 'find',
  icon: SEARCH_ICON,
  get title() { return t('Find and replace (⌘F)'); },
  group: 'review',
  order: 10,
  run() { showPanel(); panel?.focus(); },
});

registerKey({
  key: 'f',
  mod: true,
  run() { showPanel(); panel?.focus(); },
});
