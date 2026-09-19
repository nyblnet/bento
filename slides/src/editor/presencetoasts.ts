// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// "X joined" / "X left" — said once per real arrival and departure, not once
// per flap. Pure (a clock and a toast function in, no DOM), so
// scripts/test-slides-presence-toasts.ts drives it in node.
//
// WHY. Presence is a heartbeat: every peer beats every few seconds and a peer
// that has not beaten for PEER_TTL is dropped (kernel/src/sync/session.ts).
// Browsers throttle timers in a hidden tab — Chrome to once a MINUTE after
// five minutes in the background, Safari sooner — so a collaborator who
// switched tabs beats late, gets dropped, and comes back on the next beat:
// "Ana left" … "Ana joined" … once a minute, for everyone else in the room,
// while Ana has done nothing. The same for a laptop lid, a tunnel, a Wi-Fi
// handover. Those are not arrivals and departures; they are the transport
// breathing. So: a departure is announced only after it has LASTED (the
// grace), and is cancelled by a return; an arrival is announced only for
// someone not seen recently (a return within the quiet window is a flap).
// The avatar strip still follows presence exactly — this is only what gets
// SAID.

export interface PresencePeer { actor: string; name: string }

export interface PresenceToastOpts {
  toast: (kind: 'joined' | 'left', name: string) => void
  /** a departure must last this long before it is announced */
  leaveGraceMs?: number
  /** a return this soon after being seen is a flap, not an arrival */
  rejoinQuietMs?: number
  /** rooms past this size say nothing (a joiner would see a storm) */
  maxRoom?: number
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (id: unknown) => void
}

export class PresenceToasts {
  private known = new Map<string, string>()
  /** when each actor was last present */
  private lastSeen = new Map<string, number>()
  private pendingLeave = new Map<string, unknown>()
  private readonly grace: number
  private readonly quiet: number
  private readonly maxRoom: number
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (id: unknown) => void

  private readonly opts: PresenceToastOpts

  constructor(opts: PresenceToastOpts, initial: PresencePeer[] = []) {
    this.opts = opts
    this.grace = opts.leaveGraceMs ?? 45_000
    this.quiet = opts.rejoinQuietMs ?? 5 * 60_000
    this.maxRoom = opts.maxRoom ?? 8
    this.now = opts.now ?? (() => Date.now())
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = opts.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>))
    for (const p of initial) { this.known.set(p.actor, p.name); this.lastSeen.set(p.actor, this.now()) }
  }

  /** The room as it is now. Call on every presence change. */
  update(peers: PresencePeer[]) {
    const t = this.now()
    const now = new Map(peers.map((p) => [p.actor, p.name]))
    const quietRoom = now.size > this.maxRoom || this.known.size > this.maxRoom
    for (const [actor, name] of now) {
      const pending = this.pendingLeave.get(actor)
      if (pending !== undefined) {
        // back before the grace ran out: a flap, nothing was said, nothing is
        this.clearTimer(pending); this.pendingLeave.delete(actor)
      } else if (!this.known.has(actor)) {
        const seen = this.lastSeen.get(actor)
        const flap = seen !== undefined && t - seen < this.quiet
        if (!flap && !quietRoom) this.opts.toast('joined', name)
      }
      this.lastSeen.set(actor, t)
    }
    for (const [actor, name] of this.known) {
      if (now.has(actor) || this.pendingLeave.has(actor)) continue
      if (quietRoom) continue
      // gone — say so only if still gone after the grace
      const id = this.setTimer(() => {
        this.pendingLeave.delete(actor)
        this.known.delete(actor)
        this.opts.toast('left', name)
      }, this.grace)
      this.pendingLeave.set(actor, id)
    }
    // a peer that is pending-leave stays "known" until the toast fires or it returns
    const next = new Map(now)
    for (const [actor] of this.pendingLeave) if (!next.has(actor)) next.set(actor, this.known.get(actor) ?? '')
    this.known = next
  }

  /** Stop every pending announcement (the session is closing). */
  dispose() {
    for (const id of this.pendingLeave.values()) this.clearTimer(id)
    this.pendingLeave.clear()
  }
}
