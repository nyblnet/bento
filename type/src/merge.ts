// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// MAIL MERGE — one document, a spreadsheet, and N finished documents.
//
// Bind this document's fields (fields.ts) to the columns of a `bento/dash`
// sheet and emit ONE COMPLETE `.bento.html` PER ROW: 200 rows in, 200
// self-contained files out, each exactly the kind of file that produced it,
// entirely offline, with no service and no account. That is the feature, and
// the reason it can exist at all is that a Bento document already carries its
// own viewer — a merged letter is not a PDF of a letter, it is a letter that
// opens, edits, prints and signs like the template did.
//
// ────────────────────────────────────────────────────────────────────────────
// WHAT A MERGED FILE CARRIES, AND WHAT IT MUST NOT
//
//   docId       FRESH, per output. `docId` is IDENTITY (PLATFORM §3): autosave
//               keys recovery by it, the version timeline is keyed by it, and
//               collaboration rooms are minted against it. Two hundred letters
//               sharing the template's docId would be two hundred files that
//               autosave believes are the same document — open the second one
//               and it offers to restore the first one's text over it. So the
//               one field the format says never to regenerate is MINTED here,
//               because these are new documents rather than copies of one.
//
//   collab      GONE. `docForExport` strips it by REMOVING the field, so a
//               private key added to the credentials later is covered without
//               anyone remembering this line. The template's room key and
//               owner key are a live write capability on the author's own
//               document; shipping them to every recipient hands each of them
//               edit access to the master, unrevocably.
//
//   signatures  DROPPED. A signature covers a canonical form of the document
//               that signed it. Change one word of a letter and the signature
//               over the template covers nothing it claims to — carrying it
//               forward would put a broken seal, or worse a convincing one, on
//               every output.
//
//   comments    DROPPED. Drafting notes on the template ("check this figure
//   revisions   with legal") are not for two hundred recipients, and neither is
//               the revision history — `Revision.body` is a WHOLE COPY of the
//               document as it was, so carrying it forward both multiplies the
//               output by every draft and mails every recipient the earlier
//               wording of the clauses they are being sent. It is the same
//               disclosure a .docx makes when nobody remembers to inspect it.
//
//   merge       ADDED: `{ source, columns, row }`. This is the reason the
//               output is still a document. The row's VALUES live here and the
//               body still holds FIELDS, so the letter renders resolved,
//               re-renders resolved after an edit, and can say where its data
//               came from. Baking the values into the text would have been
//               fewer bytes and would have thrown the whole invariant away.
//
// ────────────────────────────────────────────────────────────────────────────
// TWENTY THOUSAND ROWS
//
// Each output is a whole app shell (~600 KB), so 200 rows is ~120 MB of
// writing and 20,000 rows is twelve gigabytes. Three consequences, all of them
// visible in the code below:
//
//   · ONE FILE IS HELD AT A TIME. The loop serializes, writes, and drops the
//     string. Nothing accumulates an array of outputs, which is what would turn
//     a large run into a tab crash instead of a long wait.
//   · IT YIELDS, AND IT CAN BE STOPPED. A `for` loop over 20,000 serializations
//     freezes the tab with no progress and no way out. Every row awaits a
//     macrotask so the browser paints, the dialog counts up, and Stop is a
//     button rather than the reload key.
//   · PAST `MERGE_WARN` IT REQUIRES A FOLDER. Below it, a browser without the
//     File System Access API can download the outputs one by one; above it,
//     that is thousands of download prompts and the run is refused with the
//     reason rather than started and abandoned halfway. Nothing is capped —
//     dash's rule (docs/DECISIONS.md 2026-08-02): say what will break, never
//     refuse a workable file.

import { t } from './i18n.ts';
import { registerMenuItem, type FeatureContext } from './features.ts';
import { docForExport, newDocId, spliceText, type TypeDoc } from './model.ts';
// Importing fields.ts here is also what MOUNTS it: registry.ts switches this
// feature on with one line, and the field engine comes with the merge that
// needs it.
import { bindTokens, fieldKey, isBuiltin, safeFieldName } from './fields.ts';
import { readArtifact } from './embed.ts';
import { downloadFile, serializeAuto } from '../../kernel/src/save.ts';

/** Rows past which a run needs a real folder to write into. */
export const MERGE_WARN = 200;

// ────────────────────────────────────────────────────────── reading the sheet

export interface MergeSheet {
  id: string;
  name: string;
  columns: string[];
  /** one entry per row, keyed by `fieldKey(column)` */
  rows: Array<Record<string, string>>;
  /** columns that could not be read, with why — reported, never hidden */
  skipped: string[];
}

export interface MergeSource {
  title: string;
  sheets: MergeSheet[];
}

/**
 * A cell value as merge text.
 *
 * The UNDERLYING value, deliberately, not dash's display format. Applying a
 * column's `format` pattern would mean carrying dash's formatter into this app
 * — a second implementation of somebody else's rules, wrong the first time they
 * change one. A merge writes what the cell holds; a document that needs "$1,200"
 * rather than "1200" formats it in the sheet, in a text column, where the
 * author can see what they will get.
 */
export const cellText = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return '';
};

/** Decode one `ColumnData` (dash's model.ts) into positional values. */
function columnValues(enc: unknown, n: number): unknown[] | null {
  if (!enc || typeof enc !== 'object') return null;
  const d = enc as Record<string, unknown>;
  if (d.enc === 'raw' && Array.isArray(d.v)) return d.v.slice(0, n);
  if (d.enc === 'dict' && Array.isArray(d.dict) && Array.isArray(d.idx)) {
    const dict = d.dict as unknown[];
    return (d.idx as Array<number | null>).slice(0, n)
      .map(i => (i === null || i === undefined ? null : dict[i] ?? null));
  }
  // 'pack' is dash's explicit ARCHIVE encoding for a frozen column — never the
  // default and never chosen on the author's behalf. Decoding it here would be
  // a second copy of a codec this app has no other reason to know, so the
  // column is reported as unreadable and the author is told which one.
  return null;
}

/** Expand dash's run-length row-id list into one id per row. */
function ridList(rids: unknown): number[] {
  if (!Array.isArray(rids)) return [];
  const out: number[] = [];
  for (const run of rids) {
    if (!Array.isArray(run) || run.length < 2) continue;
    const [start, count] = run as [number, number];
    if (!Number.isFinite(start) || !Number.isFinite(count) || count < 0) continue;
    for (let i = 0; i < count; i++) out.push(start + i);
  }
  return out;
}

/** "B7" → { col: 1, row: 6 }; anything else → null. */
function a1(ref: string): { col: number; row: number } | null {
  const m = /^([A-Z]+)(\d+)$/.exec(ref.trim().toUpperCase());
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: Number(m[2]) - 1 };
}

/**
 * A table sheet: columns are columns, and the header is the column NAME rather
 * than the first row of data.
 */
function readTableSheet(s: Record<string, unknown>): MergeSheet {
  const rids = ridList(s.rids);
  const n = rids.length;
  const cols = Array.isArray(s.columns) ? (s.columns as Array<Record<string, unknown>>) : [];
  const data = (s.data && typeof s.data === 'object') ? s.data as Record<string, unknown> : {};
  const overrides = (s.cells && typeof s.cells === 'object') ? s.cells as Record<string, { v?: unknown }> : {};

  const columns: string[] = [];
  const skipped: string[] = [];
  const rows: Array<Record<string, string>> = Array.from({ length: n }, () => ({}));

  for (const c of cols) {
    const id = typeof c.id === 'string' ? c.id : '';
    const name = safeFieldName(typeof c.name === 'string' ? c.name : id);
    if (!id || !name) { if (id) skipped.push(id); continue; }
    const vals = columnValues(data[id], n);
    if (!vals) { skipped.push(name); continue; }
    columns.push(name);
    const key = fieldKey(name);
    for (let i = 0; i < n; i++) {
      // A hand correction is what the author MEANT — an override beats the
      // imported column, exactly as it does in the grid. Skipping this would
      // mail out the number somebody had already fixed on screen.
      const ov = overrides[`${id}:${rids[i]}`];
      rows[i][key] = cellText(ov && 'v' in ov ? ov.v : vals[i]);
    }
  }
  return { id: String(s.id ?? ''), name: String(s.name ?? ''), columns, rows, skipped };
}

/**
 * A canvas sheet: the sparse A1 grid an invoice or a scratch pad is written on.
 *
 * ROW 1 IS THE HEADER. That is a convention rather than a fact in the file —
 * a canvas sheet has no column names — so it is stated here, stated in the
 * dialog, and a sheet whose first row is empty simply yields no columns rather
 * than inventing "A", "B", "C" and merging gibberish into somebody's letters.
 */
function readCanvasSheet(s: Record<string, unknown>): MergeSheet {
  const cells = (s.cells && typeof s.cells === 'object') ? s.cells as Record<string, { v?: unknown; f?: unknown }> : {};
  const grid = new Map<string, string>();
  let maxRow = 0;
  for (const [ref, cell] of Object.entries(cells)) {
    const p = a1(ref);
    if (!p) continue;
    grid.set(`${p.col}:${p.row}`, cellText(cell?.v));
    if (p.row > maxRow) maxRow = p.row;
  }
  const columns: string[] = [];
  const colAt: number[] = [];
  for (let c = 0; c < 512; c++) {
    const head = safeFieldName(grid.get(`${c}:0`) ?? '');
    if (head) { columns.push(head); colAt.push(c); }
  }
  const rows: Array<Record<string, string>> = [];
  for (let r = 1; r <= maxRow; r++) {
    const row: Record<string, string> = {};
    let any = false;
    columns.forEach((name, i) => {
      const v = grid.get(`${colAt[i]}:${r}`) ?? '';
      row[fieldKey(name)] = v;
      if (v) any = true;
    });
    // A wholly empty row is spacing, not a recipient. Merging it would produce
    // a letter addressed to nobody, and on a 200-row sheet nobody would notice
    // which one it was.
    if (any) rows.push(row);
  }
  return { id: String(s.id ?? ''), name: String(s.name ?? ''), columns, rows, skipped: [] };
}

/**
 * Pull the mergeable sheets out of a Bento file.
 *
 * Reads through `embed.ts readArtifact`, which extracts `#bento-doc` by pattern
 * — sound ONLY because the splice contract (PLATFORM §2) guarantees that block
 * is plaintext JSON at a known id in every Bento file ever written. Nothing of
 * the source document is kept beyond the rows: the parsed doc goes out of scope
 * at the end of this function, credentials and all.
 */
export function readMergeSource(html: string): MergeSource | null {
  const art = readArtifact(html);
  if (!art) return null;
  return sourceOfDoc(art.doc);
}

/**
 * The same read, from a document we ALREADY hold.
 *
 * `readMergeSource` starts from a file the user just picked; `live.ts` starts
 * from the copy an `embed` block is already carrying, which never goes back
 * through HTML. Splitting it here rather than re-deriving the sheet shape over
 * there keeps ONE decoder for dash's column encodings — the `pack` case below
 * is exactly the kind of thing that would get fixed in one copy and not the
 * other.
 */
export function sourceOfDoc(parsed: unknown): MergeSource | null {
  const doc = parsed as Record<string, unknown> | undefined;
  if (!doc || doc.format !== 'bento/dash' || !Array.isArray(doc.sheets)) return null;
  const sheets: MergeSheet[] = [];
  for (const raw of doc.sheets as Array<Record<string, unknown>>) {
    if (!raw || typeof raw !== 'object') continue;
    const s = raw.kind === 'canvas' ? readCanvasSheet(raw)
      : raw.kind === 'table' ? readTableSheet(raw)
      // A pivot sheet is a derived view; merging one is meaningful but its rows
      // live behind dash's own evaluation, so it is left out rather than read
      // half-right.
      : null;
    if (s && s.columns.length) sheets.push(s);
  }
  return { title: typeof doc.title === 'string' ? doc.title : '', sheets };
}

// ─────────────────────────────────────────────────────────── making a document

/**
 * The template, merged against one row.
 *
 * See this file's header for what is minted, what is stripped and why. The
 * clone is deep and taken from `docForExport`, so the credentials are gone
 * before anything else is decided about the output.
 */
export function mergeDoc(template: TypeDoc, row: Record<string, string>,
                         columns: string[], source: string): TypeDoc {
  const out = JSON.parse(JSON.stringify(docForExport(template))) as TypeDoc;
  out.docId = newDocId();
  out.signatures = [];
  out.revisions = [];
  delete out.comments;
  delete out.template;
  delete out.modified;
  out.merge = { source, columns: [...columns], row: { ...row } };
  // The TITLE is a plain string, not a block, so its `{{tokens}}` are resolved
  // by substitution rather than by an atom — there are no marks or anchors over
  // it to keep in step. This is what makes per-recipient file names possible.
  out.title = fillTokens(template.title ?? '', row);
  return out;
}

/**
 * Substitute `{{tokens}}` in a plain string (a title, a file-name pattern).
 *
 * `{{#}}` is the 1-based row number, which a file-name pattern needs and a
 * document body does not: two recipients may share a name and their files must
 * not share a path.
 */
export function fillTokens(s: string, row: Record<string, string>, n?: number): string {
  return s.replace(/\{\{\s*([^{}]{1,64}?)\s*\}\}/g, (_m, name: string) => {
    if (name === '#') return n === undefined ? '' : String(n);
    const v = row[fieldKey(name)];
    return v === undefined ? '' : v;
  });
}

/** A file name that a file system will actually accept. */
export function safeName(raw: string, fallback: string): string {
  const n = raw.replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 90);
  return (n || fallback) + '.bento.html';
}


// ────────────────────────────────────────────────────────────────── running it

interface DirHandle { getFileHandle(name: string, o: { create: boolean }): Promise<FsFile> }
interface FsFile { createWritable(): Promise<{ write(b: Blob): Promise<void>; close(): Promise<void> }> }

const canPickDirectory = (): boolean =>
  typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';

/** Let the browser paint. See this file's header: a merge is a long job. */
const yieldToUi = () => new Promise<void>(r => setTimeout(r, 0));

export interface MergeRun {
  template: TypeDoc;
  sheet: MergeSheet;
  source: string;
  pattern: string;
  dir: DirHandle | null;
  onProgress(done: number, total: number, name: string): void;
  stopped(): boolean;
}

/** Emit one file per row. Returns how many were written. */
export async function runMerge(run: MergeRun): Promise<number> {
  let done = 0;
  for (let i = 0; i < run.sheet.rows.length; i++) {
    if (run.stopped()) break;
    const row = run.sheet.rows[i];
    const doc = mergeDoc(run.template, row, run.sheet.columns, run.source);
    const name = safeName(fillTokens(run.pattern, row, i + 1), `merge-${i + 1}`);
    // serializeAuto, not serializeFile: it is the encryption-aware path, so a
    // password-protected template produces password-protected outputs rather
    // than two hundred plaintext copies of a document somebody encrypted.
    const html = await serializeAuto(doc);
    if (run.dir) {
      const fh = await run.dir.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(new Blob([html], { type: 'text/html' }));
      await w.close();
    } else {
      downloadFile(html, name);
    }
    done++;
    run.onProgress(done, run.sheet.rows.length, name);
    await yieldToUi();
  }
  return done;
}

// ─────────────────────────────────────────────────────────────────────── UI

async function pickFile(): Promise<File | null> {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.html,text/html';
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true });
    input.click();
  });
}

function overlay(): { back: HTMLElement; box: HTMLElement; close: () => void } {
  const back = document.createElement('div');
  back.className = 't-overlay';
  const box = document.createElement('div');
  box.className = 't-dlg t-merge';
  back.appendChild(box);
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  function close() { window.removeEventListener('keydown', onKey, true); back.remove(); }
  window.addEventListener('keydown', onKey, true);
  back.addEventListener('mousedown', e => { if (e.target === back) close(); });
  document.body.appendChild(back);
  return { back, box, close };
}

export async function openMerge(ctx: FeatureContext): Promise<void> {
  const file = await pickFile();
  if (!file) return;
  const src = readMergeSource(await file.text());
  if (!src || !src.sheets.length) {
    ctx.toast(t('That file has no sheet with named columns to merge from.'));
    return;
  }

  const { box, close } = overlay();
  let sheet = src.sheets[0];

  const render = () => {
    box.replaceChildren();
    const h = document.createElement('h3');
    h.textContent = t('Mail merge');
    box.appendChild(h);

    // --- which sheet
    if (src.sheets.length > 1) {
      const row = document.createElement('div');
      row.className = 't-row';
      const lab = document.createElement('span');
      lab.textContent = t('Sheet');
      const sel = document.createElement('select');
      src.sheets.forEach((s, i) => {
        const o = document.createElement('option');
        o.value = String(i);
        o.textContent = `${s.name || t('Untitled')} — ${s.rows.length}`;
        sel.appendChild(o);
      });
      sel.value = String(src.sheets.indexOf(sheet));
      sel.addEventListener('change', () => { sheet = src.sheets[Number(sel.value)]; render(); });
      row.append(lab, sel);
      box.appendChild(row);
    }

    const summary = document.createElement('p');
    summary.className = 't-merge-note';
    summary.textContent = t('{rows} row(s), {cols} column(s)')
      .replace('{rows}', String(sheet.rows.length))
      .replace('{cols}', String(sheet.columns.length));
    box.appendChild(summary);

    // --- the columns, and the collisions
    const cols = document.createElement('div');
    cols.className = 't-merge-cols';
    for (const c of sheet.columns) {
      const chip = document.createElement('code');
      chip.textContent = `{{${c}}}`;
      // A column named "date" TAKES OVER {{date}} for this document — say so
      // HERE, at bind time, where renaming the column is still cheap, rather
      // than leaving it to be noticed on the running head of page one.
      if (isBuiltin(c)) {
        chip.className = 't-merge-clash';
        chip.title = t('“{name}” is also a document property — this column takes over that field')
          .replace('{name}', c);
      }
      cols.appendChild(chip);
    }
    box.appendChild(cols);

    if (sheet.skipped.length) {
      const warn = document.createElement('p');
      warn.className = 't-merge-warn';
      warn.textContent = t('Could not read: {cols}').replace('{cols}', sheet.skipped.join(', '));
      box.appendChild(warn);
    }

    // --- file naming
    const nameRow = document.createElement('div');
    nameRow.className = 't-row';
    const nameLab = document.createElement('span');
    nameLab.textContent = t('File names');
    const pattern = document.createElement('input');
    pattern.type = 'text';
    pattern.className = 't-input t-merge-pattern';
    pattern.value = `${ctx.store.doc.title || 'Document'} {{#}}`;
    nameRow.append(nameLab, pattern);
    box.appendChild(nameRow);

    const hint = document.createElement('p');
    hint.className = 't-merge-note';
    hint.textContent = t('Use {{#}} for the row number, or a column name in braces.');
    box.appendChild(hint);

    // --- how it will be written
    const big = sheet.rows.length > MERGE_WARN;
    const note = document.createElement('p');
    note.className = big && !canPickDirectory() ? 't-merge-warn' : 't-merge-note';
    note.textContent = canPickDirectory()
      ? t('Each row becomes one complete file in a folder you choose.')
      : big
        ? t('This browser can only download files one at a time, which is not workable past {n} rows. Open this document in Chrome or Edge to merge it.')
            .replace('{n}', String(MERGE_WARN))
        : t('This browser will download each file separately — expect one prompt per row.');
    box.appendChild(note);

    const foot = document.createElement('div');
    foot.className = 't-dlg-foot';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 't-btn';
    cancel.textContent = t('Cancel');
    cancel.addEventListener('click', close);
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 't-btn t-btn-primary';
    go.textContent = t('Merge {n} document(s)').replace('{n}', String(sheet.rows.length));
    go.disabled = !sheet.rows.length || (big && !canPickDirectory());
    go.addEventListener('click', () => { void start(pattern.value); });
    foot.append(cancel, go);
    box.appendChild(foot);
  };

  async function start(pattern: string) {
    let dir: DirHandle | null = null;
    if (canPickDirectory()) {
      try {
        dir = await (globalThis as unknown as { showDirectoryPicker(o: unknown): Promise<DirHandle> })
          .showDirectoryPicker({ id: 'bento-merge', mode: 'readwrite' });
      } catch { return; }                       // the picker was dismissed
    }

    // Fields first: an author who typed {{Name}} and never opened the Insert
    // menu still gets a merge that works, and the conversion is one undoable
    // step in their history rather than a hidden rewrite at emit time.
    ctx.store.breakRun();
    ctx.store.commit(d => { bindTokens(d, spliceText); });
    ctx.editor.render();
    ctx.refresh();

    box.replaceChildren();
    const h = document.createElement('h3');
    h.textContent = t('Mail merge');
    const bar = document.createElement('div');
    bar.className = 't-merge-bar';
    const fill = document.createElement('div');
    bar.appendChild(fill);
    const line = document.createElement('p');
    line.className = 't-merge-note';
    const foot = document.createElement('div');
    foot.className = 't-dlg-foot';
    const stop = document.createElement('button');
    stop.type = 'button';
    stop.className = 't-btn';
    stop.textContent = t('Stop');
    let stopped = false;
    stop.addEventListener('click', () => { stopped = true; stop.disabled = true; });
    foot.appendChild(stop);
    box.append(h, bar, line, foot);

    const total = sheet.rows.length;
    let written = 0;
    try {
      written = await runMerge({
        template: ctx.store.doc,
        sheet,
        source: `${src!.title || file!.name}${sheet.name ? ` — ${sheet.name}` : ''}`,
        pattern,
        dir,
        stopped: () => stopped,
        onProgress: (done, all, name) => {
          fill.style.width = `${Math.round((done / Math.max(1, all)) * 100)}%`;
          line.textContent = `${done} / ${all} — ${name}`;
        },
      });
    } catch (err) {
      close();
      ctx.toast(t('Merge failed: {why}').replace('{why}', String((err as Error)?.message ?? err)));
      return;
    }
    close();
    ctx.toast(stopped
      ? t('Stopped after {n} of {all} document(s)')
          .replace('{n}', String(written)).replace('{all}', String(total))
      : t('Merged {n} document(s)').replace('{n}', String(written)));
  }

  render();
}

registerMenuItem({
  id: 'mail-merge',
  label: () => t('Mail merge from a sheet…'),
  order: 62,
  run: ctx => { void openMerge(ctx); },
});
