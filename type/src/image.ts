// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Pictures — choosing one, and getting it into the document.
//
// EMBEDDED BY DEFAULT. The file IS the document, so a picture that lives beside
// it is a picture that goes missing the first time somebody emails the file.
// The cost is size, and above IMAGE_EMBED_BUDGET the reader is asked rather
// than surprised: a browser file picker hands over BYTES, never a path, so
// "just reference it from disk" is not a thing this app can offer — the URL
// field is the honest escape hatch.
//
// The picture itself is verified before it enters the document. A src that is
// not plainly an image reference is refused (model.ts SAFE_IMG): a document is
// untrusted input, and this string goes straight into an <img>.

import { registerTool } from './features.ts';
import { ICONS } from './icons.ts';
import { IMAGE_EMBED_BUDGET, SAFE_IMG } from './model.ts';
import { t } from './i18n.ts';

/** Read a picked file as a data URI. Rejects anything that is not an image. */
export function readImage(file: File): Promise<{ src: string; alt: string }> {
  return new Promise((resolve, reject) => {
    if (!/^image\//.test(file.type)) { reject(new Error('not an image')); return; }
    const fr = new FileReader();
    fr.onerror = () => reject(fr.error ?? new Error('unreadable'));
    fr.onload = () => {
      const src = String(fr.result ?? '');
      if (!SAFE_IMG.test(src)) { reject(new Error('unsafe source')); return; }
      // the file name is a better alt than nothing, and the author can edit it
      resolve({ src, alt: file.name.replace(/\.[^.]+$/, '') });
    };
    fr.readAsDataURL(file);
  });
}

/** Human size, for the over-budget question. */
export const humanSize = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;

registerTool({
  id: 'image',
  icon: ICONS.image,
  title: () => t('Insert a picture'),
  label: () => t('Picture'),
  group: 'insert',
  order: 20,
  run(ctx) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return;
      if (file.size > IMAGE_EMBED_BUDGET) {
        const go = confirm(t(
          'This picture is {size}, and embedding it makes the document that much bigger. Insert it anyway?',
          { size: humanSize(file.size) }));
        if (!go) return;
      }
      try {
        const image = await readImage(file);
        ctx.editor.insertImage(image);
        ctx.refresh();
      } catch {
        ctx.toast(t('That file could not be read as a picture.'));
      }
    }, { once: true });
    input.click();
  },
});

// The table lives in the Insert menu beside the picture, rather than as its own
// button in the bar: both are things you place deliberately and rarely, and the
// menu is what stops the ninth insertable thing costing another 32px.
registerTool({
  id: 'table',
  icon: ICONS.table,
  title: () => t('Insert a table'),
  label: () => t('Table'),
  group: 'insert',
  order: 10,
  run(ctx) { ctx.editor.insertTable(); ctx.refresh(); },
});
