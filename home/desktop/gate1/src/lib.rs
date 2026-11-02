// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// GATE 1 for the desktop host: is this file's runtime a genuine Bento release?
// (bento/connect K5, security §13–§18, §36 and the 2026-10-21 grammar ruling.)
//
// A PORT of kernel/src/gate1.ts, the reference. It is held to the conformance
// corpus in home/fixtures/gate1/ (tests/corpus.rs): a row this port reads
// differently is a finding for kernel and security, never something to "fix"
// on one side alone.
//
// Port notes, where Rust and JavaScript could differ:
// - Offsets are BYTES of UTF-8; the reference's are UTF-16 units. Every search
//   is for ASCII, and case is folded for ASCII only (as the reference's
//   asciiLower does), which never changes a length, so the offsets agree.
// - The tag-name window is 256 UTF-16 units, as in the reference; see
//   parse_start_tag for the one place a surrogate pair could split there.
// - `\s` in the <meta http-equiv> rule is JavaScript's set (js_space).
// - The input must be UTF-8; anything else is UNKNOWN.
//
// examples/probe.rs prints this port's verdict for any file against the
// corpus history, for comparing a suspect file with the reference.

use base64::{engine::general_purpose::STANDARD as B64, engine::general_purpose::URL_SAFE_NO_PAD as B64URL, Engine};
use p256::ecdsa::{signature::Verifier, Signature, VerifyingKey};
use serde_json::Value;
use sha2::{Digest, Sha256};

// --- small helpers mirroring JavaScript ------------------------------------------

/// JavaScript's `\s`: WhiteSpace and LineTerminator (ECMA-262 §22.2.2.9).
pub fn js_space(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}')
}

fn char_at(s: &str, i: usize) -> Option<char> {
    s.get(i..).and_then(|t| t.chars().next())
}


fn skip_space(s: &str, mut i: usize) -> usize {
    while let Some(c) = char_at(s, i) {
        if !js_space(c) { break }
        i += c.len_utf8();
    }
    i
}

fn starts_ci(s: &str, i: usize, needle: &str) -> bool {
    s.as_bytes().get(i..i + needle.len()).is_some_and(|b| b.eq_ignore_ascii_case(needle.as_bytes()))
}

fn find_from(h: &str, needle: &str, from: usize) -> Option<usize> {
    h.get(from..)?.find(needle).map(|k| k + from)
}

/// sha256 HEX of a string's UTF-8 bytes: the encoding of every `blocks` pin.
pub fn sha256hex(s: &str) -> String {
    Sha256::digest(s.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// 'sha256-' + BASE64: the CSP encoding of every `scriptSrc` pin. Never compare it to a hex pin.
pub fn csp_hash(s: &str) -> String {
    format!("sha256-{}", B64.encode(Sha256::digest(s.as_bytes())))
}

// --- the scanner ---------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct Block<'a> {
    pub tag: &'static str,
    pub attrs: &'a str,
    /// the raw text, ending at the first `</script` / `</style` in any case
    pub text: &'a str,
    /// offset of the start tag's "<"
    pub tag_start: usize,
    /// offset of the text's first character
    pub start: usize,
    /// offset just past the end tag's ">", as the tokenizer ends it
    pub end: usize,
    pub type_: Option<String>,
    pub id: Option<String>,
    pub src: Option<String>,
    pub preview: bool,
    /// the start tag repeats an attribute name, or uses "/" between attributes (Bento writes neither)
    pub duplicate: bool,
    pub slash: bool,
}

/// The HTML tokenizer's whitespace between attributes: tab, LF, FF, CR, space.
fn html_ws(b: u8) -> bool {
    matches!(b, b'\t' | b'\n' | 0x0C | b'\r' | b' ')
}

/// ASCII-only case fold: the HTML spec's, and LENGTH-PRESERVING (the reference's asciiLower).
pub fn ascii_lower(s: &str) -> String {
    s.to_ascii_lowercase()
}

/// A start tag's attributes, read the way the HTML tokenizer reads them.
#[derive(Debug, Clone)]
pub struct StartTag {
    pub name: String,
    /// in source order; the FIRST of duplicate names wins
    pub attrs: Vec<(String, String)>,
    pub duplicate: bool,
    pub slash: bool,
    /// the offset just past the closing '>'
    pub end: usize,
}

impl StartTag {
    pub fn get(&self, n: &str) -> Option<&str> {
        self.attrs.iter().find(|(k, _)| k == n).map(|(_, v)| v.as_str())
    }
}

/// The reference's parseStartTag(). Whitespace OR "/" separates attributes; a
/// quoted value ends one even with no separator after it; a leading "=" is part
/// of a name; names fold ASCII case and NUL becomes U+FFFD; the first duplicate
/// wins. None: not a start tag, or unterminated.
///
/// The tag name is `^([a-zA-Z][^\t\n\f\r />]*)` over 256 UTF-16 units from its first character (read_tag).
/// The port stops the name at the last WHOLE character inside the window; the
/// reference can split a surrogate pair there. Either way the remainder is read
/// as an attribute name starting with a non-ASCII character, which no rule
/// matches, so the verdict is the same.
pub fn parse_start_tag(html: &str, i: usize) -> Option<StartTag> {
    if html.as_bytes().get(i) != Some(&b'<') { return None }
    read_tag(html, i + 1)
}

/// An END tag, read exactly like a start tag: the tokenizer parses attributes
/// in end tags too, quoted values included, so `</p a="><b c='">` ends at its
/// SECOND ">". None if `i` isn't "</" and a letter, or it's unterminated.
pub fn parse_end_tag(html: &str, i: usize) -> Option<StartTag> {
    let b = html.as_bytes();
    if b.get(i) != Some(&b'<') || b.get(i + 1) != Some(&b'/') { return None }
    read_tag(html, i + 2)
}

/// A tag's name and attributes, from its name's first character (the
/// reference's readTag; the name window is 256 UTF-16 units from `at`).
fn read_tag(html: &str, at: usize) -> Option<StartTag> {
    let b = html.as_bytes();
    if !b.get(at).is_some_and(|c| c.is_ascii_alphabetic()) { return None }
    let mut units = 0usize;
    let mut j = at;
    for c in html[at..].chars() {
        if matches!(c, '\t' | '\n' | '\u{0C}' | '\r' | ' ' | '/' | '>') { break }
        if units + c.len_utf16() > 256 { break }
        units += c.len_utf16();
        j += c.len_utf8();
    }
    let name = ascii_lower(&html[at..j]);
    let (mut attrs, mut duplicate, mut slash): (Vec<(String, String)>, bool, bool) = (vec![], false, false);
    while j < b.len() {
        let c = b[j];
        if html_ws(c) { j += 1; continue }
        if c == b'/' { slash = true; j += 1; continue }
        if c == b'>' { return Some(StartTag { name, attrs, duplicate, slash, end: j + 1 }) }
        // the name: a leading "=" is part of it; it ends at whitespace, "/", ">" or "="
        let mut k = j;
        if b[k] == b'=' { k += 1 }
        while k < b.len() && !html_ws(b[k]) && b[k] != b'/' && b[k] != b'>' && b[k] != b'=' { k += 1 }
        let aname = ascii_lower(&html[j..k]).replace('\0', "\u{FFFD}");
        let mut value = String::new();
        let mut p = k;
        while p < b.len() && html_ws(b[p]) { p += 1 }
        if b.get(p) == Some(&b'=') {
            p += 1;
            while p < b.len() && html_ws(b[p]) { p += 1 }
            match b.get(p) {
                Some(&q @ (b'"' | b'\'')) => {
                    let close = find_from(html, if q == b'"' { "\"" } else { "'" }, p + 1)?;
                    value = html[p + 1..close].to_string();
                    k = close + 1;
                }
                _ => {
                    let mut e = p;
                    while e < b.len() && !html_ws(b[e]) && b[e] != b'>' { e += 1 }
                    value = html[p..e].to_string();
                    k = e;
                }
            }
        }
        if attrs.iter().any(|(n, _)| *n == aname) { duplicate = true } else { attrs.push((aname, value)) }
        j = k;
    }
    None // unterminated
}

/// Elements whose content is TEXT to a browser, never tags, up to their real end tag.
const RAW_TEXT: [&str; 4] = ["script", "style", "textarea", "title"];

/// `^[a-z][a-z0-9-]*$`: the only tag names Bento writes.
fn plain_tag_name(n: &str) -> bool {
    let b = n.as_bytes();
    !b.is_empty() && b[0].is_ascii_lowercase() && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// Where a raw-text element really ends: "</name" followed by whitespace, "/",
/// ">" or the end of the file. "</scriptx>" is text, not its end.
fn raw_text_end(lower: &str, name: &str, from: usize) -> Option<usize> {
    let needle = format!("</{name}");
    let mut at = from;
    while let Some(k) = find_from(lower, &needle, at) {
        match lower.as_bytes().get(k + needle.len()) {
            None => return Some(k),
            Some(&c) if html_ws(c) || c == b'/' || c == b'>' => return Some(k),
            _ => at = k + 2,
        }
    }
    None
}

/// ONE walk over the file in document order, tag by tag, as a browser's
/// tokenizer meets them (the reference's walk()). Blocks and markup problems
/// come from the same reading, so a "<style" inside another tag's name (a tag a
/// browser reads as "meta<style") can never be taken for a style element.
fn walk(html: &str) -> (Vec<Block<'_>>, Vec<String>) {
    let (mut blocks, mut problems) = (vec![], vec![]);
    let lower = ascii_lower(html);
    let b = html.as_bytes();
    let mut i = 0;
    while let Some(at) = find_from(html, "<", i) {
        i = at;
        if html[i..].starts_with("<!--") {
            // "<!-->" and "<!--->" are whole (empty) comments to a browser
            if html[i..].starts_with("<!-->") { i += 5; continue }
            if html[i..].starts_with("<!--->") { i += 6; continue }
            let end = find_from(html, "-->", i + 4);
            if lower[i + 4..end.unwrap_or(html.len())].contains("<script") { problems.push("a comment holds a <script>".into()) }
            let Some(end) = end else { problems.push("an unterminated comment".into()); break };
            i = end + 3;
            continue;
        }
        if b.get(i + 1) == Some(&b'/') && b.get(i + 2).is_some_and(|c| c.is_ascii_alphabetic()) {
            // an end tag: tokenized with the start tag's attribute rules (see parse_end_tag)
            let Some(et) = parse_end_tag(html, i) else { problems.push("an unterminated end tag".into()); break };
            if !plain_tag_name(&et.name) { problems.push(format!("an end tag named {}", serde_json::to_string(&et.name).unwrap_or_default())) }
            // a browser drops them, but they move where the tag ends: Bento writes none
            if !et.attrs.is_empty() { problems.push(format!("an end tag </{}> carrying attributes", et.name)) }
            i = et.end;
            continue;
        }
        if html[i..].starts_with("</>") { i += 3; continue } // ignored entirely
        if matches!(b.get(i + 1), Some(b'/' | b'!' | b'?')) {
            // a doctype or a bogus comment: it ends at the first ">", quotes or not
            let Some(end) = find_from(html, ">", i + 2) else { problems.push("an unterminated tag".into()); break };
            i = end + 1;
            continue;
        }
        if !b.get(i + 1).is_some_and(|c| c.is_ascii_alphabetic()) { i += 1; continue } // a "<" that starts no tag is text
        let Some(tag) = parse_start_tag(html, i) else { problems.push("an unterminated start tag".into()); break };
        let name = tag.name.clone();
        if !plain_tag_name(&name) { problems.push(format!("a start tag named {}", serde_json::to_string(&name).unwrap_or_default())) }
        if ["iframe", "object", "embed", "base"].contains(&name.as_str()) { problems.push(format!("a <{name}>")) }
        if name == "meta" && tag.get("http-equiv").is_some_and(meta_kind) { problems.push("a <meta> refresh or CSP".into()) }
        if tag.attrs.iter().any(|(n, _)| n.starts_with("on")) { problems.push(format!("an on*= attribute on <{name}>")) }
        if name == "script" && (tag.duplicate || tag.slash) {
            problems.push(format!("a <script> start tag with a {} (Bento writes neither)", if tag.duplicate { "duplicate attribute" } else { "\"/\" between attributes" }));
        }
        if let Some(raw) = RAW_TEXT.iter().find(|r| **r == name) {
            let Some(close) = raw_text_end(&lower, raw, tag.end) else { problems.push(format!("an unterminated <{name}>")); break };
            if *raw != "script" && lower[tag.end..close].contains("<script") { problems.push(format!("a <{name}> holds a <script>")) }
            if *raw == "script" || *raw == "style" {
                let Some(et) = parse_end_tag(html, close) else { problems.push(format!("an unterminated </{name}>")); break };
                let tagname: &'static str = if *raw == "script" { "script" } else { "style" };
                blocks.push(Block {
                    tag: tagname,
                    attrs: &html[i..tag.end],
                    text: &html[tag.end..close],
                    tag_start: i,
                    start: tag.end,
                    end: et.end,
                    type_: tag.get("type").map(str::to_string),
                    id: tag.get("id").map(str::to_string),
                    src: tag.get("src").map(str::to_string),
                    preview: tag.get("data-bento-preview").is_some(),
                    duplicate: tag.duplicate,
                    slash: tag.slash,
                });
            }
            i = close; // its end tag is judged next, as an end tag
            continue;
        }
        i = tag.end;
    }
    (blocks, problems)
}

/// Every <script> and <style> element in the file, with its raw text, in document order.
pub fn scan_blocks(html: &str) -> Vec<Block<'_>> {
    walk(html).0
}

// --- the grammar (security, 2026-10-21) ------------------------------------------

pub const DATA_TYPES: [&str; 4] = ["application/bento+json", "application/bento+lang", "bento/deflate-b64", "bento/deflate-b86"];

/// A <script> is inert ONLY if its type is exactly one of Bento's data types and it has no src.
pub fn is_data_script(b: &Block) -> bool {
    b.tag == "script" && b.src.is_none() && b.type_.as_deref().is_some_and(|t| DATA_TYPES.contains(&t))
}

/// Every script that isn't one of Bento's data blocks.
pub fn executable_scripts<'a, 'b>(blocks: &'b [Block<'a>]) -> Vec<&'b Block<'a>> {
    blocks.iter().filter(|b| b.tag == "script" && !is_data_script(b)).collect()
}

/// `/^\s*(refresh|content-security-policy)\s*$/i`, with JavaScript's `\s`.
fn meta_kind(v: &str) -> bool {
    let t = v.trim_matches(js_space).to_ascii_lowercase();
    t == "refresh" || t == "content-security-policy"
}

/// Markup a genuine Bento file never carries, outside a script or style element's own text.
/// Returns the problems; empty = none.
pub fn markup_problems(html: &str) -> Vec<String> {
    let (blocks, mut problems) = walk(html);
    for bl in blocks.iter().filter(|b| is_data_script(b) && b.text.contains('<')) {
        problems.push(format!("the {} block contains \"<\"", bl.type_.as_deref().unwrap_or("")));
    }
    problems
}

// --- pins and the release history -------------------------------------------------

#[derive(Debug, Clone)]
pub struct Pins {
    pub rt: Option<String>,
    pub rt_css: Option<String>,
    pub loader: Option<String>,
    pub remover: Option<String>,
    pub script_src: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct Entry {
    pub version: String,
    pub pins: Pins,
    /// the entry exactly as signed, for anti-rollback's "never changes an entry"
    pub raw: Value,
}

#[derive(Debug, Clone)]
pub struct History {
    pub raw: Value,
}

fn pin_str(blocks: &Value, k: &str) -> Option<String> {
    blocks.get(k).and_then(|v| v.as_str()).map(str::to_string)
}

impl Entry {
    fn from(v: &Value) -> Entry {
        let pins = &v["pins"];
        let blocks = &pins["blocks"];
        Entry {
            version: v["version"].as_str().unwrap_or("").to_string(),
            pins: Pins {
                rt: pin_str(blocks, "bento-rt"),
                rt_css: pin_str(blocks, "bento-rt-css"),
                loader: pin_str(blocks, "loader"),
                remover: pin_str(blocks, "remover"),
                script_src: pins["scriptSrc"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default(),
            },
            raw: v.clone(),
        }
    }
}

impl History {
    pub fn from_value(v: Value) -> History {
        History { raw: v }
    }
    pub fn app(&self) -> Option<&str> {
        self.raw.get("app").and_then(|a| a.as_str())
    }
    pub fn entries(&self) -> Vec<Entry> {
        self.raw.get("releases").and_then(|r| r.as_array()).map(|a| a.iter().map(Entry::from).collect()).unwrap_or_default()
    }

    /// The signed envelope `{ payload, sig }`: ECDSA P-256 SHA-256, P1363 r‖s,
    /// standard base64, over the payload string's UTF-8 bytes. `jwk_x`/`jwk_y`
    /// are the public key's base64url coordinates.
    pub fn from_signed(envelope: &str, jwk_x: &str, jwk_y: &str) -> Result<History, String> {
        let env: Value = serde_json::from_str(envelope).map_err(|e| e.to_string())?;
        let payload = env["payload"].as_str().ok_or("history: no payload")?;
        let sig = B64.decode(env["sig"].as_str().ok_or("history: no sig")?).map_err(|e| e.to_string())?;
        let mut sec1 = vec![4u8];
        sec1.extend(B64URL.decode(jwk_x).map_err(|e| e.to_string())?);
        sec1.extend(B64URL.decode(jwk_y).map_err(|e| e.to_string())?);
        let key = VerifyingKey::from_sec1_bytes(&sec1).map_err(|e| e.to_string())?;
        let sig = Signature::from_slice(&sig).map_err(|e| e.to_string())?;
        key.verify(payload.as_bytes(), &sig).map_err(|_| "history: signature INVALID".to_string())?;
        Ok(History::from_value(serde_json::from_str(payload).map_err(|e| e.to_string())?))
    }
}

/// `^(\d+)\.(\d+)\.(\d+)$`, ASCII digits, compared as JavaScript Numbers.
fn semver(s: &str) -> Option<[f64; 3]> {
    let parts: Vec<&str> = s.split('.').collect();
    if parts.len() != 3 || parts.iter().any(|p| p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit())) { return None }
    Some([parts[0].parse().ok()?, parts[1].parse().ok()?, parts[2].parse().ok()?])
}

pub fn cmp_version(a: &str, b: &str) -> Result<std::cmp::Ordering, String> {
    let (x, y) = (semver(a).ok_or(format!("gate1: not a version: {a}"))?, semver(b).ok_or(format!("gate1: not a version: {b}"))?);
    for k in 0..3 {
        if x[k] != y[k] { return Ok(x[k].partial_cmp(&y[k]).unwrap()) }
    }
    Ok(std::cmp::Ordering::Equal)
}

fn entry_ok(e: &Value) -> bool {
    let is_hex64 = |s: &str| s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    e.is_object()
        && e["version"].as_str().is_some_and(|v| semver(v).is_some())
        && e["sha256"].as_str().is_some_and(is_hex64)
        && e["at"].is_string()
        && e["pins"]["v"].as_f64() == Some(1.0)
        // typeof … === 'object': an object, an array or null
        && e["pins"].get("blocks").is_some_and(|b| b.is_object() || b.is_array() || b.is_null())
}

/// A history payload's shape problems; empty = well-formed (versions unique, newest first).
pub fn history_problems(h: &Value) -> Vec<String> {
    let mut p = vec![];
    if h.get("v").and_then(|v| v.as_f64()) != Some(1.0) { p.push(format!("version {} (expected 1)", h.get("v").map(|v| v.to_string()).unwrap_or("undefined".into()))) }
    if !h.get("app").and_then(|a| a.as_str()).is_some_and(|a| !a.is_empty()) { p.push("no app".into()) }
    let Some(rel) = h.get("releases").and_then(|r| r.as_array()) else {
        p.push("no releases".into());
        return p;
    };
    let mut seen = std::collections::HashSet::new();
    for (i, e) in rel.iter().enumerate() {
        if !entry_ok(e) {
            p.push(format!("entry {i} is malformed"));
            continue;
        }
        let v = e["version"].as_str().unwrap();
        if !seen.insert(v.to_string()) { p.push(format!("version {v} appears twice")) }
        if i > 0 && entry_ok(&rel[i - 1]) && cmp_version(rel[i - 1]["version"].as_str().unwrap(), v).unwrap() != std::cmp::Ordering::Greater {
            p.push(format!("entries are not newest-first at {v}"));
        }
    }
    p
}

/// JSON.stringify equality, with keys in their signed order.
fn same(a: &Value, b: &Value) -> bool {
    serde_json::to_string(a).ok() == serde_json::to_string(b).ok()
}

/// A HOST's acceptance of an incoming, already signature-verified history, given the newest it holds: ANTI-ROLLBACK.
pub fn accept_history(held: Option<&Value>, incoming: &Value, app: &str) -> Result<(), String> {
    let problems = history_problems(incoming);
    if let Some(p) = problems.first() { return Err(format!("malformed: {p}")) }
    let inc_app = incoming["app"].as_str().unwrap_or("");
    if inc_app != app { return Err(format!("for {inc_app}, not {app}")) }
    let Some(held) = held else { return Ok(()) };
    let inc = incoming["releases"].as_array().unwrap();
    let hel = held.get("releases").and_then(|r| r.as_array()).cloned().unwrap_or_default();
    let newest = |a: &[Value]| a.first().and_then(|e| e["version"].as_str()).unwrap_or("").to_string();
    if inc.is_empty() || (!hel.is_empty() && cmp_version(&newest(inc), &newest(&hel))? == std::cmp::Ordering::Less) {
        return Err("rollback: its newest release is older than the newest already held".into());
    }
    for e in &hel {
        let v = e["version"].as_str().unwrap_or("");
        let Some(there) = inc.iter().find(|x| x["version"].as_str() == Some(v)) else {
            return Err(format!("rollback: it lacks {v}, which is already held"));
        };
        if !same(there, e) { return Err(format!("{v} changed: a history never changes an entry")) }
    }
    Ok(())
}

// --- matching -----------------------------------------------------------------------

/// Check a file against ONE release's pins. Returns the problems; empty = this release's file.
pub fn check_against_pins(html: &str, pins: &Pins) -> Vec<String> {
    let mut problems = markup_problems(html);
    let blocks = scan_blocks(html);
    for (id, pin) in [("bento-rt", &pins.rt), ("bento-rt-css", &pins.rt_css)] {
        let found: Vec<_> = blocks.iter().filter(|b| b.id.as_deref() == Some(id)).collect();
        if found.len() != 1 {
            problems.push(format!("{} #{id} blocks (exactly one expected)", found.len()));
        } else if Some(sha256hex(found[0].text)) != *pin {
            problems.push(format!("#{id} does not match"));
        }
    }
    let exec = executable_scripts(&blocks);
    let hashes: Vec<String> = exec.iter().map(|s| sha256hex(s.text)).collect();
    let allowed: Vec<&String> = [&pins.loader, &pins.remover].into_iter().flatten().filter(|s| !s.is_empty()).collect();
    for (s, h) in exec.iter().zip(&hashes) {
        if s.src.is_some() || !allowed.contains(&h) {
            problems.push(format!("an executable script that is neither the pinned loader nor the remover ({})", match &s.src { Some(src) => format!("src={src}"), None => format!("{}B", s.text.len()) }));
        }
    }
    let n = |p: &Option<String>| hashes.iter().filter(|x| Some(*x) == p.as_ref()).count();
    if n(&pins.loader) == 0 { problems.push("no pinned loader".into()) }
    if n(&pins.loader) > 1 { problems.push("more than one loader".into()) }
    if pins.remover.as_deref().is_some_and(|r| !r.is_empty()) && n(&pins.remover) > 1 { problems.push("more than one remover".into()) }
    problems
}

/// The ONE entry matching every block of the file, or None (none, or more than one: UNKNOWN).
pub fn match_release(history: &History, html: &str) -> Option<Entry> {
    let blocks = scan_blocks(html);
    let rt: Vec<_> = blocks.iter().filter(|b| b.id.as_deref() == Some("bento-rt")).collect();
    if rt.len() != 1 { return None }
    let rt_hash = sha256hex(rt[0].text);
    let full: Vec<Entry> = history.entries().into_iter().filter(|e| e.pins.rt.as_deref() == Some(rt_hash.as_str())).filter(|e| check_against_pins(html, &e.pins).is_empty()).collect();
    if full.len() == 1 { full.into_iter().next() } else { None }
}

/// The CSP a host serves a verified document under (security §17/§18, §36a).
pub fn host_policy(pins: &Pins, frame_ancestors: &str) -> String {
    [
        "default-src 'none'".to_string(),
        format!("script-src {} blob:", pins.script_src.iter().map(|h| format!("'{h}'")).collect::<Vec<_>>().join(" ")),
        "style-src 'unsafe-inline'".into(),
        "img-src data: blob: https:".into(),
        "media-src data: blob: https:".into(),
        "font-src data: blob:".into(),
        "connect-src https://bento.page https://sync.bento.page wss://sync.bento.page".into(),
        "frame-src https:".into(),
        "object-src 'none'".into(),
        "base-uri 'none'".into(),
        "form-action 'none'".into(),
        "worker-src 'none'".into(),
        format!("frame-ancestors {frame_ancestors}"),
    ]
    .join("; ")
}

#[derive(Debug, Clone)]
pub enum ServedVerdict {
    Genuine { release: Entry, csp: String },
    Unknown { reason: String },
}

/// THE served-path gate. The history must already have passed the release-key
/// signature check and accept_history(). `doc` is the file's bytes as read once
/// by the host: what is verified is what is served.
pub fn verify_served(doc: &[u8], history: &History, frame_ancestors: &str) -> ServedVerdict {
    let unknown = |reason: String| ServedVerdict::Unknown { reason };
    if let Some(p) = history_problems(&history.raw).first() { return unknown(format!("the history is malformed: {p}")) }
    let Ok(html) = std::str::from_utf8(doc) else { return unknown("not UTF-8".into()) };
    match match_release(history, html) {
        Some(release) => {
            let csp = host_policy(&release.pins, frame_ancestors);
            ServedVerdict::Genuine { release, csp }
        }
        None => {
            let markup = markup_problems(html);
            unknown(markup.into_iter().next().unwrap_or_else(|| "no single release matches every block".into()))
        }
    }
}

/// A served file judged against EVERY history the host holds (the reference's
/// verifyServedHeld). A fresh shell has an empty document block, so nothing in
/// the file says which app it is: never pick the history by a name read from the
/// file or from a directory. Exactly one held history must match; none, or more
/// than one, is UNKNOWN. A genuine verdict names the app that matched.
pub fn verify_served_held(doc: &[u8], held: &[History], frame_ancestors: &str) -> (ServedVerdict, Option<String>) {
    let mut hits: Vec<(String, ServedVerdict)> = vec![];
    for h in held {
        let v = verify_served(doc, h, frame_ancestors);
        if matches!(v, ServedVerdict::Genuine { .. }) { hits.push((h.app().unwrap_or("").to_string(), v)) }
    }
    if hits.len() == 1 {
        let (app, v) = hits.pop().unwrap();
        return (v, Some(app));
    }
    let reason = if hits.is_empty() {
        "no held history matches".to_string()
    } else {
        format!("{} held histories match ({})", hits.len(), hits.iter().map(|(a, _)| a.as_str()).collect::<Vec<_>>().join(", "))
    };
    (ServedVerdict::Unknown { reason }, None)
}

// --- the strict file:// fallback (security §15) ------------------------------------
//
// The desktop host always SERVES the bytes it verified, so it never needs this
// path for identity (§16). It is ported so the host can say what a file:// copy
// of a document would get, and to hold the two scanners to the same rows.

const CLOSE: &str = "</script>";
const DOC_ANCHOR: &str = " id=\"bento-doc\"";
const DOC_OPEN: &str = "<script type=\"application/bento+json\" id=\"bento-doc\">";

pub struct StrictExpected {
    pub skeleton: String,
    pub remover: Option<String>,
}

fn has_on_handler(body: &str) -> bool {
    // /\son[a-z]+\s*=/i
    for (p, c) in body.char_indices() {
        if !js_space(c) { continue }
        let k = p + c.len_utf8();
        if !starts_ci(body, k, "on") { continue }
        let mut e = k + 2;
        let s = e;
        while body.as_bytes().get(e).is_some_and(|b| b.is_ascii_alphabetic()) { e += 1 }
        if e == s { continue }
        let e = skip_space(body, e);
        if body.as_bytes().get(e) == Some(&b'=') { return true }
    }
    false
}

fn collapse(h: &str, remover: Option<&str>) -> Result<String, String> {
    let count = |s: &str, n: &str| s.matches(n).count();
    if count(h, DOC_ANCHOR) != 1 { return Err(format!("doc anchor count {}", count(h, DOC_ANCHOR))) }
    let di = h.find(DOC_ANCHOR).unwrap();
    let d_open = h[..di].rfind('<').ok_or("doc block opening tag altered")?;
    let d_tag_end = find_from(h, ">", di).map(|x| x + 1).ok_or("doc block opening tag altered")?;
    if &h[d_open..d_tag_end] != DOC_OPEN { return Err("doc block opening tag altered".into()) }
    let d_end = find_from(h, CLOSE, di).map(|x| x + CLOSE.len()).ok_or("\"<\" inside the doc block")?;
    if h.get(d_tag_end..d_end - CLOSE.len()).map_or(true, |b| b.contains('<')) { return Err("\"<\" inside the doc block".into()) }
    let mut h = format!("{}<!--DOC-->{}", &h[..d_open], &h[d_end..]);
    if count(&h, "data-bento-preview") > 0 {
        let Some(remover) = remover else { return Err("remover missing, altered or repeated".into()) };
        if count(&h, "<script data-bento-preview") != 1 || count(&h, remover) != 1 { return Err("remover missing, altered or repeated".into()) }
        let p_attr = h.find("data-bento-preview").unwrap();
        let p_open = h[..p_attr].rfind('<').ok_or("remover missing, altered or repeated")?;
        let rem = h.find(remover).unwrap();
        let body = h.get(p_open..rem).unwrap_or("");
        if body.to_ascii_lowercase().contains("<script") { return Err("script inside the preview markup".into()) }
        if has_on_handler(body) || body.to_ascii_lowercase().contains("javascript:") { return Err("handler or javascript: in the preview markup".into()) }
        if rem < p_open { return Err("remover missing, altered or repeated".into()) }
        h = format!("{}<!--PREVIEW-->{}", &h[..p_open], &h[rem + remover.len()..]);
    }
    // h.replace(/<title>[^<]*<\/title>/, '<title><!--TITLE--></title>')
    let mut from = 0;
    while let Some(p) = find_from(&h, "<title>", from) {
        let q = find_from(&h, "<", p + 7).unwrap_or(h.len());
        if h[q..].starts_with("</title>") {
            return Ok(format!("{}<title><!--TITLE--></title>{}", &h[..p], &h[q + 8..]));
        }
        from = p + 1;
    }
    Ok(h)
}

/// The strict check: the variable spans type-checked and collapsed, then the
/// WHOLE string equal to the release's saved skeleton, bound at both ends.
pub fn verify_strict(doc: &[u8], expected: &StrictExpected) -> Result<(), String> {
    let html = std::str::from_utf8(doc).map_err(|_| "not UTF-8".to_string())?;
    let c = collapse(html, expected.remover.as_deref())?;
    if c == expected.skeleton { Ok(()) } else { Err("skeleton differs from the release's saved form".into()) }
}
