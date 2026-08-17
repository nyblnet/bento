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
import { wordCount } from './model.ts';

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
  card.setAttribute('aria-label', 'About this document');
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
    'title="Visit bento.page (opens in a new tab)">' +
    '<svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">' +
    '<rect width="32" height="32" rx="7" fill="#16273E"/>' +
    '<rect x="5" y="5" width="7" height="22" rx="2.5" fill="#5E7699"/>' +
    '<rect x="14" y="5" width="13" height="10" rx="2.5" fill="#FF9E8A"/>' +
    '<rect x="14" y="17" width="13" height="10" rx="2.5" fill="#F0EBE0"/>' +
    '</svg><div><b>bento<span style="color:#FF9E8A">/</span>type</b>' +
    `<span>v${esc(APP_VERSION)} · format v${esc(String(store.doc.version ?? 1))}</span></div></a>`;
  card.append(head);

  card.append(h('This file'));
  const notes = Object.keys(store.doc.footnotes ?? {}).length;
  card.append(p(
    `${pages || 1} page${pages === 1 ? '' : 's'} · ` +
    `${wordCount(store.doc).toLocaleString()} words · ` +
    `${store.doc.body.length} blocks · ${notes} footnote${notes === 1 ? '' : 's'}. ` +
    'The document, the editor and the typesetter are all in this one file.'));

  const fileName = openedFileName();
  if (fileName) card.append(row('File', p(fileName, 't-about-val')));
  if (!canWriteInPlace()) {
    card.append(p(
      'This browser cannot write back to the file, so every save makes a new copy. ' +
      'Chrome and Edge on a computer can save in place.', 't-note'));
  }

  // ---- updates ------------------------------------------------------------
  card.append(h('Updates'));
  const upStatus = p('', 't-about-val');
  const upRow = document.createElement('div');
  upRow.className = 't-row';
  let found: ReleaseInfo | null = null;
  const checkBtn = button('Check for updates', async () => {
    upStatus.textContent = 'Checking…';
    const r = await checkForUpdates();
    if (r.status === 'update') {
      found = r.release;
      upStatus.textContent = `Version ${r.release.version} is available.`;
      applyBtn.hidden = false;
    } else if (r.status === 'current') {
      upStatus.textContent = `Up to date — v${APP_VERSION}.`;
    } else {
      // A failed check is not an error worth alarming anyone with: the file
      // works offline by design, and that is the common reason it fails.
      upStatus.textContent = 'Could not check right now.';
    }
  });
  const applyBtn = button('Update this file', async () => {
    if (found) await applyUpdate(found, store.doc as never);
  }, true);
  applyBtn.hidden = true;
  upRow.append(checkBtn, applyBtn);
  card.append(upRow, upStatus);
  card.append(p(
    'An update is a NEW file, downloaded beside this one — the original is untouched, ' +
    'so a bad update is undone by deleting it. Every release is signature-checked ' +
    'before it is applied.', 't-note'));

  // ---- appearance ---------------------------------------------------------
  card.append(h('Appearance'));
  const themeSel = document.createElement('select');
  themeSel.className = 't-select';
  for (const [val, label] of [['auto', 'Follow the system'], ['light', 'Light'], ['dark', 'Dark']] as const) {
    const o = document.createElement('option');
    o.value = val; o.textContent = label;
    o.selected = themeChoice() === val;
    themeSel.append(o);
  }
  themeSel.addEventListener('change', () => setTheme(themeSel.value as ThemeChoice));
  card.append(row('Theme', themeSel));
  card.append(p(
    'The theme is yours, not the document’s — it is remembered in this browser and ' +
    'never saved into the file. The PAGE stays white in both, because paper is white ' +
    'and somebody proofing a contract at midnight still has to see what will print.',
    't-note'));

  // ---- the document, for tools --------------------------------------------
  card.append(h('Document'));
  card.append(row('Document id', p(String(store.doc.docId ?? ''), 't-about-val t-mono')));
  const jsonRow = document.createElement('div');
  jsonRow.className = 't-row';
  jsonRow.append(
    button('Copy document JSON', async () => {
      try { await navigator.clipboard.writeText(JSON.stringify(store.doc, null, 2)); }
      catch { /* clipboard blocked — the agent surface below still works */ }
    }),
    button('Replace from JSON…', () => {
      const json = prompt('Paste a bento/type document JSON. This replaces the document and can be undone with ⌘Z.');
      if (json) onReplaceDoc(json);
    }),
  );
  card.append(jsonRow);
  card.append(p(
    'The document is the interchange unit: hand this JSON to an AI, get one back, ' +
    'and paste it in. `window.bento` exposes the same thing to scripts.', 't-note'));

  // ---- credits ------------------------------------------------------------
  card.append(h('Credits'));
  card.append(p(
    'bento/type is MIT-licensed. Line breaking uses the Knuth–Plass algorithm ' +
    'via tex-linebreak; hyphenation patterns are Liang’s. Everything runs in ' +
    'this file — nothing is fetched, and nothing is sent anywhere.', 't-note'));

  const foot = document.createElement('div');
  foot.className = 't-dlg-foot';
  foot.append(button('Close', close, true));
  card.append(foot);

  back.append(card);
  back.addEventListener('click', e => { if (e.target === back) close(); });
  document.addEventListener('keydown', function esc2(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc2); }
  });
  document.body.append(back);
}
