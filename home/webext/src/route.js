// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Placing an absolute path inside a granted folder.
//
// Extracted from background.js so the SERVICE WORKER and the PAGES can both do
// it. The worker places a document that is saving; the home page places paths
// found in history to learn where folders live. Both must agree, and both must
// verify rather than guess — a wrong answer here writes to, or opens, the wrong
// file. Importing background.js into a page instead would have registered a
// second `onMessage` listener in that page, which is its own bug.

/**
 * The file this message is about, according to the BROWSER.
 *
 * Not according to the page: a content script's `sender.url` is stamped by
 * Chrome. Only `file:` is accepted — the bridge exists for local documents, and
 * an http page has no business claiming one.
 */
export function pathFromSender(sender) {
  try {
    const u = new URL(sender?.url ?? '')
    if (u.protocol !== 'file:') return null
    return decodeURIComponent(u.pathname)
  } catch {
    return null
  }
}

/**
 * Find a path inside one grant WITHOUT searching for it.
 *
 * THE INSIGHT. A `FileSystemDirectoryHandle` knows its own name but not its
 * path, so a grant and an absolute path cannot be compared directly — which is
 * why this used to walk the tree looking for a matching filename. But a
 * directory's NAME must appear in the path of every file inside it. So the name
 * locates the split point, and everything after it is the route: one
 * `getDirectoryHandle` per segment, then `getFileHandle`.
 *
 * O(path depth), with no scanning at all. Three things follow:
 *
 *   · a grant can be ANY size — a home directory costs the same as a decks
 *     folder, because nothing is enumerated
 *   · several grants are cheap to try, since each attempt is a few lookups
 *   · two documents sharing a filename stop being ambiguous. The old walk found
 *     both and declined; the route reaches exactly one, because only one path
 *     leads to it.
 *
 * It is checked, not guessed. A wrong split point fails at the first missing
 * segment, and callers re-verify the file it lands on regardless.
 *
 * A folder name can repeat in a path (`/Users/andy/Decks/Decks/Q3.bento.html`),
 * so every split point is tried; the caller decides what more than one hit
 * means.
 */
export async function locateIn(dir, path) {
  const name = dir.name
  const hits = []
  for (let i = path.indexOf(`/${name}/`); i !== -1; i = path.indexOf(`/${name}/`, i + 1)) {
    const rel = path.slice(i + name.length + 2).split('/').filter(Boolean)
    if (!rel.length) continue
    try {
      let cur = dir
      for (const seg of rel.slice(0, -1)) cur = await cur.getDirectoryHandle(seg)
      const file = await cur.getFileHandle(rel[rel.length - 1])
      hits.push({ file, rel })
    } catch {
      // Not this split point — a segment that does not exist is an answer, not
      // an error. Keep trying the others.
    }
  }
  return hits
}

/**
 * Where a granted folder lives, given an absolute path to something inside it.
 *
 * Returns null unless the path can be PROVEN to be in this grant: the route has
 * to resolve, and `dir.resolve()` on what it lands on has to agree with the
 * path's own tail. That second check is the one that matters — a file merely
 * sharing a name is not the same file, and treating it as one has destroyed a
 * document before (see background.js `resolve`).
 */
export async function prefixFor(dir, path) {
  for (const { file } of await locateIn(dir, path)) {
    const rel = await dir.resolve(file)
    if (!rel || !rel.length) continue
    const suffix = `/${rel.join('/')}`
    if (path.endsWith(suffix)) return path.slice(0, -suffix.length)
  }
  return null
}
