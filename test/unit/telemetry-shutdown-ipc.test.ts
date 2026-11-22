import { describe, expect, it } from 'vitest'
import { isShutdownIpcReplyError } from '../../src/shared/telemetry'

const ev = (...values: string[]) => ({ exception: { values: values.map((value) => ({ type: 'Error', value })) } })
const NEVER = "Error invoking remote method 'terminal:screen': reply was never sent"

// FERRET-2E: 更新の入れ替え（app.quit）の途中で、renderer の invoke の返事が届かなかった
describe('isShutdownIpcReplyError', () => {
  it('終了の途中の「返事が届かなかった」は送らない', () => {
    expect(isShutdownIpcReplyError(ev(NEVER), true)).toBe(true)
    expect(isShutdownIpcReplyError(ev(`Error: ${NEVER}`), true)).toBe(true)
    expect(isShutdownIpcReplyError(ev("Error invoking remote method 'review:load': reply was never sent"), true)).toBe(true)
  })
  it('終了の途中でなければ送る（返事を返さない handler の不具合かもしれない）', () => {
    expect(isShutdownIpcReplyError(ev(NEVER), false)).toBe(false)
  })
  it('ほかの失敗は終了の途中でも送る', () => {
    expect(isShutdownIpcReplyError(ev("Error invoking remote method 'terminal:screen': Error: boom"), true)).toBe(false)
    expect(isShutdownIpcReplyError(ev(NEVER, 'TypeError: x is undefined'), true)).toBe(false)
    expect(isShutdownIpcReplyError(ev(`${NEVER} extra`), true)).toBe(false)
  })
  it('例外の無いイベント・形の崩れたイベントは送る', () => {
    expect(isShutdownIpcReplyError({}, true)).toBe(false)
    expect(isShutdownIpcReplyError({ exception: { values: [] } }, true)).toBe(false)
    expect(isShutdownIpcReplyError({ exception: 'x' }, true)).toBe(false)
  })
})

describe('更新の入れ替えの途中も終了の途中とみなす（FERRET-2E が 0.8.24 でも届いた）', () => {
  it('before-quit-for-update と終了の開始で立て、terminal:screen は送りっぱなしで拒否を捨てる', async () => {
    const { readFileSync } = await import('node:fs')
    const main = readFileSync('src/main/telemetry.ts', 'utf8')
    expect(main).toContain("autoUpdater.on('before-quit-for-update', () => { appQuitting = true })")
    expect(main).toMatch(/export function noteQuitRequested\(\): void \{\n[^}]*appQuitting = true/)
    const client = readFileSync('src/renderer/terminal/terminalClient.ts', 'utf8')
    expect(client).toContain("window.ade.invoke('terminal:screen', this.ptyId, lines.join('\\n')).catch(() => undefined)")
  })
})
