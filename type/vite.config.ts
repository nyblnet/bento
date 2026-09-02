import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

// base './' so builds open from file:// or any static host.
// SINGLEFILE=1 → everything (JS, CSS, assets) inlined into one HTML file:
// that file IS the Bento document format.
export default defineConfig({
  base: './',
  // The app version baked into every shipped shell — what update checks
  // compare against the release manifest. Single source: package.json.
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [...(process.env.SINGLEFILE ? [viteSingleFile()] : [])],
  // Dev-only: allow serving ../kernel (shared TS-source kernel) — without a
  // workspace root, vite's fs allow-list stops at the app dir. Build output
  // is unaffected (rollup has no such restriction).
  server: { fs: { allow: ['..'] } },
  build: {
    // Keep asset inlining aggressive; a Bento file must have zero external requests.
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 4096,
  },
})
