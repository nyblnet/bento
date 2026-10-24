// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// RIG BUILDS ONLY (feature "rig"): the security §19d–§19h probe. Compiled out
// of every shipped build, and inert unless BENTO_PROBE_<label> names a report
// file for that webview.

use crate::Shared;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::Manager;

const PROBE: &str = include_str!("../rig/probe.js");

/// A dead drop between windows, standing in for an attacker exfiltrating a
/// value over the network. Deliberately unauthenticated: the attacker HAS a
/// network.
static STASH: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

fn base(label: &str) -> &str {
    label.split("_r").next().unwrap_or(label)
}

/// The main-frame init script for a rig webview: the shim exposes the armed
/// capability to the probe, and the probe runs after the bridge.
pub fn init_script(app: &tauri::AppHandle, label: &str, init: String) -> String {
    let b = base(label);
    if std::env::var_os(format!("BENTO_PROBE_{b}")).is_none() { return init }
    let s = app.state::<Shared>();
    let h = s.lock().unwrap();
    let labels: Vec<String> = h.docs.iter().map(|d| base(&d.label).to_string()).collect();
    let peer = std::env::var(format!("BENTO_PEER_{b}")).unwrap_or_else(|_| labels.iter().find(|l| l.as_str() != b).cloned().unwrap_or_default());
    let init = init.replacen("armed = true\n", "armed = true; window.__rigCap = cap\n", 1);
    assert!(init.contains("window.__rigCap = cap"), "rig: the shim's arming line moved");
    format!(
        "{init}window.__RIG_INVOKE_KEY={:?};window.__RIG_LABEL={b:?};window.__RIG_FULL_LABEL={label:?};window.__RIG_WATCHDOG={};window.__RIG_PEER={peer:?};window.__RIG_ALL={:?};\n{PROBE};\n",
        app.invoke_key(),
        std::env::var_os("BENTO_RIG_WATCHDOG").is_some(),
        labels.join(","),
    )
}

#[tauri::command]
pub fn rig_stash(key: String, value: Option<String>) -> Option<String> {
    let mut g = STASH.lock().unwrap();
    let m = g.get_or_insert_with(HashMap::new);
    if let (true, Some(v)) = (key.ends_with(".step"), &value) { eprintln!("STEP {key} = {v}") }
    match value {
        Some(v) => {
            m.insert(key, v);
            None
        }
        None => m.get(&key).cloned(),
    }
}

#[tauri::command]
pub fn rig_done(app: tauri::AppHandle, webview: tauri::Webview, report: serde_json::Value) {
    let s = app.state::<Shared>();
    let h = s.lock().unwrap();
    let label = webview.label().to_string();
    let Some(d) = h.docs.iter().find(|d| d.label == label) else { return };
    let on_disk = std::fs::read(&d.path).unwrap_or_default();
    let verdict_on_disk = match h.trust.verdict(&on_disk) {
        bento_hostcore::trust::Verdict::Genuine { version, .. } => format!("genuine {version}"),
        bento_hostcore::trust::Verdict::Unknown { .. } => "unknown".into(),
    };
    let out = serde_json::json!({
        "webview": label,
        "origin_host": d.host,
        "file": d.path.display().to_string(),
        "verdict_on_disk_after": verdict_on_disk,
        "on_disk_has_marker": String::from_utf8_lossy(&on_disk).contains("desktop-rig-marker"),
        "generation": h.reg.loads.get(&label).map(|l| l.generation),
        "page": report,
    });
    if let Ok(p) = std::env::var(format!("BENTO_PROBE_{}", base(&label))) {
        // the FIRST report stands
        if !std::path::Path::new(&p).exists() { let _ = std::fs::write(p, serde_json::to_string_pretty(&out).unwrap()); }
    }
    eprintln!("RIG REPORT {label}");
    // When every window has reported, linger for rig 5's bounce, then exit 0.
    let all = h.docs.iter().all(|d| std::env::var(format!("BENTO_PROBE_{}", base(&d.label))).map(|p| std::path::Path::new(&p).exists()).unwrap_or(true));
    if all {
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(10));
            let bounced: Vec<String> = STASH.lock().unwrap().as_ref().map(|m| m.iter().filter(|(k, _)| k.ends_with(".bounced-back")).map(|(k, v)| format!("{k}={v}")).collect()).unwrap_or_default();
            eprintln!("RIG BOUNCED-BACK {}", bounced.join(" "));
            app.exit(0)
        });
    }
}

/// The watchdog's recreate path, on demand (rig 9). The 1.5 s delay lets the
/// old page present its now-dead secret before its window is destroyed.
#[tauri::command]
pub fn rig_recreate(app: tauri::AppHandle, webview: tauri::Webview) -> bool {
    crate::recreate(&app, webview.label(), None, 1500)
}
