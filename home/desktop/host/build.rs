// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Bundles the signed release histories into the binary. The release build puts
// the PUBLISHED releases/<app>/history.json files in ./releases (gitignored);
// rigs point BENTO_HISTORIES_DIR at home/fixtures/gate1. Every *history*.json
// under that directory, at any depth, is embedded. The host verifies each one
// against the pinned key at launch: embedding is not trusting.

use std::path::{Path, PathBuf};

fn collect(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = rd.flatten().map(|e| e.path()).collect();
    entries.sort();
    for p in entries {
        if p.is_dir() {
            collect(&p, out)
        } else if p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.ends_with(".json") && n.contains("history")) {
            out.push(p)
        }
    }
}

fn main() {
    println!("cargo:rerun-if-env-changed=BENTO_HISTORIES_DIR");
    let dir = std::env::var_os("BENTO_HISTORIES_DIR").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("releases"));
    println!("cargo:rerun-if-changed={}", dir.display());
    let mut files = vec![];
    collect(&dir, &mut files);
    let mut src = String::from("pub const BUNDLED: &[&str] = &[\n");
    for f in &files {
        let abs = std::fs::canonicalize(f).unwrap();
        println!("cargo:rerun-if-changed={}", abs.display());
        src.push_str(&format!("    include_str!({:?}),\n", abs.display().to_string()));
    }
    src.push_str("];\n");
    std::fs::write(PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("histories.rs"), src).unwrap();
    // Windows only: Tauri there calls only http://bento.localhost "local"; the per-document
    // origins http://bento.<hex>.localhost are "remote" and are refused every custom command
    // unless a remote capability names them (see capabilities-windows/documents.json). The
    // other platforms are unchanged: no manifest, no capability file. bento_id stays in the
    // manifest because the handler exists; only a rig capability grants it.
    let mut attrs = tauri_build::Attributes::new();
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        println!("cargo:rerun-if-changed=capabilities-windows");
        println!("cargo:rerun-if-env-changed=BENTO_RIG_SHIPPED_ACL");
        let rig = std::env::var_os("CARGO_FEATURE_RIG").is_some();
        let commands: &'static [&'static str] = if rig {
            &["bento_arm", "bento_file", "bento_id", "rig_stash", "rig_done", "rig_recreate"]
        } else {
            &["bento_arm", "bento_file", "bento_id"]
        };
        attrs = attrs
            .app_manifest(tauri_build::AppManifest::new().commands(commands))
            .capabilities_path_pattern(match (rig, std::env::var_os("BENTO_RIG_SHIPPED_ACL").is_some()) {
                (false, _) => "capabilities-windows/documents.json",
                (true, false) => "capabilities-windows/*.json",
                // The rig's shipped-ACL build: every file but rig-embed.json, so an embed
                // meets the ACL that ships. rig/check.py checks that the file really is gone.
                (true, true) => "capabilities-windows/*[!d].json",
            });
    }
    tauri_build::try_build(attrs).expect("failed to run the tauri build script")
}
