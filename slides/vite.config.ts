import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { readFileSync } from 'node:fs'

// Reveal's link-preview overlay and background-iframe builder, switched OFF at
// the source. No config option disables the overlay (a data-preview-link
// attribute binds it even with previewLinks:false) and it opens an UNSANDBOXED
// iframe on a click, so a document-controlled attribute must never reach it.
// Each edit must match exactly once or the build fails: a Reveal upgrade that
// moves the code is a loud error, never a silent return of the hole.
const REVEAL_EDITS: Array<[string, string]> = [
  ['update(){this.Reveal.getConfig().previewLinks', 'update(){return;this.Reveal.getConfig().previewLinks'],
  ['onSlidesClicked(e){', 'onSlidesClicked(e){return;'],
  ['previewIframe(e){this.close()', 'previewIframe(e){return;this.close()'],
  ['previewImage(e,t){', 'previewImage(e,t){return;'],
  ['previewVideo(e,t){', 'previewVideo(e,t){return;'],
  ['else if(a&&!0!==i.excludeIframes){', 'else if(!1){'],
]
const disarmReveal = {
  name: 'bento-disarm-reveal-preview',
  enforce: 'pre' as const,
  transform(code: string, id: string) {
    if (!/reveal\.js[\\/]dist[\\/]reveal\.esm\.js/.test(id)) return null
    for (const [from, to] of REVEAL_EDITS) {
      if (code.split(from).length !== 2) throw new Error('reveal.js changed: cannot disarm ' + from)
      code = code.replace(from, () => to)
    }
    return { code, map: null }
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
  plugins: [disarmReveal,...(process.env.SINGLEFILE ? [viteSingleFile()] : [])],
  // Dev-only: allow serving ../kernel (shared TS-source kernel) — without a
  // workspace root, vite's fs allow-list stops at the app dir. Build output
  // is unaffected (rollup has no such restriction).
  // dev: pre-bundling would skip the transform above
  optimizeDeps: { exclude: ['reveal.js'] },
  server: { fs: { allow: ['..'] } },
  build: {
    // Keep asset inlining aggressive; a Bento file must have zero external requests.
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 4096,
  },
})
