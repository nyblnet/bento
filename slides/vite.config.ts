import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

// base './' so builds open from file:// or any static host.
// SINGLEFILE=1 → everything (JS, CSS, assets) inlined into one HTML file:
// that file IS the Bento document format.
export default defineConfig({
  base: './',
  plugins: [...(process.env.SINGLEFILE ? [viteSingleFile()] : [])],
  build: {
    // Keep asset inlining aggressive; a Bento file must have zero external requests.
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 4096,
  },
})
