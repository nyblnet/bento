import { readFileSync, writeFileSync } from 'node:fs'
const dir = '/Users/andy/devel/bento/.claude/worktrees/agent-ae75bcffed021c7d4/spaces/src/i18n'
const EN = 'Nothing was recorded — the microphone captured no sound at all. Check that it is not muted, and that the right input is selected.'
const T = {
  fr: 'Rien n’a été enregistré — le microphone n’a capté aucun son. Vérifiez qu’il n’est pas coupé et que la bonne entrée est sélectionnée.',
  es: 'No se grabó nada: el micrófono no captó ningún sonido. Comprueba que no esté silenciado y que esté seleccionada la entrada correcta.',
  de: 'Es wurde nichts aufgenommen — das Mikrofon hat überhaupt keinen Ton erfasst. Prüfe, ob es stummgeschaltet ist und ob der richtige Eingang gewählt ist.',
  it: 'Non è stato registrato nulla: il microfono non ha captato alcun suono. Controlla che non sia disattivato e che sia selezionato l’ingresso giusto.',
  pt: 'Não foi gravado nada — o microfone não captou som nenhum. Verifique se não está silenciado e se está selecionada a entrada certa.',
  ja: '何も録音されませんでした。マイクは音をまったく拾っていません。ミュートになっていないか、正しい入力が選ばれているか確認してください。',
  'zh-Hans': '没有录到任何内容——麦克风完全没有拾到声音。请检查它是否被静音，以及是否选中了正确的输入。',
  'zh-Hant': '沒有錄到任何內容——麥克風完全沒有收到聲音。請檢查它是否被靜音，以及是否選取了正確的輸入。',
}
const q = (s) => JSON.stringify(s)
for (const [loc, v] of Object.entries(T)) {
  const path = `${dir}/${loc}.ts`
  const lines = readFileSync(path, 'utf8').split('\n')
  let at = -1
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s{2}"((?:\\.|[^"])*)":/.exec(lines[i])
    if (!m) continue
    if (JSON.parse(`"${m[1]}"`) > EN) { at = i; break }
  }
  if (at < 0) throw new Error('no slot ' + loc)
  lines.splice(at, 0, `  ${q(EN)}: ${q(v)},`)
  writeFileSync(path, lines.join('\n'))
  console.log(loc, 'ok')
}
