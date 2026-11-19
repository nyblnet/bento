import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { readFileSync } from 'node:fs'
import { revealLite } from './reveal-lite'

// Moveable with only the "ables" the editor turns on. `moveable`'s default
// class registers ALL of them — warp, clip, round, scale, pinch, origin-drag,
// scroll, padding… — whether or not a prop ever enables one, so every saved
// deck carried ~16 KB of handles nothing could show. The editor passes
// draggable, resizable, rotatable and snappable (canvas.ts), selects groups and
// listens for click/clickGroup; KEEP_ABLES is that set plus the always-on
// internals. An able that is not registered cannot be enabled: add it here
// BEFORE passing its prop in canvas.ts.
// Build only — the dev server pre-bundles the published file (every able
// registered, the same ones enabled). The rewrite must match exactly once or
// the build fails: an upgrade that moves the code is a loud error, never a
// silent return of the bytes.
const KEEP_ABLES = ['BeforeRenderable', 'Default', 'Snappable', 'Draggable', 'Resizable', 'Rotatable', 'Groupable', 'Clickable', 'DragArea', 'Renderable']
const ABLES_LIST = /var MOVEABLE_ABLES =\s*\[[^\]]*\];/g
const trimMoveableAbles = {
  name: 'bento-trim-moveable-ables',
  enforce: 'pre' as const,
  apply: 'build' as const,
  transform(code: string, id: string) {
    if (!/croact-moveable[\\/]dist[\\/]moveable\.esm\.js/.test(id)) return null
    if ((code.match(ABLES_LIST) ?? []).length !== 1) throw new Error('moveable changed: cannot narrow MOVEABLE_ABLES')
    for (const able of KEEP_ABLES) if (!new RegExp(`^var ${able} = `, 'm').test(code)) throw new Error('moveable changed: no able ' + able)
    code = code.replace(ABLES_LIST, () => `var MOVEABLE_ABLES = /*#__PURE__*/ [${KEEP_ABLES.join(', ')}];`)
    // makeAble() only builds an object: say so, or the ables dropped above stay in
    code = code.replace(/^var (\w+) = makeAble\(/gm, 'var $1 = /*#__PURE__*/ makeAble(')
    return { code, map: null }
  },
}

// Identifier names are re-assigned by terser AFTER esbuild has minified the
// chunk. Nothing else changes: compress is off, so the syntax tree esbuild
// emitted is kept and only local names move. No property is renamed — a
// property mangle works by NAME across the whole bundle and one wrong name is
// a model key, so it stays off. terser gives the same short name to the same
// slot in every scope (first parameter `e`, second `t`, ...), so
// `function(e,t){` and friends repeat byte-for-byte and deflate finds them;
// esbuild's naming does not. Single-file builds only: that is what ships.
const remangle = {
  name: 'bento-remangle',
  enforce: 'post' as const,
  async generateBundle(_: unknown, bundle: Record<string, { type: string; code?: string }>) {
    const { minify } = await import('terser')
    for (const chunk of Object.values(bundle)) {
      if (chunk.type !== 'chunk' || !chunk.code) continue
      const out = await minify(chunk.code, { module: true, compress: false, mangle: true, format: { comments: false } })
      if (!out.code) throw new Error('remangle: terser returned nothing')
      chunk.code = out.code
    }
  },
}

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

// base './' so builds open from file:// or any static host.
// SINGLEFILE=1 → everything (JS, CSS, assets) inlined into one HTML file:
// that file IS the Bento document format.
export default defineConfig({
  base: './',
  // The app version baked into every shipped shell — what update checks
  // compare against the release manifest. Single source: package.json.
  // __BENTO_TEST_SEAL__: the sealed TEST document's key handoff (kernel save.ts
  // capturePristine). false, and so dead-code-eliminated, unless BENTO_TEST_SEAL=1
  // (npm run build:sealtest, which writes dist-sealtest/, never dist-single/).
  // shell-gate.mjs refuses any release shell that still carries it.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BENTO_TEST_SEAL__: JSON.stringify(process.env.BENTO_TEST_SEAL === '1'),
  },
  plugins: [trimMoveableAbles, revealLite(), ...(process.env.SINGLEFILE ? [remangle, viteSingleFile()] : [])],
  // Dev-only: allow serving ../kernel (shared TS-source kernel) — without a
  // workspace root, vite's fs allow-list stops at the app dir. Build output
  // is unaffected (rollup has no such restriction).
  // dev: pre-bundling would skip reveal-lite's module swaps
  optimizeDeps: { exclude: ['reveal.js'] },
  server: { fs: { allow: ['..'] } },
  build: {
    // Keep asset inlining aggressive; a Bento file must have zero external requests.
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 4096,
    // One inlined chunk: there is nothing to preload, so no polyfill for it.
    modulePreload: false,
  },
})
