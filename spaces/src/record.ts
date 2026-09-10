// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Voice notes: recording a clip straight into the document.
//
// WHY THIS BELONGS IN A FILE-SHAPED APP. A hosted notes app records your
// meeting by uploading it. This one cannot upload anything (PLATFORM §1) and
// does not need to: `getUserMedia` and `MediaRecorder` are in the browser, the
// bytes never leave the tab, and the finished clip is interned into the same
// content-addressed asset table a picked file lands in. Nothing here touches
// the network, and nothing here transcribes — a transcription service is a
// network call wearing a helpful hat.
//
// NO NEW BLOCK TYPE. A recording is an ordinary `media` block with
// `kind: 'audio'`, so a build from before this feature existed opens the file
// and plays it. That is the whole reason this file has no model changes in it:
// everything downstream of the Blob already exists (editor.placeMedia →
// internAsset → render.ts's <audio>).

import { t } from './i18n.ts'
import { MEDIA_EMBED_BUDGET, humanBytes } from './assets.ts'

// ---------------------------------------------------------------------------
// Pure parts. DOM-free and side-effect-free at module level, so
// scripts/test-spaces-model.ts can pin them in plain node.
// ---------------------------------------------------------------------------

/**
 * Candidate recording formats, best FIRST — and "best" is judged by where the
 * result PLAYS, not by what this browser prefers to write.
 *
 * The document gets emailed. A voice note that opens on the machine that
 * recorded it and nowhere else is a bug that only ever appears for the
 * recipient, which is the worst possible place for it to appear. So the order
 * is playback reach, descending:
 *
 *   · AAC in MP4 — the only audio every shipping browser can decode, on every
 *     platform, and the one QuickTime, Windows Media and a phone's own player
 *     open by double-click. Safari records this natively; Chrome can too.
 *   · MP3 — same universality, offered by fewer recorders.
 *   · Opus in Ogg — Firefox's native output. Chrome and Firefox play it;
 *     Safari only on recent versions.
 *   · Opus in WebM — Chrome's native output, and the LEAST portable of the
 *     four. It is here because on a browser that offers nothing else it is the
 *     difference between a voice note and no voice note.
 *
 * `MediaRecorder.isTypeSupported` is the only honest arbiter of what a given
 * build can actually write: a hardcoded type produces a file that plays on the
 * developer's machine and nowhere else, and a UA-string guess ages badly. When
 * nothing in this list is supported the recorder passes NO mimeType at all,
 * which the spec defines as "the user agent picks" — a working recording in an
 * unknown container beats a thrown NotSupportedError.
 */
export const AUDIO_MIME_CANDIDATES: readonly string[] = [
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/mpeg',
  'audio/ogg;codecs=opus',
  'audio/ogg',
  'audio/webm;codecs=opus',
  'audio/webm',
]

/**
 * The first candidate this browser can write, or '' for "let it choose".
 *
 * Takes the predicate rather than reaching for `MediaRecorder` itself, so the
 * choice is testable without a browser and so a probe that throws (some builds
 * throw on a malformed type rather than returning false) cannot take the
 * recorder down with it.
 */
export function pickAudioMime(
  supported: ((type: string) => boolean) | undefined,
  /**
   * Types this session has already WATCHED FAIL, which is a different and
   * stronger fact than `isTypeSupported` saying no.
   *
   * Measured in Chrome 1568×861 on macOS: `isTypeSupported('audio/mp4;codecs
   * =mp4a.40.2')` answers TRUE, the constructor accepts it, `start()` returns
   * — and the very first encode raises `EncodingError` and the recording is
   * zero bytes. So the API's own answer is necessary and NOT sufficient, and
   * a recorder that trusted it captured nothing at all on the first browser
   * it was pointed at. The caller feeds a failure back in here and asks
   * again; the list is the fallback ladder.
   */
  exclude: ReadonlySet<string> = new Set(),
): string {
  if (typeof supported !== 'function') return ''
  for (const c of AUDIO_MIME_CANDIDATES) {
    if (exclude.has(c)) continue
    try { if (supported(c)) return c } catch { /* a throwing probe is a "no" */ }
  }
  return ''
}

/** What a mime type is, for the one line of UI that says so. */
export interface AudioFormat {
  /** short human name — 'MP4', 'Ogg', … */
  label: string
  /** true when every shipping browser and desktop player opens it */
  portable: boolean
}

/**
 * Read a recorder's actual output type.
 *
 * Deliberately driven off the CONTAINER, because that is what decides whether
 * a player opens the file at all; the codec inside decides quality, which is
 * not what the recipient is at risk of losing.
 */
export function audioFormat(mime: string): AudioFormat {
  const base = mime.split(';')[0].trim().toLowerCase()
  if (base === 'audio/mp4' || base === 'audio/aac' || base === 'audio/x-m4a') {
    return { label: 'MP4', portable: true }
  }
  if (base === 'audio/mpeg' || base === 'audio/mp3') return { label: 'MP3', portable: true }
  if (base === 'audio/wav' || base === 'audio/x-wav') return { label: 'WAV', portable: true }
  if (base === 'audio/ogg') return { label: 'Ogg', portable: false }
  if (base === 'audio/webm') return { label: 'WebM', portable: false }
  return { label: base ? base.replace(/^audio\//, '').toUpperCase() : '?', portable: false }
}

/**
 * Everything that can go wrong before a single sample is captured — and every
 * one of these is a NORMAL state, not a failure to report as "an error
 * occurred". A microphone that is not there, a prompt that was dismissed and a
 * page served over plain http are three different sentences to a reader, and
 * only one of them has a fix the reader can act on.
 *
 * `denied` covers dismissal too, and it has to: a dismissed prompt and a
 * blocked one both arrive as NotAllowedError with no way to separate them, so
 * the wording covers both rather than guessing at one.
 */
export type MicTrouble =
  | 'denied' | 'nodevice' | 'inuse' | 'insecure' | 'unsupported' | 'failed'
  /**
   * The recorder ran and captured NOTHING — a distinct state from "it would
   * not start", and one that really happens: a muted input, a virtual device
   * with no source behind it, an input the OS has routed elsewhere. Measured
   * in the browser, where a stream whose audio graph was suspended recorded
   * 81 seconds of zero bytes; before this state existed that reported itself
   * as "could not be started", which sends the reader looking for a
   * permission problem that is not there.
   */
  | 'silent'

export function micTrouble(err: unknown): MicTrouble {
  const name = (err as { name?: string } | null)?.name ?? ''
  switch (name) {
    case 'NotAllowedError': case 'PermissionDeniedError': return 'denied'
    case 'SecurityError': return 'insecure'
    case 'NotFoundError': case 'DevicesNotFoundError': case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError': return 'nodevice'
    case 'NotReadableError': case 'TrackStartError': case 'AbortError': return 'inuse'
    case 'NotSupportedError': case 'TypeError': return 'unsupported'
    default: return 'failed'
  }
}

/**
 * Can this build record at all, asked WITHOUT prompting anyone.
 *
 * `navigator.mediaDevices` is absent in an insecure context, which is the same
 * absence as "this browser is too old" — so the two are told apart by
 * `isSecureContext`, and the message differs because the remedies do.
 *
 * NOTE `file://`: Chrome and Firefox treat a local file as a potentially
 * trustworthy origin, so a space opened by double-click IS secure and can
 * record. That is the ordinary way these documents are opened, and gating on
 * `https:` rather than on `isSecureContext` would have banned it.
 */
export function recorderAvailability(
  nav: { mediaDevices?: { getUserMedia?: unknown } } | undefined,
  hasMediaRecorder: boolean,
  secure: boolean,
): 'ok' | 'insecure' | 'unsupported' {
  const gum = typeof nav?.mediaDevices?.getUserMedia === 'function'
  if (gum && hasMediaRecorder) return 'ok'
  if (!secure) return 'insecure'
  return 'unsupported'
}

/** `m:ss`, or `h:mm:ss` once there is an hour to show. Never a bare seconds
 *  count: a recording is a duration and duration is read in colons. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/**
 * A 0–1 level from `getByteTimeDomainData`, which centres silence on 128.
 *
 * RMS rather than peak: a peak meter reads full-scale off one click and then
 * tells you nothing about whether a voice is being captured, which is the only
 * question this meter exists to answer. The ×2.6 is a display gain — speech at
 * a normal distance sits around 0.1 RMS and a bar that never leaves its first
 * tenth reads as "not working".
 */
export function meterLevel(data: ArrayLike<number>): number {
  if (!data.length) return 0
  let sum = 0
  for (let i = 0; i < data.length; i++) {
    const v = (data[i] - 128) / 128
    sum += v * v
  }
  return Math.min(1, Math.sqrt(sum / data.length) * 2.6)
}

/**
 * What those raw bytes will WEIGH once they are in the document.
 *
 * The budget question is about the file someone receives, and inside the file
 * the clip is a base64 data: URI — four characters per three bytes, plus the
 * `data:audio/mp4;base64,` preamble. Asking the budget about the raw byte count
 * would let a clip a third over the line through without a word.
 */
export function embeddedSize(bytes: number, mime = ''): number {
  return Math.ceil(bytes / 3) * 4 + mime.length + 14
}

/** Where a recording stands against MEDIA_EMBED_BUDGET. `near` is the point at
 *  which saying so is still useful, i.e. while it can still be stopped. */
export function budgetVerdict(embedded: number): 'ok' | 'near' | 'over' {
  if (embedded > MEDIA_EMBED_BUDGET) return 'over'
  if (embedded > MEDIA_EMBED_BUDGET * 0.75) return 'near'
  return 'ok'
}

/**
 * Bits per second asked of the encoder.
 *
 * 64 kbit/s mono is transparent for speech in every codec on the candidate
 * list, and it is the difference between an hour-long meeting weighing 28MB
 * and weighing 200. The budget exists because a long recording is large; the
 * cheapest way to respect it is not to make the file large in the first place.
 */
export const VOICE_BITRATE = 64000

// ---------------------------------------------------------------------------
// The recorder itself.
// ---------------------------------------------------------------------------

export interface VoiceResult {
  /** the recording, typed with whatever the recorder actually wrote */
  blob: Blob
  mime: string
  ms: number
}

export interface VoiceRecorderOpts {
  /** the recording is finished and kept — the caller interns and commits it */
  onDone: (result: VoiceResult) => void
  /** dismissed with nothing kept */
  onCancel: () => void
}

export interface VoiceRecorderView {
  el: HTMLElement
  /** Stops everything and hands the microphone back. Idempotent, and it is the
   *  ONLY teardown path, so there is no second one to forget. */
  destroy: () => void
  /** For verification: how many capture tracks are still live. Must be 0 after
   *  destroy(), and this is asserted rather than assumed. */
  liveTracks: () => number
}

const div = (cls: string, text = ''): HTMLDivElement => {
  const d = document.createElement('div')
  d.className = cls
  if (text) d.textContent = text
  return d
}

const button = (cls: string, label: string, onClick: () => void): HTMLButtonElement => {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = cls
  b.textContent = label
  b.addEventListener('click', onClick)
  return b
}

/**
 * The recorder panel.
 *
 * Mounts detached and hands back a view; the caller decides where it goes and
 * calls `destroy()` when the overlay closes. Every asynchronous thing it owns
 * — the stream, the recorder, the AudioContext, the tick — is released there.
 */
export function openVoiceRecorder(opts: VoiceRecorderOpts): VoiceRecorderView {
  const card = div('sp-card sp-rec')
  card.setAttribute('role', 'dialog')
  card.setAttribute('aria-modal', 'true')
  card.setAttribute('aria-label', t('Voice note'))

  const head = document.createElement('h2')
  head.className = 'sp-card-h'
  head.textContent = t('Voice note')

  const meter = div('sp-rec-meter')
  const bar = div('sp-rec-bar')
  meter.append(bar)
  // The meter is decoration for a screen reader — the elapsed line below is
  // the fact, and it is a live region so the time is announced as it changes.
  meter.setAttribute('aria-hidden', 'true')

  const time = div('sp-rec-time', formatElapsed(0))
  time.setAttribute('role', 'status')
  time.setAttribute('aria-live', 'polite')

  const note = div('sp-rec-note')
  const warn = div('sp-rec-warn')
  warn.hidden = true
  const actions = div('sp-rec-actions')

  card.append(head, meter, time, note, warn, actions)

  // ---- state ---------------------------------------------------------------
  let stream: MediaStream | null = null
  let recorder: MediaRecorder | null = null
  let audioCtx: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  let source: MediaStreamAudioSourceNode | null = null
  let tick: ReturnType<typeof setInterval> | null = null
  let chunks: Blob[] = []
  let bytes = 0
  let startedAt = 0
  let elapsed = 0
  let done = false
  let kept: VoiceResult | null = null
  let previewUrl = ''
  /** Types this browser CLAIMED it could write and then could not. */
  const rejected = new Set<string>()
  let triedDefault = false
  /**
   * WHICH ATTEMPT'S EVENTS ARE STILL OURS.
   *
   * When a rung of the codec ladder fails we abandon that MediaRecorder and
   * build another — but `stop()` on the abandoned one still delivers a `stop`
   * event afterwards, asynchronously, and that event ran the finish path and
   * released the microphone out from under the take that had just started.
   * Measured: the fallback appeared to work and then reported "nothing was
   * recorded" at 0:00. Every handler checks its generation.
   */
  let gen = 0

  /**
   * HAND THE MICROPHONE BACK. Every track, every time.
   *
   * A MediaStream left open holds the device and leaves the browser's
   * recording indicator lit — in the tab strip, in the OS menu bar, and on a
   * phone in the status bar — for as long as the document stays open. Stopping
   * the MediaRecorder does NOT do this: the recorder and the stream are
   * separate objects and the stream outlives it.
   */
  const releaseMic = (): void => {
    for (const track of stream?.getTracks() ?? []) {
      try { track.stop() } catch { /* already gone */ }
    }
    stream = null
  }

  const stopTick = (): void => {
    if (tick !== null) { clearInterval(tick); tick = null }
  }

  const closeAudio = (): void => {
    try { source?.disconnect() } catch { /* not connected */ }
    source = null
    analyser = null
    // An AudioContext is a separate hold on the audio hardware; letting it be
    // garbage-collected is not the same as closing it.
    const ctx = audioCtx
    audioCtx = null
    if (ctx) void ctx.close().catch(() => { /* already closed */ })
  }

  const destroy = (): void => {
    stopTick()
    try { if (recorder && recorder.state !== 'inactive') recorder.stop() } catch { /* fine */ }
    recorder = null
    closeAudio()
    releaseMic()
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = '' }
  }

  const liveTracks = (): number =>
    (stream?.getTracks() ?? []).filter((tr) => tr.readyState === 'live').length

  // ---- screens -------------------------------------------------------------
  const setActions = (...els: HTMLElement[]): void => {
    actions.replaceChildren(...els)
  }

  /**
   * The states a reader can land in that are not "recording".
   *
   * Each one says what happened AND what is left to do, because "could not
   * access microphone" tells a reader nothing they can act on. The two other
   * ways to get a clip in are always still offered: this panel is an addition
   * to the file picker, never a replacement for it, so a browser with no
   * microphone support loses nothing it had.
   */
  const trouble = (kind: MicTrouble): void => {
    stopTick()
    closeAudio()
    releaseMic()
    meter.hidden = true
    time.hidden = true
    let msg: string
    switch (kind) {
      case 'denied':
        msg = t('The microphone was not allowed. The browser may have blocked it, or the permission request may have been dismissed — allow it for this page and try again.')
        break
      case 'nodevice':
        msg = t('No microphone was found. Plug one in, or choose a file instead.')
        break
      case 'inuse':
        msg = t('The microphone is busy — another app or tab may be using it. Close that and try again.')
        break
      case 'insecure':
        msg = t('This page is not on a secure connection, so the browser will not open the microphone. Open the file from disk, or over https.')
        break
      case 'unsupported':
        msg = t('This browser cannot record audio. You can still choose an audio file.')
        break
      case 'silent':
        msg = t('Nothing was recorded — the microphone captured no sound at all. Check that it is not muted, and that the right input is selected.')
        break
      default:
        msg = t('The recording could not be started.')
    }
    note.textContent = msg
    warn.hidden = true
    setActions(button('sp-btn', t('Close'), () => opts.onCancel()))
  }

  const paintRecording = (): void => {
    elapsed = Date.now() - startedAt
    time.textContent = formatElapsed(elapsed)
    if (analyser) {
      const data = new Uint8Array(analyser.fftSize)
      analyser.getByteTimeDomainData(data)
      bar.style.width = `${Math.round(meterLevel(data) * 100)}%`
    }
    // The budget, said BEFORE the recording is over and can no longer be kept
    // short. `bytes` only advances on each timeslice, so this is a real
    // measurement of what has been encoded and not a guess from the clock.
    const verdict = budgetVerdict(embeddedSize(bytes, recorder?.mimeType ?? ''))
    if (verdict === 'over') {
      warn.hidden = false
      warn.textContent = t('This recording is past the size a document travels comfortably at. You can keep it — you will be asked to confirm — but it will make the file that much heavier for everyone you send it to.')
    } else if (verdict === 'near') {
      warn.hidden = false
      warn.textContent = t('This recording is getting long enough to make the document noticeably heavier to send.')
    } else {
      warn.hidden = true
    }
  }

  /** The finished clip, with the two decisions that are still open: keep it, or
   *  throw it away. Nothing is written to the document until "Insert". */
  const paintDone = (blob: Blob, mime: string): void => {
    kept = { blob, mime, ms: elapsed }
    stopTick()
    meter.hidden = true
    time.textContent = formatElapsed(elapsed)
    const fmt = audioFormat(mime)
    const size = embeddedSize(blob.size, mime)
    note.textContent = t('{length} · {format} · about {size} in the file', {
      length: formatElapsed(elapsed),
      format: fmt.label,
      size: humanBytes(size),
    })

    // A format the recipient's player may not open is worth one sentence, once,
    // at the moment it can still be avoided by choosing a file instead.
    if (!fmt.portable) {
      warn.hidden = false
      warn.textContent = t('This browser records in a format some older players cannot open. It plays in this app on any modern browser.')
    } else if (budgetVerdict(size) === 'ok') {
      warn.hidden = true
    }

    // Listen back before committing it. A blob: URL, revoked on teardown — the
    // asset table is not touched until the caller commits.
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    previewUrl = URL.createObjectURL(blob)
    const preview = document.createElement('audio')
    preview.className = 'sp-rec-preview'
    preview.controls = true
    preview.preload = 'metadata'
    preview.src = previewUrl
    card.insertBefore(preview, note)

    const insert = button('sp-btn sp-primary', t('Insert'), () => {
      if (!kept) return
      const out = kept
      kept = null
      opts.onDone(out)
    })
    setActions(
      insert,
      button('sp-btn', t('Record again'), () => {
        preview.remove()
        if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = '' }
        kept = null
        chunks = []
        bytes = 0
        // The ladder is NOT reset: a type that failed a minute ago is still
        // broken, and re-climbing to it would fail the second take too.
        void begin()
      }),
      button('sp-btn', t('Discard'), () => opts.onCancel()),
    )
    insert.focus()
  }

  // ---- the recording itself -------------------------------------------------
  const begin = async (): Promise<void> => {
    done = false
    meter.hidden = false
    time.hidden = false
    time.textContent = formatElapsed(0)
    warn.hidden = true
    note.textContent = t('Asking for the microphone…')
    setActions(button('sp-btn', t('Cancel'), () => opts.onCancel()))

    const avail = recorderAvailability(
      navigator as unknown as { mediaDevices?: { getUserMedia?: unknown } },
      typeof MediaRecorder !== 'undefined',
      globalThis.isSecureContext === true,
    )
    if (avail !== 'ok') { trouble(avail); return }

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        // A voice note, not a field recording: the browser's own cleanup is
        // better than anything this could do afterwards, and it is free.
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
    } catch (err) {
      trouble(micTrouble(err))
      return
    }
    // Dismissed while the prompt was up: the panel is gone, so hand the device
    // straight back rather than leaving the indicator lit on a dead dialog.
    if (!card.isConnected) { releaseMic(); return }

    // The level meter. Failing to build it is not failing to record — a
    // recorder with no meter still records, so this never aborts the take.
    try {
      const Ctx = (globalThis as unknown as { AudioContext?: typeof AudioContext }).AudioContext
      if (Ctx) {
        audioCtx = new Ctx()
        analyser = audioCtx.createAnalyser()
        analyser.fftSize = 1024
        source = audioCtx.createMediaStreamSource(stream)
        source.connect(analyser)
        // A context created without user activation starts SUSPENDED, and a
        // suspended analyser reads flat silence forever — a meter that never
        // moves while a recording is plainly running. Fire-and-forget on
        // purpose: measured in Chrome, `resume()` on a page with no
        // activation NEVER SETTLES, so awaiting it would hang the recorder
        // behind a meter that is decoration.
        void audioCtx.resume?.().catch(() => { /* stays suspended; meter reads 0 */ })
      }
    } catch { closeAudio() }

    startRecording()
  }

  /**
   * Start (or RE-start) the recorder on the stream we already hold.
   *
   * Separate from acquiring the microphone because it is retried: see
   * `rejected`. Nothing here re-prompts, and the stream is untouched between
   * attempts, so a fallback is invisible — the clock has not started yet.
   */
  const startRecording = (): void => {
    if (!stream) { trouble('failed'); return }
    const myGen = ++gen
    const supported =
      typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function'
        ? (type: string) => MediaRecorder.isTypeSupported(type)
        : undefined
    const mime = pickAudioMime(supported, rejected)

    // Every named candidate has now failed in front of us AND the unnamed
    // default has too: there is nothing left to try.
    if (!mime && triedDefault) { trouble('failed'); return }
    if (!mime) triedDefault = true

    try {
      recorder = new MediaRecorder(stream, {
        ...(mime ? { mimeType: mime } : {}),
        audioBitsPerSecond: VOICE_BITRATE,
      })
    } catch {
      // A type isTypeSupported said yes to can still be refused by the
      // constructor (a bitrate it will not take, a platform encoder that is
      // missing). Reject it and take the next rung.
      if (mime) { rejected.add(mime); startRecording(); return }
      try { recorder = new MediaRecorder(stream) } catch (err2) { trouble(micTrouble(err2)); return }
    }

    chunks = []
    bytes = 0
    recorder.addEventListener('dataavailable', (e) => {
      if (myGen !== gen) return
      const b = (e as BlobEvent).data
      if (b && b.size) { chunks.push(b); bytes += b.size }
    })

    // THE FALLBACK THAT MATTERS. The failure this catches is not theoretical:
    // Chrome answers `isTypeSupported('audio/mp4;codecs=mp4a.40.2')` with
    // TRUE, builds the recorder, starts it, and then raises EncodingError on
    // the first buffer — so a recorder that trusted the API's own answer
    // captured zero bytes and had nothing to say about why. If it fails
    // before ANY bytes exist, the take has lost nothing, so drop that type
    // for the rest of the session and start again one rung down. Once bytes
    // exist we keep them instead: a partial recording beats a perfect one
    // that does not exist.
    const mine = recorder
    recorder.addEventListener('error', () => {
      if (done || myGen !== gen) return
      stopTick()
      try { if (mine.state !== 'inactive') mine.stop() } catch { /* already */ }
      if (!bytes && mime) {
        // Abandon this rung. Bumping `gen` inside startRecording is what
        // makes the abandoned recorder's trailing `stop` a no-op.
        rejected.add(mime)
        startRecording()
        return
      }
      done = true
      if (!bytes) { trouble('failed'); return }
      finish()
    })

    recorder.addEventListener('stop', () => {
      if (done || myGen !== gen) return
      done = true
      finish()
    })

    // One second per slice: it is what makes the size readout a measurement.
    recorder.start(1000)
    startedAt = Date.now()
    elapsed = 0
    note.textContent = t('Recording. Nothing leaves this file.')

    // setInterval, NOT requestAnimationFrame: rAF is throttled to nothing in a
    // backgrounded tab, and a recording that keeps running while its timer
    // reads 0:03 is worse than a timer that ticks coarsely.
    stopTick()
    tick = setInterval(paintRecording, 100)
    paintRecording()

    setActions(
      button('sp-btn sp-primary', t('Stop'), () => {
        try { if (recorder && recorder.state !== 'inactive') recorder.stop() } catch { trouble('failed') }
      }),
      button('sp-btn', t('Discard'), () => opts.onCancel()),
    )
  }

  /** The take is over, one way or another: release everything and show what
   *  there is. ONE exit, so no path can forget the microphone. */
  const finish = (): void => {
    const type = recorder?.mimeType || chunks[0]?.type || 'audio/webm'
    closeAudio()
    releaseMic()
    const blob = new Blob(chunks, { type })
    // A recorder that ran and produced no bytes is NOT a recorder that
    // failed to start, and saying so sends the reader to the wrong remedy.
    if (!blob.size) { trouble('silent'); return }
    paintDone(blob, type)
  }

  void begin()
  return { el: card, destroy, liveTracks }
}
