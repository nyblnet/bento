// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The About dialog — what this file is, what version, and the controls that
// have nowhere else to live.
//
// WHY IT EXISTS AT ALL. bento/type had no route to any of this: no version
// anywhere in the UI, no way to check for an update, no way to change theme
// except a bar button with no explanation, and no answer to "what IS this
// file". Both other apps put that behind the wordmark, so a person who learns
// one app already knows where to look — and a wordmark that is only decoration
// wastes the one place everyone looks first (spaces/src/editor.ts says the
// same, and it is right).
//
// Modelled on spaces/src/about.ts, which is the smaller and more recent of the
// two precedents. Sections in the same order, so the three dialogs read as one
// product.

import { checkForUpdates, applyUpdate, APP_VERSION, type ReleaseInfo } from '../../kernel/src/update.ts';
import { canWriteInPlace, openedFileName } from '../../kernel/src/save.ts';
import { setTheme, themeChoice, type ThemeChoice } from '../../kernel/src/theme.ts';
import type { Store } from './store.ts';
import { wordCount, docForExport } from './model.ts';
import { t } from './i18n.ts';
import { knownAuthor, setAuthorName } from './comments.ts';
import './comments.css';
import { listVersions, type Snapshot } from './autosave.ts';

export interface AboutHooks {
  store: Store;
  /** pages, from the last pagination pass — the dialog does not re-measure */
  pages: number;
  onReplaceDoc(json: string): void;
}

const esc = (s: string) => s.replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export function openAbout({ store, pages, onReplaceDoc }: AboutHooks): void {
  const back = document.createElement('div');
  back.className = 't-overlay';
  const card = document.createElement('div');
  card.className = 't-dlg t-about';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', t('About this document'));
  const close = () => back.remove();

  const h = (text: string) => {
    const n = document.createElement('h2');
    n.className = 't-dlg-h';
    n.textContent = text;
    return n;
  };
  const p = (text: string, cls = 't-about-blurb') => {
    const n = document.createElement('p');
    n.className = cls;
    n.textContent = text;
    return n;
  };
  const row = (label: string, node: HTMLElement) => {
    const r = document.createElement('div');
    r.className = 't-row';
    const s = document.createElement('span');
    s.textContent = label;
    r.append(s, node);
    return r;
  };
  const button = (label: string, fn: () => void, primary = false) => {
    const b = document.createElement('button');
    b.className = 't-btn' + (primary ? ' t-primary' : '');
    b.textContent = label;
    b.addEventListener('click', fn);
    return b;
  };

  // ---- what this is -------------------------------------------------------
  const head = document.createElement('div');
  head.className = 't-about-head';
  head.innerHTML =
    '<a class="t-about-logo" href="https://bento.page" target="_blank" rel="noopener" ' +
    `title="${t('Visit bento.page (opens in a new tab)')}">` +
    '<svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">' +
    '<rect width="32" height="32" rx="7" fill="#16273E"/>' +
    '<rect x="5" y="5" width="7" height="22" rx="2.5" fill="#5E7699"/>' +
    '<rect x="14" y="5" width="13" height="10" rx="2.5" fill="#FF9E8A"/>' +
    '<rect x="14" y="17" width="13" height="10" rx="2.5" fill="#F0EBE0"/>' +
    '</svg><div><b>bento<span style="color:#FF9E8A">/</span>type</b>' +
    `<span>${esc(t('v{app} · format v{fmt}', { app: APP_VERSION, fmt: String(store.doc.version ?? 1) }))}</span></div></a>`;
  card.append(head);

  card.append(h(t('This file')));
  const notes = Object.keys(store.doc.footnotes ?? {}).length;
  card.append(p(t(
    '{pages} page(s) · {words} words · {blocks} blocks · {notes} footnote(s). ' +
    'The document, the editor and the typesetter are all in this one file.',
    { pages: pages || 1, words: wordCount(store.doc).toLocaleString(),
      blocks: store.doc.body.length, notes })));

  const fileName = openedFileName();
  if (fileName) card.append(row(t('File'), p(fileName, 't-about-val')));
  if (!canWriteInPlace()) {
    card.append(p(t(
      'This browser cannot write back to the file, so every save makes a new copy. ' +
      'Chrome and Edge on a computer can save in place.'), 't-note'));
  }

  // ---- updates ------------------------------------------------------------
  card.append(h(t('Updates')));
  const upStatus = p('', 't-about-val');
  const upRow = document.createElement('div');
  upRow.className = 't-row';
  let found: ReleaseInfo | null = null;
  const checkBtn = button(t('Check for updates'), async () => {
    upStatus.textContent = t('Checking…');
    const r = await checkForUpdates();
    if (r.status === 'update') {
      found = r.release;
      upStatus.textContent = t('Version {v} is available.', { v: r.release.version });
      applyBtn.hidden = false;
    } else if (r.status === 'current') {
      upStatus.textContent = t('Up to date — v{v}.', { v: APP_VERSION });
    } else {
      // A failed check is not an error worth alarming anyone with: the file
      // works offline by design, and that is the common reason it fails.
      upStatus.textContent = t('Could not check right now.');
    }
  });
  const applyBtn = button(t('Update this file'), async () => {
    if (found) await applyUpdate(found, store.doc as never);
  }, true);
  applyBtn.hidden = true;
  upRow.append(checkBtn, applyBtn);
  card.append(upRow, upStatus);
  card.append(p(t(
    'An update is a NEW file, downloaded beside this one — the original is untouched, ' +
    'so a bad update is undone by deleting it. Every release is signature-checked ' +
    'before it is applied.'), 't-note'));

  // ---- appearance ---------------------------------------------------------
  card.append(h(t('Appearance')));
  const themeSel = document.createElement('select');
  themeSel.className = 't-select';
  for (const [val, label] of [['auto', t('Follow the system')], ['light', t('Light')], ['dark', t('Dark')]] as const) {
    const o = document.createElement('option');
    o.value = val; o.textContent = label;
    o.selected = themeChoice() === val;
    themeSel.append(o);
  }
  themeSel.addEventListener('change', () => setTheme(themeSel.value as ThemeChoice));
  card.append(row(t('Theme'), themeSel));
  card.append(p(t(
    'The theme is yours, not the document’s — it is remembered in this browser and ' +
    'never saved into the file. The PAGE stays white in both, because paper is white ' +
    'and somebody proofing a contract at midnight still has to see what will print.'),
    't-note'));

  // ---- you ------------------------------------------------------------
  //
  // WHY THIS HAS TO EXIST: comments.ts's authorName() has always had a name to
  // attribute comments and tracked changes to — it just never gave you a way
  // to SEE or CORRECT it, only a one-shot prompt() the first time you left a
  // comment. This is the one place in the app that shows the name and lets it
  // change; authorName()'s prompt stays as the fallback for someone who never
  // opened About before commenting or turning on tracking (both read/write the
  // same 'bento-author' key, so whichever runs first is what the other sees).
  card.append(h(t('You')));
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 't-input t-about-name-input';
  nameInput.placeholder = t('Your name');
  nameInput.value = knownAuthor();
  nameInput.autocomplete = 'off';
  // applied on blur/Enter, not on every keystroke: a comment or tracked
  // change made mid-edit must attribute to the name as it stood at that
  // moment, not flicker with whatever is half-typed into this field right now
  const commitName = () => setAuthorName(nameInput.value);
  nameInput.addEventListener('change', commitName);
  nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') { commitName(); nameInput.blur(); } });
  card.append(row(t('Name'), nameInput));
  card.append(p(t(
    'A self-asserted claim, not an identity — this is the name shown beside ' +
    'your comments and tracked changes, and anyone can type any name here. ' +
    'It is remembered in this browser, applies immediately, and is never ' +
    'itself saved into the file (only the comments and changes it signs are).'),
    't-note'));

  // ---- the document, for tools --------------------------------------------
  card.append(h(t('Document')));
  card.append(row(t('Document id'), p(String(store.doc.docId ?? ''), 't-about-val t-mono')));
  const jsonRow = document.createElement('div');
  jsonRow.className = 't-row';
  jsonRow.append(
    button(t('Copy document JSON'), async () => {
      // docForExport, never store.doc — see model.ts. This text can be pasted
      // anywhere, and the raw document carries the room's private keys.
      try { await navigator.clipboard.writeText(JSON.stringify(docForExport(store.doc), null, 2)); }
      catch { /* clipboard blocked — the agent surface below still works */ }
    }),
    button(t('Replace from JSON…'), () => {
      const json = prompt(t('Paste a bento/type document JSON. This replaces the document and can be undone with ⌘Z.'));
      if (json) onReplaceDoc(json);
    }),
  );
  card.append(jsonRow);
  card.append(p(t(
    'The document is the interchange unit: hand this JSON to an AI, get one back, ' +
    'and paste it in. `window.bento` exposes the same thing to scripts.'), 't-note'));

  // ---- version history -----------------------------------------------------
  //
  // Browses the auto-save timeline autosave.ts keeps in IndexedDB (never in
  // the file, never online). Restoring reuses `onReplaceDoc` exactly as
  // "Replace from JSON…" does above — `Snapshot.json` already IS a bento/type
  // document JSON string — so this needed no new hook into main.ts: parseDoc
  // validates it, store.replace makes it undoable, editor.render() repaints.
  const historyRow = document.createElement('div');
  historyRow.className = 't-row';
  historyRow.append(button(t('Version history…'), () => openVersionHistory({ store, onReplaceDoc, close })));
  card.append(historyRow);
  card.append(p(t(
    'Versions are saved automatically as you edit, kept only in this browser, ' +
    'and never uploaded. Restoring is undoable with ⌘Z.'), 't-note'));

  // ---- credits ------------------------------------------------------------
  card.append(h(t('Credits')));
  card.append(p(t(
    'bento/type is MIT-licensed. Line breaking uses the Knuth–Plass algorithm ' +
    'via tex-linebreak; hyphenation patterns are Liang’s. Everything runs in ' +
    'this file — nothing is fetched, and nothing is sent anywhere.'), 't-note'));

  const foot = document.createElement('div');
  foot.className = 't-dlg-foot';
  foot.append(button(t('Close'), close, true));
  card.append(foot);

  back.append(card);
  back.addEventListener('click', e => { if (e.target === back) close(); });
  document.addEventListener('keydown', function esc2(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc2); }
  });
  document.body.append(back);
}

/**
 * Version history — a second small dialog over the About card, listing the
 * auto-save timeline newest-first. Kept separate from `openAbout` rather than
 * inlined: the row list is fetched async (IndexedDB), and About itself must
 * render synchronously the moment the wordmark is clicked.
 */
async function openVersionHistory(
  { store, onReplaceDoc, close: closeAbout }: { store: Store; onReplaceDoc(json: string): void; close(): void },
): Promise<void> {
  const versions = await listVersions(store.doc.docId);

  const back = document.createElement('div');
  back.className = 't-overlay';
  const card = document.createElement('div');
  card.className = 't-dlg';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', t('Version history'));
  const close = () => back.remove();

  const h = document.createElement('h2');
  h.className = 't-dlg-h';
  h.textContent = t('Version history');
  card.append(h);

  if (!versions.length) {
    const empty = document.createElement('p');
    empty.className = 't-note';
    empty.textContent = t('No saved versions yet — they accumulate as you edit.');
    card.append(empty);
  } else {
    const list = document.createElement('div');
    versions.forEach((v: Snapshot, i: number) => {
      const rowEl = document.createElement('button');
      rowEl.type = 'button';
      rowEl.className = 't-btn';
      rowEl.style.cssText = 'display:flex;width:100%;justify-content:space-between;gap:10px;margin:4px 0;';
      const when = new Date(v.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const label = document.createElement('span');
      label.textContent = i === 0 ? t('{when} (most recent)', { when }) : when;
      const doIt = document.createElement('span');
      doIt.className = 't-note';
      doIt.textContent = t('Restore');
      rowEl.append(label, doIt);
      rowEl.addEventListener('click', () => {
        onReplaceDoc(v.json);
        close();
        closeAbout();
      });
      list.append(rowEl);
    });
    card.append(list);
  }

  const fine = document.createElement('p');
  fine.className = 't-note';
  fine.textContent = t('Stored only in this browser, never in the file or online.');
  card.append(fine);

  const foot = document.createElement('div');
  foot.className = 't-dlg-foot';
  const closeBtn = document.createElement('button');
  closeBtn.className = 't-btn t-primary';
  closeBtn.type = 'button';
  closeBtn.textContent = t('Close');
  closeBtn.addEventListener('click', close);
  foot.append(closeBtn);
  card.append(foot);

  back.append(card);
  back.addEventListener('click', e => { if (e.target === back) close(); });
  document.addEventListener('keydown', function esc2(e) {
    if (e.key === 'Escape') { e.stopPropagation(); close(); document.removeEventListener('keydown', esc2); }
  });
  document.body.append(back);
}
