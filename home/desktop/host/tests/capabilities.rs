// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The Windows capability file's origin pattern, under Tauri's own parser and matcher
// (the code the ACL runs), on any platform. rig/check.py requires this to have passed.
// The running proof on WebView2 is the rig's acl rows.

use tauri::utils::acl::RemoteUrlPattern;

fn urls(file: &str) -> Vec<String> {
    let path = format!("{}/capabilities-windows/{file}", env!("CARGO_MANIFEST_DIR"));
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    v["remote"]["urls"].as_array().unwrap().iter().map(|u| u.as_str().unwrap().to_string()).collect()
}

fn admitted(pattern: &RemoteUrlPattern, url: &str) -> bool {
    pattern.test(&url.parse().unwrap())
}

const HEX: &str = "0123456789abcdef01234567";

#[test]
fn the_document_pattern_admits_a_document_origin_and_nothing_else() {
    for file in ["documents.json", "rig.json"] {
        let got = urls(file);
        assert_eq!(got.len(), 1, "{file}");
        let p: RemoteUrlPattern = got[0].parse().unwrap();
        for good in [format!("http://bento.{HEX}.localhost/"), format!("http://bento.{HEX}.localhost/#x"), format!("http://bento.{HEX}.localhost/?q=1")] {
            assert!(admitted(&p, &good), "{file}: {good}");
        }
        for bad in [
            "http://bento.evil.localhost/".to_string(),
            "http://bento.a.b.c.localhost/".to_string(),
            "http://bento.localhost/".to_string(),
            format!("http://bento.{}.localhost/", &HEX[..23]),
            format!("http://bento.{HEX}0.localhost/"),
            format!("http://bento.{}.localhost/", HEX.replace('a', "g")),
            format!("http://bento.x.{HEX}.localhost/"),
            format!("http://{HEX}.localhost/"),
            format!("https://bento.{HEX}.localhost/"),
            format!("http://bento.{HEX}.localhost:8080/"),
            format!("http://bento.{HEX}.example/"),
        ] {
            assert!(!admitted(&p, &bad), "{file}: {bad}");
        }
    }
}

/// The glob this replaced, under the same rules: what the tight form closes.
#[test]
fn control_the_old_glob_admitted_a_host_that_is_no_document() {
    let p: RemoteUrlPattern = "http://bento.*.localhost/*".parse().unwrap();
    assert!(admitted(&p, "http://bento.evil.localhost/"));
    assert!(admitted(&p, "http://bento.a.b.c.localhost/"));
}
