// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// What the OS says about the person's session, shared between the host's
// watcher and the agent (security's ruling on #893: a machine locked or asleep
// must not go on signing).
//
// One atomic word, deliberately not behind the agent's mutex: the host holds
// that mutex while a dialog is on screen, and a lock that arrives then has to
// take effect at once, not when the dialog closes.
//
// A routine session is valid only for the epoch it opened in. Everything that
// ends sessions moves the epoch, so nothing can restore one: an unlock, a
// wake-up or a bus coming back only makes it POSSIBLE to open a new session,
// which still takes the person.
//
// It starts closed. Until a watcher has actually reached the OS and read the
// current state, nobody is listening for a lock, so no session may open.

use std::sync::atomic::{AtomicU64, Ordering::SeqCst};
use std::sync::Arc;

const WATCHED: u64 = 1;
const LOCKED: u64 = 2;
const EPOCH: u64 = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GateState {
    /// Someone is listening and the screen is not locked. The value is the epoch.
    Open(u64),
    /// The OS says the session is locked: nobody can answer a prompt.
    Locked,
    /// Nothing is listening (no bus, no logind, no session): closed until that changes.
    Unwatched,
}

#[derive(Debug, Default)]
pub struct LockGate(AtomicU64);

impl LockGate {
    pub fn new() -> Arc<Self> {
        Arc::new(LockGate::default())
    }

    pub fn state(&self) -> GateState {
        let s = self.0.load(SeqCst);
        if s & WATCHED == 0 {
            GateState::Unwatched
        } else if s & LOCKED != 0 {
            GateState::Locked
        } else {
            GateState::Open(s / EPOCH)
        }
    }

    fn update(&self, f: impl Fn(u64) -> u64) {
        let mut s = self.0.load(SeqCst);
        while let Err(now) = self.0.compare_exchange(s, f(s), SeqCst, SeqCst) {
            s = now;
        }
    }

    /// The session was locked or the machine is going to sleep: every open
    /// routine session ends.
    pub fn lock(&self) {
        self.update(|s| s + EPOCH);
    }

    /// The OS's own locked flag. Going locked ends sessions; going unlocked ends
    /// nothing and opens nothing.
    pub fn set_locked(&self, locked: bool) {
        self.update(|s| match (locked, s & LOCKED != 0) {
            (true, false) => (s | LOCKED) + EPOCH,
            (false, _) => s & !LOCKED,
            (true, true) => s,
        });
    }

    /// The watcher reached the OS and read `locked` from it.
    pub fn watched(&self, locked: bool) {
        self.update(|s| s | WATCHED);
        self.set_locked(locked);
    }

    /// The watcher lost the OS: every open session ends, and none opens.
    pub fn lost(&self) {
        self.update(|s| (s & !WATCHED) + EPOCH);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_closed_until_something_is_listening() {
        let g = LockGate::new();
        assert_eq!(g.state(), GateState::Unwatched);
        g.watched(false);
        assert!(matches!(g.state(), GateState::Open(_)));
    }

    #[test]
    fn every_ending_moves_the_epoch_and_no_recovery_moves_it_back() {
        let g = LockGate::new();
        g.watched(false);
        let GateState::Open(e0) = g.state() else { panic!() };
        g.lock();
        let GateState::Open(e1) = g.state() else { panic!() };
        assert!(e1 > e0, "lock");
        g.set_locked(true);
        assert_eq!(g.state(), GateState::Locked);
        g.set_locked(false);
        let GateState::Open(e2) = g.state() else { panic!() };
        assert!(e2 > e1, "going locked");
        g.lost();
        assert_eq!(g.state(), GateState::Unwatched);
        g.watched(false);
        let GateState::Open(e3) = g.state() else { panic!() };
        assert!(e3 > e2, "losing the watcher");
    }

    #[test]
    fn a_repeated_flag_changes_nothing_and_a_watcher_can_start_locked() {
        let g = LockGate::new();
        g.watched(true);
        assert_eq!(g.state(), GateState::Locked);
        g.set_locked(true);
        g.set_locked(false);
        let GateState::Open(e) = g.state() else { panic!() };
        g.set_locked(false);
        assert_eq!(g.state(), GateState::Open(e), "already unlocked: the session lives on");
    }

    #[test]
    fn unwatched_outranks_locked() {
        let g = LockGate::new();
        g.watched(true);
        g.lost();
        assert_eq!(g.state(), GateState::Unwatched);
    }
}
