// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The release-build check for the desktop host's bundled history, and the
// real-release verdicts. Built WITHOUT the rig feature: it trusts the pinned
// release key only.
//
//   release_check <dir>                      # dir: history.json manifest.json <shell>
//   release_check <dir> --genuine f… --unknown f…
//
// Asserts: the history and the manifest both verify against the pinned key;
// the history's newest release IS the manifest's, with the same sha256 and the
// same pins; the shell's bytes hash to it; the shell reads GENUINE at that
// version, a one-byte change inside its runtime reads UNKNOWN, and a different
// document in its #bento-doc block still reads GENUINE. Any --genuine/--unknown
// file must read as stated. Exits non-zero on the first failure.

use bento_hostcore::trust::{pinned_keys, verify_envelope, Trust, Verdict, RELEASE_KEY};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

fn fail(m: String) -> ! {
    eprintln!("FAIL {m}");
    std::process::exit(1)
}
fn ok(m: String) {
    println!("ok   {m}")
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let dir = PathBuf::from(args.first().unwrap_or_else(|| fail("usage: release_check <dir> [--genuine f…] [--unknown f…]".into())));
    if pinned_keys() != vec![RELEASE_KEY] { fail("built with the rig feature: this check trusts the release key ONLY".into()) }
    let read = |p: &Path| std::fs::read(p).unwrap_or_else(|e| fail(format!("{}: {e}", p.display())));
    let hist_env = String::from_utf8(read(&dir.join("history.json"))).unwrap();
    let keys = pinned_keys();
    // A frozen snapshot (home/fixtures/gate1/real/<app>-<version>) carries the key
    // it was signed with: it must be the key this build pins.
    if let Ok(k) = std::fs::read(dir.join("release-public-key.json")) {
        let k: serde_json::Value = serde_json::from_slice(&k).unwrap_or_else(|e| fail(format!("release-public-key.json: {e}")));
        if (k["x"].as_str(), k["y"].as_str()) != (Some(RELEASE_KEY.0), Some(RELEASE_KEY.1)) { fail("the snapshot's release key is not the pinned release key".into()) }
        ok("the snapshot's release key is the pinned release key".into());
    }
    let hist = verify_envelope(&hist_env, &keys).unwrap_or_else(|e| fail(format!("history: {e}")));
    let app = hist.app().unwrap_or("").to_string();
    ok(format!("history ({app}, {} releases) verifies against the pinned release key", hist.entries().len()));
    let newest = hist.raw["releases"][0].clone();
    let (version, sha): (String, String);
    if dir.join("manifest.json").exists() {
        let man_env = String::from_utf8(read(&dir.join("manifest.json"))).unwrap();
        let man = verify_envelope(&man_env, &keys).unwrap_or_else(|e| fail(format!("manifest: {e}")));
        let m = &man.raw;
        version = m["version"].as_str().unwrap_or("").to_string();
        sha = m["sha256"].as_str().unwrap_or("").to_string();
        if m["app"].as_str() != Some(app.as_str()) { fail(format!("manifest is for {:?}, history for {app}", m["app"])) }
        if newest["version"].as_str() != Some(version.as_str()) {
            fail(format!("the history's newest release is {:?}, the published manifest's is {version}: the bundle is not current", newest["version"]))
        }
        if newest["sha256"].as_str() != Some(sha.as_str()) { fail("the history's newest entry and the manifest disagree on the shell's sha256".into()) }
        if m.get("pins").is_some() && serde_json::to_string(&m["pins"]).ok() != serde_json::to_string(&newest["pins"]).ok() {
            fail("the history's pins and the manifest's pins differ".into())
        }
        ok(format!("the manifest verifies and the history is current: its newest release is the published {version}, same sha256 and pins"));
    } else {
        version = newest["version"].as_str().unwrap_or("").to_string();
        sha = newest["sha256"].as_str().unwrap_or("").to_string();
        ok(format!("frozen snapshot (no manifest): currency is NOT checked here; the shell must be the history's newest, {version}"));
    }
    let (version, sha) = (version.as_str(), sha.as_str());
    // the shell: whichever *.html sits beside them
    let shell_path = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.path()).find(|p| p.extension().and_then(|x| x.to_str()) == Some("html")).unwrap_or_else(|| fail("no shell .html in the dir".into()));
    let shell = read(&shell_path);
    let got: String = Sha256::digest(&shell).iter().map(|b| format!("{b:02x}")).collect();
    if got != sha { fail(format!("the shell's sha256 {got} is not the signed {sha}")) }
    ok("the shell's bytes are the signed release".into());

    let (trust, notes) = Trust::load_with_keys(keys.clone(), &[hist_env.as_str()], None);
    if !notes.is_empty() { fail(format!("trust: {notes:?}")) }
    let expect = |name: &str, bytes: &[u8], want: Option<&str>| {
        let v = trust.verdict(bytes);
        match (&v, want) {
            (Verdict::Genuine { version: got, .. }, Some(w)) if w.is_empty() || got == w => ok(format!("{name}: GENUINE {got}")),
            (Verdict::Unknown { reason }, None) => ok(format!("{name}: UNKNOWN ({reason})")),
            _ => fail(format!("{name}: want {}, got {v:?}", want.map(|w| format!("genuine {w}")).unwrap_or("unknown".into()))),
        }
    };
    expect("the published shell", &shell, Some(version));
    // a one-byte change inside the runtime block
    let html = String::from_utf8(shell.clone()).unwrap();
    let rt = html.find("id=\"bento-rt\"").unwrap_or_else(|| fail("no bento-rt block".into()));
    let at = html[rt..].find('>').unwrap() + rt + 50;
    let mut flipped = shell.clone();
    flipped[at] = if flipped[at] == b'A' { b'B' } else { b'A' };
    expect("the shell with one runtime byte changed", &flipped, None);
    // a different document in the doc block (what any save changes)
    let other = html.replacen("id=\"bento-doc\"></script>", "id=\"bento-doc\">{\"format\":\"bento/slides\",\"docId\":\"release-check\",\"title\":\"x\",\"slides\":[]}</script>", 1);
    if other == html { fail("could not place a document in the shell's empty doc block".into()) }
    expect("the shell carrying another document", other.as_bytes(), Some(version));

    let mut mode = "";
    for a in &args[1..] {
        match a.as_str() {
            "--genuine" | "--unknown" => mode = if a == "--genuine" { "g" } else { "u" },
            f => expect(f, &read(Path::new(f)), if mode == "g" { Some(version) } else if mode == "u" { None } else { fail(format!("{f}: say --genuine or --unknown first")) }),
        }
    }
    println!("release check passed for {app} {version}");
}
