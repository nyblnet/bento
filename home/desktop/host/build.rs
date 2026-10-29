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
    tauri_build::build()
}
