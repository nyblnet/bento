// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The gate-1 conformance corpus (home/fixtures/gate1), every row, against this
// port. A row this port reads differently from its declared verdict is a
// FINDING for kernel and security: never "fixed" on one side alone.

use bento_gate1::*;
use serde_json::Value;
use std::path::PathBuf;

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/gate1")
}
fn read(p: &str) -> Vec<u8> {
    std::fs::read(dir().join(p)).unwrap_or_else(|e| panic!("{p}: {e}"))
}
fn json(p: &str) -> Value {
    serde_json::from_slice(&read(p)).unwrap()
}
fn history() -> History {
    let key = json("test-public-key.json");
    History::from_signed(std::str::from_utf8(&read("history.json")).unwrap(), key["x"].as_str().unwrap(), key["y"].as_str().unwrap()).expect("the corpus history verifies")
}

#[test]
fn history_signature_verifies_and_a_flipped_byte_does_not() {
    let h = history();
    assert_eq!(h.app(), Some("bento-test"));
    // positive control: the same envelope with one payload byte changed must fail
    let key = json("test-public-key.json");
    let mut env = json("history.json");
    let p = env["payload"].as_str().unwrap().replacen("1.2.0", "1.2.1", 1);
    env["payload"] = Value::String(p);
    assert!(History::from_signed(&env.to_string(), key["x"].as_str().unwrap(), key["y"].as_str().unwrap()).is_err());
}

#[test]
fn served_rows() {
    let h = history();
    let exp = json("expected.json");
    let rows = exp["served"].as_array().unwrap();
    assert!(rows.len() >= 60, "the served rows shrank to {}: re-read the corpus", rows.len());
    let mut wrong = vec![];
    for r in rows {
        let case = r["case"].as_str().unwrap();
        let v = verify_served(&read(case), &h, "'none'");
        let got = match &v {
            ServedVerdict::Genuine { release, .. } => format!("genuine {}", release.version),
            ServedVerdict::Unknown { .. } => "unknown".into(),
        };
        let want = match r["verdict"].as_str().unwrap() {
            "genuine" => format!("genuine {}", r["release"].as_str().unwrap()),
            other => other.to_string(),
        };
        if got != want {
            let why = match &v { ServedVerdict::Unknown { reason } => reason.clone(), _ => String::new() };
            wrong.push(format!("{case}: want {want}, got {got} {why}"))
        }
        // a genuine verdict's CSP carries exactly the release's CSP-form pins
        if let ServedVerdict::Genuine { release, csp } = &v {
            for s in &release.pins.script_src { assert!(csp.contains(&format!("'{s}'")), "{case}: CSP lacks {s}") }
            assert!(csp.starts_with("default-src 'none'; script-src 'sha256-"), "{case}: {csp}");
        }
    }
    assert!(wrong.is_empty(), "served rows the port reads differently:\n{}", wrong.join("\n"));
}

#[test]
fn ambiguous_row() {
    let exp = json("expected.json");
    for r in exp["ambiguous"].as_array().unwrap() {
        let h = History::from_value(r["history"].clone());
        let v = verify_served(&read(r["case"].as_str().unwrap()), &h, "'none'");
        assert!(matches!(v, ServedVerdict::Unknown { .. }), "{}: two matching entries must be UNKNOWN, got {v:?}", r["case"]);
        assert_eq!(r["verdict"], "unknown");
    }
}

#[test]
fn strict_rows() {
    let s = json("strict-expected.json");
    let expected = StrictExpected { skeleton: s["skeleton"].as_str().unwrap().into(), remover: s["remover"].as_str().map(str::to_string) };
    let exp = json("expected.json");
    let rows = exp["strict"].as_array().unwrap();
    assert!(rows.len() >= 19, "strict rows shrank to {}", rows.len());
    let mut wrong = vec![];
    for r in rows {
        let case = r["case"].as_str().unwrap();
        let got = verify_strict(&read(case), &expected);
        if got.is_ok() != r["ok"].as_bool().unwrap() { wrong.push(format!("{case}: want ok={}, got {got:?}", r["ok"])) }
    }
    assert!(wrong.is_empty(), "strict rows the port reads differently:\n{}", wrong.join("\n"));
}

#[test]
fn history_rows() {
    let exp = json("expected.json");
    let app = exp["app"].as_str().unwrap();
    let rows = exp["history"].as_array().unwrap();
    assert!(rows.len() >= 8, "history rows shrank to {}", rows.len());
    let mut wrong = vec![];
    for r in rows {
        let held = if r["held"].is_null() { None } else { Some(&r["held"]) };
        let got = accept_history(held, &r["incoming"], app);
        if got.is_ok() != r["ok"].as_bool().unwrap() { wrong.push(format!("{}: want ok={}, got {got:?}", r["name"], r["ok"])) }
    }
    assert!(wrong.is_empty(), "history rows the port reads differently:\n{}", wrong.join("\n"));
}

#[test]
fn every_corpus_file_is_covered_by_a_row() {
    // a file added to the corpus without a row here would be silently untested
    let exp = json("expected.json");
    let mut named: Vec<String> = vec![];
    for sec in ["served", "strict", "ambiguous"] {
        for r in exp[sec].as_array().unwrap() { named.push(r["case"].as_str().unwrap().into()) }
    }
    for sub in ["served", "strict"] {
        for f in std::fs::read_dir(dir().join(sub)).unwrap() {
            let n = format!("{sub}/{}", f.unwrap().file_name().to_string_lossy());
            assert!(named.contains(&n), "{n} has no row in expected.json");
        }
    }
}

/// #842: each history named by `histories`, verified with its own key.
fn named_histories(exp: &Value) -> Option<std::collections::HashMap<String, History>> {
    let hs = exp.get("histories")?.as_object()?;
    let mut out = std::collections::HashMap::new();
    for (name, spec) in hs {
        let key = json(spec["key"].as_str().unwrap());
        let env = String::from_utf8(read(spec["history"].as_str().unwrap())).unwrap();
        let h = History::from_signed(&env, key["x"].as_str().unwrap(), key["y"].as_str().unwrap()).unwrap_or_else(|e| panic!("history {name}: {e}"));
        out.insert(name.clone(), h);
    }
    Some(out)
}

#[test]
fn held_rows() {
    let exp = json("expected.json");
    let (Some(rows), Some(named)) = (exp.get("held").and_then(Value::as_array), named_histories(&exp)) else {
        println!("NOTE: this corpus has no `held`/`histories` sections yet (they arrive with kernel #842)");
        return;
    };
    assert!(rows.len() >= 6, "the held rows shrank to {}", rows.len());
    let mut wrong = vec![];
    for r in rows {
        let held: Vec<History> = r["held"].as_array().unwrap().iter().map(|n| named[n.as_str().unwrap()].clone()).collect();
        let (v, app) = verify_served_held(&read(r["case"].as_str().unwrap()), &held, "'none'");
        let got = match &v {
            ServedVerdict::Genuine { release, .. } => format!("genuine {} {}", app.clone().unwrap_or_default(), release.version),
            ServedVerdict::Unknown { .. } => "unknown".into(),
        };
        let want = match r["verdict"].as_str().unwrap() {
            "genuine" => format!("genuine {} {}", r["app"].as_str().unwrap(), r["release"].as_str().unwrap()),
            o => o.to_string(),
        };
        if got != want { wrong.push(format!("{}: want {want}, got {got} ({v:?})", r["name"])) }
    }
    assert!(wrong.is_empty(), "held rows the port reads differently:\n{}", wrong.join("\n"));
}

#[test]
fn every_named_history_verifies_and_a_flipped_byte_does_not() {
    let exp = json("expected.json");
    let Some(hs) = exp.get("histories").and_then(Value::as_object) else {
        println!("NOTE: no `histories` section yet (kernel #842)");
        return;
    };
    for (name, spec) in hs {
        let key = json(spec["key"].as_str().unwrap());
        let mut env = json(spec["history"].as_str().unwrap());
        let p = env["payload"].as_str().unwrap().to_string();
        let i = p.find("\"version\"").unwrap() + 12;
        let mut b = p.into_bytes();
        b[i] = if b[i] == b'1' { b'2' } else { b'1' };
        env["payload"] = Value::String(String::from_utf8(b).unwrap());
        assert!(History::from_signed(&env.to_string(), key["x"].as_str().unwrap(), key["y"].as_str().unwrap()).is_err(), "{name}: a changed payload must not verify");
    }
}
