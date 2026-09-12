// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The two files the starter space ships with — kept here rather than inline in
// starter.ts, the way slides keeps its embedded faces in fontdata.ts, because a
// 13,000-character string in the middle of prose makes the prose unreadable.
//
// BOTH ARE GENERATED, and the commands are here so they can be regenerated
// rather than guessed at. Both were chosen to cost almost nothing once the
// shell is deflated: the drawing is text, and the tone is exactly periodic.
//
//   the tone   ffmpeg -f lavfi -i "sine=frequency=500:duration=1.2:sample_rate=8000" \
//                     -acodec pcm_u8 -ac 1 chime.wav
//              9,678 B of PCM → 12,904 B of base64 → 204 B once deflated. 500 Hz
//              at 8 kHz is 16 samples per period and the length is a whole
//              number of them, so the payload is one short pattern repeated —
//              which is also why it starts and stops without a click.
//   the drawing hand-written SVG, then encodeURIComponent with spaces left
//              alone and apostrophes escaped. 3,175 B → 632 B once deflated.
//
// The drawing is an `asset:` rather than an inline src so the starter exercises
// the table every picked image goes into; the tone is inline because one clip
// referenced once has nothing to dedupe against.

/** The tone on "Tables, pictures and clips" — 1.2s of 500 Hz, so there is
 *  something to press play on. */
export const STARTER_TONE =
  'data:audio/wav;base64,UklGRsYlAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgATElTVBoAAABJTkZPSVNGVA4AAABMYXZmNjIuMTIuMTAyAGRhdGGAJQAAgIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5gIaLjo+Oi4aAeXRxcHF0eYCGi46PjouGgHl0cXBxdHmAhouOj46LhoB5dHFwcXR5'

/** The drawing on the same page: a space, drawn as the one file it is. */
export const STARTER_DIAGRAM =
  'data:image/svg+xml,%3Csvg xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22 width%3D%22640%22 height%3D%22300%22 viewBox%3D%220 0 640 300%22 font-family%3D%22-apple-system%2C Segoe UI%2C Roboto%2C sans-serif%22%3E%3Crect width%3D%22640%22 height%3D%22300%22 rx%3D%2212%22 fill%3D%22%23F6F4EF%22%2F%3E%3Crect x%3D%2224%22 y%3D%2224%22 width%3D%22592%22 height%3D%22252%22 rx%3D%2210%22 fill%3D%22%23FFF%22 stroke%3D%22%231E2A3A%22 stroke-opacity%3D%22.18%22%2F%3E%3Crect x%3D%2224%22 y%3D%2224%22 width%3D%22592%22 height%3D%2234%22 rx%3D%2210%22 fill%3D%22%231E2A3A%22 fill-opacity%3D%22.05%22%2F%3E%3Crect x%3D%2224%22 y%3D%2250%22 width%3D%22592%22 height%3D%228%22 fill%3D%22%231E2A3A%22 fill-opacity%3D%22.05%22%2F%3E%3Ccircle cx%3D%2244%22 cy%3D%2241%22 r%3D%224%22 fill%3D%22%231E2A3A%22 fill-opacity%3D%22.2%22%2F%3E%3Ccircle cx%3D%2258%22 cy%3D%2241%22 r%3D%224%22 fill%3D%22%231E2A3A%22 fill-opacity%3D%22.2%22%2F%3E%3Ccircle cx%3D%2272%22 cy%3D%2241%22 r%3D%224%22 fill%3D%22%231E2A3A%22 fill-opacity%3D%22.2%22%2F%3E%3Ctext x%3D%2292%22 y%3D%2245%22 font-size%3D%2213%22 fill%3D%22%231E2A3A%22 fill-opacity%3D%22.55%22%3EMy space.bento.html%3C%2Ftext%3E%3Crect x%3D%2241%22 y%3D%2275%22 width%3D%22150%22 height%3D%22184%22 rx%3D%226%22 fill%3D%22%231E2A3A%22 fill-opacity%3D%22.04%22%2F%3E%3Cg fill%3D%22%231E2A3A%22 fill-opacity%3D%22.28%22%3E%3Crect x%3D%2257%22 y%3D%2293%22 width%3D%2296%22 height%3D%227%22 rx%3D%223.5%22%2F%3E%3Crect x%3D%2257%22 y%3D%22113%22 width%3D%22118%22 height%3D%227%22 rx%3D%223.5%22%2F%3E%3Crect x%3D%2269%22 y%3D%22133%22 width%3D%2282%22 height%3D%227%22 rx%3D%223.5%22%2F%3E%3Crect x%3D%2269%22 y%3D%22153%22 width%3D%2294%22 height%3D%227%22 rx%3D%223.5%22%2F%3E%3Crect x%3D%2257%22 y%3D%22173%22 width%3D%2274%22 height%3D%227%22 rx%3D%223.5%22%2F%3E%3C%2Fg%3E%3Crect x%3D%2241%22 y%3D%22105%22 width%3D%22150%22 height%3D%2224%22 fill%3D%22%23F7A600%22 fill-opacity%3D%22.16%22%2F%3E%3Crect x%3D%2241%22 y%3D%22105%22 width%3D%223%22 height%3D%2224%22 fill%3D%22%23F7A600%22%2F%3E%3Cg fill%3D%22%231E2A3A%22%3E%3Crect x%3D%22215%22 y%3D%2293%22 width%3D%22196%22 height%3D%2212%22 rx%3D%226%22%2F%3E%3C%2Fg%3E%3Cg fill%3D%22%231E2A3A%22 fill-opacity%3D%22.22%22%3E%3Crect x%3D%22215%22 y%3D%22125%22 width%3D%22368%22 height%3D%228%22 rx%3D%224%22%2F%3E%3Crect x%3D%22215%22 y%3D%22145%22 width%3D%22344%22 height%3D%228%22 rx%3D%224%22%2F%3E%3Crect x%3D%22215%22 y%3D%22165%22 width%3D%22378%22 height%3D%228%22 rx%3D%224%22%2F%3E%3Crect x%3D%22237%22 y%3D%22191%22 width%3D%22290%22 height%3D%228%22 rx%3D%224%22%2F%3E%3Crect x%3D%22237%22 y%3D%22211%22 width%3D%22316%22 height%3D%228%22 rx%3D%224%22%2F%3E%3C%2Fg%3E%3Ccircle cx%3D%22221%22 cy%3D%22195%22 r%3D%224%22 fill%3D%22%231E2A3A%22 fill-opacity%3D%22.22%22%2F%3E%3Ccircle cx%3D%22221%22 cy%3D%22215%22 r%3D%224%22 fill%3D%22%231E2A3A%22 fill-opacity%3D%22.22%22%2F%3E%3Crect x%3D%22215%22 y%3D%22239%22 width%3D%22132%22 height%3D%2220%22 rx%3D%2210%22 fill%3D%22%23F7A600%22 fill-opacity%3D%22.18%22%2F%3E%3Ctext x%3D%22281%22 y%3D%22253%22 font-size%3D%2211%22 text-anchor%3D%22middle%22 fill%3D%22%238a5c00%22%3Ethe editor%2C inside%3C%2Ftext%3E%3C%2Fsvg%3E'

// ————— THE COVERS ————————————————————————————————————————————————————————
//
// Six pages carry a picture across the top, and every one of them is a
// DRAWING OF WHAT THE PAGE IS: the box with compartments is the space, the
// lines are the writing, the three columns are the board. Not a photograph,
// for the reason the diagram above is not one — a photograph would be a
// bitmap of tens of kilobytes shipped in every copy of the app, and would be
// decoration rather than a picture of the thing.
//
// TRANSPARENT GROUND, and that is the decision that makes them work in both
// themes at once: the cover sits on `--chrome-2`, so a drawing with no
// background takes the page's own light or dark ground, and the shapes are
// the mid-tone colours of the field schema (the status blue, amber and green,
// the priority red, the review plum, the backlog grey), which read on either.
// An opaque cream ground would have been a bright slab on a dark page.
//
// One viewBox, 2000×400, and everything that matters sits inside the middle
// 600×280 of it (drawn at 300–900 and shifted by the group). Measured rather
// than assumed: the page cover is a 5–6:1 strip at desktop widths, so a 3:1
// picture lost the top and bottom third of the box; at 5:1 the strip crops
// only the margins. The gallery card is 3:2 and crops the sides instead, and
// both show the middle.
//
// `svgUri` is the encoding: only the characters a data: URI cannot carry are
// escaped, which is a third of the size of encodeURIComponent on the same
// text. The keys beside them are `internAsset`'s own — sha256 of the URI,
// `s` + 22 base64url characters — computed once and asserted by the agent rig
// (interning the same bytes into the starter must return the same key rather
// than mint a `~1` variant). `starterDoc()` is synchronous and the digest is
// not, so the key is written down rather than worked out at boot; the rig is
// what keeps the two from drifting. After editing a drawing, recompute:
//
//   node -e "import('./src/starterdata.ts').then(m => { const c = require('crypto');
//     for (const [n, v] of Object.entries(m.STARTER_COVERS))
//       console.log(n, 's' + c.createHash('sha256').update(v.uri).digest('base64url').slice(0, 22)) })"
//
// Six drawings, 5,681 B of URI between them (614–1,189 B each).

const A = '%23F7A600', B = '%235B8DEF', G = '%232FA37C', P = '%23A97BE0', R = '%23E5484D', S = '%238B95A5'

/** A hand-written SVG as a `data:` URI, escaping only what has to be. */
const svgUri = (body: string): string =>
  'data:image/svg+xml,' + `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 2000 400'><g transform='translate(400)'>${body}</g></svg>`
    .replace(/\s*\n\s*/g, '').replace(/</g, '%3C').replace(/>/g, '%3E')

export interface StarterCover { key: string; uri: string }

/** The six covers, by the page they belong to. */
export const STARTER_COVERS: Record<'home' | 'writing' | 'media' | 'links' | 'tracker' | 'planning', StarterCover> = {
  // the space: one box, with compartments
  home: { key: 'sA5CF4JmFucHJbqnXZp2Klo', uri: svgUri(`
    <rect x='330' y='70' width='540' height='260' rx='22' fill='none' stroke='${S}' stroke-opacity='.7' stroke-width='6'/>
    <rect x='348' y='88' width='208' height='224' rx='12' fill='${A}' fill-opacity='.9'/>
    <rect x='570' y='88' width='134' height='105' rx='12' fill='${B}' fill-opacity='.9'/>
    <rect x='718' y='88' width='134' height='105' rx='12' fill='${G}' fill-opacity='.9'/>
    <rect x='570' y='207' width='282' height='105' rx='12' fill='${P}' fill-opacity='.9'/>
    <g fill='%23fff' fill-opacity='.55'>
      <rect x='368' y='112' width='120' height='10' rx='5'/><rect x='368' y='134' width='150' height='10' rx='5'/><rect x='368' y='156' width='96' height='10' rx='5'/>
      <rect x='590' y='112' width='80' height='10' rx='5'/><rect x='738' y='112' width='60' height='10' rx='5'/>
      <rect x='590' y='231' width='190' height='10' rx='5'/><rect x='590' y='253' width='130' height='10' rx='5'/>
    </g>`) },
  // the writing: lines, a highlight, a link, a coloured word, the caret
  writing: { key: 's1Jd2yy44lrQZAPuRiSZCbd', uri: svgUri(`
    <rect x='330' y='90' width='300' height='22' rx='11' fill='${S}' fill-opacity='.85'/>
    <rect x='480' y='166' width='170' height='26' rx='6' fill='${A}' fill-opacity='.55'/>
    <g fill='${S}' fill-opacity='.45'>
      <rect x='330' y='140' width='540' height='14' rx='7'/><rect x='330' y='172' width='500' height='14' rx='7'/>
      <rect x='330' y='204' width='430' height='14' rx='7'/><rect x='484' y='236' width='366' height='14' rx='7'/>
      <rect x='330' y='268' width='216' height='14' rx='7'/>
    </g>
    <rect x='330' y='236' width='140' height='14' rx='7' fill='${B}' fill-opacity='.9'/>
    <rect x='560' y='268' width='90' height='14' rx='7' fill='${R}' fill-opacity='.85'/>
    <rect x='664' y='263' width='3' height='24' fill='${S}'/>`) },
  // a table, a picture, a clip
  media: { key: 'st-fGi_VzEEDCiK7zmKrhg3', uri: svgUri(`
    <rect x='310' y='100' width='220' height='200' rx='8' fill='none' stroke='${S}' stroke-opacity='.6' stroke-width='3'/>
    <path d='M318 100h204a8 8 0 0 1 8 8v32H310v-32a8 8 0 0 1 8-8z' fill='${B}' fill-opacity='.85'/>
    <path d='M310 180h220M310 220h220M310 260h220M383 140v160M456 140v160' stroke='${S}' stroke-opacity='.6' stroke-width='3'/>
    <rect x='560' y='100' width='240' height='200' rx='10' fill='${G}' fill-opacity='.3'/>
    <circle cx='740' cy='150' r='22' fill='${A}' fill-opacity='.95'/>
    <path d='M560 300v-60q80-60 140-10t100 0v70z' fill='${G}' fill-opacity='.9'/>
    <g fill='${P}' fill-opacity='.9'>
      <rect x='830' y='180' width='8' height='40' rx='4'/><rect x='846' y='155' width='8' height='90' rx='4'/><rect x='862' y='130' width='8' height='140' rx='4'/>
      <rect x='878' y='165' width='8' height='70' rx='4'/><rect x='894' y='145' width='8' height='110' rx='4'/><rect x='910' y='175' width='8' height='50' rx='4'/>
    </g>`) },
  // pages, and the links between them
  links: { key: 'sxCZ0gQ3cGBZ2WtXp2TEezs', uri: svgUri(`
    <path d='M420 200L600 120L780 200L620 290L420 200L500 320M600 120L760 90' fill='none' stroke='${S}' stroke-opacity='.6' stroke-width='5'/>
    <circle cx='420' cy='200' r='26' fill='${A}'/><circle cx='600' cy='120' r='18' fill='${B}'/><circle cx='620' cy='290' r='18' fill='${G}'/>
    <circle cx='780' cy='200' r='22' fill='${P}'/><circle cx='500' cy='320' r='14' fill='${S}'/><circle cx='760' cy='90' r='12' fill='${S}'/>`) },
  // the board: three columns, in the status colours
  // shifted down: the drawing is 90–264 tall and the strip crops about the
  // middle, so unshifted it sat high (measured on the page)
  tracker: { key: 's6VVhum0LZEJp4k0gSy4woQ', uri: svgUri(`<g transform='translate(0 24)'>
    <rect x='330' y='90' width='160' height='10' rx='5' fill='${B}'/><rect x='520' y='90' width='160' height='10' rx='5' fill='${A}'/><rect x='710' y='90' width='160' height='10' rx='5' fill='${G}'/>
    <g fill='${S}' fill-opacity='.3'>
      <rect x='330' y='112' width='160' height='44' rx='8'/><rect x='330' y='166' width='160' height='44' rx='8'/><rect x='330' y='220' width='160' height='44' rx='8'/>
      <rect x='520' y='112' width='160' height='44' rx='8'/><rect x='520' y='166' width='160' height='44' rx='8'/>
      <rect x='710' y='112' width='160' height='44' rx='8'/>
    </g>
    <g fill='${S}' fill-opacity='.7'>
      <rect x='342' y='128' width='96' height='8' rx='4'/><rect x='342' y='182' width='70' height='8' rx='4'/><rect x='342' y='236' width='110' height='8' rx='4'/>
      <rect x='532' y='128' width='84' height='8' rx='4'/><rect x='532' y='182' width='104' height='8' rx='4'/>
      <rect x='722' y='128' width='90' height='8' rx='4'/>
    </g></g>`) },
  // a month, three dated days, and a span across them
  planning: { key: 'sNKTqVXXiTQhpGipqFGbGPW', uri: svgUri(`
    <defs><pattern id='d' x='380' y='76' width='64' height='64' patternUnits='userSpaceOnUse'><rect width='56' height='56' rx='8' fill='${S}' fill-opacity='.22'/></pattern></defs>
    <rect x='380' y='76' width='440' height='248' fill='url(%23d)'/>
    <rect x='444' y='140' width='56' height='56' rx='8' fill='${B}'/><rect x='572' y='140' width='56' height='56' rx='8' fill='${A}'/><rect x='700' y='140' width='56' height='56' rx='8' fill='${R}'/>
    <rect x='444' y='225' width='312' height='14' rx='7' fill='${A}' fill-opacity='.55'/>`) },
}
