// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The desktop agent against the bento/connect conformance vectors
// (kernel/fixtures/identity-v1.json), mirroring scripts/test-statements.ts:
// every row's verdict AND reason, the builder round-trip and three tamperings of
// every accepted row, the attack rows' presence, the derivations, low-S, the
// purpose matcher, addresses and strict base64url.
//
// The fixture is RE-READ every run, never pinned: a regeneration changes the
// signatures, not the verdicts. A missing fixture is a FAILURE, never a skip.
// Override the path with BENTO_ID_FIXTURE.

use bento_id_agent::{address, b64u, statements as st};
use serde_json::Value;
use std::collections::HashMap;

fn fixture() -> Value {
    let path = std::env::var("BENTO_ID_FIXTURE").unwrap_or_else(|_| {
        format!("{}/../../../kernel/fixtures/identity-v1.json", env!("CARGO_MANIFEST_DIR"))
    });
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("the conformance fixture is required ({path}): {e}"));
    serde_json::from_str(&text).expect("fixture is JSON")
}

fn s<'a>(r: &'a Value, k: &str) -> &'a str {
    r[k].as_str().unwrap_or_else(|| panic!("row field {k} missing: {r}"))
}

struct Ctx {
    now: u64,
    kx_default: st::KxMode,
    dir_keys: HashMap<String, String>,
    account: String,
    consent: String,
}

#[derive(Debug)]
enum Parsed {
    Dev(st::DeviceCert),
    Bind(st::BindCert),
    Att(st::Attestation),
    Tomb(st::Tombstone),
    Del(String, u64),
    Cmp(String, String),
    Cns(st::Consent),
}

fn check(c: &Ctx, r: &Value, text: &str, sig: &str) -> Result<Parsed, &'static str> {
    let now = r["now"].as_u64().unwrap_or(c.now);
    let kx = r["kxMode"].as_str().map(|m| st::KxMode::parse(m).expect("kxMode")).unwrap_or(c.kx_default);
    match s(r, "type") {
        "dev" => st::verify_dev(text, sig, now, kx).map(Parsed::Dev),
        "bind" => st::verify_bind(text, sig, now, kx).map(Parsed::Bind),
        "att" => st::verify_att(text, sig, &c.dir_keys, s(r, "bindText"), now, r["maxAgeMs"].as_u64().expect("maxAgeMs"))
            .map(Parsed::Att),
        "tomb" => st::verify_tomb(text, sig, &c.dir_keys, now).map(Parsed::Tomb),
        "del" => st::verify_del(text, sig, &c.account, now).map(|(a, t)| Parsed::Del(a, t)),
        "cmp" => st::verify_cmp(text, sig, &c.account, s(r, "bindText")).map(|(h, k)| Parsed::Cmp(h, k)),
        "cns" => {
            let o = st::ConsentCheck {
                consent_pub: &c.consent,
                rp: s(r, "rp"),
                audience: s(r, "audience"),
                challenge: s(r, "challenge"),
                payload_text: s(r, "payloadText"),
                doc_id: r["docId"].as_str(),
                now,
            };
            let spent = r["challengeSpent"].as_bool().unwrap_or(false);
            let called = std::cell::Cell::new(false);
            let v = st::verify_consent(text, sig, &o, |_| { called.set(true); !spent }).map(Parsed::Cns);
            // The verdict cannot show WHEN spend runs; the fixture says whether
            // it must have been called (spend FIRST, after the grammar check).
            // Only on the fixture's own text: a tampered text may fail grammar.
            if text == s(r, "text") {
                if let Some(want) = r["spendCalled"].as_bool() {
                    assert_eq!(called.get(), want, "spendCalled: {}", s(r, "name"));
                }
            }
            v
        }
        t => panic!("unknown row type {t}"),
    }
}

fn rebuild(p: &Parsed) -> String {
    match p {
        Parsed::Dev(c) => st::build_dev(c),
        Parsed::Bind(c) => st::build_bind(c),
        Parsed::Att(a) => st::build_att(a),
        Parsed::Tomb(t) => st::build_tomb(t),
        Parsed::Del(a, t) => st::build_del(a, *t),
        Parsed::Cmp(h, k) => st::build_cmp(h, k),
        Parsed::Cns(c) => st::build_consent(c),
    }
}

fn ctx(f: &Value) -> Ctx {
    Ctx {
        now: f["now"].as_u64().unwrap(),
        kx_default: st::KxMode::parse(f["kxModeDefault"].as_str().unwrap()).unwrap(),
        dir_keys: f["directoryKeys"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().into())).collect(),
        account: f["keys"]["account"].as_str().unwrap().into(),
        consent: f["keys"]["consent"].as_str().unwrap().into(),
    }
}

#[test]
fn every_statement_row_reaches_its_verdict_and_reason() {
    let f = fixture();
    let c = ctx(&f);
    let mut bad = vec![];
    let rows = f["statements"].as_array().unwrap();
    assert!(rows.len() >= 60, "the statement rows shrank: {}", rows.len());
    let cns = rows.iter().filter(|r| r["type"] == "cns").count();
    assert_eq!(rows.iter().filter(|r| r["type"] == "cns" && r["spendCalled"].is_boolean()).count(), cns,
        "every cns row carries spendCalled");
    for r in rows {
        let got = match check(&c, r, s(r, "text"), s(r, "sig")) {
            Ok(_) => "accept".to_string(),
            Err(e) => format!("reject:{e}"),
        };
        let want = if s(r, "expect") == "accept" { "accept".to_string() } else { format!("reject:{}", s(r, "reason")) };
        if got != want {
            bad.push(format!("{}: want {want}, got {got}", s(r, "name")));
        }
    }
    assert!(bad.is_empty(), "{} rows differ:\n{}", bad.len(), bad.join("\n"));
}

#[test]
fn accepted_rows_round_trip_and_refuse_tampering() {
    let f = fixture();
    let c = ctx(&f);
    let mut n = 0;
    for r in f["statements"].as_array().unwrap().iter().filter(|r| r["expect"] == "accept") {
        let (text, sig) = (s(r, "text"), s(r, "sig"));
        let p = check(&c, r, text, sig).unwrap_or_else(|e| panic!("{}: {e}", s(r, "name")));
        assert_eq!(rebuild(&p), text, "builder reproduces the exact text: {}", s(r, "name"));
        let mut raw = b64u::dec(sig).unwrap();
        raw[10] ^= 1;
        assert!(check(&c, r, text, &b64u::enc(&raw)).is_err(), "flipped signature bit refused: {}", s(r, "name"));
        assert!(check(&c, r, &format!("{text}.x"), sig).is_err(), "extra field refused: {}", s(r, "name"));
        let i = text.len() - 2;
        let flipped = format!("{}{}{}", &text[..i], if &text[i..i + 1] == "1" { "2" } else { "1" }, &text[i + 1..]);
        assert!(check(&c, r, &flipped, sig).is_err(), "one changed byte refused: {}", s(r, "name"));
        n += 1;
    }
    assert!(n > 0);
}

#[test]
fn the_contract_cannot_quietly_shrink() {
    let f = fixture();
    let rows = f["statements"].as_array().unwrap();
    let has = |needle: &str| rows.iter().any(|r| s(r, "name").contains(needle));
    for a in ["REPLAY", "RELAY", "PAYLOAD SWAP", "DOCID SWAP", "EXPIRED"] {
        assert!(has(a), "cns attack row present: {a}");
    }
    for g in ["high-S", "DER", "an extra field", "a field missing", "raw (unencoded) email", "dotted rp", "padded base64url"] {
        assert!(has(g), "grammar/signature row present: {g}");
    }
    for t in ["dev", "bind", "att", "tomb", "del", "cmp", "cns"] {
        assert!(rows.iter().any(|r| r["type"] == t && r["expect"] == "accept"), "{t} has an accept row");
        assert!(rows.iter().any(|r| r["type"] == t && r["expect"] == "reject"), "{t} has a reject row");
    }
    assert_eq!(f["kxModeDefault"], "unruled");
    assert_eq!(st::KX_MODE, st::KxMode::Unruled, "kx placement is unruled: both slots empty");
}

#[test]
fn consent_transcript_and_webauthn_challenge() {
    let f = fixture();
    for t in f["transcripts"].as_array().unwrap() {
        let got = st::consent_transcript(s(t, "audience"), s(t, "challenge"), s(t, "payload"));
        assert_eq!(got.as_deref(), t["transcript"].as_str(), "transcript {t}");
    }
    for w in f["webauthn"].as_array().unwrap() {
        assert_eq!(st::webauthn_challenge_for(s(w, "cns")), s(w, "challenge"));
    }
}

#[test]
fn low_s_verifiers_refuse_high_signers_fold() {
    let f = fixture();
    let account = f["keys"]["account"].as_str().unwrap();
    for (i, p) in f["lowS"].as_array().unwrap().iter().enumerate() {
        let text = format!("dev.lows.{i}");
        assert!(st::verify_statement_sig(account, s(p, "low"), &text), "pair {i}: low-S verifies");
        assert!(!st::verify_statement_sig(account, s(p, "high"), &text), "pair {i}: high-S refused");
        let fold = |x: &str| -> String {
            let raw: [u8; 64] = b64u::dec(x).unwrap().try_into().unwrap();
            b64u::enc(&st::low_s(&raw))
        };
        assert_eq!(fold(s(p, "high")), s(p, "low"), "pair {i}: folds high to low");
        assert_eq!(fold(s(p, "low")), s(p, "low"), "pair {i}: leaves low alone");
    }
}

#[test]
fn each_purpose_signs_only_its_own_shape() {
    let f = fixture();
    for p in f["purposes"].as_array().unwrap() {
        assert_eq!(
            st::payload_matches_purpose(s(p, "purpose"), s(p, "payload")),
            p["match"].as_bool().unwrap(),
            "{p}"
        );
    }
}

#[test]
fn one_normal_form_for_addresses() {
    let f = fixture();
    let mut bad = vec![];
    for a in f["addresses"].as_array().unwrap() {
        let want = match a["address"].as_str() {
            Some(x) => format!("ok:{x}"),
            None => format!("refused:{}", s(a, "reason")),
        };
        let got = match address::normalize(s(a, "input")) {
            Ok(x) => format!("ok:{x}"),
            Err(e) => format!("refused:{}", e.as_str()),
        };
        if got != want {
            bad.push(format!("{:?}: want {want}, got {got}", s(a, "input")));
        }
    }
    assert!(bad.is_empty(), "{}", bad.join("\n"));
}

#[test]
fn strict_base64url() {
    assert!(b64u::dec("QQ").is_some() && b64u::dec("QQ==").is_none(), "padding refused");
    assert!(b64u::dec("QR").is_none(), "non-zero trailing bits refused");
    assert!(b64u::dec("Q").is_none(), "impossible length refused");
    assert!(b64u::dec("Q+8").is_none() && b64u::dec("Q/8").is_none(), "standard alphabet refused");
    assert_eq!(b64u::dec("").map(|b| b.len()), Some(0), "empty is zero bytes");
}

#[test]
fn signing_emits_low_s_that_the_verifier_accepts() {
    // A software key round-trip: 64 signatures, every one low-S and accepted.
    let key = p256::ecdsa::SigningKey::from_slice(&[7u8; 32]).unwrap();
    let pubkey = b64u::enc(key.verifying_key().to_sec1_point(false).as_bytes());
    for i in 0..64 {
        let text = format!("dev.test.{i}");
        let sig = st::sign_statement(&key, &text);
        assert!(st::verify_statement_sig(&pubkey, &sig, &text), "round-trip {i}");
    }
}

#[test]
fn reserved_prefixes() {
    assert!(st::RESERVED_PREFIXES.contains(&"pk"));
}

#[test]
fn every_consent_attempt_spends_its_challenge_even_one_refused_for_another_reason() {
    // The fixture's `spend` is a stub (challengeSpent true/false), so it cannot
    // tell WHEN the verifier spends. The reference spends right after the
    // grammar check: an attempt refused for ANY later reason must still burn the
    // challenge, or a refused attempt leaves it live to be retried. Mutation
    // check: moving `spend` after the transcript check passed every vector row.
    let f = fixture();
    let c = ctx(&f);
    let row = f["statements"].as_array().unwrap().iter()
        .find(|r| r["type"] == "cns" && r["expect"] == "accept").expect("an accepted cns row");
    let mut spent = false;
    let o = st::ConsentCheck {
        consent_pub: &c.consent,
        rp: "vault-not-this-one",
        audience: s(row, "audience"),
        challenge: s(row, "challenge"),
        payload_text: s(row, "payloadText"),
        doc_id: row["docId"].as_str(),
        now: row["now"].as_u64().unwrap_or(c.now),
    };
    let v = st::verify_consent(s(row, "text"), s(row, "sig"), &o, |_| { spent = true; true });
    assert_eq!(v.unwrap_err(), "rp");
    assert!(spent, "a consent refused for its rp still spent the challenge");
}

#[test]
fn the_display_table_is_the_fixtures_frozen_table() {
    let f = fixture();
    let d = &f["displayForbidden"];
    assert_eq!(d["unicode"].as_str(), Some(bento_id_agent::statements::DISPLAY_UNICODE), "regenerate with gen-display-table.mjs");
    let want: Vec<(u32, u32)> = d["ranges"].as_array().unwrap().iter()
        .map(|r| (r[0].as_u64().unwrap() as u32, r[1].as_u64().unwrap() as u32)).collect();
    assert_eq!(st::DISPLAY_FORBIDDEN_RANGES.to_vec(), want, "the embedded table drifted from the fixture");
}
