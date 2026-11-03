// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The recovery code and key blobs against kernel/fixtures/recovery-v1.json,
// mirroring scripts/test-recovery.ts. Every value is DETERMINISTIC: this port
// must reproduce the exact bytes. The Argon2id primitive is checked against
// RFC 9106 §5.3 FIRST, before anything trusts it. A missing fixture fails.
// Override the path with BENTO_RECOVERY_FIXTURE.

use bento_id_agent::recovery as rc;
use bento_id_agent::b64u;
use serde_json::Value;
use zeroize::Zeroizing;

fn fixture() -> Value {
    let path = std::env::var("BENTO_RECOVERY_FIXTURE").unwrap_or_else(|_| {
        format!("{}/../../../kernel/fixtures/recovery-v1.json", env!("CARGO_MANIFEST_DIR"))
    });
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("the recovery fixture is required ({path}): {e}"));
    serde_json::from_str(&text).unwrap()
}
fn unhex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}
fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or_else(|| panic!("missing {k}"))
}
fn key32(h: &str) -> Zeroizing<[u8; 32]> {
    Zeroizing::new(unhex(h).try_into().unwrap())
}
fn blob(v: &Value) -> rc::PrfBlob {
    rc::PrfBlob { v: v["v"].as_u64().unwrap() as u32, cred: s(v, "cred").into(), salt: s(v, "salt").into(), iv: s(v, "iv").into(), ct: s(v, "ct").into() }
}

#[test]
fn argon2id_primitive_matches_rfc9106_and_the_fixture_states_our_parameters() {
    let f = fixture();
    let v = &f["rfc9106"];
    let tag = rc::argon2id_raw(
        &unhex(s(v, "password")),
        &unhex(s(v, "salt")),
        Some(&unhex(s(v, "secret"))),
        Some(&unhex(s(v, "ad"))),
        v["memoryKiB"].as_u64().unwrap() as u32,
        v["passes"].as_u64().unwrap() as u32,
        v["parallelism"].as_u64().unwrap() as u32,
        v["tagLength"].as_u64().unwrap() as usize,
    )
    .unwrap();
    assert_eq!(hex(&tag), s(v, "tag"), "Argon2id(RFC 9106 §5.3) = the published tag");
    let p = &f["params"]["argon2"];
    assert_eq!(
        (p["version"].as_u64(), p["parallelism"].as_u64(), p["memoryKiB"].as_u64(), p["passes"].as_u64(), p["tagLength"].as_u64()),
        (Some(rc::ARGON2_VERSION as u64), Some(rc::ARGON2_PARALLELISM as u64), Some(rc::ARGON2_MEMORY_KIB as u64),
         Some(rc::ARGON2_PASSES as u64), Some(rc::ARGON2_TAG_LEN as u64)),
        "the port's parameters are the fixture's (v0x13, p=1, 64 MiB, t=3, 32 bytes)"
    );
}

#[test]
fn printed_codes_including_every_extra_check_symbol() {
    let f = fixture();
    let codes = f["codes"].as_array().unwrap();
    for c in codes {
        assert_eq!(rc::format_recovery_code(&unhex(s(c, "bytes"))), s(c, "printed"));
    }
    for sym in ["*", "~", "$", "=", "U"] {
        assert!(codes.iter().any(|c| c["check"] == sym), "a code whose check symbol is {sym}");
    }
}

#[test]
fn reading_what_a_person_typed() {
    let f = fixture();
    let mut bad = vec![];
    for r in f["parse"].as_array().unwrap() {
        let got = rc::parse_recovery_code(s(r, "input"));
        let ok = match (r["bytes"].as_str(), &got) {
            (Some(b), Ok(code)) => hex(&code[..]) == b,
            (None, Err(e)) => e.as_str() == s(r, "reason"),
            _ => false,
        };
        if !ok {
            bad.push(format!("{:?} → {:?}", s(r, "input"), got.map(|c| hex(&c[..]))));
        }
    }
    assert!(bad.is_empty(), "{}", bad.join("\n"));
}

#[test]
fn derivations() {
    let f = fixture();
    let d = &f["derivations"];
    let (code, salt, salt_v) = (unhex(s(d, "code")), unhex(s(d, "salt")), unhex(s(d, "saltV")));
    assert_eq!(hex(&rc::argon2id(&code, &salt).unwrap()), s(d, "argon2_A"), "A = Argon2id(code bytes, salt)");
    assert_eq!(hex(&rc::recovery_wrap_key(&code, &salt).unwrap()), s(d, "wrapKey"), "wrap key = HKDF(A, empty, rc-wrap)");
    assert_eq!(hex(&rc::recovery_verifier(&code, &salt_v).unwrap()), s(d, "verifier"), "verifier = Argon2id(code, salt_v)");
    assert_ne!(s(d, "verifier"), s(d, "argon2_A"));
    assert_eq!(hex(&rc::prf_kek(&unhex(s(&d["prf"], "output")), &unhex(s(&d["prf"], "salt")))), s(d, "prfKek"));
}

#[test]
fn whole_blobs_end_to_end() {
    let f = fixture();
    let b = &f["blobs"];
    let k = &b["keys"];
    let i = &b["prf"]["inputs"];
    let (prf, cred, salt, iv) = (unhex(s(i, "prfOutput")), unhex(s(i, "credentialId")), unhex(s(i, "salt")), unhex(s(i, "iv")));
    let acct = s(k, "accountPub");
    let kx_pub = s(k, "kxPub");

    assert_eq!((f["kxMode"].as_str(), f["blobLen"].as_u64(), rc::BLOB_LEN), (Some("C"), Some(64), 64), "kx placement is mode C: a 64-byte blob");
    let keys = rc::BlobKeys { account: key32(s(k, "accountD")), kx: key32(s(k, "kxD")) };
    assert_eq!(rc::seal_prf_blob(&prf, &cred, &salt, &iv, &keys), blob(&b["prf"]["blob"]), "PRF blob (account ‖ recovery kx) re-seals byte for byte");

    let opened = rc::open_prf_blob(&blob(&b["prf"]["blob"]), &prf, &cred, acct, kx_pub).unwrap();
    assert_eq!((hex(&opened.account[..]), hex(&opened.kx[..])), (s(k, "accountD").to_string(), s(k, "kxD").to_string()));
    let flip = |v: &[u8]| v.iter().map(|x| x ^ 1).collect::<Vec<u8>>();
    assert_eq!(rc::open_prf_blob(&blob(&b["prf"]["blob"]), &flip(&prf), &cred, acct, kx_pub).err(), Some("decrypt"));
    assert_eq!(rc::open_prf_blob(&blob(&b["prf"]["blob"]), &prf, &flip(&cred), acct, kx_pub).err(), Some("credential"));
    assert_eq!(rc::open_prf_blob(&blob(&b["prf"]["blob"]), &prf, &cred, acct, "").err(), Some("key-mismatch"), "no recovery kx to match: refused");
    let wl = b["prf"]["wrongLength"].as_array().unwrap();
    assert_eq!(wl.len(), 4);
    for w in wl {
        let mut bl = blob(&b["prf"]["blob"]);
        bl.ct = b64u::enc(&unhex(s(w, "ct")));
        assert_eq!(rc::open_prf_blob(&bl, &prf, &cred, acct, kx_pub).err(), Some("length"), "PRF: {}", s(w, "name"));
    }

    let r = &b["recovery"]["inputs"];
    let wk = rc::recovery_wrap_key(&unhex(s(r, "code")), &unhex(s(r, "salt"))).unwrap();
    let riv = unhex(s(r, "iv"));
    assert_eq!(hex(&rc::seal_recovery_inner(&wk, &riv, acct, &keys)), s(&b["recovery"], "inner"), "recovery inner re-seals");
    let inner = unhex(s(&b["recovery"], "inner"));
    let back = rc::open_recovery_inner(&inner, &wk, &riv, acct, kx_pub).unwrap();
    assert_eq!((hex(&back.account[..]), hex(&back.kx[..])), (s(k, "accountD").to_string(), s(k, "kxD").to_string()));
    for w in b["recovery"]["wrongLength"].as_array().unwrap() {
        assert_eq!(rc::open_recovery_inner(&unhex(s(w, "ct")), &wk, &riv, acct, kx_pub).err(), Some("length"), "recovery: {}", s(w, "name"));
    }
    let other = rc::parse_recovery_code(s(&f["codes"][1], "printed")).unwrap();
    let wk2 = rc::recovery_wrap_key(&other[..], &unhex(s(r, "salt"))).unwrap();
    assert_eq!(rc::open_recovery_inner(&inner, &wk2, &riv, acct, kx_pub).err(), Some("decrypt"), "another code cannot open it");
    assert_eq!(rc::open_recovery_inner(&inner, &wk, &riv, kx_pub, kx_pub).err(), Some("decrypt"), "aad binds the account");

    let pp = &b["pepper"];
    let (vk, wkey) = rc::pepper_keys(&unhex(s(pp, "secret")), acct);
    assert_eq!((hex(&vk), hex(&wkey)), (s(pp, "verifyKey").to_string(), s(pp, "wrapKey").to_string()));
    let d = &f["derivations"];
    let verifier = rc::recovery_verifier(&unhex(s(d, "code")), &unhex(s(d, "saltV"))).unwrap();
    assert_eq!(hex(&rc::pepper_verifier_tag(&vk, &verifier)), s(pp, "verifierTag"));
    let piv = unhex(s(pp, "iv"));
    assert_eq!(hex(&rc::pepper_seal(&wkey, &piv, &inner, acct)), s(pp, "outer"));
    assert_eq!(hex(&rc::pepper_open(&wkey, &piv, &unhex(s(pp, "outer")), acct).unwrap()), s(&b["recovery"], "inner"));
    assert!(rc::pepper_open(&wkey, &piv, &unhex(s(pp, "outer")), kx_pub).is_none(), "presented as another account's, it fails");
}

#[test]
fn scalars_on_import() {
    let f = fixture();
    for sc in f["scalars"].as_array().unwrap() {
        let v = rc::unpack_scalars(&unhex(s(sc, "pt")), s(sc, "accountPub"), s(sc, "kxPub"));
        match s(sc, "expect") {
            "accept" => assert!(v.is_ok(), "{}", s(sc, "name")),
            _ => assert_eq!(v.err(), Some(s(sc, "reason")), "{}", s(sc, "name")),
        }
    }
}

#[test]
fn normaliser_is_unicode_17_or_later() {
    // kernel/fixtures/README.md: NFC must be computed with Unicode ≥ 17.0 data
    // (the display table refuses everything unassigned at 17.0). Fails if the
    // crate is ever pinned or downgraded below that.
    let (major, _, _) = unicode_normalization::UNICODE_VERSION;
    assert!(major >= 17, "unicode-normalization data is {:?}", unicode_normalization::UNICODE_VERSION);
}

