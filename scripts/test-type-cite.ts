#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/type citations + bibliography rig.
//
//   node scripts/test-type-cite.ts        (Node ≥ 23.6 strips types natively)
//
// WHAT THIS PROVES. Three properties, and each one is a bug that would only
// show up in somebody's finished thesis:
//
//   1. THE BIBTEX READER IS TOTAL. It is fed a real .bib, and then a broken
//      one — unclosed braces, a stray @, an entry with no key, a duplicate
//      key, a field that is not `name = value`. It must never throw, and it
//      must SAY what it did not import. A parser that throws loses the whole
//      paste; one that stays quiet loses one source, which is worse, because
//      nobody notices until a reference list is one line short.
//
//   2. THE OUTPUT IS DERIVED AND STABLE. Numbers come from first appearance,
//      the author–year list is alphabetical, and neither is stored. So the
//      same input must give byte-identical output, twice in a row and after
//      the entry map is rebuilt in a different insertion order — otherwise
//      two readers of one file see different numbers, and "see [4]" points at
//      the wrong work.
//
//   3. A MISSING ENTRY IS LOUD. A citation whose source is gone renders
//      "[?key]" in both styles and is listed as missing. Silence here is the
//      one failure a reviewer cannot catch by reading.
//
// Everything under test is pure, so this rig exercises exactly the code the
// browser runs — no DOM, no stubs.

import { parseBibtex, decodeTex } from '../type/src/cite/bibtex.ts';
import {
  bibliography, citationText, collectCites, familyName, inTextAuthors, initials,
  parseNames, referenceText, resolve, sortKey,
  type CitedBlock,
} from '../type/src/cite/format.ts';
import {
  readBibliography, readCiteRef, readStyle, validKey,
  type BibEntry, type Bibliography, type CiteStyle,
} from '../type/src/cite/types.ts';

let checks = 0, failures = 0;
const ok = (c: boolean, m: string) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`); } else console.log(`  ok    ${m}`); };
const H = (s: string) => console.log(`\n=== ${s} ===`);
const eq = (got: unknown, want: unknown, m: string) =>
  ok(JSON.stringify(got) === JSON.stringify(want), `${m}${JSON.stringify(got) === JSON.stringify(want) ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);

const map = (r: ReturnType<typeof parseBibtex>): Bibliography =>
  Object.fromEntries(r.entries.map(e => [e.key, e.entry]));

// ─────────────────────────────────────────────────── a small real library

const LIB = String.raw`
% a .bib usually opens with junk like this
@string{cj = "The Computer Journal"}
@preamble{ "\newcommand{\noop}[1]{}" }

@book{knuth1984,
  author    = {Knuth, Donald E.},
  title     = {The {TeX}book},
  publisher = {Addison-Wesley},
  address   = {Reading, MA},
  edition   = {1st},
  year      = 1984
}

@article{knuth1984lit,
  author  = {Knuth, Donald E.},
  title   = {Literate Programming},
  journal = cj,
  volume  = {27},
  number  = {2},
  pages   = {97--111},
  year    = {1984},
  doi     = {10.1093/comjnl/27.2.97}
}

@inproceedings{lamport1982,
  author    = {Lamport, Leslie and Shostak, Robert and Pease, Marshall},
  title     = {The {B}yzantine Generals Problem},
  booktitle = {Proceedings of PODC},
  address   = {New York},
  pages     = {382-401},
  year      = {1982}
}

@techreport{inria1998,
  author      = {M\"{u}ller, J\o rgen and Bo\ss{}, Ren\'ee},
  title       = {On \'Etale Sites},
  institution = {INRIA},
  address     = {Rocquencourt},
  number      = {RR-42},
  year        = {1998}
}

@misc{bento2026,
  author       = {Bento Project,},
  title        = {Self-contained office documents},
  howpublished = {Web},
  url          = {https://bento.page},
  year         = {2026}
}
`;

const lib = parseBibtex(LIB);
const BIB = map(lib);

H('every supported entry type parses');
{
  eq(lib.entries.map(e => e.key),
     ['knuth1984', 'knuth1984lit', 'lamport1982', 'inria1998', 'bento2026'],
     'all five entries, in file order');
  eq(lib.entries.map(e => e.entry.type),
     ['book', 'article', 'inproceedings', 'techreport', 'misc'],
     '@book @article @inproceedings @techreport @misc keep their types');
  eq(BIB.knuth1984.publisher, 'Addison-Wesley', '@book keeps its publisher');
  eq(BIB.knuth1984lit.journal, 'The Computer Journal', '@article resolves the @string macro for its journal');
  eq(BIB.knuth1984lit.pages, '97–111', '`--` in a page range becomes an en dash');
  eq(BIB.lamport1982.booktitle, 'Proceedings of PODC', '@inproceedings keeps its booktitle');
  eq(BIB.inria1998.institution, 'INRIA', '@techreport keeps its institution');
  eq(BIB.inria1998.number, 'RR-42', 'and its report number');
  eq(BIB.bento2026.url, 'https://bento.page', '@misc keeps its url');
  eq(BIB.knuth1984.year, '1984', 'a bare number is a value, no braces needed');
  ok(lib.skipped.every(s => !/knuth|lamport|inria|bento/.test(s)),
     `a clean library reports nothing lost — ${JSON.stringify(lib.skipped)}`);
}

H('a type this app does not model still cites');
{
  const r = parseBibtex('@phdthesis{t1, author={Ada Lovelace}, title={A Thesis}, year={1843}}');
  eq(r.entries[0]?.entry.type, 'misc', '@phdthesis is imported as @misc');
  eq(r.entries[0]?.entry.title, 'A Thesis', 'with its fields intact');
  ok(r.skipped.some(s => s.includes('phdthesis')), 'and the substitution is reported, not silent');
  const c = parseBibtex('@conference{c1, title={Talk}, year={2000}}');
  eq(c.entries[0]?.entry.type, 'inproceedings', '@conference is an alias for @inproceedings');
}

H('brace-quoted titles keep their capitals');
{
  const r = map(parseBibtex(String.raw`
    @book{a, title = {The {TeX}book}}
    @article{b, title = {{DNA} sequencing and {RNA}}}
    @misc{c, title = {A study of {the Baltic Sea} in {W}inter}}
  `));
  eq(r.a.title, 'The TeXbook', 'protective braces come off, TeX stays TeX');
  eq(r.b.title, 'DNA sequencing and RNA', 'a leading brace group is not mistaken for the value delimiter');
  eq(r.c.title, 'A study of the Baltic Sea in Winter', 'nested groups unwrap without losing a character');
  // The reason this is safe: we never case-fold a title, so the protection is
  // structural rather than semantic — the braces come off and nothing else moves.
  eq(r.a.title, decodeTex('The {TeX}book'), 'the decoder alone accounts for it');
}

H('accent commands become real characters');
{
  const cases: Array<[string, string]> = [
    [String.raw`M\"uller`, 'Müller'],
    [String.raw`M\"{u}ller`, 'Müller'],
    [String.raw`Ren\'ee`, 'Renée'],
    [String.raw`Ren\'{e}e`, 'Renée'],
    [String.raw`\`a la carte`, 'à la carte'],
    [String.raw`c\^ote`, 'côte'],
    [String.raw`ma\~nana`, 'mañana'],
    [String.raw`\c{c}edilla`, 'çedilla'],
    [String.raw`\v{s}koda`, 'škoda'],
    [String.raw`\={a}`, 'ā'],
    [String.raw`\.z`, 'ż'],
    [String.raw`\u{a}`, 'ă'],
    [String.raw`\H{o}`, 'ő'],
    [String.raw`\k{a}`, 'ą'],
    [String.raw`\r{a}`, 'å'],
    [String.raw`Wei\ss{}bier`, 'Weißbier'],
    [String.raw`\o rsted`, 'ørsted'],
    [String.raw`\AA ngstr\"om`, 'Ångström'],
    [String.raw`\ae ther and \oe uvre`, 'æther and œuvre'],
    [String.raw`\L \'od\'z`, 'Łódź'],   // the space after \L terminates the command, as in TeX
    [String.raw`\'{\i}sla`, 'ísla'],
    [String.raw`a--b`, 'a–b'],
    [String.raw`a---b`, 'a—b'],
    ['``quoted\'\'', '“quoted”'],
    [String.raw`AT\&T 50\% \$5 a\_b`, 'AT&T 50% $5 a_b'],
    [String.raw`\textbf{bold} and \emph{italic}`, 'bold and italic'],
    [String.raw`P\'erez\nolinebreak`, 'Pérez'],
    [String.raw`a~b`, 'a b'],
  ];
  for (const [src, want] of cases) eq(decodeTex(src), want, `${src.replace(/\\/g, '\\')} → ${want}`);
  eq(BIB.inria1998.author, 'Müller, Jørgen and Boß, Renée', 'accents survive the whole parse, not just the decoder');
  eq(BIB.inria1998.title, 'On Étale Sites', 'and so does a title-leading accent');
}

H('a malformed .bib does not throw, and says what it skipped');
{
  const bad = String.raw`
@book{good1, title = {Fine}, year = {2000}}
@book{good1, title = {A second entry with the same key}}
@book{, title = {No key at all}}
@article{broken, title = {Never closed
@
@nonsense
@misc{ugly, this is not a field, title = {Still here}}
@book{good2, title = {After the wreckage}}
`;
  let r: ReturnType<typeof parseBibtex> | undefined;
  let threw = '';
  try { r = parseBibtex(bad); } catch (e) { threw = String(e); }
  ok(!threw, `it returned rather than throwing${threw ? ` — ${threw}` : ''}`);
  const keys = (r?.entries ?? []).map(e => e.key);
  eq(keys, ['good1', 'ugly', 'good2'],
     'it kept every entry it could read — including the ones AFTER the unterminated @article');
  ok(r!.skipped.some(s => s.includes('good1') && s.includes('kept the first')),
     'the duplicate key is reported, and the FIRST definition wins');
  ok(r!.skipped.some(s => s.includes('no citation key')), 'the keyless entry is reported');
  ok(r!.skipped.some(s => s.includes('never closed')), 'the unterminated entry is reported');
  ok(r!.skipped.some(s => s.includes('reading continued')),
     'and the scan resumes after it rather than abandoning the rest of the file');
  ok(r!.skipped.some(s => s.includes('stray "@"')), 'the stray @ is reported');
  ok(r!.skipped.some(s => s.includes('ugly') && s.includes('field = value')),
     'the junk inside an otherwise-good entry is reported and the entry survives');
  eq(map(r!).ugly.title, 'Still here', 'and the good field beside the junk is kept');

  // the pathological shapes, which must each return rather than hang or blow the stack
  for (const [label, src] of [
    ['empty input', ''],
    ['no @ anywhere', 'just some prose about Knuth'],
    ['only an @', '@'],
    ['a wall of open braces', '@book{k, title = {' + '{'.repeat(5000)],
    ['a wall of backslashes', '@book{k, title = {' + '\\'.repeat(5000) + '}}'],
    ['an unterminated quote', '@book{k, title = "never closed}'],
    ['a lone close brace', '}}}}'],
    ['a nul byte', '@book{k, title = {a b}}'],
  ] as Array<[string, string]>) {
    let out = '', bang = '';
    try { out = JSON.stringify(parseBibtex(src)).slice(0, 0); } catch (e) { bang = String(e); }
    ok(!bang && out === '', `${label}: returned a result${bang ? ` — ${bang}` : ''}`);
  }
  eq(map(parseBibtex('@book{k, title = {a b‮c}}')).k?.title, 'ab c'.replace(' ', ''),
     'control characters and bidi overrides are stripped from a value');
  eq(parseBibtex(undefined).entries.length, 0, 'a non-string input is nothing to read, not a crash');
}

H('pasted BibTeX cannot become markup');
{
  const r = map(parseBibtex(
    '@misc{x, title = {<script>alert(1)</script>}, author = {O"Brien & Sons,}, url = {javascript:alert(1)}}'));
  eq(r.x.title, '<script>alert(1)</script>',
     'angle brackets stay ORDINARY CHARACTERS here — escaping is the renderer\'s job, at the DOM seam');
  ok(!validKey('<img src=x>'), 'a key that could be mistaken for markup is not a valid key');
  ok(!validKey('a b'), 'nor is one with a space, which is how keys are packed into one attribute');
  ok(validKey('knuth1984'), 'an ordinary key is fine');
  ok(validKey('van-der-waals:1873'), 'and so are the punctuation marks real keys use');
}

H('@string macros and concatenation');
{
  const r = map(parseBibtex(String.raw`
    @string{acm = "ACM"}
    @string{tocs = acm # " Transactions on Computer Systems"}
    @article{a, journal = tocs, month = jul, title = "Quoted " # "and joined"}
    @article{b, journal = nosuchmacro}
  `));
  eq(r.a.journal, 'ACM Transactions on Computer Systems', 'a macro built from another macro resolves');
  eq(r.a.title, 'Quoted and joined', 'two quoted strings concatenate with #');
  eq(r.a.month, 'July', 'the built-in month macros are defined');
  eq(r.b.journal, 'nosuchmacro', 'an undefined macro is used as written rather than losing the field');
}

// ────────────────────────────────────────────────────────────────── names

H('names decompose both ways round');
{
  const n = (s: string) => parseNames(s).names;
  eq(n('Donald E. Knuth')[0], { last: 'Knuth', first: 'Donald E.', von: '', jr: '' }, 'First von Last');
  eq(n('Knuth, Donald E.')[0], { last: 'Knuth', first: 'Donald E.', von: '', jr: '' }, 'von Last, First');
  eq(n('Ludwig van Beethoven')[0], { last: 'Beethoven', first: 'Ludwig', von: 'van', jr: '' }, 'a particle joins the surname');
  eq(n('de la Vega, Jr., Maria')[0], { last: 'Vega', first: 'Maria', von: 'de la', jr: 'Jr.' }, 'von Last, Jr, First');
  eq(familyName(n('Ludwig van Beethoven')[0]), 'van Beethoven', 'and the family name keeps it');
  eq(n('Bento Project,')[0], { last: 'Bento Project', first: '', von: '', jr: '' },
     'a trailing comma marks an institutional author, which is never initialised');
  eq(initials('Donald E.'), 'D. E.', 'initials');
  eq(initials('Jean-Paul'), 'J.-P.', 'hyphenated given names keep the hyphen');
  eq(parseNames('A. One and B. Two and others').etAl, true, '"and others" sets et al.');
  eq(parseNames(undefined).names.length, 0, 'a missing author field is no names, not a crash');
}

H('two authors versus many — the et al. rules');
{
  const mk = (author: string): BibEntry => ({ type: 'article', author, title: 'T', year: '1999' });
  eq(inTextAuthors(mk('Knuth, Donald E.')), 'Knuth', 'one author is named');
  eq(inTextAuthors(mk('Knuth, Donald E. and Lamport, Leslie')), 'Knuth & Lamport',
     'two authors are both named, joined with &');
  eq(inTextAuthors(mk('Knuth, D. and Lamport, L. and Pease, M.')), 'Knuth et al.',
     'three or more collapse to et al. from the first citation (APA 7)');
  eq(inTextAuthors(mk('Knuth, D. and others')), 'Knuth et al.', '"and others" collapses too');
  eq(inTextAuthors({ type: 'misc', title: 'A work with no author' }), 'A work with no author',
     'with no author at all the title stands in');

  const six = 'A, One and B, Two and C, Three and D, Four and E, Five and F, Six';
  const seven = `${six} and G, Seven`;
  ok(referenceText(mk(six), 'numeric').startsWith('O. A, T. B, T. C, F. D, F. E, and S. F,'),
     'IEEE lists six authors in full');
  ok(referenceText(mk(seven), 'numeric').startsWith('O. A et al.,'),
     'and gives up at seven — the style\'s own ceiling, not ours');
  ok(referenceText(mk('Knuth, D. and Lamport, L.'), 'author-year').startsWith('Knuth, D., & Lamport, L.'),
     'APA joins two with ", &"');
  ok(referenceText(mk(six), 'author-year').includes(', & S. F') === false,
     'APA reference-list names are inverted, so the last one is "F, S." not "S. F"');
}

// ──────────────────────────────────────────────────────── styles and order

/** A body citing: [knuth1984], then [lamport1982 + knuth1984lit], then a
 *  missing key, then inria1998 — deliberately NOT alphabetical order. */
const BODY: CitedBlock[] = [
  { id: 'b1', cites: [{ at: 30, keys: ['knuth1984'] }] },
  { id: 'b2', cites: [{ at: 12, keys: ['lamport1982', 'knuth1984lit'] }, { at: 4, keys: ['bento2026'] }] },
  { id: 'b3', cites: [{ at: 0, keys: ['ghost1999'] }, { at: 9, keys: ['inria1998'], locator: 'p. 34' }] },
];

/** A citation by where it sits, so the checks below cannot drift when the
 *  fixture is edited — indexing into `cites` silently pointed at the wrong
 *  citation once, because b2's list is written out of offset order on purpose. */
const cite = (blockId: string, at: number) =>
  BODY.find(b => b.id === blockId)!.cites!.find(c => c.at === at)!;

H('citations are collected in document order, and offsets sort within a block');
{
  eq(collectCites(BODY).map(s => `${s.blockId}@${s.ref.at}`),
     ['b1@30', 'b2@4', 'b2@12', 'b3@0', 'b3@9'],
     'block order outside, offset order inside — b2\'s citation at 4 comes before the one at 12');
}

H('numeric (IEEE-ish)');
{
  const res = resolve(BODY, BIB, 'numeric');
  eq(res.number, { knuth1984: 1, bento2026: 2, lamport1982: 3, knuth1984lit: 4, inria1998: 5 },
     'numbered by FIRST APPEARANCE, so [1] is the first reference a reader meets');
  eq(citationText(cite('b1', 30), res, BIB), '[1]', 'a single citation');
  eq(citationText(cite('b2', 12), res, BIB), '[3], [4]', 'a multi-key citation lists each number');
  eq(citationText(cite('b3', 9), res, BIB), '[5, p. 34]', 'a locator rides inside the bracket');
  const lines = bibliography(res, BIB);
  eq(lines.map(l => l.label), ['[1]', '[2]', '[3]', '[4]', '[5]'], 'the list is labelled and in citation order');
  eq(lines[0].text, 'D. E. Knuth, The TeXbook, 1st ed. Reading, MA: Addison-Wesley, 1984.',
     '@book: title unquoted, edition, place: publisher, year');
  eq(lines[3].text,
     'D. E. Knuth, "Literate Programming," The Computer Journal, vol. 27, no. 2, pp. 97–111, 1984. ' +
     '[Online]. Available: https://doi.org/10.1093/comjnl/27.2.97',
     '@article: quoted title with the comma inside the quotes, then journal, vol, no, pages, year');
  eq(lines[2].text, 'L. Lamport, R. Shostak, and M. Pease, "The Byzantine Generals Problem," ' +
     'in Proceedings of PODC, New York, pp. 382–401, 1982.',
     '@inproceedings: "in <booktitle>", and a plain hyphen page range is normalised to an en dash');
  eq(lines[4].text, 'J. Müller and R. Boß, "On Étale Sites," INRIA, Rocquencourt, Tech. Rep. RR-42, 1998.',
     '@techreport: institution, address, report number');
  eq(lines[1].text, 'Bento Project, "Self-contained office documents," Web, 2026. ' +
     '[Online]. Available: https://bento.page',
     '@misc: howpublished and the online availability note');
}

H('author–year (APA-ish)');
{
  const res = resolve(BODY, BIB, 'author-year');
  eq(res.number, {}, 'nothing is numbered');
  eq(res.order, ['bento2026', 'knuth1984lit', 'knuth1984', 'lamport1982', 'inria1998'],
     'the list is alphabetical by author, not by first appearance — and two works ' +
     'by one author in one year are ordered by TITLE, so Literate Programming ' +
     'precedes The TeXbook');
  eq(res.suffix, { knuth1984lit: 'a', knuth1984: 'b' },
     'the disambiguating letters follow that order: 1984a is the one printed first');
  eq(citationText(cite('b1', 30), res, BIB), '(Knuth, 1984b)', 'and the citation carries the letter');
  eq(citationText(cite('b2', 12), res, BIB), '(Knuth, 1984a; Lamport et al., 1982)',
     'a multi-key citation is joined with "; " IN LIST ORDER, not click order');
  eq(citationText(cite('b3', 9), res, BIB), '(Müller & Boß, 1998, p. 34)', 'the locator follows the year');
  eq(citationText({ at: 0, keys: ['knuth1984'], suppressAuthor: true }, res, BIB), '(1984b)',
     'suppressAuthor is for a sentence that already said "Knuth"');
  const lines = bibliography(res, BIB);
  eq(lines.map(l => l.label), ['', '', '', '', ''], 'an author–year list carries no labels');
  eq(lines[2].text, 'Knuth, D. E. (1984b). The TeXbook (1st ed.). Addison-Wesley.', '@book');
  eq(lines[1].text, 'Knuth, D. E. (1984a). Literate Programming. The Computer Journal, 27(2), 97–111. ' +
     'https://doi.org/10.1093/comjnl/27.2.97', '@article, with volume(issue) and the DOI as a URL');
  eq(lines[3].text, 'Lamport, L., Shostak, R., & Pease, M. (1982). The Byzantine Generals Problem. ' +
     'In Proceedings of PODC (pp. 382–401).', '@inproceedings');
  eq(lines[4].text, 'Müller, J., & Boß, R. (1998). On Étale Sites (Report No. RR-42). INRIA.', '@techreport');
  eq(referenceText({ type: 'book', author: 'Nobody, N.', title: 'Undated' }, 'author-year'),
     'Nobody, N. (n.d.). Undated.', 'a work with no year is n.d., not blank');
}

H('a citation to a missing entry degrades VISIBLY');
{
  for (const style of ['numeric', 'author-year'] as CiteStyle[]) {
    const res = resolve(BODY, BIB, style);
    eq(res.missing, ['ghost1999'], `${style}: the missing key is reported`);
    // The marker keeps the style's own wrapper — "(…)" in author–year — so it
    // reads as a citation that went wrong rather than as loose stray text.
    eq(citationText(cite('b3', 0), res, BIB), style === 'numeric' ? '[?ghost1999]' : '([?ghost1999])',
       `${style}: it renders as [?key] — with the key, so the author knows WHICH source went`);
    ok(!res.order.includes('ghost1999'), `${style}: and it takes no slot in the reference list`);
  }
  const res = resolve(BODY, BIB, 'numeric');
  eq(citationText({ at: 0, keys: ['knuth1984', 'ghost1999'] }, res, BIB), '[1], [?ghost1999]',
     'one bad key in a group does not take the good one down with it');
}

H('nothing is stored — the same input always gives the same output');
{
  const before = JSON.stringify({ BODY, BIB });
  const a = JSON.stringify(bibliography(resolve(BODY, BIB, 'numeric'), BIB));
  const b = JSON.stringify(bibliography(resolve(BODY, BIB, 'numeric'), BIB));
  eq(a, b, 'twice in a row, byte-identical');
  eq(JSON.stringify({ BODY, BIB }), before, 'and resolving mutated neither the body nor the entries');

  // the entry map rebuilt in the opposite insertion order must not move the list
  const flipped: Bibliography = {};
  for (const k of Object.keys(BIB).reverse()) flipped[k] = BIB[k];
  eq(JSON.stringify(resolve(BODY, flipped, 'author-year').order),
     JSON.stringify(resolve(BODY, BIB, 'author-year').order),
     'the alphabetical order does not depend on the map\'s insertion order');
  eq(JSON.stringify(resolve(BODY, flipped, 'numeric').number),
     JSON.stringify(resolve(BODY, BIB, 'numeric').number),
     'and neither do the numbers');

  // and it must not depend on the reader's locale, which is why sortKey exists
  eq(sortKey('Ångström'), 'angstrom', 'the sort key folds diacritics rather than asking the locale');
  eq(sortKey('van der Waals'), 'van der waals', 'and lowercases without dropping the particle');

  // switching style is a preference, not an edit
  const numbered = JSON.stringify(BODY);
  resolve(BODY, BIB, 'author-year');
  eq(JSON.stringify(BODY), numbered, 'resolving in the other style leaves the document alone');
}

H('reading a document that was written by something else');
{
  eq(readBibliography(undefined), {}, 'an older file has no bibliography, and that is not an error');
  eq(readStyle(undefined), 'numeric', 'nor a style');
  eq(readStyle('cslJSON'), 'numeric', 'an unknown style falls back rather than rendering nothing');
  eq(readBibliography({ 'ok1': { type: 'book', title: 'Kept' },
                        'bad key': { type: 'book', title: 'Dropped' },
                        'ok2': 'not an object' }),
     { ok1: { type: 'book', title: 'Kept' } },
     'an unusable key or value is dropped, the rest survives');
  eq(readBibliography({ x: { type: 'nonsense', title: 'T', abstract: 'unmodelled' } }),
     { x: { type: 'misc', title: 'T' } },
     'an unknown type reads as misc and an unmodelled field is not carried');
  eq(readCiteRef({ at: 999, keys: ['knuth1984'] }, 10)?.at, 10,
     'an offset past the end of the text is clamped to it');
  eq(readCiteRef({ at: 2, keys: [] }, 10), undefined, 'a citation with no keys is not a citation');
  eq(readCiteRef({ at: 2, keys: ['ok', 'has space'] }, 10)?.keys, ['ok'], 'and unusable keys are dropped from it');
  eq(readCiteRef('nonsense', 10), undefined, 'and garbage is rejected without throwing');
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
