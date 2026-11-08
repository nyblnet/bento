// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// RIG BUILDS ONLY (feature "rig"): the security §19d–§19h probe. Compiled out
// of every shipped build, and inert unless BENTO_PROBE_<label> names a report
// file for that webview.

use crate::IdentState;
use crate::Shared;
use bento_id_agent::lockgate::{GateState, LockGate};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::Manager;

const PROBE: &str = include_str!("../rig/probe.js");
const EMBED: &str = include_str!("../rig/embed.html");

/// A dead drop between windows, standing in for an attacker exfiltrating a
/// value over the network. Deliberately unauthenticated: the attacker HAS a
/// network.
static STASH: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

/// The negative control for the Windows Origin-Agent-Cluster rows: with the header
/// at ?0 the same read and the same document.domain write must change, or those
/// rows could never fail.
pub fn oac(shipped: &'static str) -> &'static str {
    if std::env::var_os("BENTO_RIG_OAC_OFF").is_some() { "?0" } else { shipped }
}

/// The ACL rows (Windows): a page at an origin that is not a document, served so
/// that the ONLY thing deciding its fate is the origin pattern in the capability
/// file. Two hosts the pattern must refuse, and one it must admit (the control:
/// 24 hex, so the frame reaches the host and the capability refuses it instead).
pub fn off_document_origin(host: &str) -> Option<tauri::http::Response<Vec<u8>>> {
    if !matches!(host, "evil.localhost" | "a.b.c.localhost" | "0123456789abcdef01234567.localhost") { return None }
    eprintln!("RIG SERVED off-document origin {host}");
    Some(tauri::http::Response::builder().header("Content-Type", "text/html; charset=utf-8").body(EMBED.as_bytes().to_vec()).unwrap())
}

/// The control for the service worker row: a real script at the document's origin, so a
/// refused registration of the document itself is the document's doing, not the engine's.
pub fn sw_script(path: &str) -> Option<tauri::http::Response<Vec<u8>>> {
    if path != "/rig-sw.js" { return None }
    eprintln!("RIG SERVED service worker script");
    Some(tauri::http::Response::builder().header("Content-Type", "text/javascript").body(b"// rig".to_vec()).unwrap())
}

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
    // The race scenario's replacement bytes: the genuine shell the attacker writes.
    let race_g = std::env::var_os("BENTO_RIG_RACE_G").map(|p| std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("rig: cannot read {p:?}: {e}"))).unwrap_or_default();
    format!(
        "{init}window.__RIG_RACE_G={};window.__RIG_RACE_DELAY={};window.__RIG_MODE={:?};window.__RIG_PLAIN_URL={:?};window.__RIG_INVOKE_KEY={:?};window.__RIG_LABEL={b:?};window.__RIG_FULL_LABEL={label:?};window.__RIG_WATCHDOG={};window.__RIG_WEDGE={};window.__RIG_SIGN={};window.__RIG_PEER={peer:?};window.__RIG_ALL={:?};window.__RIG_EMBED_URL={:?};window.__RIG_ROGUE_URL={:?};\n{PROBE};\n",
        // `</` cannot end anything in an init script, but the rig keeps the habit
        serde_json::to_string(&race_g).unwrap().replace("</", "<\\/"),
        std::env::var("BENTO_RIG_RACE_DELAY").ok().and_then(|d| d.parse::<u32>().ok()).unwrap_or(0),
        std::env::var("BENTO_RIG_MODE").unwrap_or_default(),
        std::env::var("BENTO_RIG_PLAIN_URL").unwrap_or_default(),
        app.invoke_key(),
        std::env::var_os("BENTO_RIG_WATCHDOG").is_some(),
        std::env::var_os("BENTO_RIG_WEDGE").is_some(),
        std::env::var_os("BENTO_RIG_SIGN").is_some(),
        labels.join(","),
        // the attacker's page: served by rig/run.sh on loopback, never a third party
        std::env::var("BENTO_RIG_EMBED_URL").unwrap_or_default(),
        std::env::var("BENTO_RIG_ROGUE_URL").unwrap_or_default(),
    )
}

#[tauri::command]
pub fn rig_stash(key: String, value: Option<String>) -> Option<String> {
    let mut g = STASH.lock().unwrap();
    let m = g.get_or_insert_with(HashMap::new);
    if let (true, Some(v)) = (key.ends_with(".step"), &value) { eprintln!("STEP {key} = {v}") }
    // §19h heartbeats: the wedge scenario's shell reads these files, so a page
    // whose web process is stopped is seen to stop counting
    if let (true, Some(v), Ok(dir)) = (key.ends_with(".hb"), &value, std::env::var("BENTO_HB_DIR")) {
        let _ = std::fs::write(std::path::Path::new(&dir).join(&key), v);
    }
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
    // When every window has reported, linger for rig 5's bounce, then exit 0. A
    // scenario with no bounce names a shorter wait.
    let linger = std::env::var("BENTO_RIG_LINGER_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(10_000);
    let all = h.docs.iter().all(|d| std::env::var(format!("BENTO_PROBE_{}", base(&d.label))).map(|p| std::path::Path::new(&p).exists()).unwrap_or(true));
    if all {
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(linger));
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

/// RIG BUILDS ONLY, Linux only. The rig's attacker page is served over https from
/// a loopback port with a THROWAWAY self-signed certificate (rig/run.sh). Instead
/// of adding that certificate to any trust store, trust exactly that certificate
/// here, in this webview's own web context, for the host "127.0.0.1" alone
/// (webkit_web_context_allow_tls_certificate_for_host). No TLS-errors policy is
/// touched: any OTHER certificate for 127.0.0.1 is still rejected, which the rig
/// proves in the same run (a second server with a different certificate must
/// never be loaded). Fails loudly: if the certificate is named and cannot be
/// loaded, the rig process aborts instead of letting every embed report nothing.
#[cfg(target_os = "linux")]
pub fn trust_embed_cert(window: &tauri::WebviewWindow) {
    let Some(path) = std::env::var_os("BENTO_RIG_EMBED_CERT") else { return };
    window
        .with_webview(move |wv| {
            use webkit2gtk::{WebContextExt, WebViewExt};
            let cert = gio::TlsCertificate::from_file(&path).unwrap_or_else(|e| panic!("rig: cannot load the embed certificate {path:?}: {e}"));
            let ctx = wv.inner().context().expect("rig: the webview has no web context");
            ctx.allow_tls_certificate_for_host(&cert, "127.0.0.1");
            eprintln!("RIG TLS: trusted one throwaway certificate for 127.0.0.1 in this webview's context");
        })
        .expect("rig: cannot reach the platform webview");
}

/// RIG BUILDS ONLY, Windows only. The same single-certificate trust as the Linux
/// function above, for WebView2: when the engine reports a certificate error for
/// a request to https://127.0.0.1:<port>, allow it ONLY if the presented
/// certificate is byte-for-byte the rig's throwaway one (compared as PEM). The
/// second server's different certificate is therefore still refused, which the
/// rig proves in the same run. Fails loudly: an unreadable certificate or a
/// webview without the event aborts the rig process.
#[cfg(windows)]
pub fn trust_embed_cert(window: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_14, COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_ALWAYS_ALLOW,
    };
    use windows_core::{Interface, PWSTR};
    fn body(pem: &str) -> String {
        pem.lines().filter(|l| !l.starts_with("-----")).flat_map(|l| l.split_whitespace()).collect()
    }
    let Some(path) = std::env::var_os("BENTO_RIG_EMBED_CERT") else { return };
    let want = body(&std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("rig: cannot read the embed certificate {path:?}: {e}")));
    assert!(!want.is_empty(), "rig: the embed certificate is empty");
    window
        .with_webview(move |wv| unsafe {
            let core = wv.controller().CoreWebView2().expect("rig: the webview has no core");
            let core14: ICoreWebView2_14 = core.cast().expect("rig: this WebView2 runtime has no ServerCertificateErrorDetected (needs 1.0.1293+)");
            let handler = webview2_com::ServerCertificateErrorDetectedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut uri = PWSTR::null();
                args.RequestUri(&mut uri)?;
                let uri = webview2_com::take_pwstr(uri);
                let mut pem = PWSTR::null();
                args.ServerCertificate()?.ToPemEncoding(&mut pem)?;
                let pem = webview2_com::take_pwstr(pem);
                let allow = uri.starts_with("https://127.0.0.1:") && body(&pem) == want;
                eprintln!("RIG TLS: certificate error for {uri}: {}", if allow { "the rig's one certificate, allowed" } else { "refused" });
                if allow {
                    args.SetAction(COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_ALWAYS_ALLOW)?;
                }
                Ok(())
            }));
            let mut token = 0i64;
            core14.add_ServerCertificateErrorDetected(&handler, &mut token).expect("rig: cannot subscribe to certificate errors");
            eprintln!("RIG TLS: trusting one throwaway certificate for 127.0.0.1 in this webview");
        })
        .expect("rig: cannot reach the platform webview");
}

/// The person re-authenticating at the host (what Windows Hello, a TPM PIN or an
/// unlock will be): opens or ends the agent's routine session. The page can
/// never do this in a shipped build; here the rig plays the person.
#[tauri::command]
pub fn rig_session(app: tauri::AppHandle, action: String) -> Result<bool, String> {
    let s = app.state::<IdentState>();
    let mut h = s.lock().unwrap();
    match action.as_str() {
        // false: the agent refused to open one (the screen is locked, or nothing is listening)
        "begin" => return Ok(h.calls.agent.begin_session()),
        "lock" => h.calls.agent.lock(),
        _ => return Err("unknown action".into()),
    }
    Ok(true)
}

/// What the watcher has told the agent, so a probe can wait for a signal to land
/// instead of racing it.
#[tauri::command]
pub fn rig_gate(gate: tauri::State<'_, std::sync::Arc<LockGate>>) -> String {
    format!("{:?}", gate.state())
}

/// Tell the fake logind (rig/fakelogind.py) to act: the rig's stand-in for the
/// screen locking, the lid closing, or logind going away.
#[tauri::command]
pub async fn rig_bus(app: tauri::AppHandle, action: String) -> Result<String, String> {
    let r = bus(&action);
    if action == "bus-down" { bus_down_report(&app) }
    r
}

/// The last row of the lock rig, read here because the page cannot report it:
/// WebKit's network and web processes die with the system bus (measured: their
/// shared GDBus connection exits the process on close). The host does not.
fn bus_down_report(app: &tauri::AppHandle) {
    let gate = app.state::<std::sync::Arc<LockGate>>();
    for _ in 0..60 {
        if gate.state() == GateState::Unwatched { break }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let before = REAUTH_N.load(Ordering::SeqCst);
    let ident = app.state::<IdentState>();
    let mut h = ident.lock().unwrap();
    let frame = format!("AAAAAAAAAAAAAAAA.{}", "A".repeat(22));
    let caller = bento_id_agent::agent::Caller { verified: true, doc_id: None };
    let sign = h.calls.sign(&caller, "rig", "frame", &frame, &mut crate::HostUi { app });
    let out = serde_json::json!({
        "gate": format!("{:?}", gate.state()),
        "begin": h.calls.agent.begin_session(),
        "sign": sign.err().map(|r| r.as_str()).unwrap_or("ok"),
        "prompts": REAUTH_N.load(Ordering::SeqCst) - before,
    });
    if let Ok(p) = std::env::var("BENTO_RIG_BUSDOWN") { std::fs::write(p, out.to_string()).unwrap() }
}

#[cfg(not(target_os = "linux"))]
fn bus(action: &str) -> Result<String, String> {
    Err(format!("no fake logind off Linux ({action})"))
}

#[cfg(target_os = "linux")]
fn bus(action: &str) -> Result<String, String> {
    use gio::prelude::*;
    let none = None::<&gio::Cancellable>;
    let addr = gio::dbus_address_get_for_bus_sync(gio::BusType::System, none).map_err(|e| e.to_string())?;
    let flags = gio::DBusConnectionFlags::AUTHENTICATION_CLIENT | gio::DBusConnectionFlags::MESSAGE_BUS_CONNECTION;
    let c = gio::DBusConnection::for_address_sync(&addr, flags, None, none).map_err(|e| e.to_string())?;
    let r = c.call_sync(Some("com.bento.Rig"), "/com/bento/Rig", "com.bento.Rig", "Do", Some(&(action,).to_variant()), None, gio::DBusCallFlags::NONE, 3000, none);
    r.map(|v| v.to_string()).map_err(|e| e.to_string())
}

/// Moves the agent's clock, so the rig crosses the idle and overall session
/// limits without waiting hours, or sets it BACK (a negative value: the clock-moved-
/// backwards rows). Returns the skew now in force.
#[tauri::command]
pub fn rig_skew(add_ms: i64) -> i64 {
    use std::sync::atomic::Ordering;
    crate::CLOCK_SKEW_MS.fetch_add(add_ms, Ordering::SeqCst) + add_ms
}

// The host's consent prompt, answered by the rig as the person would: counted, and
// DECLINED unless the probe says otherwise. The re-auth refusal notice has nothing to
// answer (Linux v1 has no verifier): it is only counted, and no rig switch can make the
// host verify anyone. Sessions in the rig open through rig_session alone.
static CONSENT_YES: AtomicBool = AtomicBool::new(false);
static CONSENT_N: AtomicU64 = AtomicU64::new(0);
static REAUTH_N: AtomicU64 = AtomicU64::new(0);

pub fn answer_consent() -> bool {
    CONSENT_N.fetch_add(1, Ordering::SeqCst);
    CONSENT_YES.load(Ordering::SeqCst)
}
pub fn count_reauth_notice() {
    REAUTH_N.fetch_add(1, Ordering::SeqCst);
}

#[tauri::command]
pub fn rig_answers(consent: bool) {
    CONSENT_YES.store(consent, Ordering::SeqCst);
}

/// How many times each host prompt was put in front of the person, and which
/// store the host chose.
#[tauri::command]
pub fn rig_counts(app: tauri::AppHandle) -> serde_json::Value {
    let s = app.state::<IdentState>();
    let h = s.lock().unwrap();
    serde_json::json!({ "consent": CONSENT_N.load(Ordering::SeqCst), "reauth": REAUTH_N.load(Ordering::SeqCst), "store": h.kind.name(),
                        "exposure_marker": h.dir.join("exposure-shown").exists() })
}

/// The account setup this host does not have yet, played by the rig: give this
/// device a key in the REAL store (when the rig runs one) and the person a
/// binding, plus one other person's binding learned earlier.
#[tauri::command]
pub fn rig_provision(app: tauri::AppHandle, action: String) -> Result<String, String> {
    use bento_id_agent::book::{Binding, Book};
    #[cfg(target_os = "linux")]
    use bento_id_agent::b64u;
    let s = app.state::<IdentState>();
    #[cfg_attr(not(target_os = "linux"), allow(unused_mut))]
    let mut h = s.lock().unwrap();
    let path = h.dir.join("identity.json");
    match action.as_str() {
        "account" => {
            let mut book = Book::load(&path).map_err(|e| format!("{e:?}"))?;
            book.own = Some(Binding { name: "Rig Person".into(), email: "rig@example.org".into(), vouched_by: "id.bento.page".into(), account_pub: "RIG-ACCOUNT".into() });
            book.observe("RIG-BOB", Binding { name: "Bob Rig".into(), email: "bob@example.org".into(), vouched_by: "id.bento.page".into(), account_pub: "RIG-BOB-ACC".into() }, 4242);
            book.save(&path).map_err(|e| format!("{e:?}"))?;
            Ok("ok".into())
        }
        // a second, different binding for the same key (the key-changed case)
        "changed" => {
            let mut book = Book::load(&path).map_err(|e| format!("{e:?}"))?;
            book.observe("RIG-BOB", Binding { name: "Bob Rig".into(), email: "mallory@example.org".into(), vouched_by: "id.bento.page".into(), account_pub: "RIG-BOB-ACC".into() }, 9999);
            book.save(&path).map_err(|e| format!("{e:?}"))?;
            Ok("ok".into())
        }
        // the real stores exist on Linux only (Windows builds none yet)
        #[cfg(target_os = "linux")]
        "device-key" => match h.calls.agent.store_mut() {
            crate::HostStore::Real(st) => st.create_device_key().map(|p| b64u::enc(&p)).map_err(|e| format!("{e:?}")),
            _ => Err("not the real store".into()),
        },
        #[cfg(target_os = "linux")]
        "wipe" => match h.calls.agent.store_mut() {
            crate::HostStore::Real(st) => st.wipe().map(|_| "ok".into()).map_err(|e| format!("{e:?}")),
            _ => Err("not the real store".into()),
        },
        // how many keyring items this run's profile holds: the TPM store must leave it at 0
        #[cfg(target_os = "linux")]
        "keyring-items" => bento_id_agent::secret_linux::SecretStore::open(&h.profile)
            .and_then(|k| k.count_items())
            .map(|n| n.to_string())
            .map_err(|e| format!("{e:?}")),
        _ => Err("unknown action".into()),
    }
}
