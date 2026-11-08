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
//   security §19d/§19e). That secret is the rule, on every platform. Tauri's own
//   ACL is a second layer: Linux ships no capability file, so page script reaches
//   no core or plugin command, and Windows ships exactly one
//   (capabilities-windows/documents.json, build.rs), because Tauri calls a
//   per-document origin remote there. It admits bento_arm and bento_file to those
//   origins and nothing else: no core or plugin command, and no bento_id, since
//   nothing on Windows can use it until a key store exists.
// - One origin per document (hostcore::origin, §19g/§19i), and one web context
//   (data directory, hence one web process) per document (§19h).
// - The main frame never leaves the document: a navigation away is sent back
//   and opened in the system browser (§19e 1). The navigation policy reaches
//   frames on WebKitGTK only: WebView2 reports the main frame alone, so its
//   frames are held by the pinned CSP (see the on_navigation call below).
// - While a document is sealed or password-protected, its window title is the
//   neutral app name, matching the saved file's title (§30).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use bento_id_agent::agent::{Agent, Caller, Clock, KeyRole, KeyStore, Policy, Prompt, StoreError};
use bento_id_agent::book::Binding;
use bento_id_agent::calls::{Calls, Reauth, Ui};
use bento_id_agent::lockgate::LockGate;
use bento_id_agent::select::Kind;
use bento_hostcore::{
    arming::{is_document, main_frame_load, navigation_allowed, Bounce, Load, Registry},
    origin::{self, Index},
    trust::{Trust, Verdict},
};
use std::{fs, path::PathBuf, sync::Mutex};
use tauri::{http, webview::PageLoadEvent, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

#[cfg(target_os = "linux")]
mod logind;
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

/// The key store the identity agent is built over.
/// - Linux: the TPM where this user can open one, the Secret Service otherwise,
///   and nothing else: never the webview's storage (security §26.3).
/// - Elsewhere: none yet (Windows waits on the runner ruling), so every call
///   that passes the host's gates is answered `no-identity`.
/// - Rig builds can swap in an in-memory key so the session timeout can be
///   driven end to end (security §2e B). The rig build is never shipped:
///   gate-binary.sh fails a binary carrying the rig's commands.
pub(crate) enum HostStore {
    #[cfg(target_os = "linux")]
    Real(bento_id_agent::linux_store::LinuxStore),
    #[cfg(feature = "rig")]
    Memory(bento_id_agent::agent::memory::MemoryStore),
    #[cfg(not(target_os = "linux"))]
    Empty,
}
impl KeyStore for HostStore {
    fn public_key(&self, r: &KeyRole) -> Result<Option<[u8; 65]>, StoreError> {
        match self {
            #[cfg(target_os = "linux")]
            HostStore::Real(s) => s.public_key(r),
            #[cfg(feature = "rig")]
            HostStore::Memory(s) => s.public_key(r),
            #[cfg(not(target_os = "linux"))]
            HostStore::Empty => { let _ = r; Ok(None) }
        }
    }
    fn sign(&mut self, r: &KeyRole, m: &[u8], p: Option<&Prompt>) -> Result<[u8; 64], StoreError> {
        match self {
            #[cfg(target_os = "linux")]
            HostStore::Real(s) => s.sign(r, m, p),
            #[cfg(feature = "rig")]
            HostStore::Memory(s) => s.sign(r, m, p),
            #[cfg(not(target_os = "linux"))]
            HostStore::Empty => { let _ = (r, m, p); Err(StoreError::NoKey) }
        }
    }
    fn has_consent_key(&self) -> bool {
        match self {
            #[cfg(target_os = "linux")]
            HostStore::Real(s) => s.has_consent_key(),
            #[cfg(feature = "rig")]
            HostStore::Memory(s) => s.has_consent_key(),
            #[cfg(not(target_os = "linux"))]
            HostStore::Empty => false,
        }
    }
}

fn new_store(identity_dir: &std::path::Path) -> (HostStore, Kind, String) {
    #[cfg(feature = "rig")]
    if std::env::var_os("BENTO_RIG_REALSTORE").is_none() {
        return (HostStore::Memory(bento_id_agent::agent::memory::MemoryStore::with_keys()), Kind::None, String::new());
    }
    #[cfg(target_os = "linux")]
    {
        // a rig's keyring items are named for the run, never the person's own
        #[cfg(feature = "rig")]
        let profile = format!("rig-{}", std::process::id());
        #[cfg(not(feature = "rig"))]
        let profile = "default".to_string();
        // Rigs only: a software TPM's socket, or a device that is not there (the
        // control that forces the keyring). A shipped build reads neither.
        #[allow(unused_mut)]
        let mut source = bento_id_agent::linux_store::TpmSource::Device(PathBuf::from(bento_id_agent::select::TPM_DEVICE));
        #[cfg(feature = "rig")]
        {
            if let Some(t) = std::env::var_os("BENTO_RIG_TPM_TCTI") { source = bento_id_agent::linux_store::TpmSource::Tcti(t.to_string_lossy().into()) }
            else if let Some(d) = std::env::var_os("BENTO_RIG_TPM_DEVICE") { source = bento_id_agent::linux_store::TpmSource::Device(PathBuf::from(d)) }
        }
        let o = bento_id_agent::linux_store::open_best_with(&profile, identity_dir.join("tpm"), source);
        return (HostStore::Real(o.store), o.kind, profile);
    }
    #[cfg(not(target_os = "linux"))]
    { let _ = identity_dir; (HostStore::Empty, Kind::None, String::new()) }
}

/// The identity agent and what it needs, behind ONE lock of its own: a host
/// dialog is up while it is held, so the document and file commands (which take
/// `Shared`) must not wait on it, and two prompts never stack.
pub(crate) struct Ident {
    pub calls: Calls<HostStore, SysClock>,
    pub kind: Kind,
    pub dir: PathBuf,
    /// the keyring item set this host uses (rigs read it)
    #[allow(dead_code)]
    pub profile: String,
}
pub(crate) type IdentState = Mutex<Ident>;

/// Rig builds only: milliseconds added to the clock, so the rig crosses the
/// agent's one-hour idle and 24-hour overall limits without waiting for them.
#[cfg(feature = "rig")]
pub(crate) static CLOCK_SKEW_MS: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);

pub(crate) struct SysClock;
impl Clock for SysClock {
    fn now_ms(&self) -> u64 {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        #[cfg(feature = "rig")]
        let now = now.saturating_add_signed(CLOCK_SKEW_MS.load(std::sync::atomic::Ordering::SeqCst));
        now
    }
}

pub(crate) type Shared = Mutex<Host>;

fn doc_url(host: &str) -> String {
    // Windows: wry serves custom schemes at http://<scheme>.<host>/, and
    // *.localhost keeps it a secure context. Measured on WebView2: each
    // http://bento.<hex>.localhost/ is its own origin, on one shared profile too.
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
    eprintln!("ARM {label} generation {}: {}", load.generation, if r.is_ok() { format!("ARMED genuine={}", load.armed_genuine()) } else { format!("REFUSED {r:?}") });
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

/// PLACEHOLDER WORDING (maintainer to word). Host-drawn prompts: the person is
/// the only one who can answer them, and the page can draw none of them.
#[cfg_attr(feature = "rig", allow(dead_code))]
const CONSENT_TITLE: &str = "Use your Bento ID?";
#[cfg_attr(feature = "rig", allow(dead_code))]
const REAUTH_TITLE: &str = "Bento ID can't sign right now";

/// What the host shows for the identity calls. Real dialogs in a shipped build;
/// in a rig build the answers are scripted and every prompt is logged and counted.
struct HostUi<'a> {
    app: &'a tauri::AppHandle,
}
impl Ui for HostUi<'_> {
    fn consent(&mut self, doc_name: &str, who: &Binding) -> bool {
        let text = format!(
            "\u{201c}{doc_name}\u{201d} is asking who you are. If you allow it, it will see your name ({}), your address ({}) and who vouches for them ({}). It will not see your keys.",
            who.name, who.email, who.vouched_by
        );
        eprintln!("PROMPT consent doc={doc_name:?}: {text}");
        #[cfg(feature = "rig")]
        { let _ = self.app; return rig::answer_consent() }
        #[cfg(not(feature = "rig"))]
        {
            use tauri_plugin_dialog::{MessageDialogButtons, MessageDialogKind};
            self.app
                .dialog()
                .message(text)
                .title(CONSENT_TITLE)
                .kind(MessageDialogKind::Info)
                .buttons(MessageDialogButtons::OkCancelCustom("Share".into(), "Don't share".into()))
                .blocking_show()
        }
    }
    /// Linux, v1: this host has NO verifier, so it refuses and says so (maintainer,
    /// 2026-11-08: where polkit cannot ask, refuse with a clear message; security
    /// keys only for v1). A presence prompt is never offered in its place. The
    /// security-key verification (a FIDO2 assertion with user verification, which
    /// needs a host-drawn PIN field) is what will answer `Verified` here; until it
    /// is wired every re-authentication on this host is refused. The notice is an
    /// OK-only message: nothing the person can press opens a session.
    fn reauth(&mut self, doc_name: &str) -> Reauth {
        let text = format!(
            "\u{201c}{doc_name}\u{201d} asked to sign something for you, and Bento ID needs to check it is you first. \
             On Linux this version can only check that with a security key, and it does not support one yet, \
             so nothing was signed. Your document is safe and still saves as usual."
        );
        eprintln!("PROMPT reauth-refused doc={doc_name:?}: {text}");
        #[cfg(feature = "rig")]
        { let _ = self.app; rig::count_reauth_notice(); }
        #[cfg(not(feature = "rig"))]
        {
            use tauri_plugin_dialog::{MessageDialogButtons, MessageDialogKind};
            self.app
                .dialog()
                .message(text)
                .title(REAUTH_TITLE)
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::OkCustom("OK".into()))
                .blocking_show();
        }
        Reauth::NoVerifier
    }
}

/// PLACEHOLDER WORDING. Where the key lives in the Secret Service there is no
/// hardware behind it, and the person is told once, the first time the identity
/// is used on that store (security §26.3). The TPM store has nothing to confess
/// beyond what its exposure line says, which the log carries.
fn exposure_notice(app: &tauri::AppHandle, id: &Ident) {
    if id.kind != Kind::SecretService { return }
    let marker = id.dir.join("exposure-shown");
    if marker.exists() { return }
    eprintln!("NOTICE exposure ({}): {}", id.kind.name(), id.kind.exposure());
    #[cfg(not(feature = "rig"))]
    {
        use tauri_plugin_dialog::{MessageDialogButtons, MessageDialogKind};
        app.dialog()
            .message(id.kind.exposure())
            .title("Where your Bento ID key is kept")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCustom("I understand".into()))
            .blocking_show();
    }
    #[cfg(feature = "rig")]
    let _ = app;
    let _ = std::fs::create_dir_all(&id.dir);
    let _ = std::fs::write(marker, b"1");
}

/// The identity calls (whoami, sign, resolve; unwrap and share are not built).
/// Two gates in front of the agent, both HOST-side because Tauri cannot tell
/// frames apart: this webview's capability, then `armed_genuine` (the bytes
/// served for THIS load were genuine). An unknown document gets file commands
/// only. Linux only, because Linux alone has a key store to reach: the rigs have
/// run on both engines, and what stops Windows is the missing store. Widening
/// this gate takes the Windows Hello and TPM measurements on a real PC, in its
/// own PR, with a security run.
#[tauri::command]
async fn bento_id(app: tauri::AppHandle, webview: tauri::Webview, msg: String, cap: Option<String>) -> String {
    let m: serde_json::Value = match serde_json::from_str(&msg) { Ok(m) => m, Err(_) => return String::new() };
    let id = m["id"].clone();
    let label = webview.label().to_string();
    let op = m["op"].as_str().unwrap_or("").to_string();
    // The gates and the facts about the caller, under the document lock; the lock
    // is released BEFORE anything can put a dialog on screen.
    let (doc_id, doc_name) = {
        let state = app.state::<Shared>();
        let h = state.lock().unwrap();
        if let Err(e) = h.reg.check(&label, cap.as_deref()) {
            eprintln!("IPC bento_id op={op} id={id} webview={label} REFUSED: {e}");
            return reply(&id, Err(e.into()));
        }
        if !cfg!(target_os = "linux") {
            eprintln!("IPC bento_id op={op} id={id} webview={label} REFUSED: unavailable (platform)");
            return reply(&id, Err("unavailable".into()));
        }
        if !h.reg.loads.get(&label).map(|l| l.armed_genuine()).unwrap_or(false) {
            eprintln!("IPC bento_id op={op} id={id} webview={label} REFUSED: unavailable (not genuine)");
            return reply(&id, Err("unavailable".into()));
        }
        let d = h.docs.iter().find(|d| d.label == label);
        // Consent is per FILE the host opened, never per docId (security, #918 C1): the
        // key mixes the install salt and the canonical path in, as the origin does.
        let key = d.and_then(|d| origin::doc_id(&d.bytes).map(|id| origin::consent_key(&h.salt, &d.path, &id)));
        (key, d.map(|d| d.name.clone()).unwrap_or_default())
    };
    let caller = Caller { verified: true, doc_id };
    let ident = app.state::<IdentState>();
    let mut guard = ident.lock().unwrap();
    let ig = &mut *guard;
    // bridge.js sends `id.<call>`; the bare names are the rig's own probe.
    let r = match op.strip_prefix("id.").unwrap_or(&op) {
        "whoami" | "sign" => {
            if ig.calls.agent.device_pub().ok().flatten().is_some() { exposure_notice(&app, ig) }
            let mut ui = HostUi { app: &app };
            if op.ends_with("whoami") {
                ig.calls.whoami(&caller, &doc_name, &mut ui).map_err(|r| r.as_str().to_string())
            } else {
                ig.calls
                    .sign(&caller, &doc_name, m["purpose"].as_str().unwrap_or(""), m["payload"].as_str().unwrap_or(""), &mut ui)
                    .map(|s| serde_json::json!({ "sig": s.sig, "pub": s.pub_key }))
                    .map_err(|r| r.as_str().to_string())
            }
        }
        // A key already in the room, from bindings this host already holds; never
        // a prompt and never the network. null is "unknown", the same answer for
        // every key and for a document the person has not allowed.
        "resolve" => ig.calls.resolve(&caller, m["pub"].as_str().unwrap_or("")).map_err(|r| r.as_str().to_string()),
        _ => Err("unavailable".into()),
    };
    eprintln!("IPC bento_id op={op} id={id} webview={label} AGENT: {}", match &r { Ok(_) => "ok".to_string(), Err(e) => e.clone() });
    reply(&id, r)
}

/// PLACEHOLDER WORDING: the maintainer words this message (identity-phase1-plan,
/// H2/I2 security condition 3). It must never claim the file IS newer, and it
/// offers no "trust anyway". Until the update check exists on desktop the only
/// action is to carry on without a Bento ID, so there is one button.
pub(crate) const UNVERIFIED_NOTICE: &str =
    "Bento can't verify this file, so it opens without your Bento ID. It may be from a newer version of Bento.";

/// Tell the person, once when the file is opened, that an unverifiable document
/// gets no identity. The words go to the log in every build, so the rig can hold
/// the host to showing it; the dialog itself is skipped in the rig, where nobody
/// is there to dismiss it.
fn unverified_notice(app: &tauri::AppHandle, name: &str) {
    eprintln!("NOTICE {name}: {UNVERIFIED_NOTICE}");
    #[cfg(not(feature = "rig"))]
    {
        use tauri_plugin_dialog::{MessageDialogButtons, MessageDialogKind};
        app.dialog()
            .message(UNVERIFIED_NOTICE)
            .title(name.to_string())
            .kind(MessageDialogKind::Info)
            .buttons(MessageDialogButtons::OkCustom("Open without Bento ID".into()))
            .show(|_| {});
    }
    #[cfg(feature = "rig")]
    let _ = app;
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
        // RIG BUILDS ONLY: every document on ONE profile, so the rigs can show that
        // the per-document ORIGIN alone separates storage, cookies and channels.
        #[cfg(feature = "rig")]
        let data = if std::env::var_os("BENTO_RIG_SHARED_PROFILE").is_some() { eprintln!("RIG PROFILE shared"); h.data_dir.join("web").join("shared") } else { data };
        (d.label.clone(), d.host.clone(), title_for(&d.name, &d.bytes), data)
    };
    {
        let s = app.state::<Shared>();
        s.lock().unwrap().reg.loads.insert(label.clone(), Load::default());
    }
    let own = doc_url(&host);
    // `;` between the parts: each is an IIFE, and `})()\n(function…` parses as
    // ONE call expression (measured: bridge.js never ran).
    // The 'identity' capability is declared ONLY for a document whose bytes are
    // genuine right now (gate 1): an unverified file then has no agent object at
    // all. The host still re-checks every call (`armed_genuine`), so this is the
    // courtesy, not the lock. bridge.js consumes the declaration at load.
    let genuine_now = {
        let s = app.state::<Shared>();
        let h = s.lock().unwrap();
        matches!(h.trust.verdict(&h.docs[i].bytes), Verdict::Genuine { .. })
    };
    let caps = if genuine_now && cfg!(target_os = "linux") { "window.__bentoHostCaps=['identity'];\n" } else { "" };
    #[allow(unused_mut)]
    let mut init = format!("{caps}{SHIM};\n{BRIDGE};\n");
    #[cfg(feature = "rig")]
    { init = rig::init_script(app, &label, init); }
    #[allow(unused_variables)]
    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::CustomProtocol(own.parse().unwrap()))
        .data_directory(data)
        .title(title)
        .inner_size(1280.0, 800.0)
        // main frame only
        .initialization_script(&init)
        // Allow the document and https (live embeds); the MAIN frame's lock is in
        // on_page_load. WebKitGTK calls this for iframes too, with no frame
        // identity. WebView2 calls it for the main frame ALONE (wry wires it to
        // NavigationStarting, never FrameNavigationStarting), so there a frame's
        // navigation is held by the document's pinned CSP and by nothing here:
        // an unknown document, which has no CSP, can frame http (rig row "d4").
        .on_navigation({
            let own = own.clone();
            let app_h = app.clone();
            let label = label.clone();
            move |url| {
                let ok = navigation_allowed(url.as_str(), &own);
                // Exact on purpose: `own#x` is usually a same-document navigation, which
                // starts no load, and the watchdog would rebuild a healthy webview. So a
                // reload from a fragment URL has no watchdog.
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
                    if let Some(l) = h.reg.loads.get_mut(&label) {
                        l.load_started(is_document(&url, &own));
                        eprintln!("STARTED {label} generation {} url={}", l.generation, &url[..url.len().min(80)]);
                    }
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
                eprintln!("FINISHED {label} generation {} url={}", l.generation, &url[..url.len().min(80)]);
                if let Some(a) = l.load_finished(is_document(&url, &own)) {
                    eprintln!("PENDING {label} generation {} url={url}", a.generation);
                    let _ = w.eval(&format!("window.__bentoArm && window.__bentoArm({:?}, {:?})", a.cap, a.nonce));
                }
            }
        })
        .build()?;
    // A page brought back whole from WebKit's page cache is a load with no document serve, and
    // a serve is the only evidence the verdict has: it would be judged on whatever was fetched
    // before it (measured: an unknown page armed genuine that way, with the document's `no-store`
    // in place). The taint in hostcore is what closes that; this is the second layer.
    #[cfg(target_os = "linux")]
    window.with_webview(|wv| {
        use webkit2gtk::{SettingsExt, WebViewExt};
        let s = WebViewExt::settings(&wv.inner()).expect("the webview has no settings");
        // RIG BUILDS ONLY: the row that shows the taint holds with this layer gone.
        #[cfg(feature = "rig")]
        if std::env::var_os("BENTO_RIG_PAGE_CACHE_ON").is_some() { eprintln!("RIG PAGE CACHE on"); return }
        s.set_enable_page_cache(false);
        assert!(!s.enables_page_cache(), "the page cache stayed on");
    })?;
    #[cfg(all(feature = "rig", any(target_os = "linux", windows)))]
    rig::trust_embed_cert(&window);
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
    tauri::generate_handler![bento_arm, bento_file, bento_id]
}
#[cfg(feature = "rig")]
fn handlers() -> impl Fn(tauri::ipc::Invoke) -> bool {
    tauri::generate_handler![bento_arm, bento_file, bento_id, rig::rig_stash, rig::rig_done, rig::rig_recreate, rig::rig_session, rig::rig_skew, rig::rig_answers, rig::rig_provision, rig::rig_counts, rig::rig_gate, rig::rig_bus]
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

    let identity_dir = data_dir.join("identity");
    let (store, kind, profile) = new_store(&identity_dir);
    eprintln!("KEYSTORE {}: {}", kind.name(), kind.exposure());
    // Closed until a watcher has reached the OS: nothing can sign before someone
    // is listening for a lock. Off Linux no watcher exists yet, and no key store.
    let gate = LockGate::new();
    #[cfg(target_os = "linux")]
    logind::watch(gate.clone());
    #[cfg(all(feature = "rig", not(target_os = "linux")))]
    gate.watched(false);
    let ident: IdentState = Mutex::new(Ident {
        calls: Calls::new(Agent::new(store, SysClock, Policy::default(), gate.clone()), identity_dir.join("identity.json")),
        kind,
        dir: identity_dir,
        profile,
    });

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Mutex::new(Host { docs, reg: Registry::default(), trust, salt, index, data_dir: data_dir.clone() }))
        .manage(ident)
        .manage(gate)
        .register_uri_scheme_protocol("bento", |ctx, req| {
            let not_found = || http::Response::builder().status(404).body(Vec::new()).unwrap();
            let state = ctx.app_handle().state::<Shared>();
            let mut guard = state.lock().unwrap();
            let h = &mut *guard;
            let (host, rest) = (req.uri().host().unwrap_or("").to_string(), req.uri().path().to_string());
            let label = ctx.webview_label().to_string();
            #[cfg(feature = "rig")]
            if let Some(r) = rig::off_document_origin(&host).or_else(|| rig::sw_script(&rest)) { return r }
            // A document's origin serves only its root, and only to a webview that
            // document was opened in (the same file opened twice shares its origin).
            if rest != "/" { eprintln!("PROTO REFUSED {label} {host}{rest}"); return not_found() }
            let Some(d) = h.docs.iter().find(|d| d.host == host && d.label == label) else {
                eprintln!("PROTO REFUSED {label} {host}{rest}");
                return not_found();
            };
            let oac = "?1";
            #[cfg(feature = "rig")]
            let oac = rig::oac(oac);
            let mut res = http::Response::builder()
                .header("Content-Type", "text/html; charset=utf-8")
                .header("Cache-Control", "no-store")
                // §19f(3): no document.domain relaxation across sibling origins.
                .header("Origin-Agent-Cluster", oac);
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
            for i in 0..count {
                open_window(app.handle(), i)?;
                let (unknown, name) = {
                    let s = app.state::<Shared>();
                    let h = s.lock().unwrap();
                    (matches!(h.trust.verdict(&h.docs[i].bytes), Verdict::Unknown { .. }), h.docs[i].name.clone())
                };
                if unknown { unverified_notice(app.handle(), &name) }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("bento/home failed to start");
}
