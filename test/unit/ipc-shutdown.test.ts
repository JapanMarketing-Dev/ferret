import { describe, expect, it } from 'vitest'
import { acceptsDuringShutdown, replyAfterShutdown } from '../../src/main/ipcShutdown'

// FERRET-28: 終了の途中に null を返すと、画面がチャネルの値として読んで落ちた
describe('終了の途中の IPC の返事', () => {
  it('null を返さず、返事をしないまま待たせる', async () => {
    let settled: unknown = 'pending'
    replyAfterShutdown().then((v) => { settled = v }, (e) => { settled = e })
    await new Promise((r) => setTimeout(r, 20))
    expect(settled).toBe('pending')
  })

  it('ターミナルの最後の画面の文字だけは受ける', () => {
    expect(acceptsDuringShutdown('terminal:restoreSave')).toBe(true)
    for (const c of ['passwords:forPage', 'browser:state', 'settings:get', '']) expect(acceptsDuringShutdown(c)).toBe(false)
  })
})
