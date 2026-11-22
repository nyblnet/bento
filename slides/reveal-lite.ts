// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// reveal.js, minus the subsystems the present overlay can never reach.
//
// Every saved deck carries the whole shell, so Reveal's unreachable
// controllers are bytes in every file anyone shares. present.ts drives Reveal
// as a one-slide-at-a-time stage only: `deck.slide(i, 0)`, section
// transitions, layout/scale, progress, slide number, the optional corner
// controls and the overview. It ships no fragments (steps.ts), no
// auto-animate (the morph is ours), no `data-background-*`, no plugins, no
// hash/history, touch off, scroll view off, and has its own print and speaker
// view. Those controllers are swapped for inert stand-ins HERE, at build time,
// by importing Reveal from its ES-module source (`reveal.js/js/`, shipped in
// the npm package) instead of the pre-bundled dist file.
//
// This also retires what vite.config.ts used to disarm by string edits on the
// minified bundle (the 1.2.12 fix): the link-preview overlay and the
// background-iframe builder are not disarmed any more, they are ABSENT. And a
// stand-in cannot be re-enabled by a query string — Reveal merges
// `location.search` into its config (`?view=scroll`, `?print-pdf`,
// `?touch=true`), which used to reach the real controllers.
//
// LOUD ON UPGRADE, like the edits it replaces: the Reveal version is pinned
// below, every stubbed module must exist and be imported, and the one source
// edit must match exactly once — or the build fails.
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const REVEAL_VERSION = '5.2.1'

const noop = (...names: string[]) => names.map((n) => `${n}(){}`).join('')
const stub = (body: string) => `export default class{constructor(r){this.Reveal=r}${body}}`

/** controller file (under reveal.js/js/) → its inert stand-in. */
const STUBS: Record<string, string> = {
  // data-auto-animate: never emitted — morph is kernel anim.ts + present.ts
  'controllers/autoanimate.js': stub(noop('run', 'reset')),
  // scrollActivationWidth: 0 already kept this off; now it cannot come back
  'controllers/scrollview.js': stub(
    'isActive(){return false}' + noop('activate', 'deactivate', 'layout', 'toggle', 'next', 'prev', 'getSlideByIndices', 'scrollToSlide')),
  // ?print-pdf — Bento prints through its own @page path
  'controllers/printview.js': stub('isActive(){return false}' + noop('activate')),
  // touch: false — present.ts has its own state-aware swipe
  'controllers/touch.js': stub(noop('bind', 'unbind')),
  // Reveal's speaker window boots a second editor; screens.ts replaces it
  'controllers/notes.js': stub(
    'getSlideNotes(){return null}isSpeakerNotesWindow(){return false}' + noop('configure', 'render', 'update', 'updateVisibility', 'destroy')),
  // hash: false, history: false — nothing is written to the URL. What stays
  // is reading it: index parsing for the first slide() of a show and the
  // jump-to-slide box, and the hashchange listener.
  'controllers/location.js': stub(
    'getIndicesFromHash(s=window.location.hash,o={}){const b=s.replace(/^#\\/?/,"").split("/");if(!/^[0-9]*$/.test(b[0]))return null;' +
    'const k=o.oneBasedIndex?1:0;return{h:parseInt(b[0],10)-k||0,v:parseInt(b[1],10)-k||0}}' +
    'readURL(){const R=this.Reveal,c=R.getIndices(),n=this.getIndicesFromHash();n?(n.h!==c.h||n.v!==c.v)&&R.slide(n.h,n.v):R.slide(c.h||0,c.v||0)}' +
    'getHash(){return"/"}' +
    // a hash typed or navigated to mid-show still moves it, as Reveal's own listener did
    'bind(){this.h=this.h||(()=>this.readURL());window.addEventListener("hashchange",this.h)}' +
    'unbind(){window.removeEventListener("hashchange",this.h)}' + noop('writeURL')),
  // no data-background-*: a slide's background is painted by render.ts. The
  // overview still re-parents this element, so it stays a real (empty) node.
  'controllers/backgrounds.js': stub(
    'element=Object.assign(document.createElement("div"),{className:"backgrounds",hidden:true});' +
    noop('render', 'create', 'sync', 'update', 'updateParallax', 'destroy', 'bubbleSlideContrastClassToElement')),
  // .fragment: never emitted — reveal steps are steps.ts
  'controllers/fragments.js': stub(
    'sort(){return[]}sync(){return[]}update(){return{shown:[],hidden:[]}}goto(){return false}next(){return false}prev(){return false}' +
    'availableRoutes(){return{prev:false,next:false}}' + noop('configure', 'sortAll')),
  // plugins: [] — and no dependency loader
  'controllers/plugins.js': stub(
    'load(){return Promise.resolve()}hasPlugin(){return false}getRegisteredPlugins(){return{}}' + noop('destroy', 'registerPlugin', 'getPlugin')),
  // The link/image/video preview lightbox is gone: no config switches it off
  // (a data-preview-link attribute binds it even with previewLinks: false) and
  // it opens an UNSANDBOXED iframe on a click. What stays is the `?` help.
  'controllers/overlay.js': stub(
    'isOpen(){return!!this.dom}getState(){return{}}destroy(){this.close()}' +
    'close(){if(!this.dom)return false;this.dom.remove();this.dom=null;this.Reveal.dispatchEvent({type:"closeoverlay"});return true}' +
    'toggleHelp(o){(typeof o=="boolean"?o:!this.dom)?this.showHelp():this.close()}' +
    'showHelp(){const R=this.Reveal;if(!R.getConfig().help)return;this.close();' +
    'const d=this.dom=document.createElement("div");d.className="r-overlay r-overlay-help";' +
    'const k=R.keyboard,s=k.getShortcuts(),b=k.getBindings();let h="";' +
    'for(const i in s)h+=`<tr><td>${i}</td><td>${s[i]}</td></tr>`;' +
    'for(const i in b)if(b[i].key&&b[i].description)h+=`<tr><td>${b[i].key}</td><td>${b[i].description}</td></tr>`;' +
    'd.innerHTML=`<div class="r-overlay-viewport"><header class="r-overlay-header"><button class="r-overlay-button r-overlay-close">Esc <span class="icon"></span></button></header>' +
    '<div class="r-overlay-content"><div class="r-overlay-help-content"><p class="title">Keyboard Shortcuts</p><table><th>KEY</th><th>ACTION</th>${h}</table></div></div></div>`;' +
    'd.querySelector(".r-overlay-close").addEventListener("click",e=>{this.close();e.preventDefault()});' +
    'R.getRevealElement().appendChild(d);R.dispatchEvent({type:"showhelp"})}' +
    noop('update', 'setState', 'previewIframe', 'previewImage', 'previewVideo')),
  // autoSlide: 0 — the play/pause ring is never built
  // constructed only for ?autoSlide=N, which Reveal reads from the URL; the
  // ring is not drawn, but the show must still start and advance
  'components/playback.js': 'export default class{' + noop('on', 'off', 'setPlaying', 'destroy') + '}',
}
/** bare imports Reveal's source makes that the stage does not need. */
const BARE: Record<string, string> = {
  fitty: 'export default function(){}', // .r-fit-text
}

/** Source edits, each of which must match exactly once. */
const EDITS: Array<[file: string, from: string, to: string]> = [
  // the background-iframe builder (unreachable without backgrounds.js, and
  // still not shipped): a document-controlled attribute must never build one
  ['controllers/slidecontent.js', 'else if( backgroundIframe && options.excludeIframes !== true ) {', 'else if( false ) {'],
]

/**
 * reveal.css, minus the rules for what is stubbed above (and for Reveal
 * features the overlay never turns on). A SELECTOR is dropped when it matches
 * one of these; a rule goes when no selector is left, an @media when no rule
 * is. Every pattern must still hit something, or the build fails.
 */
const CSS_DROP: RegExp[] = [
  /\.fragment\b/, // fragments.js
  /\.r-(stretch|fit-text|stack|hstack|vstack)\b|\.stretch\b|\.items-|\.justify-/, // layout helpers: class names Bento never emits
  /data-transition~?=(linear|default|convex|concave)\b|\.reveal\.(linear|default|convex|concave)\b/, // model: none | fade | slide | zoom | morph
  /\.reveal(\.center)?\.(cube|page)\b/,
  /\.backgrounds\b|\.slide-background|has-parallax-background|has-(dark|light)-background|data-background-interactive/, // backgrounds.js
  /data-auto-animate/, // autoanimate.js
  /data-preview-|\.r-overlay-(preview|spinner|external|error|content-inner)\b|\.x-frame-error/, // the preview lightbox
  /\.playback\b/, // autoSlide
  /\.hljs/, /\.roll\b/, /\.zoomed\b/, // highlight / zoom plugins, 3D links
  /\.speaker-notes|\.show-notes/, // notes.js (aside.notes{display:none} stays)
  /\.reveal-scroll\b|\.loading-scroll-mode/, // scrollview.js
  /html\.reveal-print|\.print-pdf/, // printview.js
  /html\.reveal-full-page/, // embedded: true
  /\.reveal\.center\b/, // center: false
  /\.reveal\.rtl\b/, // rtl: false
]
/** whole at-rules that go: Reveal's paper stylesheet — styles.css hides the overlay in print */
const CSS_DROP_AT = /^@media print\b/

function splitTop(s: string, open: string, close: string, sep: string): string[] {
  const out: string[] = []
  let depth = 0, start = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === open) depth++
    else if (c === close) { depth--; if (sep === '' && depth === 0) { out.push(s.slice(start, i + 1)); start = i + 1 } }
    else if (sep && c === sep && depth === 0) { out.push(s.slice(start, i)); start = i + 1 }
  }
  if (sep) out.push(s.slice(start))
  else if (s.slice(start).trim()) throw new Error('reveal.css: unbalanced braces')
  return out
}

export function trimRevealCss(css: string, hits = new Set<RegExp>(), top = true): string {
  let out = ''
  for (const rule of splitTop(css.replace(/\/\*[\s\S]*?\*\//g, ''), '{', '}', '')) {
    const at = rule.indexOf('{')
    const head = rule.slice(0, at).trim()
    const body = rule.slice(at + 1, -1)
    if (head.startsWith('@')) {
      if (CSS_DROP_AT.test(head)) { hits.add(CSS_DROP_AT); continue }
      if (!head.startsWith('@media')) { out += rule; continue } // @keyframes: kept whole
      const inner = trimRevealCss(body, hits, false)
      if (inner) out += head + '{' + inner + '}'
      continue
    }
    const keep = splitTop(head, '(', ')', ',').filter((sel) => {
      const drop = CSS_DROP.find((re) => re.test(sel))
      if (drop) hits.add(drop)
      return !drop
    })
    if (keep.length) out += keep.join(',') + '{' + body + '}'
  }
  if (top) {
    const dead = [...CSS_DROP, CSS_DROP_AT].filter((re) => !hits.has(re))
    if (dead.length) throw new Error('reveal.js changed: reveal.css no longer has ' + dead.join(' , '))
  }
  return out
}

const V = '\0bento-reveal-lite:'

export function revealLite() {
  const require = createRequire(join(process.cwd(), 'package.json'))
  const pkgPath = require.resolve('reveal.js/package.json')
  const root = join(dirname(pkgPath), 'js')
  const version = JSON.parse(readFileSync(pkgPath, 'utf8')).version
  if (version !== REVEAL_VERSION) {
    throw new Error(`reveal.js ${version} is not the audited ${REVEAL_VERSION}: re-check reveal-lite.ts against its js/ sources, then bump REVEAL_VERSION`)
  }
  for (const f of [...Object.keys(STUBS), ...EDITS.map((e) => e[0]), 'index.js']) {
    if (!existsSync(join(root, f))) throw new Error('reveal.js changed: no js/' + f)
  }
  const norm = (p: string) => p.replace(/\\/g, '/')
  const rootN = norm(root) + '/'
  const cssFile = norm(join(dirname(pkgPath), 'dist/reveal.css'))
  if (!existsSync(cssFile)) throw new Error('reveal.js changed: no dist/reveal.css')
  const seen = new Set<string>()
  return {
    name: 'bento-reveal-lite',
    enforce: 'pre' as const,
    resolveId(source: string, importer?: string) {
      if (source === 'reveal.js') return join(root, 'index.js')
      if (!importer || !norm(importer).startsWith(rootN)) return null
      if (source in BARE) return V + source
      if (!source.startsWith('.')) return null
      const rel = norm(join(dirname(importer), source)).slice(rootN.length)
      if (rel in STUBS) { seen.add(rel); return V + rel }
      return null
    },
    load(id: string) {
      if (!id.startsWith(V)) return null
      const key = id.slice(V.length)
      return STUBS[key] ?? BARE[key]
    },
    transform(code: string, id: string) {
      const file = norm(id).split('?')[0]
      if (file === cssFile) return { code: trimRevealCss(code), map: null }
      if (!file.startsWith(rootN)) return null
      const rel = file.slice(rootN.length)
      let hit = false
      for (const [f, from, to] of EDITS) {
        if (f !== rel) continue
        if (code.split(from).length !== 2) throw new Error('reveal.js changed: cannot edit ' + from)
        code = code.replace(from, () => to)
        hit = true
      }
      return hit ? { code, map: null } : null
    },
    buildEnd() {
      const missed = Object.keys(STUBS).filter((k) => !seen.has(k))
      if (seen.size && missed.length) throw new Error('reveal.js changed: never imported ' + missed.join(', '))
    },
  }
}
