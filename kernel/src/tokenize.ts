// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// One tokenizer, a small table per language — the kernel's built-in code
// highlighting tier. A slide needs seven colours, not 400 scopes; real
// grammars (per-deck assets, see CodeElement.grammarAssetId) are the tier
// above this one, not a replacement for it. Shared by slides and spaces.
//
// CONTRACT, guarded by scripts/test-tokenize.ts:
//   - LOSSLESS: concatenating token values reproduces the source byte for
//     byte, for every language and every malformed input. Renderers rebuild
//     the text from the tokens, so a dropped character is a corrupted slide.
//   - Token values MAY contain newlines — block comments, triple-quoted
//     strings, whitespace runs. A consumer that blockifies tokens (the morph
//     needs display:inline-block to move them) MUST split at newlines first,
//     or lines collapse: a \n inside an atomic inline-level box stops
//     breaking the line under `white-space: pre`.
//   - Unknown language ids fall back to js rules; unterminated strings and
//     comments run to end of input rather than throwing.
type Lang = { ci?: 1; line?: string | string[]; block?: [string, string]; str: string; kw: string; tri?: string }

export const LANGS: Record<string, Lang> = {
  js: { line: '//', block: ['/*', '*/'], str: `'"\``, kw: 'const let var function return if else for while do switch case break continue class extends new this typeof instanceof in of await async import export from default try catch finally throw yield delete void null undefined true false' },
  ts: { line: '//', block: ['/*', '*/'], str: `'"\``, kw: 'const let var function return if else for while do switch case break continue class extends implements interface type enum new this typeof instanceof in of await async import export from default try catch finally throw yield delete void null undefined true false public private protected readonly as satisfies keyof infer' },
  py: { line: '#', tri: `'''"""`, str: `'"`, kw: 'def class return if elif else for while break continue import from as with try except finally raise lambda yield global nonlocal pass assert del in is not and or None True False async await match case' },
  rust: { line: '//', block: ['/*', '*/'], str: '"', kw: 'fn let mut const static struct enum trait impl for while loop if else match return break continue use mod pub crate self super where as in ref move dyn unsafe async await type true false Some None Ok Err' },
  go: { line: '//', block: ['/*', '*/'], str: '"`', kw: 'func var const type struct interface map chan package import return if else for range switch case default break continue go defer select nil true false make new len cap append' },
  java: { line: '//', block: ['/*', '*/'], str: '"', kw: 'public private protected class interface extends implements static final void int long double float boolean char String new return if else for while do switch case break continue try catch finally throw throws import package this super null true false' },
  sh: { line: '#', str: `'"`, kw: 'if then elif else fi for while do done case esac function return local export source echo cd set unset trap exit' },
  sql: { ci: 1, line: '--', block: ['/*', '*/'], str: `'"`, kw: 'select from where group by having order limit offset insert into values update set delete create table drop alter add index join left right inner outer on as and or not null distinct union all count sum avg min max' },
  c: { line: "//", block: ["/*", "*/"], str: "\"'", kw: "auto break case char const continue default do double else enum extern float for goto if int long register return short signed sizeof static struct switch typedef union unsigned void volatile while NULL true false" },
  cpp: { line: "//", block: ["/*", "*/"], str: "\"'", kw: "auto bool break case catch char class const constexpr continue default delete do double else enum explicit extern false float for friend goto if inline int long mutable namespace new nullptr operator private protected public return short signed sizeof static struct switch template this throw true try typedef typename union unsigned using virtual void volatile while" },
  csharp: { line: "//", block: ["/*", "*/"], str: "\"'", kw: "abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach get if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sealed set short sizeof static string struct switch this throw true try typeof uint ulong ushort using var virtual void volatile while async await yield record" },
  kotlin: { line: "//", block: ["/*", "*/"], str: "\"", kw: "as break class continue do else false for fun if in interface is null object package return super this throw true try typealias val var when while by catch constructor finally get import init set abstract actual annotation companion const crossinline data enum expect external final infix inline inner internal lateinit noinline open operator out override private protected public reified sealed suspend tailrec vararg" },
  swift: { line: "//", block: ["/*", "*/"], str: "\"", kw: "associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private protocol public rethrows static struct subscript typealias var break case continue default defer do else fallthrough for guard if in repeat return switch where while as catch false is nil super self throw throws true try Any" },
  scala: { line: "//", block: ["/*", "*/"], str: "\"", kw: "abstract case catch class def do else extends false final finally for if implicit import lazy match new null object override package private protected return sealed super this throw trait try true type val var while with yield given using enum" },
  dart: { line: "//", block: ["/*", "*/"], str: "\"'", kw: "abstract as assert async await break case catch class const continue covariant default deferred do dynamic else enum export extends extension external factory false final finally for get hide if implements import in interface is late library mixin new null on operator part required rethrow return set show static super switch sync this throw true try typedef var void while with yield" },
  zig: { line: "//", str: "\"", kw: "const var fn pub return if else while for switch struct enum union error try catch defer errdefer comptime inline export extern test orelse unreachable break continue and or align anytype null true false undefined" },
  php: { line: ["//", "#"], block: ["/*", "*/"], str: "\"'", kw: "abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enum extends final finally fn for foreach function global goto if implements include instanceof interface isset list match namespace new or print private protected public readonly require return static switch throw trait try unset use var while xor yield true false null" },
  ruby: { line: "#", block: ["=begin", "=end"], str: "\"'`", kw: "alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield attr_accessor attr_reader require puts lambda proc" },
  perl: { line: "#", str: "\"'`", kw: "my our local sub if elsif else unless while until for foreach do last next redo return use require package no BEGIN END and or not eq ne lt gt le ge cmp print printf say die warn defined undef ref bless" },
  lua: { line: "--", block: ["--[[", "]]"], str: "\"'", kw: "and break do else elseif end false for function goto if in local nil not or repeat return then true until while self" },
  r: { line: "#", str: "\"'", kw: "if else repeat while function for in next break TRUE FALSE NULL Inf NaN NA library require return invisible" },
  julia: { line: "#", block: ["#=", "=#"], str: "\"", kw: "baremodule begin break catch const continue do else elseif end export false finally for function global if import let local macro module mutable primitive quote return struct true try type using while abstract in isa where" },
  powershell: { line: "#", block: ["<#", "#>"], str: "\"'", kw: "begin break catch continue data do dynamicparam else elseif end exit filter finally for foreach from function if in param process return switch throw trap try until using while class enum hidden static" },
  haskell: { line: "--", block: ["{-", "-}"], str: "\"", kw: "case class data default deriving do else foreign if import in infix infixl infixr instance let module newtype of then type where forall" },
  elixir: { line: "#", str: "\"'", kw: "after and case catch cond def defmacro defmodule defp defstruct do else end fn for if import in nil not or quote raise receive require rescue try unless unquote use when true false alias with" },
  erlang: { line: "%", str: "\"'", kw: "after and andalso band begin bnot bor bsl bsr bxor case catch cond div end fun if let not of or orelse receive rem try when xor module export import" },
  clojure: { line: ";", str: "\"", kw: "def defn defmacro defrecord defprotocol let fn if when cond case do loop recur quote var ns require import use try catch finally throw new true false nil and or not" },
  ocaml: { block: ["(*", "*)"], str: "\"", kw: "and as assert begin class constraint do done downto else end exception external false for fun function functor if in include inherit initializer land lazy let lor lsl lsr lxor match method mod module mutable new nonrec object of open or private rec sig struct then to true try type val virtual when while with" },
  fsharp: { line: "//", block: ["(*", "*)"], str: "\"", kw: "abstract and as assert base begin class default delegate do done downcast downto elif else end exception extern false finally for fun function global if in inherit inline interface internal lazy let match member module mutable namespace new not null of open or override private public rec return static struct then to true try type use val void when while with yield" },
  json: { str: "\"", kw: "true false null" },
  yaml: { line: "#", str: "\"'", kw: "true false null yes no on off" },
  toml: { line: "#", str: "\"'", kw: "true false" },
  ini: { line: [";", "#"], str: "\"'", kw: "true false yes no on off" },
  xml: { block: ["<!--", "-->"], str: "\"'", kw: "" },
  html: { block: ["<!--", "-->"], str: "\"'", kw: "html head body div span a img script style link meta title p ul ol li table tr td th form input button label section article header footer nav" },
  css: { block: ["/*", "*/"], str: "\"'", kw: "important media supports keyframes import charset font-face color background display position width height margin padding border flex grid" },
  graphql: { line: "#", str: "\"", kw: "query mutation subscription fragment on type interface union enum input scalar schema extend implements directive true false null" },
  proto: { line: "//", block: ["/*", "*/"], str: "\"'", kw: "syntax package import option message enum service rpc returns repeated optional required reserved oneof map extend true false int32 int64 uint32 uint64 string bool bytes double float" },
  dockerfile: { line: "#", str: "\"'", kw: "FROM RUN CMD LABEL EXPOSE ENV ADD COPY ENTRYPOINT VOLUME USER WORKDIR ARG ONBUILD STOPSIGNAL HEALTHCHECK SHELL AS" },
  makefile: { line: "#", str: "\"'`", kw: "ifeq ifneq ifdef ifndef else endif include define endef export unexport override vpath" },
  asm: { line: ";", str: "\"'", kw: "mov push pop call ret jmp je jne jz jnz add sub mul div inc dec cmp test lea nop int section global extern db dw dd dq byte word dword qword" },
  elm: { line: "--", block: ["{-", "-}"], str: "\"", kw: "module exposing import type alias port let in if then else case of as infix where" },
  nim: { line: "#", block: ["#[", "]#"], str: "\"", kw: "proc func method iterator template macro type const let var if elif else case of while for in return yield discard import export from include object ref ptr enum tuple distinct converter static when defer block break continue raise try except finally echo nil true false" },
  crystal: { line: "#", str: "\"'", kw: "def class module struct enum union lib fun macro if elsif else unless case when then while until do begin rescue ensure return yield next break require include extend property getter setter nil true false self super abstract private protected" },
  solidity: { line: "//", block: ["/*", "*/"], str: "\"'", kw: "pragma solidity contract interface library function modifier event struct enum mapping address uint uint256 int bool string bytes memory storage calldata public private internal external pure view payable returns return if else for while do break continue emit require revert assert new delete constructor receive fallback immutable constant override virtual" },
  hcl: { line: ["#", "//"], block: ["/*", "*/"], str: "\"", kw: "resource provider variable output module data locals terraform for_each count depends_on lifecycle dynamic true false null var local" },
  nix: { line: "#", block: ["/*", "*/"], str: "\"'", kw: "let in rec with inherit if then else assert import derivation builtins true false null or" },
  matlab: { line: "%", block: ["%{", "%}"], str: "\"'", kw: "function end if elseif else switch case otherwise for while break continue return try catch global persistent classdef properties methods events arguments true false" },
  fortran: { line: "!", str: "\"'", kw: "program module subroutine function end if then else elseif do while select case type implicit none integer real complex logical character dimension parameter intent in out inout allocatable pointer call return contains use only public private interface", ci: 1 },
  pascal: { line: "//", block: ["{", "}"], str: "\"'", kw: "program unit interface implementation uses type var const procedure function begin end if then else case of while do repeat until for to downto record array set file class object constructor destructor inherited nil true false and or not div mod", ci: 1 },
  groovy: { line: "//", block: ["/*", "*/"], str: "\"'", kw: "def class interface trait enum extends implements import package if else for while switch case break continue return try catch finally throw throws new this super static final public private protected abstract synchronized null true false as in it" },
  verilog: { line: "//", block: ["/*", "*/"], str: "\"", kw: "module endmodule input output inout wire reg parameter localparam always assign begin end if else case endcase for while function endfunction task endtask posedge negedge initial generate endgenerate genvar integer logic bit" },
  vhdl: { line: "--", str: "\"", kw: "entity architecture is begin end port map signal variable constant process if then elsif else case when others for loop while type subtype array record function procedure return library use downto to std_logic", ci: 1 },
  latex: { line: "%", str: "", kw: "begin end documentclass usepackage section subsection subsubsection chapter item label ref cite includegraphics textbf textit emph frac sum int newcommand renewcommand" },
  objc: { line: "//", block: ["/*", "*/"], str: "\"", kw: "interface implementation property synthesize end class protocol selector id self super nil YES NO void int char float double BOOL if else for while return switch case break continue typedef struct enum static const import include" },
  scheme: { line: ";", block: ["#|", "|#"], str: "\"", kw: "define lambda let let* letrec if cond else case when unless do begin set! quote quasiquote unquote and or not null? car cdr cons list map for-each apply display newline" },
  lisp: { line: ";", block: ["#|", "|#"], str: "\"", kw: "defun defvar defparameter defmacro let let* if cond case when unless loop do dolist dotimes lambda setq setf progn quote function nil t car cdr cons list append mapcar format" },
  prolog: { line: "%", block: ["/*", "*/"], str: "\"'", kw: "is not fail true false assert asserta assertz retract findall bagof setof forall between member append length nth0 nth1 writeln write nl halt dynamic discontiguous module use_module" },
  ada: { line: "--", str: "\"", kw: "package body procedure function is begin end if then elsif else case when loop for while exit return declare type subtype record array access constant renames with use new others null range in out", ci: 1 },
  d: { line: "//", block: ["/*", "*/"], str: "\"'`", kw: "module import class struct interface union enum template mixin alias auto const immutable shared static final abstract override public private protected package if else for foreach while do switch case default break continue return try catch finally throw new delete cast is in out ref scope pure nothrow safe true false null this super" },
  gleam: { line: "//", str: "\"", kw: "import pub fn type const let case if else use assert todo panic opaque as external" },
  batch: { line: ["REM", "::"], str: "\"", kw: "echo set setlocal endlocal if else for in do goto call exit rem shift pause cls copy move del dir mkdir rmdir type findstr errorlevel not exist defined", ci: 1 },
  awk: { line: "#", str: "\"'", kw: "BEGIN END function if else while for do break continue next exit return print printf getline delete in length substr index split sub gsub match sprintf system NR NF FS OFS RS ORS" },
  tcl: { line: "#", str: "\"", kw: "proc set unset if elseif else switch while for foreach break continue return global variable namespace package require source expr incr append lappend lindex llength string list array dict catch error puts" },
  vb: { line: "'", str: "\"", kw: "Dim As Public Private Protected Friend Shared Sub Function End If Then Else ElseIf Select Case For Each Next While Do Loop Until Return Class Module Structure Interface Property Get Set New Nothing True False And Or Not Is Try Catch Finally Throw Imports Namespace Overrides", ci: 1 },
  scss: { line: "//", block: ["/*", "*/"], str: "\"'", kw: "import use forward mixin include extend function return if else each for while media supports keyframes true false null not and or" },
  nginx: { line: "#", str: "\"'", kw: "server location listen server_name root index proxy_pass upstream include error_page access_log error_log ssl_certificate ssl_certificate_key return rewrite if set add_header gzip on off" },
  jinja: { block: ["{#", "#}"], str: "\"'", kw: "if elif else endif for endfor block endblock extends include import macro endmacro set with endwith raw endraw filter endfilter true false none and or not in is" },
  sparql: { line: "#", str: "\"'", kw: "SELECT CONSTRUCT ASK DESCRIBE WHERE FROM PREFIX BASE ORDER BY LIMIT OFFSET DISTINCT REDUCED OPTIONAL UNION FILTER GRAPH BIND VALUES GROUP HAVING a", ci: 1 },
  cypher: { line: "//", block: ["/*", "*/"], str: "\"'", kw: "MATCH OPTIONAL WHERE RETURN CREATE MERGE DELETE DETACH SET REMOVE WITH UNWIND ORDER BY SKIP LIMIT UNION CALL YIELD AS DISTINCT AND OR NOT IN STARTS ENDS CONTAINS NULL TRUE FALSE", ci: 1 },
  fish: { line: "#", str: "\"'", kw: "function end if else if else end switch case for in while begin and or not set setenv echo test return source exit" },
  apex: { line: "//", block: ["/*", "*/"], str: "\"'", kw: "public private protected global static final abstract virtual override class interface extends implements enum trigger on before after insert update delete undelete if else for while do switch when try catch finally throw new return this super null true false System Database SOQL", ci: 1 },
  purescript: { line: "--", block: ["{-", "-}"], str: "\"", kw: "module where import data newtype type class instance derive let in if then else case of do ado forall infixl infixr foreign" },
  odin: { line: "//", block: ["/*", "*/"], str: "\"'`", kw: "package import foreign using proc struct union enum bit_set map matrix distinct if else for switch case break continue fallthrough return defer when in not_in do or_else or_return cast transmute auto_cast size_of align_of type_of nil true false" },
  zsh: { line: "#", str: "\"'`", kw: "if then elif else fi for while until do done case esac function return local export source setopt unsetopt autoload zstyle typeset declare integer readonly alias unalias" },
}

export type Tok = { t: 'c' | 's' | 'n' | 'k' | 'f' | 'p' | 'x' | 'a' | 'd'; v: string }

const W = /[A-Za-z_$]/, WD = /[\w$]/, D = /[0-9]/

export function tokenize(src: string, langId: string): Tok[] {
  if (langId === 'diff' || langId === 'patch') return tokenizeLines(src, false)
  if (langId === 'md' || langId === 'markdown') return tokenizeLines(src, true)
  const L = LANGS[langId] ?? LANGS.js
  const kw = new Set((L.ci ? L.kw.toLowerCase() : L.kw).split(' '))
  const out: Tok[] = []
  const push = (t: Tok['t'], v: string) => { if (v) out.push({ t, v }) }
  let i = 0
  while (i < src.length) {
    const c = src[i]
    // whitespace / newlines ride along as plain
    if (c === '\n' || c === ' ' || c === '\t') { let j = i; while (j < src.length && /[ \t\n]/.test(src[j])) j++; push('x', src.slice(i, j)); i = j; continue }
    // line comment
    const lm = L.line ? (Array.isArray(L.line) ? L.line : [L.line]) : []
    if (lm.some((m) => src.startsWith(m, i))) { const j = src.indexOf('\n', i); const e = j < 0 ? src.length : j; push('c', src.slice(i, e)); i = e; continue }
    // block comment
    if (L.block && src.startsWith(L.block[0], i)) { const j = src.indexOf(L.block[1], i + 2); const e = j < 0 ? src.length : j + L.block[1].length; push('c', src.slice(i, e)); i = e; continue }
    // triple-quoted (python docstrings) before plain strings
    if (L.tri) { const t3 = [`'''`, `"""`].find((q) => src.startsWith(q, i)); if (t3) { const j = src.indexOf(t3, i + 3); const e = j < 0 ? src.length : j + 3; push('s', src.slice(i, e)); i = e; continue } }
    // string, with escapes
    if (L.str.includes(c)) { let j = i + 1; while (j < src.length) { if (src[j] === '\\') { j += 2; continue } if (src[j] === c) { j++; break } j++ } push('s', src.slice(i, j)); i = j; continue }
    // number
    if (D.test(c)) { let j = i; while (j < src.length && /[0-9a-fA-FxXoObB._]/.test(src[j])) j++; push('n', src.slice(i, j)); i = j; continue }
    // word: keyword, or call, or plain identifier
    if (W.test(c)) {
      let j = i; while (j < src.length && WD.test(src[j])) j++
      const w = src.slice(i, j)
      let k = j; while (k < src.length && src[k] === ' ') k++
      push(kw.has(L.ci ? w.toLowerCase() : w) ? 'k' : src[k] === '(' ? 'f' : 'x', w)
      i = j; continue
    }
    // punctuation / operators
    let j = i; while (j < src.length && /[^\w\s$]/.test(src[j]) && !lm.some((m) => src.startsWith(m, j)) && !(L.block && src.startsWith(L.block[0], j)) && !L.str.includes(src[j])) j++
    if (j === i) j++
    push('p', src.slice(i, j)); i = j
  }
  return out
}

/**
 * Line-prefix formats. A token stream cannot express these: what a line MEANS
 * depends on how it starts, not on which characters are in it. Two of them are
 * worth the bytes — a patch and a README are both things people put on slides.
 */
function tokenizeLines(src: string, md: boolean): Tok[] {
  const out: Tok[] = []
  const push = (t: Tok['t'], v: string) => { if (v) out.push({ t, v }) }
  let fence = false
  for (const raw of src.split('\n')) {
    const line = raw + '\n'
    if (!md) {
      // unified diff
      if (line.startsWith('@@')) push('k', line)
      else if (/^(diff |index |--- |\+\+\+ |new file|deleted file|similarity |rename )/.test(line)) push('c', line)
      else if (line.startsWith('+')) push('a', line)
      else if (line.startsWith('-')) push('d', line)
      else push('x', line)
      continue
    }
    // markdown
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; push('k', line); continue }
    if (fence) { push('x', line); continue }
    if (/^#{1,6}\s/.test(line)) { push('k', line); continue }
    if (/^\s*>/.test(line)) { push('c', line); continue }
    const m = line.match(/^(\s*(?:[-*+]|\d+[.)])\s+)/)
    if (m) { push('p', m[1]); inline(line.slice(m[1].length), push); continue }
    if (/^\s*(-{3,}|={3,})\s*$/.test(line)) { push('k', line); continue }
    inline(line, push)
  }
  return out
}

/** Inline markdown: code, emphasis, links. Everything else is prose. */
function inline(text: string, push: (t: Tok['t'], v: string) => void) {
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*\n]+\*|_[^_\n]+_)|(\[[^\]]*\]\([^)]*\))/g
  let last = 0, m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    push('x', text.slice(last, m.index))
    if (m[1]) push('s', m[1])
    else if (m[2]) push('k', m[2])
    else if (m[3]) push('f', m[3])
    else push('n', m[4])
    last = m.index + m[0].length
  }
  push('x', text.slice(last))
}
