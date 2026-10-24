// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// bento/home for Windows and Linux (bento/connect H2).
//
// Opens the Bento documents the OS hands it (argv), saves them in place
// through home/bridge.js, and serves each one from its own origin:
// - The host reads a file ONCE and serves exactly those bytes. Gate 1 (the
//   bento-gate1 crate, held to home/fixtures/gate1) runs on the bytes at every
//   serve, against the bundled signed release histories (hostcore::trust). A
//   genuine runtime is served under its release's hash-only CSP; anything else
//   opens and edits as an ordinary page, with no CSP and no identity.
// - Every privileged command needs this load's capability secret, armed only
//   after a finished document load and a nonce echo from the same generation,
//   and checked against the webview the call arrived on (hostcore::arming,
//   security §19d/§19e). No Tauri capability file ships: page script reaches no
//   core or plugin command at all.
// - One origin per document (hostcore::origin, §19g/§19i), and one web context
//   (data directory, hence one web process) per document (§19h).
// - The main frame never leaves the document: a navigation away is sent back
//   and opened in the system browser (§19e 1).
// - While a document is sealed or password-protected, its window title is the
//   neutral app name, matching the saved file's title (§30).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use bento_hostcore::{
    arming::{main_frame_load, navigation_allowed, Bounce, Load, Registry},
    origin::{self, Index},
    trust::{Trust, Verdict},
};
use std::{fs, path::PathBuf, sync::Mutex};
use tauri::{http, webview::PageLoadEvent, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

#[cfg(feature = "rig")]
mod rig;

mod histories {
    include!(concat!(env!("OUT_DIR"), "/histories.rs"));
}

const BRIDGE: &str = include_str!("../../../bridge.js");
const SHIM: &str = include_str!("../shim.js");
/// The neutral title for every title sink while a document is sealed (§30).
const APP_NAME: &str = "Bento";

pub(crate) struct Doc {
    /// The webview label; changes when the watchdog recreates the webview.
    label: String,
    /// "<24 hex>.localhost"
    host: String,
    path: PathBuf,
    name: String,
    /// Exactly the bytes served. Replaced only by the host's own write.
    bytes: Vec<u8>,
    /// Main-frame load starts seen (the watchdog's progress counter).
    starts: u64,
    /// How many times the watchdog has recreated this document's webview.
    rebuilds: u32,
}

pub(crate) struct Host {
    docs: Vec<Doc>,
    reg: Registry,
    trust: Trust,
    salt: Vec<u8>,
    index: Index,
    data_dir: PathBuf,
}

pub(crate) type Shared = Mutex<Host>;

fn doc_url(host: &str) -> String {
    // Windows: wry serves custom schemes at http://<scheme>.<host>/, and
    // *.localhost keeps it a secure context. Per-document origins there are
    // UNMEASURED until the WebView2 rigs run (H2 is held until then).
    if cfg!(windows) { format!("http://bento.{host}/") } else { format!("bento://{host}/") }
}

fn title_for(name: &str, bytes: &[u8]) -> String {
    if origin::is_envelope(bytes) { APP_NAME.to_string() } else { format!("{name} — {APP_NAME}") }
}

fn reply(id: &serde_json::Value, r: Result<serde_json::Value, String>) -> String {
    match r {
        Ok(v) => serde_json::json!({ "id": id, "ok": true, "value": v }),
        Err(e) => serde_json::json!({ "id": id, "ok": false, "value": e }),
    }
    .to_string()
}

/// Write beside, then rename over: a crash mid-write never leaves a torn file.
fn write_atomic(path: &PathBuf, text: &str) -> Result<(), String> {
    let tmp = path.with_extension("bento-tmp");
    fs::write(&tmp, text).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// The page echoes the nonce it was handed with this load's secret.
#[tauri::command]
fn bento_arm(app: tauri::AppHandle, webview: tauri::Webview, nonce: String, cap: String) -> Result<(), String> {
    let s = app.state::<Shared>();
    let mut h = s.lock().unwrap();
    let label = webview.label().to_string();
    let load = h.reg.loads.get_mut(&label).ok_or("unknown webview")?;
    let r = load.confirm(&nonce, &cap).map_err(str::to_string);
    eprintln!("ARM {label} generation {}: {}", load.generation, if r.is_ok() { "ARMED".to_string() } else { format!("REFUSED {r:?}") });
    r
}

/// The one file transport op set, the same message shapes as iOS and Android
/// (begin / read / write), so bridge.js stays the shared file.
#[tauri::command]
async fn bento_file(app: tauri::AppHandle, webview: tauri::Webview, msg: String, cap: Option<String>) -> String {
    let m: serde_json::Value = match serde_json::from_str(&msg) { Ok(m) => m, Err(_) => return String::new() };
    let id = m["id"].clone();
    let state = app.state::<Shared>();
    let label = webview.label().to_string();
    let i = {
        let h = state.lock().unwrap();
        if let Err(e) = h.reg.check(&label, cap.as_deref()) {
            eprintln!("IPC bento_file op={} id={id} webview={label} REFUSED: {e}", m["op"]);
            return reply(&id, Err(e.into()));
        }
        eprintln!("IPC bento_file op={} id={id} webview={label} OK", m["op"]);
        match h.docs.iter().position(|d| d.label == label) { Some(i) => i, None => return reply(&id, Err("unknown webview".into())) }
    };
    // File-scoped: whatever the verdict, it reaches THIS document's own file
    // and the exports the user chose for it, nothing else.
    let r = match m["op"].as_str() {
        Some("begin") => {
            let mut h = state.lock().unwrap();
            let load = h.reg.loads.get_mut(&label).unwrap();
            if !load.handed_out {
                load.handed_out = true;
                Ok(h.docs[i].name.clone().into())
            } else if m["launch"].as_bool() == Some(true) {
                Err("the open document was already handed out".into())
            } else {
                let want = m["suggestedName"].as_str().unwrap_or("Untitled.bento.html").to_string();
                let dir = h.docs[i].path.parent().map(|p| p.to_path_buf());
                drop(h);
                let mut d = app.dialog().file().set_file_name(&want);
                if let Some(dir) = dir { d = d.set_directory(dir) }
                match d.blocking_save_file().and_then(|p| p.into_path().ok()) {
                    None => Err("cancelled".into()),
                    Some(p) => {
                        let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                        let mut h = state.lock().unwrap();
                        if h.docs.get(i).map(|d| d.label != label).unwrap_or(true) {
                            Err("the document's window changed".into())
                        } else if name == h.docs[i].name {
                            Err("choose a different name from the open document".into())
                        } else {
                            h.reg.loads.get_mut(&label).unwrap().exports.insert(name.clone(), p);
                            Ok(name.into())
                        }
                    }
                }
            }
        }
        Some("read") => {
            let h = state.lock().unwrap();
            let d = &h.docs[i];
            if m["name"].as_str() == Some(d.name.as_str()) { Ok(String::from_utf8_lossy(&d.bytes).into_owned().into()) } else { Err("only the open document is readable".into()) }
        }
        Some("write") => {
            let text = m["text"].as_str().unwrap_or("").to_string();
            let name = m["name"].as_str().unwrap_or("").to_string();
            let mut guard = state.lock().unwrap();
            let h = &mut *guard;
            if name == h.docs[i].name {
                let path = h.docs[i].path.clone();
                write_atomic(&path, &text).map(|_| {
                    h.index.host_wrote(&h.salt, &path, &origin::file_id(&path));
                    // The NEXT load serves these bytes, and is verified then.
                    h.docs[i].bytes = text.into_bytes();
                    let title = title_for(&h.docs[i].name, &h.docs[i].bytes);
                    if let Some(w) = app.get_webview_window(&label) { let _ = w.set_title(&title); }
                    serde_json::Value::Null
                })
            } else if let Some(p) = h.reg.loads.get(&label).and_then(|l| l.exports.get(&name)).cloned() {
                write_atomic(&p, &text).map(|_| serde_json::Value::Null)
            } else {
                Err("no such handle".into())
            }
        }
        _ => Err("unknown op".into()),
    };
    reply(&id, r)
}

/// Build (or rebuild) the webview for document `i`.
fn open_window(app: &tauri::AppHandle, i: usize) -> tauri::Result<()> {
    let (label, host, title, data) = {
        let s = app.state::<Shared>();
        let h = s.lock().unwrap();
        let d = &h.docs[i];
        // §19h: one WEB CONTEXT per document: its own data directory, named
        // from the origin hash (never the file name or docId). Tauri keys web
        // contexts by data directory, so documents never share a web process.
        let data = h.data_dir.join("web").join(d.host.trim_end_matches(".localhost"));
        (d.label.clone(), d.host.clone(), title_for(&d.name, &d.bytes), data)
    };
    {
        let s = app.state::<Shared>();
        s.lock().unwrap().reg.loads.insert(label.clone(), Load::default());
    }
    let own = doc_url(&host);
    // `;` between the parts: each is an IIFE, and `})()\n(function…` parses as
    // ONE call expression (measured: bridge.js never ran).
    #[allow(unused_mut)]
    let mut init = format!("{SHIM};\n{BRIDGE};\n");
    #[cfg(feature = "rig")]
    { init = rig::init_script(app, &label, init); }
    WebviewWindowBuilder::new(app, &label, WebviewUrl::CustomProtocol(own.parse().unwrap()))
        .data_directory(data)
        .title(title)
        .inner_size(1280.0, 800.0)
        // main frame only
        .initialization_script(&init)
        // Fires for iframes too, with no frame identity: allow the document and
        // https (live embeds); the MAIN frame's lock is in on_page_load.
        .on_navigation({
            let own = own.clone();
            let app_h = app.clone();
            let label = label.clone();
            move |url| {
                let ok = navigation_allowed(url.as_str(), &own);
                if url.as_str() == own { watchdog(app_h.clone(), label.clone()) }
                if !ok { eprintln!("NAVIGATION BLOCKED {} -> {}", label, &url.as_str()[..url.as_str().len().min(80)]) }
                ok
            }
        })
        .on_page_load({
            let own = own.clone();
            move |w, p| {
                let app = w.app_handle().clone();
                let s = app.state::<Shared>();
                let mut h = s.lock().unwrap();
                let label = w.label().to_string();
                let url = p.url().as_str().to_string();
                if p.event() == PageLoadEvent::Started {
                    if let Some(d) = h.docs.iter_mut().find(|d| d.label == label) { d.starts += 1 }
                    if let Some(l) = h.reg.loads.get_mut(&label) { l.load_started() }
                    match main_frame_load(&url, &own) {
                        Bounce::Stay => {}
                        b => {
                            eprintln!("BOUNCE {label}: main frame left the document for {}", &url[..url.len().min(80)]);
                            drop(h);
                            if let Bounce::BackAndOpen(ext) = b { let _ = app.opener().open_url(ext, None::<&str>); }
                            let _ = w.navigate(own.parse().unwrap());
                        }
                    }
                    return;
                }
                let Some(l) = h.reg.loads.get_mut(&label) else { return };
                if let Some(a) = l.load_finished(url == own) {
                    eprintln!("PENDING {label} generation {} url={url}", a.generation);
                    let _ = w.eval(&format!("window.__bentoArm && window.__bentoArm({:?}, {:?})", a.cap, a.nonce));
                }
            }
        })
        .build()?;
    Ok(())
}

/// WebKitGTK sometimes passes the navigation policy for a reload of a page
/// served without a script-restricting CSP and then never requests the
/// document (measured: about 1 in 4 such reloads). If no load starts within
/// 4 s, the webview is RECREATED (see `recreate`).
fn watchdog(app: tauri::AppHandle, label: String) {
    let seen = {
        let s = app.state::<Shared>();
        let h = s.lock().unwrap();
        h.docs.iter().find(|d| d.label == label).map(|d| d.starts)
    };
    let Some(seen) = seen else { return };
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(4));
        if recreate(&app, &label, Some(seen), 0) { eprintln!("WATCHDOG {label}: the load never started; recreated the webview") }
    });
}

/// Replace a document's webview with a fresh one (security, watchdog ruling):
/// - a NEW label (doc0 -> doc0_r1), so late IPC from the dying webview can never be attributed
///   to its replacement;
/// - the old label's Load is removed in the SAME locked step that switches the
///   document to the new label, so from that instant the old webview's calls
///   are refused ("unknown webview") and only one label is live;
/// - the new window is built and the old one destroyed in ONE main-thread step;
/// - the new webview starts from zero: a fresh Load (generation 0, nothing
///   armed), gate 1 re-run at its serve, arming from PENDING like any load.
/// `expect_starts`: recreate only if no load has started since (the watchdog).
/// `delay_ms`: rigs only, to let the old page try its dead secret first.
pub(crate) fn recreate(app: &tauri::AppHandle, label: &str, expect_starts: Option<u64>, delay_ms: u64) -> bool {
    let (i, new_label) = {
        let s = app.state::<Shared>();
        let mut h = s.lock().unwrap();
        let Some(i) = h.docs.iter().position(|d| d.label == label) else { return false };
        if expect_starts.is_some_and(|n| h.docs[i].starts != n) || h.docs[i].rebuilds >= 3 { return false }
        h.docs[i].rebuilds += 1;
        // Tauri labels allow only [A-Za-z0-9-/:_]
        let base = label.split("_r").next().unwrap_or(label).to_string();
        let new_label = format!("{base}_r{}", h.docs[i].rebuilds);
        h.docs[i].label = new_label.clone();
        h.reg.loads.remove(label);
        (i, new_label)
    };
    eprintln!("RECREATE {label} -> {new_label}");
    let (app2, old) = (app.clone(), label.to_string());
    std::thread::spawn(move || {
        if delay_ms > 0 { std::thread::sleep(std::time::Duration::from_millis(delay_ms)) }
        let app3 = app2.clone();
        // Build the replacement first, then destroy the old window, in this one
        // step: destroying first closes the app's last window, and Tauri exits.
        // The old label's Load is already gone, so only the new label can act.
        let _ = app2.run_on_main_thread(move || match open_window(&app3, i) {
            Ok(()) => {
                if let Some(w) = app3.get_webview_window(&old) { let _ = w.destroy(); }
            }
            // never leave the user with no window; the old one is already dead to IPC
            Err(e) => eprintln!("RECREATE FAILED {old}: {e}"),
        });
    });
    true
}

#[cfg(not(feature = "rig"))]
fn handlers() -> impl Fn(tauri::ipc::Invoke) -> bool {
    tauri::generate_handler![bento_arm, bento_file]
}
#[cfg(feature = "rig")]
fn handlers() -> impl Fn(tauri::ipc::Invoke) -> bool {
    tauri::generate_handler![bento_arm, bento_file, rig::rig_stash, rig::rig_done, rig::rig_recreate]
}

fn data_dir() -> PathBuf {
    if let Some(d) = std::env::var_os("BENTO_DATA_DIR") { return PathBuf::from(d) }
    let base = if cfg!(windows) { std::env::var_os("LOCALAPPDATA") } else { std::env::var_os("XDG_DATA_HOME") }
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
        .unwrap_or_else(std::env::temp_dir);
    base.join("bento-home")
}

fn main() {
    let data_dir = data_dir();
    let (trust, notes) = Trust::load(histories::BUNDLED, &data_dir.join("floor"));
    for n in notes { eprintln!("trust: {n}") }
    eprintln!("trust: holding {:?}", trust.apps());
    let salt = origin::install_salt(&data_dir);
    let mut index = Index::open(Some(&data_dir.join("origins.json")));

    let files: Vec<PathBuf> = std::env::args().skip(1).filter(|a| !a.starts_with('-')).map(PathBuf::from).collect();
    if files.is_empty() {
        eprintln!("usage: bento-home-desktop <document.bento.html>…");
        std::process::exit(2);
    }
    let mut docs = vec![];
    for (n, p) in files.iter().enumerate() {
        let Ok(p) = fs::canonicalize(p) else { eprintln!("cannot open {}", p.display()); continue };
        let Ok(bytes) = fs::read(&p) else { eprintln!("cannot read {}", p.display()); continue };
        let host = origin::origin_at_open(&salt, &p, &bytes, &mut index);
        match trust.verdict(&bytes) {
            Verdict::Genuine { app, version, .. } => eprintln!("opened doc{n}: {app} {version}"),
            Verdict::Unknown { reason } => eprintln!("opened doc{n}: unknown ({reason})"),
        }
        docs.push(Doc { label: format!("doc{n}"), host, name: p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(), path: p, bytes, starts: 0, rebuilds: 0 });
    }
    if docs.is_empty() { std::process::exit(1) }
    let count = docs.len();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Mutex::new(Host { docs, reg: Registry::default(), trust, salt, index, data_dir }))
        .register_uri_scheme_protocol("bento", |ctx, req| {
            let not_found = || http::Response::builder().status(404).body(Vec::new()).unwrap();
            let state = ctx.app_handle().state::<Shared>();
            let mut guard = state.lock().unwrap();
            let h = &mut *guard;
            let (host, rest) = (req.uri().host().unwrap_or("").to_string(), req.uri().path().to_string());
            let label = ctx.webview_label().to_string();
            // A document's origin serves only its root, and only to a webview that
            // document was opened in (the same file opened twice shares its origin).
            if rest != "/" { eprintln!("PROTO REFUSED {label} {host}{rest}"); return not_found() }
            let Some(d) = h.docs.iter().find(|d| d.host == host && d.label == label) else {
                eprintln!("PROTO REFUSED {label} {host}{rest}");
                return not_found();
            };
            let mut res = http::Response::builder()
                .header("Content-Type", "text/html; charset=utf-8")
                .header("Cache-Control", "no-store")
                // §19f(3): no document.domain relaxation across sibling origins.
                .header("Origin-Agent-Cluster", "?1");
            // Gate 1 on exactly these bytes, now.
            let verdict = h.trust.verdict(&d.bytes);
            let genuine = matches!(verdict, Verdict::Genuine { .. });
            if let Verdict::Genuine { csp, .. } = &verdict { res = res.header("Content-Security-Policy", csp.as_str()) }
            let body = d.bytes.clone();
            if let Some(l) = h.reg.loads.get_mut(&label) { l.served(genuine) }
            eprintln!("SERVED {label} {} bytes, {}", body.len(), if genuine { "genuine (pinned CSP)" } else { "unknown (no CSP)" });
            res.body(body).unwrap()
        })
        .invoke_handler(handlers())
        .setup(move |app| {
            for i in 0..count { open_window(app.handle(), i)? }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("bento/home failed to start");
}
