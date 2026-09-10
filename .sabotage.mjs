import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
const P = '/Users/andy/devel/bento/.claude/worktrees/agent-ae75bcffed021c7d4/spaces/src/record.ts'
const orig = readFileSync(P, 'utf8')

const cases = [
  ['codec order: prefer what the browser likes (WebM first)',
    "  'audio/mp4;codecs=mp4a.40.2',\n  'audio/mp4',\n  'audio/mpeg',\n  'audio/ogg;codecs=opus',\n  'audio/ogg',\n  'audio/webm;codecs=opus',\n  'audio/webm',",
    "  'audio/webm;codecs=opus',\n  'audio/webm',\n  'audio/ogg;codecs=opus',\n  'audio/ogg',\n  'audio/mpeg',\n  'audio/mp4;codecs=mp4a.40.2',\n  'audio/mp4',"],
  ['codec probe: a throwing isTypeSupported takes the recorder down',
    "    try { if (supported(c)) return c } catch { /* a throwing probe is a \"no\" */ }",
    "    if (supported(c)) return c"],
  ['codec choice: hardcode the mime instead of asking',
    'export function pickAudioMime(supported: ((type: string) => boolean) | undefined): string {',
    "export function pickAudioMime(supported: ((type: string) => boolean) | undefined): string {\n  return 'audio/webm;codecs=opus'"],
  ['portability: call WebM portable',
    "  if (base === 'audio/webm') return { label: 'WebM', portable: false }",
    "  if (base === 'audio/webm') return { label: 'WebM', portable: true }"],
  ['portability: an unknown container is assumed fine',
    "  return { label: base ? base.replace(/^audio\\//, '').toUpperCase() : '?', portable: false }",
    "  return { label: base ? base.replace(/^audio\\//, '').toUpperCase() : '?', portable: true }"],
  ['budget: ask about raw bytes, not what lands in the file',
    '  return Math.ceil(bytes / 3) * 4 + mime.length + 14',
    '  return bytes'],
  ['budget: no warning band before the limit',
    "  if (embedded > MEDIA_EMBED_BUDGET * 0.75) return 'near'",
    "  if (false) return 'near'"],
  ['budget: a second, laxer threshold of its own',
    '  if (embedded > MEDIA_EMBED_BUDGET) return \'over\'',
    '  if (embedded > MEDIA_EMBED_BUDGET * 4) return \'over\''],
  ['bitrate: record at the browser default (~128k), halving the time to the limit',
    'export const VOICE_BITRATE = 64000',
    'export const VOICE_BITRATE = 8000'],
  ['permission: a denied prompt reported as a generic failure',
    "    case 'NotAllowedError': case 'PermissionDeniedError': return 'denied'",
    "    case 'PermissionDeniedError': return 'denied'"],
  ['permission: no device reported as a generic failure',
    "    case 'NotFoundError': case 'DevicesNotFoundError': case 'OverconstrainedError':\n    case 'ConstraintNotSatisfiedError': return 'nodevice'",
    "    case 'DevicesNotFoundError': return 'nodevice'"],
  ['permission: an unknown error name guessed at as "denied"',
    "    default: return 'failed'",
    "    default: return 'denied'"],
  ['availability: gate on https, banning a file:// document',
    '  if (gum && hasMediaRecorder) return \'ok\'\n  if (!secure) return \'insecure\'',
    '  if (gum && hasMediaRecorder && secure) return \'ok\'\n  if (!secure) return \'insecure\''],
  ['availability: "too old" and "insecure" collapsed into one message',
    "  if (!secure) return 'insecure'\n  return 'unsupported'",
    "  return 'unsupported'"],
  ['clock: no zero padding',
    '  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`',
    '  return h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`'],
  ['clock: negative elapsed not floored',
    '  const total = Math.max(0, Math.floor(ms / 1000))',
    '  const total = Math.floor(ms / 1000)'],
  ['clock: minutes never roll into hours',
    '  const m = Math.floor(total / 60) % 60\n  const h = Math.floor(total / 3600)',
    '  const m = Math.floor(total / 60)\n  const h = 0'],
  ['meter: no display gain — speech never leaves the first tenth',
    '  return Math.min(1, Math.sqrt(sum / data.length) * 2.6)',
    '  return Math.min(1, Math.sqrt(sum / data.length))'],
  ['meter: no clamp — a loud passage overflows the bar',
    '  return Math.min(1, Math.sqrt(sum / data.length) * 2.6)',
    '  return Math.sqrt(sum / data.length) * 2.6'],
  ['meter: an empty buffer divides by zero',
    '  if (!data.length) return 0',
    '  if (false) return 0'],
]

let broke = 0
for (const [name, from, to] of cases) {
  if (!orig.includes(from)) { console.log(`SETUP FAILED — anchor not found: ${name}`); continue }
  writeFileSync(P, orig.replace(from, to))
  let out = ''
  try {
    out = execSync('node scripts/test-spaces-model.ts 2>&1', {
      cwd: '/Users/andy/devel/bento/.claude/worktrees/agent-ae75bcffed021c7d4', encoding: 'utf8',
    })
    console.log(`GREEN (bad) — ${name}`)
  } catch (e) {
    out = String(e.stdout ?? '') + String(e.stderr ?? '')
    const fails = out.split('\n').filter((l) => l.trim().startsWith('FAIL'))
    console.log(`RED ok (${fails.length} failed) — ${name}`)
    if (fails.length) console.log('        first: ' + fails[0].slice(0, 130))
    broke++
  }
}
writeFileSync(P, orig)
console.log(`\n${broke}/${cases.length} sabotages produced a red rig`)
