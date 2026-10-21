// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The Bento ID setup page (bento/connect W1b). The work is id/agent.js; this
// page runs the passkey ceremony inside the person's click, shows the
// recovery code ONCE, and stores the result only after the person confirms
// they have the code (a code nobody kept is not a way back).
//
// Nothing here talks to a server yet: binding the address and uploading the
// blobs come with the directory client. The new Bento ID is "local" until then.

import { t, localize, initI18n } from './i18n.js'
import { createBentoId } from './id/agent.js'
import { runPasskeyCeremony } from './id/passkey.js'
import { argon2idInWorker } from './id/argon2-page.js'
import { saveNewSelf, loadSelf } from './id/keystore.js'
import { parseRecoveryCode } from './id/gen/recovery.js'

await initI18n()
localize()
const $ = (id) => document.getElementById(id)
const show = (id) => { for (const s of document.querySelectorAll('.step')) s.hidden = s.id !== id }
$('label').value = t('idSetupLabelDefault')

if (await loadSelf().catch(() => null)) { show('done') }

let pending = null // { record, recoveryCode } until the person confirms the code

$('go').onclick = async () => {
  const go = $('go')
  go.disabled = true
  $('status').textContent = t('idWorking')
  try {
    const label = $('label').value.trim().slice(0, 64) || null
    let derivations = 0
    const started = performance.now()
    pending = await createBentoId({ label }, {
      subtle: crypto.subtle,
      rand: (n) => crypto.getRandomValues(new Uint8Array(n)),
      now: () => Date.now(),
      argon2id: async (pw, salt) => {
        derivations++
        $('status').textContent = t('idDeriving', String(derivations))
        return argon2idInWorker(pw, salt)
      },
      passkey: ({ prfEval }) => runPasskeyCeremony({ prfEval, label: label ?? 'Bento ID' }),
    })
    console.info('[bento/connect] setup took', Math.round(performance.now() - started), 'ms,', derivations, 'Argon2id derivations')
    if (pending.recoveryCode) {
      $('codeText').textContent = pending.recoveryCode
      if (!pending.record.passkeys.length) { $('codeNote').hidden = false; $('codeNote').textContent = t('idNoPrf') }
      show('code')
      $('confirm').focus()
    } else {
      await store()
      show('nocode')
    }
  } catch (e) {
    // literal keys, so the catalogue rig can see every one is used
    $('status').textContent = e?.name === 'PasskeyError' && e.code === 'cancelled' ? t('idErrCancelled')
      : e?.name === 'PasskeyError' && e.code === 'permission' ? t('idErrPermission')
        : e?.name === 'SetupRefused' ? t('idErrNoWayBack') : t('idErrFailed')
    console.info('[bento/connect] setup stopped:', e?.name, e?.message)
    go.disabled = false
  }
}

async function store() {
  const r = await saveNewSelf(pending.record)
  pending = null
  if (!r.ok) throw new Error(r.reason)
}

$('print').onclick = () => window.print()
$('saved').onclick = async () => {
  // the person types the code back: proof it was kept, before anything is stored
  const typed = parseRecoveryCode($('confirm').value)
  const want = parseRecoveryCode(pending?.recoveryCode ?? '')
  const same = typed.ok && want.ok && typed.code.every((b, i) => b === want.code[i])
  if (!same) { $('codeStatus').textContent = typed.ok ? t('idCodeMismatch') : t('idCodeTypo'); return }
  try { await store(); $('codeText').textContent = ''; show('done') } catch (e) { $('codeStatus').textContent = t('idErrFailed') }
}
for (const b of ['done1', 'done2']) $(b).onclick = () => window.close()
