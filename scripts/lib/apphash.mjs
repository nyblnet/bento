// App payload fingerprint — the shell's deflated runtime blocks
// (`bento/deflate-b86`, or `deflate-b64` in shells before 1.2.0). Two files
// with the same hash embed the same runtime, whatever document they carry.
// Returns null for a file with no payload blocks: callers comparing hashes
// must treat null as "cannot tell", never as a match — null === null once
// let a gate pass that was checking nothing.
import { createHash } from 'node:crypto'

export const appHash = (html) => {
  const blocks = [...html.matchAll(/type="bento\/deflate-b(?:64|86)"[^>]*>([^<]+)</g)].map((m) => m[1])
  return blocks.length ? createHash('sha256').update(blocks.join('')).digest('hex') : null
}

// True only when both files carry a payload and it is the same one.
export const sameApp = (a, b) => a !== null && a === b
