// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * maths-lite — the ONE symbol table. Each row: LaTeX name (without the
 * backslash), Typst name, code point, class (i = identifier, o = operator).
 * Both front ends look symbols up here; there is no second list anywhere.
 * Every row costs bytes in the shell, so the table is what our decks and the
 * obvious tier need, not what TeX has.
 */

export type SymClass = 'i' | 'o' | 'big'
export type Sym = { tex: string; typst: string; cp: string; cls: SymClass }

// tex, typst, glyph, class — one line each so the table is diffable.
const T = (tex: string, typst: string, cp: string, cls: SymClass = 'o'): Sym => ({ tex, typst, cp, cls })

export const SYMBOLS: Sym[] = [
  // greek (lowercase italic in maths, uppercase upright)
  T('alpha', 'alpha', 'α', 'i'), T('beta', 'beta', 'β', 'i'), T('gamma', 'gamma', 'γ', 'i'), T('delta', 'delta', 'δ', 'i'),
  T('epsilon', 'epsilon', 'ϵ', 'i'), T('varepsilon', 'epsilon.alt', 'ε', 'i'), T('zeta', 'zeta', 'ζ', 'i'), T('eta', 'eta', 'η', 'i'),
  T('theta', 'theta', 'θ', 'i'), T('vartheta', 'theta.alt', 'ϑ', 'i'), T('iota', 'iota', 'ι', 'i'), T('kappa', 'kappa', 'κ', 'i'),
  T('lambda', 'lambda', 'λ', 'i'), T('mu', 'mu', 'μ', 'i'), T('nu', 'nu', 'ν', 'i'), T('xi', 'xi', 'ξ', 'i'),
  T('pi', 'pi', 'π', 'i'), T('rho', 'rho', 'ρ', 'i'), T('sigma', 'sigma', 'σ', 'i'), T('tau', 'tau', 'τ', 'i'),
  T('upsilon', 'upsilon', 'υ', 'i'), T('phi', 'phi', 'ϕ', 'i'), T('varphi', 'phi.alt', 'φ', 'i'), T('chi', 'chi', 'χ', 'i'),
  T('psi', 'psi', 'ψ', 'i'), T('omega', 'omega', 'ω', 'i'),
  T('Gamma', 'Gamma', 'Γ', 'i'), T('Delta', 'Delta', 'Δ', 'i'), T('Theta', 'Theta', 'Θ', 'i'), T('Lambda', 'Lambda', 'Λ', 'i'),
  T('Xi', 'Xi', 'Ξ', 'i'), T('Pi', 'Pi', 'Π', 'i'), T('Sigma', 'Sigma', 'Σ', 'i'), T('Phi', 'Phi', 'Φ', 'i'),
  T('Psi', 'Psi', 'Ψ', 'i'), T('Omega', 'Omega', 'Ω', 'i'),
  // binary operators
  T('pm', 'plus.minus', '±'), T('mp', 'minus.plus', '∓'), T('times', 'times', '×'), T('div', 'div', '÷'),
  T('cdot', 'dot.op', '⋅'), T('ast', 'ast', '∗'), T('star', 'star', '⋆'), T('circ', 'compose', '∘'),
  T('bullet', 'bullet', '∙'), T('cap', 'sect', '∩'), T('cup', 'union', '∪'), T('setminus', 'without', '∖'),
  T('oplus', 'plus.circle', '⊕'), T('otimes', 'times.circle', '⊗'), T('wedge', 'and', '∧'), T('vee', 'or', '∨'),
  T('land', 'and', '∧'), T('lor', 'or', '∨'), T('dagger', 'dagger', '†'), T('ddagger', 'dagger.double', '‡'), T('diamond', 'diamond.stroked.small', '⋄'),
  // relations
  T('le', 'lt.eq', '≤'), T('leq', 'lt.eq', '≤'), T('ge', 'gt.eq', '≥'), T('geq', 'gt.eq', '≥'), T('ne', 'eq.not', '≠'), T('neq', 'eq.not', '≠'),
  T('approx', 'approx', '≈'), T('equiv', 'equiv', '≡'), T('sim', 'tilde.op', '∼'), T('simeq', 'tilde.eq', '≃'), T('cong', 'tilde.equiv', '≅'),
  T('propto', 'prop', '∝'), T('ll', 'lt.double', '≪'), T('gg', 'gt.double', '≫'), T('prec', 'prec', '≺'), T('succ', 'succ', '≻'),
  T('subset', 'subset', '⊂'), T('supset', 'supset', '⊃'), T('subseteq', 'subset.eq', '⊆'), T('supseteq', 'supset.eq', '⊇'),
  T('in', 'in', '∈'), T('notin', 'in.not', '∉'), T('ni', 'in.rev', '∋'), T('parallel', 'parallel', '∥'), T('perp', 'perp', '⟂'),
  T('mid', 'divides', '|'), T('models', 'models', '⊧'), T('vdash', 'tack.r', '⊢'),
  T('nmid', 'divides.not', '∤'), T('nparallel', 'parallel.not', '∦'),
  T('leqslant', 'lt.eq.slant', '⩽'), T('geqslant', 'gt.eq.slant', '⩾'), T('lesssim', 'lt.tilde', '≲'), T('gtrsim', 'gt.tilde', '≳'),
  T('nleq', 'lt.eq.not', '≰'), T('ngeq', 'gt.eq.not', '≱'), T('nless', 'lt.not', '≮'), T('ngtr', 'gt.not', '≯'), T('lneq', 'lt.neq', '⪇'), T('gneq', 'gt.neq', '⪈'),
  T('nsim', 'tilde.not', '≁'), T('ncong', 'tilde.equiv.not', '≇'),
  T('subsetneq', 'subset.neq', '⊊'), T('supsetneq', 'supset.neq', '⊋'), T('varsubsetneq', 'subset.neq', '⊊︀'), T('varsupsetneq', 'supset.neq', '⊋︀'),
  T('nsubseteq', 'subset.eq.not', '⊈'), T('nsupseteq', 'supset.eq.not', '⊉'),
  // arrows
  T('to', 'arrow.r', '→'), T('rightarrow', 'arrow.r', '→'), T('leftarrow', 'arrow.l', '←'), T('leftrightarrow', 'arrow.l.r', '↔'),
  T('Rightarrow', 'arrow.r.double', '⇒'), T('Leftarrow', 'arrow.l.double', '⇐'), T('Leftrightarrow', 'arrow.l.r.double', '⇔'), T('iff', 'arrow.l.r.double.long', '⟺'),
  T('mapsto', 'arrow.r.bar', '↦'), T('longrightarrow', 'arrow.r.long', '⟶'), T('uparrow', 'arrow.t', '↑'), T('downarrow', 'arrow.b', '↓'),
  T('implies', 'arrow.r.double.long', '⟹'), T('hookrightarrow', 'arrow.r.hook', '↪'),
  T('gets', 'arrow.l', '←'),
  // logic & sets
  T('forall', 'forall', '∀', 'i'), T('exists', 'exists', '∃', 'i'), T('nexists', 'exists.not', '∄', 'i'), T('neg', 'not', '¬'), T('lnot', 'not', '¬'),
  T('emptyset', 'emptyset', '∅', 'i'), T('varnothing', 'nothing', '∅', 'i'), T('infty', 'infinity', '∞', 'i'), T('partial', 'diff', '∂', 'i'), T('nabla', 'nabla', '∇'),
  T('angle', 'angle', '∠'), T('triangle', 'triangle', '△'), T('hbar', 'planck.reduce', 'ℏ', 'i'), T('ell', 'ell', 'ℓ', 'i'),
  T('Re', 'Re', 'ℜ', 'i'), T('Im', 'Im', 'ℑ', 'i'), T('aleph', 'aleph', 'ℵ', 'i'), T('wp', 'wp', '℘', 'i'),
  T('degree', 'degree', '°'), T('prime', 'prime', '′'), T('therefore', 'therefore', '∴'), T('because', 'because', '∵'),
  T('top', 'top', '⊤', 'i'), T('bot', 'bot', '⊥', 'i'), T('square', 'square.stroked', '□', 'i'), T('Box', 'square.stroked', '□', 'i'), T('blacksquare', 'square.filled', '■', 'i'), T('checkmark', 'checkmark', '✓', 'i'),
  // dots
  T('ldots', 'dots.h', '…'), T('cdots', 'dots.h.c', '⋯'), T('vdots', 'dots.v', '⋮'), T('ddots', 'dots.down', '⋱'), T('dots', 'dots', '…'),
  T('dotsc', 'dots.h', '…'), T('dotso', 'dots.h', '…'), T('dotsb', 'dots.h.c', '⋯'), T('dotsm', 'dots.h.c', '⋯'), T('dotsi', 'dots.h.c', '⋯'),
  // big operators (limits go under/over in display mode)
  T('sum', 'sum', '∑', 'big'), T('prod', 'product', '∏', 'big'), T('coprod', 'coproduct', '∐', 'big'),
  T('int', 'integral', '∫', 'big'), T('iint', 'integral.double', '∬', 'big'), T('iiint', 'integral.triple', '∭', 'big'), T('oint', 'integral.cont', '∮', 'big'),
  T('bigcup', 'union.big', '⋃', 'big'), T('bigcap', 'sect.big', '⋂', 'big'), T('bigoplus', 'plus.circle.big', '⨁', 'big'), T('bigotimes', 'times.circle.big', '⨂', 'big'),
  T('bigwedge', 'and.big', '⋀', 'big'), T('bigvee', 'or.big', '⋁', 'big'),
  // fences that are also symbols
  T('langle', 'angle.l', '⟨'), T('rangle', 'angle.r', '⟩'), T('lfloor', 'floor.l', '⌊'), T('rfloor', 'floor.r', '⌋'),
  T('lceil', 'ceil.l', '⌈'), T('rceil', 'ceil.r', '⌉'), T('|', 'bar.v.double', '‖'), T('vert', 'bar.v', '|'), T('Vert', 'bar.v.double', '‖'),
  T('lbrace', 'brace.l', '{'), T('rbrace', 'brace.r', '}'), T('{', 'brace.l', '{'), T('}', 'brace.r', '}'), T('backslash', 'backslash', '\\'),
]

// The rest of TeX's symbol vocabulary, as Temml 0.13.3 spells it (#551):
// "name glyph name glyph …", one string per class — a row here is a name and
// a code point, nothing more, so a string costs a fraction of a T() call.
// Generated from Temml's own output and gated tree-for-tree against it by
// scripts/test-maths-coverage.ts; no Typst names (Typst has its own table).
const PACKED: Record<SymClass, string> = {
  i:
  "AE Æ Angstrom Å Bbbk 𝕜 Bot ⫫ Complex ℂ Coppa Ϙ DH Ð DJ Đ Diamond ◊ Earth ⊕ Finv Ⅎ Game ⅁ Koppa Ϟ " +
  "L Ł N ℕ NG Ŋ O Ø OE Œ P ¶ QED ∎ R ℝ Reals ℝ S § Sampi Ϡ Stigma Ϛ TH Þ Z ℤ ae æ alef ℵ alefsym ℵ " +
  "astrosun ☉ ballotx ✗ beth ℶ bigstar ★ blacklozenge ⧫ blacktriangle ▲ blacktriangledown ▼ cent ¢ " +
  "circledR ® circledS Ⓢ clubs ♣ clubsuit ♣ cnums ℂ complement ∁ coppa ϙ copyright © dag † daleth ℸ " +
  "ddag ‡ dh ð diagdown ╲ diagup ╱ diameter ⌀ diamonds ♢ diamondsuit ♢ digamma ϝ dj đ empty ∅ eth ð " +
  "euro € exist ∃ female ♀ flat ♭ gimel ℷ hearts ♡ heartsuit ♡ hslash ℏ image ℑ imath ı infin ∞ jmath ȷ " +
  "koppa ϟ l Ł leftmoon ☾ lightning ↯ lozenge ◊ lq ‘ male ♂ maltese ✠ mathsterling £ measuredangle ∡ " +
  "mho ℧ natnums ℕ natural ♮ ng ŋ o ø oc ! oe œ omicron ο permil ‰ pounds £ real ℜ reals ℝ rightmoon ☽ " +
  "sampi ϡ sect § sharp ♯ shift ↕ shneg ↑ shpos ↓ smiley ☺ spades ♠ spadesuit ♠ sphericalangle ∢ ss ß " +
  "stigma ϛ sun ☼ thetasym ϑ triangledown ▽ var δ varDelta 𝛥 varGamma 𝛤 varLambda 𝛬 varOmega 𝛺 " +
  "varPhi 𝛷 varPi 𝛱 varPsi 𝛹 varSigma 𝛴 varTheta 𝛩 varUpsilon 𝛶 varXi 𝛯 varclubsuit ♧ varcoppa ϙ " +
  "vardiamondsuit ♦ varheartsuit ♥ variation δ varkappa ϰ varpi ϖ varrho ϱ varsigma ς varspadesuit ♤ " +
  "varvdots ⋮ weierp ℘ wn ? yen ¥ ",
  o:
  "And & Bumpeq ≎ Cap ⋒ Coloneqq ⩴ Cup ⋓ Dagger ‡ Darr ⇓ Doteq ≑ Downarrow ⇓ Harr ⇔ Join ⋈ Larr ⇐ " +
  "Lleftarrow ⇚ Longleftarrow ⟸ Longleftrightarrow ⟺ Longrightarrow ⟹ Lrarr ⇔ Lsh ↰ Nand ⊼ Nor ⊽ " +
  "Otimes ⨷ Perp ⫫ Rarr ⇒ Rrightarrow ⇛ Rsh ↱ Sqcap ⩎ Sqcup ⩏ Subset ⋐ Supset ⋑ Uarr ⇑ Uparrow ⇑ " +
  "Updownarrow ⇕ VDash ⊫ Vdash ⊩ Vee ⩔ Vvdash ⊪ Wedge ⩓ Xor ⊻ amalg ⨿ approxeq ≊ arceq ≘ asymp ≍ " +
  "backcong ≌ backepsilon ∍ backsim ∽ backsimeq ⋍ barcap ⩃ barcup ⩂ barvee ⊽ barwedge ⊼ between ≬ " +
  "bigcirc ◯ bigtriangledown ▽ bigtriangleup △ blackhourglass ⧗ blacktriangleleft ◀ " +
  "blacktriangleright ▶ bowtie ⋈ boxast ⧆ boxbox ⧈ boxcircle ⧇ boxdot ⊡ boxminus ⊟ boxplus ⊞ boxslash ⧄ " +
  "boxtimes ⊠ bull ∙ bumpeq ≏ capbarcup ⩈ capdot ⩀ capovercup ⩇ circeq ≗ circlearrowleft ↺ " +
  "circlearrowright ↻ circledast ⊛ circledcirc ⊚ circleddash ⊝ circledequal ⊜ circledparallel ⦷ " +
  "circledvert ⦶ circlehbar ⦵ closedvarcap ⩍ closedvarcup ⩌ coloncolon ∷ coloncolonequals ⩴ coloneqq ≔ " +
  "colonequals ≔ concavediamond ⟡ concavediamondtickleft ⟢ concavediamondtickright ⟣ cupovercap ⩆ " +
  "curlyeqprec ⋞ curlyeqsucc ⋟ curlyvee ⋎ curlywedge ⋏ curvearrowleft ↶ curvearrowright ↷ dArr ⇓ darr ↓ " +
  "dashleftarrow ⇠ dashrightarrow ⇢ dashv ⊣ dblcolon ∷ divideontimes ⋇ doteq ≐ doteqdot ≑ dotminus ∸ " +
  "dotplus ∔ doublebarvee ⩢ doublebarwedge ⩞ doublecap ⋒ doublecup ⋓ downdownarrows ⇊ downharpoonleft ⇃ " +
  "downharpoonright ⇂ eqcirc ≖ eqcolon ∹ eqdef ≝ eqeq ⩵ eqeqeq ⩶ eqqcolon ≕ eqsim ≂ eqslantgtr ⪖ " +
  "eqslantless ⪕ equal = equalscolon ≕ fallingdotseq ≒ frown ⌢ fullouterjoin ⟗ geqq ≧ ggg ⋙ gggtr ⋙ " +
  "gnapprox ⪊ gneqq ≩ gnsim ⋧ gt > gtrapprox ⪆ gtrdot ⋗ gtreqless ⋛ gtreqqless ⪌ gtrless ≷ gvertneqq ≩︀ " +
  "hArr ⇔ harr ↔ hookleftarrow ↩ hourglass ⧖ iddots ⋰ imageof ⊷ intercal ⊺ interleave ⫴ invlazys ∾ " +
  "isin ∈ lAngle ⟪ lArr ⇐ lBrace ⦃ lang ⟨ larr ← leadsto ⇝ leftarrowtail ↢ leftharpoondown ↽ " +
  "leftharpoonup ↼ leftleftarrows ⇇ leftouterjoin ⟕ leftrightarrows ⇆ leftrightharpoons ⇋ " +
  "leftrightsquigarrow ↭ leftthreetimes ⋋ leqq ≦ lessapprox ⪅ lessdot ⋖ lesseqgtr ⋚ lesseqqgtr ⪋ " +
  "lessgtr ≶ lgroup ⟮ lhd ⊲ llangle ⦉ llbracket ⟦ llcorner ⌞ lll ⋘ llless ⋘ llparenthesis ⦇ " +
  "lmoustache ⎰ lnapprox ⪉ lneqq ≨ lnsim ⋦ longleftarrow ⟵ longleftrightarrow ⟷ longmapsto ⟼ " +
  "looparrowleft ↫ looparrowright ↬ lozengeminus ⟠ lparen ( lrArr ⇔ lrarr ↔ lrcorner ⌟ lt < ltimes ⋉ " +
  "lvertneqq ≨︀ mapsfrom ↤ mathellipsis … measeq ≞ minuscolon ∹ minusdot ⨪ minusfdots ⨫ minusrdots ⨬ " +
  "multimap ⊸ nLeftarrow ⇍ nLeftrightarrow ⇎ nRightarrow ⇏ nVDash ⊯ nVdash ⊮ nearrow ↗ ngeqq ≱ " +
  "ngeqslant ≱ nleftarrow ↚ nleftrightarrow ↮ nleqq ≰ nleqslant ≰ nprec ⊀ npreceq ⋠ nrightarrow ↛ " +
  "nsubset ⊄ nsubseteqq ⊈ nsucc ⊁ nsucceq ⋡ nsupset ⊅ nsupseteqq ⊉ ntriangleleft ⋪ ntrianglelefteq ⋬ " +
  "ntriangleright ⋫ ntrianglerighteq ⋭ nvDash ⊭ nvdash ⊬ nwarrow ↖ obar ⌽ obslash ⦸ odiv ⨸ odot ⊙ " +
  "ogreaterthan ⧁ olessthan ⧀ ominus ⊖ operp ⦹ origof ⊶ oslash ⊘ otimeshat ⨶ owns ∋ pitchfork ⋔ " +
  "plusmn ± precapprox ⪷ preccurlyeq ≼ preceq ⪯ precnapprox ⪹ precneqq ⪵ precnsim ⋨ precsim ≾ questeq ≟ " +
  "rAngle ⟫ rArr ⇒ rBrace ⦄ rang ⟩ rarr → restriction ↾ rgroup ⟯ rhd ⊳ rightarrowtail ↣ " +
  "rightharpoondown ⇁ rightharpoonup ⇀ rightleftarrows ⇄ rightleftharpoons ⇌ rightouterjoin ⟖ " +
  "rightrightarrows ⇉ rightsquigarrow ⇝ rightthreetimes ⋌ risingdotseq ≓ rmoustache ⎱ rparen ) " +
  "rrangle ⦊ rrbracket ⟧ rrparenthesis ⦈ rtimes ⋊ sdot ⋅ searrow ↘ shuffle ⧢ smallfrown ⌢ smallint ∫ " +
  "smallsmile ⌣ smashtimes ⨳ smile ⌣ sqcap ⊓ sqcup ⊔ sqsubset ⊏ sqsubseteq ⊑ sqsupset ⊐ sqsupseteq ⊒ " +
  "sslash ⫽ stareq ≛ strictfi ⥼ strictif ⥽ sub ⊂ sube ⊆ subseteqq ⫅ subsetneqq ⫋ succapprox ⪸ " +
  "succcurlyeq ≽ succeq ⪰ succnapprox ⪺ succneqq ⪶ succnsim ⋩ succsim ≿ supe ⊇ supseteqq ⫆ supsetneqq ⫌ " +
  "swarrow ↙ thickapprox ≈ thicksim ∼ threedotcolon ⫶ triangleleft ◃ trianglelefteq ⊴ triangleminus ⨺ " +
  "triangleplus ⨹ triangleq ≜ triangleright ▹ trianglerighteq ⊵ triangletimes ⨻ twocaps ⩋ twocups ⩊ " +
  "twoheadleftarrow ↞ twoheadrightarrow ↠ typecolon ⦂ uArr ⇑ uarr ↑ ulcorner ⌜ unlhd ⊴ unrhd ⊵ " +
  "updownarrow ↕ upharpoonleft ↿ upharpoonright ↾ uplus ⊎ upuparrows ⇈ urcorner ⌝ vDash ⊨ varpropto ∝ " +
  "varsubsetneqq ⫋︀ varsupsetneqq ⫌︀ vartriangle △ vartriangleleft ⊲ vartriangleright ⊳ veebar ⊻ " +
  "veedot ⟇ veedoublebar ⩣ veeeq ≚ veeonvee ⩖ wedgebar ⩟ wedgedot ⟑ wedgedoublebar ⩠ wedgeonwedge ⩕ " +
  "wedgeq ≙ whitesquaretickleft ⟤ whitesquaretickright ⟥ wr ≀ ",
  big:
  "bigcupdot ⨃ bigcupplus ⨄ bigdoublevee ⨇ bigdoublewedge ⨈ bigodot ⨀ bigsqcap ⨅ bigsqcup ⨆ bigtimes ⨉ " +
  "biguplus ⨄ fint ⨏ iiiint ⨌ intBar ⨎ intbar ⨍ intcap ⨙ intclockwise ∱ intcup ⨚ intlarhk ⨗ intop ∫ " +
  "intx ⨘ oiiint ∰ oiint ∯ pointint ⨕ rppolint ⨒ scpolint ⨓ sqint ⨖ varointclockwise ∲ ",
}
// the few Temml writes with its own spacing or size, by hand: primes, dots,
// the short relations, ⅋ — the operator dictionary spaces them close enough
PACKED.o += 'cdotp · ldotp . centerdot ⋅ DOTSB ⋯ DOTSI ⋯ DOTSX … dotsx … dprime ″ trprime ‴ qprime ⁗ backprime ‵ backdprime ‶ backtrprime ‷ ' +
  'impliedby ⟸ invamp ⅋ parr ⅋ upand ⅋ with & leftmodels ⫣ multimapboth ⧟ multimapinv ⟜ notni ∌ nshortmid ∤ nshortparallel ∦ shortmid ∣ shortparallel ∥ smallsetminus ∖ '
PACKED.i += 'ordinarycolon : rq ’ '
for (const cls of ['i', 'o', 'big'] as SymClass[]) {
  const f = PACKED[cls].trim().split(' ')
  for (let k = 0; k < f.length; k += 2) SYMBOLS.push(T(f[k], '', f[k + 1], cls))
}

/** The upright function names: \sin → <mi>sin</mi>. Typst spells them the same. */
export const FUNCTIONS = ['sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'log', 'ln', 'lg', 'exp', 'det', 'dim', 'ker', 'deg', 'gcd', 'hom', 'arg', 'Pr',
  // the rest of Temml's list (#551), and the physics package's
  'coth', 'sgn', 'arcctg', 'arctg', 'cosec', 'cotg', 'ctg', 'cth', 'tg', 'th', 'sh', 'ch', 'erf', 'rank', 'Tr', 'tr', 'Res', 'lcm']
/** Function names whose scripts sit under/over in display mode. */
export const LIMIT_FUNCTIONS = ['lim', 'max', 'min', 'sup', 'inf', 'limsup', 'liminf', 'argmax', 'argmin', 'injlim', 'projlim', 'plim']
/** Names printed differently from how they are typed: \argmax is "arg max". */
export const FN_TEXT: Record<string, string> = { argmax: 'arg max', argmin: 'arg min', injlim: 'inj lim', projlim: 'proj lim', limsup: 'lim sup', liminf: 'lim inf' }

export const byTex = new Map(SYMBOLS.map((s) => [s.tex, s]))
/** a glyph typed directly (∈) → the first row that draws it, for its class */
export const byGlyph = new Map<string, Sym>()
for (const s of SYMBOLS) if (!byGlyph.has(s.cp)) byGlyph.set(s.cp, s)
export const byTypst = new Map<string, Sym>()
for (const s of SYMBOLS) if (s.typst && !byTypst.has(s.typst)) byTypst.set(s.typst, s)

// --- Mathematical Alphanumeric code points -----------------------------------
// Chrome ignores mathvariant on <mi>, so \mathbb{R} must BE the code point ℝ.
// Ranges from the Unicode block U+1D400…; the letters Unicode left out of the
// block (ℂℍℕℙℚℝℤ, ℬℰℱℋℐℒℳℛ, ℭℌℑℜℨ) live in Letterlike Symbols and are patched.
const RANGES: Record<string, [number, number, number] | null> = {
  // [upper A, lower a, digit 0] base code points; null digits = none
  bf: [0x1d400, 0x1d41a, 0x1d7ce],
  it: [0x1d434, 0x1d44e, 0],
  bb: [0x1d538, 0x1d552, 0x1d7d8],
  cal: [0x1d49c, 0x1d4b6, 0],
  scr: [0x1d49c, 0x1d4b6, 0],
  frak: [0x1d504, 0x1d51e, 0],
  sf: [0x1d5a0, 0x1d5ba, 0x1d7e2],
  sfit: [0x1d608, 0x1d622, 0],
  bfit: [0x1d468, 0x1d482, 0],
  tt: [0x1d670, 0x1d68a, 0x1d7f6],
  rm: null,
}
const HOLES: Record<string, Record<string, string>> = {
  bb: { C: 'ℂ', H: 'ℍ', N: 'ℕ', P: 'ℙ', Q: 'ℚ', R: 'ℝ', Z: 'ℤ' },
  cal: { B: 'ℬ', E: 'ℰ', F: 'ℱ', H: 'ℋ', I: 'ℐ', L: 'ℒ', M: 'ℳ', R: 'ℛ', e: 'ℯ', g: 'ℊ', o: 'ℴ' },
  scr: { B: 'ℬ', E: 'ℰ', F: 'ℱ', H: 'ℋ', I: 'ℐ', L: 'ℒ', M: 'ℳ', R: 'ℛ', e: 'ℯ', g: 'ℊ', o: 'ℴ' },
  frak: { C: 'ℭ', H: 'ℌ', I: 'ℑ', R: 'ℜ', Z: 'ℨ' },
  it: { h: 'ℎ' },
}
export function styledChar(ch: string, font: string): string {
  const r = RANGES[font]
  if (!r) return ch
  const hole = HOLES[font]?.[ch]
  if (hole) return hole
  const c = ch.charCodeAt(0)
  if (c >= 65 && c <= 90) return String.fromCodePoint(r[0] + c - 65)
  if (c >= 97 && c <= 122) return String.fromCodePoint(r[1] + c - 97)
  if (r[2] && c >= 48 && c <= 57) return String.fromCodePoint(r[2] + c - 48)
  return ch
}
