// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Linux: tell the identity agent when the person's session locks or the machine
// sleeps (security's ruling on #893, §2e B), from logind on the system bus.
//
// - `Session.Lock`, `Session.LockedHint` and `Manager.PrepareForSleep(true)` each
//   end the routine session. Nothing here ever opens one: `Unlock` is not even
//   listened to, and a wake-up does nothing.
// - The session is `session/auto`, not the caller's own: an app started from a
//   modern desktop runs in a systemd user scope, outside any logind session, so
//   "my session" would not resolve (measured).
// - Blind means closed. Until every subscription is in place and the flag has
//   been read, the gate stays closed; the bus closing, logind leaving the bus or
//   the session going away all close it again, and this retries.
// - A private connection on its own thread and main context: the app's main loop
//   may be held by a dialog, and the shared GDBus connection exits the process
//   when the bus goes away.
// - LockedHint is always read back from logind, never taken from the signal: on
//   an older GLib a forged signal can reach a well-known-name subscription, and
//   that must not be able to say "unlocked". Forging a lock costs only a prompt.

use bento_id_agent::lockgate::LockGate;
use gio::glib::{self, MainContext, MainLoop, Variant, VariantTy};
use gio::prelude::*;
use gio::{BusType, Cancellable, DBusCallFlags, DBusConnection, DBusConnectionFlags, DBusSignalFlags};
use std::sync::Arc;
use std::time::Duration;

const LOGIND: &str = "org.freedesktop.login1";
const MANAGER_PATH: &str = "/org/freedesktop/login1";
const MANAGER: &str = "org.freedesktop.login1.Manager";
const SESSION: &str = "org.freedesktop.login1.Session";
const SESSION_AUTO: &str = "/org/freedesktop/login1/session/auto";
const PROPERTIES: &str = "org.freedesktop.DBus.Properties";
const CALL_TIMEOUT_MS: i32 = 3000;
const RETRY: Duration = Duration::from_secs(1);

const NO_CANCEL: Option<&Cancellable> = None;

/// Start watching, for the life of the process.
pub fn watch(gate: Arc<LockGate>) {
    std::thread::Builder::new()
        .name("logind-watch".into())
        .spawn(move || {
            let mut said = String::new();
            loop {
                let why = run(&gate).err().unwrap_or_else(|| "logind went away".into());
                gate.lost();
                if why != said {
                    eprintln!("LOGIND closed, nothing signs until it is back: {why}");
                    said = why;
                }
                std::thread::sleep(RETRY);
            }
        })
        .expect("the logind watcher thread");
}

fn prop(c: &DBusConnection, path: &str, name: &str) -> Result<Variant, String> {
    c.call_sync(Some(LOGIND), path, PROPERTIES, "Get", Some(&(SESSION, name).to_variant()), Some(VariantTy::new("(v)").unwrap()), DBusCallFlags::NONE, CALL_TIMEOUT_MS, NO_CANCEL)
        .map_err(|e| format!("{name}: {e}"))?
        .child_value(0)
        .as_variant()
        .ok_or_else(|| format!("{name}: no value"))
}

fn locked_hint(c: &DBusConnection, path: &str) -> Result<bool, String> {
    prop(c, path, "LockedHint")?.get::<bool>().ok_or_else(|| "LockedHint: not a boolean".into())
}

/// `session/auto` is an alias: signals come from the session's real path.
fn session_path(c: &DBusConnection) -> Result<String, String> {
    let id = prop(c, SESSION_AUTO, "Id")?.get::<String>().ok_or("Id: not a string")?;
    let reply = c
        .call_sync(Some(LOGIND), MANAGER_PATH, MANAGER, "GetSession", Some(&(id.as_str(),).to_variant()), Some(VariantTy::new("(o)").unwrap()), DBusCallFlags::NONE, CALL_TIMEOUT_MS, NO_CANCEL)
        .map_err(|e| format!("GetSession: {e}"))?;
    Ok(reply.child_value(0).str().ok_or("GetSession: no path")?.to_string())
}

/// One connection, until it is lost. Returns only when the gate must close.
fn run(gate: &Arc<LockGate>) -> Result<(), String> {
    let ctx = MainContext::new();
    ctx.with_thread_default(|| {
        let addr = gio::dbus_address_get_for_bus_sync(BusType::System, NO_CANCEL).map_err(|e| e.to_string())?;
        let flags = DBusConnectionFlags::AUTHENTICATION_CLIENT | DBusConnectionFlags::MESSAGE_BUS_CONNECTION;
        let c = DBusConnection::for_address_sync(&addr, flags, None, NO_CANCEL).map_err(|e| e.to_string())?;
        let session = session_path(&c)?;
        let main = MainLoop::new(Some(&ctx), false);

        let m = main.clone();
        c.connect_closed(move |_, _, _| m.quit());

        // Subscribed before the flag is read, so no change can fall between them:
        // anything that arrived meanwhile is delivered once the loop runs.
        let g = gate.clone();
        c.signal_subscribe(Some(LOGIND), Some(SESSION), Some("Lock"), Some(&session), None, DBusSignalFlags::NONE, move |_, _, _, _, _, _| g.lock());

        let g = gate.clone();
        c.signal_subscribe(Some(LOGIND), Some(MANAGER), Some("PrepareForSleep"), Some(MANAGER_PATH), None, DBusSignalFlags::NONE, move |_, _, _, _, _, p| {
            if p.child_value(0).get::<bool>() != Some(false) { g.lock() }
        });

        let (g, m, path) = (gate.clone(), main.clone(), session.clone());
        c.signal_subscribe(Some(LOGIND), Some(PROPERTIES), Some("PropertiesChanged"), Some(&session), Some(SESSION), DBusSignalFlags::NONE, move |c, _, _, _, _, _| {
            match locked_hint(c, &path) {
                Ok(locked) => g.set_locked(locked),
                Err(_) => m.quit(),
            }
        });

        let (m, path) = (main.clone(), session.clone());
        c.signal_subscribe(Some(LOGIND), Some(MANAGER), Some("SessionRemoved"), Some(MANAGER_PATH), None, DBusSignalFlags::NONE, move |_, _, _, _, _, p| {
            if p.child_value(1).str() == Some(path.as_str()) { m.quit() }
        });

        let m = main.clone();
        c.signal_subscribe(Some("org.freedesktop.DBus"), Some("org.freedesktop.DBus"), Some("NameOwnerChanged"), Some("/org/freedesktop/DBus"), Some(LOGIND), DBusSignalFlags::NONE, move |_, _, _, _, _, p| {
            if p.child_value(2).str().unwrap_or("").is_empty() { m.quit() }
        });

        let locked = locked_hint(&c, &session)?;
        gate.watched(locked);
        eprintln!("LOGIND watching {session} (locked: {locked})");
        main.run();
        let _ = c.close_sync(NO_CANCEL);
        Ok(())
    })
    .map_err(|e: glib::BoolError| e.to_string())?
}
