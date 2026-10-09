#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/type fields and mail merge.  node scripts/test-type-fields.ts
//
// THE FIXTURES ARE BUILT BY THE APPS THAT WILL ACTUALLY FEED THIS.
//
// That sentence is the whole reason this file is shaped the way it is, and it
// is a lesson this zone has already paid for: `scripts/test-type-embed.ts`
// passed for weeks on a preview fixture (a bare `<svg>` in the host) that NO
// app ever writes, and it went on passing while the boundary it certified was
// broken. So the spreadsheet here is not a hand-typed object literal in the
// shape a dash file might have — it is produced by `dash/src/import.ts`
// `importDelimited` and `dash/src/starter.ts` `starterDoc`, the code paths a
// real workbook comes out of, and it is wrapped in a `#bento-doc` block with
// the SAME `<`-escape kernel/src/save.ts applies (PLATFORM §2). If dash changes
// how it encodes a column, this rig goes red instead of certifying a merge that
// silently reads nothing.
//
// What is checked:
//
//   1. a token resolves — `{{Name}}` typed in prose becomes a field, and the
//      field renders the row's value on paper;
//   2. an unmatched field is EMPTY on paper, and is neither the literal token
//      nor "undefined" — the two failure modes that would print;
//   3. converting tokens moves marks, footnotes and citations by the same rule
//      an edit does, because a field occupies no characters;
//   4. every merged output gets a FRESH docId — 200 letters sharing the
//      template's identity is 200 files autosave believes are one document;
//   5. no emitted file carries the source's collaboration block, checked
//      against the SERIALIZED bytes rather than against the object;
//   6. the sheet reader gets real rows, real dictionary-encoded columns and
//      honours a hand correction.

import { register } from 'node:module'
register('./lib/ts-resolve-hooks.mjs', import.meta.url)

const {
  BUILTINS, fieldContext, fieldsOf, fillFieldsHtml, isBuiltin, resolveField,
  safeFieldName, shiftFields, tokensToFields, withField, TOKEN,
} = await import('../type/src/fields.ts')
const { blockHtml } = await import('../type/src/render.ts')
const { emptyDoc, parseDoc, spliceText } = await import('../type/src/model.ts')
const { cellText, fillTokens, mergeDoc, readMergeSource, safeName } = await import('../type/src/merge.ts')
const { importDelimited } = await import('../dash/src/import.ts')
const { starterDoc } = await import('../dash/src/starter.ts')

type Block = import('../type/src/model.ts').Block
type TypeDoc = import('../type/src/model.ts').TypeDoc

let checks = 0, bad = 0
const ok = (cond: boolean, msg: string) => {
  checks++
  if (cond) console.log(`  ok    ${msg}`)
  else { bad++; console.log(`  FAIL  ${msg}`) }
}
const H = (s: string) => console.log(`\n=== ${s} ===`)

// ── the spreadsheet, built by dash ──────────────────────────────────────────
//
// A dictionary-encoded column is what dash writes for repeated text (its
// default encoding, model.ts "dict is the default and the reason the format
// fits"), so "Plan" being read correctly is a real check and not a formality.

const CSV = [
  'Name,Company,Plan,Owed',
  'Ada Lovelace,Analytical Engines,Gold,1200',
  'Grace Hopper,Naval Systems,Gold,340',
  'Alan Turing,Bletchley,Silver,0',
].join('\n')

const imported = importDelimited(CSV, { name: 'Recipients', sheetId: 'sheet-r' })
const sheetRaw = imported.sheet as Record<string, unknown>

// A HAND CORRECTION, made through dash's own overlay shape: `cells` keyed
// `<colId>:<rid>`. A merge that ignored it would mail out the number somebody
// had already fixed on screen.
const owedId = (sheetRaw.columns as Array<{ id: string; name: string }>)
  .find(c => c.name === 'Owed')!.id
const firstRid = (sheetRaw.rids as Array<[number, number]>)[0][0]
sheetRaw.cells = { [`${owedId}:${firstRid}`]: { v: 999, by: 'someone', why: 'agreed discount' } }

const workbook = { ...starterDoc(), title: 'Debtors', sheets: [sheetRaw] }

/** A Bento file, spliced the way kernel/src/save.ts splices one (PLATFORM §2). */
const bentoFile = (doc: unknown): string =>
  '<!DOCTYPE html>\n<html><head>'
  + '<script type="application/bento+json" id="bento-doc">\n'
  + JSON.stringify(doc).replace(/</g, '\\u003c')
  + '\n</script></head><body></body></html>'

H('the sheet reader gets what dash actually wrote')
const src = readMergeSource(bentoFile(workbook))
{
  ok(src !== null, 'a bento/dash file is recognised')
  const sheet = src!.sheets.find(s => s.name === 'Recipients')
  ok(!!sheet, 'the imported sheet is offered for merging')
  ok(sheet!.columns.join(',') === 'Name,Company,Plan,Owed', `columns: ${sheet!.columns.join(',')}`)
  ok(sheet!.rows.length === 3, `three rows read (${sheet!.rows.length})`)
  ok(sheet!.rows[1].name === 'Grace Hopper', 'a raw text column reads back')
  ok(sheet!.rows[2].plan === 'Silver', 'a DICTIONARY-encoded column reads back (dash\'s default encoding)')
  ok(sheet!.rows[0].owed === '999', 'a hand correction in `cells` beats the imported value')
  ok(sheet!.rows[2].owed === '0', 'a zero is a value, not a blank')
  ok(readMergeSource(bentoFile({ ...emptyDoc(), title: 'A letter' })) === null,
     'a bento/type file offers no sheets — merging a document into itself is not a thing')
  ok(readMergeSource('<html><body>hello</body></html>') === null, 'a non-Bento file is refused')
}

const sheet = src!.sheets.find(s => s.name === 'Recipients')!

// ── the template ────────────────────────────────────────────────────────────

H('a typed {{token}} becomes a field, and the text loses the characters')
{
  const b: Block = { id: 'p1', kind: 'para', text: 'Dear {{Name}}, of {{Company}}.' }
  const out = tokensToFields(b, spliceText)!
  ok(out.text === 'Dear , of .', `the token characters are gone: ${JSON.stringify(out.text)}`)
  ok(fieldsOf(out).length === 2, 'two fields')
  ok(fieldsOf(out)[0].name === 'Name' && fieldsOf(out)[0].at === 5, 'the first sits where its token began')
  ok(fieldsOf(out)[1].name === 'Company' && fieldsOf(out)[1].at === 10, 'and so does the second')
  ok(tokensToFields(out, spliceText) === null, 'a second pass finds nothing to do')
}

H('a field owns no characters, so the offsets around it do not move under it')
{
  // marks, a footnote and a citation over the SAME string — the four things
  // that are offsets into `text` in this app.
  // Offsets computed from the text rather than typed in, so the fixture cannot
  // quietly stop describing what it claims to.
  const text = 'Dear {{Name}}, the fee is due.'
  const feeAt = text.indexOf('fee')
  const b: Block = {
    id: 'p2', kind: 'para', text,
    marks: [{ t: 'b', from: feeAt, to: feeAt + 3 }],
    notes: [{ id: 'n1', at: text.length }],
    cites: [{ at: text.length, keys: ['smith2020'] }],
  }
  const out = tokensToFields(b, spliceText)!
  ok(out.text.slice(out.marks![0].from, out.marks![0].to) === 'fee',
     `the bold mark still covers "fee" (${JSON.stringify(out.text.slice(out.marks![0].from, out.marks![0].to))})`)
  ok(out.notes![0].at === out.text.length, 'the footnote anchor followed the shortened text')
  ok(out.cites![0].at === out.text.length, 'and so did the citation')
}

H('a field survives the model round-trip')
{
  const doc = emptyDoc()
  doc.body = [withField({ id: 'p3', kind: 'para', text: 'Dear .' }, 5, 'Name')]
  const round = parseDoc(JSON.stringify(doc))
  ok(round.ok, 'the document parses')
  ok(round.ok && fieldsOf(round.doc.body[0])[0]?.name === 'Name', 'the field is still there')

  const clamped = parseDoc(JSON.stringify({
    ...doc,
    body: [{ id: 'p3', kind: 'para', text: 'Hi', fields: [{ name: 'Name', at: 900 }, { name: '', at: 0 }] }],
  }))
  ok(clamped.ok && fieldsOf(clamped.doc.body[0]).length === 1, 'a nameless field is dropped')
  ok(clamped.ok && fieldsOf(clamped.doc.body[0])[0].at === 2, 'and an out-of-range offset is clamped to the text')
}

H('shiftFields moves anchors the way every other anchor in this app moves')
{
  const f = [{ at: 0, name: 'A' }, { at: 5, name: 'B' }, { at: 10, name: 'C' }]
  ok(JSON.stringify(shiftFields(f, 2, 0, 3).map(x => x.at)) === '[0,8,13]', 'an insertion pushes what is after it')
  ok(JSON.stringify(shiftFields(f, 3, 4, 0).map(x => x.at)) === '[0,6]',
     'a deletion drops the anchor whose words are gone and moves the rest')
  ok(JSON.stringify(shiftFields(f, 20, 0, 5).map(x => x.at)) === '[0,5,10]', 'an edit after them all changes nothing')
}

// ── resolution ──────────────────────────────────────────────────────────────

H('a token resolves — the row\'s value reaches the paper')
{
  const template = emptyDoc()
  template.title = 'Statement'
  template.body = [tokensToFields(
    { id: 'p4', kind: 'para', text: 'Dear {{Name}} of {{Company}} — you owe {{Owed}}.' },
    spliceText)!]

  const merged = mergeDoc(template, sheet.rows[0], sheet.columns, 'Debtors — Recipients')
  const paper = fillFieldsHtml(blockHtml(merged.body[0]), fieldContext(merged))
  ok(paper.includes('Ada Lovelace'), `the name is on the page: ${paper}`)
  ok(paper.includes('Analytical Engines'), 'and the company')
  ok(paper.includes('999'), 'and the corrected figure')
  ok(!paper.includes('{{'), 'and no token survives to be read by a recipient')
}

H('an unmatched field prints as NOTHING — not the token, not "undefined"')
{
  const b = tokensToFields({ id: 'p5', kind: 'para', text: 'Dear {{Nickname}}, hello.' }, spliceText)!
  const doc = emptyDoc()
  const paper = fillFieldsHtml(blockHtml(b), fieldContext(doc))
  ok(!paper.includes('Nickname'), `the field NAME is not printed: ${paper}`)
  ok(!paper.includes('{{'), 'the token is not printed either')
  ok(!/undefined|null|NaN/.test(paper), 'and neither is a JavaScript accident')
  ok(paper === 'Dear , hello.', `it is simply absent: ${JSON.stringify(paper)}`)

  // The editor is the ONE surface that shows it, because the editor is the only
  // place anyone can still fix it. blockHtml emits the unbound chip; the DOM
  // filler (fillFields) only ever changes text and a class, never structure.
  ok(blockHtml(b).includes('t-field-unbound'), 'while the editor marks it unbound')
  ok(blockHtml(b).includes('>Nickname<'), 'and names it, so an author can see the hole')
}

H('a document answers for its own properties, and a bound row overrides them')
{
  const doc = emptyDoc()
  doc.title = 'Q3 Terms'
  doc.meta = { author: 'A. Author', company: 'Acme' }
  const ctx = fieldContext(doc)
  ok(resolveField({ at: 0, name: 'title' }, ctx) === 'Q3 Terms', '{{title}}')
  ok(resolveField({ at: 0, name: 'Author' }, ctx) === 'A. Author', '{{Author}} — case does not matter')
  ok(resolveField({ at: 0, name: ' company ' }, ctx) === 'Acme', 'nor does edge whitespace')
  ok(resolveField({ at: 0, name: 'page' }, ctx) === null,
     '{{page}} is unbound before anything has been paginated, rather than a confident "1"')

  // A BOUND ROW WINS over a document property of the same name — see fields.ts
  // for why that is the safer of the two failures. "Company" is the case that
  // made the rule: it is both a document property and one of the commonest
  // headings in a mail-merge sheet, and reserving it printed nothing at all.
  const shadow = fieldContext(doc, { row: { company: 'Analytical Engines' } })
  ok(resolveField({ at: 0, name: 'Company' }, shadow) === 'Analytical Engines',
     'a merge column takes over the document property of the same name')
  ok(resolveField({ at: 0, name: 'author' }, shadow) === 'A. Author',
     'while a property the row says nothing about still answers for itself')
  ok(BUILTINS.every(b => isBuiltin(b)) && isBuiltin('DATE') && !isBuiltin('Nickname'),
     'isBuiltin names exactly the set the dialog flags as shadowed')
}

H('a value from a spreadsheet is escaped, not interpreted')
{
  const b = tokensToFields({ id: 'p6', kind: 'para', text: '{{Name}}' }, spliceText)!
  const doc = emptyDoc()
  const evil = fillFieldsHtml(blockHtml(b),
    fieldContext(doc, { row: { name: '<img src=x onerror=alert(1)>' } }))
  ok(!evil.includes('<img'), `a cell cannot inject markup: ${evil}`)
  ok(evil.includes('&lt;img'), 'it is shown as the text it is')

  ok(safeFieldName('Full Name') === 'Full Name', 'a column name with a space is usable')
  ok(safeFieldName('Invoice-No') === 'Invoice-No', 'so is one with a hyphen')
  ok(safeFieldName('a<b') === null && safeFieldName('a"b') === null && safeFieldName('{x}') === null,
     'a name that could not survive an attribute or a token is refused')
  ok(safeFieldName('x'.repeat(200)) === null, 'and one that could not survive a page')
}

H('{{page:2}} takes a width, and only where a width means anything')
{
  const b = tokensToFields({ id: 'p7', kind: 'para', text: '{{page:2}} of {{pages:2}}' }, spliceText)!
  const fs = fieldsOf(b)
  ok(fs[0].pad === 2 && fs[1].pad === 2, 'the width is read off the token')
  const ctx = fieldContext(emptyDoc(), { pages: 9, pageOf: () => 6 })
  ok(resolveField(fs[0], ctx, '') === '06', 'and zero-pads')
  ok(resolveField(fs[1], ctx) === '09', 'both of them')
  ok(withField({ id: 'x', kind: 'para', text: '' }, 0, 'Name', 2).fields![0].pad === undefined,
     'a width on a name that is not a page number is dropped rather than stored meaninglessly')
  ok([...'{{page:2}}'.matchAll(TOKEN)][0][2] === '2', 'the token pattern itself carries the width')
}

// ── merging ─────────────────────────────────────────────────────────────────

H('every output is its own document')
{
  const template = emptyDoc()
  template.title = '{{Company}} statement'
  template.body = [tokensToFields({ id: 'p8', kind: 'para', text: 'Dear {{Name}}.' }, spliceText)!]

  const outs = sheet.rows.map(r => mergeDoc(template, r, sheet.columns, 'Debtors'))
  const ids = new Set(outs.map(o => o.docId))
  ok(ids.size === outs.length, `${ids.size} distinct docIds for ${outs.length} outputs`)
  ok(!ids.has(template.docId), 'and none of them is the template\'s')
  ok(outs.every(o => typeof o.docId === 'string' && o.docId.length > 8), 'each is a real id')
  ok(outs[0].title === 'Analytical Engines statement',
     `the title resolves per row, so the files have distinct names: ${outs[0].title}`)
  ok(outs[0].merge?.row?.name === 'Ada Lovelace', 'the row rides along, so the output still RESOLVES its fields')
  ok(fieldsOf(outs[0].body[0]).length === 1,
     'and the body still holds a FIELD — the value was never baked into the text')
  ok(template.body[0].text === 'Dear .' && fieldsOf(template.body[0]).length === 1,
     'the template is untouched by merging')
}

H('no emitted file carries the source\'s collaboration block')
{
  const template = emptyDoc() as TypeDoc
  // The credentials in the shape type/src/collab.ts actually mints (v2:
  // an owner keypair, a room committed to it, a read key, an invite).
  template.collab = {
    room: 'w-ROOMSECRET', key: 'READKEY-b64url', on: true, v: 2,
    owner: 'OWNERPUB', ownerPriv: 'OWNERPRIVATEKEY',
    invite: { pub: 'INVPUB', priv: 'INVPRIVATEKEY', role: 'writer', sig: 'SIG' },
  }
  template.signatures = [{ by: 'A', at: '2026-01-01', sig: 'SIGNATURE-OVER-THE-TEMPLATE' } as never]
  template.comments = { c1: { id: 'c1', block: 'b', from: 0, to: 1, quote: 'x',
                              messages: [{ id: 'm', author: 'A', at: 'now', text: 'check with legal' }] } }
  // A revision carries a WHOLE COPY of an earlier body — the wording somebody
  // negotiated away. Two hundred recipients must not each receive it.
  template.revisions = [{ id: 'r1', at: 'then', label: 'first draft',
                          body: [{ id: 'p9', kind: 'para', text: 'we will pay THE OLD PRICE.' }] }]
  template.body = [tokensToFields({ id: 'p9', kind: 'para', text: 'Dear {{Name}}.' }, spliceText)!]

  const out = mergeDoc(template, sheet.rows[0], sheet.columns, 'Debtors')
  ok(out.collab === undefined, 'the object has no collab')

  // Checked against the BYTES, because that is what leaves the machine: the
  // merged doc is spliced into a shell exactly as above, so grep the file.
  const file = bentoFile(out)
  const SECRETS = ['OWNERPRIVATEKEY', 'INVPRIVATEKEY', 'READKEY-b64url', 'w-ROOMSECRET', 'OWNERPUB']
  for (const s of SECRETS) ok(!file.includes(s), `the emitted FILE does not contain ${s}`)
  ok(!file.includes('SIGNATURE-OVER-THE-TEMPLATE'),
     'nor a signature that covers a document this one is not')
  ok(!file.includes('check with legal'), 'nor the drafting comments')
  ok(!file.includes('THE OLD PRICE'), 'nor an earlier draft of a clause, out of the revision history')
  ok(file.includes('Ada Lovelace'), 'while the row it was merged from is there')
  ok(bentoFile(template).includes('OWNERPRIVATEKEY'),
     'and the control holds: the same splice DOES carry them when nothing strips them')
}

H('file names')
{
  const row = { name: 'Ada Lovelace', company: 'Analytical/Engines' }
  ok(fillTokens('{{name}} {{#}}', row, 7) === 'Ada Lovelace 7', 'a pattern takes columns and the row number')
  ok(fillTokens('{{nothing}}!', row, 1) === '!', 'an unknown column in a pattern is empty, like everywhere else')
  ok(safeName('Analytical/Engines', 'x') === 'Analytical Engines.bento.html',
     'a path separator out of a cell cannot become a directory')
  ok(safeName('', 'merge-4') === 'merge-4.bento.html', 'an empty name falls back rather than writing ".bento.html"')
  ok(safeName('..', 'merge-4') === 'merge-4.bento.html', 'and so does a name that is only dots')
}

H('cell values')
{
  ok(cellText(null) === '' && cellText(undefined) === '', 'a blank cell is a blank string, never "null"')
  ok(cellText(0) === '0', 'a zero is a zero')
  ok(cellText(NaN) === '', 'and a non-finite number is blank rather than "NaN" on somebody\'s invoice')
  ok(cellText(true) === 'true' && cellText({}) === '', 'a boolean reads, an object does not')
}

console.log(`\n${checks - bad}/${checks} checks passed`)
if (bad) process.exit(1)
