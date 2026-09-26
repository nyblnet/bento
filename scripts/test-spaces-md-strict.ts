#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/spaces: which block types survive Markdown BYTE FOR BYTE.
//
//   node scripts/test-spaces.mjs md-strict
//
// (Bundled, not run directly: the app's imports are extensionless. See the
// runner.)
//
// THE STRICT BAR, per block type. One fixture per type in the registry →
// about.ts toMarkdown → markdown.ts parseNote, and a type QUALIFIES only when
// both of these hold:
//   · the blocks that come back are the blocks that went in, as JSON — ids
//     aside, and `parent` compared by POSITION, since ids are fresh on import;
//   · exporting what came back reproduces the first export's text exactly.
//
// test-spaces-roundtrip.ts is the LOOSE bar — words, on the whole starter —
// and says in its own header that type-for-type is not its business. This rig
// is that business. The two do not overlap: a callout that came back as a
// quote passes the loose rig (every word is there) and fails this one.
//
// A TYPE THAT DOES NOT QUALIFY IS PINNED, with the reason Markdown cannot yet
// carry it. The pin is two-sided on purpose: a pinned type that starts to
// qualify FAILS this rig too. So teaching the importer a new shape (toggles
// as <details>, props as front matter …) is a deliberate edit here — the pin
// comes out in the same PR that earns it — never a silent improvement that
// nobody records, and never a silent regression hidden among known losses.
//
// A block type with no fixture fails as well: a type added to blocks.ts has to
// be put on one side of this line or the other.
import { toMarkdown } from '../spaces/src/about.ts'
import { parseNote } from '../spaces/src/markdown.ts'
import { Store } from '../spaces/src/store.ts'
import { SPECS, CALLOUT_TONES } from '../spaces/src/blocks.ts'
import { DEFAULT_FIELDS, propBlock } from '../spaces/src/fields.ts'
import { type Block, type Page, type SpacesDoc, defaultTheme, writeTable, linkCard, linkCardHtml } from '../spaces/src/model.ts'

let checks = 0
let failures = 0
function ok(cond: boolean, msg: string, detail?: string) {
  checks++
  if (cond) { console.log(`  ok    ${msg}`); return }
  failures++
  console.log(`  FAIL  ${msg}`)
  if (detail) console.log(detail.split('\n').map((l) => `          ${l}`).join('\n'))
}

let n = 0
const id = () => `f-${++n}`
/** A block in the EDITOR's shape: model.newBlock always writes `html: ''`. */
const b = (type: string, html = '', extra: Record<string, unknown> = {}): Block =>
  ({ id: id(), type, html, ...extra }) as Block

const PAGE = 'fixture-page'
const TITLE = 'Fixture'

function doc(pages: Page[]): SpacesDoc {
  return { format: 'bento/spaces', version: 1, docId: 'fixture', title: TITLE, theme: defaultTheme(), pages } as SpacesDoc
}

interface Fixture { blocks: Block[]; extraPages?: Page[] }

// ONE PER TYPE. Each is what the editor would produce, with every field the
// type actually carries set — a fixture that leaves a field out cannot notice
// it being dropped.
const FIX: Record<string, () => Fixture> = {
  p: () => ({ blocks: [b('p', 'Plain <strong>bold</strong> <em>em</em> <code>code</code> text with a <a href="https://x.y/z">link</a>.')] }),
  h1: () => ({ blocks: [b('p', 'lead'), b('h1', 'A heading')] }),
  h2: () => ({ blocks: [b('h2', 'A heading')] }),
  h3: () => ({ blocks: [b('h3', 'A heading')] }),
  bullet: () => { const a = b('bullet', 'one'); return { blocks: [a, b('bullet', 'nested', { parent: a.id }), b('bullet', 'two')] } },
  number: () => ({ blocks: [b('number', 'first'), b('number', 'second')] }),
  todo: () => ({ blocks: [b('todo', 'open', { done: false }), b('todo', 'done', { done: true })] }),
  toggle: () => { const t = b('toggle', 'Fold me', { open: false }); return { blocks: [t, b('p', 'inside the fold', { parent: t.id })] } },
  // a callout with its own two lines AND a child: the child is what proves the
  // alert body is parsed as blocks, not flattened into the callout's text
  callout: () => { const c = b('callout', 'Mind the gap<br>and the step', { tone: 'warning' }); return { blocks: [c, b('p', 'body line', { parent: c.id })] } },
  quote: () => ({ blocks: [b('quote', 'Said once.<br>Said twice.')] }),
  code: () => ({ blocks: [b('code', 'const a = 1\nif (a &lt; 2) {}', { lang: 'ts' })] }),
  divider: () => ({ blocks: [b('p', 'above'), b('divider'), b('p', 'below')] }),
  // alt, src, caption — `![alt](src "title")` — and the size as a Pandoc
  // attribute list, `{width=80% w=640 h=300}`
  image: () => ({ blocks: [b('image', '', { src: 'asset:abc', alt: 'A diagram', caption: 'Drawn, not "photographed"', width: 80, w: 640, h: 300 })] }),
  media: () => ({ blocks: [b('media', '', { kind: 'audio', src: 'asset:tone', alt: 'A tone', controls: true })] }),
  link: () => ({ blocks: [b('link', '<a href="https://bento.page">Bento</a> — desc', { url: 'https://bento.page', title: 'Bento', desc: 'desc', site: 'bento.page', icon: '🍱', image: 'asset:thumb' })] }),
  pagelink: () => ({ blocks: [b('pagelink', '', { page: 'other' })], extraPages: [{ id: 'other', title: 'Other page', blocks: [b('p', 'x')] }] }),
  prop: () => ({ blocks: [propBlock(DEFAULT_FIELDS[0], 'doing', id())] }),
  table: () => {
    const t = b('table', '')
    writeTable(t, { rows: [['A', 'B'], ['1', '<strong>2</strong>']], cols: [1, 1], colAlign: ['', 'right'], header: true })
    return { blocks: [t] }
  },
  view: () => ({
    blocks: [b('view', 'Issues', { layout: 'board', groupBy: 'status' })],
    extraPages: [{ id: 'iss1', title: 'Fix it', parent: PAGE, blocks: [propBlock(DEFAULT_FIELDS[0], 'todo', id()), b('p', 'body')] }],
  }),
  canvas: () => { const c = b('canvas', 'Roadmap'); return { blocks: [c, b('p', 'card one', { parent: c.id, x: 40, y: 60 }), b('p', 'card two', { parent: c.id, x: 300, y: 120 })] } },
}

// THE PINS — the types Markdown cannot yet carry, each with why. The reason is
// the design brief's own row, so a reader of a failure knows what closing it
// would take. Removing a pin is the deliberate edit this rig asks for.
const PINNED: Record<string, string> = {
  media: 'exports as `[label](src)` and comes back a paragraph; needs `<video>`/`<audio>` html or a fence, and `controls`/`loop`/`muted` are lost',
  prop: 'exports as `**Status:** In progress` and comes back a paragraph; the natural form is front matter (`status: doing`), and value id vs label needs the schema',
  view: 'exports as a title and a grouped issue list and comes back as p+p+bullet; needs a `bento-view` fence (its rows are other pages)',
  pagelink: 'exports as `→ [[Title]]` and comes back a paragraph holding a wikilink',
  canvas: 'exports its name and cards as prose and comes back as paragraphs; card positions are lost (a `bento-canvas` fence or `{x= y=}` attributes)',
}

// ---- the measurement --------------------------------------------------------

/** ids out, `parent` as the parent's position — ids are minted fresh on import */
function strip(blocks: Block[]): unknown[] {
  const pos = new Map(blocks.map((x, i) => [x.id, i]))
  return blocks.map((x) => {
    const { id: _id, parent, ...rest } = x as Record<string, unknown> & { id: string; parent?: string }
    return parent === undefined ? rest : { ...rest, parent: `#${pos.get(parent) ?? parent}` }
  })
}
const canon = (v: unknown): string => JSON.stringify(v, (_k, x) =>
  x && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]]))
    : x)

/** The fixture page's own section of an export: its body, without the `# Fixture` title. */
function section(md: string, others: Page[]): string {
  let s = md.slice(md.indexOf(`# ${TITLE}\n`))
  for (const p of others) {
    const at = s.search(new RegExp(`\\n#+ ${p.title}\\n`))
    if (at >= 0) s = s.slice(0, at + 1)
  }
  return s.replace(new RegExp(`^# ${TITLE}\\n\\n?`), '')
}

interface Trip { md: string; md2: string; inJson: string; outJson: string; back: Block[] }

function trip(fx: Fixture): Trip {
  const extra = fx.extraPages ?? []
  const exportOf = (blocks: Block[]) =>
    section(toMarkdown(new Store(doc([{ id: PAGE, title: TITLE, blocks }, ...extra]) as never) as never), extra)
  const md = exportOf(fx.blocks)
  const back = parseNote(md, TITLE).blocks
  return { md, md2: exportOf(back), inJson: canon(strip(fx.blocks)), outJson: canon(strip(back)), back }
}

const qualifies = (t: Trip): boolean => t.inJson === t.outJson && t.md === t.md2
const why = (t: Trip): string => [
  'markdown:', ...t.md.trimEnd().split('\n').map((l) => `  | ${l}`),
  ...(t.inJson !== t.outJson ? [`json in : ${t.inJson}`, `json out: ${t.outJson}`] : []),
  ...(t.md !== t.md2 ? ['re-exported:', ...t.md2.trimEnd().split('\n').map((l) => `  | ${l}`)] : []),
].join('\n')

// ---- per type ---------------------------------------------------------------

console.log('\nevery registered block type, exported and read back')
const types = SPECS.map((s) => s.type)
let exact = 0
for (const type of types) {
  const fx = FIX[type]
  if (!fx) { ok(false, `${type}: has a fixture (a new block type must be put on one side of the pin line)`); continue }
  const t = trip(fx())
  const q = qualifies(t)
  if (q) exact++
  const pin = PINNED[type]
  if (pin) {
    ok(!q, `${type}: pinned as lossy — ${pin}`,
      q ? 'it now round-trips byte for byte. Remove its pin from PINNED: that is the deliberate edit this rig exists to force.' : undefined)
  } else {
    ok(q, `${type}: byte-identical (JSON minus ids, and the re-exported text)`, q ? undefined : why(t))
  }
}
for (const type of Object.keys(PINNED)) {
  ok(types.includes(type), `pin "${type}" names a registered block type`)
}
for (const type of Object.keys(FIX)) {
  ok(types.includes(type), `fixture "${type}" names a registered block type`)
}
const expected = types.length - Object.keys(PINNED).length
ok(exact === expected, `${exact} of ${types.length} block types are byte-identical (expected ${expected}; ${Object.keys(PINNED).length} pinned)`)

// ---- a space with none of the lossless-family shapes -------------------------
// Every family below (toggles, sized images, cards, media, page links, views,
// canvases, block ids) changes how ITS OWN block exports. A space that has none
// of them must export exactly as it did before any family existed — byte for
// byte, marks and all — so a README someone keeps in git does not churn
// because the exporter learned a shape the document never used. The expected
// text was captured from the exporter BEFORE the first family landed.

console.log('\na space without any family shape exports byte-identically to before')
{
  const t = b('table', '')
  writeTable(t, { rows: [['A', 'B'], ['1', '<strong>2</strong>']], cols: [1, 1], colAlign: ['', 'right'], header: true })
  const blocks = [
    { id: 'g1', type: 'p', html: 'Plain <strong>bold</strong> <em>em</em> <u>u</u> <s>s</s> <sub>2</sub> <sup>3</sup> <code>c</code> <mark>hi</mark> <a href="https://x.y/z">link</a> and a <a href="#p/pg2">page link</a>.' },
    { id: 'g2', type: 'h1', html: 'One' }, { id: 'g3', type: 'h2', html: 'Two' }, { id: 'g4', type: 'h3', html: 'Three' },
    { id: 'g5', type: 'bullet', html: 'a' }, { id: 'g6', type: 'bullet', html: 'b', parent: 'g5' },
    { id: 'g7', type: 'number', html: 'n' }, { id: 'g8', type: 'todo', html: 't', done: true },
    t,
    { id: 'g10', type: 'callout', html: 'Careful', tone: 'warning' }, { id: 'g11', type: 'p', html: 'inside', parent: 'g10' },
    { id: 'g12', type: 'quote', html: 'q<br>r' },
    { id: 'g13', type: 'code', html: 'x &lt; 1', lang: 'js' },
    { id: 'g14', type: 'divider', html: '' },
    { id: 'g15', type: 'image', html: '', src: 'asset:k', alt: 'alt', caption: 'cap' },
    { id: 'g16', type: 'p', html: '<span class="sp-fg-red">red</span> <mark class="sp-bg-blue">band</mark> Last {not an attribute} [bracket] ==text== line' },
  ] as Block[]
  const d = { ...doc([{ id: 'pg', title: 'Plain', blocks }, { id: 'pg2', title: 'Second', parent: 'pg', blocks: [b('p', 'child page')] }]), docId: 'g', title: 'G' }
  const got = toMarkdown(new Store(d as never) as never)
  const want = "# Plain\n\nPlain **bold** *em* <u>u</u> ~~s~~ <sub>2</sub> <sup>3</sup> `c` ==hi== [link](https://x.y/z) and a [page link](#p/pg2).\n\n# One\n\n## Two\n\n### Three\n\n- a\n\n  - b\n\n1. n\n\n- [x] t\n\n| A | B |\n| --- | ---: |\n| 1 | **2** |\n\n> [!WARNING]\n> Careful\n>\n> inside\n\n> q\n> r\n\n```js\nx < 1\n```\n\n---\n\n![alt](asset:k \"cap\")\n\n<span class=\"sp-fg-red\">red</span> <mark class=\"sp-bg-blue\">band</mark> Last {not an attribute} [bracket] ==text== line\n\n## Second\n\nchild page\n"
  ok(got === want, 'export of a plain space is byte-identical to the pre-family exporter',
    got === want ? undefined : `want:\n${want}\ngot:\n${got}`)
}

// ---- the shapes one fixture per type does not reach -------------------------

console.log('\ncallouts: every tone, and a body that is more than one paragraph')
for (const { tone } of CALLOUT_TONES) {
  const c = b('callout', `A ${tone}`, { tone })
  const t = trip({ blocks: [c, b('p', 'first child', { parent: c.id }), b('p', 'after the box')] })
  ok(qualifies(t), `tone "${tone}" ⇄ > [!${tone.toUpperCase()}]`, qualifies(t) ? undefined : why(t))
}
{
  const c = b('callout', '', { tone: 'note' })
  const li = b('bullet', 'a point', { parent: c.id })
  const t = trip({ blocks: [c, b('p', 'one', { parent: c.id }), li, b('bullet', 'under it', { parent: li.id }), b('p', 'outside')] })
  ok(qualifies(t), 'an EMPTY callout whose body is a paragraph and a nested list', qualifies(t) ? undefined : why(t))
}
{
  const outer = b('callout', 'Outer', { tone: 'important' })
  const inner = b('callout', 'Inner', { tone: 'caution', parent: outer.id })
  const t = trip({ blocks: [outer, inner, b('p', 'deep', { parent: inner.id })] })
  ok(qualifies(t), 'a callout nested in a callout (> > [!CAUTION])', qualifies(t) ? undefined : why(t))
}
{
  const t = trip({ blocks: [b('callout', 'first', { tone: 'tip' }), b('callout', 'second', { tone: 'tip' })] })
  ok(qualifies(t), 'two adjacent callouts stay two', qualifies(t) ? undefined : why(t))
}

console.log('\nquotes and images at their edges')
{
  const t = trip({ blocks: [b('quote', 'stanza one<br><br>stanza two'), b('quote', 'a second quote')] })
  ok(qualifies(t), 'a quote holding a blank line, then a separate quote', qualifies(t) ? undefined : why(t))
}
{
  const t = trip({ blocks: [b('image', '', { src: 'asset:x', caption: 'a back\\slash' })] })
  ok(qualifies(t), 'a caption with a backslash and no alt', qualifies(t) ? undefined : why(t))
}
{
  const t = trip({ blocks: [b('image', '', { src: 'asset:x', alt: 'no caption' })] })
  ok(qualifies(t) && !t.md.includes('"'), 'an image without a caption exports no title', qualifies(t) ? undefined : why(t))
}
console.log('\nimage sizes: {width=N% w= h=}')
{
  const t = trip({ blocks: [b('image', '', { src: 'asset:abc', width: 62.5 }), b('image', '', { src: 'asset:d', alt: 'only px', w: 12, h: 34 })] })
  ok(qualifies(t) && t.md.includes('{width=62.5%}') && t.md.includes('{w=12 h=34}'),
    'a fractional width alone, and pixels alone, each round-trip', qualifies(t) ? undefined : why(t))
}
{
  const t = trip({ blocks: [b('image', '', { src: 'asset:x', width: 'wide', w: 'x', h: 3 } as never)] })
  ok(!/\{/.test(t.md), 'a size field holding a non-number is not written', t.md)
}
{
  const got = only('- ![a](asset:k){width=40%}\n')
  ok(got[0]?.type === 'image' && got[0].width === 40, 'a sized image as a list item keeps its size', JSON.stringify(got))
}
{
  const got = only('![a](pic.png){width=30% w=100}\n![b](pic.png){width=5%}\n![c](pic.png){width=300px height=200}\n')
  ok(got.length === 3 && got[0].width === 30 && got[0].w === undefined && got[1].width === undefined && got[2].width === undefined && got[2].w === undefined,
    'Pandoc-flavoured sizes outside the model (one of w/h, under 10%, px widths) are ignored, the image kept', JSON.stringify(got))
}
{
  const hostile = [
    '![x](a.png){width="><script>alert(1)</script>"}',
    '![x](a.png){width=100% onerror=alert(1) style="background:url(//t.invalid)"}',
    '![x](a.png){width=javascript:alert(1)}',
    '![x](a.png){width=50% w=1e9 h=-1}',
    '![x](a.png){width=50%" onload="alert(1)}',
  ]
  for (const line of hostile) {
    const got = only(`${line}\n`)
    const all = JSON.stringify(got)
    const img = got.find((x) => x.type === 'image')
    const keys = img ? Object.keys(img).filter((k) => !['id', 'type', 'html', 'src', 'alt', 'width'].includes(k)) : []
    ok(!/onerror|onload|style|javascript/i.test(Object.keys(img ?? {}).join(' ')) && keys.length === 0 &&
      (img?.width === undefined || img.width === 100 || img.width === 50) && !/<script/i.test(img?.alt ?? ''),
    `HOSTILE size: ${line} — no key but a validated width reaches the block`, all)
  }
}

console.log('\nlink cards: [title](url) — desc <!-- bento:card … -->')
{
  const card = (f: Record<string, unknown>) => {
    const x = b('link', '', f)
    x.html = linkCardHtml(linkCard(x))
    return x
  }
  const t = trip({ blocks: [
    card({ url: 'https://x.y/a b(c)', title: 'Tricky [title] with \\ and -- dashes', desc: 'says "hi" --> <b>not a tag</b>', site: 'x--y "site" >' }),
    card({ title: 'No url here', desc: 'still a card' }),
    card({ url: 'https://only.url/' }),
    card({ url: 'mailto:a@b.c', title: 'Mail', image: 'data:image/png;base64,iVBORw0KGgo=' }),
  ] })
  ok(qualifies(t), 'brackets, backslashes, dashes, quotes and a --> in the fields; a card with no url; an untitled one; a small data: thumbnail',
    qualifies(t) ? undefined : why(t))
  ok(t.md.split('\n').filter((l) => l.includes('<!-- bento:card')).every((l) => {
    const c = l.slice(l.lastIndexOf('<!-- bento:card') + 4)
    return c.indexOf('--') === c.length - 3 && !/[<>]/.test(c.slice(0, -1))
  }), 'no field can close or nest the marker comment: its only `--` is the closing one', t.md)
}
{
  // THE PINNED LOSS: a large data: thumbnail is left out of the export
  const big = `data:image/png;base64,${'A'.repeat(4000)}`
  const x = b('link', '', { url: 'https://big.img/', title: 'Big', image: big })
  x.html = linkCardHtml(linkCard(x))
  const t = trip({ blocks: [x] })
  ok(!t.md.includes('AAAA') && t.back[0]?.type === 'link' && t.back[0].image === undefined,
    'pinned: a data: thumbnail over CARD_IMAGE_MD_BUDGET does not leave (the card does, without it)', t.md)
}
{
  const got = only('[Docs](https://example.com) — the manual\n\n[Just a link](https://example.com)\n')
  ok(got.length === 2 && got.every((x) => x.type === 'p'), 'an UNMARKED lone link stays a paragraph', JSON.stringify(got))
}
{
  const hostile: Array<[string, (x: Block[]) => boolean]> = [
    ['[Click](javascript:alert(1)) <!-- bento:card -->', (x) => x[0]?.type === 'link' && x[0].url === undefined && !/javascript/i.test(x[0].html ?? '')],
    ['[Click]( JAVASCRIPT:alert(1)) <!-- bento:card -->', (x) => x[0]?.url === undefined && x[0]?.title === 'Click' && !/javascript/i.test(JSON.stringify(x))],
    ['[x](https://ok.example) <!-- bento:card image="https://tracker.invalid/p.png" -->', (x) => x[0]?.type === 'link' && x[0].image === undefined],
    ['[x](https://ok.example) <!-- bento:card image="data:image/svg+xml;base64,PHN2Zz4=" -->', (x) => x[0]?.image === undefined],
    ['[x](https://ok.example) <!-- bento:card image="javascript:alert(1)" onload="alert(1)" -->', (x) => x[0]?.image === undefined && !('onload' in (x[0] ?? {}))],
    ['[x](https://ok.example) <!-- bento:card site="a" --> <script>alert(1)</script> <!-- bento:card -->', (x) => !/<script/i.test(JSON.stringify(x))],
    ['[x](https://ok.example) <!-- bento:card site="<img src=x onerror=alert(1)>" -->', (x) => !/<img/i.test(JSON.stringify(x))],
    ['[x](https://ok.example) <!-- bento:card site="&lt;img src=x onerror=alert(1)&gt;" -->', (x) => x[0]?.type === 'link' && x[0].site === '<img src=x onerror=alert(1)>' && !/<img/i.test(x[0].html ?? '')],
    ['[x](https://ok.example) <!-- bento:other site="evil" -->', (x) => x[0]?.type === 'p'],
  ]
  for (const [line, fine] of hostile) {
    const got = only(`${line}\n`)
    ok(fine(got), `HOSTILE card: ${line}`, JSON.stringify(got))
  }
}

console.log('\ntoggles: <details>, open or folded, holding anything')
{
  const t = trip({ blocks: [b('toggle', 'Open one', { open: true }), b('toggle', 'Shut one', { open: false })] })
  ok(qualifies(t) && t.md.includes('<details open>') && t.md.includes('<details>\n'),
    'an open and a folded toggle keep their state, and an empty one closes at once', qualifies(t) ? undefined : why(t))
}
{
  const outer = b('toggle', 'Outer &amp; more', { open: true })
  const inner = b('toggle', 'Inner <strong>bold</strong>', { open: false, parent: outer.id })
  const li = b('bullet', 'a point', { parent: inner.id })
  const t = trip({ blocks: [outer, inner, b('p', 'deep', { parent: inner.id }), li, b('bullet', 'under it', { parent: li.id }),
    b('p', 'back in outer', { parent: outer.id }), b('p', 'outside')] })
  ok(qualifies(t), 'a toggle in a toggle, holding a paragraph and a nested list, then prose after both', qualifies(t) ? undefined : why(t))
}
{
  const c = b('callout', 'Box', { tone: 'tip' })
  const tg = b('toggle', 'Fold in a box', { open: true, parent: c.id })
  const t = trip({ blocks: [c, tg, b('p', 'folded words', { parent: tg.id }), b('p', 'still in the box', { parent: c.id }), b('p', 'out')] })
  ok(qualifies(t), 'a toggle inside a callout closes inside the blockquote', qualifies(t) ? undefined : why(t))
}
{
  const tg = b('toggle', 'Holds a box', { open: false })
  const c = b('callout', 'Boxed', { tone: 'note', parent: tg.id })
  const t = trip({ blocks: [tg, c, b('p', 'box body', { parent: c.id }), b('p', 'after')] })
  ok(qualifies(t), 'a callout inside a toggle', qualifies(t) ? undefined : why(t))
}
{
  const tg = b('toggle', 'Code inside', { open: true })
  const t = trip({ blocks: [tg, b('code', 'x = 1\n\ny = 2', { lang: 'py', parent: tg.id })] })
  ok(qualifies(t), 'a code block with a blank line inside a toggle', qualifies(t) ? undefined : why(t))
}

console.log('\ntoggles written elsewhere, and hostile ones')
{
  // the shape GitHub's own docs show, summary indented on its own line
  const got = only('<details>\n  <summary>Click to expand</summary>\n\n  ### Heading\n  1. Foo\n  2. Bar\n\n</details>\n\nAfter.\n')
  ok(got.map((x) => `${x.type}${x.parent === got[0].id ? '^' : ''}`).join(' ') === 'toggle h3^ number^ number^ p' &&
    got[0].html === 'Click to expand' && got[0].open === false,
  'GitHub: a folded <details> with an indented summary holds its heading and list', JSON.stringify(got))
}
{
  const got = only('<details><summary><b>Why?</b></summary>Because.</details>\n\nNext.\n')
  ok(got.map((x) => `${x.type}${x.parent === got[0]?.id ? '^' : ''}`).join(' ') === 'toggle p^ p' &&
    got[0].html === '<b>Why?</b>' && got[1].html === 'Because.',
  'a one-line <details><summary>…</summary>body</details>', JSON.stringify(got))
}
{
  const got = only('<details open>\n<summary>Unclosed</summary>\n\nbody\n')
  ok(got.length === 2 && got[0].type === 'toggle' && got[0].open === true && got[1].parent === got[0].id,
    'a <details> never closed holds the rest of the note', JSON.stringify(got))
}
{
  const got = only('</details>\n\ntext\n')
  ok(got.length === 1 && got[0].type === 'p' && got[0].html === 'text', 'a stray </details> is dropped', JSON.stringify(got))
}
{
  const got = only('<details onclick="alert(1)" ontoggle=alert(2) title="open"><summary onmouseover="alert(3)">Hi <img src=x onerror=alert(4)></summary>\n\nbody\n\n</details>\n')
  const all = JSON.stringify(got)
  ok(got[0]?.type === 'toggle' && got[0].open === false && !/alert|onclick|ontoggle|onmouseover|onerror|<img/i.test(all),
    'HOSTILE: <details onclick ontoggle> and <summary onmouseover> carry no attribute or tag into the block, and `title="open"` is not the open flag', all)
}

// ---- Markdown this app did not write ----------------------------------------
// An importer that only reads its own exporter's spelling is a round trip, not
// an importer. These are alerts as GitHub documents them and as Obsidian writes
// callouts.

console.log('\nalerts written elsewhere')
function only(md: string) { return parseNote(md, 'Note').blocks }
{
  const got = only('> [!WARNING]\n> Critical content demanding immediate user attention due to potential risks.\n')
  ok(got.length === 1 && got[0].type === 'callout' && got[0].tone === 'warning' &&
    got[0].html === 'Critical content demanding immediate user attention due to potential risks.',
  'GitHub: `> [!WARNING]` then `> text` is a warning callout holding that text', JSON.stringify(got))
}
{
  const got = only('> [!NOTE]\n> Useful information.\n>\n> - one\n> - two\n\nAfter.\n')
  ok(got.map((x) => `${x.type}${x.parent === got[0].id ? '^' : ''}`).join(' ') === 'callout bullet^ bullet^ p',
    'GitHub: a multi-paragraph alert keeps its list inside the box, and the next line outside', JSON.stringify(got))
  ok(got[0].html === 'Useful information.', 'GitHub: the alert\'s first paragraph is the callout\'s own text', JSON.stringify(got[0]))
}
{
  const got = only('- item\n  > [!IMPORTANT]\n  > inside a list\n- next\n')
  ok(got.map((x) => x.type).join(' ') === 'bullet callout bullet' && got[1].parent === got[0].id &&
    got[1].html === 'inside a list' && got[2].parent === undefined,
  'an alert indented under a list item belongs to that item, and the list resumes after it', JSON.stringify(got))
}
{
  // a lazy line after the tag is NOT the callout's text: the box has ended
  const got = only('> [!NOTE]\nnot in the box\n')
  ok(got.length === 2 && got[0].type === 'callout' && got[0].html === '' && got[1].type === 'p' && !got[1].parent,
    'a line after the alert without `>` is not pulled into it', JSON.stringify(got))
}
{
  const got = only('> [!tip] Remember this\n> and this too\n')
  ok(got.length === 1 && got[0].type === 'callout' && got[0].tone === 'tip' && got[0].html === 'Remember this<br>and this too',
    'Obsidian: lower-case `[!tip] Title` on the tag line keeps the title as text', JSON.stringify(got))
}
{
  const got = only('> [!caution]- Folded\n> body\n')
  ok(got[0]?.type === 'callout' && got[0].tone === 'caution', 'Obsidian: a fold marker `[!caution]-` is still a caution callout', JSON.stringify(got))
}
{
  const got = only('> [!info] Not one of the five\n')
  ok(got.length === 1 && got[0].type === 'quote', 'an alert type outside the five stays a quote, word for word', JSON.stringify(got))
}
{
  const got = only('> Just a quote\n> [!NOTE] mid-quote is text\n')
  ok(got.length === 1 && got[0].type === 'quote', 'an alert tag that does not OPEN the blockquote is quote text', JSON.stringify(got))
}

console.log(`\n${checks - failures}/${checks} checks passed · ${exact} of ${types.length} block types byte-identical`)
if (failures) process.exit(1)
